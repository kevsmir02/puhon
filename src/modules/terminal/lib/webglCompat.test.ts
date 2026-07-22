import { describe, expect, it } from "vitest";

import { shouldDefaultDisableWebgl } from "./webglCompat";

describe("shouldDefaultDisableWebgl", () => {
  it("disables on a Wayland session", () => {
    expect(shouldDefaultDisableWebgl("wayland")).toBe(true);
  });

  it("is case-insensitive for the session type", () => {
    expect(shouldDefaultDisableWebgl("Wayland")).toBe(true);
  });

  it("keeps WebGL enabled on X11", () => {
    expect(shouldDefaultDisableWebgl("x11")).toBe(false);
  });

  it("keeps WebGL enabled when the session is unknown", () => {
    expect(shouldDefaultDisableWebgl(null)).toBe(false);
    expect(shouldDefaultDisableWebgl(undefined)).toBe(false);
  });
});