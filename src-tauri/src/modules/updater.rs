use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
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
}
