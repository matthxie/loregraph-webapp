// @vitest-environment jsdom
/**
 * The board holds a shuffled sample, not the store, so a brand-new note usually never appears in
 * `rows` at all. The hand-off used to wait for exactly that — the filing sat queued forever and
 * the note landed in no collection. The announced episode id is the key that always arrives.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../shared/api";
import type { EpisodeListRow } from "../shared/protocol";
import {
  getUserTags,
  pushPendingFiling,
  resetCreatedFoldersForTests,
  resetKnownTagsForTests,
  resetPendingFilingsForTests,
  resetUserTagsForTests,
} from "../lib/tags";
import { HistoryPage } from "./HistoryPage";
import type { PendingWriteEntry } from "./InputPage";

const NOTE = "a new idea /work";
const EPISODE_ID = "ep_new_idea";

const sampled: EpisodeListRow[] = Array.from({ length: 10 }, (_, index) => ({
  id: `ep_sample_${index}`,
  title: "",
  created_at: "2026-08-02T12:00:00Z",
  snippet: `sampled ${index}`,
  modality: "text",
  source: "capture",
  raw_text: `sampled ${index}`,
  media_paths: [],
}));

const snapshot = {
  engine: { state: "running" },
  capabilities: { episodesList: true, shuffle: true },
} as unknown as StatusSnapshot;

const entry = (episodeId: string | null): PendingWriteEntry => ({
  id: "record-uuid",
  text: NOTE,
  attachmentCount: 0,
  attachments: [],
  status: episodeId ? "done" : "processing",
  episodeId,
  createdAt: 0,
});

describe("a typed /folder on a note the sample never shows", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    resetKnownTagsForTests();
    resetUserTagsForTests();
    resetCreatedFoldersForTests();
    resetPendingFilingsForTests();
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
        // 10 of 40 — and the new note is in neither the sample nor the count.
        episodesList: vi.fn(async () => ({ episodes: sampled, total: 40 })),
        search: vi.fn().mockResolvedValue({ episodes: [] }),
        episodesByIds: vi.fn().mockResolvedValue({ episodes: [] }),
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
    resetPendingFilingsForTests();
    vi.restoreAllMocks();
  });

  const render = async (pendingEntries: PendingWriteEntry[]) => {
    await act(async () => {
      root.render(
        <HistoryPage
          snapshot={snapshot}
          refreshToken={0}
          pendingEntries={pendingEntries}
          onOpenSettings={vi.fn()}
          onMutated={vi.fn()}
        />,
      );
    });
  };

  it("files under the announced episode id, without waiting for a row", async () => {
    pushPendingFiling({ text: NOTE, spots: ["work"] });
    await render([entry(null)]);
    expect(getUserTags()[EPISODE_ID]).toBeUndefined(); // nothing to file under yet

    await render([entry(EPISODE_ID)]);
    expect(getUserTags()[EPISODE_ID]).toContain("work");

    // And it survives the reconcile that follows, on a list that will never carry the note.
    await render([]);
    expect(getUserTags()[EPISODE_ID]).toContain("work");
  });
});
