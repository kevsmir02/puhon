# Agent-awareness layer - design spec

- Status: Draft, pending review
- Date: 2026-07-20
- Owner: puhon
- Supersedes: none (this is the first design for the ROADMAP "Agent-awareness layer" item)

## 1. Purpose

Puhon exists to host external coding-agent CLIs (Codex, OpenCode, Pi, Claude Code,
Antigravity, and similar) in its terminal. Today, when an agent running in a
hidden tab needs input or finishes a task, the user has no signal. They have to
remember to check back. The agent-awareness layer closes that gap:

> Detect supported agent CLIs running in any PTY and route their lifecycle
> (started, working, needs-attention, finished, exited) to an in-app bell and
> OS notifications, but only when the user is not already looking at that tab.

This is the fork's reason to exist. Nothing else on the ROADMAP serves the
"agent-host first" thesis as directly.

### What this is NOT

This layer observes **external** CLIs the user chose to run. It is not, and must
never become, built-in AI. Puhon does not ship chat, models, providers, API-key
management, or LSP. The built-in AI subsystem was intentionally removed and stays
removed. Every design choice below is audited against that line (see section 10,
"Boundary: what we do not port").

## 2. Lineage and posture

Puhon is a fork of Terax. Terax already implements this feature. Rather than
design from scratch, this spec defines a **surgical port** of Terax's
terminal-source detection path into Puhon, with three classes of change:

1. Rebrand (Terax to Puhon) throughout.
2. Strip every trace of Terax's built-in AI ("local" agent source, managed review,
   the `modules/ai` subsystem).
3. Adapt the agent set to Puhon's roadmap (add OpenCode and Antigravity, which
   Terax does not have).

A naive wholesale port would drag the AI subsystem back across the fork line.
This spec exists partly to prevent that.

Terax's detector architecture is retained because it is more Puhon-idiomatic
than a frontend alternative, not less: PUHON.md mandates "Rust owns all OS
access" and "functional core, imperative shell." The detector is a pure Rust
state machine over bytes; the wiring is a thin shell. Detection belongs in Rust.

## 3. Goals and non-goals

### Goals

- Detect agent CLIs running in any terminal leaf, including hidden and
  split-pane leaves.
- Route five lifecycle phases to UI: started, working, attention, finished,
  exited.
- Surface attention and finished events via an in-app bell and OS notifications,
  gated on tab visibility and window focus.
- Never flap when a full-screen TUI repaints continuously.
- Zero cost when no agent is running: no polling, no extra IPC on the hot path,
  no work in idle tabs beyond parsing bytes that already flow.
- Honor the existing OSC trust model: untrusted command output cannot arm the
  detector or spoof attention.
- Ship install support for five agents in v1: Claude Code, Codex, Pi, OpenCode,
  Antigravity.

### Non-goals (v1)

- Built-in AI of any kind (see section 1).
- Managed/supervised agent review loops.
- A "local" agent source. There is only one source: the terminal.
- Image/screenshot input into agent prompts (separate ROADMAP item).
- SSH support (separate ROADMAP item; this layer is designed to work over SSH
  unchanged because it reads the same OSC stream).
- Process-name attribution as a primary signal. It is an optional later phase.

## 4. Architecture overview

The layer spans both processes, matching Puhon's two-process model.

```
agent CLI hook (shell script / Pi extension / OpenCode plugin)
  writes OSC bytes to its controlling terminal (the PTY)
   |
   v
RUST: PTY reader thread (session.rs)
  feeds every byte chunk to AgentDetector (agent_detect.rs)
  detector emits Transition -> AgentSignal
  app.emit("puhon:agent-signal", signal)
   |
   v
FRONTEND: AgentNotificationsBridge listens for "puhon:agent-signal"
  maps signal -> agentStore action (start / setStatus / finish)
  on attention or finished, calls routeAgentNotification(...)
    -> if window unfocused: OS notification
    -> elif tab hidden and allowToast: in-app toast
    -> always: push to bell notification list
   |
   v
UI: NotificationBell (counts + list), AgentToast, tab status
```

Nothing here adds IPC round-trips on the keystroke/output hot path. Bytes already
flow from PTY to the reader thread; the detector is an extra pure-function pass
over those bytes. Signals are emitted only on lifecycle transitions (rare), not
per byte.

### Module placement

New frontend module `src/modules/agents/`, following PUHON.md's module idiom
(self-contained, thin `index.ts` barrel, logic under `lib/`). New Rust module
`src-tauri/src/modules/pty/agent_detect.rs` (the detector) and
`src-tauri/src/modules/agent.rs` (the install backend).

## 5. The detector (functional core)

File: `src-tauri/src/modules/pty/agent_detect.rs`. Ported from Terax, rebranded.

### Shape

`AgentDetector` is a per-PTY state machine. One instance lives in each PTY
reader thread. It exposes two entry points:

- `process(&mut self, input: &[u8], emit: F)` - feed a chunk of raw PTY output.
- `finish(&mut self, emit: F)` - call when the PTY closes; reports `Exited` if
  the detector was armed, so a shell that dies mid-command does not leave a
  stale session.

### Byte-level parser

A minimal, allocation-light OSC scanner with four states: `Ground`, `Esc`,
`Osc`, `OscEsc`. It handles both terminators (BEL `0x07` and ST `ESC \`), caps a
single OSC at 2048 bytes (overflow clears the buffer, never panics), and is
correct under arbitrary chunk boundaries (a sequence split across reads parses
identically to one delivered whole). A fast path skips entirely when a chunk
contains no `ESC` byte and the machine is in `Ground`.

This parser exists only to extract OSC payloads. It does not interpret CSI, DCS,
APC, or any other control structure. PTY output that is not an OSC sequence we
care about is ignored at zero cost.

### Signal sources

The detector derives transitions from OSC sequences only, never from raw output.
That is the no-flap invariant: a TUI that repaints its screen continuously
emits no new OSC lifecycle sequence, so working and waiting never toggle.

Five inputs drive it:

1. **OSC 133 C;<command>** (shell preexec marker). The detector inspects the
   command text via `match_agent`: it tokenizes, skips flags, takes each
   token's basename (splitting on both `/` and `\`), and prefix-matches against
   the known-agent list. Matches must be exact or dash-suffixed: `claude`,
   `/usr/local/bin/codex`, `npx claude`, `claude-enigma` all match; `claudexyz`,
   `cat claude.txt`, `vim src/main.rs` do not. A match arms the detector and
   emits `Started { agent }`.
2. **OSC 133 D** (command exit marker). If armed, emits `Exited` and disarms.
3. **OSC 777, Puhon marker** (emitted by installed hooks):
   - 4-field: `notify;Puhon;<agent>;<event>` where `<agent>` is validated
     against the known list (an unknown agent like `evil` is rejected). `<event>`
     is `working`, `attention`, or `finished`.
   - 3-field legacy: `notify;Puhon;<event>` (Claude Code path). Agent defaults
     to `claude`.
   Both forms self-arm if not already armed (so detection works on shells
   without preexec, on Windows, and inside tmux).
4. **OSC 9** (ConEmu-style desktop notify), excluding `9;4` (taskbar progress).
   Treated as generic `Attention`, but only when already armed.
5. **Generic OSC 777** from a non-Puhon source. Treated as generic `Attention`,
   only when armed.

### The "armed" trust gate

This is the security core. The detector has an `armed` flag. It becomes armed
only on a trusted signal: an OSC 133 C whose command matches a known agent, or
a Puhon OSC 777 marker whose agent field is a known agent.

While disarmed, generic attention signals (OSC 9, foreign OSC 777) are ignored.
This means `cat attacker-file.txt` can print arbitrary escape sequences,
including fake `OSC 9` or foreign `OSC 777 notify` bytes, and the detector will
not react. Untrusted output cannot arm the detector, cannot flip it to
attention, and cannot spoof a finished event. This mirrors the existing OSC 7
trust discipline in `osc-handlers.ts` (OSC 7 emitted during a command is
rejected as untrusted).

The known-agent allowlist for the 4-field marker is the same list used by
`match_agent`, so the gate and the command matcher agree on what counts as an
agent.

### Transition and signal vocabulary

```
Transition = Started { agent } | Working | Attention | Finished | Exited
AgentSignal = { id: u32, kind: "started"|"working"|"attention"|"finished"|"exited", agent: Option<String> }
```

`id` is the PTY session id. `agent` is set only on `started`; subsequent
transitions inherit the armed agent. `into_signal(id)` maps a Transition to an
AgentSignal for serialization.

### Default agent list

`DEFAULT_AGENTS = ["claude", "codex", "pi", "opencode", "antigravity"]`.

This list serves two roles: the OSC 133 C command matcher, and the 4-field OSC
777 agent-field allowlist. Both must stay in sync. (Terax ships
`claude/codex/gemini/pi`; Puhon drops `gemini` as a distinct entry since
Antigravity supersedes it in this roadmap, and adds `opencode` and
`antigravity`.)

## 6. Wire protocol

All forms terminate with BEL (`0x07`) or ST (`ESC \`). Values are not encoded
beyond what each agent's hook mechanism naturally produces; agent names and
events are short ASCII tokens.

### Puhon OSC 777 (primary, hook-emitted)

```
ESC ] 777 ; notify ; Puhon ; <agent> ; <event> BEL
ESC ] 777 ; notify ; Puhon ; <event> BEL          (3-field legacy, Claude)
```

- `<agent>` in `claude | codex | pi | opencode | antigravity` (lowercase).
- `<event>` in `working | attention | finished`.

Examples:

```
ESC ] 777 ; notify ; Puhon ; codex ; attention BEL
ESC ] 777 ; notify ; Puhon ; working BEL
```

The host-app field is the literal `Puhon`. The detector matches the prefix
`notify;Puhon;` (constant `PUHON_MARKER`).

### Shell integration (OSC 133, already emitted by Puhon)

```
ESC ] 133 ; C ; <command line> BEL     -> arms + Started if command matches an agent
ESC ] 133 ; D BEL                       -> Exited if armed
```

No new shell work required; Puhon already emits OSC 133 A/B/C/D via its init
scripts. The detector reuses them.

### Generic (compat, gated on armed)

```
ESC ] 9 ; <message> BEL                 -> Attention (armed only; 9;4 excluded)
ESC ] 777 ; notify ; <other> ; ... BEL  -> Attention (armed only)
```

### Why no custom Puhon OSC number

An earlier draft proposed a private `1337;puhon;...` sequence. It is dropped.
OSC 777 with a `Puhon;` host field is sufficient, already has five shipping
adapters in the sister codebase, and standard terminals that parse OSC 777 show
a harmless notification instead of garbage. Inventing a second protocol would
add parser surface for no gain.

## 7. PTY wiring

File: `src-tauri/src/modules/pty/session.rs`. Ported from Terax, ~5 lines.

Inside the existing PTY reader thread, alongside the `DaFilter` pass:

```rust
let mut agent_detect = AgentDetector::new();
// ...in the read loop:
agent_detect.process(&buf[..n], |t| {
    let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
});
// ...after the read loop ends:
agent_detect.finish(|t| {
    let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
});
```

`AGENT_EVENT` is the constant `"puhon:agent-signal"`. The detector runs as an
independent pass over the same bytes the DA filter and the pending-buffer path
already consume. It does not mutate the byte stream forwarded to xterm.

This placement means detection works uniformly regardless of renderer-slot
state: a hidden leaf whose slot is parked or stolen still has its bytes scanned
here, in Rust, before any xterm lifecycle is involved. That uniformity is the
main reason detection lives in Rust rather than in a frontend xterm OSC handler.

## 8. Install backend

File: `src-tauri/src/modules/agent.rs`. Ported from Terax, rebranded, with the
agent set adjusted.

### AgentSpec registry

Each agent has a spec: config directory, config file, the lifecycle events it
exposes, whether it uses matchers, and its delivery mode.

| Agent | Config target | Events to phase | Delivery |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | UserPromptSubmit to working, Notification to attention, Stop to finished | TerminalSequence JSON |
| Codex | `~/.codex/hooks.json` | UserPromptSubmit to working, PermissionRequest to attention, Stop to finished | Osc to /dev/tty (unix), CONOUT$ helper (windows) |
| Pi | `~/.pi/agent/extensions/puhon-notifications.ts` | agent_start to working, agent_settled to finished | Pi extension, process.stdout |
| Antigravity | `~/.gemini/config/hooks.json` (or workspace `.agents/hooks.json`) | PreInvocation to working, Notification to attention, Stop to finished | Osc to /dev/tty (unix), CONOUT$ helper (windows) |
| OpenCode | `~/.config/opencode/plugin/puhon-notifications.ts` | message/session start to working, end to finished | TS plugin writing to /dev/tty |

### Delivery modes

- **TerminalSequence**: the hook returns JSON
  `{"terminalSequence":"\u001b]777;notify;Puhon;<event>\u0007"}` and the agent
  harness writes those bytes to its controlling terminal. Used by Claude Code,
  which lost direct `/dev/tty` access in v2.1.139. Cross-platform.
- **Osc**: the hook command itself writes the marker. On unix,
  `printf '\033]777;notify;Puhon;<agent>;<event>\007' > /dev/tty`. On windows,
  a helper invocation `puhon.exe __puhon_notify <agent> <event>` writes via
  CONOUT$.
- **Pi extension**: a TypeScript extension using the
  `@earendil-works/pi-coding-agent` `ExtensionAPI`, gated on
  `process.env.PUHON_TERMINAL`, writing the marker to `process.stdout` on
  `agent_start` and `agent_settled`.
- **OpenCode plugin**: a TypeScript plugin subscribing to OpenCode's lifecycle
  events, writing the marker to `/dev/tty` (stdout fallback on windows).

All hook commands are gated on `$PUHON_TERMINAL` so they no-op outside Puhon.
`PUHON_TERMINAL=1` is already injected at PTY spawn
(`shell_init.rs` unix and windows arms).

### Tauri commands

- `agent_enable_hooks(agent: String) -> Result<(), String>`: installs (or
  refreshes) the hook config for one agent. For JSON-config agents, merges into
  the existing file, pruning Puhon's own previously-written groups first so
  installs are idempotent and migrate older marker forms. For Pi, writes the
  managed extension file.
- `agent_hooks_status(agent: String) -> bool`: returns true when the current
  config contains the expected needles (proves the install is present and
  current).

Both are registered in `lib.rs`.

### Safe install invariants (ported from Terax, mandatory)

- **Marker-based ownership**: managed files (the Pi extension) carry a versioned
  marker comment (`// puhon-pi-notifications-v1`). The installer only overwrites
  a file it owns (marker present, or empty). A foreign file is refused, never
  clobbered.
- **Atomic writes**: write to a sibling temp file, then rename. A crash
  mid-write cannot leave a truncated config.
- **Symlink-safe**: if the target is a symlink, resolve it and write through,
  preserving the link.
- **Idempotent**: re-running `agent_enable_hooks` for an already-installed agent
  is a no-op (or a refresh).
- **Owned-marker pruning**: for JSON-config agents, the merge step removes
  Puhon's own older hook entries (matched by stable substrings) before
  reinserting, so upgrades do not accumulate duplicates.

These invariants are covered by Terax's existing unit tests, which port across.

### The two new adapters (OpenCode, Antigravity)

These are new; Terax has neither.

- **Antigravity** uses a JSON `hooks.json` format (not the older
  `settings.json` form Terax uses for its `gemini` entry). Its events are
  `PreInvocation`, `PostInvocation`, `Stop`, `PreToolUse`, `PostToolUse`. The
  adapter maps `PreInvocation` to working, a notification/permission event to
  attention, and `Stop` to finished, with `Delivery::Osc`. Config dir is
  `~/.gemini/config/` (global) or `.agents/` (workspace); the installer writes
  the global form.
- **OpenCode** uses a TypeScript plugin subscribed to lifecycle events, writing
  to `/dev/tty`. The exact event names for working and finished need to be
  confirmed against the current OpenCode plugin event surface during
  implementation (the event/bus API is still moving). The plugin file lives in
  `~/.config/opencode/plugin/`. OpenCode is the most uncertain adapter of the
  five; if its plugin cannot reliably write to the hosting PTY at the right
  moments, the fallback is a thin shell wrapper around the `opencode` invocation
  that tees our marker on start and exit. The spec marks this as the
  highest-risk item in section 13.

## 9. Frontend

Module: `src/modules/agents/`. Ported from Terax, terminal-source only.

### Types (`lib/types.ts`)

```
AgentStatus = "working" | "waiting"
AgentSignalKind = "started" | "working" | "attention" | "finished" | "exited"
AgentSignal = { id: number; kind: AgentSignalKind; agent: string | null }
AgentSession = { leafId, tabId, agent, status, startedAt, lastActivityAt, attentionSince }
AgentNotification = { id, source: "terminal", leafId, tabId, agent, kind: "attention"|"finished"|"error", at, read }
```

There is exactly one source: `"terminal"`. The `AgentSource` union and
`LocalAgentState` type that exist in Terax are not ported. `source` is retained
as a literal on `AgentNotification` for forward compatibility and simple
filtering, but it has one value.

### Store (`store/agentStore.ts`)

A zustand store holding `sessions: Record<leafId, AgentSession>` and
`notifications: AgentNotification[]` (capped at 50). Actions: `start`,
`setStatus`, `finish`, `pushNotification`, `markAllRead`, `clearNotifications`.
Plus `nextAttentionTarget()`, which returns the most recently waiting session
for a keyboard "jump to attention" shortcut.

The Terax fields `localAgent` and `setLocalAgent` are not ported.

### Bridge (`components/AgentNotificationsBridge.tsx`)

Mounted once in `App.tsx`. Listens for `"puhon:agent-signal"`. For each signal,
resolves the PTY id to a leaf id via `leafIdForPty`, then dispatches to the
store:

- `started` -> `start(leafId, tabId, agent)`
- `working` -> `setStatus(leafId, "working")`
- `attention` -> `setStatus(leafId, "waiting")` then route
- `finished` -> `setStatus(leafId, "waiting")` then route
- `exited` -> `finish(leafId)`

Routing (`lib/route.ts`, `routeAgentNotification`) decides the surface:

- If the preference `agentNotifications` is off, do nothing.
- If the window is unfocused: OS notification via `lib/notify.ts`, plus push to
  the bell list.
- If focused but the agent's tab is not active: in-app toast (attention only;
  finished only updates the bell), plus push to the bell list.
- If focused and the tab is active: nothing (the user is already looking).

The Terax call to `maybeTriggerManagedReview(leafId)` on `finished` is not
ported. That function and its store do not exist in Puhon.

### Notify (`lib/notify.ts`)

Wraps `tauri-plugin-notification`. Lazily requests permission on first use,
caches only the positive result (a transient denial must not disable
notifications for the session). `osNotify(title, body)`. The plugin is already
wired in `lib.rs`; the capability entry in `default.json` is added here.

### UI (`components/NotificationBell.tsx`, `components/AgentToast.tsx`)

- `NotificationBell`: the header bell with a count and a collapsible notification
  list (Terax's latest evolved form, per its recent commits). The Terax
  `onActivateLocal`/`localAgent` display paths are stripped; the bell reflects
  terminal sessions only.
- `AgentToast`: transient toast for attention events when focused-but-hidden.

### Settings preference

Add `agentNotifications: boolean` (default `true`) to the settings store
(`src/modules/settings/store.ts`) and expose a toggle in the Settings UI. The
route function reads it via `usePreferencesStore.getState().agentNotifications`.

### Supporting libs

`lib/format.ts` (`displayAgent`), `lib/useWindowFocus.ts` (window focus signal
for routing), `lib/agentIcon.tsx` (per-agent icon). Ported as-is.

## 10. Boundary: what we do NOT port

This section is mandatory reading. It is the line between "agent host" and "AI
product."

Not ported, and explicitly excluded:

- **All of `src/modules/ai/`** from Terax: chat, providers, API keys, LSP, the
  agent registry, subagents, `AgentRunBridge`, `AgentStatusPill`,
  `LocalAgentNotificationsBridge`. Puhon already lacks this directory. It stays
  absent.
- **`store/managedAgentsStore.ts` and `lib/review.ts`**: Terax's built-in AI
  supervising external agents in a multi-round auto-review loop. `review.ts`
  imports `@/modules/ai/store/chatStore` and calls `chat.sendMessage`. This is
  built-in AI orchestration. It is cut entirely, and the
  `maybeTriggerManagedReview` call site is removed from the bridge.
- **`AgentSource "local"`, `LocalAgentState`, `localAgent`, `setLocalAgent`,
  `onActivateLocal`**: every trace of a "local" (in-app) agent status path.
- Any notification routing, badge, or bell behavior that depends on a local
  agent.

If a future change re-introduces any of the above, it violates PUHON.md and the
ROADMAP "out of scope: built-in AI" clause, and must be rejected.

## 11. Puhon deltas (summary)

| Area | Terax | Puhon |
| --- | --- | --- |
| Host field in OSC 777 | `notify;Terax;` | `notify;Puhon;` |
| Env gate | `TERAX_TERMINAL` | `PUHON_TERMINAL` (already injected) |
| Event name | `terax:agent-signal` | `puhon:agent-signal` |
| Pi extension file/marker | `terax-notifications.ts`, `terax-pi-notifications-v1` | `puhon-notifications.ts`, `puhon-pi-notifications-v1` |
| Owned-marker substrings | `notify;Terax;`, `terax;notify`, `__terax_notify` | `notify;Puhon;`, `puhon;notify`, `__puhon_notify` |
| Windows helper arg | `terax.exe __terax_notify` | `puhon.exe __puhon_notify` |
| Log prefix | `[terax]` | `[puhon]` |
| Agent set | claude, codex, gemini, pi | claude, codex, pi, opencode, antigravity |
| Agent sources | terminal + local | terminal only |

Conventions honored throughout: no em-dash, no emoji, `@/` imports on the
frontend, pnpm only, comments default to none (1 to 2 lines on why when
genuinely needed).

## 12. Phasing

### Phase 1 - v1 (shippable)

- Detector (`agent_detect.rs`) rebranded, with its test suite ported and
  extended for the new agent list.
- PTY wiring in `session.rs`.
- Install backend (`agent.rs`) for Claude, Codex, Pi (ported), plus Antigravity
  and OpenCode (new).
- Frontend module `src/modules/agents/`: types (terminal only), store, bridge,
  notify, route, format, useWindowFocus, agentIcon, NotificationBell,
  AgentToast.
- Settings preference `agentNotifications` (default on) + toggle.
- Tauri command registration + capability entry for notifications.

### Phase 2 - hardening and UX

- Tab-icon status display (show agent phase via the tab icon, not a separate
  badge; this is Terax's latest evolved form).
- Collapsible notification list in the bell.
- Keyboard "jump to next attention" shortcut wired to `nextAttentionTarget`.
- Confirm OpenCode plugin event mapping; if unreliable, ship the shell-wrapper
  fallback.

### Phase 3 - optional attribution

- A Rust foreground-process-name command (`/proc/<pgid>/comm` on Linux,
  `sysctl` on macOS, `QueryFullProcessImageName` on Windows), used only to
  attribute generic OSC 777 messages and to nudge users to install a hook when a
  known agent binary is detected without one. Never overrides an OSC signal,
  never drives notifications on its own.
- SSH forward-compat verification: the layer should work identically over an SSH
  PTY because it reads the same OSC stream.

## 13. Testing strategy

Per PUHON.md, a core-subsystem change (the PTY byte path) needs invariant
tests.

### Detector unit tests (port and extend Terax's suite)

The detector is pure and takes bytes in, emits transitions out. Tests cover:

- Arming on OSC 133 C with bare, pathed, wrapped (`npx claude`), and
  dash-suffixed (`claude-enigma`) agent commands.
- Not arming on non-agent commands, including `cat claude.txt` and `claudexyz`.
- 3-field and 4-field OSC 777 driving working/attention/finished, including
  self-arming when no preexec fired.
- 4-field marker rejecting unknown agents (`evil`).
- Generic OSC 9 and foreign OSC 777 ignored while disarmed, honored while armed.
- `9;4` (taskbar progress) never treated as attention.
- OSC 133 D and PTY close (`finish`) emitting `Exited` only when armed.
- No-flap: continuous raw output between OSC lifecycle sequences emits nothing.
- Chunk-boundary correctness: a sequence split across `process()` calls parses
  identically to one delivered whole.
- Oversized OSC (over 2048 bytes) clears without panicking.
- BEL inside a title-setting OSC is not misread as an attention terminator.

These are the invariants. They lock the trust gate and the no-flap property.

### Install backend tests (port Terax's suite)

- Pi extension: install is atomic, idempotent, preserves foreign files (refuses
  to overwrite), and preserves symlinks.
- JSON-config agents: merge is idempotent, prunes older owned markers, and does
  not duplicate.
- `agent_hooks_status` returns true only when all expected needles are present.

### Frontend tests

- `agentStore`: start/setStatus/finish transitions, notification cap, dedup.
- `routeAgentNotification`: the focus/visibility/allowToast matrix produces the
  correct surface (OS notify, toast, bell-only, nothing).
- `AgentNotificationsBridge`: signal-to-store mapping for all five kinds.

### Manual / integration

- Run each of the five agents in a hidden tab; confirm the bell and OS
  notification fire on attention and finished, and do not fire when the tab is
  visible and focused.
- Confirm no notifications fire for non-agent commands and for `cat` of a file
  containing hostile escape sequences.

## 14. Security review

- **Untrusted output**: command output is never trusted. The armed gate ensures
  `OSC 9` and foreign `OSC 777` from command output (a `cat` of attacker bytes,
  a remote SSH session printing escapes) cannot arm the detector or flip it to
  attention. Only a trusted signal (OSC 133 C with a known agent command, or a
  Puhon OSC 777 with a known agent) arms it. This is consistent with the
  existing OSC 7 trust discipline.
- **Agent spoofing via 4-field marker**: the agent field is allowlisted. A hook
  claiming `agent=evil` is ignored.
- **Hook install safety**: managed files are only overwritten when owned
  (marker present or empty); foreign files are refused. Writes are atomic.
  Symlinks are preserved.
- **Env gating**: hooks no-op unless `PUHON_TERMINAL` is set, so installing a
  Puhon hook does not spam escapes when the same agent runs in a bare terminal.
- **Notification permission**: requested lazily; denial does not brick the
  feature for the session (positive-only caching).

## 15. Open questions and risks

1. **OpenCode plugin event mapping** (highest risk). OpenCode's plugin event/bus
   API is still moving. The exact events for "agent started working" and "agent
   finished" must be confirmed during implementation. Mitigation: if the plugin
   cannot reliably emit at the right moments, ship the shell-wrapper fallback
   for v1 and revisit the plugin later.
2. **Antigravity hook event names.** Antigravity 2.0 introduced JSON hooks with
   events like `PreInvocation`, `PostInvocation`, `Stop`. The mapping to
   working/attention/finished is straightforward but should be verified against
   the current `hooks.json` schema when the adapter is written.
3. **Pi attention signal.** The minimal Pi extension maps `agent_start` to
   working and `agent_settled` to finished, with no attention event. Pi's
   extension API exposes an `input` event that could map to attention; adding it
   is a Phase 2 enhancement, not a v1 blocker.
4. **Detector uniformity vs xterm.** Detection lives in Rust partly so it works
   for hibernated tabs. The tradeoff is a second OSC parser alongside xterm's.
   The detector's parser is deliberately tiny (OSC only, 2048-byte cap) and
   fully tested; it is not a general terminal emulator.

## 16. Out of scope

- Built-in AI of any kind (section 1, section 10).
- Managed/supervised review loops.
- A local agent source.
- Image/screenshot input (separate ROADMAP item).
- SSH (separate ROADMAP item; designed to be compatible).
- Heavy IDE features, notebooks, package-manager UIs, full browser features,
  telemetry, accounts (per ROADMAP "out of scope").

## 17. References

- Puhon architecture authority: `PUHON.md`
- Direction and scope: `ROADMAP.md` ("Agent-awareness layer" under "Coming next")
- PTY and OSC context: `docs/architecture/pty-shell-integration.md`
- Source codebase for the port: Terax (`src-tauri/src/modules/pty/agent_detect.rs`,
  `src-tauri/src/modules/agent.rs`, `src/modules/agents/`)
