# TUI Compatibility Regression Harness - Design

Status: Approved (2026-07-21)
Roadmap item: "TUI compatibility regression harness" (Coming next, #1)
Supersedes: none. Elaborates `PUHON.md`; if anything conflicts, `PUHON.md` wins.

## Problem

Terminal rendering fidelity is Puhon's make-or-break surface. Agent CLIs and
heavy full-screen TUIs (vim, lazygit, htop) are demanding TUIs, and the byte
path that renders them is split across two processes with several hand-tuned,
invariant-heavy pieces:

- Rust: `session.rs` flusher (coalescing, overflow discard), `da_filter.rs`
  (DA1/DA2/DSR/CPR reply synthesis), shell-init scripts.
- TS: `osc-handlers.ts` (OSC 7 cwd, OSC 133 prompt markers),
  `rendererPool.ts` (slot lifecycle, never-serialize-mid-command),
  `dormantRing.ts` (resume-at-line-boundary, drop-oldest), xterm.js parsing.

Today there is zero integration coverage of the byte-to-grid path. Existing
tests are unit tests on pure functions (`dormantRing.test.ts`,
`osc-handlers.test.ts`, `panes.test.ts`, plus Rust unit tests). The
renderer-pool invariants, OSC parse correctness against real escape streams,
and end-to-end grid fidelity are verified only manually. Regressions (the kind
that "used to wipe Claude Code") ship undetected.

## Goal

Drive recorded TUI byte streams through Puhon's real TS layer into xterm.js's
real parser, snapshot the rendered grid, and golden-compare, so that
regressions in OSC handling, the renderer pool, DormantRing, and grid
fidelity fail CI automatically instead of waiting for a manual repro.

## Scope

### In scope (v1)

- OSC handling at the TS parse layer: OSC 7 (cwd, including Windows
  drive-letter normalization `/C:/...`), OSC 133 (A/B/C/D prompt markers),
  and tolerance of DA1/DA2/DSR/CPR query sequences present in the stream.
- Renderer-pool invariant `never-serialize-mid-command`, via the
  `isLeafBusy` predicate, plus targeted unit tests for parking-vs-releasing
  and eviction ordering.
- DormantRing: resume-at-line-boundary under chunked replay, drop-oldest on
  overflow.
- Grid fidelity: alt-screen enter/exit, truecolor SGR, wide chars
  (CJK/emoji/combining), cursor positioning, scrollback.
- Golden-file regression flow inside the existing `pnpm test` / CI frontend
  job.

### Out of scope (v1)

- Live PTY driving inside CI (no `node-pty` in the test path, no `ffmpeg`).
  Determinism comes from recorded, committed cassettes.
- Windows ConPTY testing. Releases are Linux-only; the ROADMAP defers the
  Windows release pipeline. ConPTY-specific behavior stays behind
  `#[cfg(windows)]` for when Windows CI exists.
- The Rust byte path (flusher coalescing, overflow, `DaFilter`). Already
  unit-tested; the user scoped v1 to the TS layer. Cassettes can be fed
  through the Rust transforms later as a follow-up.
- Real agent-CLI snapshots (Codex, Claude Code). They need keys/network and
  are non-deterministic. Synthetic + vim/lazygit cassettes exercise the same
  escape sequences deterministically.

## Architecture

A Vitest harness replays asciicast-v2 cassettes through Puhon's real TS
modules into a headless xterm.js terminal, serializes the rendered grid, and
golden-compares it. No browser, no DOM, no WebGL, no native dependencies in
the test path.

### Why asciicast v2

The cassette is a `.cast` file: a JSON header
(`{"version":2,"width":80,"height":24,"title":...}`) followed by
newline-delimited events `[time, "o", <base64 data>]`. It is portable,
human-inspectable, and the format asciinema/ptywright already use. The
harness ignores recorded inter-event timing for golden comparison because
timing is not what matters; chunk-split points are a replay parameter, not
stored data. This keeps cassettes simple and the replay deterministic.

### Why @xterm/headless

`@xterm/headless` is xterm.js's real VT parser and buffer running in Node,
sharing the same core as the DOM build. Feeding it the same bytes the DOM
xterm receives produces the same grid, so a snapshot in a test is the same
state Puhon renders. It supports `addon-serialize` and the
`buffer.active.getLine(y).getCell(x)` cell API. This is the linchpin: the
harness tests Puhon's actual rendering contract, not a toy parser.

For the style-sensitive cassettes (truecolor SGR blocks, wide chars), the
harness loads `@xterm/addon-serialize` onto the headless Terminal and uses
`SerializeAddon.serialize()` to capture full per-cell style state (fg/bg
color, bold/italic/underline, modes, cursor) in addition to the text grid.
This gives exact-fidelity snapshots where whitespace and color matter, while
the default readable text golden stays the primary format for everything
else.

### Determinism contract

The harness is hermetic: no network, no real time, no randomness, no
background timers. Headless xterm is deterministic given fixed bytes and
fixed geometry. Vim and lazygit cassettes are recorded once and committed, so
their byte content is frozen and replay is reproducible. A cassette that
captures live wall-clock or CPU values (htop) is a bug in cassette selection,
not a harness failure, which is why htop is not a golden target.

## Components

All harness code lives under `src/modules/terminal/__tui_compat__/`. Each
component is a pure, dependency-light function (functional core) so it is
testable without a later rewrite, per the quality bar.

### cassettePlayer.ts

Loads a `.cast`, decodes the base64 output events, and returns:

```ts
type Cassette = {
  bytes: Uint8Array;     // concatenation of all "o" events, base64-decoded
  cols: number;
  rows: number;
  title: string;
  expectedEvents?: ParsedEvent[]; // optional: cwd/markers the cassette asserts
};
```

Pure. No I/O side effects beyond reading the file passed in.

**Default geometry.** Asciicast v2 headers are not required to declare size,
and some real captures omit it. `cassettePlayer` enforces a standard default
terminal geometry of **80 columns x 24 rows** whenever the `.cast` header
does not define `width`/`height`. A cassette with an explicit header size
always wins. This guarantees every replay runs against a known, finite grid
and a missing header never produces an undefined-geometry Terminal.

### gridSnapshot.ts

Given a `@xterm/headless` `Terminal`, produce a deterministic string golden.
Two modes:

- **Text (default).** The active buffer viewport rendered as one text row
  per line (concatenation of `cell.getChars()` for cells with width > 0),
  prefixed by a small header block of structural facts:

  ```
  # title: vim-insert
  # cursor: [12, 3]
  # alt: true
  # modes: { applicationCursor: false }
  row0text
  row1text
  ...
  ```

  Readable diffs; trailing whitespace is not part of the text golden by
  default.

- **Strict cell-grid (opt-in).** For style-sensitive cassettes, a
  fixed-width dump (one entry per cell, `cols` wide) plus the
  `SerializeAddon.serialize()` output, capturing exact color and attribute
  state. Used for `truecolor-sgr` and `wide-chars`.

The output is stable: cursor coordinates zero-indexed, header keys sorted,
rows ordered top to bottom.

### harness.ts

Wires one cassette run end to end. Steps:

1. `cassettePlayer` -> `{ bytes, cols, rows, ... }` (geometry defaulted to
   80x24 if absent).
2. Create a `@xterm/headless` `Terminal` at `{ cols, rows }`, load
   `SerializeAddon` (lazily, only used by strict cassettes).
3. Register Puhon's real `osc-handlers` parse functions on the Terminal's
   parser so captured events flow through production code, not a copy.
4. `await term.write(bytes)` (awaited via the write callback so the golden
   is captured after the full parse settles).
5. If the cassette declares a DormantRing chunk test, replay `bytes`
   through a real `DormantRing` instance at chunk sizes `{ 1, 16, 64, 4096 }`
   and assert each final grid equals the full-write grid. This proves
   resume-at-line-boundary: a mid-CSI split must not corrupt state.
6. Return the `gridSnapshot` plus the captured parsed events.

### tui-compat.test.ts

The Vitest entry. Iterates every `.cast` under `cassettes/`, runs `harness`
for each, and compares the snapshot to the matching file under `golden/`
(same basename, `.golden` extension). On mismatch, fails with a unified diff
and prints the regen command (`HARNESS_UPDATE=1 pnpm test`). The iteration is
data-driven so adding a cassette requires no new test code.

### rendererPool predicate (the one refactor)

Export the `isLeafBusy` predicate from `rendererPool.ts` as a pure function.
This is the guard behind "never serialize mid-command": a leaf is busy when
`commandRunning`, `isAgentActivePty`, or alt-screen is true, and a busy leaf
must never be serialized or evicted. Cover it with unit tests for each busy
condition and the idle case. No other renderer-pool refactor is in scope; the
integrated hide/show/steal exercise is a documented future extension.

## Data flow

```
.cast ──► cassettePlayer ──► { bytes, cols, rows } ──┬──► headless Terminal.write
                                                     │        │
                                                     │        ├──► osc-handlers (real)
                                                     │        │      └── captured cwd/markers ──► assert vs expectedEvents
                                                     │        └──► gridSnapshot ──► compare .golden
                                                     │
                                                     └──► DormantRing @ {1,16,64,4096} ──► final grid == full-write grid
```

## v1 cassette set

1. `osc7-cwd.cast` - OSC 7 for several paths including the Windows
   drive-letter form `/C:/Users/foo`. Asserts cwd parsed correctly.
2. `osc133-prompt.cast` - A/B/C/D prompt markers. Asserts block boundaries.
3. `altscreen-vim.cast` - real vim (open a fixed fixture file, enter insert,
   type known text, `:wq`). Asserts alt-screen enter/exit and the final grid.
4. `truecolor-sgr.cast` - synthetic truecolor gradient. Strict cell-grid
   golden + `serialize()`.
5. `wide-chars.cast` - emoji + CJK double-width + combining marks. Asserts no
   misalignment. Strict golden.
6. `cursor-positioning.cast` - CSI cup/cub/cuf exercises plus a DSR query
   mid-stream. Asserts final cursor and that the query does not corrupt the
   grid.
7. `da1-dsr.cast` - DA1/DA2/DSR query sequences present in the stream.
   Asserts the queries do not corrupt rendering. (Rust reply synthesis is
   out of scope and already unit-tested.)

Cassettes 3, 4, and 5 double as the DormantRing chunk-split corpus because
they carry multi-byte escape sequences.

## Golden workflow and CI

- Goldens live beside cassettes under `src/modules/terminal/__tui_compat__/`.
- Regen: `HARNESS_UPDATE=1 pnpm test` (env-gated; CI never sets it). The flag
  rewrites every `.golden` and prints which changed.
- CI: runs in the existing `frontend` job via `pnpm test`. No new job, no
  native dependencies. A mismatch fails the build; a golden change requires a
  deliberate commit, so reviewers see the diff.
- Cassette size guard: each cassette capped (256 KiB) to keep the repo and CI
  fast. A cassette over the cap fails the harness with an explicit error
  rather than silently bloating the repo.

## Recording tool (out of CI)

`scripts/record-cassette.mjs` uses `node-pty` to spawn and drive a program
and emit a `.cast`. `node-pty` is a **devDependency only**: it never runs in
CI's test path and is never bundled into the app. Recording is a manual,
human-reviewed step that produces the committed cassettes. This keeps the
"no native dependencies in CI" promise while still allowing real-program
captures.

## Error handling and determinism

- Hermetic by construction: no network, no real time, no randomness.
- The only flakiness source would be a non-deterministic cassette; mitigated
  by recording once and committing, and by forbidding live-clock/CPU targets.
- Chunk replay asserts exact grid equality at four chunk sizes, so a
  DormantRing boundary regression is caught, not hidden by averaging.
- Missing cassette header geometry falls back to 80x24 (see `cassettePlayer`
  above), so an undefined-geometry Terminal can never occur.

## Testing the harness itself

- A hand-written synthetic cassette with a hand-written expected golden locks
  the serializer and driver contract, so a future `gridSnapshot` or
  `cassettePlayer` change cannot silently rewrite every golden without
  failing this anchor test.
- The `isLeafBusy` predicate gets its own unit tests in the existing
  renderer-pool-adjacent test file.
- `cassettePlayer`'s default-geometry fallback is covered by a test that
  feeds a header-less `.cast` and asserts `cols === 80 && rows === 24`.

## File layout

```
src/modules/terminal/__tui_compat__/
  tui-compat.test.ts            # Vitest entry; iterates cassettes (data-driven)
  lib/
    cassettePlayer.ts           # .cast -> { bytes, cols, rows, ... } (pure)
    gridSnapshot.ts             # headless Terminal -> golden text (pure)
    harness.ts                  # wires osc-handlers + DormantRing + headless
  cassettes/
    osc7-cwd.cast
    osc133-prompt.cast
    altscreen-vim.cast
    truecolor-sgr.cast
    wide-chars.cast
    cursor-positioning.cast
    da1-dsr.cast
  golden/
    osc7-cwd.golden
    osc133-prompt.golden
    altscreen-vim.golden
    truecolor-sgr.golden
    wide-chars.golden
    cursor-positioning.golden
    da1-dsr.golden
src/modules/terminal/lib/
  rendererPool.ts               # export isLeafBusy (no other change)
scripts/
  record-cassette.mjs           # dev-only recorder (node-pty devDep)
```

## Dependencies

- `@xterm/headless` - devDependency; the headless terminal in tests.
- `@xterm/addon-serialize` - already a runtime dependency; reused on the
  headless Terminal for strict cell-grid snapshots.
- `node-pty` - devDependency only; powers the out-of-CI recorder.

No runtime (app) dependencies change. No new CI job.

## Future extensions (explicitly out of v1)

- Integrated renderer-pool lifecycle exercise (Approach 2): extract pool
  decisions behind an interface so the harness can drive bind/park/steal/
  evict against headless instances. Only if a real regression escapes v1.
- Rust byte-path harness: feed the same cassettes through the real
  `DaFilter` + flusher + overflow logic in `cargo nextest` and assert the
  transformed stream against golden.
- Windows ConPTY leg, behind `#[cfg(windows)]`, when the Windows release
  pipeline exists.
- Real agent-CLI cassettes recorded against a fixture workspace, if a
  deterministic enough capture can be produced.
