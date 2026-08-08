/**
 * Pinned-card store for the History board. A pin is just an episode id the user parked at the
 * top of the board; the "Pinned" section re-renders the SAME underlying episode rows, so a pinned
 * card is a live pointer to the original, not a frozen copy — editing either edits the one episode.
 *
 * Pins are client-side state in user_prefs — they never touch the graph store. reconcilePins keeps the set honest against the live episode list:
 * it drops pins whose episode was deleted and, crucially, follows a pin across an edit (a reingest
 * replaces episode A with a fresh episode B, so the pin migrates A → B and the pinned card survives).
 */
import { useSyncExternalStore } from "react";
import { readPref, writePref } from "./prefs";

const PINS_KEY = "pins";

/** In-flight/settled edit info reconcilePins needs — a subset of PendingWriteEntry. */
export interface PinEditHint {
  /** Episode this pending reingest replaces (its old id). */
  replacesEpisodeId?: string | null;
  /** New episode id once the reingest has materialized; null while still processing. */
  episodeId: string | null;
}

export function loadPins(): string[] {
  try {
    const raw = JSON.parse(readPref(PINS_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string");
  } catch {
    // Corrupt/absent value — start empty.
  }
  return [];
}

export function savePins(ids: string[]): void {
  try {
    writePref(PINS_KEY, JSON.stringify(ids));
  } catch {
    // Storage disabled/full — pins simply won't persist this session.
  }
}

let pinsState: string[] | null = null;
const pinListeners = new Set<() => void>();

export function getPins(): string[] {
  if (!pinsState) pinsState = loadPins();
  return pinsState;
}

export function setPins(ids: string[]): void {
  if (ids === pinsState) return;
  pinsState = ids;
  savePins(ids);
  pinListeners.forEach((listener) => listener());
}

export function updatePins(change: (ids: string[]) => string[]): void {
  setPins(change(getPins()));
}

export function subscribePins(listener: () => void): () => void {
  pinListeners.add(listener);
  return () => pinListeners.delete(listener);
}

export function usePins(): string[] {
  return useSyncExternalStore(subscribePins, getPins);
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(Math.round(index), length));
}

/** Pin `id` at `index`. Already pinned → a reorder, so a re-drop never duplicates it. */
export function insertPin(id: string, index: number): void {
  updatePins((current) => {
    if (current.includes(id)) return reorder(current, id, index);
    const next = [...current];
    next.splice(clampIndex(index, next.length), 0, id);
    return next;
  });
}

/** Move an existing pin to `index`. A no-op move returns the SAME array, so React bails on it. */
export function movePin(id: string, index: number): void {
  updatePins((current) => reorder(current, id, index));
}

/** `index` is a slot in the current order, with `id` still in it — a later slot shifts down one. */
function reorder(pins: string[], id: string, index: number): string[] {
  const from = pins.indexOf(id);
  if (from < 0) return pins;
  const without = pins.filter((pin) => pin !== id);
  const to = clampIndex(index > from ? index - 1 : index, without.length);
  if (to === from) return pins;
  without.splice(to, 0, id);
  return without;
}

/** Test-only: force the next read back through the store. */
export function resetPinsForTests(): void {
  pinsState = null;
}

/**
 * Reconcile pinned ids against the live episode list and any in-flight edits.
 *
 * - A pin whose episode is still live is kept as-is.
 * - A pin whose episode was replaced by a completed edit migrates to the new episode id, so the
 *   pinned card keeps pointing at "the same" note after it's edited.
 * - A pin whose episode is mid-edit (reingest queued, no new id yet) is kept — the old episode
 *   still exists until the replacement lands, so the pin waits it out.
 * - Any other missing pin is dropped as deleted — but ONLY when `listComplete` is true. The board
 *   fetches a capped page (top 2000), so when that page is truncated (`listComplete` false) a
 *   missing pin may simply have aged out of the window rather than been deleted, and is kept.
 *
 * Returns the SAME array reference when nothing changed, so callers can treat an unchanged result
 * as a no-op (React bails on an identical state value).
 */
export function reconcilePins(
  pins: string[],
  liveIds: Set<string>,
  edits: readonly PinEditHint[],
  listComplete = true,
): string[] {
  const migrated = new Map<string, string>(); // old episode id → new episode id (edit done)
  const midEdit = new Set<string>(); // old episode id still being reingested (no new id yet)
  for (const edit of edits) {
    const from = edit.replacesEpisodeId;
    if (!from) continue;
    if (edit.episodeId && edit.episodeId !== from) migrated.set(from, edit.episodeId);
    else midEdit.add(from);
  }

  const next: string[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const id of pins) {
    let resolved = id;
    if (!liveIds.has(id)) {
      const to = migrated.get(id);
      if (to) {
        resolved = to;
        changed = true;
      } else if (midEdit.has(id)) {
        // Keep the pin while the replacement is still processing.
      } else if (listComplete) {
        changed = true; // episode is gone from a complete list — drop the pin
        continue;
      }
      // else: the list is truncated, so a missing pin may be out-of-window — keep it.
    }
    if (seen.has(resolved)) {
      changed = true; // a double-edit could collapse two pins onto one id — dedupe
      continue;
    }
    seen.add(resolved);
    next.push(resolved);
  }
  return changed ? next : pins;
}
