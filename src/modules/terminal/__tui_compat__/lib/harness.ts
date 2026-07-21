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
