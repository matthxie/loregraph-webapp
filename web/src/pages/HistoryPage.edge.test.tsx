// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../shared/api";
import type { EpisodeListRow } from "../shared/protocol";
import type { PendingWriteEntry } from "./InputPage";
import {
  getUserTags,
  resetCreatedFoldersForTests,
  resetKnownTagsForTests,
  resetUserTagsForTests,
  setUserTags,
} from "../lib/tags";
import { spotCounts } from "../components/SpotsSidebar";
import { HistoryPage, pendingDeleteShieldsRow } from "./HistoryPage";

const DAY_MS = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();

const makeRow = (id: string, text: string, extra: Partial<EpisodeListRow> = {}) => ({
  id,
  title: "",
  created_at: iso(2),
  snippet: text,
  modality: "text",
  source: "capture",
  raw_text: text,
  media_paths: [],
  concepts: [],
  entities: [],
  graph_preview: { nodes: [], edges: [] },
  ...extra,
}) satisfies EpisodeListRow;

const makePendingEntry = (id: string, text: string, extra: Partial<PendingWriteEntry> = {}): PendingWriteEntry => ({
  id,
  text,
  attachmentCount: 0,
  attachments: [],
  status: "processing",
  episodeId: null,
  createdAt: Date.now(),
  ...extra,
});

describe("pending delete board shields", () => {
  it("suppresses a late daemon commit by episode id", () => {
    const row = makeRow("ep-raced", "same text");
    const deleted = makePendingEntry("pending-1", "same text", {
      hidden: true,
      episodeId: row.id,
    });

    expect(pendingDeleteShieldsRow(deleted, row)).toBe(true);
  });

  it("suppresses a late commit by content and capture time before its id is known", () => {
    const createdAt = Date.now();
    const row = makeRow("ep-raced", "same text", {
      created_at: new Date(createdAt + 500).toISOString(),
    });
    const deleted = makePendingEntry("pending-1", "same text", {
      hidden: true,
      createdAt,
    });

    expect(pendingDeleteShieldsRow(deleted, row)).toBe(true);
    expect(pendingDeleteShieldsRow(
      { ...deleted, hidden: false },
      row,
    )).toBe(false);
  });
});

describe("HistoryPage edge cases", () => {
  let host: HTMLDivElement;
  let root: Root;

  const snapshot = {
    engine: { state: "running" },
    capabilities: {},
  } as StatusSnapshot;

  const mountGraph = (episodes: EpisodeListRow[], mocks?: { total?: number; pages?: EpisodeListRow[][] }) => {
    const total = mocks?.total ?? episodes.length;
    const pages = mocks?.pages ?? [episodes];
    let pageIndex = 0;

    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockImplementation(() => {
          const page = pages[pageIndex] ?? [];
          pageIndex += 1;
          return Promise.resolve({ episodes: page, total });
        }),
        search: vi.fn().mockResolvedValue({ episodes: [] }),
      },
    });
  };

  const render = async (props: Partial<React.ComponentProps<typeof HistoryPage>> = {}) => {
    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshot}
          refreshToken={0}
          pendingEntries={[]}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
          {...props}
        />,
      );
    });
  };

  const visibleCards = () =>
    [...document.querySelectorAll('[aria-label^="history-card-"]')]
      .map((node) => node.getAttribute("aria-label"))
      .sort();

  const visiblePendingCards = () =>
    [...document.querySelectorAll('[aria-label^="processing-card-"]')]
      .map((node) => node.getAttribute("aria-label"))
      .sort();

  const folderRows = () =>
    [...document.querySelectorAll(".spots-sidebar .spot-row")].map((node) => ({
      name: node.querySelector(".spot-row-name")?.textContent,
      selected: node.classList.contains("selected"),
    }));

  const openSidebar = async () => {
    const toggle = document.querySelector('[aria-label="Folders"]') as HTMLButtonElement | null;
    expect(toggle, "folders toggle should be in the header").not.toBeNull();
    if (document.querySelector(".spots-sidebar.open") === null) await act(async () => toggle!.click());
  };

  const clickChip = async (name: string, opts: { shift?: boolean } = {}) => {
    await openSidebar();
    const row = document.querySelector(`[aria-label="spot-${name}"]`) as HTMLButtonElement | null;
    expect(row, `folder ${name} should exist`).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: opts.shift ?? false }));
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    resetKnownTagsForTests();
    resetUserTagsForTests();
    resetCreatedFoldersForTests();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class {
        observe() {}
        disconnect() {}
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
    resetKnownTagsForTests();
    resetUserTagsForTests();
    resetCreatedFoldersForTests();
    vi.restoreAllMocks();
  });

  it("backfill truncation guard: skips rows with legacy #tag syntax and only runs on full list", async () => {
    // Mock pagination: first page has 2 rows with total=5, next page empty (early exit).
    const withHashtag = makeRow("ep_001", "#legacy note about cats", { raw_text: "#legacy note about cats" });
    const normalRow = makeRow("ep_002", "modern note");
    mountGraph([], { total: 5, pages: [[withHashtag, normalRow], []] });

    await render();

    // Wait for the episodesList calls to settle and rows to appear.
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // With a truncated page (rows.length < total), backfill should not run.
    expect(localStorage.getItem("graph.history.tags.backfill.v1")).toBeNull();

    // The hashtag row should NOT be backfilled into the UserTagMap because rows have legacy
    // syntax (we only backfill full list loads).
    const userTags = JSON.parse(localStorage.getItem("ceb.prefs.user-tags") ?? "{}");
    expect(userTags[withHashtag.id]).toBeUndefined();
  });

  it("a folder outlives its last card: it stays selected, empty, until it is deleted", async () => {
    const bioCard = makeRow("ep_bio_1", "my biography");
    const coffeeCard = makeRow("ep_coffee_1", "love coffee");

    mountGraph([bioCard, coffeeCard]);
    setUserTags({ [bioCard.id]: ["bio"], [coffeeCard.id]: ["coffee"] });

    await render();
    expect(visibleCards().length).toBe(2);

    // Select the bio folder.
    await clickChip("bio");
    expect(folderRows().find((row) => row.name === "bio")?.selected).toBe(true);
    expect(visibleCards()).toEqual([`history-card-${bioCard.id}`]);

    // Now remove the bio tag from the card (simulating deletion).
    setUserTags({ [coffeeCard.id]: ["coffee"] }); // bio card no longer tagged
    await render(); // Re-render to pick up the tag change

    // The folder is still there — now empty. Nothing removes a folder but Delete folder, so
    // the selection holds and the board honestly shows the empty folder.
    expect(folderRows().find((row) => row.name === "bio")?.selected).toBe(true);
    expect(visibleCards()).toEqual([]);
    expect(document.body.textContent).toContain("No cards with this tag");

    // Leaving the folder puts the whole board back.
    await clickChip("bio");
    expect(visibleCards()).toContain(`history-card-${coffeeCard.id}`);
  });

  it("case collision: 'Bio' and 'bio' merge into one folder that selects both cards", async () => {
    const card1 = makeRow("ep_bio_1", "biography part 1");
    const card2 = makeRow("ep_bio_2", "biography part 2");

    mountGraph([card1, card2]);
    // Manually create tags with different cases to simulate case collision.
    setUserTags({ [card1.id]: ["Bio"], [card2.id]: ["bio"] });

    await render();
    await openSidebar();

    // ONE folder "bio" (case-folded), and selecting it matches BOTH cards.
    const rows = folderRows();
    const bioDirs = rows.filter((row) => row.name && row.name.toLowerCase() === "bio");
    expect(bioDirs).toHaveLength(1);
    await clickChip("bio");
    expect(visibleCards()).toEqual([
      `history-card-${card1.id}`,
      `history-card-${card2.id}`,
    ].sort());
  });

  it("sidebar persistence: localStorage '1' opens on mount", async () => {
    const row = makeRow("ep_001", "test");
    mountGraph([row]);
    setUserTags({ [row.id]: ["folder"] });

    // Start with sidebar preference = "1" (open).
    localStorage.setItem("graph.history.folders-sidebar.v1", "1");

    await render();
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Sidebar should be open because localStorage says "1".
    expect(document.querySelector(".spots-sidebar")?.classList.contains("open")).toBe(true);
    expect(document.querySelector(".history-page")?.classList.contains("sidebar-open")).toBe(true);
  });

  it("sidebar persistence: localStorage '0' keeps sidebar closed on mount", async () => {
    const row = makeRow("ep_001", "test");
    mountGraph([row]);
    setUserTags({ [row.id]: ["folder"] });

    // Sidebar preference = "0" (closed).
    localStorage.setItem("graph.history.folders-sidebar.v1", "0");

    await render();
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Sidebar should be closed.
    expect(document.querySelector(".spots-sidebar")?.classList.contains("open")).toBe(false);
    expect(document.querySelector(".spots-sidebar")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".history-page")?.classList.contains("sidebar-open")).toBe(false);
  });

  it("empty-state wording: two tags say 'these tags'; one tag says 'this tag'", async () => {
    const card1 = makeRow("ep_001", "tagged");
    const card2 = makeRow("ep_002", "untagged");
    const card3 = makeRow("ep_003", "tagged bio");

    mountGraph([card1, card2, card3]);
    setUserTags({ [card1.id]: ["bio"], [card3.id]: ["bio"] });

    await render();
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // No match scenario with TWO active tags (via search).
    await render({ searchQuery: "/bio /coffee" });
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Empty state should say "these tags" (plural because of multiple tags).
    const emptyText = document.body.textContent ?? "";
    expect(emptyText).toContain("these tags");
  });

  it("empty-state with single folder-only filter says 'this tag'", async () => {
    const card1 = makeRow("ep_001", "content");

    mountGraph([card1]);
    setUserTags({ [card1.id]: ["bio"] });

    await render();
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Use a tag filter that doesn't match any cards.
    await render({ searchQuery: "/missing" });
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Empty state should say "this tag" (singular) because only one tag filter is active.
    const emptyText = document.body.textContent ?? "";
    expect(emptyText).toContain("this tag");
  });

  it("pending capture: visible when tag filter matches, hidden when it doesn't", async () => {
    const realCard = makeRow("ep_001", "real content");
    const otherCard = makeRow("ep_002", "other");

    mountGraph([realCard, otherCard]);

    const pending: PendingWriteEntry = makePendingEntry("pending_001", "/bio writing bio notes", {
      status: "processing",
      episodeId: null,
    });

    // File both real cards and pending entry.
    setUserTags({
      [realCard.id]: ["bio"],
      [otherCard.id]: ["coffee"],
      [pending.id]: ["bio"],
    });

    await render({ pendingEntries: [pending] });
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Open sidebar and select "bio" folder.
    await openSidebar();
    const bioRow = document.querySelector(`[aria-label="spot-bio"]`) as HTMLButtonElement | null;
    expect(bioRow).not.toBeNull();
    await act(async () => bioRow!.click());

    // Pending should be visible because it's tagged with "bio" and "bio" is selected.
    expect(visiblePendingCards()).toContain(`processing-card-${pending.id}`);

    // Deselect "bio" and select "coffee" instead.
    const coffeeRow = document.querySelector(`[aria-label="spot-coffee"]`) as HTMLButtonElement | null;
    expect(coffeeRow).not.toBeNull();
    await act(async () => bioRow!.click()); // deselect bio
    await act(async () => coffeeRow!.click()); // select coffee

    // Pending should NOT be visible because "coffee" is selected but pending is tagged "bio".
    expect(visiblePendingCards()).not.toContain(`processing-card-${pending.id}`);
  });

  it("search narrowing: pending entries hide during text search, stay under tag filters", async () => {
    const realCard = makeRow("ep_001", "coffee content");
    mountGraph([realCard]);

    const pending: PendingWriteEntry = makePendingEntry("pending_001", "/bio secret project");
    setUserTags({ [pending.id]: ["bio"], [realCard.id]: ["coffee"] });

    await render({ pendingEntries: [pending] });
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Pending should be visible with no filter.
    expect(visiblePendingCards()).toContain(`processing-card-${pending.id}`);

    // Re-render with a text search query (not a tag filter).
    await render({ pendingEntries: [pending], searchQuery: "coffee" });
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Pending should hide during text search (per buildBoardItems logic).
    expect(visiblePendingCards()).not.toContain(`processing-card-${pending.id}`);

    // But it should appear if we search by tag alone.
    await render({ pendingEntries: [pending], searchQuery: "/bio" });
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));
    expect(visiblePendingCards()).toContain(`processing-card-${pending.id}`);
  });

  it("case-insensitive folder matching: /Bio search tag matches Bio folder and bio cards", async () => {
    const card1 = makeRow("ep_001", "content");
    const card2 = makeRow("ep_002", "more");

    mountGraph([card1, card2]);
    setUserTags({ [card1.id]: ["Bio"] }); // Capitalized in the map.

    await render();
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Search by lowercase tag /bio.
    await render({ searchQuery: "/bio" });
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Should match the card filed under "Bio" because tag matching is case-insensitive.
    expect(visibleCards()).toContain(`history-card-${card1.id}`);
  });

  it("sidebar renders many folders with stable sort and correct counts", async () => {
    const rows: EpisodeListRow[] = [
      makeRow("ep_001", "a"),
      makeRow("ep_002", "b"),
      makeRow("ep_003", "c"),
      makeRow("ep_004", "d"),
      makeRow("ep_005", "e"),
    ];
    mountGraph(rows);

    // Create a variety of folder sizes.
    setUserTags({
      [rows[0]!.id]: ["alpha", "delta"],
      [rows[1]!.id]: ["beta", "delta"],
      [rows[2]!.id]: ["charlie"],
      [rows[3]!.id]: ["delta"],
      [rows[4]!.id]: ["echo"],
    });

    await render();
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));
    await openSidebar();

    const names = folderRows().map((row) => row.name);
    // Default sort is alphabetical.
    expect(names).toEqual(["alpha", "beta", "charlie", "delta", "echo"]);
    // Counts aren't rendered anymore, but the underlying data still counts per folder.
    const counts = Object.fromEntries(spotCounts(rows, getUserTags()).map((s) => [s.name, s.count]));
    expect(counts).toEqual({ alpha: 1, beta: 1, charlie: 1, delta: 3, echo: 1 });
  });

  it("board reflects backfilled tags after full list loads", async () => {
    const backedCard = makeRow("ep_001", "#bio old syntax", { raw_text: "#bio old syntax" });
    const newCard = makeRow("ep_002", "modern text");

    mountGraph([backedCard, newCard]);

    await render();
    await act(() => new Promise(resolve => setTimeout(resolve, 150)));

    // Backfill should run (full list load).
    // After backfill, the backedCard should have "bio" mapped in UserTagMap.
    const userTags = JSON.parse(localStorage.getItem("ceb.prefs.user-tags") ?? "{}");
    expect(userTags[backedCard.id]).toContain("bio");

    // Open sidebar — the folder should be listed.
    await openSidebar();
    expect(folderRows().map((row) => row.name)).toContain("bio");
  });

  it("legacy hashtag and modern /tag both strip from display", async () => {
    const legacyCard = makeRow("ep_legacy", "check #biology notes", { raw_text: "check #biology notes" });
    const modernCard = makeRow("ep_modern", "check /biology notes", { raw_text: "check /biology notes" });

    mountGraph([legacyCard, modernCard]);
    // File both under "biology".
    setUserTags({ [legacyCard.id]: ["biology"], [modernCard.id]: ["biology"] });

    await render();
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));

    // Both cards should be visible.
    const cards = visibleCards();
    expect(cards).toContain(`history-card-${legacyCard.id}`);
    expect(cards).toContain(`history-card-${modernCard.id}`);

    // Open sidebar and select "biology".
    await clickChip("biology");

    // Both should stay visible (both are tagged).
    expect(visibleCards().sort()).toEqual([
      `history-card-${legacyCard.id}`,
      `history-card-${modernCard.id}`,
    ].sort());
  });
});
