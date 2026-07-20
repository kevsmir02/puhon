#![allow(dead_code, unused_imports)]

use serde_json::{json, Value};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Delivery {
    TerminalSequence,
    Osc,
}

struct AgentSpec {
    agent: &'static str,
    dir: &'static str,
    file: &'static str,
    events: &'static [(&'static str, &'static str)],
    matcher: bool,
    delivery: Delivery,
}

const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        agent: "claude",
        dir: ".claude",
        file: "settings.json",
        events: &[
            ("UserPromptSubmit", "working"),
            ("Notification", "attention"),
            ("Stop", "finished"),
        ],
        matcher: false,
        delivery: Delivery::TerminalSequence,
    },
    AgentSpec {
        agent: "codex",
        dir: ".codex",
        file: "hooks.json",
        events: &[
            ("UserPromptSubmit", "working"),
            ("PermissionRequest", "attention"),
            ("Stop", "finished"),
        ],
        matcher: false,
        delivery: Delivery::Osc,
    },
    AgentSpec {
        agent: "antigravity",
        dir: ".gemini",
        file: "settings.json",
        events: &[
            ("BeforeAgent", "working"),
            ("Notification", "attention"),
            ("AfterAgent", "finished"),
        ],
        matcher: true,
        delivery: Delivery::Osc,
    },
];

const OWNED_MARKERS: &[&str] = &["notify;Puhon;", "puhon;notify", "__puhon_notify"];

fn find(agent: &str) -> Result<&'static AgentSpec, String> {
    AGENTS
        .iter()
        .find(|s| s.agent == agent)
        .ok_or_else(|| format!("unknown agent {agent}"))
}

fn home_path(dir: &str, file: &str) -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(dir)
        .join(file))
}

fn settings_path(spec: &AgentSpec) -> Result<std::path::PathBuf, String> {
    home_path(spec.dir, spec.file)
}

fn hook_command(spec: &AgentSpec, event: &str) -> String {
    match spec.delivery {
        Delivery::TerminalSequence => format!(
            r#"[ -n "$PUHON_TERMINAL" ] && printf '{{"terminalSequence":"\\u001b]777;notify;Puhon;{event}\\u0007"}}' || true"#
        ),
        Delivery::Osc => osc_command(spec.agent, event),
    }
}

#[cfg(unix)]
fn osc_command(agent: &str, event: &str) -> String {
    format!(
        r#"[ -n "$PUHON_TERMINAL" ] && printf '\033]777;notify;Puhon;{agent};{event}\007' > /dev/tty; printf '{{}}'"#
    )
}

#[cfg(windows)]
fn osc_command(agent: &str, event: &str) -> String {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "puhon.exe".to_string());
    format!(r#""{exe}" __puhon_notify {agent} {event}"#)
}

fn status_needle(spec: &AgentSpec, event: &str) -> String {
    match spec.delivery {
        Delivery::TerminalSequence => format!("notify;Puhon;{event}"),
        Delivery::Osc => format!("notify;Puhon;{};{event}", spec.agent),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_returns_known_specs() {
        assert_eq!(find("claude").unwrap().agent, "claude");
        assert_eq!(find("codex").unwrap().agent, "codex");
        assert_eq!(find("antigravity").unwrap().agent, "antigravity");
        assert!(find("nope").is_err());
    }

    #[test]
    fn claude_uses_terminal_sequence_delivery() {
        assert_eq!(find("claude").unwrap().delivery, Delivery::TerminalSequence);
    }

    #[test]
    fn codex_and_antigravity_use_osc_delivery() {
        assert_eq!(find("codex").unwrap().delivery, Delivery::Osc);
        assert_eq!(find("antigravity").unwrap().delivery, Delivery::Osc);
    }

    #[test]
    fn antigravity_uses_matcher_and_gemini_dir() {
        let s = find("antigravity").unwrap();
        assert!(s.matcher);
        assert_eq!(s.dir, ".gemini");
        assert_eq!(s.file, "settings.json");
    }

    fn command(root: &Value, event: &str, idx: usize) -> String {
        root["hooks"][event][idx]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn claude_command_uses_terminal_sequence() {
        let cmd = hook_command(find("claude").unwrap(), "finished");
        assert!(cmd.contains("terminalSequence"));
        assert!(cmd.contains("notify;Puhon;finished"));
        assert!(!cmd.contains("/dev/tty"));
        assert!(cmd.contains("$PUHON_TERMINAL"));
    }

    #[cfg(unix)]
    #[test]
    fn osc_command_unix_writes_four_field_to_dev_tty() {
        let cmd = osc_command("codex", "finished");
        assert!(cmd.contains("notify;Puhon;codex;finished"));
        assert!(cmd.contains("> /dev/tty"));
        assert!(cmd.contains("printf '{}'"));
    }

    #[test]
    fn status_needle_matches_emitted_command() {
        let s = find("codex").unwrap();
        let needle = status_needle(s, "finished");
        let cmd = hook_command(s, "finished");
        assert!(cmd.contains(&needle), "needle {needle} not in {cmd}");
    }
}
