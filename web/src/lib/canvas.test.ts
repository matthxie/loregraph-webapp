import { describe, expect, it } from "vitest";
import type { CanvasShape } from "../shared/api";
import {
  CARD_H,
  CARD_W,
  clampZoom,
  emptyCanvas,
  hitsShape,
  isDegenerate,
  placeMissing,
  pruneItems,
  roundDocument,
  shapeAt,
  shapeBounds,
  toCanvasPoint,
} from "./canvas";

const shape = (over: Partial<CanvasShape> = {}): CanvasShape => ({
  id: "s1",
  kind: "line",
  x1: 0,
  y1: 0,
  x2: 100,
  y2: 0,
  color: 0,
  width: 3,
  ...over,
});

describe("canvas geometry", () => {
  it("places newly filed saves and leaves existing ones alone", () => {
    const first = placeMissing(emptyCanvas(), ["a", "b"]);
    expect(first.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(first.items[0]).toMatchObject({ x: 0, y: 0, w: CARD_W, h: CARD_H });
    expect(first.items[1]!.x).toBeGreaterThan(0);

    // A save dragged somewhere keeps its spot when another arrives.
    const moved = { ...first, items: first.items.map((i) => (i.id === "a" ? { ...i, x: 900, y: 700 } : i)) };
    const second = placeMissing(moved, ["a", "b", "c"]);
    expect(second.items.find((item) => item.id === "a")).toMatchObject({ x: 900, y: 700 });
    // The new one lands below everything, not on top of it.
    expect(second.items.find((item) => item.id === "c")!.y).toBeGreaterThan(700);

    // Nothing missing → same object, so no needless save.
    expect(placeMissing(second, ["a", "b", "c"])).toBe(second);
  });

  it("prunes placements whose save left the collection", () => {
    const doc = placeMissing(emptyCanvas(), ["a", "b"]);
    expect(pruneItems(doc, ["a"]).items.map((item) => item.id)).toEqual(["a"]);
    expect(pruneItems(doc, ["a", "b"])).toBe(doc);
  });

  it("bounds a shape whichever way it was dragged", () => {
    expect(shapeBounds(shape({ x1: 100, y1: 80, x2: 20, y2: 10 })))
      .toEqual({ x: 20, y: 10, w: 80, h: 70 });
  });

  it("treats a click-sized shape as degenerate", () => {
    expect(isDegenerate(shape({ x2: 2, y2: 1 }))).toBe(true);
    expect(isDegenerate(shape({ x2: 40, y2: 0 }))).toBe(false);
  });

  it("hit-tests lines along the segment, not their bounding box", () => {
    const line = shape({ x1: 0, y1: 0, x2: 100, y2: 100 });
    expect(hitsShape(line, 50, 50)).toBe(true);
    // Inside the bounding box but far from the diagonal.
    expect(hitsShape(line, 95, 5)).toBe(false);
  });

  it("hit-tests boxes on their outline so an empty middle stays clickable", () => {
    const rect = shape({ kind: "rect", x1: 0, y1: 0, x2: 200, y2: 120 });
    expect(hitsShape(rect, 0, 60)).toBe(true);
    expect(hitsShape(rect, 100, 60)).toBe(false);
    expect(hitsShape(rect, 400, 60)).toBe(false);
  });

  it("returns the topmost shape under a point", () => {
    const under = shape({ id: "under", kind: "rect", x1: 0, y1: 0, x2: 100, y2: 100 });
    const over = shape({ id: "over", kind: "rect", x1: 0, y1: 0, x2: 100, y2: 100 });
    expect(shapeAt([under, over], 0, 50)?.id).toBe("over");
    expect(shapeAt([under, over], 50, 50)).toBeNull();
  });

  it("maps screen points into canvas space through the viewport", () => {
    const point = toCanvasPoint(300, 200, { left: 100, top: 50 }, { x: 10, y: 20, zoom: 2 });
    expect(point).toEqual({ x: 110, y: 95 });
  });

  it("clamps zoom to the usable range", () => {
    expect(clampZoom(99)).toBe(2.5);
    expect(clampZoom(0.01)).toBe(0.25);
  });

  it("rounds to whole pixels before saving", () => {
    const doc = {
      ...emptyCanvas(),
      items: [{ id: "a", x: 1.6, y: 2.4, w: 240.5, h: 160.2, z: 1 }],
      shapes: [shape({ x1: 0.4, y1: 0.6, x2: 99.9, y2: 0.2 })],
      view: { x: 3.7, y: 4.2, zoom: 1.2345 },
    };
    const rounded = roundDocument(doc);
    expect(rounded.items[0]).toMatchObject({ x: 2, y: 2, w: 241, h: 160 });
    expect(rounded.shapes[0]).toMatchObject({ x1: 0, y1: 1, x2: 100, y2: 0 });
    expect(rounded.view).toEqual({ x: 4, y: 4, zoom: 1.23 });
  });
});
