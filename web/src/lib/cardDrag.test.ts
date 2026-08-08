import { describe, expect, it } from "vitest";
import { dropIndexFor, type DropSlot } from "./cardDrag";

/** Two 100×100 columns of stacked cards: slots 0,1 on the left, 2,3 on the right. */
const slots: DropSlot[] = [
  { id: "a", rect: { left: 0, top: 0, right: 100, bottom: 100 } },
  { id: "b", rect: { left: 0, top: 100, right: 100, bottom: 200 } },
  { id: "c", rect: { left: 120, top: 0, right: 220, bottom: 100 } },
  { id: "d", rect: { left: 120, top: 100, right: 220, bottom: 200 } },
];

describe("dropIndexFor", () => {
  it("lands at 0 on an empty shelf", () => {
    expect(dropIndexFor([], { x: 50, y: 50 })).toBe(0);
  });

  it("lands before the nearest card when the pointer is in its top half", () => {
    expect(dropIndexFor(slots, { x: 50, y: 10 })).toBe(0);
    expect(dropIndexFor(slots, { x: 50, y: 110 })).toBe(1);
  });

  it("lands after the nearest card when the pointer is in its bottom half", () => {
    expect(dropIndexFor(slots, { x: 50, y: 90 })).toBe(1);
    expect(dropIndexFor(slots, { x: 50, y: 190 })).toBe(2);
  });

  it("picks the column nearest the pointer, not just the row", () => {
    expect(dropIndexFor(slots, { x: 200, y: 10 })).toBe(2);
    expect(dropIndexFor(slots, { x: 200, y: 190 })).toBe(4);
  });

  it("clamps past the last card to the end", () => {
    expect(dropIndexFor(slots, { x: 200, y: 900 })).toBe(4);
  });
});
