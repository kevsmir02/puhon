# Image Input Into Agent Prompts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user paste clipboard images (Cmd/Ctrl+Shift+V) or capture screenshots (Cmd/Ctrl+Shift+S) into the terminal, saving them as temp PNG files and pasting the shell-quoted path so the running agent reads the image.

**Architecture:** Three paths converge on `pasteIntoLeaf(leafId, formatDroppedPaths([path]))`: clipboard image (intercept paste shortcut, check for image first), screenshot (new shortcut calls OS tool), and OS file drag-drop (already works). New Rust commands handle clipboard image → PNG encoding and OS screenshot tool invocation.

**Tech Stack:** Rust (Tauri, `image` crate, `tauri-plugin-clipboard-manager`), TypeScript, React, xterm.js, vitest

## Global Constraints

- Paste without Enter (bracketed paste via `term.paste()`)
- Temp files saved to `std::env::temp_dir()` with `puhon-` prefix, NOT auto-cleaned
- Screenshot uses OS-native tool (`screencapture` on macOS, `scrot`/`spectacle`/`grim` on Linux)
- Windows screenshot not supported in this iteration
- Clipboard plugin must be enabled on all platforms (currently Linux-only in `lib.rs`)
- Reuse existing `pasteIntoLeaf` and `formatDroppedPaths`

---

## File Structure

| File | Purpose |
| ------ | --------- |
| `src-tauri/src/modules/clipboard.rs` | **New.** `clipboard_read_image` + `image_screenshot` Tauri commands |
| `src-tauri/src/modules/mod.rs` | Add `pub mod clipboard;` |
| `src-tauri/src/lib.rs` | Enable clipboard plugin on all platforms, register new commands |
| `src-tauri/Cargo.toml` | Add `image` dependency |
| `src-tauri/capabilities/clipboard.json` | Add `clipboard-manager:allow-read-image` permission |
| `src/modules/terminal/lib/imagePaste.ts` | **New.** `tryClipboardImagePaste` + `takeScreenshotAndPaste` |
| `src/modules/terminal/lib/rendererPool.ts` | Extend `isTerminalPaste` for macOS, image-first check, screenshot shortcut |

---

### Task 1: Rust clipboard image command + PNG encoding

**Files:**

- Create: `src-tauri/src/modules/clipboard.rs`
- Modify: `src-tauri/src/modules/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

- Produces: `clipboard_read_image(app: AppHandle) -> Result<String, String>` — reads clipboard image, saves PNG to temp dir, returns path

- [ ] **Step 1: Add `image` dependency to Cargo.toml**

In `src-tauri/Cargo.toml`, add after the other dependencies:

```toml
image = "0.25"
```

- [ ] **Step 2: Create `src-tauri/src/modules/clipboard.rs`**

```rust
use tauri::Manager;

/// Reads an image from the system clipboard, encodes it as PNG, saves to the
/// temp dir, and returns the file path. Errors if the clipboard has no image.
#[tauri::command]
pub async fn clipboard_read_image(app: tauri::AppHandle) -> Result<String, String> {
    let clipboard = app.clipboard();
    let image = clipboard
        .read_image()
        .map_err(|e| format!("no image in clipboard: {e}"))?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("puhon-clipboard-{ts}.png"));

    let rgba = image.rgba();
    let width = image.width();
    let height = image.height();
    let img = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or("failed to construct image from clipboard RGBA")?;
    img.save(&path).map_err(|e| format!("failed to write PNG: {e}"))?;

    Ok(path.to_string_lossy().to_string())
}
```

- [ ] **Step 3: Add module to `mod.rs`**

In `src-tauri/src/modules/mod.rs`, add:

```rust
pub mod clipboard;
```

- [ ] **Step 4: Enable clipboard plugin on all platforms in `lib.rs`**

In `src-tauri/src/lib.rs`, find the clipboard plugin initialization (around line 191):

```rust
let builder = tauri::Builder::default();
#[cfg(target_os = "linux")]
let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
builder
```

Change to enable the plugin on all platforms:

```rust
let builder = tauri::Builder::default();
let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
builder
```

- [ ] **Step 5: Register the command in `lib.rs`**

In the `invoke_handler` macro (around line 249), add:

```rust
crate::modules::clipboard::clipboard_read_image,
```

- [ ] **Step 6: Build to verify compilation**

Run: `cargo build`
Expected: clean build, no errors

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/modules/clipboard.rs src-tauri/src/modules/mod.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: add clipboard_read_image Tauri command for image clipboard"
```

---

### Task 2: Rust screenshot command

**Files:**

- Modify: `src-tauri/src/modules/clipboard.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

- Produces: `image_screenshot() -> Result<String, String>` — calls OS screenshot tool, saves PNG to temp dir, returns path

- [ ] **Step 1: Add `image_screenshot` command to `clipboard.rs`**

Add to `src-tauri/src/modules/clipboard.rs`:

```rust
/// Captures a screenshot using the OS-native tool, saves it as a PNG to the
/// temp dir, and returns the file path. Blocks until the user completes or
/// cancels the screenshot interaction.
#[tauri::command]
pub async fn image_screenshot() -> Result<String, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("puhon-screenshot-{ts}.png"));
    let path_str = path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("screencapture")
            .args(["-i", &path_str])
            .output()
            .map_err(|e| format!("failed to run screencapture: {e}"))?;
        if !output.status.success() {
            return Err("screenshot cancelled".into());
        }
        return Ok(path_str);
    }

    #[cfg(target_os = "linux")]
    {
        if which::which("scrot").is_ok() {
            let output = std::process::Command::new("scrot")
                .arg(&path_str)
                .output()
                .map_err(|e| format!("failed to run scrot: {e}"))?;
            if !output.status.success() {
                return Err("screenshot cancelled".into());
            }
            return Ok(path_str);
        }
        if which::which("spectacle").is_ok() {
            let output = std::process::Command::new("spectacle")
                .args(["-b", "-n", "-o", &path_str])
                .output()
                .map_err(|e| format!("failed to run spectacle: {e}"))?;
            if !output.status.success() {
                return Err("screenshot cancelled".into());
            }
            return Ok(path_str);
        }
        if which::which("grim").is_ok() {
            let output = std::process::Command::new("grim")
                .arg(&path_str)
                .output()
                .map_err(|e| format!("failed to run grim: {e}"))?;
            if !output.status.success() {
                return Err("screenshot cancelled".into());
            }
            return Ok(path_str);
        }
        return Err("no screenshot tool found. Install scrot, spectacle, or grim".into());
    }

    #[cfg(target_os = "windows")]
    {
        let _ = path;
        Err("screenshot capture not yet supported on Windows".into())
    }
}
```

- [ ] **Step 2: Register the command in `lib.rs`**

In the `invoke_handler` macro, add after `clipboard_read_image`:

```rust
crate::modules::clipboard::image_screenshot,
```

- [ ] **Step 3: Build to verify compilation**

Run: `cargo build`
Expected: clean build, no errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modules/clipboard.rs src-tauri/src/lib.rs
git commit -m "feat: add image_screenshot Tauri command for OS screenshot capture"
```

---

### Task 3: Clipboard capability permissions

**Files:**

- Modify: `src-tauri/capabilities/clipboard.json`

- [ ] **Step 1: Add read-image permission**

In `src-tauri/capabilities/clipboard.json`, add to the `permissions` array:

```json
"clipboard-manager:allow-read-image"
```

The full file becomes:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "clipboard",
  "description": "Native clipboard read/write for the terminal. Linux-only: WebKitGTK's web clipboard can't read copies made in other apps.",
  "platforms": ["linux"],
  "windows": [
    "main"
  ],
  "permissions": [
    "clipboard-manager:allow-read-text",
    "clipboard-manager:allow-write-text",
    "clipboard-manager:allow-read-image"
  ]
}
```

Note: The `platforms: ["linux"]` restriction applies to the text clipboard workaround. For image clipboard on macOS, we need a separate capability or to broaden this one. Since the clipboard plugin is now enabled on all platforms, update `platforms` to include all:

```json
"platforms": ["linux", "macOS", "windows"]
```

- [ ] **Step 2: Build to verify**

Run: `cargo build`
Expected: clean build

- [ ] **Step 3: Commit**

```bash
git add src-tauri/capabilities/clipboard.json
git commit -m "feat: add clipboard read-image permission for all platforms"
```

---

### Task 4: Frontend image paste logic

**Files:**

- Create: `src/modules/terminal/lib/imagePaste.ts`

**Interfaces:**

- Produces: `tryClipboardImagePaste(leafId: number): Promise<boolean>` — tries clipboard image, pastes path if found, returns false if no image
- Produces: `takeScreenshotAndPaste(leafId: number): Promise<void>` — captures screenshot, pastes path

- [ ] **Step 1: Create `src/modules/terminal/lib/imagePaste.ts`**

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
/// into the terminal. Shows a toast on error (tool not found). User-cancelled
/// screenshots are silent.
export async function takeScreenshotAndPaste(leafId: number): Promise<void> {
  try {
    const path = await invoke<string>("image_screenshot");
    pasteIntoLeaf(leafId, formatDroppedPaths([path]));
  } catch (e) {
    const msg = String(e);
    if (msg.includes("no screenshot tool")) {
      toast.error(msg);
    }
    // User-cancelled screenshots are silent (non-zero exit)
  }
}
```

- [ ] **Step 2: Run typecheck to verify**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/modules/terminal/lib/imagePaste.ts
git commit -m "feat: add imagePaste module for clipboard image and screenshot paste"
```

---

### Task 5: Wire paste interceptor and screenshot shortcut

**Files:**

- Modify: `src/modules/terminal/lib/rendererPool.ts`

**Interfaces:**

- Consumes: `tryClipboardImagePaste` + `takeScreenshotAndPaste` from Task 4
- Produces: paste handler checks image clipboard first; screenshot shortcut calls OS tool

- [ ] **Step 1: Add imports to `rendererPool.ts`**

At the top of `src/modules/terminal/lib/rendererPool.ts`, add:

```typescript
import { tryClipboardImagePaste, takeScreenshotAndPaste } from "./imagePaste";
```

- [ ] **Step 2: Extend `isTerminalPaste` for macOS**

Find the `isTerminalPaste` function (around line 1056):

```typescript
function isTerminalPaste(e: KeyboardEvent): boolean {
  return (
    !IS_MAC &&
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyV" || e.key === "v" || e.key === "V")
  );
}
```

Replace with:

```typescript
function isTerminalPaste(e: KeyboardEvent): boolean {
  if (IS_MAC) {
    return (
      e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      (e.code === "KeyV" || e.key === "v" || e.key === "V")
    );
  }
  return (
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyV" || e.key === "v" || e.key === "V")
  );
}
```

- [ ] **Step 3: Add `isScreenshotShortcut` function**

Add after `isTerminalPaste`:

```typescript
function isScreenshotShortcut(e: KeyboardEvent): boolean {
  if (IS_MAC) {
    return (
      e.metaKey &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (e.code === "KeyS" || e.key === "s" || e.key === "S")
    );
  }
  return (
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyS" || e.key === "s" || e.key === "S")
  );
}
```

- [ ] **Step 4: Add screenshot handler in the custom key event handler**

In the `attachCustomKeyEventHandler` block (around line 243), add the screenshot check BEFORE the paste check. Find the `isTerminalPaste` block and add before it:

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

- [ ] **Step 5: Update paste handler to check image first**

Find the existing paste handler block (around line 290):

```typescript
if (isTerminalPaste(event)) {
  if (event.type === "keydown") {
    const targetLeafId = slot.currentLeafId;
    void readTerminalClipboard().then((text) => {
      if (text && slot.currentLeafId === targetLeafId)
        slot.term.paste(text);
    });
  }
  event.preventDefault();
  return false;
}
```

Replace with:

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

- [ ] **Step 6: Run typecheck to verify**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Run tests to verify no regression**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 8: Commit**

```bash
git add src/modules/terminal/lib/rendererPool.ts
git commit -m "feat: intercept paste for clipboard images and add screenshot shortcut"
```

---

### Task 6: Manual integration verification

**Files:**

- No file changes — manual verification only

- [ ] **Step 1: Verify clipboard image paste**

1. Copy an image to the clipboard (e.g. screenshot with PrtScrn, or copy an image from a browser)
2. Focus a terminal pane running Claude Code
3. Press Ctrl+Shift+V (Linux) or Cmd+V (macOS)
4. Verify: the image path (e.g. `/tmp/puhon-clipboard-1234567890.png`) appears in the terminal input
5. Verify: Claude Code resolves it to `[Image #N]`
6. Press Enter to submit

- [ ] **Step 2: Verify text paste still works**

1. Copy some text to the clipboard
2. Focus a terminal pane
3. Press Ctrl+Shift+V (Linux) or Cmd+V (macOS)
4. Verify: the text is pasted (no image path)

- [ ] **Step 3: Verify screenshot capture**

1. Focus a terminal pane
2. Press Ctrl+Shift+S (Linux) or Cmd+Shift+S (macOS)
3. Verify: the OS screenshot tool activates (area selection)
4. Select an area
5. Verify: the screenshot path appears in the terminal input
6. Press Enter to submit to the agent

- [ ] **Step 4: Verify screenshot cancel**

1. Focus a terminal pane
2. Press Ctrl+Shift+S
3. Press Escape to cancel the screenshot
4. Verify: no path pasted, no error toast

- [ ] **Step 5: Verify OS file drag-drop (existing, no regression)**

1. Drag an image file from the OS file manager onto a terminal pane
2. Verify: the file path is pasted (existing behavior, no regression)
