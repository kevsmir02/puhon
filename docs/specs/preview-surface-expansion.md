# Preview Surface Expansion

> Parent: [ROADMAP.md](/ROADMAP.md) — "Preview surface expansion (better image / Markdown handling)"

## Summary

The preview surface currently spans three disconnected pathways: `PreviewPane` (URLs only), `EditorPane` (fallback binary/media preview), and `MarkdownPreviewPane` (Streamdown). This spec unifies them toward a single surface that handles local files, remote URLs, images, HTML, and Markdown — with proper image resolution, zoom controls, server auto-detection, and keyboard shortcuts.

---

## Phase 1 — Fix Markdown image rendering (low effort)

### 1.1 Resolve relative image paths

**Problem:** `![diagram](./diagram.png)` in a markdown file renders a broken image because the `<img src="./diagram.png">` has no base URL.

**Fix:** Use Streamdown's [`urlTransform`](https://streamdown.ai/docs/security#custom-url-transformations) prop to rewrite relative `src` URLs to Tauri `asset://` protocol URLs.

```tsx
import { convertFileSrc } from "@tauri-apps/api/core";
import { Streamdown, defaultUrlTransform } from "streamdown";

function makeUrlTransform(fileDir: string) {
  return (url: string, key: string, node: unknown) => {
    if (key === "src" && !/^https?:\/\//i.test(url) && !/^data:/i.test(url)) {
      const resolved = /* join fileDir + url, normalize */;
      return convertFileSrc(resolved);
    }
    return defaultUrlTransform(url, key, node);
  };
}
```

- `fileDir` is the directory of the markdown file being previewed.
- Path joining must handle `..` traversal safely (already present in the Rust `resolve_path`).
- `convertFileSrc` is already configured — CSP allows `asset:`, scope is `["**"]`.
- **Files:** `src/modules/markdown/MarkdownPreviewPane.tsx`
- **Deps:** none. `convertFileSrc` already imported in editor; just needs adding here.

### 1.2 Mermaid diagram support ✅ (done — #0204979)

Already wired via `@streamdown/mermaid`. Default config: `securityLevel: "strict"`, `startOnLoad: false`, `suppressErrorRendering: true`.

---

## Phase 2 — Image zoom & lightbox (medium effort)

### 2.1 Reusable image lightbox component

**Problem:** Images opened from the file explorer render with `object-contain` but no zoom, pan, or full-size view. Large screenshots and diagrams are hard to inspect.

**Fix:** Build a `MediaLightbox` component that wraps the current `<img>` in `EditorPane`:

```
┌────────────────────────────────┐
│  [×] close        [zoom: 100%] │  ← toolbar
├────────────────────────────────┤
│                                │
│     click+drag to pan          │
│     scroll to zoom             │
│                                │
└────────────────────────────────┘
```

| Feature | Implementation |
| --------- | --------------- |
| Zoom | CSS `scale()` driven by wheel event + pinch gesture |
| Pan | CSS `translate()` driven by pointer events (mousedown→mousemove) |
| Fullscreen toggle | `element.requestFullscreen()` |
| Open externally | `openUrl(path)` via `@tauri-apps/plugin-opener` |
| Checkerboard background | Already present in `EditorPane` |
| Reset | Double-click returns to fit-to-container |
| Close | Escape key or X button |

**New file:** `src/modules/preview/MediaLightbox.tsx`
**Modified:** `src/modules/editor/EditorPane.tsx` — wrap `<img>` with `<MediaLightbox>`

### 2.2 Extend zoom to PDF and video

Add the same toolbar with "Open externally" and "Fullscreen" to the PDF `<iframe>` and `<video>` elements in the editor binary fallback. No zoom/pan needed for video. PDF pick up zoom/pan via the browser's built-in viewer.

---

## Phase 3 — Unify preview surfaces (medium effort)

### 3.1 Let `PreviewPane` accept local file paths

**Problem:** `PreviewPane` only accepts HTTP URLs. The editor's binary fallback handles HTML/images/PDF but is a different code path. Users can't navigate a local HTML file from the address bar.

**Fix:** Extend the address bar to accept file paths:

| Input | Behavior |
| ------- | ---------- |
| `http://localhost:3000` | Load in iframe (existing) |
| `/home/user/project/README.md` | Resolve with `convertFileSrc`, load as asset URL in iframe, or switch to markdown renderer |
| `/home/user/project/index.html` | Resolve, load in iframe via `asset://` |
| `file:///home/user/...` | Strip `file://` prefix, treat as local path |
| `./index.html` | Resolve relative to current workspace root |

```tsx
// PreviewAddressBar: update normalizeUrl
function normalizeUrl(raw: string, workspaceRoot: string): { kind: "url" | "file"; value: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return { kind: "url", value: trimmed };
  if (/^file:\/\//i.test(trimmed)) return { kind: "file", value: trimmed.slice(7) };
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../"))
    return { kind: "file", value: resolveRelativePath(trimmed, workspaceRoot) };
  if (/^localhost(:\d+)?(\/|$)/i.test(trimmed)) return { kind: "url", value: `http://${trimmed}` };
  // ... existing port/number detection
}
```

- **Files:** `src/modules/preview/PreviewAddressBar.tsx`, `src/modules/preview/PreviewPane.tsx`

### 3.2 Local HTML file live-reload

When the address bar points to a local `.html` file, watch that file for changes and auto-reload the iframe (bump `nonce`). Use the existing filesystem watch infrastructure from the editor (`src/modules/editor/useEditorFileSync.ts`).

### 3.3 Consolidate `MarkdownTab` → `PreviewTab` with mode

**Goal:** Opening a `.md` file opens a `PreviewTab` in `mode: "markdown"` instead of a separate `MarkdownTab`. The user can switch between:

- **Rendered** — Streamdown with plugins
- **Raw** — CodeMirror editor (existing behavior via `setMarkdownView`)
- **Preview** — If the markdown references a dev server, the address bar can switch to `http://localhost:3000`

| Current | Proposed |
| --------- | ---------- |
| `MarkdownTab` (kind: `"markdown"`) | `PreviewTab` (kind: `"preview"`, mode: `"markdown"`) |
| Switch to raw → converts to `EditorTab` | Switch to raw → converts to `EditorTab` (unchanged) |
| Can't navigate to URL | Can type URL in address bar |

**Impact:**

- `src/modules/tabs/lib/useTabs.ts` — add `mode` field to `PreviewTab`, remove `MarkdownTab`
- `src/modules/markdown/` — move rendering logic into `PreviewPane` as a mode
- `src/modules/spaces/lib/serialize.ts` — update `SerializedTab` to store `mode`
- `ROADMAP.md` — update shipped items

**Risk:** High touch surface. Consider deferring to Phase 4 or splitting into its own PR.

---

## Phase 4 — Dev server auto-detection (medium effort)

### 4.1 Scan for running servers on space open

**Problem:** Users have to know their dev server port and type it manually. The port presets in `PreviewAddressBar` already exist but require manual selection.

**Fix:** On workspace open, scan the port presets list in the background. For each port that responds, show a non-intrusive notification:

```
┌──────────────────────────────────────────────────┐
│  ● Vite detected on :5173 — [Open preview]  [×] │
└──────────────────────────────────────────────────┘
```

- Use existing `probeUrl()` from `PreviewAddressBar.tsx` (already does no-cors fetch with 900ms timeout)
- Run sequentially (not in parallel — avoids flooding localhost)
- Track dismissed ports in session storage so they don't re-appear
- **Files:** `src/modules/preview/useServerDetector.ts` (new), wire into `useSpacesBoot` or a workspace-level effect

### 4.2 Surface detected servers in the Ports dropdown

Add a "Detected" section at the top of the port presets dropdown, populated by the scanner results. Show a green dot next to responding ports.

---

## Phase 5 — Polish & shortcuts (low effort)

### 5.1 Keyboard shortcut for markdown rendered/raw toggle

Bind `Ctrl+Shift+M` (or configurable) to toggle between rendered and raw view for the active markdown tab. Wire into the existing `setMarkdownView` callback.

- **Files:** `src/modules/shortcuts/lib/useGlobalShortcuts.ts`

### 5.2 PDF page controls

Add a thin toolbar above the PDF iframe in `EditorPane`:

```
[← page N of M →] [zoom -] [100%] [zoom +] [Open externally]
```

Leverage the browser's built-in PDF viewer postMessage API for page navigation where available, or accept the browser's native controls as sufficient.

### 5.3 Empty state improvements

Add a "Drag a file here" drop target to the `PreviewPane` empty state. Dropping a `.md`, `.html`, image, or PDF file opens it in preview mode.

---

## Non-goals (explicitly out of scope)

- **Full browser features** — already listed as out of scope in ROADMAP. No bookmarks, navigation history, or dev tools.
- **Live editing in preview** — CodeMirror handles editing; preview is read-only rendering.
- **Jupyter notebook rendering** — Use Jupyter in the terminal.
- **Arbitrary file-type plugins** — The preview surface handles HTML, Markdown, images, video, audio, and PDF. No extension system for additional formats.

---

## Migration & compatibility

| Change | Breakage risk | Mitigation |
| -------- | -------------- | ------------ |
| Phase 1 (urlTransform) | None | Additive; malformed paths degrade to broken images (same as today) |
| Phase 2 (lightbox) | None | Component swap; same asset URLs |
| Phase 3 (unified tabs) | **High** — stale serialized tabs | Increment `SerializedTab` schema version; add migration for old `markdown` kind |
| Phase 4 (server detection) | None | Additive; no config changes |
| Phase 5 (shortcuts) | None | Additive; defaults off via shortcut config |

---

## Testing

| Area | Tests |
| ------ | ------- |
| `urlTransform` | Unit: relative paths resolve correctly, absolute URLs pass through, `data:` URIs pass through |
| `MediaLightbox` | Component: zoom in/out, pan, reset, escape close |
| `normalizeUrl` file paths | Unit: `file://`, absolute, relative, HTTP URL all parsed correctly |
| Server detection | Integration: mock fetch, verify port presets probed, verify dedup |
| Markdown rendered/raw toggle shortcut | Integration: keystroke triggers tab kind swap |
