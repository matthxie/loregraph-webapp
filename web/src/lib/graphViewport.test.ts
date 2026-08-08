import { describe, expect, it } from "vitest";
import { zoomGraphViewBox } from "./graphViewport";

describe("zoomGraphViewBox", () => {
  it("zooms around the cursor and preserves the aspect ratio", () => {
    const initial = { x: 0, y: 0, width: 1000, height: 600 };
    const next = zoomGraphViewBox(initial, -200, 250, 150, 0, 0, 500, 300, 120, 2500);

    expect(next.width).toBeLessThan(initial.width);
    expect(next.height / next.width).toBeCloseTo(0.6);
    expect(next.x + next.width / 2).toBeCloseTo(500);
    expect(next.y + next.height / 2).toBeCloseTo(300);
  });

  it("clamps the zoom range", () => {
    const initial = { x: 0, y: 0, width: 800, height: 400 };
    const zoomedIn = zoomGraphViewBox(initial, -10000, 400, 200, 0, 0, 800, 400, 120, 2000);
    const zoomedOut = zoomGraphViewBox(initial, 10000, 400, 200, 0, 0, 800, 400, 120, 2000);

    expect(zoomedIn.width).toBe(120);
    expect(zoomedOut.width).toBe(2000);
  });
});
