/**
 * Memory board: everything the user has written, shown as a Pinterest-style card —
 * image attachments stacked on top, text below. Search plus New | Old | Random sort,
 * Today/Yesterday day sections, shortest-column-first packing (1–5 responsive columns),
 * linkified snippets, right-click Edit / Delete (capability gated), detail
 * overlay via EpisodeOverlay, refetch after drains and lifecycle ops.
 *
 * Search filters the loaded rows client-side (historySearch: text, title, description,
 * entities/concepts, file types) and unions the engine's own hits in, ranked first. A lookup
 * ("kyoto", "pdf receipts") asks §3.4 `search` (BM25); a question ("what did I say about the
 * gym") asks §9.5 `search.nl`, which fuses the semantic graph walk with BM25 — fail-soft, so
 * a stub or older engine degrades to local filtering alone.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { StatusSnapshot } from "../shared/api";
import type { EpisodeListRow } from "../shared/protocol";
import { isSentenceQuery, matchesHistorySearch } from "../lib/historySearch";
import {
  columnCountForWidth,
  dayKey,
  estimateCardHeight,
  groupByDay,
  packBalancedColumns,
  reshuffle,
  stickyShuffleOrder,
  SHUFFLE_SIZE,
  type HistorySortMode,
} from "../lib/historySort";
import { linkifySegments, markdownToSnippet, previewText } from "../lib/format";
import {
  addCreatedFolder,
  addUserTag,
  backfillHashtagUserTags,
  deleteFolder,
  hasAllTags,
  knownCreatedTags,
  pruneHiddenFolders,
  pruneOnlyFolders,
  reconcileUserTags,
  registerFolders,
  setFolderHidden,
  setFolderOnly,
  setFolderVisibilityMode,
  setKnownTags,
  splitSearchTags,
  spotNames,
  stripTags,
  takePendingFiling,
  updateUserTags,
  useCreatedFolders,
  useFolderVisibility,
  useHiddenFolders,
  useUserTags,
} from "../lib/tags";
import { reconcilePins, updatePins, usePins } from "../lib/pins";
import { CardDevView } from "../components/CardDevView";
import { CardFolderPicker } from "../components/CardFolderPicker";
import { CardFolders } from "../components/CardFolders";
import { RichLinkPreview } from "../components/LinkPreview";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SpotsSidebar, spotCounts } from "../components/SpotsSidebar";
import type { EpisodeEdit } from "../App";
import type { PendingWriteEntry } from "./InputPage";

export interface EpisodeScrollRequest {
  id: string;
  requestId: number;
}

/** Set once the pre-map hashtag rows have been copied into the UserTagMap (full list only). */
const TAGS_BACKFILL_KEY = "graph.history.tags.backfill.v1";

/** How many rows the dated modes pull in one go. */
const PAGE_SIZE = 200;

const SORT_LABELS: Record<HistorySortMode, string> = {
  shuffle: "Shuffled",
  new: "Newest first",
  old: "Oldest first",
  random: "Random",
};

/** Folders sidebar open/closed, persisted across sessions. */
const SIDEBAR_OPEN_KEY = "graph.history.folders-sidebar.v1";

/** Folders sidebar width in px, persisted across sessions (drag the right edge). */
const SIDEBAR_WIDTH_KEY = "graph.history.folders-sidebar-width.v1";

function cardHasSelectedText(card: HTMLElement): boolean {
  const selection = window.getSelection();
  return Boolean(
    selection &&
    !selection.isCollapsed &&
    selection.toString() &&
    selection.anchorNode &&
    selection.focusNode &&
    card.contains(selection.anchorNode) &&
    card.contains(selection.focusNode),
  );
}

function mediaUrl(mediaPath: string): string | null {
  return window.graph.mediaUrl(mediaPath);
}

function isImage(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i.test(p);
}

interface CtxMenu {
  x: number;
  y: number;
  episodeId?: string;
  pendingId?: string;
}

/**
 * The stable episode identity a board item pins to: a real card pins to its episode id; a card
 * that's mid-edit (its slot shows the reingest skeleton) pins to the episode being replaced, so a
 * pinned card keeps its place while the user edits it. Fresh captures have no episode yet → null.
 */
/** Outline folder — the shared mark for spots, same path as the sidebar/picker glyphs. */
function FolderGlyph() {
  return (
    <svg className="folder-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function boardItemEpisodeId(item: HistoryBoardItem): string | null {
  if (item.kind === "real") return item.row?.id ?? null;
  return item.pending?.replacesEpisodeId ?? null;
}

type DeleteTarget = { kind: "episode" | "pending"; id: string };

interface HistoryBoardItem {
  id: string;
  created_at: string;
  raw_text: string | null;
  media_paths: string[];
  graph_preview?: EpisodeListRow["graph_preview"];
  kind: "real" | "pending";
  row?: EpisodeListRow;
  pending?: PendingWriteEntry;
  materializing?: boolean;
}

/** Hide a daemon result that committed in the same instant its processing card was deleted. */
export function pendingDeleteShieldsRow(entry: PendingWriteEntry, row: EpisodeListRow): boolean {
  if (!entry.hidden) return false;
  if (entry.episodeId === row.id) return true;
  const rowCreatedAt = Date.parse(row.created_at);
  return row.raw_text === entry.text &&
    Number.isFinite(rowCreatedAt) &&
    Math.abs(rowCreatedAt - entry.createdAt) <= 60_000;
}

/**
 * Masonry columns with shortest-column-first packing. Card heights are re-measured after layout
 * (rich link previews load late and change a card's height) and fed back into the packer so later
 * entries fill whichever lane is actually open.
 */
function MasonryBoard({
  items,
  columns,
  columnWidth,
  renderCard,
  devView = false,
}: {
  items: HistoryBoardItem[];
  columns: number;
  columnWidth: number;
  renderCard: (item: HistoryBoardItem) => React.ReactNode;
  /** Cards carry the dev panel, so the first-guess heights have to account for it. */
  devView?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const measuredHeightsRef = useRef(new Map<string, number>());
  const [measurementRevision, setMeasurementRevision] = useState(0);

  const cols = useMemo(() => packBalancedColumns(
    items,
    columns,
    (item) => measuredHeightsRef.current.get(item.id) ?? estimateCardHeight(item, columnWidth, devView),
    Math.max(120, columnWidth * 0.55),
  ), [items, columns, columnWidth, measurementRevision, devView]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      const nextHeights = new Map<string, number>();
      for (const item of items) {
        const card = cardRefs.current.get(item.id);
        if (!card) continue;
        // Include the 12px .masonry-col gap before the following card; otherwise columns
        // with more short cards drift tall.
        nextHeights.set(item.id, Math.round(card.getBoundingClientRect().height) + 12);
      }
      const previous = measuredHeightsRef.current;
      const heightsChanged = previous.size !== nextHeights.size || [...nextHeights].some(
        ([id, height]) => previous.get(id) !== height,
      );
      if (heightsChanged) {
        measuredHeightsRef.current = nextHeights;
        setMeasurementRevision((revision) => revision + 1);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    cardRefs.current.forEach((element) => observer.observe(element));
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [cols, columns, items]);

  const attach = (node: React.ReactNode, key: string): React.ReactNode => {
    if (!React.isValidElement(node)) return node;
    return React.cloneElement(node as React.ReactElement<React.RefAttributes<HTMLElement>>, {
      ref: (element: HTMLElement | null) => {
        if (element) cardRefs.current.set(key, element);
        else cardRefs.current.delete(key);
      },
    });
  };

  return (
    <div className="masonry" ref={rootRef}>
      {cols.map((col, index) => (
        // Explicit width, not flex:1. A fluid column tracks the container, and the container
        // spends 620ms animating when the chat drawer opens — so every frame rewrapped the
        // card text, changed its height, and sent the packer hunting for a new balance. Cards
        // visibly hopped lanes. Pinned to the width the board settles at, nothing reflows.
        <div key={index} className="masonry-col" style={{ width: columnWidth, flex: "none" }}>
          {col.map((item) => (
            <React.Fragment key={item.id}>
              {attach(renderCard(item), item.id)}
            </React.Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}

export function HistoryPage({
  snapshot,
  refreshToken,
  pendingEntries,
  onOpenSettings,
  onMutated,
  onEpisodeEdited,
  searchQuery = "",
  scrollToEpisode = null,
  onInitialLoadSettled,
  onActiveFolderChange,
  cardDevView = false,
}: {
  snapshot: StatusSnapshot | null;
  /** Bumped by the shell after drains / lifecycle mutations → refetch. */
  refreshToken: number;
  pendingEntries: PendingWriteEntry[];
  /** An edit was queued against a stored note — the shell tracks its reingest. */
  onEpisodeEdited?: (edit: EpisodeEdit) => void;
  onOpenSettings: () => void;
  /** A delete completed — bump the shell's refresh token to refetch. */
  onMutated: () => void;
  /** Live filter for the board, driven by the omnibar's search mode. */
  searchQuery?: string;
  /** Ask citation navigation: reveal this episode's original card in the board. */
  scrollToEpisode?: EpisodeScrollRequest | null;
  /** First page (or its actionable error) resolved; the shell may reveal the complete UI. */
  onInitialLoadSettled?: () => void;
  /** The single folder currently being viewed (exactly one rail spot selected), else null —
      lets the shell pre-fill the composer with `/folder` so a note added here files itself. */
  onActiveFolderChange?: (folder: string | null) => void;
  /** Already gated by lib/devTools.ts `cardDevViews` — every card grows its inspection panel. */
  cardDevView?: boolean;
}) {
  const [rows, setRows] = useState<EpisodeListRow[] | null>(null);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<HistorySortMode>("shuffle");
  /** Re-rolled only by the Shuffle button, so the sample holds still across refetches. */
  const [shuffleSeed, setShuffleSeed] = useState(() => Math.random().toString(36).slice(2));
  const [filterOpen, setFilterOpen] = useState(false);
  /** The folder-visibility dropdown (Only show / Don't show), beside the sort filter. */
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const query = searchQuery;
  /** §9.5 `search.nl` — natural-language search. Probe-discovered, so it is off against an
   *  older daemon or an engine that predates it, and search falls back to BM25 alone. */
  const canSearchNl = snapshot?.capabilities?.searchNl ?? false;
  /**
   * The daemon's hits for the current query, id → rank. The RANK is the point: the engine
   * returns its matches best-first, and a search board that re-sorted them by date threw that
   * away — so the closest match could land anywhere on the board. Null = no hits, or the
   * engine could not answer.
   */
  const [engineHits, setEngineHits] = useState<Map<string, number> | null>(null);
  const [shuffleOrder, setShuffleOrder] = useState<string[]>([]);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const pinnedIds = usePins();
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<DeleteTarget | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ id: string; text: string } | null>(null);
  /** Editing a STORED note. The detail overlay is gone; a note is only ever its own text. */
  const [episodeEdit, setEpisodeEdit] = useState<{ id: string; text: string } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  /** Which card's folder picker is open, opened from its ⋯ menu. */
  const [folderPickerFor, setFolderPickerFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** `count` is how many entries the folder holds — they stay; only the filing goes. */
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<{ name: string; count: number } | null>(null);
  /** The board's container, measured clear of the animating margins. */
  const [containerWidth, setContainerWidth] = useState(1000);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const filterCloseTimerRef = useRef<number | null>(null);
  const visibilityRef = useRef<HTMLDivElement | null>(null);
  const visibilityCloseTimerRef = useRef<number | null>(null);
  /** Latest rows for effects that must not re-run when the list changes. */
  const rowsRef = useRef<EpisodeListRow[]>([]);
  useEffect(() => {
    rowsRef.current = rows ?? [];
  }, [rows]);
  const initialLoadSettledRef = useRef(false);
  const handledEpisodeScrollRef = useRef<number | null>(null);
  const spotlightTimerRef = useRef<number | null>(null);
  const [spotlightEpisodeId, setSpotlightEpisodeId] = useState<string | null>(null);

  const settleInitialLoad = useCallback(() => {
    if (initialLoadSettledRef.current) return;
    initialLoadSettledRef.current = true;
    onInitialLoadSettled?.();
  }, [onInitialLoadSettled]);

  const engineRunning = snapshot?.engine.state === "running";
  const todayKey = dayKey(new Date().toISOString());

  const selectSort = useCallback((nextMode: HistorySortMode) => {
    if (nextMode === "random") setShuffleOrder(rows ? reshuffle(rows) : []);
    setMode(nextMode);
  }, [rows]);

  const cancelFilterClose = useCallback(() => {
    if (filterCloseTimerRef.current === null) return;
    window.clearTimeout(filterCloseTimerRef.current);
    filterCloseTimerRef.current = null;
  }, []);

  const openFilter = useCallback(() => {
    cancelFilterClose();
    setFilterOpen(true);
  }, [cancelFilterClose]);

  const closeFilter = useCallback(() => {
    cancelFilterClose();
    setFilterOpen(false);
  }, [cancelFilterClose]);

  const scheduleFilterClose = useCallback(() => {
    cancelFilterClose();
    filterCloseTimerRef.current = window.setTimeout(() => {
      filterCloseTimerRef.current = null;
      setFilterOpen(false);
    }, 200);
  }, [cancelFilterClose]);

  const cancelVisibilityClose = useCallback(() => {
    if (visibilityCloseTimerRef.current === null) return;
    window.clearTimeout(visibilityCloseTimerRef.current);
    visibilityCloseTimerRef.current = null;
  }, []);

  const openVisibility = useCallback(() => {
    cancelVisibilityClose();
    setVisibilityOpen(true);
  }, [cancelVisibilityClose]);

  const closeVisibility = useCallback(() => {
    cancelVisibilityClose();
    setVisibilityOpen(false);
  }, [cancelVisibilityClose]);

  const scheduleVisibilityClose = useCallback(() => {
    cancelVisibilityClose();
    visibilityCloseTimerRef.current = window.setTimeout(() => {
      visibilityCloseTimerRef.current = null;
      setVisibilityOpen(false);
    }, 200);
  }, [cancelVisibilityClose]);

  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  // Tag filtering: `/tag` tokens typed into search, intersected — a card must carry all of
  // them. The remaining search text keeps the normal text-search behavior.
  const searchSplit = useMemo(() => splitSearchTags(query), [query]);
  /** Spots toggled on the rail — lowercased, composed into activeTags below. */
  const [selectedSpots, setSelectedSpots] = useState<string[]>([]);

  // A cited memory can currently be hidden by a folder selection. Clear that local filter
  // first; App clears the omnibar query in the same navigation transaction.
  useEffect(() => {
    if (!scrollToEpisode) return;
    setSelectedSpots([]);
  }, [scrollToEpisode]);

  useEffect(() => {
    if (
      !scrollToEpisode ||
      !rows ||
      query.trim().length > 0 ||
      selectedSpots.length > 0 ||
      handledEpisodeScrollRef.current === scrollToEpisode.requestId
    ) return;

    const timer = window.setTimeout(() => {
      const card = [...(wrapRef.current?.querySelectorAll<HTMLElement>("[data-episode-id]") ?? [])]
        .find((candidate) => candidate.dataset.episodeId === scrollToEpisode.id);
      if (!card) return;
      handledEpisodeScrollRef.current = scrollToEpisode.requestId;
      setSpotlightEpisodeId(null);
      card.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
      const revealSpotlight = () => setSpotlightEpisodeId(scrollToEpisode.id);
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(revealSpotlight);
      else revealSpotlight();
      if (spotlightTimerRef.current !== null) window.clearTimeout(spotlightTimerRef.current);
      spotlightTimerRef.current = window.setTimeout(() => {
        spotlightTimerRef.current = null;
        setSpotlightEpisodeId(null);
      }, 1_800);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [query, rows, scrollToEpisode, selectedSpots]);

  useEffect(() => () => {
    if (spotlightTimerRef.current !== null) window.clearTimeout(spotlightTimerRef.current);
  }, []);
  // Rail-selected spots COMPOSE with `/tag` search terms into one intersection set — a card
  // must carry ALL of them; selecting a spot never replaces a typed tag filter.
  const activeTags = useMemo(
    () => [...new Set([...searchSplit.tags, ...selectedSpots])],
    [searchSplit.tags, selectedSpots],
  );
  /** Manually-added tags per episode (the detail view's + button). */
  const userTags = useUserTags();
  /** AI-authored chat summaries carry a durable source marker from the engine. Project it into
      the same visible/filterable tag system without pretending it was manually filed. */
  const displayTags = useMemo(() => {
    if (!rows?.some((row) => row.source === "assistant")) return userTags;
    const next = { ...userTags };
    for (const row of rows) {
      if (row.source !== "assistant") continue;
      const existing = next[row.id] ?? [];
      if (!existing.some((tag) => tag.toLowerCase() === "ai")) next[row.id] = [...existing, "AI"];
    }
    return next;
  }, [rows, userTags]);
  const createdFolders = useCreatedFolders();
  /** Sidebar rows: card-backed folders (the UserTagMap on live cards) plus created-but-empty
      ones from the "New folder" button, which show with no cards until their first filing. */
  const spots = useMemo(() => {
    const backed = spotCounts(rows ?? [], displayTags);
    const backedNames = new Set(backed.map((spot) => spot.name));
    return [
      ...backed,
      ...createdFolders.filter((name) => !backedNames.has(name))
        .map((name) => ({ name, count: 0, newest: "" })),
    ];
  }, [rows, displayTags, createdFolders]);
  // A chat-requested rename/delete can invalidate the rail's local selection. Never leave
  // the board filtered by a folder that no longer exists.
  useEffect(() => {
    const available = new Set(spots.map((spot) => spot.name));
    setSelectedSpots((current) => {
      const kept = current.filter((name) => available.has(name));
      return kept.length === current.length ? current : kept;
    });
  }, [spots]);
  /** Folders muted from the default (no-selection) board view — explicit selection always
      overrides this, whether via the rail or a typed `/tag` search term. */
  const hiddenFolders = useHiddenFolders();
  const hiddenSet = useMemo(() => new Set(hiddenFolders), [hiddenFolders]);
  /** The toolbar dropdown's mode and its "only" checklist ("dont" shares hiddenFolders). */
  const folderVisibility = useFolderVisibility();
  const onlySet = useMemo(
    () => (folderVisibility.mode === "only" ? new Set(folderVisibility.only) : new Set<string>()),
    [folderVisibility],
  );
  // Folders are durable now (deleteFolder is the one remover), so a hide or an "only" check
  // only goes stale when its folder is explicitly deleted — prune both lists against the
  // rail's list of existing folders.
  useEffect(() => {
    const existing = new Set(spots.map((spot) => spot.name));
    pruneHiddenFolders(existing);
    pruneOnlyFolders(existing);
  }, [spots]);
  // A folder exists until it is deleted. Every folder a card carries is recorded in the folder
  // list, so unfiling the last card (or deleting that card) leaves the folder behind, empty —
  // it never disappears on its own. Registered from the USER map, so the synthetic AI tag
  // stays a view of the board rather than becoming a durable folder.
  useEffect(() => {
    registerFolders(Object.values(userTags).flat());
  }, [userTags]);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      try {
        localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "0" : "1");
      } catch {
        // Storage disabled — the toggle still works for this session.
      }
      return !open;
    });
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      return Number.isFinite(stored) && stored >= MIN_SIDEBAR_WIDTH
        ? Math.min(MAX_SIDEBAR_WIDTH, stored)
        : 220;
    } catch {
      return 220;
    }
  });
  const persistSidebarWidth = useCallback(() => {
    setSidebarWidth((width) => {
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
      } catch {
        // Storage disabled — the width still holds for this session.
      }
      return width;
    });
  }, []);

  const selectSpot = useCallback((name: string, additive: boolean) => {
    setSelectedSpots((current) => {
      // Shift-click: toggle this folder in/out of the running intersection.
      if (additive) {
        return current.includes(name) ? current.filter((spot) => spot !== name) : [...current, name];
      }
      // Plain click: go to just this folder — clicking the sole active one clears the filter.
      return current.length === 1 && current[0] === name ? [] : [name];
    });
  }, []);

  // Deletes/edits can remove a spot's last card — drop it from the sidebar selection once the
  // FULL list confirms it's gone, so the board doesn't stick on a filter with no folder behind
  // it (a truncated page would misread out-of-window as deleted, like the pin reconciler).
  useEffect(() => {
    if (!rows || rows.length < rowsTotal) return;
    const known = new Set(spots.map((spot) => spot.name));
    setSelectedSpots((current) => current.every((name) => known.has(name))
      ? current
      : current.filter((name) => known.has(name)));
  }, [rows, rowsTotal, spots]);

  // "Inside a folder" = exactly one rail spot selected (the plain-click case). Report it to the
  // shell so the composer can pre-fill `/folder`; an intersection of several (or none) is not a
  // single home to file into, so it reports null.
  const activeFolder = selectedSpots.length === 1 ? selectedSpots[0] ?? null : null;
  useEffect(() => {
    onActiveFolderChange?.(activeFolder);
  }, [activeFolder, onActiveFolderChange]);

  const togglePin = useCallback((episodeId: string) => {
    updatePins((current) => current.includes(episodeId)
      ? current.filter((id) => id !== episodeId)
      : [episodeId, ...current]); // newest pin rides to the top of the Pinned section
  }, []);

  // Keep pins honest against the live list: drop deleted episodes, and follow a pin across an edit
  // (a reingest replaces episode A with B → the pin migrates so the pinned card survives the edit).
  // Only prune a missing pin as "deleted" once the FULL list has loaded — the board pages in the
  // whole store, so until rows.length reaches rowsTotal a pin that hasn't loaded yet is out-of-view,
  // not gone, and must be kept.
  useEffect(() => {
    if (!rows) return;
    const liveIds = new Set(rows.map((row) => row.id));
    updatePins((current) => reconcilePins(current, liveIds, pendingEntries, rows.length >= rowsTotal));
  }, [rows, rowsTotal, pendingEntries]);

  // The Electron board paged the entire store into memory and filtered locally. Over a network
  // that is untenable, and the default view no longer wants it: `shuffle` asks the service for a
  // sample of SHUFFLE_SIZE, and the dated modes take one bounded page. Search is served by the
  // engine (below) rather than by filtering a full local copy.
  useEffect(() => {
    if (!engineRunning) return;
    let alive = true;
    void (async () => {
      try {
        const page = mode === "shuffle"
          ? await window.graph.episodesList({
              shuffle: true,
              limit: SHUFFLE_SIZE,
              seed: shuffleSeed,
            })
          : await window.graph.episodesList({ offset: 0, limit: PAGE_SIZE });
        if (!alive) return;
        setRows(page.episodes);
        setRowsTotal(page.total);
        setError(null);
        settleInitialLoad();
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          settleInitialLoad();
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [engineRunning, refreshToken, mode, shuffleSeed, settleInitialLoad]);

  // Publish the created-spot list (the UserTagMap on live cards) for the `/` popup in the
  // composer and search.
  useEffect(() => {
    // Created-but-empty folders count as known too, so `/name` autocompletes into them.
    if (rows) {
      setKnownTags([...new Set([...knownCreatedTags(rows, displayTags), ...createdFolders])]
        .sort((a, b) => a.localeCompare(b)));
    }
  }, [rows, displayTags, createdFolders]);

  // One-time migration: rows captured before filing moved into the UserTagMap carry their
  // spots as raw-text hashtags — copy those into the map once, over the FULL list only (a
  // truncated page would strand the unloaded rows' spots). After the flag is set, raw
  // text is never again read for spots, which is what keeps pasted tokens inert.
  useEffect(() => {
    if (!rows || rows.length < rowsTotal) return;
    try {
      if (localStorage.getItem(TAGS_BACKFILL_KEY)) return;
      updateUserTags((map) => backfillHashtagUserTags(rows, map));
      localStorage.setItem(TAGS_BACKFILL_KEY, "1");
    } catch {
      // Storage disabled — skip the migration rather than re-tagging every session.
    }
  }, [rows, rowsTotal]);

  // The ONE consumer of queued filings: whenever a refetch first shows a row whose verbatim
  // raw_text matches a queued filing, file its spots under the row's PERMANENT id. This path
  // has no timing window — an ingested note always reaches the rows list eventually, and a row
  // id is live by construction, so the reconcile below can never prune it as an orphan. The
  // composer files the same spots early under its provisional ids for the chip, but leaves the
  // entry queued: consuming it there could drop the filing for good when the pending record
  // drains before the board has met the episode. Only never-before-seen rows may claim a
  // filing, so an old identical note can't steal one (and the queue is empty at mount anyway).
  const seenRowIdsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!rows) return;
    const seen = seenRowIdsRef.current;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const spots = takePendingFiling((row.raw_text ?? "").trim());
      if (spots) {
        updateUserTags((map) => spots.reduce((next, name) => addUserTag(next, row.id, name), map));
      }
    }
  }, [rows]);

  // Episode ids the capture pipeline has announced but the board hasn't refetched yet: a
  // fresh note's filing lands under its episode id while `rows` is still the PREVIOUS fetch,
  // and by then the pending entry may already be gone — a "complete" stale list would prune
  // the newborn key as an orphan. Remember every announced id and shield it until the list
  // actually carries it (after which normal liveness governs, so real deletes still prune).
  const announcedEpisodeIdsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const entry of pendingEntries) {
      if (entry.episodeId) announcedEpisodeIdsRef.current.add(entry.episodeId);
    }
  }, [pendingEntries]);

  useEffect(() => {
    if (!rows) return;
    const liveIds = new Set(rows.map((row) => row.id));
    const announced = announcedEpisodeIdsRef.current;
    for (const id of announced) {
      if (liveIds.has(id)) announced.delete(id); // seen on the board — normal rules from here
    }
    const shielded = [...announced].map((id) => ({ id, episodeId: null }));
    updateUserTags((map) =>
      reconcileUserTags(map, liveIds, [...pendingEntries, ...shielded], rows.length >= rowsTotal));
  }, [rows, rowsTotal, pendingEntries]);

  // Deep search: union the daemon's engine hits into the client-side matches, in the engine's
  // ranking. WHICH verb answers depends on the shape of what was typed (isSentenceQuery):
  //   • a name, phrase, or file-type lookup → §3.4 `search` (BM25 — every term must appear),
  //     asked wide (k=100) because every hit provably contains the words;
  //   • a question, "what did I say about the gym" → §9.5 `search.nl`, which fuses the semantic
  //     graph walk with that same BM25 lane. BM25 alone answers a sentence with nothing: its
  //     words are the user's, not the note's. Asked NARROW (k=20) for the opposite reason —
  //     the semantic lane is ranked but never filtered, so it always returns its best k however
  //     weak, and a wide ask would bury a precise answer under the tail.
  // Fail-soft throughout: a daemon that stubs `search` (-32603), or one whose engine predates
  // search.nl (-32601, capabilities.searchNl false), leaves the local filter carrying the
  // feature. Only the non-tag remainder is sent; `/tag` tokens filter locally.
  useEffect(() => {
    // Hits are per-query: drop the previous query's set NOW, or rows matching only the old
    // terms linger (with a wrong count) until the debounced response lands.
    setEngineHits(null);
    const terms = searchSplit.rest.trim();
    if (!engineRunning || !terms) return;
    const askNl = canSearchNl && isSentenceQuery(terms);
    let alive = true;
    // A sentence gets a longer pause than a lookup: it costs a graph walk plus a rerank, and
    // it is also the query a person is still in the middle of typing.
    const timer = setTimeout(() => {
      (askNl ? window.graph.searchNl(terms, 20) : window.graph.search(terms, 100))
        .then(async (res) => {
          if (!alive) return;
          setEngineHits(new Map(res.episodes.map((episode, rank) => [episode.id, rank])));
          // The board holds a sample, so most hits aren't loaded. Pull their rows in, or a
          // search would only ever surface the handful already on screen.
          const missing = res.episodes
            .map((episode) => episode.id)
            .filter((id) => !rowsRef.current.some((row) => row.id === id));
          if (missing.length === 0) return;
          const hydrated = await window.graph.episodesByIds(missing);
          if (!alive) return;
          setRows((current) => {
            const known = new Set((current ?? []).map((row) => row.id));
            return [...(current ?? []), ...hydrated.episodes.filter((row) => !known.has(row.id))];
          });
        })
        .catch(() => alive && setEngineHits(null));
    }, askNl ? 400 : 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [engineRunning, searchSplit.rest, canSearchNl]);

  /**
   * Measure the PARENT, not the board itself. The board's own width animates for 620ms while
   * the chat drawer takes its margin, and re-columning off that moving number is what made
   * the cards shudder — three columns narrowing to their floor, snapping to two, then
   * widening again. The parent never moves, so subtracting the space the drawer is about to
   * claim gives the settled width immediately: the masonry re-columns ONCE, at the size it
   * will end at, and the container simply closes around it.
   */
  useEffect(() => {
    const el = wrapRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep a random board stable while it is visible; new captures append instead of reshuffling it.
  useEffect(() => {
    if (mode !== "random" || !rows) return;
    setShuffleOrder((current) => stickyShuffleOrder(current, rows));
  }, [mode, rows]);

  useEffect(() => {
    const close = (event: Event) => {
      setCtxMenu(null);
      if (!filterRef.current?.contains(event.target as Node)) closeFilter();
      if (!visibilityRef.current?.contains(event.target as Node)) closeVisibility();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      cancelFilterClose();
      cancelVisibilityClose();
    };
  }, [cancelFilterClose, closeFilter, cancelVisibilityClose, closeVisibility]);

  // The width the board will settle at, known the instant the drawer is toggled.
  const width = Math.max(240, containerWidth - (sidebarOpen ? sidebarWidth : 0));
  const columns = columnCountForWidth(width);
  /**
   * A column is also the text's measure, so it is capped at a readable line (~52 characters
   * of 16px SF at 420px). Uncapped, a one- or two-column window ran lines of 70+ characters,
   * which is the "wall of text" feel wide notes had. When the cap bites, the board no longer
   * fills the window; day sections centre themselves instead (--board-width below).
   */
  const columnWidth = Math.max(180, Math.min(420, (width - 48 - Math.max(0, columns - 1) * 12) / columns));
  const boardWidth = columns * columnWidth + Math.max(0, columns - 1) * 12 + 48;
  const searching = searchSplit.rest.trim().length > 0;
  const tagFiltering = activeTags.length > 0;
  /** Per-row spot names, lowercased — user spots plus durable provenance tags such as AI;
      extracted entities/concepts never answer for a spot filter. */
  const rowTagNames = useMemo(
    () => new Map((rows ?? []).map((row) => [row.id, spotNames(displayTags[row.id])])),
    [rows, displayTags],
  );
  const filteredRows = useMemo(() => {
    if (!rows) return [];
    // "Only show": the board narrows to cards carrying at least one checked folder. An
    // explicit tag selection (rail click or typed `/tag`) suspends the narrowing — asking
    // for a folder outright always wins over the standing filter.
    const narrowed = onlySet.size === 0 || tagFiltering
      ? rows
      : rows.filter((row) => {
          const names = rowTagNames.get(row.id);
          if (!names) return false;
          for (const onlyName of onlySet) {
            if (names.has(onlyName)) return true;
          }
          return false;
        });
    // A hidden folder's cards drop out of view UNLESS that folder is itself part of the active
    // tag intersection — an explicit request (rail click or typed `/tag`) always wins.
    const unhidden = hiddenSet.size === 0
      ? narrowed
      : narrowed.filter((row) => {
          const names = rowTagNames.get(row.id);
          if (!names) return true;
          for (const hiddenName of hiddenSet) {
            if (names.has(hiddenName) && !activeTags.includes(hiddenName)) return false;
          }
          return true;
        });
    // Tags intersect first (a card must carry ALL active tags), then the text query narrows.
    const scoped = tagFiltering
      ? unhidden.filter((row) => {
          const names = rowTagNames.get(row.id);
          return names !== undefined && activeTags.every((tag) => names.has(tag));
        })
      : unhidden;
    if (!searching) return scoped;
    const matches = scoped.filter((row) =>
      matchesHistorySearch(row, searchSplit.rest) || engineHits?.has(row.id));
    if (!engineHits) return matches;
    // Results read best-match-first, not newest-first: a search is a question, and the board's
    // usual date order answers a different one. Rows the engine didn't rank (client-side-only
    // matches) keep their existing order behind the ranked ones — sort is stable.
    const rank = (row: EpisodeListRow) => engineHits.get(row.id) ?? Number.MAX_SAFE_INTEGER;
    return [...matches].sort((a, b) => rank(a) - rank(b));
  }, [rows, tagFiltering, rowTagNames, activeTags, searching, searchSplit.rest, engineHits, hiddenSet, onlySet]);
  const randomRows = useMemo(() => {
    if (mode !== "random") return [];
    const byId = new Map(filteredRows.map((row) => [row.id, row]));
    return shuffleOrder
      .map((id) => byId.get(id))
      .filter((row): row is EpisodeListRow => row !== undefined);
  }, [mode, filteredRows, shuffleOrder]);

  const buildBoardItems = useCallback((realRows: EpisodeListRow[]): HistoryBoardItem[] => {
    // Pending skeletons aren't indexed yet — hide them while a search narrows the board.
    // Under a tag filter, a pending capture's typed spots are already filed under its id.
    const deleteShields = pendingEntries.filter((entry) => entry.hidden);
    const visiblePending = (searching ? [] : pendingEntries).filter((entry) =>
      !entry.hidden &&
      (activeTags.length === 0 || hasAllTags([...spotNames(userTags[entry.id])], activeTags)));
    const pendingByEpisodeId = new Map(
      visiblePending.flatMap((entry) => entry.episodeId ? [[entry.episodeId, entry] as const] : []),
    );
    const pendingByReplacedEpisodeId = new Map(
      visiblePending.flatMap((entry) => entry.replacesEpisodeId
        ? [[entry.replacesEpisodeId, entry] as const]
        : []),
    );
    const matchedPendingIds = new Set<string>();
    const realItems = realRows
      .filter((row) => !deleteShields.some((entry) => pendingDeleteShieldsRow(entry, row)))
      .map((row): HistoryBoardItem => {
      const replacement = pendingByReplacedEpisodeId.get(row.id);
      if (replacement) {
        matchedPendingIds.add(replacement.id);
        return {
          id: `pending:${replacement.id}`,
          created_at: row.created_at,
          raw_text: replacement.text || null,
          media_paths: Array.from(
            { length: replacement.attachmentCount },
            (_, index) => `pending-${index}`,
          ),
          kind: "pending",
          pending: replacement,
        };
      }
      const pending = pendingByEpisodeId.get(row.id);
      if (pending) matchedPendingIds.add(pending.id);
      return {
        id: pending ? `pending:${pending.id}` : `episode:${row.id}`,
        created_at: row.created_at,
        raw_text: row.raw_text,
        media_paths: row.media_paths,
        graph_preview: row.graph_preview,
        kind: "real",
        row,
        pending,
        materializing: Boolean(pending),
      };
      });
    const pendingItems = visiblePending
      .filter((entry) => !matchedPendingIds.has(entry.id))
      .map((pending): HistoryBoardItem => ({
        id: `pending:${pending.id}`,
        created_at: new Date(pending.createdAt || Date.now()).toISOString(),
        raw_text: pending.text || null,
        media_paths: Array.from({ length: pending.attachmentCount }, (_, index) => `pending-${index}`),
        kind: "pending",
        pending,
      }));
    return [...realItems, ...pendingItems];
  }, [pendingEntries, searching, activeTags]);

  const boardItems = useMemo(() => buildBoardItems(filteredRows), [buildBoardItems, filteredRows]);
  const randomBoardItems = useMemo(() => buildBoardItems(randomRows), [buildBoardItems, randomRows]);

  // Duplicate the pinned cards into a section of their own, in pin order (newest first). They reuse
  // the same board items — a real row, or its reingest skeleton while it's being edited — so a
  // pinned card is a live pointer to the original, and search narrows both copies together. The
  // `pinned:` id prefix keeps this board's keys/measurements independent of the main board's.
  const pinnedBoardItems = useMemo(() => {
    if (pinnedIds.length === 0) return [];
    const byEpisode = new Map<string, HistoryBoardItem>();
    for (const item of boardItems) {
      const episodeId = boardItemEpisodeId(item);
      if (episodeId && !byEpisode.has(episodeId)) byEpisode.set(episodeId, item);
    }
    // A completed edit replaces episode A with B. The reconcile effect rewrites pinnedIds A→B, but
    // it runs a commit behind the row refetch — resolve A→B here too so the pinned card follows the
    // edit on the SAME commit rather than blanking for a frame while the effect catches up.
    const migrated = new Map<string, string>();
    for (const entry of pendingEntries) {
      if (entry.replacesEpisodeId && entry.episodeId && entry.episodeId !== entry.replacesEpisodeId) {
        migrated.set(entry.replacesEpisodeId, entry.episodeId);
      }
    }
    const items: HistoryBoardItem[] = [];
    const seen = new Set<string>();
    for (const id of pinnedIds) {
      const migratedId = migrated.get(id);
      const item = byEpisode.get(id) ?? (migratedId ? byEpisode.get(migratedId) : undefined);
      if (!item || seen.has(item.id)) continue; // skip missing / de-dupe two pins onto one target
      seen.add(item.id);
      items.push({ ...item, id: `pinned:${item.id}` });
    }
    return items;
  }, [pinnedIds, boardItems, pendingEntries]);

  // Day sections computed ONCE per real change. groupByDay allocates fresh arrays every call, so
  // building this inline in the render handed each MasonryBoard a new `items` array on every
  // unrelated re-render (toolbar hover, ctx menu, status poll) — churning its ResizeObserver and
  // forcing a full re-measure. Memoizing keeps each day's `entries` referentially stable.
  const daySections = useMemo((): Array<{ key: string; label: string | null; entries: HistoryBoardItem[] }> => {
    // A search is a question, and its answers are ONE run of cards in best-match order. Day
    // sections would answer a different question: they re-sort every match by date and then
    // cut the run into labelled pieces, so the closest match could sit under a "Yesterday"
    // heading three sections down from a weaker one. Checked before the flat modes so a search
    // still renders while the board is shuffled.
    if (searching) {
      return boardItems.length > 0
        ? [{ key: "search-results", label: null, entries: boardItems }]
        : [];
    }
    // Both flat modes render one un-sectioned board: a sample of 10 spread across weeks would
    // be mostly one-card day headings.
    if (mode === "random" || mode === "shuffle") return [];
    return groupByDay(boardItems, mode).map((group) => ({
      key: group.key,
      label: group.label,
      entries: group.entries,
    }));
  }, [boardItems, mode, searching]);

  const canDelete = snapshot?.capabilities?.episodeDelete ?? false;
  const canReingest = snapshot?.capabilities?.episodeReingest ?? false;

  /** Re-ingest a note under its edited text, and hand the reingest to the shell to track. */
  const saveEpisodeEdit = async () => {
    if (!episodeEdit) return;
    const text = episodeEdit.text.trim();
    if (!text) return;
    setSavingEdit(true);
    try {
      const result = await window.graph.episodeReingest(episodeEdit.id, text);
      if (result) {
        onEpisodeEdited?.({
          replacesEpisodeId: episodeEdit.id,
          spoolId: result.spool_id,
          text,
          attachments: [],
          createdAt: Date.now(),
        });
      }
      setEpisodeEdit(null);
      onMutated();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSavingEdit(false);
    }
  };

  const doDelete = async (episodeId: string) => {
    setDeleting(true);
    try {
      await window.graph.episodeDelete(episodeId);
      // Optimistic removal for instant feedback; onMutated refetches the authoritative list.
      setRows((current) => current?.filter((row) => row.id !== episodeId) ?? current);
      updatePins((current) => current.filter((id) => id !== episodeId));
      setConfirmDeleteTarget(null);
      onMutated();
    } catch (e) {
      setError((e as Error).message);
      setConfirmDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  // Deleting a folder unfiles its cards, it never deletes them. Count off the FULL row list,
  // not the filtered board, so the confirm is honest while another filter is active.
  const requestDeleteFolder = (name: string) => {
    const count = (rows ?? []).filter((row) => rowTagNames.get(row.id)?.has(name)).length;
    setConfirmDeleteFolder({ name, count });
  };

  const doDeleteFolderConfirmed = () => {
    if (!confirmDeleteFolder) return;
    deleteFolder(confirmDeleteFolder.name);
    setConfirmDeleteFolder(null);
  };

  const renderCard = useCallback(
    (item: HistoryBoardItem, opts?: { pinned?: boolean }) => {
      const pinned = opts?.pinned ?? false;
      if (item.kind === "pending" && item.pending) {
        const pending = item.pending;
        // Typed `/spots` are filing commands, filed under the pending id — not card text.
        const pendingText = stripTags(pending.text, spotNames(userTags[pending.id]));
        const snippet = previewText(markdownToSnippet(pendingText) || "Untitled input");
        const rawLinks = linkifySegments(pendingText).filter((segment) => segment.kind === "link");
        return (
          <div
            key={item.id}
            className={`card history-processing-card ${pending.status}${pinned ? " card-pinned" : ""}`}
            aria-label={`${pinned ? "pinned-" : ""}processing-card-${pending.id}`}
            onContextMenu={(event) => {
              event.preventDefault();
              if (pending.onEdit || pending.onDelete) {
                setCtxMenu({ x: event.clientX, y: event.clientY, pendingId: pending.id });
              }
            }}
          >
            {/* The card's own border, lit and turning while the note is being ingested: the
                orbit is the 2px frame this card is padded to leave, with the content sitting
                on top of it. It goes still and red when the ingest failed. */}
            <span className="history-processing-orbit" aria-hidden />
            {/* Typed `/spots` are filed under the pending id, so the line reads the same
                before and after the daemon hands the card its episode id. */}
            <CardFolders names={userTags[pending.id] ?? []} />
            <div className="history-processing-content">
              <div className="body">
                <div className="snippet">
                  {linkifySegments(snippet).map((segment, index) => segment.kind === "link" ? (
                    <a
                      key={index}
                      onClick={(event) => {
                        event.stopPropagation();
                        void window.graph.openExternal(segment.url);
                      }}
                    >{segment.url}</a>
                  ) : <React.Fragment key={index}>{segment.text}</React.Fragment>)}
                </div>
                {pending.attachmentCount > 0 && (
                  <div className="caption">{pending.attachmentCount} attachment{pending.attachmentCount === 1 ? "" : "s"}</div>
                )}
              </div>
              {rawLinks.map((link, index) => (
                <RichLinkPreview key={`${link.url}-${index}`} url={link.url} />
              ))}
            </div>
          </div>
        );
      }

      const row = item.row;
      if (!row) return null;
      const images = row.media_paths.filter(isImage);
      // The card body shows the note with its filed `/spots` stripped out — the command
      // already reads as a chip; the stored raw stays verbatim (display-only strip).
      const displayText = stripTags(row.raw_text ?? "", rowTagNames.get(row.id) ?? new Set());
      const userSnippet = markdownToSnippet(displayText);
      const rawLinks = linkifySegments(displayText).filter((segment) => segment.kind === "link");
      const showBody = userSnippet.length > 0 || images.length === 0;
      // A link note reads as the link the user actually pasted. The fetched page title used to
      // stand in for it here; that belongs to the embed below, which already shows it.
      const snippet = previewText(userSnippet || "Untitled input");
      return (
        <div
          key={item.id}
          className={`card${row.source === "assistant" ? " card-ai" : ""}${pinned ? " card-pinned" : ""}${!pinned && spotlightEpisodeId === row.id ? " episode-jump-target" : ""}`}
          aria-label={`${pinned ? "pinned-" : ""}history-card-${row.id}`}
          data-episode-id={pinned ? undefined : row.id}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, episodeId: row.id });
          }}
        >
          {/* Where this memory is filed, above everything else on the card. */}
          <CardFolders names={displayTags[row.id] ?? []} />
          <button
            type="button"
            className="card-menu-button"
            aria-label={`card-menu-${row.id}`}
            onClick={(event) => {
              // Keep the card's open-episode click and the window's menu-dismiss listener out of it.
              event.stopPropagation();
              const anchor = event.currentTarget.getBoundingClientRect();
              setCtxMenu({ x: Math.max(8, anchor.right - 180), y: anchor.bottom + 4, episodeId: row.id });
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
          {images.map((p) => {
            const url = mediaUrl(p);
            return url ? <img key={p} src={url} loading="lazy" alt="" /> : null;
          })}
          {showBody && (
            <div className="body">
              {(userSnippet.length > 0 || images.length === 0) && (
                <div className={`snippet${images.length > 0 ? " with-images" : ""}`}>
                  {/* The note's own words, unmarked. Cards used to bold every extracted
                      entity and concept where it literally appeared; that is off. Links are
                      still segmented out, since those are the user's own content and have to
                      stay clickable. To restore the marks, swap linkifySegments back for
                      `entitySegments(snippet, [...(row.entities ?? []), ...(row.concepts ?? [])])`
                      and re-add the `entity` branch — lib/format.ts and the
                      `.snippet-entity` rule in styles.css are both still here. */
                  linkifySegments(snippet).map((seg, i) =>
                    seg.kind === "link" ? (
                      <a
                        key={i}
                        onClick={(e) => {
                          e.stopPropagation();
                          void window.graph.openExternal(seg.url);
                        }}
                      >
                        {seg.url}
                      </a>
                    ) : (
                      <React.Fragment key={i}>{seg.text}</React.Fragment>
                    ),
                  )}
                </div>
              )}
              {images.length > 1 && <div className="caption">{images.length} images</div>}
            </div>
          )}
          {rawLinks.map((link, index) => (
            <RichLinkPreview key={`${link.url}-${index}`} url={link.url} />
          ))}
          {cardDevView && <CardDevView row={row} />}
        </div>
      );
    },
    [displayTags, userTags, rowTagNames, spotlightEpisodeId, cardDevView],
  );

  return (
    <>
      {createPortal(
        <div className="history-toolbar notes-history-toolbar">
        {/* Folder toggle rides the header's left side, right of the traffic lights. */}
        <button
          type="button"
          className={`history-folders-button${sidebarOpen ? " active" : ""}`}
          aria-label="Folders"
          aria-pressed={sidebarOpen}
          onClick={toggleSidebar}
        >
          <svg className="folder-glyph" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </button>
        <div
          className="history-filter"
          ref={filterRef}
          onPointerEnter={openFilter}
          onPointerLeave={scheduleFilterClose}
          onFocus={openFilter}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) closeFilter();
          }}
        >
          <button
            type="button"
            className={`history-filter-button${filterOpen ? " active" : ""}`}
            aria-label="Sort memories"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            onClick={(event) => {
              event.stopPropagation();
              cancelFilterClose();
              setFilterOpen((open) => !open);
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 5h14M5.5 10h9M8 15h4" />
            </svg>
          </button>
          {filterOpen && (
            <div className="history-filter-menu" role="menu" aria-label="Sort memories">
              {(["shuffle", "new", "old", "random"] as const).map((option) => (
                <button
                  type="button"
                  key={option}
                  role="menuitemradio"
                  aria-checked={mode === option}
                  onClick={() => {
                    selectSort(option);
                    closeFilter();
                  }}
                >
                  <span>{SORT_LABELS[option]}</span>
                  {mode === option && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Re-roll the sample. Only meaningful in the default view — the dated modes show a
            page in order, so there is nothing to re-draw. */}
        {mode === "shuffle" && (
          <button
            type="button"
            className="history-filter-button history-shuffle-button"
            aria-label="Shuffle"
            title="Show a different handful"
            onClick={() => setShuffleSeed(Math.random().toString(36).slice(2))}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 5h3.5l7 10H17M3 15h3.5l7-10H17" />
              <path d="M14.5 2.5 17 5l-2.5 2.5M14.5 12.5 17 15l-2.5 2.5" />
            </svg>
          </button>
        )}
        {/* Folder visibility: a standing filter over the whole board. "Don't show" mutes the
            checked folders (the same list the sidebar's Hide feeds); "Only show" narrows the
            board to nothing but the checked ones. */}
        <div
          className="history-filter history-visibility"
          ref={visibilityRef}
          onPointerEnter={openVisibility}
          onPointerLeave={scheduleVisibilityClose}
          onFocus={openVisibility}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) closeVisibility();
          }}
        >
          <button
            type="button"
            className={`history-filter-button${visibilityOpen ? " active" : ""}${
              (folderVisibility.mode === "only" ? folderVisibility.only.length : hiddenFolders.length) > 0
                ? " filtering"
                : ""
            }`}
            aria-label="Folder visibility"
            aria-haspopup="menu"
            aria-expanded={visibilityOpen}
            onClick={(event) => {
              event.stopPropagation();
              cancelVisibilityClose();
              setVisibilityOpen((open) => !open);
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M2 10s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5S2 10 2 10z" />
              <circle cx="10" cy="10" r="2.5" />
            </svg>
          </button>
          {visibilityOpen && (
            <div className="history-filter-menu visibility-menu" role="menu" aria-label="Folder visibility">
              <div className="visibility-modes" role="group" aria-label="Visibility mode">
                {(["dont", "only"] as const).map((option) => (
                  <button
                    type="button"
                    key={option}
                    role="menuitemradio"
                    aria-checked={folderVisibility.mode === option}
                    className={folderVisibility.mode === option ? "active" : ""}
                    onClick={() => setFolderVisibilityMode(option)}
                  >
                    {option === "dont" ? "Don't show" : "Only show"}
                  </button>
                ))}
              </div>
              <div className="visibility-folders">
                {spots.length === 0 && <p className="visibility-empty">No folders yet</p>}
                {[...spots].sort((a, b) => a.name.localeCompare(b.name)).map((spot) => {
                  const checked = folderVisibility.mode === "only"
                    ? folderVisibility.only.includes(spot.name)
                    : hiddenSet.has(spot.name);
                  return (
                    <button
                      type="button"
                      key={spot.name}
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      onClick={() => {
                        if (folderVisibility.mode === "only") setFolderOnly(spot.name, !checked);
                        else setFolderHidden(spot.name, !checked);
                      }}
                    >
                      <span className="visibility-folder-label">
                        <FolderGlyph />
                        <span>{spot.name}</span>
                      </span>
                      {checked && <span aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          className="history-settings-button"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        </div>,
        document.body,
      )}

      <SpotsSidebar
        open={sidebarOpen}
        spots={spots}
        selected={selectedSpots}
        width={sidebarWidth}
        onSelect={selectSpot}
        onResize={setSidebarWidth}
        onResizeEnd={persistSidebarWidth}
        onCreate={addCreatedFolder}
        onDeleteFolder={requestDeleteFolder}
      />

      <div
        className={`history-page${sidebarOpen ? " sidebar-open" : ""}`}
        ref={wrapRef}
        style={{ marginLeft: sidebarOpen ? sidebarWidth : 0, "--board-width": `${boardWidth}px` } as React.CSSProperties}
      >
      {error && <p className="error-text" style={{ padding: "12px 24px" }}>{error}</p>}
      {!engineRunning && !error && <p className="muted" style={{ padding: "12px 24px" }}>Waiting for the engine…</p>}
      {searching && rows && filteredRows.length === 0 && (rows.length > 0 || pendingEntries.length > 0) && (
        <div className="empty-state">
          <h3>No matches</h3>
          <p className="muted">Nothing matches your search. Try fewer or different words.</p>
        </div>
      )}
      {!searching && tagFiltering && rows && boardItems.length === 0 && (
        <div className="empty-state">
          <h3>No cards with {activeTags.length === 1 ? "this tag" : "these tags"}</h3>
          <p className="muted">No card carries {activeTags.map((tag) => `/${tag}`).join(" + ")}. Add the tag{activeTags.length === 1 ? "" : "s"} to a note, or deselect one.</p>
        </div>
      )}
      {pinnedBoardItems.length > 0 && (
        <div className="day-section pinned-section">
          <div className="day-header pinned-header">
            <svg className="pinned-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 4h6l-1 6 3 3v2h-4v5l-1 1-1-1v-5H6v-2l3-3-1-6z" />
            </svg>
            <span className="day-header-label">Pinned</span>
          </div>
          <MasonryBoard
            items={pinnedBoardItems}
            columns={columns}
            columnWidth={columnWidth}
            renderCard={(item) => renderCard(item, { pinned: true })}
            devView={cardDevView}
          />
        </div>
      )}
      {daySections.length > 0 && (
        <>
          {daySections.map((section) => (
            <div key={section.key} className={section.key === todayKey ? "day-section today" : "day-section"}>
              {section.label !== null && (
                <div className="day-header">
                  <span className="day-header-label">{section.label}</span>
                </div>
              )}
              <MasonryBoard
                items={section.entries}
                columns={columns}
                columnWidth={columnWidth}
                renderCard={renderCard}
                devView={cardDevView}
              />
            </div>
          ))}
        </>
      )}
      {mode === "random" && randomBoardItems.length > 0 && (
        <div className="random-board">
          <MasonryBoard
            items={randomBoardItems}
            columns={columns}
            columnWidth={columnWidth}
            renderCard={renderCard}
            devView={cardDevView}
          />
        </div>
      )}
      {mode === "shuffle" && !searching && boardItems.length > 0 && (
        <div className="random-board shuffle-board">
          <MasonryBoard
            items={boardItems}
            columns={columns}
            columnWidth={columnWidth}
            renderCard={renderCard}
            devView={cardDevView}
          />
          {rows !== null && rowsTotal > rows.length && (
            <p className="muted shuffle-footnote">
              {rows.length} of {rowsTotal.toLocaleString()} — search, or pick a sort, to see more.
            </p>
          )}
        </div>
      )}
      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          {ctxMenu.episodeId && (
            <button
              onClick={() => {
                if (ctxMenu.episodeId) togglePin(ctxMenu.episodeId);
                setCtxMenu(null);
              }}
            >
              {pinnedSet.has(ctxMenu.episodeId) ? "Unpin" : "Pin"}
            </button>
          )}
          {ctxMenu.episodeId && (
            <button
              onClick={() => {
                setFolderPickerFor(ctxMenu.episodeId ?? null);
                setCtxMenu(null);
              }}
            >
              Folders
            </button>
          )}
          <button
            disabled={ctxMenu.pendingId
              ? !pendingEntries.find((entry) => entry.id === ctxMenu.pendingId)?.onEdit
              : !canReingest}
            onClick={() => {
              if (ctxMenu.pendingId) {
                const pending = pendingEntries.find((entry) => entry.id === ctxMenu.pendingId);
                if (pending?.onEdit) setPendingEdit({ id: pending.id, text: pending.text });
              } else {
                const row = rows?.find((candidate) => candidate.id === ctxMenu.episodeId);
                if (row) setEpisodeEdit({ id: row.id, text: row.raw_text ?? "" });
              }
              setCtxMenu(null);
            }}
          >
            Edit
          </button>
          <button
            className="destructive"
            disabled={ctxMenu.pendingId
              ? !pendingEntries.find((entry) => entry.id === ctxMenu.pendingId)?.onDelete
              : !canDelete}
            onClick={() => {
              const id = ctxMenu.pendingId ?? ctxMenu.episodeId;
              if (id) setConfirmDeleteTarget({ kind: ctxMenu.pendingId ? "pending" : "episode", id });
              setCtxMenu(null);
            }}
          >
            Delete
          </button>
        </div>
      )}
      {confirmDeleteTarget && (
        <div className="backdrop" style={{ zIndex: 70 }} onClick={() => !deleting && setConfirmDeleteTarget(null)}>
          <div className="overlay-panel" style={{ width: 360, maxHeight: 220 }} onClick={(e) => e.stopPropagation()}>
            <div className="overlay-body">
              <h3 style={{ marginTop: 0 }}>Delete this {confirmDeleteTarget.kind === "pending" ? "processing memory" : "memory"}?</h3>
              <p className="muted">
                It will move to Deleted and be permanently removed in 30 days. You can retrieve it
                from Settings › General › View deleted.
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="btn" onClick={() => setConfirmDeleteTarget(null)} disabled={deleting}>
                  Cancel
                </button>
                <button
                  className="btn danger"
                  onClick={() => {
                    if (confirmDeleteTarget.kind === "pending") {
                      const pending = pendingEntries.find((entry) => entry.id === confirmDeleteTarget.id);
                      void pending?.onDelete?.();
                      setConfirmDeleteTarget(null);
                    } else {
                      void doDelete(confirmDeleteTarget.id);
                    }
                  }}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {confirmDeleteFolder && (
        <div
          className="backdrop"
          style={{ zIndex: 70 }}
          onClick={() => setConfirmDeleteFolder(null)}
        >
          <div className="overlay-panel" style={{ width: 380, maxHeight: 240 }} onClick={(e) => e.stopPropagation()}>
            <div className="overlay-body">
              <h3 style={{ marginTop: 0 }}>Delete the folder “{confirmDeleteFolder.name}”?</h3>
              <p className="muted">
                {confirmDeleteFolder.count === 0
                  ? "The folder is empty — nothing else changes."
                  : `Its ${confirmDeleteFolder.count} ${confirmDeleteFolder.count === 1 ? "entry stays" : "entries stay"} on the board; they just won’t be filed here anymore.`}
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="btn" onClick={() => setConfirmDeleteFolder(null)}>
                  Cancel
                </button>
                <button className="btn danger" onClick={doDeleteFolderConfirmed}>
                  Delete folder
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {episodeEdit && (
        <div className="backdrop" style={{ zIndex: 70 }} onClick={() => !savingEdit && setEpisodeEdit(null)}>
          <div className="overlay-panel" style={{ width: 560, maxHeight: 460 }} onClick={(event) => event.stopPropagation()}>
            <div className="overlay-body">
              <h3 style={{ marginTop: 0 }}>Edit memory</h3>
              <textarea
                aria-label="edit-memory-text"
                value={episodeEdit.text}
                onChange={(event) => setEpisodeEdit({ ...episodeEdit, text: event.currentTarget.value })}
                autoFocus
                style={{ width: "100%", minHeight: 230, resize: "vertical" }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button className="btn" onClick={() => setEpisodeEdit(null)} disabled={savingEdit}>Cancel</button>
                <button
                  className="btn primary"
                  disabled={savingEdit || !episodeEdit.text.trim()}
                  onClick={() => void saveEpisodeEdit()}
                >
                  {savingEdit ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {folderPickerFor && (
        <div className="backdrop" style={{ zIndex: 70 }} onClick={() => setFolderPickerFor(null)}>
          <div className="overlay-panel card-tag-sheet" style={{ width: 360, maxHeight: 380 }} onClick={(event) => event.stopPropagation()}>
            <div className="overlay-body">
              <h3 style={{ marginTop: 0 }}>Folders</h3>
              <CardFolderPicker episodeId={folderPickerFor} />
            </div>
          </div>
        </div>
      )}
      {pendingEdit && (
        <div className="backdrop" style={{ zIndex: 70 }} onClick={() => setPendingEdit(null)}>
          <div className="overlay-panel" style={{ width: 520, maxHeight: 420 }} onClick={(event) => event.stopPropagation()}>
            <div className="overlay-body">
              <h3 style={{ marginTop: 0 }}>Edit processing memory</h3>
              <textarea
                value={pendingEdit.text}
                onChange={(event) => setPendingEdit({ ...pendingEdit, text: event.currentTarget.value })}
                autoFocus
                style={{ width: "100%", minHeight: 190, resize: "vertical" }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button className="btn" onClick={() => setPendingEdit(null)}>Cancel</button>
                <button
                  className="btn primary"
                  disabled={!pendingEdit.text.trim()}
                  onClick={() => {
                    const pending = pendingEntries.find((entry) => entry.id === pendingEdit.id);
                    void pending?.onEdit?.(pendingEdit.text);
                    setPendingEdit(null);
                  }}
                >Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}
