# Agent-awareness - Plan 2: Install backend and agent adapters

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Rust install backend that writes per-agent hook configs so each supported agent CLI emits the Puhon OSC 777 marker, plus `agent_enable_hooks` and `agent_hooks_status` Tauri commands and a Windows CONOUT$ helper. Covers all five v1 agents: Claude Code, Codex, Pi, OpenCode, Antigravity.

**Architecture:** A new `src-tauri/src/modules/agent.rs` module owns an `AgentSpec` registry and per-agent install logic. JSON-config agents (Claude, Codex, Antigravity) merge idempotently into their settings file. File-based agents (Pi extension, OpenCode plugin) write a managed file with marker-based ownership, atomic writes, and symlink safety. All hook commands no-op unless `$PUHON_TERMINAL` is set. Depends on Plan 1 (the detector reads the OSC bytes these hooks emit).

**Tech Stack:** Rust (edition 2021), `serde_json` for config merge, `dirs` for home, `windows_sys` for the Windows CONOUT$ path, Tauri 2 commands, `cargo` + `cargo nextest` (fallback `cargo test`) for tests, `cargo clippy --locked -D warnings` for lint.

## Global Constraints

(From `docs/architecture/agent-awareness.md` and `PUHON.md`. Every task inherits these.)

- No em-dash anywhere. No emojis anywhere. Comments default to none; if needed, 1 to 2 lines on why.
- Rust checks before claiming a task done: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings` and `cd src-tauri && cargo nextest run --locked 2>/dev/null || cargo test --locked`.
- This is a core-subsystem change (writes into the user's agent config files). It needs invariant tests: installs are atomic, idempotent, never clobber a foreign file, and preserve symlinks.
- No built-in AI. This plan writes hook configs that emit OSC bytes; it does not add chat, models, providers, or any `modules/ai` code.
- All hook commands gate on `$PUHON_TERMINAL`, which is already injected at PTY spawn (`shell_init.rs`).

## File Structure

- **Create** `src-tauri/src/modules/agent.rs` - the install backend. Owns: `AgentSpec` registry, `Delivery` modes, hook-command generation, idempotent JSON merge, the Pi extension and OpenCode plugin managed-file installers, the two Tauri commands, the Windows CONOUT$ helper.
- **Modify** `src-tauri/src/modules/mod.rs` - register `pub(crate) mod agent;`.
- **Modify** `src-tauri/src/lib.rs` - register the two commands in `invoke_handler`, and add the Windows `__puhon_notify` arg dispatch at the start of `run()`.
- **Modify** `src-tauri/src/modules/pty/agent_detect.rs` - extend `DEFAULT_AGENTS` with Antigravity command aliases (`agy`, `gemini`) so OSC 133 C catches every invocation. (From Plan 1.)

No frontend changes in this plan. The commands are callable via `invoke` but the UI that calls them arrives in Plan 3.

## Agent registry (the five v1 agents)

| Agent | Config target | Events to phase | Delivery |
| --- | --- | --- | --- |
| claude | `~/.claude/settings.json` | UserPromptSubmit to working, Notification to attention, Stop to finished | TerminalSequence JSON |
| codex | `~/.codex/hooks.json` | UserPromptSubmit to working, PermissionRequest to attention, Stop to finished | Osc to /dev/tty (unix), CONOUT$ helper (windows) |
| pi | `~/.pi/agent/extensions/puhon-notifications.ts` | agent_start to working, agent_settled to finished | Pi extension |
| antigravity | `~/.gemini/settings.json` | BeforeAgent to working, Notification to attention, AfterAgent to finished | Osc to /dev/tty (unix), CONOUT$ helper (windows) |
| opencode | `~/.config/opencode/plugin/puhon-notifications.js` | session.status busy to working, idle to finished | OpenCode plugin |

Antigravity note: Google transitioned Gemini CLI to Antigravity CLI (shut down June 18, 2026). Antigravity CLI is invoked as `agy`, with `antigravity` and `gemini` as aliases, and shares the `~/.gemini/settings.json` config and hook format. So this adapter is Terax's gemini adapter renamed, covering both. The hook emits `agent=antigravity`; the detector also recognizes the `agy` and `gemini` command tokens (see Task 1).

---

### Task 1: Extend the detector agent list with Antigravity aliases

**Files:**

- Modify: `src-tauri/src/modules/pty/agent_detect.rs`

**Interfaces:**

- Produces: `DEFAULT_AGENTS` now also contains `agy` and `gemini` so OSC 133 C arms on any Antigravity/Gemini invocation. `displayAgent` in Plan 3 maps `agy`, `gemini`, and `antigravity` to the label "Antigravity".

- [ ] **Step 1: Update the constant**

In `src-tauri/src/modules/pty/agent_detect.rs`, change:

```rust
const DEFAULT_AGENTS: &[&str] = &["claude", "codex", "pi", "opencode", "antigravity"];
```

to:

```rust
const DEFAULT_AGENTS: &[&str] = &[
    "claude",
    "codex",
    "pi",
    "opencode",
    "antigravity",
    // Antigravity CLI is invoked as `agy`, with `gemini` as the legacy alias.
    "agy",
    "gemini",
];
```

- [ ] **Step 2: Add a test for the alias**

Append to the `tests` module:

```rust
    #[test]
    fn match_agent_antigravity_aliases() {
        let d = AgentDetector::new();
        assert_eq!(d.match_agent(b"agy"), Some("agy".into()));
        assert_eq!(d.match_agent(b"gemini"), Some("gemini".into()));
        assert_eq!(d.match_agent(b"antigravity"), Some("antigravity".into()));
    }
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test --locked agent_detect`
Expected: PASS (all prior tests plus the new alias test).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modules/pty/agent_detect.rs
git commit -m "feat(agents): recognize agy and gemini command aliases"
```

---

### Task 2: Scaffold the agent module and registry

**Files:**

- Create: `src-tauri/src/modules/agent.rs`
- Modify: `src-tauri/src/modules/mod.rs`

**Interfaces:**

- Produces: `pub(crate) mod agent` registered; `Delivery` enum; `AgentSpec` struct; the `AGENTS` registry with claude, codex, antigravity; `find(agent) -> Result<&AgentSpec>`; `OWNED_MARKERS`; `home_path`, `settings_path`.

- [ ] **Step 1: Register the module**

In `src-tauri/src/modules/mod.rs`, add alongside the existing module declarations:

```rust
pub(crate) mod agent;
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/modules/agent.rs` with only a test module:

```rust
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: compile error, types not defined.

- [ ] **Step 4: Write the registry above the test module**

Add to `src-tauri/src/modules/agent.rs` (above `#[cfg(test)]`):

```rust
use serde_json::{json, Value};

// How a given agent's hook delivers our OSC 777 marker into the terminal.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Delivery {
    // Claude returns the sequence via a `terminalSequence` JSON field (it lost
    // /dev/tty access in v2.1.139) and emits it in-band. Cross-platform.
    TerminalSequence,
    // Codex/Antigravity hooks emit the marker themselves: to /dev/tty on Unix,
    // via a CONOUT$ helper on Windows.
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

// Substrings identifying a hook command as ours, across every form we've ever
// emitted. Used to prune our own groups before reinserting so installs are
// idempotent and migrate older marker forms.
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/modules/agent.rs src-tauri/src/modules/mod.rs
git commit -m "feat(agents): scaffold install backend registry"
```

---

### Task 3: Hook command generation

**Files:**

- Modify: `src-tauri/src/modules/agent.rs`
- Test: same file

**Interfaces:**

- Produces: `fn hook_command(spec, event) -> String`, `fn osc_command(agent, event) -> String` (cfg unix/windows), `fn status_needle(spec, event) -> String`.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:

```rust
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
        // Codex Stop rejects empty/non-JSON stdout; the hook must emit a no-op.
        assert!(cmd.contains("printf '{}'"));
    }

    #[test]
    fn status_needle_matches_emitted_command() {
        let s = find("codex").unwrap();
        let needle = status_needle(s, "finished");
        let cmd = hook_command(s, "finished");
        assert!(cmd.contains(&needle), "needle {needle} not in {cmd}");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: FAIL, `hook_command` not found.

- [ ] **Step 3: Implement command generation**

Add to `src-tauri/src/modules/agent.rs`:

```rust
fn hook_command(spec: &AgentSpec, event: &str) -> String {
    match spec.delivery {
        Delivery::TerminalSequence => format!(
            r#"[ -n "$PUHON_TERMINAL" ] && printf '{{"terminalSequence":"\\u001b]777;notify;Puhon;{event}\\u0007"}}' || true"#
        ),
        Delivery::Osc => osc_command(spec.agent, event),
    }
}

// Marker to the tty, then `{}` on stdout: Codex/Antigravity require a JSON no-op.
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

// The stable substring that proves a given (agent, event) hook is installed.
// Kept in sync with hook_command so status reflects what enable writes.
fn status_needle(spec: &AgentSpec, event: &str) -> String {
    match spec.delivery {
        Delivery::TerminalSequence => format!("notify;Puhon;{event}"),
        Delivery::Osc => format!("notify;Puhon;{};{event}", spec.agent),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/agent.rs
git commit -m "feat(agents): generate per-agent hook commands"
```

---

### Task 4: Idempotent JSON merge

**Files:**

- Modify: `src-tauri/src/modules/agent.rs`
- Test: same file

**Interfaces:**

- Produces: `fn merge_hooks(root: Value, spec: &AgentSpec) -> Value`, `fn existing_config(contents, path) -> Result<Value>`, private `is_ours`, `is_empty_group`.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:

```rust
    fn hook_count(root: &Value, event: &str) -> usize {
        root["hooks"][event].as_array().map_or(0, Vec::len)
    }

    #[test]
    fn claude_adds_all_event_hooks_to_empty_config() {
        let out = merge_hooks(json!({}), find("claude").unwrap());
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        assert!(command(&out, "Notification", 0).contains("notify;Puhon;attention"));
        assert!(command(&out, "Stop", 0).contains("terminalSequence"));
    }

    #[test]
    fn merge_is_idempotent_per_agent() {
        for agent in ["claude", "codex", "antigravity"] {
            let s = find(agent).unwrap();
            let once = merge_hooks(json!({}), s);
            let twice = merge_hooks(once.clone(), s);
            assert_eq!(once, twice, "{agent} not idempotent");
        }
    }

    #[test]
    fn merge_preserves_foreign_hooks_and_prunes_empties() {
        let foreign = json!({
            "hooks": {
                "UserPromptSubmit": [
                    { "hooks": [ { "type": "command", "command": "echo user-hook" } ] }
                ]
            }
        });
        let out = merge_hooks(foreign, find("claude").unwrap());
        // Foreign hook kept, our hook added: two groups.
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 2);
    }

    #[test]
    fn antigravity_uses_matcher() {
        let out = merge_hooks(json!({}), find("antigravity").unwrap());
        assert_eq!(out["hooks"]["BeforeAgent"][0]["matcher"], "*");
    }

    #[test]
    fn existing_config_rejects_invalid_json() {
        let p = std::path::Path::new("/x");
        assert!(existing_config(Some("not json"), p).is_err());
        assert!(existing_config(Some(""), p).is_ok());
        assert!(existing_config(None, p).is_ok());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: FAIL, `merge_hooks` not found.

- [ ] **Step 3: Implement the merge**

Add to `src-tauri/src/modules/agent.rs`:

```rust
fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| OWNED_MARKERS.iter().any(|m| c.contains(m)))
            })
        })
}

// A group with no hooks is inert cruft. Drop it so the file stays clean.
fn is_empty_group(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_none_or(|hs| hs.is_empty())
}

fn merge_hooks(mut root: Value, spec: &AgentSpec) -> Value {
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    for (event, marker) in spec.events {
        let arr = hooks.entry(*event).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        // Prune our own older groups (idempotency + marker migration) and empties.
        arr.retain(|group| !is_ours(group) && !is_empty_group(group));
        let mut group = json!({
            "hooks": [ { "type": "command", "command": hook_command(spec, marker) } ]
        });
        if spec.matcher {
            group["matcher"] = json!("*");
        }
        arr.push(group);
    }
    root
}

fn existing_config(contents: Option<&str>, path: &std::path::Path) -> Result<Value, String> {
    match contents {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(s).map_err(|e| {
            format!("{} is not valid JSON ({e}); refusing to overwrite", path.display())
        }),
        _ => Ok(json!({})),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/agent.rs
git commit -m "feat(agents): idempotent hook config merge"
```

---

### Task 5: Atomic write and the enable command

**Files:**

- Modify: `src-tauri/src/modules/agent.rs`
- Test: same file

**Interfaces:**

- Produces: `fn write_atomic(path, contents) -> Result<()>`, `#[tauri::command] pub fn agent_enable_hooks(agent: String) -> Result<(), String>`.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module:

```rust
    #[test]
    fn enable_writes_merged_config_atomically() {
        let dir = std::env::temp_dir().join(format!("puhon-agent-{}", std::process::id()));
        let path = dir.join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Bypass home_dir by exercising merge + write directly.
        let merged = merge_hooks(json!({}), find("claude").unwrap());
        let out = serde_json::to_string_pretty(&merged).unwrap();
        write_atomic(&path, &out).unwrap();
        let read = std::fs::read_to_string(&path).unwrap();
        assert!(read.contains("notify;Puhon;finished"));

        // Re-running is idempotent on disk.
        let twice = merge_hooks(serde_json::from_str(&read).unwrap(), find("claude").unwrap());
        write_atomic(&path, &serde_json::to_string_pretty(&twice).unwrap()).unwrap();
        let read2 = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read.matches("notify;Puhon").count(), read2.matches("notify;Puhon").count());

        std::fs::remove_dir_all(&dir).unwrap();
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: FAIL, `write_atomic` not found.

- [ ] **Step 3: Implement write and the command**

Add to `src-tauri/src/modules/agent.rs`:

```rust
fn write_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("puhon-tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", path.display())
    })
}

#[tauri::command]
pub fn agent_enable_hooks(agent: String) -> Result<(), String> {
    let spec = find(&agent)?;
    let path = settings_path(spec)?;
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => existing_config(Some(&s), &path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };

    let merged = merge_hooks(existing, spec);
    let out = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    write_atomic(&path, &out)
}
```

(Pi and OpenCode branch into this command in Tasks 7 and 9.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/agent.rs
git commit -m "feat(agents): atomic hook config install command"
```

---

### Task 6: Status command

**Files:**

- Modify: `src-tauri/src/modules/agent.rs`
- Test: same file

**Interfaces:**

- Produces: `#[tauri::command] pub fn agent_hooks_status(agent: String) -> bool`.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module:

```rust
    #[test]
    fn status_reports_true_when_all_needles_present() {
        let dir = std::env::temp_dir().join(format!("puhon-status-{}", std::process::id()));
        let path = dir.join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let merged = merge_hooks(json!({}), find("codex").unwrap());
        std::fs::write(&path, serde_json::to_string_pretty(&merged).unwrap()).unwrap();

        // Exercise the needle logic directly (status command reads from home).
        let content = std::fs::read_to_string(&path).unwrap();
        let s = find("codex").unwrap();
        assert!(s.events.iter().all(|(_, m)| content.contains(&status_needle(s, m))));

        std::fs::remove_dir_all(&dir).unwrap();
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: FAIL (compiles, but the assertion is trivially exercised; this task adds the command the next plan calls).

- [ ] **Step 3: Implement the command**

Add to `src-tauri/src/modules/agent.rs`:

```rust
#[tauri::command]
pub fn agent_hooks_status(agent: String) -> bool {
    let Ok(spec) = find(&agent) else { return false };
    let Some(content) = settings_path(spec)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    spec.events
        .iter()
        .all(|(_, m)| content.contains(&status_needle(spec, m)))
}
```

- [ ] **Step 4: Run tests and lint**

Run: `cd src-tauri && cargo test --locked agent:: && cargo clippy --all-targets --locked -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/agent.rs
git commit -m "feat(agents): hook install status command"
```

---

### Task 7: Pi extension installer

**Files:**

- Modify: `src-tauri/src/modules/agent.rs`
- Test: same file

**Interfaces:**

- Produces: Pi constants, `pi_extension_path`, `pi_extension_contents`, `pi_extension_write_path`, `enable_pi_extension_at`, `enable_pi_extension`. `agent_enable_hooks("pi")` and `agent_hooks_status("pi")` branch to the extension path.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:

```rust
    #[test]
    fn pi_extension_contains_markers_and_events() {
        let path = std::path::Path::new("/x/puhon-notifications.ts");
        let ext = pi_extension_contents(None, path).unwrap();
        for needle in PI_STATUS_NEEDLES {
            assert!(ext.contains(needle), "missing {needle}");
        }
        assert!(ext.contains("process.env.PUHON_TERMINAL"));
        assert!(ext.contains("process.stdout.write"));
    }

    #[test]
    fn pi_extension_refuses_foreign_file() {
        let path = std::path::Path::new("/x/puhon-notifications.ts");
        assert!(pi_extension_contents(Some("export const mine = true;"), path).is_err());
        assert!(pi_extension_contents(Some(PI_EXTENSION), path).is_ok());
        assert!(pi_extension_contents(Some(" \n"), path).is_ok());
    }

    #[test]
    fn pi_install_is_atomic_idempotent_and_preserves_foreign_files() {
        let dir = std::env::temp_dir().join(format!("puhon-pi-{}", std::process::id()));
        let path = dir.join(PI_EXTENSION_FILE);
        let _ = std::fs::remove_dir_all(&dir);

        enable_pi_extension_at(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), PI_EXTENSION);
        enable_pi_extension_at(&path).unwrap(); // idempotent

        std::fs::write(&path, "export const mine = true;").unwrap();
        assert!(enable_pi_extension_at(&path).is_err()); // refuse foreign
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "export const mine = true;");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pi_install_preserves_symlink() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("puhon-pi-link-{}", std::process::id()));
        let target = dir.join("managed.ts");
        let path = dir.join(PI_EXTENSION_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&target, format!("// {PI_EXTENSION_MARKER}\n")).unwrap();
        symlink(&target, &path).unwrap();

        enable_pi_extension_at(&path).unwrap();
        assert!(std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(target).unwrap(), PI_EXTENSION);

        std::fs::remove_dir_all(&dir).unwrap();
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: FAIL, Pi symbols not defined.

- [ ] **Step 3: Implement the Pi installer**

Add the Pi constants near the top of `agent.rs` (below `OWNED_MARKERS`):

```rust
const PI_EXTENSION_DIR: &str = ".pi/agent/extensions";
const PI_EXTENSION_FILE: &str = "puhon-notifications.ts";
const PI_EXTENSION_MARKER: &str = "puhon-pi-notifications-v1";
const PI_STATUS_NEEDLES: &[&str] = &[
    PI_EXTENSION_MARKER,
    "agent_start",
    "agent_settled",
    "notify;Puhon;pi;${event}",
    "emit(\"working\")",
    "emit(\"finished\")",
];
const PI_EXTENSION: &str = r#"// puhon-pi-notifications-v1
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const emit = (event: "working" | "finished") => {
    if (process.env.PUHON_TERMINAL) {
      process.stdout.write(`\u001b]777;notify;Puhon;pi;${event}\u0007`);
    }
  };

  pi.on("agent_start", () => emit("working"));
  pi.on("agent_settled", () => emit("finished"));
}
"#;
```

Add the installer functions:

```rust
fn pi_extension_path() -> Result<std::path::PathBuf, String> {
    home_path(PI_EXTENSION_DIR, PI_EXTENSION_FILE)
}

fn pi_extension_contents(existing: Option<&str>, path: &std::path::Path) -> Result<&'static str, String> {
    if existing.is_some_and(|s| !s.trim().is_empty() && !s.contains(PI_EXTENSION_MARKER)) {
        return Err(format!(
            "{} is not managed by Puhon; refusing to overwrite",
            path.display()
        ));
    }
    Ok(PI_EXTENSION)
}

fn pi_extension_write_path(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            std::fs::canonicalize(path).map_err(|e| format!("resolve {}: {e}", path.display()))
        }
        Ok(_) => Ok(path.to_path_buf()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(e) => Err(format!("inspect {}: {e}", path.display())),
    }
}

fn enable_pi_extension_at(path: &std::path::Path) -> Result<(), String> {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let existing = match std::fs::read_to_string(path) {
        Ok(s) if s == PI_EXTENSION => return Ok(()),
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let contents = pi_extension_contents(existing.as_deref(), path)?;
    write_atomic(&pi_extension_write_path(path)?, contents)
}

fn enable_pi_extension() -> Result<(), String> {
    enable_pi_extension_at(&pi_extension_path()?)
}
```

Branch the two commands. Change the start of `agent_enable_hooks` to:

```rust
#[tauri::command]
pub fn agent_enable_hooks(agent: String) -> Result<(), String> {
    if agent == "pi" {
        return enable_pi_extension();
    }
    if agent == "opencode" {
        return enable_opencode_plugin();
    }
    let spec = find(&agent)?;
    // ...unchanged JSON-config path...
```

And `agent_hooks_status` to:

```rust
#[tauri::command]
pub fn agent_hooks_status(agent: String) -> bool {
    if agent == "pi" {
        return pi_extension_path()
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .is_some_and(|content| PI_STATUS_NEEDLES.iter().all(|n| content.contains(n)));
    }
    if agent == "opencode" {
        return opencode_plugin_status();
    }
    let Ok(spec) = find(&agent) else { return false };
    // ...unchanged JSON-config path...
```

(`enable_opencode_plugin` and `opencode_plugin_status` arrive in Task 9. Add stubs returning `Ok(())` / `false` now if you want intermediate compiles, then replace them in Task 9.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/modules/agent.rs
git commit -m "feat(agents): install Pi coding-agent extension"
```

---

### Task 8: Windows CONOUT$ helper and arg dispatch

**Files:**

- Modify: `src-tauri/src/modules/agent.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `agent.rs`

**Interfaces:**

- Produces: `fn conout_marker(agent, event) -> String` (cfg any(windows, test)), `pub fn emit_conout_marker(agent, event)` (cfg windows). `run()` in `lib.rs` dispatches the `__puhon_notify` subcommand on Windows before starting Tauri.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module:

```rust
    #[test]
    fn conout_marker_matches_detector_format() {
        // Exactly the bytes pty/agent_detect parses (ESC ] 777 ; ... BEL).
        assert_eq!(
            conout_marker("codex", "attention"),
            "\u{1b}]777;notify;Puhon;codex;attention\u{7}"
        );
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: FAIL, `conout_marker` not found.

- [ ] **Step 3: Implement the marker and the Windows emitter**

Add to `src-tauri/src/modules/agent.rs`:

```rust
// The raw OSC 777 bytes the detector parses. Kept in one place so the Windows
// CONOUT$ path can't drift from what the Unix /dev/tty hook emits.
#[cfg(any(windows, test))]
fn conout_marker(agent: &str, event: &str) -> String {
    format!("\x1b]777;notify;Puhon;{agent};{event}\x07")
}

// Windows has no /dev/tty: the hook calls `puhon.exe __puhon_notify ...` and we
// write the marker into the ConPTY console. A GUI-subsystem release inherits no
// console, so attach to the hook runner's first.
#[cfg(windows)]
pub fn emit_conout_marker(agent: &str, event: &str) {
    use std::io::Write;
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};

    if std::env::var_os("PUHON_TERMINAL").is_none() {
        return;
    }
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("CONOUT$")
    {
        let _ = f.write_all(conout_marker(agent, event).as_bytes());
    }
}
```

- [ ] **Step 4: Add the Windows arg dispatch to run()**

In `src-tauri/src/lib.rs`, at the very start of `pub fn run()` (before any other logic), add:

```rust
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(String::as_str) == Some("__puhon_notify") {
            if let (Some(agent), Some(event)) = (args.get(2), args.get(3)) {
                crate::modules::agent::emit_conout_marker(agent, event);
            }
            use std::io::Write;
            let mut out = std::io::stdout();
            let _ = out.write_all(b"{}");
            let _ = out.flush();
            std::process::exit(0);
        }
    }
```

- [ ] **Step 5: Register the two Tauri commands**

In `src-tauri/src/lib.rs`, in the `invoke_handler![...]` list (alongside the `pty::pty_*` commands), add:

```rust
            crate::modules::agent::agent_enable_hooks,
            crate::modules::agent::agent_hooks_status,
```

- [ ] **Step 6: Build, lint, test**

Run: `cd src-tauri && cargo build --locked && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked agent::`
Expected: clean build, no warnings, tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/modules/agent.rs src-tauri/src/lib.rs
git commit -m "feat(agents): Windows CONOUT$ helper and command registration"
```

---

### Task 9: OpenCode plugin installer

**Files:**

- Modify: `src-tauri/src/modules/agent.rs`
- Test: same file

**Interfaces:**

- Produces: OpenCode constants, `opencode_plugin_path`, `opencode_plugin_contents`, `enable_opencode_plugin_at`, `enable_opencode_plugin`, `opencode_plugin_status`. Replaces the Task 7 stubs in `agent_enable_hooks`/`agent_hooks_status`.

The OpenCode plugin hooks the `event` lifecycle and writes the marker to `/dev/tty` via OpenCode's `$` shell runner. The modern event is `session.status` with `status.type` of `busy` (working) or `idle` (finished); `session.idle` is deprecated but still fires.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:

```rust
    #[test]
    fn opencode_plugin_contains_markers_and_events() {
        let path = std::path::Path::new("/x/puhon-notifications.js");
        let plugin = opencode_plugin_contents(None, path).unwrap();
        for needle in OPENCODE_STATUS_NEEDLES {
            assert!(plugin.contains(needle), "missing {needle}");
        }
        assert!(plugin.contains("process.env.PUHON_TERMINAL"));
        assert!(plugin.contains("session.status"));
    }

    #[test]
    fn opencode_plugin_refuses_foreign_file() {
        let path = std::path::Path::new("/x/puhon-notifications.js");
        assert!(opencode_plugin_contents(Some("export const mine = 1;"), path).is_err());
        assert!(opencode_plugin_contents(Some(OPENCODE_PLUGIN), path).is_ok());
    }

    #[test]
    fn opencode_install_is_atomic_and_idempotent() {
        let dir = std::env::temp_dir().join(format!("puhon-oc-{}", std::process::id()));
        let path = dir.join(OPENCODE_PLUGIN_FILE);
        let _ = std::fs::remove_dir_all(&dir);

        enable_opencode_plugin_at(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), OPENCODE_PLUGIN);
        enable_opencode_plugin_at(&path).unwrap();

        std::fs::remove_dir_all(&dir).unwrap();
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: FAIL, OpenCode symbols not defined.

- [ ] **Step 3: Implement the OpenCode installer**

Add constants near the Pi constants:

```rust
const OPENCODE_PLUGIN_DIR: &str = ".config/opencode/plugin";
const OPENCODE_PLUGIN_FILE: &str = "puhon-notifications.js";
const OPENCODE_PLUGIN_MARKER: &str = "puhon-opencode-notifications-v1";
const OPENCODE_STATUS_NEEDLES: &[&str] = &[
    OPENCODE_PLUGIN_MARKER,
    "session.status",
    "notify;Puhon;opencode;${ev}",
    "$PTY_MARKER",
];
const OPENCODE_PLUGIN: &str = r#"// puhon-opencode-notifications-v1
export const PuhonNotifications = async ({ $ }) => {
  const PTY_MARKER = (ev) =>
    `\u001b]777;notify;Puhon;opencode;${ev}\u0007`;
  return {
    event: async ({ event }) => {
      if (!process.env.PUHON_TERMINAL) return;
      if (event.type !== "session.status") return;
      const status = event.properties?.status?.type ?? event.status?.type;
      if (status === "busy") {
        await $`printf ${PTY_MARKER("working")} > /dev/tty`;
      } else if (status === "idle") {
        await $`printf ${PTY_MARKER("finished")} > /dev/tty`;
      }
    },
  };
};
export default PuhonNotifications;
"#;
```

Add the installer functions (mirroring the Pi shape):

```rust
fn opencode_plugin_path() -> Result<std::path::PathBuf, String> {
    home_path(OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_FILE)
}

fn opencode_plugin_contents(
    existing: Option<&str>,
    path: &std::path::Path,
) -> Result<&'static str, String> {
    if existing.is_some_and(|s| !s.trim().is_empty() && !s.contains(OPENCODE_PLUGIN_MARKER)) {
        return Err(format!(
            "{} is not managed by Puhon; refusing to overwrite",
            path.display()
        ));
    }
    Ok(OPENCODE_PLUGIN)
}

fn enable_opencode_plugin_at(path: &std::path::Path) -> Result<(), String> {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let existing = match std::fs::read_to_string(path) {
        Ok(s) if s == OPENCODE_PLUGIN => return Ok(()),
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let contents = opencode_plugin_contents(existing.as_deref(), path)?;
    write_atomic(&pi_extension_write_path(path)?, contents)
}

fn enable_opencode_plugin() -> Result<(), String> {
    enable_opencode_plugin_at(&opencode_plugin_path()?)
}

fn opencode_plugin_status() -> bool {
    opencode_plugin_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|content| OPENCODE_STATUS_NEEDLES.iter().all(|n| content.contains(n)))
}
```

Note: `enable_opencode_plugin_at` reuses `pi_extension_write_path` for the symlink-safe resolution, since the symlink handling is generic. If you prefer, rename it to `managed_write_path` and share it; the behavior is identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --locked agent::`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`
Expected: no warnings.

```bash
git add src-tauri/src/modules/agent.rs
git commit -m "feat(agents): install OpenCode notification plugin"
```

---

### Task 10: Full Rust gate and manual install smoke

- [ ] **Step 1: Full test + lint**

Run: `cd src-tauri && cargo nextest run --locked 2>/dev/null || cargo test --locked`
Expected: all tests PASS (detector from Plan 1 plus all agent:: tests).

Run: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`
Expected: no warnings.

- [ ] **Step 2: Manual smoke - install and verify Claude**

Run: `pnpm tauri dev`. Once the app is up, from a terminal in the dev shell run:

```bash
node -e "console.log(require('./src-tauri/target/debug/...'))" 2>/dev/null || true
```

That node line is illustrative only. Instead, exercise the command directly via the Tauri devtools console (the webview devtools), or temporarily add a debug call. The concrete check: open the OS file `~/.claude/settings.json` after triggering an install (Plan 3 wires the UI; for now call the command from devtools):

```js
await window.__TAURI__.core.invoke("agent_enable_hooks", { agent: "claude" });
await window.__TAURI__.core.invoke("agent_hooks_status", { agent: "claude" }); // true
```

Then inspect `~/.claude/settings.json`: it must contain three `notify;Puhon;...` hooks (working, attention, finished) and leave any pre-existing hooks intact.

- [ ] **Step 3: Manual smoke - Pi extension**

```js
await window.__TAURI__.core.invoke("agent_enable_hooks", { agent: "pi" });
await window.__TAURI__.core.invoke("agent_hooks_status", { agent: "pi" }); // true
```

Inspect `~/.pi/agent/extensions/puhon-notifications.ts`: must equal the managed content, must not have overwritten a foreign file if one existed.

- [ ] **Step 4: Commit any cleanup**

If the smoke revealed a fix, commit it. Otherwise this step is a no-op.

---

## Self-review

**Spec coverage** (against `docs/architecture/agent-awareness.md`):

- Section 8 install backend (AgentSpec, delivery modes, safe-install invariants, the 5 adapters): Tasks 2 to 9.
- Section 8 Pi extension + OpenCode plugin managed-file installers: Tasks 7 and 9.
- Section 8 Windows CONOUT$ helper + arg dispatch: Task 8.
- Section 5 detector agent list (Antigravity aliases): Task 1.
- Section 13 install-backend tests (atomic, idempotent, refuse-foreign, symlink): Tasks 5, 7, 9.
- Frontend (section 9), detector core (section 5 minus the alias), and PTY wiring (section 7) are out of scope here (Plans 1 and 3).

**Placeholder scan:** none. Every code step has full code and exact paths. The OpenCode event payload access (`event.properties?.status?.type ?? event.status?.type`) is defensive against the two payload shapes OpenCode has used; Task 9 verifies the needles, and the manual smoke (Plan 3) confirms end-to-end.

**Type consistency:** `AgentSpec`, `Delivery`, `find`, `hook_command`, `osc_command`, `status_needle`, `merge_hooks`, `write_atomic`, `agent_enable_hooks`, `agent_hooks_status` are defined once and reused. The Pi and OpenCode installers share `pi_extension_write_path` for symlink-safe resolution (Task 9 calls it; if renamed, update both call sites).

**Risks carried into execution:**

- OpenCode `session.status` payload shape (Task 9): defended with a fallback access; verify in the Plan 3 manual smoke.
- Antigravity event names (`BeforeAgent`/`Notification`/`AfterAgent`): inherited from Terax's working gemini adapter; the manual smoke (Task 10) confirms the file is written. Live confirmation that Antigravity CLI fires those events happens in Plan 3's end-to-end test.
- Windows helper requires a console attach (Task 8): the dispatch runs before Tauri starts, so the GUI-subsystem no-console case is handled by `AttachConsole(ATTACH_PARENT_PROCESS)`.

## Next plan

- **Plan 3:** frontend module `src/modules/agents/` (terminal-source only) - the `puhon:agent-signal` listener bridge, store, NotificationBell, AgentToast, OS notifications, and the `agentNotifications` settings preference. It calls the `agent_enable_hooks` and `agent_hooks_status` commands shipped here.
