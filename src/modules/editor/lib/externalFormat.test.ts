import { describe, expect, it } from "vitest";
import { resolveFormatter } from "./externalFormat";

const prefs = (
  global: Parameters<typeof resolveFormatter>[1]["editorFormatter"],
  byLang: Record<string, never> | Record<string, "ruff" | "prettier"> = {},
) => ({ editorFormatter: global, editorFormatterByLang: byLang });

describe("resolveFormatter", () => {
  it("explicit override wins over the global default", () => {
    expect(resolveFormatter("py", prefs("biome", { py: "ruff" }))).toBe("ruff");
  });

  it("global external applies only to languages it understands", () => {
    expect(resolveFormatter("ts", prefs("biome"))).toBe("biome");
    expect(resolveFormatter("py", prefs("biome"))).toBe("prettier");
    expect(resolveFormatter("rs", prefs("prettier"))).toBe("prettier");
  });

  it("custom global always applies", () => {
    expect(resolveFormatter("py", prefs("custom"))).toBe("custom");
  });

  it("unknown language falls back to prettier for external globals", () => {
    expect(resolveFormatter(null, prefs("biome"))).toBe("prettier");
  });
});
