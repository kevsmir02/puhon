# Web Preview Attribution — Design

Date: 2025-07-16
Status: draft

## Goal

Reliably tie an auto-detected localhost dev server URL to the agent tab that started it, so the preview pill opens the right surface instead of a guessed one.

## Architecture

Three layers: Rust PTY scanner → frontend bridge/store → TabBar pill + Header pill.

```
PTY reader thread (Rust)
  UrlDetector                 ← new, scans for localhost URLs
    │ emits puhon:preview-url { pty_id, url }
    ▼
Frontend bridge
  AgentNotificationsBridge    ← extended to also listen for puhon:preview-url
    │ maps pty_id → leafId → tabId → spaceId
    │ calls updateTab(id, { previewUrl })
    ▼
UI
  TabIcon (in TabBar)         ← globe badge when tab.previewUrl is set
  PreviewUrlPill (in Header)  ← pill showing latest detected URL + dropdown
```

## Components

### 1. Rust: UrlDetector (`src-tauri/src/modules/pty/url_detect.rs`)

A struct that lives in the PTY reader thread alongside `AgentDetector`, processing the same byte stream.

**Regex pattern:**

```
https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d{1,5})?(/\S*)?
```

**Behavior:**

- Strips ANSI escape sequences from the chunk before scanning (embedded SGR codes would break regex matching)
- Emits only when the URL **changes** for a given session (stateful dedup: stores last URL per session in a `HashMap<u32, String>`)
- Rate-limited: at most one emission per 500ms per session — a repainting TUI that redraws `localhost:3000` in every frame won't flood events
- Emits Tauri event: `puhon:preview-url` with payload `{ pty_id: u32, url: String }`

**Integration point:** `session.rs` reader thread, after `agent_detect.process()` and `da_filter.process()`:

```rust
url_detect.process(&buf[..n], |url| {
    let _ = app_reader.emit("puhon:preview-url", PreviewUrlEvent { pty_id: id, url });
});
```

**Tauri event struct:**

```rust
#[derive(Clone, serde::Serialize)]
struct PreviewUrlEvent {
    pty_id: u32,
    url: String,
}
```

**Edge cases:**

- ANSI escape bytes interleaved in the URL string (regex runs on cleaned output)
- A URL that wraps across two reads — accept the first partial match, update on the next read when full URL arrives (the dedup + rate limit handles this gracefully)
- URLs on `0.0.0.0` are treated as `localhost` in the frontend (the iframe can only connect to localhost anyway)

### 2. Frontend bridge: extend AgentNotificationsBridge

**File:** `src/modules/agents/components/AgentNotificationsBridge.tsx`

Add a second `listen` for `puhon:preview-url`:

```typescript
listen<PreviewUrlEvent>("puhon:preview-url", (e) => {
    const leafId = leafIdForPty(e.payload.pty_id);
    if (leafId === null) return;
    const tab = findTerminalTab(ctx.tabs, leafId);
    if (!tab) return;
    // Update the tab's previewUrl field
    updateTab(tab.id, { previewUrl: e.payload.url });
    // If from an agent tab, also mark in the pill store
    if (agentStore.sessions[leafId]) {
        setActivePreviewUrl(tab.spaceId, tab.id, e.payload.url);
    }
})
```

**Clear on exit:** On `Transition::Exited` (already handled in `handleSignal`), also clear `previewUrl`:

```typescript
case "exited":
    store.finish(leafId);
    const t = findTerminalTab(ctx.tabs, leafId);
    if (t?.previewUrl) updateTab(t.id, { previewUrl: undefined });
    return;
```

### 3. TerminalTab type change + space-aware preview opening

**File:** `src/modules/tabs/lib/useTabs.ts`

```typescript
export type TerminalTab = TabBase & {
    // ... existing fields unchanged
    /** Latest localhost URL detected in this tab's PTY output. Transient — never persisted. */
    previewUrl?: string;
};
```

`previewUrl` is excluded from serialization — the existing `serializeTab` switch on `tab.kind` only reads fields it knows about, so `previewUrl` is naturally skipped.

**Tab patch type:** `TabPatch` already supports arbitrary keys via `Partial<Tab>`. No change needed.

**New hook function: `openPreviewInSpace`** — wraps `newPreviewTab` but takes an explicit `spaceId`:

```typescript
const openPreviewInSpace = useCallback((url: string, spaceId: string) => {
    // Dedup: if a preview tab for this URL already exists in this space, focus it.
    setTabs((curr) => {
        const existing = curr.find(
            (t) => t.kind === "preview" && t.url === url && t.spaceId === spaceId,
        );
        if (existing) {
            setActiveId(existing.id);
            // Ensure the space is active too.
            useSpaces.getState().setActive(spaceId);
            return curr;
        }
        const id = nextIdRef.current++;
        setActiveId(id);
        useSpaces.getState().setActive(spaceId);
        return [...curr, { id, kind: "preview", spaceId, title: titleFromUrl(url), url }];
    });
}, []);
```

This ensures clicking a preview pill from any tab always opens the preview in the correct space, deduplicating by URL within that space.

### 4. TabIcon: globe badge

**File:** `src/modules/tabs/TabBar.tsx`, function `TabIcon`

When `tab.kind === "terminal" && tab.previewUrl`:

- Show `Globe02Icon` instead of `ComputerTerminal02Icon`
- Add a small green dot (matching the dirty-indicator pattern) to signal "server running"
- Wrap in a span with `data-no-drag` and an `onClick` handler that calls `openPreviewTab(tab.previewUrl)` in the tab's space

The click handler is passed down as a new prop: `onPreviewFromTab?: (tabId: number, url: string, spaceId: string) => void`.

```tsx
if (tab.kind === "terminal" && tab.previewUrl) {
    return (
        <span
            role="button"
            tabIndex={-1}
            data-no-drag
            onClick={(e) => { e.stopPropagation(); onPreviewFromTab?.(tab.id, tab.previewUrl!, tab.spaceId); }}
            className="inline-flex shrink-0 cursor-pointer items-center gap-0.5"
        >
            <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={2} className="shrink-0 text-green-500" />
            <span className="size-1.5 shrink-0 rounded-full bg-green-500" />
        </span>
    );
}
```

### 5. PreviewUrlPill component

**New file:** `src/modules/preview/PreviewUrlPill.tsx`

Rendered in `Header` between `NotificationBell` and settings.

**States:**

- **Hidden:** No URLs detected anywhere.
- **Active tab has URL:** Dim pill showing the URL — just informational since you're already on that tab. Click still opens/focuses preview.
- **Another tab has URL:** Prominent pill — "localhost:3000 →" — clicking opens a preview tab in the source tab's space. Chevron opens dropdown.

**Dropdown:** Lists all detected URLs, grouped by tab label:

```
┌─────────────────────────────────┐
│ next dev                        │
│   localhost:3000  →  (active)   │
│ vite app                        │
│   localhost:5173  →             │
└─────────────────────────────────┘
```

Clicking a row opens/focuses the preview tab in the correct space.

**Dismiss:** A small × on the pill hides it for this session (clears `previewUrl` on all tabs). It will reappear when a new URL is detected.

## Data flow

```
1. Agent runs `npm run dev` in a PTY
2. Terminal output contains "Local: http://localhost:3000"
3. UrlDetector matches the URL, emits puhon:preview-url { pty_id: 42, url: "http://localhost:3000" }
4. Bridge receives event, maps pty_id=42 → leafId=7 → tabId=3, spaceId="abc"
5. updateTab(3, { previewUrl: "http://localhost:3000" })
6. TabBar re-renders: tab 3 now shows globe icon + green dot
7. PreviewUrlPill appears in Header if tab 3 is not active
8. User clicks pill → openPreviewInSpace("http://localhost:3000", "abc")
9. Dedup: if a preview tab for localhost:3000 already exists in space "abc", focus it; otherwise create one
```

## Lifecycle

| Event | Action |
| --- | --- |
| URL detected in PTY output | Set `tab.previewUrl`, show pill |
| Same URL re-detected (TUI repaint) | No-op (dedup in Rust) |
| Different URL detected in same PTY | Update `tab.previewUrl` (last wins) |
| Agent exits | Clear `tab.previewUrl`, hide pill |
| Terminal tab closed | `previewUrl` dies with the tab |
| User clicks × on pill | Clear all `previewUrl` for session |
| App restart | `previewUrl` is transient, not persisted |

## Files changed

| File | Change |
| --- | --- |
| `src-tauri/src/modules/pty/url_detect.rs` | **New.** UrlDetector struct + regex scanning |
| `src-tauri/src/modules/pty/session.rs` | Wire UrlDetector into PTY reader thread |
| `src-tauri/src/modules/pty/mod.rs` | Register `puhon:preview-url` event |
| `src/modules/tabs/lib/useTabs.ts` | Add `previewUrl?` to `TerminalTab` |
| `src/modules/agents/components/AgentNotificationsBridge.tsx` | Listen for preview-url events, update tabs, clear on exit |
| `src/modules/tabs/TabBar.tsx` | Globe badge in TabIcon, onPreviewFromTab prop |
| `src/modules/header/Header.tsx` | Render PreviewUrlPill, wire props |
| `src/modules/preview/PreviewUrlPill.tsx` | **New.** Header pill + dropdown |
| `src/modules/preview/index.ts` | Export PreviewUrlPill |
| `src/app/App.tsx` | Wire onPreviewFromTab callback, pass to Header; use `openPreviewInSpace` |

## Testing

- **Rust unit tests:** UrlDetector regex matching (valid URLs, ANSI-interleaved, non-localhost URLs rejected, dedup behavior, rate limiting)
- **Rust integration:** `url_detect` alongside `agent_detect` in the same byte stream (they don't interfere)
- **Frontend unit tests:** TabIcon renders globe when `previewUrl` is set, `serializeTab` excludes `previewUrl`
- **Manual test:** Run `npm run dev` in a terminal tab, verify pill appears, click pill, verify preview opens in correct space

## Out of scope

- Detecting non-localhost URLs (production deployments) — these can't be iframed and should open in external browser
- Port scanning / probing — the AddressBar port presets handle this; URL detection only scans existing output
- Persisting detected URLs across app restarts
- Attributing URLs from non-agent terminal sessions (though the mechanism works for them too)
