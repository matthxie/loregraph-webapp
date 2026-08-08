/**
 * History board ordering: New | Old | Random sort, day sectioning with
 * Today awareness, sticky shuffle order (late arrivals appended, never vanish),
 * and shortest-column-first masonry packing with a cheap height estimate.
 * Pure functions — unit-tested.
 */

/** `shuffle` is the board's default: a server-sampled handful, not a re-sort of loaded rows. */
export type HistorySortMode = "shuffle" | "new" | "old" | "random";

/** How many notes the default board shows. */
export const SHUFFLE_SIZE = 10;

export interface HistoryItem {
  id: string;
  created_at: string; // ISO
  raw_text: string | null;
  media_paths: string[];
  graph_preview?: { nodes: unknown[] };
}

/** Local-day key for grouping (YYYY-MM-DD in the viewer's timezone). */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "Today" / full date, computed against an injectable `now` for tests. */
export function dayLabel(key: string, now: Date = new Date()): string {
  if (key === dayKey(now.toISOString())) return "Today";
  const parts = key.split("-").map(Number);
  const d = new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1);
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function byCreatedDesc(a: HistoryItem, b: HistoryItem): number {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id.localeCompare(a.id);
}

export interface DayGroup<T extends HistoryItem> {
  key: string;
  label: string;
  entries: T[];
}

/**
 * New = days newest-first, entries newest-first inside a day;
 * Old = days oldest-first, entries oldest-first inside a day.
 */
export function groupByDay<T extends HistoryItem>(items: T[], mode: "new" | "old", now: Date = new Date()): DayGroup<T>[] {
  const sorted = [...items].sort(byCreatedDesc);
  if (mode === "old") sorted.reverse();
  const groups: DayGroup<T>[] = [];
  const index = new Map<string, DayGroup<T>>();
  for (const item of sorted) {
    const key = dayKey(item.created_at);
    let g = index.get(key);
    if (!g) {
      g = { key, label: dayLabel(key, now), entries: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.entries.push(item);
  }
  return groups;
}

/**
 * Sticky shuffle (feature spec Random): given the previous shuffled id order and the current
 * items, keep surviving ids in their shuffled positions and APPEND newly-arrived items
 * (newest-first) at the end — entries never silently vanish or jump.
 */
export function stickyShuffleOrder(previousOrder: string[], items: HistoryItem[], rng: () => number = Math.random): string[] {
  const alive = new Set(items.map((i) => i.id));
  const kept = previousOrder.filter((id) => alive.has(id));
  const keptSet = new Set(kept);
  const fresh = [...items].sort(byCreatedDesc).map((i) => i.id).filter((id) => !keptSet.has(id));
  if (kept.length === 0) {
    // first shuffle: Fisher-Yates over everything
    const all = [...fresh];
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = all[i]!;
      all[i] = all[j]!;
      all[j] = tmp;
    }
    return all;
  }
  return [...kept, ...fresh];
}

/** Re-shuffle from scratch (the shuffle button). */
export function reshuffle(items: HistoryItem[], rng: () => number = Math.random): string[] {
  return stickyShuffleOrder([], items, rng);
}

/**
 * Cheap card-height estimate: image blocks (fixed aspect guess) + a text-length term, plus the
 * dev view when the board is showing one (chips + the fixed-height graph canvas). Only a first
 * guess — the masonry re-measures real heights and re-packs off those.
 */
export function estimateCardHeight(item: HistoryItem, columnWidth = 280, devView = false): number {
  const imageH = item.media_paths.length * columnWidth * 0.72;
  const textLen = (item.raw_text ?? "").length;
  const lineChars = columnWidth / 7.2; // ~7.2 px/char at 13 px system font
  const lines = Math.min(Math.ceil(textLen / lineChars), item.media_paths.length > 0 ? 6 : 14);
  const graphH = devView && item.graph_preview
    ? (item.graph_preview.nodes.length > 1 ? 176 : 90) + 96
    : 0;
  return 56 + imageH + lines * 19 + graphH;
}

/** Shortest-column-first packing: returns per-column item arrays, order preserved per column. */
export function packColumns<T extends HistoryItem>(
  items: T[],
  columnCount: number,
  estimate: (item: T) => number = (i) => estimateCardHeight(i),
): T[][] {
  const n = Math.max(1, columnCount);
  const columns: T[][] = Array.from({ length: n }, () => []);
  const heights = new Array<number>(n).fill(0);
  for (const item of items) {
    let best = 0;
    for (let c = 1; c < n; c++) if (heights[c]! < heights[best]!) best = c;
    columns[best]!.push(item);
    heights[best]! += estimate(item);
  }
  return columns;
}

/**
 * Chronological mosaic packing. Fill left-to-right while lane heights are close; when they drift
 * beyond `maxHeightDelta`, temporarily feed the shortest lane until balance is restored, then
 * continue the round-robin sequence from the following lane.
 */
export function packBalancedColumns<T extends HistoryItem>(
  items: T[],
  columnCount: number,
  estimate: (item: T) => number = (item) => estimateCardHeight(item),
  maxHeightDelta = 180,
): T[][] {
  const n = Math.max(1, columnCount);
  const columns: T[][] = Array.from({ length: n }, () => []);
  const heights = new Array<number>(n).fill(0);
  const delta = Math.max(0, maxHeightDelta);
  let cursor = 0;

  for (const item of items) {
    const tallestHeight = Math.max(...heights);
    const shortestHeight = Math.min(...heights);
    let target = cursor;
    if (tallestHeight - shortestHeight > delta) {
      // Break equal-height ties from the current cursor so repair mode still moves left-to-right.
      for (let step = 1; step < n; step += 1) {
        const candidate = (cursor + step) % n;
        if (heights[candidate]! < heights[target]!) target = candidate;
      }
    }
    columns[target]!.push(item);
    heights[target]! += Math.max(0, estimate(item));
    cursor = (target + 1) % n;
  }

  return columns;
}

/** 1–5 responsive columns: ~280 px per column, 24 px page padding, 16 px gutters. */
export function columnCountForWidth(containerWidth: number): number {
  const usable = containerWidth - 2 * 24;
  const per = 280 + 16;
  return Math.max(1, Math.min(5, Math.floor((usable + 16) / per)));
}
