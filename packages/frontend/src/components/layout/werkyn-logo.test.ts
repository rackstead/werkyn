// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const logoPath = new URL("../../../public/werkyn_logo.svg", import.meta.url);

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function emptyBox(): Box {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function include(box: Box, x: number, y: number) {
  box.minX = Math.min(box.minX, x);
  box.minY = Math.min(box.minY, y);
  box.maxX = Math.max(box.maxX, x);
  box.maxY = Math.max(box.maxY, y);
}

// Outlined wordmark: absolute M/L/Q/Z only. One box per contour.
function contourBoxes(d: string): Box[] {
  const tokens = d.match(/[MLQZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/g);
  if (!tokens) throw new Error("empty word path");
  const boxes: Box[] = [];
  let box: Box | null = null;
  let i = 0;
  const num = () => {
    const value = tokens[i++];
    if (value === undefined) throw new Error("path ended early");
    return Number(value);
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M" || cmd === "L") {
      const x = num();
      const y = num();
      if (cmd === "M") {
        box = emptyBox();
        boxes.push(box);
      }
      if (!box) throw new Error("path command before moveto");
      include(box, x, y);
    } else if (cmd === "Q") {
      if (!box) throw new Error("path command before moveto");
      include(box, num(), num());
      include(box, num(), num());
    } else if (cmd === "Z") {
      continue;
    } else {
      throw new Error(`unexpected path command ${cmd}`);
    }
  }
  return boxes;
}

describe("Werkyn logo", () => {
  const svg = readFileSync(logoPath, "utf8");

  it("does not embed the broken font payload", () => {
    expect(svg).not.toMatch(/@font-face/i);
    expect(svg).not.toMatch(/base64/i);
    expect(svg).not.toMatch(/<!DOCTYPE/i);
    expect(svg).not.toMatch(/<text[\s>]/i);
  });

  it("draws the whole word, including the n, inside the viewport", () => {
    expect(svg).toContain('fill="#2B157A"');
    const word = svg.match(/<path fill="#212121" d="([^"]+)"/);
    expect(word).not.toBeNull();
    const boxes = contourBoxes(word?.[1] ?? "");
    // W, e outer, e counter, r, k, y, n — Urbanist SemiBold outlines.
    expect(boxes).toHaveLength(7);
    const viewBox = svg.match(/viewBox="([^"]+)"/);
    expect(viewBox).not.toBeNull();
    const [x, y, width, height] = (viewBox?.[1] ?? "").split(/\s+/).map(Number);
    const right = x + width;
    const bottom = y + height;
    const translateX = 43;
    for (const box of boxes) {
      expect(box.minX + translateX).toBeGreaterThanOrEqual(x);
      expect(box.maxX + translateX).toBeLessThanOrEqual(right);
      expect(box.minY).toBeGreaterThanOrEqual(y);
      expect(box.maxY).toBeLessThanOrEqual(bottom + 0.01);
    }
    const yLetter = boxes[5];
    const n = boxes[6];
    expect(n).toBeDefined();
    expect(yLetter).toBeDefined();
    if (!n || !yLetter) return;
    // The n is its own contour after y, and it is not cut by the viewBox edge.
    expect(n.minX).toBeGreaterThan(yLetter.maxX);
    expect(n.maxX - n.minX).toBeGreaterThan(8);
    expect(n.maxX + translateX).toBeLessThan(right - 1);
  });
});
