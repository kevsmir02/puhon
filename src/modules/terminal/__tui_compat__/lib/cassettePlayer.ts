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
