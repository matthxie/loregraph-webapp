// @vitest-environment jsdom
/**
 * The `/folder` hand-off across the composer→board seam. A typed filing is queued at submit and
 * joined to its episode BY TEXT; the board is the one consumer, because a row id is the only key
 * its own reconcile can never prune.
 *
 * This is the race that makes that matter, and it is the one a loaded machine produces: the
 * daemon names the episode BEFORE the board has refetched, so every id the composer can file
 * under is still provisional — and the record drains out of the board's pending entries in the
 * same batch, so the new episode id is never announced either. The reconcile then meets a key it
 * has never heard of on a list it believes complete, and drops it. Consuming the queued filing
 * there spends it on a key that no longer exists: the row lands with no folder, for good.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../shared/api";
import type { EpisodeListRow } from "../shared/protocol";
import {
  getUserTags,
  resetCreatedFoldersForTests,
  resetKnownTagsForTests,
  resetPendingFilingsForTests,
  resetUserTagsForTests,
} from "../lib/tags";
import { HistoryPage } from "./HistoryPage";
import { InputPage, type PendingWriteEntry } from "./InputPage";

const NOTE = "first errand /work";
const EPISODE_ID = "ep_first_errand";

const makeRow = (id: string, text: string) => ({
  id,
  title: "",
  created_at: "2026-08-02T12:00:00Z",
  snippet: text,
  modality: "text",
  source: "capture",
  raw_text: text,
  media_paths: [],
  concepts: [],
  entities: [],
  graph_preview: { nodes: [], edges: [] },
}) satisfies EpisodeListRow;

const existingRow = makeRow("ep_older_note", "morning ritual note");
const errandRow = makeRow(EPISODE_ID, NOTE);

const snapshot = { engine: { state: "running" }, capabilities: {} } as StatusSnapshot;

describe("a typed /folder survives the composer→board hand-off", () => {
  let host: HTMLDivElement;
  let root: Root;
  /** What the board's episodesList answers with — swapped when the refetch is meant to land. */
  let episodes: EpisodeListRow[];

  const composer = () =>
    document.querySelector('textarea[aria-label="Add anything"]') as HTMLTextAreaElement;
  const sendButton = () => document.querySelector(".write-send.omnibar-send") as HTMLButtonElement;

  const typeComposer = async (value: string) => {
    await act(async () => {
      const element = composer();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  /**
   * App's wiring, minus the one thing this race turns on: the board is rendered WITHOUT the
   * composer's pending entries, standing in for the batch where a record is announced and drained
   * before the board ever renders it — which is what leaves the fresh episode id unshielded.
   */
  const render = async (refreshToken: number, pendingEntries: PendingWriteEntry[] = []) => {
    await act(async () => {
      root.render(
        <>
          <HistoryPage
            snapshot={snapshot}
            refreshToken={refreshToken}
            pendingEntries={pendingEntries}
            onOpenSettings={vi.fn()}
            onMutated={vi.fn()}
          />
          <InputPage focusToken={0} composerOnly />
        </>,
      );
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    resetKnownTagsForTests();
    resetUserTagsForTests();
    resetCreatedFoldersForTests();
    resetPendingFilingsForTests();
    episodes = [existingRow];
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
        episodesList: vi.fn(async () => ({ episodes, total: episodes.length })),
        search: vi.fn().mockResolvedValue({ episodes: [] }),
        writeAttachmentsGet: vi.fn().mockResolvedValue({ attachments: [] }),
        writeAttachmentsSync: vi.fn().mockResolvedValue({ attachments: [] }),
        // The daemon answers the capture with the episode already named, so the record carries
        // its episode id before any refetch — the ordering a slow board produces.
        capture: vi.fn().mockResolvedValue({
          status: "spooled",
          spoolId: "spool_first_errand",
          text: NOTE,
          at: "2026-08-02T12:00:00Z",
          episodeId: EPISODE_ID,
        }),
        inboxStatus: vi.fn().mockResolvedValue({ batch: null, last_receipts: [] }),
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    resetKnownTagsForTests();
    resetUserTagsForTests();
    resetCreatedFoldersForTests();
    resetPendingFilingsForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("files the folder when the row lands, though the board reconciled without it first", async () => {
    await render(0);
    await typeComposer(NOTE);
    await act(async () => sendButton().click());

    // A submitted block is sent once it has settled (3s), and comes back already named.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(window.graph.capture).toHaveBeenCalledTimes(1);
    expect(getUserTags()[EPISODE_ID]).toContain("work"); // shown early, on a key nothing has met

    // The board reconciles while its list is still the previous fetch: every key the composer
    // filed under is unknown to it, and a list it believes complete prunes what it doesn't know.
    await render(1);

    // The refetch lands. The filing is still queued, so the row claims it under its own id.
    episodes = [errandRow, existingRow];
    await render(2);

    expect(getUserTags()[EPISODE_ID]).toContain("work");
    const card = document.querySelector(`[aria-label="history-card-${EPISODE_ID}"]`);
    expect(card, "the note's card is on the board").not.toBeNull();
    expect([...card!.querySelectorAll(".card-folders-name")].map((chip) => chip.textContent))
      .toContain("work");
  });
});
