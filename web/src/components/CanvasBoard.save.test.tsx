// @vitest-environment jsdom
/**
 * The canvas saves on a debounce, and a whole document per save. The regression here is a save
 * PER EDIT: `flush` used to close over `doc`, so the unmount effect that guards the last edit was
 * re-created — and its cleanup fired — on every change. Those saves race, each carrying an etag
 * the one before it already invalidated, and the board blinks "canvas changed elsewhere".
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodeListRow } from "../shared/protocol";
import { emptyCanvas } from "../lib/canvas";
import { CanvasBoard } from "./CanvasBoard";

const row = (id: string) => ({
  id,
  title: "",
  created_at: "2026-08-02T12:00:00Z",
  snippet: id,
  modality: "text",
  source: "capture",
  raw_text: id,
  media_paths: [],
}) satisfies EpisodeListRow;

describe("canvas autosave", () => {
  let host: HTMLDivElement;
  let root: Root;
  let canvasSave: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    let version = 0;
    canvasSave = vi.fn(async (_collection: string, _doc: unknown, etag: string | null) => {
      // The service the contract describes: a stale etag is a conflict, not a silent overwrite.
      if (etag !== `v${version}`) throw new Error("canvas changed elsewhere");
      version += 1;
      return { etag: `v${version}` };
    });
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: { canvasGet: vi.fn(async () => ({ doc: emptyCanvas(), etag: "v0" })), canvasSave },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const show = async (ids: string[]) => {
    await act(async () => {
      root.render(
        <CanvasBoard
          collection="board"
          episodeIds={ids}
          rows={new Map(ids.map((id) => [id, row(id)]))}
          tags={{}}
        />,
      );
    });
  };

  it("writes once for a burst of edits, and never on a stale etag", async () => {
    await show(["ep_1"]);
    await show(["ep_1", "ep_2"]);
    await show(["ep_1", "ep_2", "ep_3"]);
    await show(["ep_1", "ep_2", "ep_3", "ep_4"]);
    expect(canvasSave).not.toHaveBeenCalled(); // still inside the debounce

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(canvasSave).toHaveBeenCalledTimes(1);
    expect(canvasSave.mock.calls[0]?.[2]).toBe("v0");
    expect(document.querySelector(".canvas-error")).toBeNull();
    expect(document.querySelectorAll(".canvas-card")).toHaveLength(4);
  });

  it("still saves the last edit when the canvas is left", async () => {
    await show(["ep_1"]);
    await act(async () => root.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(canvasSave).toHaveBeenCalledTimes(1);
    root = createRoot(host); // afterEach unmounts
  });
});
