# Roadmap

Puhon direction: what's shipped, what's coming, what's deliberately out of scope, and why this fork exists.

This file is updated as direction evolves. For day-to-day work, see [GitHub Issues](https://github.com/kevsmir02/puhon/issues).

## What Puhon is

Puhon is a lightweight terminal workspace built to **host the coding-agent CLIs you already use** (Codex, OpenCode, Pi, Claude Code, and similar) alongside the chrome those agents need: a file explorer to watch what they touch, a web preview to see the servers they spin up, source control to review their commits, and an editor for your own edits. Run the agent in the terminal; stay in one app.

Under 8 MB on disk. No telemetry, no accounts, no built-in AI. Cross-platform; releases currently cut Linux first.

The product is opinionated: agent-host first, terminal-first, lightweight always.

## What Puhon is not

- **Not an AI product.** Puhon runs external coding agents; it does not ship its own chat, models, providers, or API-key management. Mature CLIs (Codex, OpenCode, Pi) do that better, so the built-in AI subsystem was removed.
- **Not a full IDE replacement.** Heavy IDE features that overlap with VS Code / Cursor / Zed are out of scope.
- **Not a browser.** Web preview exists for the local dev servers agents start, plus lightweight doc viewing.
- **Not a one-size-fits-all shell.** The goal is "best host for coding-agent CLIs," not "terminal with extras."

## Themes

The themes below frame every scope decision.

1. **Agent-host first.** Puhon exists to make running external coding-agent CLIs better than running them in a bare terminal. If a change does not serve that, it is deprioritized.
2. **Lightweight always.** 7-8 MB binary. Every dependency justified. Renderer slots pooled, scrollback bounded.
3. **Terminal-first.** xterm.js correctness, PTY fidelity, and full-screen TUI compatibility are non-negotiable. Agent CLIs are demanding TUIs; rendering them faithfully is the make-or-break surface.
4. **Security by default.** Path guards, OSC trust, IPC sandboxing. Defaults safe out of the box.
5. **Cross-platform parity.** macOS, Linux, and Windows all build and run from one codebase; no platform-specific exclusives. Releases currently cut Linux first; macOS and Windows ship when there is demand or a maintainer to verify them.

## Shipped

### Terminal

- [x] Multi-tab terminal with WebGL renderer
- [x] Native PTY backend (zsh, bash, pwsh, fish, cmd)
- [x] Split panes
- [x] Shell integration (cwd via OSC 7, prompt markers via OSC 133)
- [x] Inline search, link detection, true-color
- [x] **Drag files from explorer into terminal.** Drag a file or path into the terminal as a quoted path — an agent-input affordance (feed the running agent a file path quickly). Shell-quoted absolute path paste with no Enter.
- [x] Renderer slot pooling with lazy serialization (keeps many tabs mounted within a memory budget)
- [x] **TUI compatibility regression harness.** Replay recorded asciicast-v2 cassettes through real osc-handlers and DormantRing into @xterm/headless, snapshot rendered grids, and golden-compare in CI.

### Editor

- [x] Multi-language support (TypeScript / JavaScript, Rust, Python, HTML / CSS, JSON, Markdown, Go, C / C++ / Java / C#, PHP)
- [x] Vim mode
- [x] Prebuilt themes, external formatters (prettier, biome, ruff, rustfmt, gofmt, clang-format, shfmt, zig fmt)

### File Explorer

- [x] Icon theme with full file-type coverage
- [x] Fuzzy search, keyboard navigation, inline rename, context actions

### Git / Source Control

- [x] Source control panel (stage, commit, branch)
- [x] Git history with commit graph
- [x] Per-file diffs

### Web Preview

- [x] Auto-detected local dev server preview (status-bar pill when a localhost URL appears)
- [x] Image, PDF, and Markdown viewers, Mermaid diagrams
- [x] **Web preview attribution.** Reliably tie an auto-detected dev server to the agent tab that started it, so the preview pill opens the right surface instead of a guessed one.
- [x] Sandboxed iframe

### Platform Integration

- [x] Cross-platform: macOS, Linux, and Windows all functional (native PTY, shell integration, custom window styling, WSL bridge on Windows)
- [x] Linux release artifacts: AppImage, .deb, .rpm (x86_64 + aarch64)
- [x] Auto-updater (per-install-form routing, minisign verify)
- [x] No telemetry
- [x] Live filesystem updates in explorer and editor
- [x] Tab/pane layout restore across app restarts
- [x] Persistent terminal scrollback across restarts (opt-in)

### Agent Awareness

- [x] **Agent-awareness layer.** Detect Codex, OpenCode, Pi, Claude Code, and friends running in the PTY and route their lifecycle (started / working / needs-attention / finished / exited) to an in-app bell and OS notifications when the tab is hidden. Installed via per-CLI hooks that emit an OSC marker on prompt, permission, and stop events; driven only by escape sequences so a repainting TUI never flaps; zero cost when no agent runs. This is the fork's reason to exist; nothing else on the roadmap serves the thesis as directly.

### Security

- [x] Trust gating in terminal escape-sequence handling
- [x] Sandboxed preview surface

## Planned

### Coming next

- [ ] **macOS / Windows release pipeline.** The apps build and run on both, but the release workflow only cuts Linux artifacts. Add macOS / Windows legs when there is demand or a maintainer to verify them.

### Longer horizon

- [ ] **Image and screenshot input into agent prompts.** Agents accept image input; terminals do not. Scope a design for pasting or dragging an image into the terminal and attaching it to the running agent's prompt.
- [ ] **SSH support.** Run agents and dev servers on a remote box, controlled from local Puhon. The agent-awareness layer should work identically over the SSH PTY since it reads the same OSC stream. PTY auth and known_hosts first; SFTP and port forwarding later.
- [ ] **Release automation.** CHANGELOG generation, version bump, tag flow.
- [ ] **Selective TS-to-Rust migration**, only where a profiler shows measurable wins in the agent byte path (parsing, buffering, serialization). No speculative rewrites.

## Out of scope

Categories that will not be built into Puhon. Feature requests in these categories will be closed.

- **Built-in AI.** Chat, models, providers, API-key management, autocomplete models. Puhon hosts external coding agents; it does not compete with them.
- **Heavy IDE features.** Full language-server integration, integrated debuggers, refactoring engines, project-wide search at IDE scale. Use a real editor for those.
- **Notebook and document workspaces.** Anything that turns Puhon into a document host rather than a terminal.
- **Package manager and toolchain UIs.** Use `npm`, `pip`, `cargo` and friends in the terminal directly.
- **Full web browser features.** Preview pane stays scoped to local dev servers and lightweight doc viewing. No navigation history, no bookmarks, no dev tools.
- **Telemetry, analytics, accounts.** Puhon stays offline-respectful.
- **Extension marketplaces at IDE scale.** Arbitrary UI or behavior extensions will not.
- **Third-party subscription session bridges.** Forwarding cloud subscription auth (provider-managed login sessions) through Puhon is not technically feasible for third-party clients.
