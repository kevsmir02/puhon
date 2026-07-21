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

      if (UPDATE) {
        mkdirSync(path.join(here, "golden"), { recursive: true });
        writeFileSync(goldenPath, actual);
        return;
      }
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
