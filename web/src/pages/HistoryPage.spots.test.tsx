// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../shared/api";
import type { EpisodeListRow } from "../shared/protocol";
import {
  getCreatedFolders,
  getKnownTags,
  getUserTags,
  resetCreatedFoldersForTests,
  resetKnownTagsForTests,
  resetUserTagsForTests,
  setUserTags,
} from "../lib/tags";
import { HistoryPage } from "./HistoryPage";

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

// Distinct ages so the sidebar's sort modes produce different orders: tea's newest card is
// rowTea (half a day old), coffee's newest is rowPlain (one day old).
const rowTea = makeRow("ep_note_0001", "morning #tea ritual", { created_at: iso(0.5) });
const rowBoth = makeRow("ep_note_0002", "#tea with #coffee later", { created_at: iso(2) });
const rowPlain = makeRow("ep_note_0003", "grocery run", { created_at: iso(1) });

describe("HistoryPage folders sidebar", () => {
  let host: HTMLDivElement;
  let root: Root;

  const snapshot = {
    engine: { state: "running" },
    capabilities: {},
  } as StatusSnapshot;

  const mountGraph = (episodes: EpisodeListRow[]) => {
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockResolvedValue({ episodes, total: episodes.length }),
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

  // Masonry packs cards into columns, so DOM order isn't list order — compare sorted.
  const visibleCards = () =>
    [...document.querySelectorAll('[aria-label^="history-card-"]')]
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

  const openRowMenu = async (name: string) => {
    await openSidebar();
    const button = document.querySelector(`[aria-label="More actions for ${name}"]`) as HTMLButtonElement | null;
    expect(button, `folder ${name}'s menu button should exist`).not.toBeNull();
    await act(async () => button!.click());
  };

  const clickMenuItem = async (label: string) => {
    const item = [...document.querySelectorAll(".spot-row-menu-list button")]
      .find((button) => button.textContent === label) as HTMLButtonElement | undefined;
    expect(item, `menu item "${label}" should exist`).not.toBeUndefined();
    await act(async () => item!.click());
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
    vi.useRealTimers();
  });

  it("lists one row per folder, count-desc then alphabetical; no counts shown; no folders → empty state", async () => {
    mountGraph([rowTea, rowBoth, rowPlain]);
    setUserTags({ [rowPlain.id]: ["coffee"] });
    await render();
    // Closed by default; the header toggle opens it and the board shifts over.
    expect(document.querySelector(".spots-sidebar")?.classList.contains("open")).toBe(false);
    await openSidebar();
    expect(document.querySelector(".history-page")?.classList.contains("sidebar-open")).toBe(true);
    // tea: rowTea + rowBoth; coffee: rowBoth hashtag + rowPlain manual add. Tie → alphabetical.
    expect(folderRows()).toEqual([
      { name: "coffee", selected: false },
      { name: "tea", selected: false },
    ]);
    // The card count is not rendered beside a folder.
    expect(document.querySelector(".spot-row-count")).toBeNull();

    // A board with no user-created tags shows the how-to empty state (entities don't count).
    await act(async () => root.unmount());
    localStorage.clear();
    resetUserTagsForTests();
    resetCreatedFoldersForTests(); // folders are durable — drop the module cache with the storage
    mountGraph([makeRow("ep_note_0009", "plain note", { entities: ["Mrs. Smith"], concepts: ["algebra"] })]);
    root = createRoot(host);
    await render();
    await openSidebar();
    expect(folderRows()).toEqual([]);
    expect(document.querySelector(".spots-sidebar-empty")?.textContent).toContain("No folders yet");
  });

  it("sort toggles reorder folders: A–Z default, newest by freshest card, oldest reversed", async () => {
    mountGraph([rowTea, rowBoth, rowPlain]);
    setUserTags({ [rowPlain.id]: ["coffee"] });
    await render();
    await openSidebar();
    const names = () => folderRows().map((row) => row.name);
    // The sort options live behind the hover filter — open it, then pick.
    const openFilterMenu = async () => {
      await act(async () => (document.querySelector('[aria-label="Sort folders"]') as HTMLButtonElement).click());
    };
    const pickSort = async (mode: string) => {
      await openFilterMenu();
      await act(async () => (document.querySelector(`[aria-label="sort-folders-${mode}"]`) as HTMLButtonElement).click());
    };
    // Default alphabetical.
    await openFilterMenu();
    expect(document.querySelector('[aria-label="sort-folders-alpha"]')?.getAttribute("aria-checked")).toBe("true");
    await openFilterMenu(); // close it again (toggle)
    expect(names()).toEqual(["coffee", "tea"]);
    // Newest: tea's freshest card (rowTea, 0.5d) beats coffee's (rowPlain, 1d).
    await pickSort("new");
    expect(names()).toEqual(["tea", "coffee"]);
    // Oldest: reversed.
    await pickSort("old");
    expect(names()).toEqual(["coffee", "tea"]);
    // The choice persists in localStorage for the next mount.
    expect(localStorage.getItem("graph.history.folders-sort.v1")).toBe("old");
  });

  it("plain click goes to one folder; shift-click intersects; clicking the active one clears", async () => {
    mountGraph([rowTea, rowBoth, rowPlain]);
    setUserTags({ [rowPlain.id]: ["coffee"] });
    await render();
    expect(visibleCards()).toEqual([
      `history-card-${rowTea.id}`,
      `history-card-${rowBoth.id}`,
      `history-card-${rowPlain.id}`,
    ].sort());

    // Plain click GOES TO tea.
    await clickChip("tea");
    expect(folderRows().find((row) => row.name === "tea")?.selected).toBe(true);
    expect(visibleCards()).toEqual([`history-card-${rowTea.id}`, `history-card-${rowBoth.id}`].sort());

    // Shift-click ADDS coffee — now an intersection, only the card carrying BOTH stays.
    await clickChip("coffee", { shift: true });
    expect(folderRows().find((row) => row.name === "coffee")?.selected).toBe(true);
    expect(visibleCards()).toEqual([`history-card-${rowBoth.id}`]);

    // Plain click on coffee REPLACES the selection with just coffee (tea drops).
    await clickChip("coffee");
    expect(folderRows().find((row) => row.name === "tea")?.selected).toBe(false);
    expect(folderRows().find((row) => row.name === "coffee")?.selected).toBe(true);
    expect(visibleCards()).toEqual([`history-card-${rowBoth.id}`, `history-card-${rowPlain.id}`].sort());

    // Plain click on the sole active folder clears the filter → full board.
    await clickChip("coffee");
    expect(visibleCards()).toEqual([
      `history-card-${rowTea.id}`,
      `history-card-${rowBoth.id}`,
      `history-card-${rowPlain.id}`,
    ].sort());
  });

  it("New folder creates an empty folder: sanitized name, listed, selectable, autocompletable", async () => {
    mountGraph([rowPlain]);
    await render();
    await openSidebar();

    await act(async () => (document.querySelector('[aria-label="new-folder"]') as HTMLButtonElement).click());
    const input = document.querySelector('[aria-label="new-folder-name"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    // Folder names can never contain a slash — the character doesn't type.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Read/ing List");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("Reading-List");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    // The empty folder shows as a row (lowercased), persists, and feeds the / autocomplete.
    expect(folderRows().find((row) => row.name === "reading-list")).toBeTruthy();
    expect(getCreatedFolders()).toEqual(["reading-list"]);
    expect(getKnownTags()).toContain("reading-list");

    // Selecting it filters the board to its (zero) cards.
    await clickChip("reading-list");
    expect(visibleCards()).toEqual([]);
  });

  it("drag-resizing the sidebar clamps to the sort-chips floor and persists the width", async () => {
    mountGraph([rowTea, rowBoth, rowPlain]);
    setUserTags({ [rowPlain.id]: ["coffee"] });
    await render();
    await openSidebar();

    const sidebar = () => document.querySelector(".spots-sidebar") as HTMLElement;
    const handle = document.querySelector('[aria-label="resize-folders-sidebar"]') as HTMLElement;
    expect(handle).not.toBeNull();

    const drag = async (toX: number) => {
      await act(async () => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: toX }));
        window.dispatchEvent(new PointerEvent("pointerup", {}));
      });
    };

    await drag(320);
    expect(sidebar().style.width).toBe("320px");
    expect(document.querySelector<HTMLElement>(".history-page")?.style.marginLeft).toBe("320px");
    expect(localStorage.getItem("graph.history.folders-sidebar-width.v1")).toBe("320");

    // Below the floor (the sort chips must always fit) → clamps to 190.
    await drag(80);
    expect(sidebar().style.width).toBe("190px");
    expect(localStorage.getItem("graph.history.folders-sidebar-width.v1")).toBe("190");
  });

  it("keeps a folder listed once its cards arrive, and keeps it standing when they leave", async () => {
    mountGraph([rowTea, rowBoth, rowPlain]);
    localStorage.setItem("ceb.prefs.created-folders", JSON.stringify(["someday"]));
    resetCreatedFoldersForTests();
    await render();
    // Folders the cards carry join the durable list beside the empty "someday".
    expect(getCreatedFolders().sort()).toEqual(["coffee", "someday", "tea"]);
    await openSidebar();
    expect(folderRows().map((row) => row.name)).toEqual(["coffee", "someday", "tea"]);

    // Unfiling every card in a folder leaves it EMPTY, not gone — only Delete folder removes it.
    await act(async () => setUserTags({ [rowBoth.id]: ["coffee"] }));
    expect(folderRows().map((row) => row.name)).toEqual(["coffee", "someday", "tea"]);
    expect(getCreatedFolders()).toContain("tea");
  });

  it("sidebar selection composes with /tag search terms and feeds the no-matches empty state", async () => {
    mountGraph([rowTea, rowBoth, rowPlain]);
    await render({ searchQuery: "/coffee" });
    expect(visibleCards()).toEqual([`history-card-${rowBoth.id}`]);

    // Selecting a folder narrows WITHIN the search's tag filter (intersection, not replace).
    await clickChip("tea");
    expect(visibleCards()).toEqual([`history-card-${rowBoth.id}`]);

    // An impossible combination (tea still selected in the sidebar) empties the board and
    // the no-matches empty state accounts for the sidebar selection too.
    await render({ searchQuery: "/coffee /ritual" }); // no card carries a "ritual" tag
    expect(visibleCards()).toEqual([]);
    expect(document.body.textContent).toContain("No cards with these tags");
  });

  it("deletes a folder after confirming and keeps every entry that was in it", async () => {
    mountGraph([rowTea, rowBoth, rowPlain]);
    setUserTags({ [rowTea.id]: ["tea"], [rowBoth.id]: ["tea", "coffee"], [rowPlain.id]: ["coffee"] });
    const episodeDelete = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        episodesList: vi.fn().mockResolvedValue({ episodes: [rowTea, rowBoth, rowPlain], total: 3 }),
        search: vi.fn().mockResolvedValue({ episodes: [] }),
        episodeDelete,
      },
    });
    await render({ snapshot: { engine: { state: "running" }, capabilities: { episodeDelete: true } } as StatusSnapshot });

    await openRowMenu("tea");
    await clickMenuItem("Delete folder…");
    expect(document.body.textContent).toContain("Delete the folder “tea”?");
    expect(document.body.textContent).toContain("Its 2 entries stay on the board");

    const confirm = [...document.querySelectorAll(".overlay-panel button")]
      .find((button) => button.textContent === "Delete folder") as HTMLButtonElement;
    await act(async () => confirm.click());

    // The folder is gone; not one entry was deleted, and a card filed elsewhere keeps that filing.
    expect(episodeDelete).not.toHaveBeenCalled();
    expect(visibleCards()).toEqual(
      [`history-card-${rowTea.id}`, `history-card-${rowBoth.id}`, `history-card-${rowPlain.id}`].sort(),
    );
    expect(getUserTags()).toEqual({ [rowBoth.id]: ["coffee"], [rowPlain.id]: ["coffee"] });
    await openSidebar();
    expect(folderRows()).toEqual([{ name: "coffee", selected: false }]);
  });

  it("offers deleting the folder as the row menu's only action, ungated by the engine", async () => {
    mountGraph([rowTea, rowBoth, rowPlain]);
    await render(); // default snapshot: capabilities: {} → the engine can't delete entries
    await openRowMenu("tea");
    const items = [...document.querySelectorAll<HTMLButtonElement>(".spot-row-menu-list button")];
    expect(items.map((item) => item.textContent)).toEqual(["Delete folder…"]);
    // Nothing is destroyed by unfiling, so the action doesn't wait on an engine capability.
    expect(items[0]!.disabled).toBe(false);
  });

  it("puts each card's folders on the card, collapsing four or more to two plus a count", async () => {
    // Hashtag-free rows: the legacy backfill would file extra folders of its own.
    const four = makeRow("ep_card_0001", "cell membranes");
    const two = makeRow("ep_card_0002", "lecture notes");
    const none = makeRow("ep_card_0003", "grocery run");
    mountGraph([four, two, none]);
    setUserTags({
      [four.id]: ["bio", "class", "reading", "misc"],
      [two.id]: ["bio", "class"],
    });
    await render();

    const line = (id: string) =>
      document.querySelector(`[aria-label="history-card-${id}"] .card-folders`)?.textContent;
    expect(line(four.id)).toBe("inbio,class,+2 more");
    expect(line(two.id)).toBe("inbio,class");
    // A card in no folder gets no line at all — a board at rest stays quiet.
    expect(line(none.id)).toBeUndefined();
  });
});
