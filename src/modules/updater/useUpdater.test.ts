import { describe, expect, it } from "vitest";
import { isNewer, parseVersion } from "./useUpdater";

describe("parseVersion", () => {
  it("parses standard semver versions", () => {
    expect(parseVersion("0.9.0")).toEqual([0, 9, 0]);
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
  });

  it("handles version strings with prerelease tags", () => {
    expect(parseVersion("0.9.0-beta.1")).toEqual([0, 9, 0]);
    expect(parseVersion("v1.0.0-rc1")).toEqual([1, 0, 0]);
  });
});

describe("isNewer", () => {
  it("returns false when versions are identical", () => {
    expect(isNewer("0.9.0", "0.9.0")).toBe(false);
    expect(isNewer("v0.9.0", "0.9.0")).toBe(false);
  });

  it("returns true when remote is newer than current", () => {
    expect(isNewer("0.9.1", "0.9.0")).toBe(true);
    expect(isNewer("1.0.0", "0.9.0")).toBe(true);
    expect(isNewer("v0.10.0", "0.9.0")).toBe(true);
  });

  it("returns false when remote is older than current", () => {
    expect(isNewer("0.8.9", "0.9.0")).toBe(false);
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
  });
});
