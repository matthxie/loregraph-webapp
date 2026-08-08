/** Dragging a card between the board and the Pinned shelf. Custom MIME so it isn't a file drag. */

export const CARD_DRAG_MIME = "application/x-ceb-episode";

export interface CardDragPayload {
  episodeId: string;
  /** A drag out of the shelf onto the board unpins. */
  from: "pinned" | "board";
}

export function writeCardDrag(dataTransfer: DataTransfer | null, payload: CardDragPayload): void {
  if (!dataTransfer) return;
  dataTransfer.setData(CARD_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.effectAllowed = "move";
}

/** Safe during `dragover`, where getData is blanked until the drop. */
export function dragHasCard(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes(CARD_DRAG_MIME);
}

export function readCardDrag(dataTransfer: DataTransfer | null): CardDragPayload | null {
  const raw = dataTransfer?.getData(CARD_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CardDragPayload>;
    if (typeof parsed.episodeId !== "string") return null;
    return { episodeId: parsed.episodeId, from: parsed.from === "pinned" ? "pinned" : "board" };
  } catch {
    return null;
  }
}

export interface DropSlot {
  id: string;
  rect: { left: number; top: number; right: number; bottom: number };
}

/**
 * Insert index for a drop at `point`, given the shelf's slots IN PIN ORDER. Nearest card center
 * picks the column; which half of that card the pointer is in picks before or after it.
 */
export function dropIndexFor(slots: readonly DropSlot[], point: { x: number; y: number }): number {
  if (slots.length === 0) return 0;
  let nearest = 0;
  let nearestDistance = Infinity;
  slots.forEach((slot, index) => {
    const centerX = (slot.rect.left + slot.rect.right) / 2;
    const centerY = (slot.rect.top + slot.rect.bottom) / 2;
    const distance = (point.x - centerX) ** 2 + (point.y - centerY) ** 2;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
  });
  const slot = slots[nearest]!;
  const midpointY = (slot.rect.top + slot.rect.bottom) / 2;
  return point.y < midpointY ? nearest : nearest + 1;
}
