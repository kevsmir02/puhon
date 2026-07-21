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
