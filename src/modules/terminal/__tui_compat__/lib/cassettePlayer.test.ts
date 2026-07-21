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
