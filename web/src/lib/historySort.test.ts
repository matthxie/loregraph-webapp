import { describe, expect, it } from "vitest";
import {
  dayKey,
  dayLabel,
  packBalancedColumns,
  packColumns,
  reshuffle,
  stickyShuffleOrder,
  type HistoryItem,
} from "./historySort";

describe("dayLabel", () => {
  it("keeps only the current day relative and turns prior days into explicit dates", () => {
    const now = new Date(2026, 6, 12, 12);
    const prior = new Date(2026, 6, 11, 12);

    expect(dayLabel(dayKey(now.toISOString()), now)).toBe("Today");
    expect(dayLabel(dayKey(prior.toISOString()), now)).not.toBe("Yesterday");
    expect(dayLabel(dayKey(prior.toISOString()), now)).toContain("2026");
  });
});

describe("packColumns", () => {
  it("uses measured heights to keep filling the shortest mosaic lane", () => {
    const items: HistoryItem[] = Array.from({ length: 9 }, (_, index) => ({
      id: String.fromCharCode(97 + index),
      created_at: `2026-07-14T12:0${9 - index}:00Z`,
      raw_text: "entry",
      media_paths: [],
    }));
    const heights = new Map(items.map((item) => [item.id, item.id === "a" ? 500 : 100]));
    expect(packColumns(items, 3, (item) => heights.get(item.id) ?? 100).map(
      (column) => column.map((item) => item.id),
    )).toEqual([
      ["a"],
      ["b", "d", "f", "h"],
      ["c", "e", "g", "i"],
    ]);
  });

  it("fills left-to-right, repairs a large height delta, then resumes the sequence", () => {
    const items: HistoryItem[] = Array.from({ length: 12 }, (_, index) => ({
      id: String.fromCharCode(97 + index),
      created_at: `2026-07-14T12:${String(12 - index).padStart(2, "0")}:00Z`,
      raw_text: "entry",
      media_paths: [],
    }));
    const heights = new Map(items.map((item) => [item.id, item.id === "c" ? 500 : 100]));
    const mosaic = packBalancedColumns(items, 3, (item) => heights.get(item.id) ?? 100, 150);
    const totals = mosaic.map((column) => column.reduce(
      (total, item) => total + (heights.get(item.id) ?? 0),
      0,
    ));

    expect(Math.max(...totals) - Math.min(...totals)).toBe(100);
    expect(mosaic.map((column) => column.map((item) => item.id))).toEqual([
      ["a", "d", "f", "h", "k"],
      ["b", "e", "g", "i", "l"],
      ["c", "j"],
    ]);
  });
});

describe("random ordering", () => {
  const items: HistoryItem[] = ["a", "b", "c"].map((id, index) => ({
    id,
    created_at: `2026-07-14T12:0${3 - index}:00Z`,
    raw_text: id,
    media_paths: [],
  }));

  it("reshuffles from scratch and appends new arrivals without moving survivors", () => {
    expect(reshuffle(items, () => 0)).toEqual(["b", "c", "a"]);
    expect(stickyShuffleOrder(["b", "c", "a"], [
      { ...items[0]!, id: "new", created_at: "2026-07-14T12:04:00Z" },
      ...items,
    ], () => 0)).toEqual(["b", "c", "a", "new"]);
  });
});
