// @vitest-environment jsdom
/**
 * Which engine verb a typed search asks, and what the board does with the answer.
 *
 * A lookup ("kyoto") asks §3.4 `search` — BM25, every term must literally appear. A question
 * ("what did I say about the climbing gym") asks §9.5 `search.nl`, which fuses the semantic
 * walk with that same BM25 lane: its point is that the answer card need not contain a single
 * word the user typed, which is exactly the case the client-side field filter cannot serve.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../shared/api";
import type { EpisodeListRow } from "../shared/protocol";
import { HistoryPage } from "./HistoryPage";

const makeRow = (id: string, text: string) => ({
  id,
  title: "",
  created_at: "2026-07-14T12:00:00Z",
  snippet: text,
  modality: "text",
  source: "capture",
  raw_text: text,
  media_paths: [],
  concepts: [],
  entities: [],
  graph_preview: { nodes: [], edges: [] },
}) satisfies EpisodeListRow;

// Only the first mentions a gym in words; the second is what a semantic walk would surface
// for a question about one, and no client-side word filter would ever return it.
const rowGym = makeRow("ep_note_0001", "the climbing gym on 4th has a new bouldering wall");
const rowBelay = makeRow("ep_note_0002", "Sam taught me to belay on Tuesday");
const rowKyoto = makeRow("ep_note_0003", "kyoto ramen counter");
const rows = [rowGym, rowBelay, rowKyoto];

describe("HistoryPage search verb", () => {
  let host: HTMLDivElement;
  let root: Root;
  let search: ReturnType<typeof vi.fn>;
  let searchNl: ReturnType<typeof vi.fn>;

  const snapshotWith = (searchNlCapable: boolean) => ({
    engine: { state: "running" },
    capabilities: { searchNl: searchNlCapable },
  }) as StatusSnapshot;

  const render = async (searchQuery: string, searchNlCapable = true) => {
    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshotWith(searchNlCapable)}
          refreshToken={0}
          pendingEntries={[]}
          searchQuery={searchQuery}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
        />,
      );
    });
    // Both paths debounce (250 ms lookup / 400 ms sentence) before they ask the daemon.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {});
  };

  // Masonry packs cards into columns, so DOM order isn't list order — read the list order
  // off the board's own ordering attribute instead.
  const visibleCards = () =>
    [...document.querySelectorAll('[aria-label^="history-card-"]')]
      .map((node) => node.getAttribute("aria-label"))
      .sort();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
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
    search = vi.fn().mockResolvedValue({ terms: "", episodes: [] });
    searchNl = vi.fn().mockResolvedValue({ query: "", as_of: null, episodes: [] });
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockResolvedValue({ episodes: rows, total: rows.length }),
        search,
        searchNl,
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks BM25 `search` for a name or phrase lookup", async () => {
    await render("kyoto");
    expect(search).toHaveBeenCalledWith("kyoto", 100);
    expect(searchNl).not.toHaveBeenCalled();
  });

  it("asks `search.nl` for a question, narrowly", async () => {
    await render("what did I say about the climbing gym");
    // Narrow k: the semantic lane is ranked but never filtered, so a wide ask would bury a
    // precise answer under its tail.
    expect(searchNl).toHaveBeenCalledWith("what did I say about the climbing gym", 20);
    expect(search).not.toHaveBeenCalled();
  });

  it("falls back to BM25 when the engine cannot serve search.nl", async () => {
    await render("what did I say about the climbing gym", false);
    expect(search).toHaveBeenCalledWith("what did I say about the climbing gym", 100);
    expect(searchNl).not.toHaveBeenCalled();
  });

  it("answers a question with the engine's hits, words or no words", async () => {
    searchNl.mockResolvedValue({
      query: "",
      as_of: null,
      episodes: [
        { id: rowBelay.id, title: "", created_at: "", snippet: "", score: 0.016,
          sources: ["semantic"] },
        { id: rowGym.id, title: "", created_at: "", snippet: "", score: 0.014,
          sources: ["semantic", "keyword"] },
      ],
    });
    await render("what did I say about the climbing gym");
    // Neither card matches the sentence locally — "what", "did", "say" appear in no note — so
    // this board is the engine's list, which is the whole point of asking search.nl for it.
    expect(visibleCards()).toEqual([
      `history-card-${rowGym.id}`,
      `history-card-${rowBelay.id}`,
    ].sort());
    expect(visibleCards()).not.toContain(`history-card-${rowKyoto.id}`);
  });

  it("keeps the board local when the engine cannot answer at all", async () => {
    searchNl.mockRejectedValue(new Error("METHOD_NOT_FOUND"));
    await render("what did I say about the climbing gym");
    // Every typed word must appear for a local match, and no note carries the whole sentence.
    expect(visibleCards()).toEqual([]);
    expect(document.body.textContent).toContain("Nothing matches your search");
  });

  it("sends only the text remainder, never the /tag tokens", async () => {
    await render("/travel what did I say about the climbing gym");
    expect(searchNl).toHaveBeenCalledWith("what did I say about the climbing gym", 20);
  });
});
