# Image Input Into Agent Prompts — Design

Date: 2026-07-22
Status: draft

## Goal

Let the user paste clipboard images or capture screenshots and feed them to the running agent (Claude Code, Codex, etc.) as image file paths. Terminals are text-only, so the flow is: get image data → save to a temp PNG file → paste the shell-quoted file path into the terminal → the agent reads the file.

## Existing Infrastructure

Three systems already in place make this a small change:

1. **Paste handler** (`src/modules/terminal/lib/rendererPool.ts:290`) — xterm's `attachCustomKeyEventHandler` intercepts Ctrl+Shift+V (Linux). It reads the text clipboard and calls `slot.term.paste(text)`. This is where we intercept to check for image clipboard first.

2. **Path paste** (`src/modules/terminal/lib/rendererPool.ts:147` → `pasteIntoLeaf`, `src/modules/terminal/lib/quoteShellPath.ts` → `formatDroppedPaths`) — bracketed paste of shell-quoted file paths. Already used by OS file drops and explorer drag-drop. Reused as-is.

3. **Tauri clipboard plugin** (`tauri-plugin-clipboard-manager` v2.3.2) — already in `Cargo.toml`. The JS API exports `readImage()` which returns an `Image` object (with `.rgba()` for raw RGBA bytes). The Rust API has `clipboard.read_image()` / `clipboard.write_image()`. Currently only `clipboard-manager:allow-read-text` / `allow-write-text` permissions are granted; we need `allow-read-image`.

**Claude Code image resolution:** The comment in `quoteShellPath.ts:4` says "Claude resolves an image path to '[Image #N]'". Pasting a path to a `.png` file into Claude Code already works — the agent reads the file. This design extends that mechanism to clipboard images and screenshots by saving them to temp files first.

## Architecture

Three image input paths, all converging on `pasteIntoLeaf(leafId, formatDroppedPaths([path]))`:

```
1. Clipboard paste (Cmd/Ctrl+Shift+V)
   ├─ Check clipboard for image (Tauri readImage)
   │   YES → save RGBA → PNG → /tmp/puhon-clipboard-<ts>.png
   │        → pasteIntoLeaf(leafId, formatDroppedPaths([path]))
   │   NO  → existing text paste (readTerminalClipboard → term.paste)
   └─ (async — handler returns false to prevent xterm default while checking)

2. Screenshot (Cmd/Ctrl+Shift+S)
   └─ Call OS screenshot tool → save to /tmp/puhon-screenshot-<ts>.png
      → pasteIntoLeaf(activeLeafId, formatDroppedPaths([path]))

3. OS file drag-drop (already works)
   └─ Existing useTerminalFileDrop → formatDroppedPaths([path])
      → agent reads image file by path (no new work needed)
```

## Components

### 1. Rust: clipboard image read (`src-tauri/src/modules/clipboard.rs`)

**New file.** A Tauri command that reads the clipboard image and saves it as a PNG.

```rust
use std::path::PathBuf;
use tauri::Manager;

/// Reads an image from the system clipboard and saves it as a PNG to the temp
/// dir. Returns the file path, or an error if the clipboard has no image.
#[tauri::command]
pub async fn clipboard_read_image(app: tauri::AppHandle) -> Result<String, String> {
    let clipboard = app.clipboard();
    let image = clipboard.read_image().map_err(|e| format!("no image in clipboard: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("puhon-clipboard-{ts}.png"));
    // image is a tauri::image::Image (RGBA bytes + width + height)
    // Encode as PNG and write to file
    let rgba = image.rgba();
    let width = image.width();
    let height = image.height();
    // Encode as PNG using the `image` crate:
    let img = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or("failed to construct image from clipboard RGBA")?;
    img.save(&path).map_err(|e| format!("failed to write PNG: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}
```

Note: The `tauri::image::Image` provides RGBA bytes. We need a PNG encoder to write them to a file. The `image` crate (already a transitive dependency of `tauri`) provides `image::RgbaImage::from_raw(width, height, rgba)` → `img.save(path)`. We need to add `image` as a direct dependency in `Cargo.toml`.

### 2. Rust: screenshot capture (`src-tauri/src/modules/clipboard.rs`)

A Tauri command that calls the OS screenshot tool:

```rust
/// Captures a screenshot using the OS-native tool, saves it as a PNG, and
/// returns the file path. Blocks until the user completes or cancels the
/// screenshot interaction.
#[tauri::command]
pub async fn image_screenshot() -> Result<String, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("puhon-screenshot-{ts}.png"));
    let path_str = path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    let (cmd, args) = ("screencapture", vec!["-i".to_string(), path_str.clone()]);

    #[cfg(target_os = "linux")]
    let (cmd, args) = {
        // Try common Linux screenshot tools in order of preference.
        // All write directly to a file path (no stdout piping needed).
        if which::which("grim").is_ok() {
            ("grim", vec![path_str.clone()]) // Wayland: full-screen capture to file
        } else if which::which("scrot").is_ok() {
            ("scrot", vec![path_str.clone()])
        } else if which::which("spectacle").is_ok() {
            // -b: don't show window, -n: don't show after capture, -o: output to file
            ("spectacle", vec!["-b".to_string(), "-n".to_string(), "-o".to_string(), path_str.clone()])
        } else {
            return Err("no screenshot tool found. Install scrot, spectacle, or grim".into());
        }
    };

    #[cfg(target_os = "windows")]
    return Err("screenshot capture not yet supported on Windows".into());

    let output = std::process::Command::new(cmd)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run {cmd}: {e}"))?;

    if !output.status.success() {
        return Err(format!("{cmd} exited with {}", output.status));
    }

    // All tools write directly to the file path; no stdout piping needed.

    Ok(path_str)
}
```

Platform-specific screenshot tools:
- **macOS:** `screencapture -i <path>` (interactive area selection)
- **Linux:** `scrot <path>` or `spectacle -b -n -o <path>` or `grim - | ...` (area selection depends on tool)
- **Windows:** Not supported in this iteration

### 3. Rust: register commands and permissions

**`src-tauri/src/modules/mod.rs`** — Add `pub mod clipboard;`

**`src-tauri/src/lib.rs`** — Register commands in the Tauri builder:
```rust
clipboard::clipboard_read_image,
clipboard::image_screenshot,
```

**`src-tauri/capabilities/clipboard.json`** — Add image read permission:
```json
"clipboard-manager:allow-read-image"
```

**`src-tauri/Cargo.toml`** — Add `image` as a direct dependency (for PNG encoding):
```toml
image = "0.25"
```

### 4. Frontend: image paste logic (`src/modules/terminal/lib/imagePaste.ts`)

**New file.** Two functions:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { pasteIntoLeaf } from "./rendererPool";
import { formatDroppedPaths } from "./quoteShellPath";

/// Tries to read an image from the clipboard, save it as a temp PNG, and paste
/// the file path into the terminal. Returns true if an image was found and
/// pasted; false if the clipboard has no image (caller should fall back to text).
export async function tryClipboardImagePaste(leafId: number): Promise<boolean> {
  try {
    const path = await invoke<string>("clipboard_read_image");
    return pasteIntoLeaf(leafId, formatDroppedPaths([path]));
  } catch {
    return false;
  }
}

/// Captures a screenshot via the OS tool, saves it, and pastes the file path
/// into the terminal. Shows a toast on error (tool not found, user cancelled
/// silently if non-zero exit).
export async function takeScreenshotAndPaste(leafId: number): Promise<void> {
  try {
    const path = await invoke<string>("image_screenshot");
    pasteIntoLeaf(leafId, formatDroppedPaths([path]));
  } catch (e) {
    const msg = String(e);
    if (msg.includes("no screenshot tool")) {
      toast.error(msg);
    }
    // User-cancelled screenshots (non-zero exit) are silent
  }
}
```

### 5. Frontend: extend paste handler (`src/modules/terminal/lib/rendererPool.ts`)

Extend `isTerminalPaste` to also match macOS Cmd+V:
```typescript
function isTerminalPaste(e: KeyboardEvent): boolean {
  if (IS_MAC) {
    return e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey &&
      (e.code === "KeyV" || e.key === "v" || e.key === "V");
  }
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey &&
    (e.code === "KeyV" || e.key === "v" || e.key === "V");
}
```

Update the paste handler block (line 290) to check for image first:
```typescript
if (isTerminalPaste(event)) {
  if (event.type === "keydown") {
    const targetLeafId = slot.currentLeafId;
    void tryClipboardImagePaste(targetLeafId).then((wasImage) => {
      if (!wasImage && slot.currentLeafId === targetLeafId) {
        void readTerminalClipboard().then((text) => {
          if (text) slot.term.paste(text);
        });
      }
    });
  }
  event.preventDefault();
  return false;
}
```

Add screenshot shortcut detection (before the paste handler):
```typescript
function isScreenshotShortcut(e: KeyboardEvent): boolean {
  const mod = IS_MAC ? e.metaKey : (e.ctrlKey && e.shiftKey);
  return mod && !e.altKey && (e.code === "KeyS" || e.key === "s" || e.key === "S")
    && (IS_MAC ? !e.ctrlKey && !e.shiftKey : !e.metaKey);
}
```

In the custom key event handler:
```typescript
if (isScreenshotShortcut(event)) {
  if (event.type === "keydown") {
    const targetLeafId = slot.currentLeafId;
    if (targetLeafId !== null) void takeScreenshotAndPaste(targetLeafId);
  }
  event.preventDefault();
  return false;
}
```

### No changes needed

- `pasteIntoLeaf` / `formatDroppedPaths` — reused as-is
- `useTerminalFileDrop` — OS file drops already work for image files
- `quoteShellPath` — already handles image file paths correctly

## Data flow

### Clipboard image paste
```
1. User presses Ctrl+Shift+V (Linux) or Cmd+V (macOS) in a terminal pane
2. attachCustomKeyEventHandler fires, isTerminalPaste matches
3. Handler returns false (prevents xterm default), starts async check
4. tryClipboardImagePaste(leafId) → invoke("clipboard_read_image")
5. Rust: clipboard.read_image() → RGBA bytes → encode PNG → write /tmp/puhon-clipboard-<ts>.png
6. Returns path to frontend
7. pasteIntoLeaf(leafId, formatDroppedPaths([path]))
8. formatDroppedPaths → "/tmp/puhon-clipboard-1234567890.png "
9. pasteIntoLeaf → slot.term.paste(text) → bracketed paste into xterm
10. Agent (Claude Code) receives the path, reads the PNG, resolves to [Image #N]
```

### Screenshot
```
1. User presses Ctrl+Shift+S (Linux) or Cmd+Shift+S (macOS) in a terminal pane
2. isScreenshotShortcut matches
3. Handler returns false, calls takeScreenshotAndPaste(leafId)
4. invoke("image_screenshot") → Rust calls OS screenshot tool
5. User selects screen area (interactive)
6. OS tool saves PNG to /tmp/puhon-screenshot-<ts>.png
7. Returns path to frontend
8. pasteIntoLeaf(leafId, formatDroppedPaths([path]))
9. Agent receives the path, reads the PNG
```

### OS file drag-drop (existing, no changes)
```
1. User drags an image file from Finder/Explorer onto a terminal pane
2. useTerminalFileDrop fires, calls formatDroppedPaths([path])
3. pasteIntoLeaf → bracketed paste
4. Agent receives the path, reads the image file
```

## Edge cases

| Scenario | Behavior |
| --- | --- |
| Clipboard has image + text | Image wins. `readImage()` succeeds → image path pasted. Text ignored. |
| Clipboard is empty | `clipboard_read_image` fails → `tryClipboardImagePaste` returns `false` → text paste reads empty → nothing pasted. |
| Screenshot tool not installed | Rust command fails with "no screenshot tool found" → frontend shows toast with install hint. No path pasted. |
| Screenshot cancelled by user (Escape) | OS tool exits non-zero → Rust returns error → frontend catches silently (no toast for user-initiated cancel). |
| Temp file cleanup | Files written to `std::env::temp_dir()` with `puhon-` prefix. NOT auto-cleaned (unreliable on crash/force-quit). OS temp dir is periodically cleared. TTL cleanup is out of scope. |
| Paste race (leaf changes during async) | Handler captures `targetLeafId`, checks `slot.currentLeafId === targetLeafId` before pasting. Paste goes to the original pane. |
| macOS Cmd+V | `isTerminalPaste` extended to match Cmd+V on macOS (currently Linux-only Ctrl+Shift+V). |
| Large images (4K screenshot ~8MB) | No size limit. Temp file write is local disk. Agent API handles oversized images. Puhon doesn't enforce limits. |
| Multiple rapid pastes | Each creates a unique temp file (timestamp-based name). No dedup. Two pastes = two files, two paths. |
| No terminal tab open | Screenshot shortcut does nothing (no active leaf). Paste handler doesn't fire (no terminal focused). |

## Lifecycle

| Event | Action |
| --- | --- |
| Ctrl+Shift+V / Cmd+V in terminal | Check clipboard for image → save PNG → paste path, or fall back to text paste |
| Ctrl+Shift+S / Cmd+Shift+S in terminal | Call OS screenshot tool → save PNG → paste path |
| OS file drag onto terminal | Existing behavior — paste file path (already works for images) |
| Clipboard has no image | Fall back to text paste (existing behavior) |
| Screenshot cancelled | Silent — no paste, no error |
| Screenshot tool missing | Toast notification with install hint |

## Files changed

| File | Change |
| --- | --- |
| `src-tauri/src/modules/clipboard.rs` | **New.** `clipboard_read_image` + `image_screenshot` Tauri commands |
| `src-tauri/src/modules/mod.rs` | Add `pub mod clipboard;` |
| `src-tauri/src/lib.rs` | Register the two new commands |
| `src-tauri/Cargo.toml` | Add `image = "0.25"` dependency (PNG encoding) |
| `src-tauri/capabilities/clipboard.json` | Add `clipboard-manager:allow-read-image` permission |
| `src/modules/terminal/lib/imagePaste.ts` | **New.** `tryClipboardImagePaste` + `takeScreenshotAndPaste` |
| `src/modules/terminal/lib/rendererPool.ts` | Extend `isTerminalPaste` for macOS, add image-first check, add screenshot shortcut |

## Testing

- **Rust unit test:** PNG encoding from RGBA bytes (mock image data → file → verify PNG header)
- **Rust unit test:** `image_screenshot` command selection logic (mock `which::which` per platform)
- **Frontend unit test:** `tryClipboardImagePaste` — mock `invoke` returning a path → verify `pasteIntoLeaf` called with formatted path; mock `invoke` rejecting → verify returns `false`
- **Frontend unit test:** `isTerminalPaste` / `isScreenshotShortcut` — keyboard event matching per platform
- **Manual test:** Copy an image to clipboard, Ctrl+Shift+V in a terminal running Claude Code, verify `[Image #N]` appears. Take a screenshot with Ctrl+Shift+S, verify the path appears.

## Out of scope

- Windows screenshot support (different API, defer to future task)
- Temp file cleanup/TTL (OS temp dir handles this)
- Image size limits (agent API handles oversized images)
- Clipboard image *write* (writing images to clipboard from Puhon)
- Pasting images into non-terminal tabs (editor, preview)
- Area-selection UI for screenshots (we use the OS tool's native UI)
- `grim` stdout-piping workaround (use `scrot`/`spectacle` which write directly to files; `grim` is a Wayland-only fallback)
