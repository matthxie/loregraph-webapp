// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../shared/api";
import type { EpisodeListRow } from "../shared/protocol";
import {
  getKnownTags,
  resetKnownTagsForTests,
  resetCreatedFoldersForTests,
  resetUserTagsForTests,
  setUserTags,
} from "../lib/tags";
import { HistoryPage } from "./HistoryPage";

const makeRow = (id: string, text: string, extra: Partial<EpisodeListRow> = {}) => ({
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
  ...extra,
}) satisfies EpisodeListRow;

const rowTagged = makeRow("ep_note_0001", "algebra set #homework", {
  entities: ["Mrs. Smith"],
  concepts: ["algebra", "Homework"],
});
const rowMath = makeRow("ep_note_0002", "calculus review #math");
const rowPlain = makeRow("ep_note_0003", "grocery run");

describe("HistoryPage card tag section", () => {
  let host: HTMLDivElement;
  let root: Root;

  const snapshot = {
    engine: { state: "running" },
    capabilities: {},
  } as StatusSnapshot;

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

  // Masonry packs cards into columns, so DOM order isn't list order — compare sorted.
  const visibleCards = () =>
    [...document.querySelectorAll('[aria-label^="history-card-"]')]
      .map((node) => node.getAttribute("aria-label"))
      .sort();

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
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockResolvedValue({ episodes: [rowTagged, rowMath, rowPlain], total: 3 }),
        search: vi.fn().mockResolvedValue({ episodes: [] }),
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

  it("keeps associations off board cards; they belong to the opened memory view", async () => {
    setUserTags({ [rowMath.id]: ["review"] });
    await render();
    expect(document.querySelector('[aria-label^="associations-"]')).toBeNull();
    expect(document.querySelector(".card .card-tag")).toBeNull();
    expect(document.querySelector(".card .card-folder-button")).toBeNull();
  });

  it("/search terms match USER spots only — entities/concepts and body text never answer", async () => {
    setUserTags({ [rowPlain.id]: ["errands"] });
    await render({ searchQuery: "/errands" });
    expect(visibleCards()).toEqual([`history-card-${rowPlain.id}`]);

    // "Homework" is a concept on rowTagged and "algebra" appears in its text — neither makes
    // the card answer for a spot filter (the guy-with-dog card must not match /test).
    await render({ searchQuery: "/algebra" });
    expect(visibleCards()).toEqual([]);
    expect(document.body.textContent).toContain("No cards with this tag");

    await render({ searchQuery: "/homework" }); // backfilled legacy hashtag → real spot
    expect(visibleCards()).toEqual([`history-card-${rowTagged.id}`]);

    await render({ searchQuery: "/math calculus" }); // spot ∩ text
    expect(visibleCards()).toEqual([`history-card-${rowMath.id}`]);

    await render({ searchQuery: "/homework /math" });
    expect(visibleCards()).toEqual([]);
    expect(document.body.textContent).toContain("No cards with these tags");
  });

  it("publishes only created tags (backfilled hashtags + adds) to the / popup, not entities/concepts", async () => {
    setUserTags({ [rowPlain.id]: ["errands"] });
    await render();
    expect(getKnownTags()).toEqual(["errands", "homework", "math"]);
  });
});
