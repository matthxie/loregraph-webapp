// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../shared/api";
import type { EpisodeListRow } from "../shared/protocol";
import { HistoryPage } from "./HistoryPage";
import { SHUFFLE_SIZE } from "../lib/historySort";

const makeRow = (n: number): EpisodeListRow => ({
  id: `ep_${n}`,
  title: `note ${n}`,
  created_at: new Date(Date.UTC(2026, 6, 1 + n, 12)).toISOString(),
  snippet: `note ${n}`,
  modality: "text",
  source: "capture",
  raw_text: `note ${n}`,
  media_paths: [],
});

const ALL = Array.from({ length: 40 }, (_, index) => makeRow(index));

const snapshot = {
  engine: { state: "running" },
  capabilities: { episodesList: true, shuffle: true, searchNl: false },
} as unknown as StatusSnapshot;

describe("HistoryPage shuffled board", () => {
  let host: HTMLDivElement;
  let root: Root;
  let episodesList: ReturnType<typeof vi.fn>;

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
    // Answer like the service: honour limit, and make the sample a function of the seed.
    episodesList = vi.fn(async (params: { limit?: number; shuffle?: boolean; seed?: string } = {}) => {
      const limit = params.limit ?? 200;
      if (!params.shuffle) return { episodes: ALL.slice(0, limit), total: ALL.length };
      const offset = [...(params.seed ?? "")].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % ALL.length;
      const rotated = [...ALL.slice(offset), ...ALL.slice(0, offset)];
      return { episodes: rotated.slice(0, limit), total: ALL.length };
    });
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: { episodesList, search: vi.fn().mockResolvedValue({ episodes: [] }) },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const render = async () => {
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
  };

  const cards = () => document.querySelectorAll(".card");

  it("asks for a seeded sample and shows only that handful", async () => {
    await render();

    expect(episodesList).toHaveBeenCalledWith(
      expect.objectContaining({ shuffle: true, limit: SHUFFLE_SIZE }),
    );
    expect(episodesList.mock.calls[0]?.[0]?.seed).toBeTruthy();
    expect(cards()).toHaveLength(SHUFFLE_SIZE);
    // Flat board, not day-sectioned: 10 notes spread over weeks would be mostly headings.
    expect(document.querySelector(".day-header")).toBeNull();
    expect(document.querySelector(".shuffle-board")).not.toBeNull();
  });

  it("says how much of the store it is showing", async () => {
    await render();
    expect(document.querySelector(".shuffle-footnote")?.textContent).toContain("10 of 40");
  });

  it("re-rolls with a fresh seed only when Shuffle is pressed", async () => {
    await render();
    const firstSeed = episodesList.mock.calls[0]?.[0]?.seed;
    const firstIds = [...cards()].map((card) => card.getAttribute("data-episode-id"));

    // A refetch that isn't a re-roll must keep the same 10 — otherwise the board would
    // reshuffle under the user several times a minute.
    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshot}
          refreshToken={1}
          pendingEntries={[]}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
        />,
      );
    });
    expect(episodesList.mock.calls[1]?.[0]?.seed).toBe(firstSeed);
    expect([...cards()].map((card) => card.getAttribute("data-episode-id"))).toEqual(firstIds);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Shuffle"]')?.click();
    });
    const nextSeed = episodesList.mock.calls.at(-1)?.[0]?.seed;
    expect(nextSeed).not.toBe(firstSeed);
    expect([...cards()].map((card) => card.getAttribute("data-episode-id"))).not.toEqual(firstIds);
  });

  it("pages in order instead of sampling once a dated sort is chosen", async () => {
    await render();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Sort memories"]')?.click();
    });
    await act(async () => {
      const options = document.querySelectorAll<HTMLButtonElement>('.history-filter-menu [role="menuitemradio"]');
      [...options].find((option) => option.textContent?.includes("Newest first"))?.click();
    });

    const lastCall = episodesList.mock.calls.at(-1)?.[0];
    expect(lastCall).toEqual(expect.objectContaining({ offset: 0 }));
    expect(lastCall?.shuffle).toBeFalsy();
    expect(document.querySelector(".shuffle-board")).toBeNull();
    expect(document.querySelector(".day-header")).not.toBeNull();
  });
});
