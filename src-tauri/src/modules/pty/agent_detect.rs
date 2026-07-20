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

    /// Called when the underlying PTY closes. Reports the agent as exited so the
    /// UI does not leave a stale entry if the shell died mid-command.
    pub fn finish<F: FnMut(Transition)>(&mut self, mut emit: F) {
        if self.armed {
            self.disarm();
            emit(Transition::Exited);
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

    fn handle_osc133<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        match pt.first() {
            Some(b'C') => {
                if self.armed {
                    return;
                }
                let cmd = pt.strip_prefix(b"C;").unwrap_or(b"");
                if let Some(agent) = self.match_agent(cmd) {
                    self.armed = true;
                    self.status = Status::Working;
                    emit(Transition::Started { agent });
                }
            }
            Some(b'D') if self.armed => {
                self.disarm();
                emit(Transition::Exited);
            }
            _ => {}
        }
    }

    fn ensure_armed<F: FnMut(Transition)>(&mut self, agent: &str, emit: &mut F) {
        if !self.armed {
            self.armed = true;
            self.status = Status::Working;
            emit(Transition::Started { agent: agent.to_string() });
        }
    }

    fn set_working<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.status != Status::Working {
            self.status = Status::Working;
            emit(Transition::Working);
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
        self.status = Status::Working;
    }
    fn handle_osc777<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        if let Some(tail) = pt.strip_prefix(PUHON_MARKER) {
            let (agent, event) = match tail.iter().position(|&c| c == b';') {
                Some(i) => {
                    let Ok(name) = std::str::from_utf8(&tail[..i]) else { return };
                    if !self.agents.iter().any(|a| a == name) {
                        return;
                    }
                    (name, &tail[i + 1..])
                }
                None => ("claude", tail),
            };
            match event {
                b"working" => {
                    self.ensure_armed(agent, emit);
                    self.set_working(emit);
                }
                b"attention" => {
                    self.ensure_armed(agent, emit);
                    self.status = Status::Waiting;
                    emit(Transition::Attention);
                }
                b"finished" => {
                    self.ensure_armed(agent, emit);
                    self.status = Status::Waiting;
                    emit(Transition::Finished);
                }
                _ => {}
            }
            return;
        }
        self.generic_attention(emit);
    }

    fn generic_attention<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.armed {
            self.status = Status::Waiting;
            emit(Transition::Attention);
        }
    }

    fn match_agent(&self, cmd: &[u8]) -> Option<String> {
        let cmd = std::str::from_utf8(cmd).ok()?;
        for token in cmd.split_whitespace() {
            if token.starts_with('-') {
                continue;
            }
            let base = token.rsplit(['/', '\\']).next().unwrap_or(token);
            if let Some(agent) = self.agents.iter().find(|a| {
                base.strip_prefix(a.as_str())
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
            }) {
                return Some(agent.clone());
            }
        }
        None
    }
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
const PUHON_MARKER: &[u8] = b"notify;Puhon;";

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

    #[test]
    fn match_agent_bare_name() {
        let d = AgentDetector::new();
        assert_eq!(d.match_agent(b"claude"), Some("claude".into()));
        assert_eq!(d.match_agent(b"pi"), Some("pi".into()));
    }

    #[test]
    fn match_agent_pathed_or_wrapped() {
        let d = AgentDetector::new();
        assert_eq!(d.match_agent(b"/usr/local/bin/codex exec"), Some("codex".into()));
        assert_eq!(d.match_agent(b"npx claude"), Some("claude".into()));
        assert_eq!(d.match_agent(b".\\build\\antigravity"), Some("antigravity".into()));
    }

    #[test]
    fn match_agent_dash_suffix_alias() {
        let d = AgentDetector::new();
        assert_eq!(d.match_agent(b"claude-enigma"), Some("claude".into()));
    }

    #[test]
    fn match_agent_rejects_non_agents() {
        let d = AgentDetector::new();
        assert_eq!(d.match_agent(b"vim src/main.rs"), None);
        assert_eq!(d.match_agent(b"cat claude.txt"), None);
        assert_eq!(d.match_agent(b"claudexyz"), None);
        assert_eq!(d.match_agent(b"opencodefoo"), None);
    }

    fn started(agent: &str) -> Transition {
        Transition::Started { agent: agent.into() }
    }

    #[test]
    fn arms_on_agent_command_via_osc133c() {
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("133;C;claude -p hello")), vec![started("claude")]);
        run(&mut d, &osc("133;D;0"));
        assert_eq!(run(&mut d, &osc("133;C;pi")), vec![started("pi")]);
        run(&mut d, &osc("133;D;0"));
        assert!(run(&mut d, &osc("133;C;vim src/main.rs")).is_empty());
    }

    #[test]
    fn exits_on_osc133d_only_when_armed() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("133;D;0")).is_empty());
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(run(&mut d, &osc("133;D;0")), vec![Transition::Exited]);
        assert!(run(&mut d, &osc("133;D;0")).is_empty());
    }

    #[test]
    fn osc133c_does_not_re_arm_while_armed() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert!(run(&mut d, &osc("133;C;codex")).is_empty());
    }

    #[test]
    fn puhon_marker_drives_status() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(run(&mut d, &osc("777;notify;Puhon;attention")), vec![Transition::Attention]);
        assert_eq!(run(&mut d, &osc("777;notify;Puhon;working")), vec![Transition::Working]);
        assert!(run(&mut d, &osc("777;notify;Puhon;working")).is_empty());
        assert_eq!(run(&mut d, &osc("777;notify;Puhon;finished")), vec![Transition::Finished]);
    }

    #[test]
    fn three_field_marker_defaults_agent_to_claude() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("777;notify;Puhon;attention")),
            vec![started("claude"), Transition::Attention]
        );
    }

    #[test]
    fn four_field_marker_self_arms_named_agent() {
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("777;notify;Puhon;codex;working")), vec![started("codex")]);
        let mut g = AgentDetector::new();
        assert_eq!(
            run(&mut g, &osc("777;notify;Puhon;antigravity;finished")),
            vec![started("antigravity"), Transition::Finished]
        );
    }

    #[test]
    fn four_field_marker_rejects_unknown_agent() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("777;notify;Puhon;evil;attention")).is_empty());
        assert_eq!(
            run(&mut d, &osc("777;notify;Puhon;opencode;attention")),
            vec![started("opencode"), Transition::Attention]
        );
    }

    #[test]
    fn generic_attention_only_when_armed() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("777;notify;Other;ready")).is_empty());
        assert!(run(&mut d, &osc("9;needs you")).is_empty());
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(run(&mut d, &osc("777;notify;Codex;ready")), vec![Transition::Attention]);
        assert_eq!(run(&mut d, &osc("9;needs you")), vec![Transition::Attention]);
        assert!(run(&mut d, &osc("9;4;1;50")).is_empty());
    }

    #[test]
    fn bel_inside_title_osc_is_not_attention() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![0x1b, b']'];
        seq.extend_from_slice(b"0;set title");
        seq.push(BEL);
        assert!(run(&mut d, &seq).is_empty());
    }

    #[test]
    fn finish_emits_exited_when_armed() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut out = Vec::new();
        d.finish(|t| out.push(t));
        assert_eq!(out, vec![Transition::Exited]);
        let mut out2 = Vec::new();
        d.finish(|t| out2.push(t));
        assert!(out2.is_empty());
    }

    #[test]
    fn finish_is_noop_when_not_armed() {
        let mut d = AgentDetector::new();
        let mut out = Vec::new();
        d.finish(|t| out.push(t));
        assert!(out.is_empty());
    }
}
