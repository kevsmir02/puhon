#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code)]
enum Status {
    Working,
    Waiting,
}

#[derive(Clone, PartialEq, Eq, Debug)]
#[allow(dead_code)]
pub enum Transition {
    Started { agent: String },
    Working,
    Attention,
    Finished,
    Exited,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[allow(dead_code)]
pub struct AgentSignal {
    pub id: u32,
    pub kind: &'static str,
    pub agent: Option<String>,
}

impl Transition {
    #[allow(dead_code)]
    pub fn into_signal(self, id: u32) -> AgentSignal {
        match self {
            Transition::Started { agent } => AgentSignal {
                id,
                kind: "started",
                agent: Some(agent),
            },
            Transition::Working => AgentSignal {
                id,
                kind: "working",
                agent: None,
            },
            Transition::Attention => AgentSignal {
                id,
                kind: "attention",
                agent: None,
            },
            Transition::Finished => AgentSignal {
                id,
                kind: "finished",
                agent: None,
            },
            Transition::Exited => AgentSignal {
                id,
                kind: "exited",
                agent: None,
            },
        }
    }
}

#[allow(dead_code)]
pub struct AgentDetector {
    agents: Vec<String>,
    state: State,
    osc: Vec<u8>,
    armed: bool,
    status: Status,
}

#[allow(dead_code)]
impl AgentDetector {
    pub fn new() -> Self {
        Self::with_agents(DEFAULT_AGENTS.iter().map(|s| s.to_string()).collect())
    }

    pub fn with_agents(agents: Vec<String>) -> Self {
        Self {
            agents,
            state: State::Ground,
            osc: Vec::new(),
            armed: false,
            status: Status::Working,
        }
    }
}

impl Default for AgentDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[allow(dead_code)]
const DEFAULT_AGENTS: &[&str] = &["claude", "codex", "pi", "opencode", "antigravity"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_serializes_to_signal_kinds() {
        assert_eq!(
            Transition::Started {
                agent: "codex".into()
            }
            .into_signal(7),
            AgentSignal {
                id: 7,
                kind: "started",
                agent: Some("codex".into())
            }
        );
        assert_eq!(Transition::Working.into_signal(7).kind, "working");
        assert_eq!(Transition::Attention.into_signal(7).kind, "attention");
        assert_eq!(Transition::Finished.into_signal(7).kind, "finished");
        assert_eq!(Transition::Exited.into_signal(7).kind, "exited");
        assert_eq!(Transition::Working.into_signal(7).agent, None);
    }
}
