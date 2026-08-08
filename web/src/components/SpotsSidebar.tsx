/**
 * Folders sidebar: ONE flat list of the user's spots (the tags they created — `/names` typed
 * in notes plus folders checked in a card's ⋯ → Folders), opened by the header's folder toggle.
 * No nesting, no archive: a folder comes into existence by using `/name` in a note (names can
 * never contain a slash) or via "New folder", and disappears when its last card does. A plain
 * click GOES TO one folder (replaces the selection; clicking the sole active folder clears it);
 * shift-click adds/removes a folder to build an INTERSECTION. Selected folders also intersect
 * with `/tag` search terms — filtering only, the feed itself is never reordered or mutated.
 * A row's only action is deleting the folder, which unfiles its cards and never deletes them.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { UserTagMap } from "../lib/tags";

/** The chosen folder order, persisted across sessions. */
const FOLDERS_SORT_KEY = "graph.history.folders-sort.v1";

export interface SpotCount {
  /** Lowercased spot name — spots match case-insensitively, like tags. */
  name: string;
  /** Number of cards carrying the spot. */
  count: number;
  /** created_at of the folder's newest card (ISO, lexicographically ordered) — "" if unknown. */
  newest: string;
}

/**
 * Every folder on the live rows with its card count and newest-card date — read from the
 * UserTagMap ONLY (typed `/names` land there at capture; raw text and extraction
 * entities/concepts never count, so a pasted `/` can't mint a folder), counted once per card.
 * Base order is count-desc then alphabetical; the sidebar re-sorts by its own mode.
 */
/**
 * Counts come from the tag map, not the loaded rows: the board shows a sample, so counting
 * what happens to be on screen would show "1" for a folder holding forty notes. Loaded rows
 * only supply `newest`, which is presentational.
 */
export function spotCounts(
  rows: ReadonlyArray<{ id: string; raw_text: string | null; created_at?: string }>,
  userTags: UserTagMap,
): SpotCount[] {
  const createdAt = new Map(rows.map((row) => [row.id, row.created_at ?? ""]));
  const counts = new Map<string, { count: number; newest: string }>();
  for (const [episodeId, tags] of Object.entries(userTags)) {
    const names = new Set<string>(); // per-card dedupe: two casings of one name = 1
    for (const tag of tags) names.add(tag.toLowerCase());
    for (const name of names) {
      const entry = counts.get(name) ?? { count: 0, newest: "" };
      entry.count += 1;
      const at = createdAt.get(episodeId) ?? "";
      if (at > entry.newest) entry.newest = at;
      counts.set(name, entry);
    }
  }
  return [...counts]
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export type SpotSortMode = "alpha" | "new" | "old";

/** The sidebar's folder order: by name, or by each folder's newest card (desc/asc). */
export function sortSpots(spots: readonly SpotCount[], mode: SpotSortMode): SpotCount[] {
  const list = [...spots];
  if (mode === "alpha") return list.sort((a, b) => a.name.localeCompare(b.name));
  if (mode === "new") return list.sort((a, b) => b.newest.localeCompare(a.newest) || a.name.localeCompare(b.name));
  return list.sort((a, b) => a.newest.localeCompare(b.newest) || a.name.localeCompare(b.name));
}

function FolderGlyph() {
  return (
    <svg className="folder-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg className="folder-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Sliders icon (same visual family as the board's sort filter). */
function FilterGlyph() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 5h14M5.5 10h9M8 15h4" />
    </svg>
  );
}

const SORT_OPTIONS = [
  ["alpha", "A–Z"],
  ["new", "Newest first"],
  ["old", "Oldest first"],
] as const;

/** The sort chips must always fit — the resize floor. */
export const MIN_SIDEBAR_WIDTH = 190;
export const MAX_SIDEBAR_WIDTH = 420;

export function SpotsSidebar({
  open,
  spots,
  selected,
  width,
  onSelect,
  onResize,
  onResizeEnd,
  onCreate,
  onDeleteFolder,
}: {
  /** Stay mounted while closed so the exit transform can finish instead of cutting away. */
  open: boolean;
  spots: readonly SpotCount[];
  /** Lowercased selected folder names — lifted into HistoryPage so search tags compose. */
  selected: readonly string[];
  /** Panel width in px, owned by HistoryPage (the board's margin follows it). */
  width: number;
  /** `additive` (shift-click) toggles the folder into an intersection; a plain click goes to it. */
  onSelect: (name: string, additive: boolean) => void;
  /** Live width while dragging the right-edge handle (already clamped). */
  onResize: (width: number) => void;
  /** Drag finished — persist the width. */
  onResizeEnd: () => void;
  /** "New folder" committed a (sanitized-by-the-store) name. */
  onCreate: (name: string) => void;
  /** Requests the "delete this folder, keep its entries" confirm flow, owned by HistoryPage. */
  onDeleteFolder: (name: string) => void;
}) {
  const selectedSet = new Set(selected);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the row menu on any click outside it — it has no other dismiss affordance.
  useEffect(() => {
    if (!openMenu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [openMenu]);
  const [sortMode, setSortMode] = useState<SpotSortMode>(() => {
    try {
      const stored = localStorage.getItem(FOLDERS_SORT_KEY);
      return stored === "new" || stored === "old" ? stored : "alpha";
    } catch {
      return "alpha";
    }
  });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const selectSort = (mode: SpotSortMode) => {
    setSortMode(mode);
    try {
      localStorage.setItem(FOLDERS_SORT_KEY, mode);
    } catch {
      // Storage disabled — the choice still applies this session.
    }
  };
  // Hover-revealed sort menu, mirroring the board's toolbar filter: pointer-enter opens it,
  // pointer-leave closes after a short grace so a quick diagonal to the menu doesn't dismiss it.
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const filterCloseTimer = useRef<number | null>(null);
  const cancelFilterClose = useCallback(() => {
    if (filterCloseTimer.current === null) return;
    window.clearTimeout(filterCloseTimer.current);
    filterCloseTimer.current = null;
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
    filterCloseTimer.current = window.setTimeout(() => {
      filterCloseTimer.current = null;
      setFilterOpen(false);
    }, 140);
  }, [cancelFilterClose]);
  const commitNewFolder = () => {
    const name = newName.trim();
    if (name) onCreate(name);
    setCreating(false);
    setNewName("");
  };
  // The panel sits at the window's left edge, so the pointer's x IS the width. Window-level
  // listeners keep the drag alive when the pointer outruns the 5px handle.
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const move = (pointer: PointerEvent) => {
      onResize(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, pointer.clientX)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onResizeEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const renderSpotRow = (spot: SpotCount) => {
    const active = selectedSet.has(spot.name);
    const menuOpen = openMenu === spot.name;
    return (
      <div key={spot.name} className={`spot-row${active ? " selected" : ""}`}>
        <button
          type="button"
          className="spot-row-select"
          aria-label={`spot-${spot.name}`}
          aria-pressed={active}
          // Shift-click builds an intersection; a plain click goes straight to this folder.
          onClick={(event) => onSelect(spot.name, event.shiftKey)}
        >
          <FolderGlyph />
          <span className="spot-row-name">{spot.name}</span>
        </button>
        <div className="spot-row-menu" ref={menuOpen ? menuRef : undefined}>
          <button
            type="button"
            className="spot-row-menu-btn"
            aria-label={`More actions for ${spot.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setOpenMenu((current) => (current === spot.name ? null : spot.name))}
          >
            ⋯
          </button>
          {/* One action only. Deleting a folder is a filing decision: the folder goes, its
              entries stay on the board — so there is nothing here to gate on the engine's
              delete capability. */}
          {menuOpen && (
            <div className="ctx-menu spot-row-menu-list" role="menu">
              <button
                type="button"
                role="menuitem"
                className="destructive"
                onClick={() => {
                  setOpenMenu(null);
                  onDeleteFolder(spot.name);
                }}
              >
                Delete folder…
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };
  return (
    <aside
      className={`spots-sidebar${open ? " open" : ""}`}
      aria-label="Folders sidebar"
      aria-hidden={!open}
      inert={!open}
      style={{ width }}
    >
      {/* Header row: New folder on the left (like a section label), the sort filter on the
          right — a hover-revealed menu, same as the board's toolbar filter. */}
      <div className="spots-sidebar-head">
        {creating ? (
          <input
            className="new-folder-input"
            value={newName}
            aria-label="new-folder-name"
            placeholder="folder name"
            autoFocus
            // Folder names can never contain a slash — the character just doesn't type. Spaces
            // become dashes so the folder stays targetable via `/name` in the composer.
            onChange={(event) =>
              setNewName(event.currentTarget.value.replaceAll("/", "").replace(/\s+/g, "-"))
            }
            onBlur={commitNewFolder}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                commitNewFolder();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setCreating(false);
                setNewName("");
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="new-folder-button"
            aria-label="new-folder"
            onClick={() => {
              setNewName("");
              setCreating(true);
            }}
          >
            <PlusGlyph />
            <span>New folder</span>
          </button>
        )}
        <div
          className="spots-filter"
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
            className={`spots-filter-button${filterOpen ? " active" : ""}`}
            aria-label="Sort folders"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            onClick={(event) => {
              event.stopPropagation();
              cancelFilterClose();
              setFilterOpen((open) => !open);
            }}
          >
            <FilterGlyph />
          </button>
          {filterOpen && (
            <div className="spots-filter-menu" role="menu" aria-label="Sort folders">
              {SORT_OPTIONS.map(([mode, label]) => (
                <button
                  type="button"
                  key={mode}
                  role="menuitemradio"
                  aria-checked={sortMode === mode}
                  aria-label={`sort-folders-${mode}`}
                  onClick={() => {
                    selectSort(mode);
                    closeFilter();
                  }}
                >
                  <span>{label}</span>
                  {sortMode === mode && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {spots.length === 0 ? (
        <p className="spots-sidebar-empty">
          No folders yet. Type /name in a note to file it as you save.
        </p>
      ) : (
        sortSpots(spots, sortMode).map((spot) => renderSpotRow(spot))
      )}
      <div
        className="spots-sidebar-resize"
        aria-label="resize-folders-sidebar"
        style={{ left: width - 6 }}
        onPointerDown={startResize}
      />
    </aside>
  );
}
