import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source-level regression test for the MediaLightbox component.
 * Rendering this component for real requires jsdom + React Testing Library;
 * for a focused structural check we verify the source carries the key
 * attributes, handlers, and accessibility markers. If a future change
 * silently removes them, this test fails.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "MediaLightbox.tsx"), "utf8");

// Extract the lightbox overlay dialog div (the second <div> inside the {lightbox && } block)
const dialogMatch = src.match(/role="dialog"[\s\S]*?className="[^"]*fixed[^"]*"/);
const dialogJsx = dialogMatch?.[0] ?? "";

// Extract the thumbnail image (the one with loading="lazy")
const thumbMatch = src.match(
  /<img[\s\S]*?loading="lazy"[\s\S]*?\/>/,
);
const thumbJsx = (thumbMatch?.[0] ?? "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

// Extract the zoomable image inside the dialog
const zoomImgMatch = src.match(
  /select-none[\s\S]*?style=\{[\s\S]*?transform[\s\S]*?\}[\s\S]*?\/>/,
);
const zoomImgJsx = zoomImgMatch?.[0] ?? "";

describe("MediaLightbox structure", () => {
  it("renders a thumbnail image with zoom-in cursor", () => {
    expect(thumbJsx).not.toBe("");
    expect(thumbJsx).toMatch(/cursor-zoom-in/);
    expect(thumbJsx).toMatch(/loading="lazy"/);
    expect(thumbJsx).toMatch(/decoding="async"/);
  });

  it("renders a lightbox dialog overlay", () => {
    expect(dialogJsx).not.toBe("");
    expect(dialogJsx).toMatch(/role="dialog"/);
  });

  it("thumbnail image fires onClick to open lightbox", () => {
    expect(thumbJsx).toMatch(/onClick/);
  });

  it("lightbox has an Escape key listener", () => {
    expect(src).toMatch(/e\.key === "Escape"/);
  });

  it("lightbox has toolbar with zoom in, zoom out, fullscreen, and close buttons", () => {
    expect(src).toMatch(/title="Zoom in"/);
    expect(src).toMatch(/title="Zoom out"/);
    expect(src).toMatch(/title="Fullscreen"/);
    expect(src).toMatch(/title="Close"/);
  });

  it("displays zoom percentage", () => {
    expect(src).toMatch(/Math\.round\(zoom \* 100\)/);
  });

  it("zoomable image uses CSS scale and translate transforms", () => {
    expect(zoomImgJsx).toMatch(/transform/);
    expect(zoomImgJsx).toMatch(/scale\(/);
  });

  it("zoomable image has dragDisabled and is not draggable", () => {
    expect(src).toMatch(/draggable=\{false\}/);
  });

  it("has wheel zoom handler", () => {
    expect(src).toMatch(/onWheel/);
  });

  it("has mouse pan handlers", () => {
    expect(src).toMatch(/onMouseDown/);
    expect(src).toMatch(/onMouseMove/);
    expect(src).toMatch(/onMouseUp/);
    expect(src).toMatch(/onMouseLeave/);
  });

  it("clicking overlay backdrop closes lightbox", () => {
    expect(src).toMatch(/e\.target === e\.currentTarget/);
    expect(src).toMatch(/setLightbox\(false\)/);
  });

  it("zoom is clamped between MIN_ZOOM and MAX_ZOOM", () => {
    expect(src).toMatch(/Math\.min\(MAX_ZOOM/);
    expect(src).toMatch(/Math\.max\(MIN_ZOOM/);
  });
});
