use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

const MAX_SESSIONS_PER_SPACE: usize = 8;

#[derive(Default)]
pub struct SessionState;

#[derive(Serialize, Deserialize, Clone)]
struct SessionMeta {
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    saved_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SessionData {
    pub data: String,
    #[serde(flatten)]
    meta: SessionMeta,
}

fn sessions_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("terax")
        .join("sessions")
}

fn space_dir(space_id: &str) -> PathBuf {
    sessions_dir().join(space_id)
}

fn term_path(space_id: &str, tab_id: u32, leaf_id: u32) -> PathBuf {
    space_dir(space_id).join(format!("{tab_id}-{leaf_id}.term"))
}

fn meta_path(space_id: &str, tab_id: u32, leaf_id: u32) -> PathBuf {
    space_dir(space_id).join(format!("{tab_id}-{leaf_id}.meta"))
}

fn prune(space_id: &str) {
    let dir = space_dir(space_id);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut term_files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "term"))
        .collect();

    if term_files.len() <= MAX_SESSIONS_PER_SPACE {
        return;
    }

    term_files.sort_by_key(|e| {
        e.metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });

    for entry in term_files.iter().take(term_files.len() - MAX_SESSIONS_PER_SPACE) {
        let _ = fs::remove_file(entry.path());
    }
}

#[tauri::command]
pub fn session_save(
    space_id: String,
    tab_id: u32,
    leaf_id: u32,
    data: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let dir = space_dir(&space_id);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;

    let meta = SessionMeta {
        cwd,
        cols,
        rows,
        saved_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };

    // Write .term file atomically
    let mut tmp =
        NamedTempFile::new_in(&dir).map_err(|e| format!("tempfile: {e}"))?;
    tmp.write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    tmp.persist(term_path(&space_id, tab_id, leaf_id))
        .map_err(|e| format!("persist: {e}"))?;

    // Write .meta file atomically
    let meta_json = serde_json::to_string(&meta).map_err(|e| format!("json: {e}"))?;
    let mut tmp_meta =
        NamedTempFile::new_in(&dir).map_err(|e| format!("tempfile: {e}"))?;
    tmp_meta
        .write_all(meta_json.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    tmp_meta
        .persist(meta_path(&space_id, tab_id, leaf_id))
        .map_err(|e| format!("persist: {e}"))?;

    prune(&space_id);
    Ok(())
}

#[tauri::command]
pub fn session_load(
    space_id: String,
    tab_id: u32,
    leaf_id: u32,
) -> Result<Option<SessionData>, String> {
    let tp = term_path(&space_id, tab_id, leaf_id);
    let mp = meta_path(&space_id, tab_id, leaf_id);

    let data = match fs::read_to_string(&tp) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read: {e}")),
    };

    let meta: SessionMeta = match fs::read_to_string(&mp) {
        Ok(json) => serde_json::from_str(&json).map_err(|e| format!("parse: {e}"))?,
        Err(_) => SessionMeta {
            cwd: None,
            cols: 80,
            rows: 24,
            saved_at: 0,
        },
    };

    if data.is_empty() {
        return Ok(None);
    }

    Ok(Some(SessionData { data, meta }))
}

#[tauri::command]
pub fn session_delete(
    space_id: String,
    tab_id: u32,
    leaf_id: u32,
) -> Result<(), String> {
    let tp = term_path(&space_id, tab_id, leaf_id);
    let mp = meta_path(&space_id, tab_id, leaf_id);
    let _ = fs::remove_file(&tp);
    let _ = fs::remove_file(&mp);
    Ok(())
}

#[tauri::command]
pub fn session_delete_space(space_id: String) -> Result<(), String> {
    let dir = space_dir(&space_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("rmdir: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_sessions_dir() -> PathBuf {
        std::env::temp_dir().join("terax-session-tests")
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tmp_sessions_dir().join("test-space");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let tp = dir.join("42-0.term");
        let mp = dir.join("42-0.meta");

        let data = "test-terminal-state";
        let meta = SessionMeta {
            cwd: Some("/home/user".into()),
            cols: 120,
            rows: 40,
            saved_at: 1234567890,
        };

        fs::write(&tp, data).unwrap();
        fs::write(&mp, serde_json::to_string(&meta).unwrap()).unwrap();

        let loaded = fs::read_to_string(&tp).unwrap();
        assert_eq!(loaded, data);

        let loaded_meta: SessionMeta =
            serde_json::from_str(&fs::read_to_string(&mp).unwrap()).unwrap();
        assert_eq!(loaded_meta.cwd.as_deref(), Some("/home/user"));
        assert_eq!(loaded_meta.cols, 120);
        assert_eq!(loaded_meta.rows, 40);

        let _ = fs::remove_dir_all(tmp_sessions_dir());
    }

    #[test]
    fn delete_removes_files() {
        let dir = tmp_sessions_dir().join("delete-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let tp = dir.join("1-0.term");
        let mp = dir.join("1-0.meta");
        fs::write(&tp, "x").unwrap();
        fs::write(&mp, "{}").unwrap();

        fs::remove_file(&tp).unwrap();
        fs::remove_file(&mp).unwrap();

        assert!(!tp.exists());
        assert!(!mp.exists());

        let _ = fs::remove_dir_all(tmp_sessions_dir());
    }
}
