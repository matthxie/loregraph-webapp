// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../shared/api";
import type { EpisodeListRow, EpisodeResult, StatsResult } from "../shared/protocol";
import { HistoryPage } from "./HistoryPage";

const row = {
  id: "ep_note_0001",
  title: "Tea",
  created_at: "2026-07-14T12:00:00Z",
  snippet: "tea",
  modality: "text",
  source: "capture",
  raw_text: "tea",
  media_paths: [],
  concepts: ["tea"],
  entities: ["me"],
  graph_preview: { nodes: [], edges: [] },
} satisfies EpisodeListRow;

const detail = {
  ...row,
  note_id: "note_0001",
  recorded_at: row.created_at,
  description: null,
  facts: [],
} satisfies EpisodeResult;

const stats = {
  nodes: 3,
  edges: 2,
  added: { nodes: 0, edges: 0 },
  episodes: 1,
  entities: 1,
  concepts: 1,
  mentions: 2,
  relations: 0,
  facts: { open: 0, closed: 0, retracted: 0 },
  by_node_type: { episode: 1, entity: 1, concept: 1 },
  by_edge_type: { mention: 2 },
} satisfies StatsResult;

describe("HistoryPage board", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockResolvedValue({ episodes: [row], total: 1 }),
        stats: vi.fn().mockResolvedValue(stats),
        episode: vi.fn().mockResolvedValue(detail),
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("shows the board summary without a full-graph control", async () => {
    const snapshot = {
      engine: { state: "running" },
      capabilities: {},
    } as StatusSnapshot;
    const onInitialLoadSettled = vi.fn();

    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshot}
          refreshToken={0}
          pendingEntries={[]}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
          onInitialLoadSettled={onInitialLoadSettled}
        />,
      );
    });

    expect(onInitialLoadSettled).toHaveBeenCalledTimes(1);
    expect(document.querySelector('button[aria-label="Sort memories"]')).not.toBeNull();
    expect(document.querySelector(`[aria-label="history-card-${row.id}"]`)).not.toBeNull();
    expect(document.querySelector(".memory-hero")).toBeNull();

    expect(document.querySelector('[aria-label="Show full graph"]')).toBeNull();
    expect(document.querySelector('[aria-label="Show memories"]')).toBeNull();
    expect(document.querySelector(".history-graph-wrap")).toBeNull();
    expect(document.querySelector(`[aria-label="history-card-${row.id}"]`)).not.toBeNull();

    // A card opens nothing: the note IS the card, and the old detail view only ever showed
    // the same text back plus machine-extracted internals the user never asked for.
    const card = document.querySelector(`[aria-label="history-card-${row.id}"]`) as HTMLElement;
    window.getSelection()?.removeAllRanges();
    await act(async () => card.click());
    expect(document.querySelector(".overlay-panel"), "no detail lightbox").toBeNull();
    expect(document.querySelector(".backdrop")).toBeNull();
  });

  it("scrolls an Ask citation to its original card and highlights the landing point", async () => {
    const snapshot = {
      engine: { state: "running" },
      capabilities: {},
    } as StatusSnapshot;

    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshot}
          refreshToken={0}
          pendingEntries={[]}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
          scrollToEpisode={{ id: row.id, requestId: 1 }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));

    const card = document.querySelector(`[aria-label="history-card-${row.id}"]`) as HTMLElement;
    expect(card.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
    expect(card.classList.contains("episode-jump-target")).toBe(true);
  });

  it("shows every link embed on a card in source order", async () => {
    const urls = [
      "https://two.example/story",
      "https://one.example/watch",
      "https://three.example/post",
      "https://four.example/note",
    ];
    const linkedRow = {
      ...row,
      id: "ep_many_links",
      raw_text: urls.join("\n"),
      snippet: urls.join("\n"),
    };
    const linkPreview = vi.fn(async (url: string) => ({
      url,
      canonicalUrl: url,
      provider: "web" as const,
      siteName: null,
      title: new URL(url).hostname,
      description: null,
      imageDataUrl: null,
    }));
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockResolvedValue({ episodes: [linkedRow], total: 1 }),
        stats: vi.fn().mockResolvedValue(stats),
        linkPreview,
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
    });
    const snapshot = { engine: { state: "running" }, capabilities: {} } as StatusSnapshot;

    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshot}
          refreshToken={0}
          pendingEntries={[]}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
        />,
      );
    });

    const card = document.querySelector(`[aria-label="history-card-${linkedRow.id}"]`) as HTMLElement;
    expect(linkPreview.mock.calls.map(([url]) => url)).toEqual(urls);
    expect(
      [...card.querySelectorAll<HTMLButtonElement>(".link-preview")]
        .map((embed) => embed.getAttribute("aria-label")),
    ).toEqual(urls.map((url) => `Open ${new URL(url).hostname}`));
  });

  it("shows a link note as the pasted url, not the fetched page title", async () => {
    const url = "https://www.instagram.com/reel/DAeXfrq/";
    const linkRow = {
      ...row,
      id: "ep_link_title",
      modality: "link",
      title: "Instagram",
      raw_text: url,
      snippet: url,
    } satisfies EpisodeListRow;
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockResolvedValue({ episodes: [linkRow], total: 1 }),
        stats: vi.fn().mockResolvedValue(stats),
        linkPreview: vi.fn().mockResolvedValue(null),
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
    });
    const snapshot = { engine: { state: "running" }, capabilities: {} } as StatusSnapshot;

    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshot}
          refreshToken={0}
          pendingEntries={[]}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
        />,
      );
    });

    const card = document.querySelector(`[aria-label="history-card-${linkRow.id}"]`) as HTMLElement;
    const link = card.querySelector(".snippet a") as HTMLAnchorElement;
    expect(link.textContent).toBe(url);
    expect(card.querySelector(".snippet")?.textContent).toBe(url);
  });

  it("keeps AI-authored summaries filterable without showing associations on board cards", async () => {
    const aiRow = { ...row, id: "ep_ai_summary", source: "assistant", raw_text: "Chat summary" };
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockResolvedValue({ episodes: [aiRow], total: 1 }),
        stats: vi.fn().mockResolvedValue(stats),
      },
    });
    const snapshot = { engine: { state: "running" }, capabilities: {} } as StatusSnapshot;

    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshot}
          refreshToken={0}
          pendingEntries={[]}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
          searchQuery="/ai"
        />,
      );
    });

    const card = document.querySelector(`[aria-label="history-card-${aiRow.id}"]`) as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector(".card-tag")).toBeNull();
  });

  it("sorts oldest-first and produces a stable random board from the filter", async () => {
    const sortRows = [
      { ...row, id: "ep_new", title: "New", raw_text: "new", snippet: "new", created_at: "2026-07-16T12:00:00Z" },
      { ...row, id: "ep_middle", title: "Middle", raw_text: "middle", snippet: "middle", created_at: "2026-07-15T12:00:00Z" },
      { ...row, id: "ep_old", title: "Old", raw_text: "old", snippet: "old", created_at: "2026-07-14T12:00:00Z" },
    ] satisfies EpisodeListRow[];
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockResolvedValue({ episodes: sortRows, total: sortRows.length }),
        stats: vi.fn().mockResolvedValue(stats),
      },
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const snapshot = { engine: { state: "running" }, capabilities: {} } as StatusSnapshot;

    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshot}
          refreshToken={0}
          pendingEntries={[]}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
        />,
      );
    });

    const openSort = async () => {
      await act(async () => {
        (document.querySelector('button[aria-label="Sort memories"]') as HTMLButtonElement).click();
      });
    };
    await openSort();
    await act(async () => {
      document.querySelector(".history-filter")?.dispatchEvent(new Event("pointerleave", { bubbles: true }));
    });
    expect(document.querySelector(".history-filter-menu")).not.toBeNull();
    const options = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.history-filter-menu [role="menuitemradio"]'));
    expect(options().map((option) => option.textContent?.replace("✓", ""))).toEqual([
      "Shuffled", "Newest first", "Oldest first", "Random",
    ]);

    await act(async () => options().find((option) => option.textContent?.includes("Oldest first"))?.click());
    expect(Array.from(document.querySelectorAll(".day-header-label")).map((label) => label.textContent)).toEqual([
      "Tuesday, July 14, 2026",
      "Wednesday, July 15, 2026",
      "Thursday, July 16, 2026",
    ]);

    await openSort();
    await act(async () => options().find((option) => option.textContent?.includes("Random"))?.click());
    expect(document.querySelectorAll(".day-header-label")).toHaveLength(0);
    expect(document.querySelector(".random-board")).not.toBeNull();
    expect(Array.from(document.querySelectorAll(".random-board .masonry-col")).map((column) =>
      column.querySelector('[aria-label^="history-card-"]')?.getAttribute("aria-label"),
    )).toEqual([
      "history-card-ep_middle",
      "history-card-ep_old",
      "history-card-ep_new",
    ]);
  });

  it("repacks measured card heights into the shortest open columns", async () => {
    const measuredRows = Array.from({ length: 9 }, (_, index): EpisodeListRow => ({
      ...row,
      id: `ep_${String.fromCharCode(97 + index)}`,
      title: `Entry ${index}`,
      raw_text: `entry ${index}`,
      snippet: `entry ${index}`,
      created_at: new Date(Date.UTC(2026, 6, 14, 12, 9 - index)).toISOString(),
    }));
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockResolvedValue({ episodes: measuredRows, total: measuredRows.length }),
        stats: vi.fn().mockResolvedValue(stats),
      },
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const label = this.getAttribute("aria-label");
      const height = label === "history-card-ep_a" ? 500 : label?.startsWith("history-card-") ? 100 : 600;
      return {
        x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height,
        width: 300, height, toJSON: () => ({}),
      } as DOMRect;
    });
    const snapshot = { engine: { state: "running" }, capabilities: {} } as StatusSnapshot;

    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshot}
          refreshToken={0}
          pendingEntries={[]}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
        />,
      );
    });

    const columns = Array.from(document.querySelectorAll(".masonry-col"));
    expect(columns).toHaveLength(3);
    expect(columns.map((column) => column.querySelectorAll('[aria-label^="history-card-"]').length))
      .toEqual([1, 4, 4]);
    expect(columns[0]?.querySelector('[aria-label="history-card-ep_a"]')).not.toBeNull();
  });
});
