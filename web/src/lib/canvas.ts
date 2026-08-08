/**
 * Canvas geometry: placement of new saves, shape normalization, and hit-testing.
 * Pure functions — the component owns the interaction, these own the maths.
 */
import type { CanvasDocument, CanvasItem, CanvasShape, CanvasShapeKind } from "../shared/api";

export const CARD_W = 240;
export const CARD_H = 160;
const GAP = 24;
/** How many cards a freshly-placed run lays out before wrapping. */
const COLUMNS = 4;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;

/** Stroke palette, indexed by `CanvasShape.color`. */
export const CANVAS_COLORS = [
  "#1d1d1f",
  "#0000ff",
  "#e5484d",
  "#f5a524",
  "#30a46c",
  "#8e4ec6",
] as const;

export function emptyCanvas(): CanvasDocument {
  return { version: 1, items: [], shapes: [], view: { x: 0, y: 0, zoom: 1 } };
}

/**
 * Give every episode in the collection a home. A save filed into a canvas collection has no
 * placement until it is dropped somewhere, so it would otherwise be invisible — new ids get
 * laid out in a grid below whatever is already placed.
 */
export function placeMissing(doc: CanvasDocument, episodeIds: readonly string[]): CanvasDocument {
  const placed = new Set(doc.items.map((item) => item.id));
  const missing = episodeIds.filter((id) => !placed.has(id));
  if (missing.length === 0) return doc;

  const bottom = doc.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  const startY = doc.items.length > 0 ? bottom + GAP : 0;
  const topZ = doc.items.reduce((max, item) => Math.max(max, item.z), 0);

  const added = missing.map((id, index): CanvasItem => ({
    id,
    x: (index % COLUMNS) * (CARD_W + GAP),
    y: startY + Math.floor(index / COLUMNS) * (CARD_H + GAP),
    w: CARD_W,
    h: CARD_H,
    z: topZ + 1 + index,
  }));
  return { ...doc, items: [...doc.items, ...added] };
}

/** Drop placements whose episode has left the collection. */
export function pruneItems(doc: CanvasDocument, episodeIds: readonly string[]): CanvasDocument {
  const live = new Set(episodeIds);
  const items = doc.items.filter((item) => live.has(item.id));
  return items.length === doc.items.length ? doc : { ...doc, items };
}

/** The axis-aligned box of a shape, whichever direction it was drawn in. */
export function shapeBounds(shape: CanvasShape): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(shape.x1, shape.x2),
    y: Math.min(shape.y1, shape.y2),
    w: Math.abs(shape.x2 - shape.x1),
    h: Math.abs(shape.y2 - shape.y1),
  };
}

/** A shape too small to see was a stray click, not a drawing. */
export function isDegenerate(shape: CanvasShape): boolean {
  const { w, h } = shapeBounds(shape);
  return Math.hypot(w, h) < 6;
}

function distanceToSegment(px: number, py: number, shape: CanvasShape): number {
  const dx = shape.x2 - shape.x1;
  const dy = shape.y2 - shape.y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - shape.x1, py - shape.y1);
  const t = Math.max(0, Math.min(1, ((px - shape.x1) * dx + (py - shape.y1) * dy) / lengthSquared));
  return Math.hypot(px - (shape.x1 + t * dx), py - (shape.y1 + t * dy));
}

/**
 * Whether a canvas-space point hits a shape. Lines and arrows test against the segment;
 * rects and ellipses against their outline, so clicking inside an empty box doesn't grab it.
 */
export function hitsShape(shape: CanvasShape, px: number, py: number, tolerance = 8): boolean {
  if (shape.kind === "line" || shape.kind === "arrow") {
    return distanceToSegment(px, py, shape) <= tolerance;
  }
  const { x, y, w, h } = shapeBounds(shape);
  const outside = px < x - tolerance || px > x + w + tolerance ||
    py < y - tolerance || py > y + h + tolerance;
  if (outside) return false;
  const inside = px > x + tolerance && px < x + w - tolerance &&
    py > y + tolerance && py < y + h - tolerance;
  return !inside;
}

/** Topmost shape under a point, matching what the user sees. */
export function shapeAt(shapes: readonly CanvasShape[], px: number, py: number): CanvasShape | null {
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const shape = shapes[index];
    if (shape && hitsShape(shape, px, py)) return shape;
  }
  return null;
}

export function makeShape(
  kind: CanvasShapeKind,
  x1: number,
  y1: number,
  color: number,
  width: number,
): CanvasShape {
  return {
    id: `sh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    kind,
    x1,
    y1,
    x2: x1,
    y2: y1,
    color,
    width,
  };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Screen point → canvas point, given the viewport. */
export function toCanvasPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  view: CanvasDocument["view"],
): { x: number; y: number } {
  return {
    x: (clientX - rect.left) / view.zoom + view.x,
    y: (clientY - rect.top) / view.zoom + view.y,
  };
}

/** Round to whole pixels before saving — halves the stored document for free. */
export function roundDocument(doc: CanvasDocument): CanvasDocument {
  const r = Math.round;
  return {
    ...doc,
    items: doc.items.map((item) => ({ ...item, x: r(item.x), y: r(item.y), w: r(item.w), h: r(item.h) })),
    shapes: doc.shapes.map((shape) => ({
      ...shape,
      x1: r(shape.x1),
      y1: r(shape.y1),
      x2: r(shape.x2),
      y2: r(shape.y2),
    })),
    view: { x: r(doc.view.x), y: r(doc.view.y), zoom: Math.round(doc.view.zoom * 100) / 100 },
  };
}
