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
