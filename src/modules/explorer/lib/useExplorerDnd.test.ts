import { describe, expect, it } from "vitest";
import { resolveDropTarget } from "./useExplorerDnd";

function mockElement(attrs: Record<string, string>): HTMLElement {
  const el = {
    closest: (selector: string) => {
      if (selector === "[data-pane-leaf]" && attrs["data-pane-leaf"]) return el;
      if (selector === "[data-fs-path]" && attrs["data-fs-path"]) return el;
      return null;
    },
    getAttribute: (name: string) => attrs[name] ?? null,
    dataset: attrs["data-pane-leaf"]
      ? { paneLeaf: attrs["data-pane-leaf"] }
      : {},
  } as unknown as HTMLElement;
  return el;
}

const isDir = (p: string) => p.endsWith("/");

describe("resolveDropTarget", () => {
  it("returns terminal target when element is inside a data-pane-leaf", () => {
    const el = mockElement({ "data-pane-leaf": "7" });
    expect(resolveDropTarget(el, "/root", isDir)).toEqual({
      kind: "terminal",
      leafId: 7,
    });
  });

  it("returns explorer target with directory path for a folder row", () => {
    const el = mockElement({ "data-fs-path": "/root/src/" });
    expect(resolveDropTarget(el, "/root", isDir)).toEqual({
      kind: "explorer",
      dir: "/root/src/",
    });
  });

  it("returns explorer target with parent dir for a file row", () => {
    const el = mockElement({ "data-fs-path": "/root/src/index.ts" });
    expect(resolveDropTarget(el, "/root", isDir)).toEqual({
      kind: "explorer",
      dir: "/root/src",
    });
  });

  it("returns null when element has no drop target attributes", () => {
    const el = mockElement({});
    expect(resolveDropTarget(el, "/root", isDir)).toBeNull();
  });

  it("returns null when element is null", () => {
    expect(resolveDropTarget(null, "/root", isDir)).toBeNull();
  });

  it("returns null when data-pane-leaf is not a finite number", () => {
    const el = mockElement({ "data-pane-leaf": "abc" });
    expect(resolveDropTarget(el, "/root", isDir)).toBeNull();
  });

  it("prioritizes terminal over explorer when both match (element is a pane-leaf)", () => {
    const el = mockElement({
      "data-pane-leaf": "3",
      "data-fs-path": "/root/foo",
    });
    expect(resolveDropTarget(el, "/root", isDir)).toEqual({
      kind: "terminal",
      leafId: 3,
    });
  });
});