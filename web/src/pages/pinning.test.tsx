// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../shared/api";
import type { EpisodeListRow } from "../shared/protocol";
import { resetPinsForTests } from "../lib/pins";
import { CARD_DRAG_MIME } from "../lib/cardDrag";
import { greetingLabel, HistoryPage } from "./HistoryPage";

const rowA = {
  id: "ep_note_0001",
  title: "Tea",
  created_at: "2026-07-14T12:00:00Z",
  snippet: "tea",
  modality: "text",
  source: "capture",
  raw_text: "green tea in the morning",
  media_paths: [],
  concepts: ["tea"],
  entities: ["me"],
  graph_preview: { nodes: [], edges: [] },
} satisfies EpisodeListRow;

const rowB = {
  ...rowA,
  id: "ep_note_0002",
  title: "Coffee",
  snippet: "coffee",
  raw_text: "black coffee in the afternoon",
} satisfies EpisodeListRow;

const capabilities = {
  episodesList: true,
  episodeDelete: true,
  episodeReingest: true,
  searchNl: false,
  chatAnswer: true,
  coldImport: false,
  shuffle: true,
};

const snapshot = { engine: { state: "running" }, capabilities } as unknown as StatusSnapshot;

function mountGraph(
  episodes: EpisodeListRow[] | ReturnType<typeof vi.fn>,
  extra: Record<string, unknown> = {},
) {
  Object.defineProperty(window, "graph", {
    configurable: true,
    value: {
      episodesList: typeof episodes === "function"
        ? episodes
        : vi.fn().mockResolvedValue({ episodes, total: episodes.length }),
      search: vi.fn().mockResolvedValue({ episodes: [] }),
      episodeDelete: vi.fn().mockResolvedValue(undefined),
      ...extra,
    },
  });
}

function ctxMenuLabels(): (string | null)[] {
  return Array.from(document.querySelectorAll(".ctx-menu button")).map((b) => b.textContent);
}

/**
 * Assert the pin feature's contribution to the (shared) card context menu: exactly one of
 * Pin/Unpin per the pinned state, plus Edit/Delete. Deliberately does NOT assert the full menu —
 * other features add their own items to this menu, so an exact-match would be brittle.
 */
function expectMenuPinState(pinned: boolean): void {
  const labels = ctxMenuLabels();
  expect(labels).toContain(pinned ? "Unpin" : "Pin");
  expect(labels).not.toContain(pinned ? "Pin" : "Unpin");
  expect(labels).toEqual(expect.arrayContaining(["Edit", "Delete"]));
}

async function rightClick(root: Root, ariaLabel: string) {
  const card = document.querySelector(`[aria-label="${ariaLabel}"]`);
  expect(card, `card ${ariaLabel} should exist`).not.toBeNull();
  await act(async () => {
    card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 30 }));
  });
}

async function clickMenuItem(label: string) {
  const button = Array.from(document.querySelectorAll(".ctx-menu button"))
    .find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  expect(button, `menu item "${label}" should exist`).toBeTruthy();
  await act(async () => button!.click());
}

/** jsdom implements neither DataTransfer nor DragEvent — this is the slice the page uses. */
function dataTransferStub(): DataTransfer {
  const store = new Map<string, string>();
  return {
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    dropEffect: "none",
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

async function fireDrag(
  target: Element | null,
  type: string,
  dataTransfer: DataTransfer,
  point: { x: number; y: number } = { x: 0, y: 0 },
) {
  expect(target, `${type} target should exist`).not.toBeNull();
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientX: { value: point.x },
    clientY: { value: point.y },
  });
  await act(async () => void target!.dispatchEvent(event));
}

/** Stack the shelf's slots 100px apart in pin order, since jsdom measures everything as zero. */
function stubPinnedRects(order: string[]) {
  document.querySelectorAll<HTMLElement>("[data-pin-id]").forEach((element) => {
    const index = order.indexOf(element.dataset.pinId ?? "");
    const top = index * 100;
    element.getBoundingClientRect = () =>
      ({ left: 0, right: 200, top, bottom: top + 100, width: 200, height: 100, x: 0, y: top }) as DOMRect;
  });
}

function pinnedLabels(): (string | null)[] {
  return Array.from(document.querySelectorAll('.pinned-section [aria-label^="pinned-history-card-"]'))
    .map((card) => card.getAttribute("aria-label"));
}

describe("pinning", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    resetPinsForTests();
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
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function render(
    props: Partial<React.ComponentProps<typeof HistoryPage>> = {},
    { strict = false } = {},
  ) {
    const page = (
      <HistoryPage
        snapshot={snapshot}
        refreshToken={0}
        pendingEntries={[]}
        onOpenSettings={vi.fn()}
        onMutated={vi.fn()}
        {...props}
      />
    );
    await act(async () => {
      root.render(strict ? <React.StrictMode>{page}</React.StrictMode> : page);
    });
  }

  it("shows no Pinned section until something is pinned", async () => {
    mountGraph([rowA]);
    await render();
    expect(document.querySelector(".pinned-section")).toBeNull();
  });

  it("pins a card from the context menu, duplicating it under a Pinned section", async () => {
    mountGraph([rowA]);
    await render();

    await rightClick(root, `history-card-${rowA.id}`);
    expectMenuPinState(false);
    await clickMenuItem("Pin");

    const section = document.querySelector(".pinned-section");
    expect(section).not.toBeNull();
    expect(section?.querySelector(".day-header-label")?.textContent).toBe(greetingLabel());
    // The original stays in its day section; a live duplicate now sits under Pinned.
    expect(document.querySelector(`[aria-label="history-card-${rowA.id}"]`)).not.toBeNull();
    const pinnedCard = document.querySelector(`[aria-label="pinned-history-card-${rowA.id}"]`);
    expect(pinnedCard).not.toBeNull();
    // Pointer, not a copy: the pinned card renders the same underlying text as the original.
    expect(pinnedCard?.textContent).toContain("green tea in the morning");
    expect(pinnedCard?.classList.contains("card-pinned")).toBe(true);
  });

  it("toggles the menu label to Unpin and removes the section when unpinned", async () => {
    mountGraph([rowA]);
    await render();

    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");
    expect(document.querySelector(".pinned-section")).not.toBeNull();

    await rightClick(root, `history-card-${rowA.id}`);
    expectMenuPinState(true);
    await clickMenuItem("Unpin");
    expect(document.querySelector(".pinned-section")).toBeNull();
  });

  it("pins multiple cards, newest on top", async () => {
    mountGraph([rowA, rowB]);
    await render();

    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");
    await rightClick(root, `history-card-${rowB.id}`);
    await clickMenuItem("Pin");

    const pinnedCards = document.querySelectorAll('.pinned-section [aria-label^="pinned-history-card-"]');
    expect(pinnedCards.length).toBe(2);
    // Newest pin (B) renders before A within the pinned board.
    const labels = Array.from(pinnedCards).map((c) => c.getAttribute("aria-label"));
    expect(labels).toEqual([`pinned-history-card-${rowB.id}`, `pinned-history-card-${rowA.id}`]);
  });

  it("unpinning one of several pins leaves the others in place", async () => {
    mountGraph([rowA, rowB]);
    await render();

    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");
    await rightClick(root, `history-card-${rowB.id}`);
    await clickMenuItem("Pin");
    expect(document.querySelectorAll('.pinned-section [aria-label^="pinned-history-card-"]').length).toBe(2);

    // Unpin only B (from its pinned duplicate) — A must survive under Pinned.
    await rightClick(root, `pinned-history-card-${rowB.id}`);
    expectMenuPinState(true);
    await clickMenuItem("Unpin");

    expect(document.querySelector(`[aria-label="pinned-history-card-${rowB.id}"]`)).toBeNull();
    expect(document.querySelector(`[aria-label="pinned-history-card-${rowA.id}"]`)).not.toBeNull();
    expect(document.querySelector(".pinned-section")).not.toBeNull();
  });

  it("keeps a pinned card in place (as its skeleton) while its episode is mid-edit", async () => {
    mountGraph([rowA]);
    await render();
    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");

    // A reingest is queued but not yet materialized: the old episode still exists (rows unchanged),
    // and buildBoardItems substitutes a skeleton into A's slot. The pin must follow that skeleton.
    await render({
      pendingEntries: [{
        id: "edit:op-mid",
        replacesEpisodeId: rowA.id,
        text: "editing…",
        attachmentCount: 0,
        attachments: [],
        status: "processing" as const,
        episodeId: null,
        createdAt: Date.parse(rowA.created_at),
      }],
    });

    // Pinned section still present, now showing the reingest skeleton for the pinned card.
    expect(document.querySelector(".pinned-section")).not.toBeNull();
    expect(document.querySelector(`[aria-label="pinned-processing-card-edit:op-mid"]`)).not.toBeNull();
  });

  it("persists pins across a remount", async () => {
    mountGraph([rowA]);
    await render();
    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");
    await act(async () => root.unmount());

    // Fresh page instance — pins come back from localStorage and reconcile against the live list.
    root = createRoot(host);
    await render();
    expect(document.querySelector(`[aria-label="pinned-history-card-${rowA.id}"]`)).not.toBeNull();
  });

  it("follows a pin across an edit so the pinned card survives the id change", async () => {
    // First list load returns A; after the edit's refetch it returns B (the replacement).
    const episodesList = vi.fn()
      .mockResolvedValueOnce({ episodes: [rowA], total: 1 })
      .mockResolvedValue({ episodes: [rowB], total: 1 });
    mountGraph(episodesList);
    await render();

    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");
    expect(document.querySelector(`[aria-label="pinned-history-card-${rowA.id}"]`)).not.toBeNull();

    // The edit completes: a reingest replaced A with B (bump refreshToken → refetch → rows=[B]),
    // and the completed edit hint carries the A→B mapping.
    await render({
      refreshToken: 1,
      pendingEntries: [{
        id: "edit:op-1",
        replacesEpisodeId: rowA.id,
        text: rowB.raw_text ?? "",
        attachmentCount: 0,
        attachments: [],
        status: "done" as const,
        episodeId: rowB.id,
        createdAt: Date.parse(rowA.created_at),
      }],
    });

    expect(document.querySelector(`[aria-label="pinned-history-card-${rowA.id}"]`)).toBeNull();
    const migrated = document.querySelector(`[aria-label="pinned-history-card-${rowB.id}"]`);
    expect(migrated).not.toBeNull();
    expect(migrated?.textContent).toContain("black coffee in the afternoon");
  });

  it("opens an empty shelf while a board card is being dragged", async () => {
    mountGraph([rowA]);
    await render();
    expect(document.querySelector(".pinned-section")).toBeNull();

    const dataTransfer = dataTransferStub();
    await fireDrag(document.querySelector(`[aria-label="history-card-${rowA.id}"]`), "dragstart", dataTransfer);
    expect(document.querySelector(".pinned-section .pinned-empty")).not.toBeNull();

    // Dropping nowhere leaves the pins alone and closes the shelf again.
    await fireDrag(document.querySelector(`[aria-label="history-card-${rowA.id}"]`), "dragend", dataTransfer);
    expect(document.querySelector(".pinned-section")).toBeNull();
  });

  it("pins a card dragged from the board onto the shelf", async () => {
    mountGraph([rowA]);
    await render();

    const dataTransfer = dataTransferStub();
    const card = document.querySelector(`[aria-label="history-card-${rowA.id}"]`);
    await fireDrag(card, "dragstart", dataTransfer);
    expect(dataTransfer.getData(CARD_DRAG_MIME)).toContain(rowA.id);

    const shelf = document.querySelector(".pinned-section");
    await fireDrag(shelf, "dragover", dataTransfer);
    expect(shelf?.classList.contains("drop-active")).toBe(true);
    await fireDrag(shelf, "drop", dataTransfer);

    expect(pinnedLabels()).toEqual([`pinned-history-card-${rowA.id}`]);
    expect(document.querySelector(".pinned-section.drop-active")).toBeNull();
  });

  it("unpins a card dragged out of the shelf onto the board", async () => {
    mountGraph([rowA]);
    await render();
    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");

    const dataTransfer = dataTransferStub();
    await fireDrag(document.querySelector(`[aria-label="pinned-history-card-${rowA.id}"]`), "dragstart", dataTransfer);
    await fireDrag(document.querySelector(".history-page"), "drop", dataTransfer);

    expect(document.querySelector(".pinned-section")).toBeNull();
    expect(localStorage.getItem("ceb.prefs.pins")).toBe("[]");
  });

  it("reorders the shelf by dropping one pinned card above another", async () => {
    mountGraph([rowA, rowB]);
    await render();
    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");
    await rightClick(root, `history-card-${rowB.id}`);
    await clickMenuItem("Pin");
    expect(pinnedLabels()).toEqual([`pinned-history-card-${rowB.id}`, `pinned-history-card-${rowA.id}`]);

    // Drag A (slot 1) into the top half of slot 0 — it lands before B.
    stubPinnedRects([rowB.id, rowA.id]);
    const dataTransfer = dataTransferStub();
    await fireDrag(document.querySelector(`[aria-label="pinned-history-card-${rowA.id}"]`), "dragstart", dataTransfer);
    const shelf = document.querySelector(".pinned-section");
    await fireDrag(shelf, "drop", dataTransfer, { x: 100, y: 10 });

    expect(pinnedLabels()).toEqual([`pinned-history-card-${rowA.id}`, `pinned-history-card-${rowB.id}`]);
    // A drop inside the shelf must not reach the page's unpin handler.
    expect(JSON.parse(localStorage.getItem("ceb.prefs.pins") ?? "[]")).toEqual([rowA.id, rowB.id]);
  });

  it("holds pinned cards through a re-shuffle that drops them from the sample", async () => {
    // The board shows a sample of a much larger store, so a re-shuffle draws a different one.
    const episodesList = vi.fn()
      .mockResolvedValueOnce({ episodes: [rowA, rowB], total: 50 })
      .mockResolvedValue({ episodes: [rowB], total: 50 });
    const episodesByIds = vi.fn().mockResolvedValue({ episodes: [rowA], total: 1 });
    mountGraph(episodesList, { episodesByIds });
    await render();

    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");
    expect(pinnedLabels()).toEqual([`pinned-history-card-${rowA.id}`]);

    // New sample: A is not in the feed at all, so the shelf has to fetch it by id.
    await render({ refreshToken: 1 });
    await act(async () => {});
    expect(document.querySelector(`[aria-label="history-card-${rowA.id}"]`)).toBeNull();
    expect(episodesByIds).toHaveBeenCalledWith([rowA.id]);
    expect(pinnedLabels()).toEqual([`pinned-history-card-${rowA.id}`]);
  });

  it("hydrates pins on a cold load under StrictMode's double-invoked effects", async () => {
    // How the app actually mounts (main.tsx). The first effect run is torn down before its fetch
    // lands, so the second run has to reissue it.
    localStorage.setItem("ceb.prefs.pins", JSON.stringify([rowA.id]));
    resetPinsForTests();
    const episodesByIds = vi.fn().mockResolvedValue({ episodes: [rowA], total: 1 });
    mountGraph(vi.fn().mockResolvedValue({ episodes: [rowB], total: 50 }), { episodesByIds });

    await render({}, { strict: true });
    await act(async () => {});

    expect(episodesByIds).toHaveBeenCalledWith([rowA.id]);
    expect(pinnedLabels()).toEqual([`pinned-history-card-${rowA.id}`]);
  });

  it("holds the shelf steady while a re-shuffle re-fetches its rows", async () => {
    const episodesList = vi.fn()
      .mockResolvedValueOnce({ episodes: [rowA, rowB], total: 50 })
      .mockResolvedValue({ episodes: [rowB], total: 50 });
    const episodesByIds = vi.fn()
      .mockResolvedValueOnce({ episodes: [rowA], total: 1 })
      .mockReturnValue(new Promise(() => {})); // the re-shuffle's fetch never settles
    mountGraph(episodesList, { episodesByIds });
    await render();
    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");
    await act(async () => {});
    expect(pinnedLabels()).toEqual([`pinned-history-card-${rowA.id}`]);

    await render({ refreshToken: 1 });
    await act(async () => {});
    // Rows are due again, but the cached ones carry the shelf until the new ones land — no blink.
    expect(episodesByIds).toHaveBeenCalledTimes(2);
    expect(pinnedLabels()).toEqual([`pinned-history-card-${rowA.id}`]);
  });

  it("still narrows the shelf with the board when a search is running", async () => {
    const episodesList = vi.fn().mockResolvedValue({ episodes: [rowA, rowB], total: 50 });
    const episodesByIds = vi.fn().mockResolvedValue({ episodes: [rowA], total: 1 });
    mountGraph(episodesList, { episodesByIds });
    await render();
    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");

    // "coffee" matches B only — the pinned copy of A goes with the original.
    await render({ searchQuery: "coffee" });
    await act(async () => {});
    expect(document.querySelector(`[aria-label="history-card-${rowA.id}"]`)).toBeNull();
    expect(pinnedLabels()).toEqual([]);
  });

  it("drops the pin when the pinned episode is deleted", async () => {
    // After the delete refetch, the list no longer contains A.
    const episodesList = vi.fn()
      .mockResolvedValueOnce({ episodes: [rowA], total: 1 })
      .mockResolvedValue({ episodes: [], total: 0 });
    mountGraph(episodesList);
    await render();
    await rightClick(root, `history-card-${rowA.id}`);
    await clickMenuItem("Pin");
    expect(document.querySelector(".pinned-section")).not.toBeNull();

    // Refetch with an empty list (episode gone) → reconcile drops the now-dangling pin.
    await render({ refreshToken: 1 });
    expect(document.querySelector(".pinned-section")).toBeNull();
    expect(localStorage.getItem("ceb.prefs.pins")).toBe("[]");
  });
});
