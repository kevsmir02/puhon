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
