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
