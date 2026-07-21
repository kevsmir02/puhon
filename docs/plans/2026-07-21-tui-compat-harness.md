# TUI Compatibility Regression Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deterministic, cassette-replay regression harness that feeds recorded TUI byte streams through Puhon's real TS layer into xterm.js's real parser, snapshots the rendered grid, and golden-compares, so OSC / renderer-pool / DormantRing / grid-fidelity regressions fail CI automatically.

**Architecture:** A Vitest harness under `src/modules/terminal/__tui_compat__/` replays asciicast-v2 `.cast` cassettes through Puhon's real `osc-handlers` + `DormantRing` into `@xterm/headless` (xterm.js's real VT parser running in Node), serializes the grid, and golden-compares. No native deps in CI; the optional recorder lives in an isolated sub-package.

**Tech Stack:** Vitest, `@xterm/headless@^6.0.0`, `@xterm/addon-serialize` (already a runtime dep), `node-pty@^1.1.0` (recorder sub-package only).

## Global Constraints

- Puhon conventions: **no em-dash, no emojis** anywhere. Frontend imports always `@/...` across modules, relative within a module. **pnpm only**.
- Biome: double quotes, semicolons, trailing commas, 2-space indent, lineWidth 80. Organize-imports groups: `[:NODE:, [@/**], :PACKAGE:, :ALIAS:, :PATH:]`.
- TS strict + `noUnusedLocals`/`noUnusedParameters` must pass `pnpm check-types`.
- Verify after each task: `pnpm check-types` and `pnpm test` for the affected scope; full `pnpm lint && pnpm check-types && pnpm test` before the final commit.
- The harness runs in the existing `frontend` CI job via `pnpm test` with **no CI workflow changes** and **no native builds** on the root install.

## Spec deviations (resolved during planning)

1. **asciicast data is raw UTF-8, not base64.** The spec said "base64 output events"; standard asciicast v2 `"o"` events carry raw UTF-8 strings (JSON-escaped). `cassettePlayer` decodes them with `TextEncoder`. No base64 anywhere.
2. **`isLeafBusy` is an adapter method, not a pool function.** It is declared on the `SlotAdapter` interface and implemented in the React layer (`TerminalStack`), so it cannot be unit-tested without DOM. The pool's pure, testable kernel of the "never-serialize-mid-command" invariant is the `evictionScore()` function, which already combines `isLeafBusy` + `isAltScreen` into an eviction ranking. Task 6 extracts that ranking into a pure `leafEvictionScore()` and tests it. No unused predicate is added (knip-clean).

## File Structure

```
src/modules/terminal/__tui_compat__/
  tui-compat.test.ts            # data-driven golden loop + HARNESS_UPDATE
  lib/
    cassettePlayer.ts           # .cast string -> { bytes, cols, rows, title, meta } (pure)
    cassettePlayer.test.ts
    gridSnapshot.ts             # headless Terminal -> deterministic golden text (pure)
    gridSnapshot.test.ts
    harness.ts                  # wires osc-handlers + DormantRing + headless; runs one cassette
    harness.test.ts
  cassettes/
    anchor.cast                 # locks harness contract (hand-written golden assertion)
    osc7-cwd.cast
    osc133-prompt.cast
    altscreen-tui.cast          # synthetic alt-screen enter/paint/exit (renderer path)
    truecolor-sgr.cast          # strict (serialize) golden
    wide-chars.cast             # strict (serialize) golden
    cursor-positioning.cast
    da1-dsr.cast
    altscreen-vim.cast          # recorded via the isolated recorder (Task 7)
  golden/
    *.golden                    # one per cassette, seeded via HARNESS_UPDATE=1
src/modules/terminal/lib/
  rendererPoolDecisions.ts      # NEW: pure leafEvictionScore (no heavy imports)
  rendererPoolDecisions.test.ts
  rendererPool.ts               # MODIFIED: evictionScore delegates to leafEvictionScore
scripts/recorder/
  package.json                  # isolated: { node-pty } (never installed by root CI)
  record.mjs                    # spawn a program, drive keystrokes, emit asciicast v2
docs/contributing/testing.md    # MODIFIED: add a "TUI compatibility harness" section
```

---

## Task 1: cassettePlayer.ts (pure)

**Files:**

- Create: `src/modules/terminal/__tui_compat__/lib/cassettePlayer.ts`
- Test: `src/modules/terminal/__tui_compat__/lib/cassettePlayer.test.ts`

**Interfaces:**

- Produces: `parseCassette(contents: string): Cassette` where

  ```ts
  type CassetteMeta = { strict?: boolean; expectCwd?: string; chunkTest?: boolean };
  type Cassette = { bytes: Uint8Array; cols: number; rows: number; title: string; meta: CassetteMeta };
  ```

  and exports `DEFAULT_COLS = 80`, `DEFAULT_ROWS = 24`, `MAX_CASSETTE_BYTES = 256 * 1024`.

- [ ] **Step 1: Write the failing test**

```ts
// cassettePlayer.test.ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_CASSETTE_BYTES,
  parseCassette,
} from "./cassettePlayer";

const enc = new TextEncoder();

function cast(body: string): string {
  return `{"version":2,"width":80,"height":24,"title":"x"}\n${body}\n`;
}

describe("parseCassette", () => {
  it("concatenates output events into bytes", () => {
    const c = parseCassette(cast('[0,"o","hel"]\n[0.1,"o","lo"]'));
    expect(c.bytes).toEqual(enc.encode("hello"));
    expect(c.title).toBe("x");
    expect(c.cols).toBe(80);
    expect(c.rows).toBe(24);
  });

  it("uses 80x24 when the header omits geometry", () => {
    const c = parseCassette('{"version":2,"title":"no-geo"}\n[0,"o","hi"]');
    expect(c.cols).toBe(DEFAULT_COLS);
    expect(c.rows).toBe(DEFAULT_ROWS);
  });

  it("reads puhon metadata from the header", () => {
    const c = parseCassette(
      '{"version":2,"width":40,"height":3,"title":"osc7","puhon":{"expectCwd":"/x","chunkTest":true}}\n[0,"o",""]',
    );
    expect(c.meta.expectCwd).toBe("/x");
    expect(c.meta.chunkTest).toBe(true);
    expect(c.meta.strict).toBeFalsy();
  });

  it("ignores non-output events", () => {
    const c = parseCassette(cast('[0,"i","keys"]\n[0,"o","ok"]'));
    expect(c.bytes).toEqual(enc.encode("ok"));
  });

  it("rejects cassettes over the size cap", () => {
    const big = "x".repeat(MAX_CASSETTE_BYTES + 1);
    const body = JSON.stringify([0, "o", big]);
    expect(() => parseCassette(cast(body))).toThrow(/exceeds/);
  });

  it("throws on an empty cassette", () => {
    expect(() => parseCassette("")).toThrow(/empty/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/modules/terminal/__tui_compat__/lib/cassettePlayer.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// cassettePlayer.ts
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const MAX_CASSETTE_BYTES = 256 * 1024;

export type CassetteMeta = {
  strict?: boolean;
  expectCwd?: string;
  chunkTest?: boolean;
};

export type Cassette = {
  bytes: Uint8Array;
  cols: number;
  rows: number;
  title: string;
  meta: CassetteMeta;
};

type CastHeader = {
  version?: number;
  width?: number;
  height?: number;
  title?: string;
  puhon?: CassetteMeta;
};

type CastEvent = [number, string, string];

export function parseCassette(contents: string): Cassette {
  const lines = contents.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("cassette is empty");

  const header = JSON.parse(lines[0]) as CastHeader;
  const enc = new TextEncoder();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let i = 1; i < lines.length; i++) {
    const ev = JSON.parse(lines[i]) as CastEvent;
    if (!Array.isArray(ev) || ev[1] !== "o") continue;
    const bytes = enc.encode(ev[2]);
    total += bytes.byteLength;
    if (total > MAX_CASSETTE_BYTES) {
      throw new Error(`cassette exceeds ${MAX_CASSETTE_BYTES} bytes`);
    }
    chunks.push(bytes);
  }

  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }

  return {
    bytes: merged,
    cols: header.width ?? DEFAULT_COLS,
    rows: header.height ?? DEFAULT_ROWS,
    title: header.title ?? "untitled",
    meta: header.puhon ?? {},
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/modules/terminal/__tui_compat__/lib/cassettePlayer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/terminal/__tui_compat__/lib/cassettePlayer.ts \
        src/modules/terminal/__tui_compat__/lib/cassettePlayer.test.ts
git commit -m "feat(tui-compat): add cassettePlayer (asciicast v2 -> bytes, 80x24 default)"
```

---

## Task 2: gridSnapshot.ts (pure) + @xterm/headless devDep

**Files:**

- Modify: `package.json` (add devDep `@xterm/headless@^6.0.0`)
- Create: `src/modules/terminal/__tui_compat__/lib/gridSnapshot.ts`
- Test: `src/modules/terminal/__tui_compat__/lib/gridSnapshot.test.ts`

**Interfaces:**

- Consumes: `Terminal` from `@xterm/headless`.
- Produces: `snapshotGrid(term: Terminal, title?: string): string`. Format:

  ```
  # title: <title>
  # cursor: [<cursorY>, <cursorX>]
  # alt: <true|false>
  <row0 rtrimmed>
  <row1 rtrimmed>
  ...
  ```

- [ ] **Step 1: Add the dev dependency**

```bash
pnpm add -D @xterm/headless@^6.0.0
```

- [ ] **Step 2: Write the failing test**

```ts
// gridSnapshot.test.ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { snapshotGrid } from "./gridSnapshot";

async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((r) => term.write(data, () => r()));
}

describe("snapshotGrid", () => {
  it("dumps the viewport with a header and rtrimmed rows", async () => {
    const term = new Terminal({ cols: 5, rows: 2, allowProposedApi: true });
    await write(term, "AB\r\nCD");
    expect(snapshotGrid(term, "test")).toBe(
      ["# title: test", "# cursor: [1, 2]", "# alt: false", "AB", "CD", ""].join(
        "\n",
      ),
    );
    term.dispose();
  });

  it("reports alt-screen active", async () => {
    const term = new Terminal({ cols: 5, rows: 2, allowProposedApi: true });
    await write(term, "\u001b[?1049h");
    expect(snapshotGrid(term).split("\n")[2]).toBe("# alt: true");
    term.dispose();
  });

  it("defaults the title to untitled", async () => {
    const term = new Terminal({ cols: 2, rows: 1, allowProposedApi: true });
    expect(snapshotGrid(term).startsWith("# title: untitled")).toBe(true);
    term.dispose();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- src/modules/terminal/__tui_compat__/lib/gridSnapshot.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Write minimal implementation**

```ts
// gridSnapshot.ts
import type { Terminal } from "@xterm/headless";

export function snapshotGrid(term: Terminal, title = "untitled"): string {
  const active = term.buffer.active;
  const { cols, rows } = term;
  const out: string[] = [
    `# title: ${title}`,
    `# cursor: [${active.cursorY}, ${active.cursorX}]`,
    `# alt: ${active.type === "alternate"}`,
  ];
  for (let y = 0; y < rows; y++) {
    const line = active.getLine(y);
    let row = "";
    if (line) {
      for (let x = 0; x < cols; x++) {
        const cell = line.getCell(x);
        if (!cell) break;
        if (cell.getWidth() > 0) row += cell.getChars();
      }
    }
    out.push(row.replace(/\s+$/, ""));
  }
  return `${out.join("\n")}\n`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- src/modules/terminal/__tui_compat__/lib/gridSnapshot.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml \
        src/modules/terminal/__tui_compat__/lib/gridSnapshot.ts \
        src/modules/terminal/__tui_compat__/lib/gridSnapshot.test.ts
git commit -m "feat(tui-compat): add gridSnapshot + @xterm/headless devDep"
```

---

## Task 3: harness.ts (wires real osc-handlers + DormantRing + headless)

**Files:**

- Create: `src/modules/terminal/__tui_compat__/lib/harness.ts`
- Test: `src/modules/terminal/__tui_compat__/lib/harness.test.ts`

**Interfaces:**

- Consumes: `parseCassette` (Task 1), `snapshotGrid` (Task 2), Puhon's real `registerCwdHandler`/`registerPromptTracker`/`createShellIntegrationState` from `@/modules/terminal/lib/osc-handlers`, `DormantRing` from `@/modules/terminal/lib/dormantRing`.
- Produces:

  ```ts
  type HarnessResult = { text: string; serialize: string | null; cwd: string[] };
  async function runCassette(cassette: Cassette): Promise<HarnessResult>
  async function runChunkInvariance(cassette: Cassette): Promise<Record<number, string>>
  ```

Note: `registerCwdHandler`/`registerPromptTracker` are typed for `@xterm/xterm`'s `Terminal`, but only use `parser.registerOscHandler` + `registerMarker`, which `@xterm/headless` also implements. Cast through `unknown` to satisfy the signature. The test file mocks `@/lib/platform` (same as `osc-handlers.test.ts`) so `osc-handlers` imports cleanly in Node.

- [ ] **Step 1: Write the failing test**

```ts
// harness.test.ts
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));

import { Terminal } from "@xterm/headless";
import { runCassette, runChunkInvariance } from "./harness";
import { parseCassette } from "./cassettePlayer";
import { snapshotGrid } from "./gridSnapshot";

const OSC7 = // /C:/ form normalizes unconditionally to C:/
  '{"version":2,"width":40,"height":3,"title":"osc7","puhon":{"expectCwd":"C:/Users/leo/project","chunkTest":true}}\n' +
  '[0,"o","\\u001b]7;file:///C:/Users/leo/project\\u0007"]';

describe("runCassette", () => {
  it("replays bytes through the real osc-handlers and reports cwd", async () => {
    const res = await runCassette(parseCassette(OSC7));
    expect(res.cwd).toContain("C:/Users/leo/project");
    expect(res.serialize).toBeNull(); // not strict
    expect(res.text.startsWith("# title: osc7")).toBe(true);
  });

  it("produces strict serialize output when meta.strict is set", async () => {
    const cast = parseCassette(
      '{"version":2,"width":5,"height":1,"title":"s","puhon":{"strict":true}}\n[0,"o","hi"]',
    );
    const res = await runCassette(cast);
    expect(res.serialize).toContain("hi");
  });
});

describe("runChunkInvariance", () => {
  it("yields the same grid as a full write at every chunk size", async () => {
    const cassette = parseCassette(OSC7);
    const refs = await runChunkInvariance(cassette);
    // Reference: a single full write.
    const term = new Terminal({
      cols: cassette.cols,
      rows: cassette.rows,
      allowProposedApi: true,
    });
    await new Promise<void>((r) => term.write(cassette.bytes, () => r()));
    const reference = snapshotGrid(term, cassette.title);
    term.dispose();
    for (const size of [1, 16, 64, 4096]) {
      expect(refs[size]).toBe(reference);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/modules/terminal/__tui_compat__/lib/harness.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// harness.ts
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import {
  createShellIntegrationState,
  registerCwdHandler,
  registerPromptTracker,
} from "@/modules/terminal/lib/osc-handlers";
import { DormantRing } from "@/modules/terminal/lib/dormantRing";
import { snapshotGrid } from "./gridSnapshot";
import type { Cassette } from "./cassettePlayer";

export type HarnessResult = {
  text: string;
  serialize: string | null;
  cwd: string[];
};

function writeAll(term: Terminal, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(bytes, () => resolve()));
}

export async function runCassette(cassette: Cassette): Promise<HarnessResult> {
  const term = new Terminal({
    cols: cassette.cols,
    rows: cassette.rows,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  term.loadAddon(serializeAddon);

  const state = createShellIntegrationState();
  const cwd: string[] = [];
  const disposeCwd = registerCwdHandler(
    term as unknown as XtermTerminal,
    (c) => cwd.push(c),
    state,
  );
  const tracker = registerPromptTracker(
    term as unknown as XtermTerminal,
    state,
  );

  try {
    await writeAll(term, cassette.bytes);
    return {
      text: snapshotGrid(term, cassette.title),
      serialize: cassette.meta.strict ? serializeAddon.serialize() : null,
      cwd,
    };
  } finally {
    disposeCwd();
    tracker.dispose();
    term.dispose();
  }
}

export async function runChunkInvariance(
  cassette: Cassette,
): Promise<Record<number, string>> {
  const sizes = [1, 16, 64, 4096];
  const out: Record<number, string> = {};
  // Cap above total so no overflow occurs; chunk-invariance is the property
  // under test here (overflow resync is covered by dormantRing.test.ts).
  const cap = Math.max(1024, cassette.bytes.byteLength + 16);
  for (const size of sizes) {
    const term = new Terminal({
      cols: cassette.cols,
      rows: cassette.rows,
      allowProposedApi: true,
    });
    const ring = new DormantRing(cap, 1024);
    for (let i = 0; i < cassette.bytes.byteLength; i += size) {
      ring.push(cassette.bytes.subarray(i, i + size));
    }
    const drained: Uint8Array[] = [];
    ring.drain((b) => drained.push(b));
    const total = drained.reduce((s, b) => s + b.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const b of drained) {
      merged.set(b, off);
      off += b.byteLength;
    }
    await writeAll(term, merged);
    out[size] = snapshotGrid(term, cassette.title);
    term.dispose();
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/modules/terminal/__tui_compat__/lib/harness.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/terminal/__tui_compat__/lib/harness.ts \
        src/modules/terminal/__tui_compat__/lib/harness.test.ts
git commit -m "feat(tui-compat): add harness wiring real osc-handlers + DormantRing + headless"
```

---

## Task 4: tui-compat.test.ts data-driven golden loop + anchor cassette

**Files:**

- Create: `src/modules/terminal/__tui_compat__/tui-compat.test.ts`
- Create: `src/modules/terminal/__tui_compat__/cassettes/anchor.cast`
- Create: `src/modules/terminal/__tui_compat__/golden/anchor.golden` (seeded via HARNESS_UPDATE)

**Interfaces:**

- Consumes: `parseCassette`, `runCassette`, `runChunkInvariance`.
- Uses `import.meta.glob` to discover `cassettes/*.cast` and `golden/*.golden` as raw strings.

The anchor cassette locks the harness contract against a hand-verified expectation. Its golden is seeded with `HARNESS_UPDATE=1` and then **eyeballed** before commit.

- [ ] **Step 1: Create the anchor cassette**

```
// cassettes/anchor.cast
{"version":2,"width":10,"height":3,"title":"anchor","puhon":{"chunkTest":true}}
[0,"o","HELLO\r\n"]
[0.1,"o","WORLD\r\n"]
```

- [ ] **Step 2: Write the data-driven test**

```ts
// tui-compat.test.ts
// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));

import { parseCassette } from "./lib/cassettePlayer";
import { runCassette, runChunkInvariance } from "./lib/harness";

const cassettes = import.meta.glob("./cassettes/*.cast", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const goldens = import.meta.glob("./golden/*.golden", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const here = path.dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.HARNESS_UPDATE === "1";

function composeGolden(text: string, serialize: string | null): string {
  return serialize ? `${text}---serialize---\n${serialize}\n` : `${text}`;
}

describe("tui-compat golden", () => {
  for (const [file, castContents] of Object.entries(cassettes)) {
    const stem = basename(file).replace(/\.cast$/, "");
    it(stem, async () => {
      const cassette = parseCassette(castContents);
      const { text, serialize, cwd } = await runCassette(cassette);
      const actual = composeGolden(text, serialize);

      const goldenPath = path.join(here, "golden", `${stem}.golden`);
      const existing = goldens[`./golden/${stem}.golden`];

      // UPDATE rewrites every golden without comparing (intentional regen).
      if (UPDATE) {
        mkdirSync(path.join(here, "golden"), { recursive: true });
        writeFileSync(goldenPath, actual);
        return;
      }
      // First-time seed: create the golden and pass.
      if (!existing) {
        mkdirSync(path.join(here, "golden"), { recursive: true });
        writeFileSync(goldenPath, actual);
        return;
      }
      expect(actual).toBe(existing);

      if (cassette.meta.expectCwd) {
        expect(cwd).toContain(cassette.meta.expectCwd);
      }
      if (cassette.meta.chunkTest) {
        const refs = await runChunkInvariance(cassette);
        for (const size of Object.keys(refs)) {
          expect(refs[Number(size)]).toBe(text);
        }
      }
    });
  }
});
```

- [ ] **Step 3: Seed the anchor golden**

Run: `HARNESS_UPDATE=1 pnpm test -- src/modules/terminal/__tui_compat__/tui-compat.test.ts`
Expected: PASS (1 test, creates `golden/anchor.golden`).

- [ ] **Step 4: Eyeball the seeded golden**

Open `golden/anchor.golden`. It must read:

```
# title: anchor
# cursor: [2, 0]
# alt: false
HELLO
WORLD

```

If it does not, stop and fix `gridSnapshot` before continuing.

- [ ] **Step 5: Run without UPDATE to confirm the gate holds**

Run: `pnpm test -- src/modules/terminal/__tui_compat__/tui-compat.test.ts`
Expected: PASS (golden matches the committed file).

- [ ] **Step 6: Commit**

```bash
git add src/modules/terminal/__tui_compat__/tui-compat.test.ts \
        src/modules/terminal/__tui_compat__/cassettes/anchor.cast \
        src/modules/terminal/__tui_compat__/golden/anchor.golden
git commit -m "feat(tui-compat): data-driven golden loop + anchor cassette"
```

---

## Task 5: Synthetic cassettes + seeded goldens

**Files:**

- Create under `src/modules/terminal/__tui_compat__/cassettes/`: `osc7-cwd.cast`, `osc133-prompt.cast`, `altscreen-tui.cast`, `truecolor-sgr.cast`, `wide-chars.cast`, `cursor-positioning.cast`, `da1-dsr.cast`.
- Seed matching `golden/*.golden` files via `HARNESS_UPDATE=1`.

These cover OSC handling (cwd, prompt markers, DA/DSR tolerance), alt-screen enter/paint/exit, truecolor, wide chars, and cursor positioning. Each `.cast` below is committed verbatim.

- [ ] **Step 1: Create `cassettes/osc7-cwd.cast`**

```
{"version":2,"width":40,"height":3,"title":"osc7-cwd","puhon":{"expectCwd":"C:/Users/leo/project","chunkTest":true}}
[0,"o","\u001b]7;file:///C:/Users/leo/project\u0007"]
```

- [ ] **Step 2: Create `cassettes/osc133-prompt.cast`**

```
{"version":2,"width":40,"height":4,"title":"osc133-prompt","puhon":{"chunkTest":true}}
[0,"o","\u001b]133;A\u0007$ \u001b]133;B\u0007"]
[0.1,"o","ls\r\n"]
[0.2,"o","\u001b]133;C\u0007file_a file_b\r\n\u001b]133;D;0\u0007$ \u001b]133;B\u0007"]
```

- [ ] **Step 3: Create `cassettes/altscreen-tui.cast`**

Exercises the renderer alt-screen path the same way vim does: write to the normal buffer, enter alt-screen, paint a header at a moved cursor, exit alt-screen. The golden asserts the normal buffer is restored on exit.

```
{"version":2,"width":20,"height":4,"title":"altscreen-tui","puhon":{"chunkTest":true}}
[0,"o","before\r\n"]
[0.1,"o","\u001b[?1049h\u001b[2J\u001b[H\u001b[1;1H\u001b[7m TUI HEADER \u001b[0m"]
[0.2,"o","\u001b[?1049l"]
```

- [ ] **Step 4: Create `cassettes/truecolor-sgr.cast` (strict)**

```
{"version":2,"width":9,"height":1,"title":"truecolor-sgr","puhon":{"strict":true}}
[0,"o","\u001b[38;2;255;0;0mR\u001b[38;2;0;255;0mG\u001b[38;2;0;0;255mB\u001b[0m"]
```

- [ ] **Step 5: Create `cassettes/wide-chars.cast` (strict)**

`Ａ` (fullwidth A, width 2), `漢` (CJK, width 2), `😀` (emoji, width 2). Asserts no misalignment via the strict serialize golden.

```
{"version":2,"width":10,"height":1,"title":"wide-chars","puhon":{"strict":true}}
[0,"o","Ａ漢😀"]
```

- [ ] **Step 6: Create `cassettes/cursor-positioning.cast`**

```
{"version":2,"width":20,"height":6,"title":"cursor-positioning","puhon":{"chunkTest":true}}
[0,"o","\u001b[3;5HX"]
[0.1,"o","\u001b[6n"]
[0.2,"o","\u001b[1;1Htop"]
```

- [ ] **Step 7: Create `cassettes/da1-dsr.cast`**

DA1 (`ESC[c`), DA2 (`ESC[>c`), and DSR (`ESC[6n`) queries present in the stream must not corrupt the grid. xterm answers them on its input; the grid stays clean.

```
{"version":2,"width":20,"height":2,"title":"da1-dsr","puhon":{"chunkTest":true}}
[0,"o","clean\r\n"]
[0.1,"o","\u001b[c\u001b[>c\u001b[6n"]
[0.2,"o","still clean\r\n"]
```

- [ ] **Step 8: Seed all goldens**

Run: `HARNESS_UPDATE=1 pnpm test -- src/modules/terminal/__tui_compat__/tui-compat.test.ts`
Expected: PASS (8 tests: anchor + 7 new).

- [ ] **Step 9: Confirm the gate holds without UPDATE**

Run: `pnpm test -- src/modules/terminal/__tui_compat__/tui-compat.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 10: Commit**

```bash
git add src/modules/terminal/__tui_compat__/cassettes/*.cast \
        src/modules/terminal/__tui_compat__/golden/*.golden
git commit -m "feat(tui-compat): add OSC/alt-screen/truecolor/wide-char/cursor/DA cassettes + goldens"
```

---

## Task 6: Extract leafEvictionScore (renderer-pool invariant coverage)

**Files:**

- Create: `src/modules/terminal/lib/rendererPoolDecisions.ts`
- Create: `src/modules/terminal/lib/rendererPoolDecisions.test.ts`
- Modify: `src/modules/terminal/lib/rendererPool.ts` (replace the body of `evictionScore` with a call to `leafEvictionScore`; add the import).

**Interfaces:**

- Produces: `leafEvictionScore(f: LeafEvictionFlags): number` where

  ```ts
  type LeafEvictionFlags = { visible: boolean; altScreen: boolean; busy: boolean; blocks: boolean; focused: boolean; lastUsedAt: number };
  ```

This file imports nothing heavy (no Tauri/DOM), so it is safe to import from a Node test. The existing `evictionScore` body is extracted verbatim; behavior is unchanged. The test locks the "never-serialize-mid-command" guarantee: busy and alt-screen leaves rank high enough to never be the eviction victim.

- [ ] **Step 1: Write the failing test**

```ts
// rendererPoolDecisions.test.ts
import { describe, expect, it } from "vitest";
import { leafEvictionScore } from "./rendererPoolDecisions";

const idle = {
  visible: false,
  altScreen: false,
  busy: false,
  blocks: false,
  focused: false,
  lastUsedAt: 0,
};

describe("leafEvictionScore", () => {
  it("ranks a busy leaf above an idle leaf (never-serialize-mid-command)", () => {
    expect(leafEvictionScore({ ...idle, busy: true })).toBeGreaterThan(
      leafEvictionScore(idle),
    );
  });

  it("ranks an alt-screen leaf above an idle leaf", () => {
    expect(leafEvictionScore({ ...idle, altScreen: true })).toBeGreaterThan(
      leafEvictionScore(idle),
    );
  });

  it("ranks a visible leaf above a hidden busy leaf (visible is never the victim)", () => {
    expect(
      leafEvictionScore({ ...idle, visible: true }),
    ).toBeGreaterThan(leafEvictionScore({ ...idle, busy: true }));
  });

  it("breaks ties by recency (older evicted first)", () => {
    const older = leafEvictionScore({ ...idle, lastUsedAt: 1 });
    const newer = leafEvictionScore({ ...idle, lastUsedAt: 1_000_000 });
    expect(newer).toBeGreaterThan(older);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/modules/terminal/lib/rendererPoolDecisions.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the pure helper**

```ts
// rendererPoolDecisions.ts
export type LeafEvictionFlags = {
  visible: boolean;
  altScreen: boolean;
  busy: boolean;
  blocks: boolean;
  focused: boolean;
  lastUsedAt: number;
};

// Higher score = less likely to be evicted/serialized. A busy or alt-screen
// leaf is the "never-serialize-mid-command" surface: it must never lose to an
// idle hidden leaf, which is exactly what this weighting guarantees.
export function leafEvictionScore(f: LeafEvictionFlags): number {
  return (
    (f.visible ? 1000 : 0) +
    (f.altScreen ? 100 : 0) +
    (f.busy ? 80 : 0) +
    (f.blocks ? 50 : 0) +
    (f.focused ? 10 : 0) +
    f.lastUsedAt / 1e12
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/modules/terminal/lib/rendererPoolDecisions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor rendererPool.ts to use it**

In `src/modules/terminal/lib/rendererPool.ts`, add to the local imports block (after the `keymap` import):

```ts
import { leafEvictionScore } from "./rendererPoolDecisions";
```

Replace the `evictionScore` function body:

```ts
function evictionScore(s: Slot): number {
  const leafId = s.currentLeafId;
  return leafEvictionScore({
    visible: leafId !== null && (adapter?.isLeafVisible(leafId) ?? false),
    altScreen: isAltScreen(s),
    busy: leafId !== null && (adapter?.isLeafBusy(leafId) ?? false),
    blocks: leafId !== null && (adapter?.isLeafBlocks(leafId) ?? false),
    focused: leafId !== null && (adapter?.isLeafFocused(leafId) ?? false),
    lastUsedAt: s.lastUsedAt,
  });
}
```

- [ ] **Step 6: Verify types + full harness still pass**

Run:

```bash
pnpm check-types
pnpm test
```

Expected: `check-types` clean; all tests PASS (no behavior change to the pool).

- [ ] **Step 7: Commit**

```bash
git add src/modules/terminal/lib/rendererPoolDecisions.ts \
        src/modules/terminal/lib/rendererPoolDecisions.test.ts \
        src/modules/terminal/lib/rendererPool.ts
git commit -m "refactor(terminal): extract leafEvictionScore (pure) + cover never-serialize-mid-command"
```

---

## Task 7: Isolated recorder sub-package + vim cassette

**Files:**

- Create: `scripts/recorder/package.json`
- Create: `scripts/recorder/record.mjs`
- Create: `src/modules/terminal/__tui_compat__/cassettes/altscreen-vim.cast` (produced by the recorder)
- Seed: `src/modules/terminal/__tui_compat__/golden/altscreen-vim.golden`

The recorder is isolated in `scripts/recorder/` with its own `package.json` so the **root `pnpm install` (CI) never builds `node-pty`**. A developer records manually: `cd scripts/recorder && pnpm install && pnpm start -- <args>`. The committed `.cast` is the artifact; the recorder is regen tooling only.

- [ ] **Step 1: Create the isolated package**

```json
// scripts/recorder/package.json
{
  "name": "puhon-cassette-recorder",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node record.mjs"
  },
  "dependencies": {
    "node-pty": "^1.1.0"
  }
}
```

- [ ] **Step 2: Create the recorder**

```js
// scripts/recorder/record.mjs
// Drives a program in a PTY and emits an asciicast v2 cassette.
// Usage: pnpm start -- --cmd vim --cols 80 --rows 24 \
//        --out ../../src/modules/terminal/__tui_compat__/cassettes/altscreen-vim.cast \
//        --keys 'ihello from vim\x1b:wq!\r'
// \r in --keys is CR (Enter); \x1b is ESC. Keystrokes are sent with a small
// fixed delay between them so interactive programs repaint deterministically.
import { spawn as ptySpawn } from "node-pty";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function decode(s) {
  return s.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\x1b/g, "\x1b");
}

const cmd = arg("cmd", "vim");
const cols = Number(arg("cols", "80"));
const rows = Number(arg("rows", "24"));
const out = resolve(arg("out", "cassette.cast"));
const keys = decode(arg("keys", ""));
const cwd = arg("cwd", process.cwd());

const events = [];
const start = Date.now();
const proc = ptySpawn(cmd, [], { cols, rows, cwd, name: "xterm" });

proc.onData((d) => {
  events.push([(Date.now() - start) / 1000, "o", d]);
});

setTimeout(() => {
  for (const ch of keys) {
    proc.write(ch);
  }
}, 200);

setTimeout(() => {
  try {
    proc.kill();
  } catch {}
}, 200 + keys.length * 15 + 1500);

proc.onExit(() => {
  const lines = [
    JSON.stringify({ version: 2, width: cols, height: rows, title: "altscreen-vim" }),
    ...events.map((e) => JSON.stringify(e)),
  ];
  writeFileSync(out, `${lines.join("\n")}\n`);
  // eslint-disable-next-line no-console
  console.log(`wrote ${out} (${events.length} events)`);
});
```

- [ ] **Step 3: Record the vim cassette**

```bash
cd scripts/recorder
pnpm install
pnpm start -- --cmd vim --cols 80 --rows 24 \
  --out ../../src/modules/terminal/__tui_compat__/cassettes/altscreen-vim.cast \
  --keys 'ihello from vim\x1b:wq!\r'
cd ../..
```

Expected: `wrote .../altscreen-vim.cast (N events)`.

- [ ] **Step 4: Seed the vim golden**

Run: `HARNESS_UPDATE=1 pnpm test -- src/modules/terminal/__tui_compat__/tui-compat.test.ts`
Expected: PASS (9 tests including `altscreen-vim`).

- [ ] **Step 5: Confirm the gate holds**

Run: `pnpm test -- src/modules/terminal/__tui_compat__/tui-compat.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/recorder/package.json scripts/recorder/record.mjs \
        src/modules/terminal/__tui_compat__/cassettes/altscreen-vim.cast \
        src/modules/terminal/__tui_compat__/golden/altscreen-vim.golden
git commit -m "feat(tui-compat): isolated node-pty recorder + recorded vim cassette"
```

---

## Task 8: Verify full suite + document the harness

**Files:**

- Modify: `docs/contributing/testing.md` (add a "TUI compatibility harness" section).

- [ ] **Step 1: Run the full quality gate**

```bash
pnpm lint
pnpm check-types
pnpm test
```

Expected: all PASS, no new lint/type errors. The `frontend` CI job already runs exactly these, so no workflow change is needed.

- [ ] **Step 2: Add the docs section**

Append to `docs/contributing/testing.md`, under a new `## TUI compatibility harness` heading (keep it short; this guide elaborates `PUHON.md`):

```markdown
## TUI compatibility harness

The byte-to-grid path (PTY flusher, OSC parsing, renderer pool, DormantRing,
xterm.js parsing) is the make-or-break surface for agent CLIs and full-screen
TUIs. Unit tests cover the pure pieces; the integration harness replays
recorded TUI byte streams through the real TS layer into `@xterm/headless`
and golden-compares the rendered grid.

- Location: `src/modules/terminal/__tui_compat__/`.
- Cassettes are asciicast v2 `.cast` files; goldens are committed beside them.
- Run: `pnpm test` (part of the normal suite).
- Regenerate goldens: `HARNESS_UPDATE=1 pnpm test`, then review the diff.
- Record a new cassette from a real program: `cd scripts/recorder && pnpm install && pnpm start -- --cmd <prog> --out <path> --keys '<keys>'`. The recorder is isolated so the root install (CI) never builds `node-pty`.

A golden mismatch fails CI; updates require a deliberate commit so reviewers
see the rendered-grid diff.
```

- [ ] **Step 3: Commit**

```bash
git add docs/contributing/testing.md
git commit -m "docs(testing): document the TUI compatibility regression harness"
```

---

## Self-Review (run before handing off)

- **Spec coverage:** Every spec section maps to a task: cassettePlayer default geometry (Task 1), `@xterm/addon-serialize` on headless for strict cassettes (Task 2 + Task 3 strict path), OSC handling (Task 5 osc7/osc133/da1-dsr), DormantRing chunk-invariance (Task 3 + chunkTest cassettes), grid fidelity incl. alt-screen/truecolor/wide-char (Task 5), renderer-pool `never-serialize-mid-command` (Task 6), golden workflow + CI-in-`pnpm test` (Task 4/5/8), isolated recorder (Task 7), default 80x24 (Task 1 + its test), testing-the-harness anchor (Task 4).
- **No native deps in CI:** `node-pty` is only in `scripts/recorder/package.json`; the root `pnpm-lock.yaml` is untouched by it. Verified CI's `pnpm install --frozen-lockfile` cannot build it.
- **Type consistency:** `parseCassette`, `snapshotGrid(term, title)`, `runCassette`/`runChunkInvariance`, `leafEvictionScore` names and shapes match across tasks.
