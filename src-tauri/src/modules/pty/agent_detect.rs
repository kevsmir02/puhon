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

    pub fn process<F: FnMut(Transition)>(&mut self, input: &[u8], mut emit: F) {
        if self.state == State::Ground && !input.contains(&ESC) {
            return;
        }
        for &b in input {
            match self.state {
                State::Ground => {
                    if b == ESC {
                        self.state = State::Esc;
                    }
                }
                State::Esc => match b {
                    OSC_INTRO => {
                        self.state = State::Osc;
                        self.osc.clear();
                    }
                    ESC => {}
                    _ => self.state = State::Ground,
                },
                State::Osc => match b {
                    BEL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => self.state = State::OscEsc,
                    _ => {
                        if self.osc.len() < OSC_MAX {
                            self.osc.push(b);
                        } else {
                            self.osc.clear();
                            self.state = State::Ground;
                        }
                    }
                },
                State::OscEsc => match b {
                    ST_FINAL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => {}
                    _ => {
                        self.osc.clear();
                        self.state = State::Ground;
                    }
                },
            }
        }
    }

    fn finish_osc<F: FnMut(Transition)>(&mut self, _emit: &mut F) {
        let body = std::mem::take(&mut self.osc);
        let (ps, pt) = match body.iter().position(|&c| c == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (&body[..], &body[0..0]),
        };
        match ps {
            b"133" => self.handle_osc133(pt, _emit),
            b"9" if !pt.starts_with(b"4;") && pt != b"4" => self.generic_attention(_emit),
            b"777" => self.handle_osc777(pt, _emit),
            _ => {}
        }
    }

    fn handle_osc133<F: FnMut(Transition)>(&mut self, _pt: &[u8], _emit: &mut F) {}
    fn handle_osc777<F: FnMut(Transition)>(&mut self, _pt: &[u8], _emit: &mut F) {}
    fn generic_attention<F: FnMut(Transition)>(&mut self, _emit: &mut F) {}
}

impl Default for AgentDetector {
    fn default() -> Self {
        Self::new()
    }
}

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const OSC_INTRO: u8 = b']';
const ST_FINAL: u8 = b'\\';
const OSC_MAX: usize = 2048;

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

    #[allow(dead_code)]
    fn osc(body: &str) -> Vec<u8> {
        let mut v = vec![0x1b, b']'];
        v.extend_from_slice(body.as_bytes());
        v.extend_from_slice(&[0x1b, b'\\']);
        v
    }

    fn run(d: &mut AgentDetector, input: &[u8]) -> Vec<Transition> {
        let mut out = Vec::new();
        d.process(input, |t| out.push(t));
        out
    }

    #[test]
    fn scanner_skips_chunks_with_no_escape_in_ground() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, b"hello world no escape here").is_empty());
    }

    #[test]
    fn scanner_parses_split_across_chunks() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &[0x1b, b']']).is_empty());
        assert!(run(&mut d, b"133;C;cla").is_empty());
        let mut out = run(&mut d, b"ude");
        out.extend(run(&mut d, &[0x1b, b'\\']));
        assert!(out.iter().all(|t| !matches!(t, Transition::Exited)));
    }

    #[test]
    fn scanner_caps_oversized_osc_without_panicking() {
        let mut d = AgentDetector::new();
        let mut seq = vec![0x1b, b']'];
        seq.extend(std::iter::repeat_n(b'x', 2200));
        seq.extend_from_slice(&[0x1b, b'\\']);
        assert!(run(&mut d, &seq).is_empty());
    }
}
