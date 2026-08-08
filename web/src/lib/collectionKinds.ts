/**
 * Whether a collection is a grid or a canvas. Chosen at creation and fixed after — the two
 * lay saves out so differently that switching would either discard placements or invent them.
 *
 * One enum per collection, so it rides in prefs beside folders and pins. The canvas document
 * itself does not: it is large and rewritten constantly, so it lives on the graph service.
 */
import { useSyncExternalStore } from "react";
import type { CollectionKind } from "../shared/api";
import { readPref, writePref } from "./prefs";

const KINDS_KEY = "collection-kinds";

export type KindMap = Record<string, CollectionKind>;

export function loadKinds(): KindMap {
  try {
    const raw = JSON.parse(readPref(KINDS_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const map: KindMap = {};
    for (const [name, kind] of Object.entries(raw as Record<string, unknown>)) {
      if (kind === "grid" || kind === "canvas") map[name.toLowerCase()] = kind;
    }
    return map;
  } catch {
    return {};
  }
}

let state: KindMap | null = null;
const listeners = new Set<() => void>();

export function getKinds(): KindMap {
  if (!state) state = loadKinds();
  return state;
}

function setKinds(next: KindMap): void {
  state = next;
  writePref(KINDS_KEY, JSON.stringify(next));
  listeners.forEach((listener) => listener());
}

export function setCollectionKind(name: string, kind: CollectionKind): void {
  setKinds({ ...getKinds(), [name.toLowerCase()]: kind });
}

/** Anything unrecorded is a grid — that is what every collection was before canvases. */
export function collectionKind(name: string, kinds: KindMap = getKinds()): CollectionKind {
  return kinds[name.toLowerCase()] ?? "grid";
}

export function pruneKinds(existing: ReadonlySet<string>): void {
  const current = getKinds();
  const kept = Object.fromEntries(Object.entries(current).filter(([name]) => existing.has(name)));
  if (Object.keys(kept).length !== Object.keys(current).length) setKinds(kept);
}

export function useCollectionKinds(): KindMap {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getKinds,
  );
}

/** Test-only: force the next read back through the store. */
export function resetKindsForTests(): void {
  state = null;
}
