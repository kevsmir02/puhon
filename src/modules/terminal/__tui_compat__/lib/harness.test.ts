// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));

import { Terminal } from "@xterm/headless";
import { runCassette, runChunkInvariance } from "./harness";
import { parseCassette } from "./cassettePlayer";
import { snapshotGrid } from "./gridSnapshot";

const OSC7 =
  '{"version":2,"width":40,"height":3,"title":"osc7","puhon":{"expectCwd":"C:/Users/leo/project","chunkTest":true}}\n' +
  '[0,"o","\\u001b]7;file:///C:/Users/leo/project\\u0007"]';

describe("runCassette", () => {
  it("replays bytes through the real osc-handlers and reports cwd", async () => {
    const res = await runCassette(parseCassette(OSC7));
    expect(res.cwd).toContain("C:/Users/leo/project");
    expect(res.serialize).toBeNull();
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
