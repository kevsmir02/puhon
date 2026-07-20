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
}
