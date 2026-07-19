# TERAX.md

Terax loads `TERAX.md` from the workspace root as agent memory (similar to AGENTS.md / CLAUDE.md). This file is also the project's living architecture doc - read it before making changes.

## Project

**Terax**: open-source terminal-native IDE. Tauri 2 + Rust (`portable-pty`) backend, React 19 + TypeScript + xterm.js (webgl) client.

This fork's purpose: a lightweight host for external coding-agent CLIs (Codex, OpenCode, Pi, Claude Code). The upstream built-in AI subsystem (chat, providers, API keys, LSP) was intentionally removed; agents run in the terminal and the surrounding chrome (explorer, preview, git, editor) keeps you in one app. Cross-platform codebase; releases currently cut Linux only.

- Bundle id: `app.crynta.terax`
- Package manager: **pnpm**
- Platforms: macOS, Linux, Windows
- Frontend checks: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust checks: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (local fallback: `cargo test --locked`)

## Quality bar

Production-grade or it does not ship. Every change is judged against all of these, not just "it works":

- **Correctness**: edge cases, failure modes, concurrent access. No "works for now".
- **Performance**: ultra-lightweight is the product. ~7-8 MB bundle, high-performance terminal. For every change ask: how much RAM it costs, whether it adds IPC round-trips or redundant requests, whether it triggers extra re-renders or wasted work, whether it pulls a heavy dependency. Unused features consume zero resources.
- **Security**: no critical security holes. Validate at every boundary (IPC, fs, network). The secret-path deny-list applies on both read and write and is never bypassed.
- **UI/UX**: polished, professional, premium. Every state and detail considered.
- **Architecture**: new or changed logic lives in pure, dependency-light functions (functional core); tauri commands and React components stay thin (imperative shell). Keeps it testable without a later rewrite.

Verify before claiming done:

- Frontend: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (or `cargo test --locked`)

A change to a core subsystem (terminal/shell spawn, workspace auth, git, fs, or IPC) needs a test that locks the invariant.

## Conventions

- **Comments**: default to none, the code should explain itself. If genuinely needed, 1-2 lines on *why*, never *what*. No AI-generic filler.
- **No em-dash** anywhere: code, comments, commits, docs.
- **No emojis** anywhere.
- **Imports**: always `@/...` on the frontend, never relative across modules.
- **pnpm only**, never npm/npx/yarn.

## Architecture

### Two-process model

**Rust (`src-tauri/`)** owns all OS access. The webview never touches the FS, processes, or shells directly - everything goes through `invoke()` calls to commands registered in `src-tauri/src/lib.rs`:

- `pty::pty_*` - long-lived interactive PTY sessions (xterm ↔ portable-pty), managed by `PtyState` (`RwLock<HashMap<id, Session>>`). Output streams via a Tauri `Channel<PtyEvent>`.
- `fs::tree::*` (`fs_read_dir`, `list_subdirs`), `fs::file::*` (`fs_read_file`, `fs_write_file`, `fs_stat`, `fs_canonicalize`), `fs::mutate::*` (`fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_delete`): file explorer + editor IO.
- `fs::search::*` (`fs_search`, `fs_list_files`), `fs::grep::*` (`fs_grep`, `fs_glob`): fuzzy file finder + content search (powered by `ignore` + `grep-*` crates).
- `git::commands::*`: full source-control surface (`git_status`, `git_diff`, `git_diff_content`, `git_stage`, `git_unstage`, `git_discard`, `git_commit`, `git_fetch`, `git_pull_ff_only`, `git_push`, `git_log`, `git_show_commit`, `git_commit_files`, `git_commit_file_diff`, `git_panel_snapshot`, `git_resolve_repo`, `git_remote_url`). All gated through the workspace authorization registry.
- `shell::shell_run_command`: one-shot subshell exec. Distinct from PTY sessions; not the user's interactive terminal. On Windows via PowerShell (`-NoProfile -Command`), on Unix via `$SHELL -lc`. Shared helper `build_oneshot_command`.
- `shell::shell_session_*`: persistent shell session with state across calls. `shell::shell_bg_*` (`spawn`, `logs`, `kill`, `list`): long-running background processes (dev servers etc.) with bounded ring-buffer log capture.
- `workspace::*`: `workspace_authorize` / `workspace_current_dir` (the spawn cwd authorization registry) plus the WSL bridge (`wsl_list_distros`, `wsl_default_distro`, `wsl_home`).
- `open_settings_window`: separate webview window for Settings (optional `tab` arg deep-links a section).

### PTY shell integration

PTY shells are bootstrapped via injected init scripts in `src-tauri/src/modules/pty/scripts/`:

- **Unix** (`zshenv.zsh`, `zprofile.zsh`, `zlogin.zsh`, `zshrc.zsh`, `bashrc.bash`) for zsh/bash, plus `init.fish` installed to `~/.config/fish/conf.d/terax.fish` for fish. Emit OSC 7 (cwd) and OSC 133 A/B/C/D (prompt boundaries + exit code) so the host can track cwd and detect command boundaries without re-parsing the prompt. Fish 4.0+ writes its own OSC 133 prompt markers; Terax sets `fish_features=no-mark-prompt` and re-asserts its own prompt via `-C` to avoid doubling.
- **Windows** (`profile.ps1`) - passed via `pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <path>`. Wraps the user's existing `prompt` function (after their `$PROFILE` runs) to emit OSC 7 + OSC 133 A/B/D. Shell priority: `pwsh.exe` (PS 7+) → `powershell.exe` (PS 5.1) → `cmd.exe` (no integration). cwd is normalized to backslashes before being passed to ConPTY (`CreateProcessW` misbehaves with forward-slash cwd).

`pty/shell_init.rs` is split into `#[cfg(unix)]` / `#[cfg(windows)]` modules - keep new platform-specific code in the right cfg arm.

ConPTY on Windows requires `SPAWN_LOCK` (Mutex) around `openpty + spawn_command` in `session.rs`. Concurrent spawns leave one of the resulting PTYs with a stalled output pipe. Don't remove the lock without verifying first-tab stability under fast tab spam.

Each ConPTY child is also assigned to a per-session **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`pty/job.rs`). When the Job HANDLE drops - clean shutdown, panic, or even SIGKILL'd Terax process - the kernel kills every descendant of the shell (e.g. `npm run dev` spawned from inside pwsh). Without this Windows orphans the entire process subtree because `TerminateProcess` only kills the immediate child. macOS/Linux rely on `Drop for Session → killer.kill()`; on dev-`Ctrl-C` of `cargo run` destructors don't fire and orphans are possible there too - acceptable for now since dev only.

### Frontend (`src/`)

Single-window React app. Path alias `@/*` → `src/*`. Tabs are a tagged union (`kind`: `terminal` | `editor` | `preview` | `markdown` | `git-diff` | `git-history` | `git-commit-file`) and **not** unmounted on switch - they're hidden via `invisible pointer-events-none` so PTYs and dev servers keep streaming in the background.

`App.tsx` wires modules together - keep it a coordinator. New features go inside the appropriate `modules/<area>/`.

### Module layout (`src/modules/`)

Each module is self-contained, exports a thin barrel via `index.ts`, and owns its hooks under `lib/`.

- **terminal/** - `TerminalStack` keeps one mounted xterm per tab via `useTerminalSession` + `pty-bridge`. `osc-handlers.ts` parses OSC 7 (with Windows drive-letter normalization: `/C:/Users/foo` → `C:/Users/foo`) and OSC 133 markers. The xterm color palette is driven by the central theme engine (`modules/theme`), not a local table. Renderer slots are pooled (`rendererPool.ts`, max 5): a hidden leaf with a foreground job (OSC 133 C..D or `pty_has_foreground_job`) keeps its live grid parked with rendering paused via `display:none`; an idle hidden leaf releases its slot but the buffer is retained and serialized lazily only when another leaf steals it. The `DormantRing` (1 MiB, no terminal reset on overflow) buffers bytes only for leaves whose slot was stolen or never bound. Never serialize a leaf that is mid-command: replaying incremental TUI repaints over a snapshot produces visual artifacts.
- **editor/** - CodeMirror 6 stack (`EditorStack` mirrors `TerminalStack`). `extensions.ts` configures language modes; supports vim mode. Buffers live in LF space and the original EOL (`lib/eol.ts`, majority-vote detection) is restored on save; indent unit/tab size are detected per file (`lib/indent.ts`) via a per-pane compartment. Saves are conflict-checked against the disk mtime returned by `fs_read_file`/`fs_write_file` (mismatch → warning toast with explicit Overwrite, never silent last-writer-wins); external format-on-save only applies the disk read-back if the doc is unchanged since the save snapshot. Files over 10 MB offer "Open anyway" (hard cap 50 MB, `force` arg); above 4 MB syntax highlighting stays off. Cmd-F routes to CodeMirror's own search panel (find/replace/regex) when an editor tab is active, Ctrl-G opens go-to-line; both panels styled in `chromeTheme.ts`. Format-on-save formatters live in `lib/externalFormat.ts` (`FORMATTERS` registry: biome, prettier, ruff, rustfmt, gofmt, clang-format, shfmt, zig fmt, plus a custom `{file}` command template); `resolveFormatter` applies per-language overrides (`editorFormatterByLang`) over the global default, and a global external default only runs on languages its tool understands. Diff panes resolve the language before mounting CodeMirror: a late compartment reconfigure leaves the merge view's deleted-chunk widgets unhighlighted. Markdown editing is GFM (`markdownLanguage` base) with fenced-code highlighting resolved through the shared lazy language registry, Cmd/Ctrl+Click URLs, and clickable task checkboxes (`markdownExtras.ts`, all inside the lazy markdown chunk; the eager-budget test enforces this). Dotenv files (`.env`, `.env.*`, and `*.env`) use the lazy shell grammar. Editor theme is decoupled from the app theme: the `editorTheme` pref is `"auto" | EditorThemeId` (default `"auto"`), resolved at render time by `useEditorThemeExt` via `resolveEditorThemeId`. In `auto` the editor follows the active app theme's `editorTheme[mode]` pairing (live, never stale); an explicit pick overrides. Theme ids + labels live in `settings/store.ts` (`EDITOR_THEMES`/`EDITOR_THEME_LABELS`); the matching extensions in `editor/lib/themes.ts` (`EDITOR_THEME_EXT`). Prebuilt `@uiw` themes plus locally-built ones in `editor/lib/cmThemes.ts` (Kanagawa wave/lotus/dragon, Everforest, Dracula, Solarized, Catppuccin, Rosé Pine) via `createTheme` (no extra deps). The CM surfaces (`EditorPane`, `GitDiffPane`) all read the theme through `useEditorThemeExt`.
  Editor code size is stored separately as `editorFontSize` and does not affect `terminalFontSize`.
- **explorer/** - file tree with Material/Catppuccin icons (`iconResolver.ts`), fuzzy search, keyboard nav, inline rename, context actions. Backslash-aware `basename`.
- **preview/** - auto-detected dev-server preview tab (status-bar pill suggests opening when a localhost URL is detected).
- **tabs/** - `useTabs` is the source of truth for tab list + active id. `useWorkspaceCwd` derives explorer root + inherited cwd for new tabs from active tab. `basename` splits on both `/` and `\`.
- **header/** - top bar + inline search (`SearchInline` adapts to terminal vs editor via `SearchTarget`). `WindowControls` rendered when `USE_CUSTOM_WINDOW_CONTROLS` is true (Linux + Windows; macOS uses native traffic lights).
- **statusbar/** - bottom bar, `CwdBreadcrumb` (handles Unix paths, Windows drive letters, and home `~` segments via `pathUtils.segmentsFromCwd`).
- **shortcuts/** - keymap registry (`shortcuts.ts`) + `useGlobalShortcuts`. Handlers live in `App.tsx` and are passed in by id (`tab.new`, …). `metaKey || ctrlKey` for cross-platform Cmd/Ctrl.
- **settings/** - settings store (`store.ts` via `tauri-plugin-store`), preferences hook, settings window opener.
- **sidebar/** - activity bar + collapsible side panels (explorer, source control, git history).
- **source-control/** - git status / stage / commit panel and diff workflow.
- **git-history/** - commit graph rail, refs, per-commit file diffs.
- **markdown/** - markdown preview renderer (backs the `markdown` tab kind).
- **workspace/** - workspace environment switching (Local + WSL distros).
- **theme/** - custom theme engine (no `next-themes`). `ThemeProvider` + `applyTheme` write CSS variables; built-in presets in `themes/` (terax-default, claude, kanagawa, kanagawa-dragon, tokyo-night, catppuccin, rose-pine, everforest, nord, gruvbox, dracula, solarized, tide, sage, caffeine), each optionally declaring an `editorTheme` pairing consumed by `resolveEditorThemeId` (see editor/). User themes via `customThemes.ts` + `validateTheme.ts`, optional background image via `bgImageStore.ts` + `SurfaceLayer`.
- **updater/** - auto-updater UI built on `tauri-plugin-updater`.
- **command-palette/** - modal command palette (`CommandPalette.tsx`, `commands.ts`) for actions and navigation.
- **spaces/** - workspace spaces/projects (name, root, env, color, per-space tab persistence) via `useSpaces` and `SpaceSwitcher`.

### UI conventions

- **shadcn/ui** is configured (`components.json`, style `radix-luma`, base `mist`, icon lib **hugeicons**). Primitives in `src/components/ui/` - don't hand-edit; re-run `pnpm dlx shadcn add` to upgrade.
- **Tailwind v4** - no `tailwind.config.*`, config is in `src/App.css` via `@theme`. Use `cn()` from `@/lib/utils`.
- Animation: `motion` (Framer Motion successor). Resizable layout: `react-resizable-panels`.
- Path imports: always `@/…`, never relative across modules.
- Cross-platform paths: anywhere a path may originate from OSC 7, the explorer, or the OS, normalize separators with `.split(/[\\/]/)` rather than `.split("/")`.
- Canonical path form on the frontend is **forward-slash**. `homeDir()` returns backslashes on Windows; convert at the boundary (App.tsx setHome). OSC 7 already arrives as forward-slash. Equal canonical strings keep `useFileTree` from wiping its tree and flashing the explorer when `tab.cwd` first arrives.

### Window styling

- macOS: `titleBarStyle: Overlay` + `hiddenTitle: true` in `tauri.conf.json` (native traffic lights via overlay).
- Linux: `decorations: false` + `transparent: true` from `tauri.linux.conf.json`; re-asserted post-realize for GNOME/Mutter CSD.
- Windows: same as Linux via `tauri.windows.conf.json`. React renders custom `WindowControls`.

### Tauri capabilities

`src-tauri/capabilities/default.json` is the allowlist for plugin APIs available to the webview. New plugins (dialog, autostart, updater, window-state, store, opener, os, log are wired in `lib.rs`) typically need:

1. `Cargo.toml` dependency
2. `.plugin(...)` call in `lib.rs` `run()`
3. capability entry in `default.json`

### Cross-platform conventions

- HOME / cache dirs: use the `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`), never raw `$HOME` / `%USERPROFILE%`.
- Shell init scripts: gate Unix-only logic behind `#[cfg(unix)]`; Windows arm in `pty::shell_init::windows`.
- Terminal input: send `\r` (CR) for Enter, not `\n` (LF) - PowerShell on Windows requires CR.

### Bundle config

- `bundle.targets: "all"` plus per-platform sections in `tauri.conf.json`:
  - **macOS**: `minimumSystemVersion: 10.15`.
  - **Linux**: deb depends `libwebkit2gtk-4.1-0`, `libgtk-3-0`; rpm `webkit2gtk4.1`, `gtk3`; AppImage bundles its media framework.
  - **Windows**: NSIS installer in `currentUser` mode (no admin required), WebView2 via `embedBootstrapper` (offline install).
- Auto-updater configured with a public minisign key; release artifacts at `https://github.com/kevsmir02/terax-ai/releases/latest/download/latest.json`.

### Known gotchas

- **React 19 strict mode** double-mounts `useEffect` in dev → terminals spawn twice on first render. The first PTY is cleaned up almost immediately. The `SPAWN_LOCK` mutex serializes this; don't be alarmed by `pty opened id=1` followed by `pty closed id=1` in dev logs.
- **Windows PowerShell process lifecycle**: `killer.kill()` from `portable-pty` only kills the immediate child. Descendants (e.g. `npm run dev` started inside pwsh) survive unless something else takes them down. The Job Object in `pty/job.rs` handles this for the Terax-process-death case; an explicit `pty_close` from JS also kills only the immediate child + relies on the Job to take the rest. Don't disable the Job without a replacement.
- **Tab `cwd` storage**: comes from OSC 7 with forward slashes (after `parseOsc7` strips `/C:` → `C:`). Anything that consumes `tab.cwd` and passes it to a Rust fs command on Windows must normalize separators or accept both forms - `apply_common` in `pty::shell_init` handles this for PTY spawn; other call sites must do their own.

## Further reading

Long-form contributor guides live under `docs/`. These guides elaborate on `TERAX.md`; if anything conflicts, `TERAX.md` wins.

- `docs/README.md` - index of contributor guides
- `docs/architecture/two-process-model.md` - IPC boundary and command reference
- `docs/architecture/pty-shell-integration.md` - PTY, shell init scripts, OSC, ConPTY, Job Object
- `docs/architecture/terminal-renderer-pool.md` - renderer pool and DormantRing invariants
- `docs/contributing/testing.md` - testing contract and core-subsystem invariants
- `docs/release.md` - how to cut a release, trigger the workflow, and how the changelog is generated
