use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::ipc::Channel;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum PackageManager {
    Dnf,
    Apt,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    pub is_appimage: bool,
    pub package_manager: Option<PackageManager>,
}

/// Pure routing decision over three boolean facts. Tested directly; the
/// command below gathers the facts from the environment and package DBs.
pub fn classify(is_appimage: bool, rpm_registered: bool, deb_registered: bool) -> DetectResult {
    if is_appimage {
        return DetectResult { is_appimage: true, package_manager: None };
    }
    let package_manager = if rpm_registered {
        Some(PackageManager::Dnf)
    } else if deb_registered {
        Some(PackageManager::Apt)
    } else {
        None
    };
    DetectResult { is_appimage: false, package_manager }
}

fn command_succeeds(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Terax registers as `Terax` under rpm and `terax` under dpkg (productName,
/// dpkg lowercases). Confirm exact casing at first release.
fn rpm_registered() -> bool {
    command_succeeds("rpm", &["-q", "Terax"])
}
fn deb_registered() -> bool {
    command_succeeds("dpkg", &["-s", "terax"])
}

#[tauri::command]
pub fn updater_detect() -> DetectResult {
    let is_appimage = std::env::var_os("APPIMAGE").is_some();
    let rpm = if is_appimage { false } else { rpm_registered() };
    let deb = if is_appimage { false } else { deb_registered() };
    classify(is_appimage, rpm, deb)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "lowercase", tag = "event")]
pub enum DownloadEvent {
    Started { content_length: Option<u64> },
    Progress { downloaded: u64, total: Option<u64> },
    Finished,
}

/// Controlled download root. Never user-supplied.
pub fn update_dir() -> PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    base.join("terax").join("updates")
}

pub fn validate_download_url(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw).map_err(|e| format!("bad url: {e}"))?;
    if url.scheme() != "https" {
        return Err("download url must be https".into());
    }
    match url.host_str() {
        Some("github.com") | Some("objects.githubusercontent.com") => Ok(raw.into()),
        _ => Err("download url host not allowed".into()),
    }
}

pub fn is_within(parent: &Path, candidate: &Path) -> bool {
    let Ok(canon_parent) = parent.canonicalize() else {
        return false;
    };
    let Some(file_name) = candidate.file_name() else {
        return false;
    };
    let Some(candidate_parent) = candidate.parent() else {
        return false;
    };
    let Ok(canon_candidate_parent) = candidate_parent.canonicalize() else {
        return false;
    };
    canon_candidate_parent.join(file_name).starts_with(canon_parent)
}

#[tauri::command]
pub async fn updater_download(
    url: String,
    on_event: Channel<DownloadEvent>,
) -> Result<String, String> {
    let url = validate_download_url(&url)?;
    std::fs::create_dir_all(update_dir()).map_err(|e| format!("mkdir updates: {e}"))?;

    let resp = reqwest::get(&url).await.map_err(|e| format!("request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download http {}", resp.status()));
    }
    let total = resp.content_length();
    let _ = on_event.send(DownloadEvent::Started { content_length: total });

    let path = update_dir().join(format!("terax-{}.pkg", std::process::id()));
    let mut file = std::fs::File::create(&path).map_err(|e| format!("create file: {e}"))?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    while let Some(chunk) = futures_util::StreamExt::next(&mut stream).await {
        let chunk = chunk.map_err(|e| format!("stream: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
        downloaded += chunk.len() as u64;
        let _ = on_event.send(DownloadEvent::Progress { downloaded, total });
    }
    file.flush().map_err(|e| format!("flush: {e}"))?;
    drop(file);
    let _ = on_event.send(DownloadEvent::Finished);
    Ok(path.to_string_lossy().into_owned())
}

/// Public minisign key from tauri.conf.json plugins.updater.pubkey.
const UPDATER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDcwQ0M5QjRBRjAwQzc4QkUKUldTK2VBendTcHZNY0FweHNsZ1Z6cHBweGo3U2hXdHl6dmdDRll2Vzg1cWRZYS90Z2VKU3g1MVkK";

pub fn build_install_args(pm: PackageManager, path: &str) -> Vec<String> {
    match pm {
        PackageManager::Dnf => vec![
            "pkexec".into(), "dnf".into(), "install".into(), "-y".into(), path.into(),
        ],
        PackageManager::Apt => vec![
            "pkexec".into(), "apt-get".into(), "install".into(), "--yes".into(), path.into(),
        ],
    }
}

pub fn verify_signature(data: &[u8], sig_text: &str, pubkey_b64: &str) -> Result<(), String> {
    let pk = minisign_verify::PublicKey::from_base64(pubkey_b64)
        .map_err(|e| format!("bad pubkey: {e}"))?;
    let sig = minisign_verify::Signature::decode(sig_text)
        .map_err(|e| format!("bad signature: {e}"))?;
    pk.verify(data, &sig, false).map_err(|e| format!("signature mismatch: {e}"))
}

fn read_sig_for(pkg_path: &Path) -> Result<String, String> {
    let sig_path = format!("{}.sig", pkg_path.to_string_lossy());
    std::fs::read_to_string(&sig_path).map_err(|e| format!("read sig {sig_path}: {e}"))
}

#[tauri::command]
pub async fn updater_install(
    path: String,
    package_manager: PackageManager,
) -> Result<(), String> {
    let pkg_path = PathBuf::from(&path);
    if !is_within(&update_dir(), &pkg_path) {
        return Err("install path outside controlled dir".into());
    }
    if which::which("pkexec").is_err() {
        return Err("pkexec-missing: pkexec not found on PATH".into());
    }
    let data = std::fs::read(&pkg_path).map_err(|e| format!("read pkg: {e}"))?;
    let sig_text = read_sig_for(&pkg_path)?;
    verify_signature(&data, &sig_text, UPDATER_PUBKEY)?;

    let mut args = build_install_args(package_manager, &path);
    let program = args.remove(0);
    let status = Command::new(&program)
        .args(&args)
        .status()
        .map_err(|e| format!("spawn {program}: {e}"))?;
    if !status.success() {
        return Err(format!("install exited {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appimage_wins_over_package_db() {
        let r = classify(true, true, true);
        assert!(r.is_appimage);
        assert_eq!(r.package_manager, None);
    }

    #[test]
    fn rpm_registered_selects_dnf() {
        let r = classify(false, true, false);
        assert!(!r.is_appimage);
        assert_eq!(r.package_manager, Some(PackageManager::Dnf));
    }

    #[test]
    fn deb_registered_when_no_rpm() {
        let r = classify(false, false, true);
        assert_eq!(r.package_manager, Some(PackageManager::Apt));
    }

    #[test]
    fn neither_registered_is_none() {
        let r = classify(false, false, false);
        assert_eq!(r.package_manager, None);
    }

    #[test]
    fn rpm_takes_precedence_over_deb() {
        let r = classify(false, true, true);
        assert_eq!(r.package_manager, Some(PackageManager::Dnf));
    }

    #[test]
    fn accepts_github_release_url() {
        assert!(validate_download_url(
            "https://github.com/kevsmir02/terax-ai/releases/download/v0.9.0/Terax-0.9.0.AppImage",
        )
        .is_ok());
    }

    #[test]
    fn rejects_http_and_foreign_hosts() {
        assert!(validate_download_url("http://github.com/x").is_err());
        assert!(validate_download_url("https://evil.example.com/x.rpm").is_err());
        assert!(validate_download_url("not a url").is_err());
    }

    #[test]
    fn is_within_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path();
        assert!(is_within(dir, &dir.join("terax-0.9.0.rpm")));
        assert!(!is_within(dir, &std::path::PathBuf::from("/etc/passwd")));
        assert!(!is_within(dir, &dir.join("..").join("etc").join("passwd")));
    }

    #[test]
    fn dnf_args_use_fixed_vector() {
        let a = build_install_args(PackageManager::Dnf, "/tmp/x.rpm");
        assert_eq!(
            a,
            vec!["pkexec", "dnf", "install", "-y", "/tmp/x.rpm"]
                .into_iter().map(String::from).collect::<Vec<_>>()
        );
    }

    #[test]
    fn apt_args_use_fixed_vector() {
        let a = build_install_args(PackageManager::Apt, "/tmp/x.deb");
        assert_eq!(
            a,
            vec!["pkexec", "apt-get", "install", "--yes", "/tmp/x.deb"]
                .into_iter().map(String::from).collect::<Vec<_>>()
        );
    }

    #[test]
    fn sig_verify_rejects_malformed_inputs() {
        assert!(verify_signature(b"data", "not-a-sig", "not-a-key").is_err());
    }
}
