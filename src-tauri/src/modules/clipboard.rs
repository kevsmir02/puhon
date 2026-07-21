use tauri_plugin_clipboard_manager::ClipboardExt;

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
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or("failed to construct image from clipboard RGBA")?;
    img.save(&path).map_err(|e| format!("failed to write PNG: {e}"))?;

    Ok(path.to_string_lossy().to_string())
}
