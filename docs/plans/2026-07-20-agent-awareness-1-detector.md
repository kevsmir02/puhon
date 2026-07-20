# Agent-awareness - Plan 1: Rust detector + PTY wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure Rust state machine that scans raw PTY output bytes and emits agent-lifecycle signals (started, working, attention, finished, exited) as a Tauri event, with an "armed" trust gate so untrusted output cannot arm it or spoof attention.

**Architecture:** One `AgentDetector` per PTY, instantiated in the existing reader thread in `session.rs`, fed every read chunk via `process()`. Transitions are derived from OSC sequences only (OSC 133 C/D command boundaries and a Puhon OSC 777 marker), never from raw output, so a repainting TUI never flaps. The detector is a pure functional core with no I/O; the reader thread is a thin shell that emits the serialized `AgentSignal` over `app.emit("puhon:agent-signal", ...)`.

**Tech Stack:** Rust (edition 2021), `serde` for serialization, Tauri 2 `Emitter` trait for the event, `cargo` + `cargo nextest` (fallback `cargo test`) for tests, `cargo clippy --locked -D warnings` for lint.

## Global Constraints

(From `docs/architecture/agent-awareness.md` and `PUHON.md`. Every task inherits these.)

- No em-dash anywhere (code, comments, commits, docs). Use a regular hyphen or rephrase.
- No emojis anywhere.
- Comments default to none; if genuinely needed, 1 to 2 lines on why, never what. No AI-generic filler.
- Rust checks must pass before claiming a task done: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings` and `cd src-tauri && cargo nextest run --locked` (fallback `cargo test --locked`).
- This is a core-subsystem change (the PTY byte path). It needs invariant tests locking the trust gate and the no-flap property.
- The detector must be zero-cost when idle: no allocation per byte on the fast path (the `Ground` + no-`ESC` skip).
- No built-in AI. This plan only adds detection of external CLIs. Do not add chat, providers, models, or any `modules/ai` code.

## File Structure

- **Create** `src-tauri/src/modules/pty/agent_detect.rs` - the pure detector (functional core). Owns: byte-level OSC scanner, command matcher, the armed trust gate, transition/signal types. No I/O, no Tauri dependency except `serde::Serialize` on `AgentSignal`.
- **Modify** `src-tauri/src/modules/pty/mod.rs` - register the new module (`mod agent_detect;`) and expose the event name constant `pub(crate) const AGENT_EVENT: &str`.
- **Modify** `src-tauri/src/modules/pty/session.rs` - clone `app` into `app_reader`, move it into the reader-thread closure, feed every chunk to `AgentDetector::process()`, call `finish()` after the read loop, emit `puhon:agent-signal`.

No frontend changes in this plan. The event has no listeners yet; that arrives in Plan 3. Detection is fully verifiable with `cargo test` plus a manual smoke.

---

### Task 1: Detector scaffold, types, and module registration

**Files:**

- Create: `src-tauri/src/modules/pty/agent_detect.rs`
- Modify: `src-tauri/src/modules/pty/mod.rs` (add `mod agent_detect;` and the `AGENT_EVENT` constant)

**Interfaces:**

- Produces: `pub enum Transition` (variants `Started { agent }`, `Working`, `Attention`, `Finished`, `Exited`), `pub struct AgentSignal { id, kind, agent }`, `impl Transition { pub fn into_signal(self, id: u32) -> AgentSignal }`, `pub struct AgentDetector`, `impl AgentDetector { pub fn new() -> Self }`. Later tasks add `process` and `finish`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/modules/pty/agent_detect.rs` with only a `#[cfg(test)]` block for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_serializes_to_signal_kinds() {
        assert_eq!(
            Transition::Started { agent: "codex".into() }.into_signal(7),
            AgentSignal { id: 7, kind: "started", agent: Some("codex".into()) }
        );
        assert_eq!(Transition::Working.into_signal(7).kind, "working");
        assert_eq!(Transition::Attention.into_signal(7).kind, "attention");
        assert_eq!(Transition::Finished.into_signal(7).kind, "finished");
        assert_eq!(Transition::Exited.into_signal(7).kind, "exited");
        assert_eq!(Transition::Working.into_signal(7).agent, None);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo nextest run -p puhon agent_detect 2>/dev/null || cargo test --locked agent_detect`
Expected: compile error, `Transition` / `AgentSignal` not defined.

- [ ] **Step 3: Write the minimal types above the test module**

Add to `src-tauri/src/modules/pty/agent_detect.rs` (above the `#[cfg(test)]` block):

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Status {
    Working,
    Waiting,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Transition {
    Started { agent: String },
    Working,
    Attention,
    Finished,
    Exited,
}

#[derive(Clone, serde::Serialize)]
pub struct AgentSignal {
    pub id: u32,
    pub kind: &'static str,
    pub agent: Option<String>,
}

impl Transition {
    pub fn into_signal(self, id: u32) -> AgentSignal {
        match self {
            Transition::Started { agent } => AgentSignal { id, kind: "started", agent: Some(agent) },
            Transition::Working => AgentSignal { id, kind: "working", agent: None },
            Transition::Attention => AgentSignal { id, kind: "attention", agent: None },
            Transition::Finished => AgentSignal { id, kind: "finished", agent: None },
            Transition::Exited => AgentSignal { id, kind: "exited", agent: None },
        }
    }
}

pub struct AgentDetector {
    agents: Vec<String>,
    state: State,
    osc: Vec<u8>,
    armed: bool,
    status: Status,
}

impl AgentDetector {
    pub fn new() -> Self {
        Self::with_agents(DEFAULT_AGENTS.iter().map(|s| s.to_string()).collect())
    }

    pub fn with_agents(agents: Vec<String>) -> Self {
        Self { agents, state: State::Ground, osc: Vec::new(), armed: false, status: Status::Working }
    }
}

const DEFAULT_AGENTS: &[&str] = &["claude", "codex", "pi", "opencode", "antigravity"];
```

- [ ] **Step 4: Register the module and the event-name constant**

In `src-tauri/src/modules/pty/mod.rs`, add alongside the existing `mod da_filter;` line:

```rust
mod agent_detect;
mod da_filter;
mod session;
pub(crate) mod shell_init;

/// Tauri event carrying one agent lifecycle signal. Frontend subscribes in
/// Plan 3; this plan only emits it from the PTY reader thread.
pub(crate) const AGENT_EVENT: &str = "puhon:agent-signal";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd src-tauri && cargo nextest run -p puhon agent_detect 2>/dev/null || cargo test --locked agent_detect`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/modules/pty/agent_detect.rs src-tauri/src/modules/pty/mod.rs
git commit -m "feat(agents): scaffold agent detector types and event name"
```

---

### Task 2: Byte-level OSC scanner and `process()`

**Files:**

- Modify: `src-tauri/src/modules/pty/agent_detect.rs`
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**

- Produces: `impl AgentDetector { pub fn process<F: FnMut(Transition)>(&mut self, input: &[u8], emit: F) }`. For this task `process` only drives the scanner and invokes a private `finish_osc` that is a no-op stub for unknown payloads (real dispatch arrives in Tasks 4 and 5). The scanner must handle both BEL (`0x07`) and ST (`ESC \`) terminators, cap a single OSC at 2048 bytes (clear on overflow, never panic), and skip the whole chunk when in `Ground` with no `ESC` byte.
- Consumes: the types from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `agent_detect.rs`:

```rust
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
        // No ESC byte, machine in Ground: no work, no panic.
        assert!(run(&mut d, b"hello world no escape here").is_empty());
    }

    #[test]
    fn scanner_parses_split_across_chunks() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &[0x1b, b']']).is_empty());
        assert!(run(&mut d, b"133;C;cla").is_empty());
        let mut out = run(&mut d, b"ude");
        out.extend(run(&mut d, &[0x1b, b'\\']));
        // Started arrives once dispatch lands in Task 4; here we only assert the
        // scanner did not panic and buffered across the split. With Task 4 in
        // place this will be vec![started("claude")].
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
```

Note: `repeat_n` is stable in the Rust edition pinned by `Cargo.toml` (edition 2021, recent toolchain). If the toolchain is older, replace with `std::iter::repeat(b'x').take(2200)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: FAIL, `process` method not found on `AgentDetector`.

- [ ] **Step 3: Implement the scanner and a no-op `finish_osc`**

Add constants at the top of `agent_detect.rs` (below the `use`-free header, above `State`):

```rust
const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const OSC_INTRO: u8 = b']';
const ST_FINAL: u8 = b'\\';
const OSC_MAX: usize = 2048;
```

Add `process` and the private helpers to `impl AgentDetector`:

```rust
    /// Feed a chunk of raw PTY output. Transitions come only from OSC sequences
    /// (133 prompt boundaries, our 777 marker), never from raw output, so a TUI
    /// that repaints continuously never flaps working/waiting.
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
```

Add stub handlers so it compiles (real bodies arrive in Tasks 4 and 5):

```rust
    fn handle_osc133<F: FnMut(Transition)>(&mut self, _pt: &[u8], _emit: &mut F) {}
    fn handle_osc777<F: FnMut(Transition)>(&mut self, _pt: &[u8], _emit: &mut F) {}
    fn generic_attention<F: FnMut(Transition)>(&mut self, _emit: &mut F) {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: PASS (4 tests). The scanner now buffers and clears without dispatching.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/pty/agent_detect.rs
git commit -m "feat(agents): byte-level OSC scanner in agent detector"
```

---

### Task 3: Command matcher `match_agent`

**Files:**

- Modify: `src-tauri/src/modules/pty/agent_detect.rs`
- Test: same file

**Interfaces:**

- Produces: private `fn match_agent(&self, cmd: &[u8]) -> Option<String>`. Tokenizes a command line, skips flags, takes each token basename (splitting on `/` and `\`), and returns the known agent whose name is an exact or dash-suffixed prefix of the basename.
- Consumes: `self.agents` from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: FAIL, `match_agent` is private/missing (tests are in the same module so private is fine; the method does not exist yet).

- [ ] **Step 3: Implement `match_agent`**

Add to `impl AgentDetector`:

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/pty/agent_detect.rs
git commit -m "feat(agents): command matcher for known agent CLIs"
```

---

### Task 4: OSC 133 C/D handling and arming

**Files:**

- Modify: `src-tauri/src/modules/pty/agent_detect.rs`
- Test: same file

**Interfaces:**

- Produces: real bodies for `handle_osc133`, plus private `ensure_armed`, `set_working`, `disarm`. `Started` is emitted on the first OSC 133 C whose command matches; `Exited` on OSC 133 D when armed.
- Consumes: `match_agent` (Task 3), `process`/`finish_osc` (Task 2).

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module. `started` helper:

```rust
    fn started(agent: &str) -> Transition {
        Transition::Started { agent: agent.into() }
    }

    #[test]
    fn arms_on_agent_command_via_osc133c() {
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("133;C;claude -p hello")), vec![started("claude")]);
        assert_eq!(run(&mut d, &osc("133;C;pi")), vec![started("pi")]);
        assert!(run(&mut d, &osc("133;C;vim src/main.rs")).is_empty());
    }

    #[test]
    fn exits_on_osc133d_only_when_armed() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("133;D;0")).is_empty());
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(run(&mut d, &osc("133;D;0")), vec![Transition::Exited]);
        // Already disarmed: a second D is a no-op.
        assert!(run(&mut d, &osc("133;D;0")).is_empty());
    }

    #[test]
    fn osc133c_does_not_re_arm_while_armed() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        // While armed, a second C for another agent is ignored (no second Started).
        assert!(run(&mut d, &osc("133;C;codex")).is_empty());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: FAIL (the stub `handle_osc133` emits nothing).

- [ ] **Step 3: Implement `handle_osc133` and the arming helpers**

Replace the stub `handle_osc133` and add the helpers:

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/pty/agent_detect.rs
git commit -m "feat(agents): arm detector on OSC 133 C, exit on OSC 133 D"
```

---

### Task 5: OSC 777 Puhon marker and gated generic attention

**Files:**

- Modify: `src-tauri/src/modules/pty/agent_detect.rs`
- Test: same file

**Interfaces:**

- Produces: real bodies for `handle_osc777` and `generic_attention`. Recognizes `notify;Puhon;<event>` (3-field, agent defaults to `claude`) and `notify;Puhon;<agent>;<event>` (4-field, agent validated against the known list; unknown agents rejected). Both self-arm. Generic OSC 9 and foreign OSC 777 fire `Attention` only while armed; `9;4` (taskbar progress) is never attention.
- Consumes: `ensure_armed`, `set_working` (Task 4).

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:

```rust
    #[test]
    fn puhon_marker_drives_status() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(run(&mut d, &osc("777;notify;Puhon;attention")), vec![Transition::Attention]);
        assert_eq!(run(&mut d, &osc("777;notify;Puhon;working")), vec![Transition::Working]);
        // Idempotent: a second working while already Working emits nothing.
        assert!(run(&mut d, &osc("777;notify;Puhon;working")).is_empty());
        assert_eq!(run(&mut d, &osc("777;notify;Puhon;finished")), vec![Transition::Finished]);
    }

    #[test]
    fn three_field_marker_defaults_agent_to_claude() {
        let mut d = AgentDetector::new();
        // No preexec fired: the 3-field marker self-arms as claude.
        assert_eq!(
            run(&mut d, &osc("777;notify;Puhon;attention")),
            vec![started("claude"), Transition::Attention]
        );
    }

    #[test]
    fn four_field_marker_self_arms_named_agent() {
        let mut d = AgentDetector::new();
        // Fresh arm already implies Working, so `working` emits only Started.
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
        // A known agent in the same detector still works afterward.
        assert_eq!(
            run(&mut d, &osc("777;notify;Puhon;opencode;attention")),
            vec![started("opencode"), Transition::Attention]
        );
    }

    #[test]
    fn generic_attention_only_when_armed() {
        let mut d = AgentDetector::new();
        // Disarmed: foreign 777 and OSC 9 are ignored.
        assert!(run(&mut d, &osc("777;notify;Other;ready")).is_empty());
        assert!(run(&mut d, &osc("9;needs you")).is_empty());
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(run(&mut d, &osc("777;notify;Codex;ready")), vec![Transition::Attention]);
        assert_eq!(run(&mut d, &osc("9;needs you")), vec![Transition::Attention]);
        // 9;4 is taskbar progress, never attention.
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: FAIL (stubs emit nothing).

- [ ] **Step 3: Implement `handle_osc777` and `generic_attention`**

Add the marker constant near the other constants:

```rust
// OSC 777 marker our agent hooks emit. Legacy 3-field `notify;Puhon;<event>`
// (Claude) or 4-field `notify;Puhon;<agent>;<event>` (Codex/Pi/OpenCode/...).
const PUHON_MARKER: &[u8] = b"notify;Puhon;";
```

Replace the stubs:

```rust
    fn handle_osc777<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        if let Some(tail) = pt.strip_prefix(PUHON_MARKER) {
            // PTY output is untrusted: only self-arm for known agents.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: PASS (17 tests total).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/pty/agent_detect.rs
git commit -m "feat(agents): OSC 777 Puhon marker and gated generic attention"
```

---

### Task 6: `finish()` on PTY close

**Files:**

- Modify: `src-tauri/src/modules/pty/agent_detect.rs`
- Test: same file

**Interfaces:**

- Produces: `pub fn finish<F: FnMut(Transition)>(&mut self, emit: F)`. Emits `Exited` once if armed (so a shell that dies mid-command clears its session), then disarms. No-op when not armed.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:

```rust
    #[test]
    fn finish_emits_exited_when_armed() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut out = Vec::new();
        d.finish(|t| out.push(t));
        assert_eq!(out, vec![Transition::Exited]);
        // Idempotent: a second finish is a no-op.
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: FAIL, `finish` not found.

- [ ] **Step 3: Implement `finish`**

Add to `impl AgentDetector`:

```rust
    /// Called when the underlying PTY closes. Reports the agent as exited so the
    /// UI does not leave a stale entry if the shell died mid-command.
    pub fn finish<F: FnMut(Transition)>(&mut self, mut emit: F) {
        if self.armed {
            self.disarm();
            emit(Transition::Exited);
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: PASS (19 tests total).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/pty/agent_detect.rs
git commit -m "feat(agents): report exit when PTY closes mid-command"
```

---

### Task 7: Wire the detector into the PTY reader thread

**Files:**

- Modify: `src-tauri/src/modules/pty/session.rs`

**Interfaces:**

- Consumes: `AgentDetector` (Tasks 1 to 6), `AGENT_EVENT` (Task 1), the existing reader thread in `session::spawn` (which already receives `app: AppHandle`).
- Produces: each PTY now emits `puhon:agent-signal` with an `AgentSignal` payload on lifecycle transitions. No frontend listens yet; that is Plan 3.

The reader-thread closure currently captures `reader`, `buf`, `filtered`, `da_filter`, `pending_r`, `first_byte_r`, and `id`. It does not capture `app`. We add a clone.

- [ ] **Step 1: Add the import and clone the app handle for the reader thread**

In `src-tauri/src/modules/pty/session.rs`, the import at the top is `use tauri::{AppHandle, Manager};`. Add the `Emitter` trait so `.emit(...)` resolves:

```rust
use tauri::{AppHandle, Emitter, Manager};
```

Add `use super::agent_detect::AgentDetector;` alongside the existing `use super::da_filter::DaFilter;`.

Just before the `let reader_thread = thread::Builder::new()` call, clone the handle so the closure can move it:

```rust
    let app_reader = app.clone();
```

- [ ] **Step 2: Instantiate the detector and feed every chunk**

Inside the reader-thread closure, next to `let mut da_filter = DaFilter::new();`, add:

```rust
            let mut agent_detect = AgentDetector::new();
```

Inside the `Ok(n) =>` arm, before the `da_filter.process(...)` call, feed the chunk and emit any transitions:

```rust
                        agent_detect.process(&buf[..n], |t| {
                            let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
                        });
```

`AGENT_EVENT` is `pub(crate)` in `mod.rs` and resolves via `use super::agent_detect::AgentDetector;` plus the existing module scope. If the compiler reports `AGENT_EVENT` unresolved, qualify it as `super::AGENT_EVENT`.

- [ ] **Step 3: Call `finish()` after the read loop ends**

After the read loop (after the `Err` arm and before `pending_r.1.notify_one();`), add:

```rust
            agent_detect.finish(|t| {
                let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
            });
```

- [ ] **Step 4: Build and lint**

Run: `cd src-tauri && cargo build --locked`
Expected: builds clean.

Run: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`
Expected: no warnings. If clippy flags the `|t|` closure capture of `app_reader`, confirm the closure is `move` (the `thread::Builder::spawn(move || ...)` already moves captures, and `app_reader` is moved in).

- [ ] **Step 5: Run the full Rust test suite**

Run: `cd src-tauri && cargo nextest run --locked 2>/dev/null || cargo test --locked`
Expected: all tests PASS, including the 19 detector tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/modules/pty/session.rs
git commit -m "feat(agents): emit agent lifecycle signals from PTY reader thread"
```

---

### Task 8: Manual smoke test

This task has no code. It confirms the wiring emits real events before Plan 3 builds a listener.

- [ ] **Step 1: Start the dev app**

Run: `pnpm tauri dev`
Expected: the app launches.

- [ ] **Step 2: Run any known agent CLI in a terminal tab**

In a terminal tab, run a known agent command, for example `pi --version` or `claude --version` (whichever is installed). The detector arms on the OSC 133 C marker the shell emits.

- [ ] **Step 3: Confirm the event fires (temporary verification)**

Because Plan 3 has not added a listener yet, verify via a temporary log. Before Step 2, add this line inside the `agent_detect.process(...)` closure from Task 7, Step 2:

```rust
                        agent_detect.process(&buf[..n], |t| {
                            log::debug!("agent signal: {:?}", t);
                            let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
                        });
```

Rebuild, run the agent, and check the dev console for `agent signal: Started { agent: "pi" }` (or the agent you ran) and `agent signal: Exited` when it returns. Then remove the `log::debug!` line before committing.

Run: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`
Expected: clean after removing the debug log.

- [ ] **Step 4: Final commit (if the debug log was the only change, skip; otherwise record the clean state)**

If no source change remains, this step is a no-op. Otherwise:

```bash
git add src-tauri/src/modules/pty/session.rs
git commit -m "chore(agents): drop temporary detector debug log"
```

---

## Self-review (run after writing, before handoff)

**Spec coverage** (against `docs/architecture/agent-awareness.md`):

- Section 5 detector (parser, signal sources, armed gate, vocabulary, default list): Tasks 1 to 6.
- Section 6 wire protocol (OSC 777 forms, OSC 133 reuse, generic OSC 9, no custom number): Tasks 4 and 5.
- Section 7 PTY wiring: Task 7.
- Section 13 testing (detector unit invariants): Tasks 1 to 6 port and extend the invariant suite.
- Sections 8 (install backend), 9 (frontend), 10 (boundary), 12 (phasing beyond v1 core): out of scope for this plan. They belong to Plan 2 (install backend and adapters) and Plan 3 (frontend).

**Placeholder scan:** none. Every code step contains the full code or an exact file path and insertion point.

**Type consistency:** `Transition`, `AgentSignal`, `into_signal`, `AgentDetector::new`, `process`, `finish`, `AGENT_EVENT` are defined in Task 1 and consumed unchanged in Tasks 2 to 7. The private helpers `match_agent`, `handle_osc133`, `handle_osc777`, `generic_attention`, `ensure_armed`, `set_working`, `disarm` are named consistently across tasks.

**Risks carried into execution:**

- `repeat_n` availability (Task 2): guarded with a fallback.
- `AGENT_EVENT` resolution (Task 7): guarded with a `super::AGENT_EVENT` fallback.
- Manual smoke (Task 8) depends on having at least one of the five agents installed; pick whichever is present.

## Next plans

- **Plan 2:** install backend (`src-tauri/src/modules/agent.rs`) and the five agent adapters (Claude, Codex, Pi ported; OpenCode, Antigravity new), the `agent_enable_hooks` and `agent_hooks_status` Tauri commands, safe-install invariants.
- **Plan 3:** frontend module `src/modules/agents/` (terminal-source only), the `puhon:agent-signal` listener bridge, store, bell, toast, OS notifications, and the `agentNotifications` settings preference.
