/**
 * Collections tab: one card per folder instead of per save. Previews are fetched by id — the
 * tag map knows which episodes a folder holds, and the sampled board rarely has them loaded.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { EpisodeListRow } from "../shared/protocol";
import type { UserTagMap } from "../lib/tags";
import { markdownToSnippet, previewText } from "../lib/format";
import { clearCover, fileToCover, setCover, useCovers } from "../lib/covers";
import { collectionKind, setCollectionKind, useCollectionKinds } from "../lib/collectionKinds";
import type { CollectionKind } from "../shared/api";
import type { SpotCount } from "./SpotsSidebar";

/** Episodes fetched per folder for its preview, and the ceiling across all folders. */
const PER_FOLDER = 3;
const MAX_PREVIEW_FETCH = 90;

/** folder name → the episode ids filed under it, from the tag map. */
export function episodesByFolder(userTags: UserTagMap): Map<string, string[]> {
  const byFolder = new Map<string, string[]>();
  for (const [episodeId, tags] of Object.entries(userTags)) {
    for (const tag of new Set(tags.map((t) => t.toLowerCase()))) {
      const list = byFolder.get(tag) ?? [];
      list.push(episodeId);
      byFolder.set(tag, list);
    }
  }
  return byFolder;
}

export function CollectionsBoard({
  spots,
  userTags,
  loadedRows,
  onOpen,
  onCreate,
  onDelete,
}: {
  spots: SpotCount[];
  userTags: UserTagMap;
  /** Rows the board already has — saves a fetch for anything on screen. */
  loadedRows: EpisodeListRow[];
  onOpen: (name: string) => void;
  onCreate: (name: string, kind: CollectionKind) => void;
  onDelete: (name: string) => void;
}) {
  const [fetched, setFetched] = useState<Map<string, EpisodeListRow>>(new Map());
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const covers = useCovers();
  const kinds = useCollectionKinds();
  /** Which kind the inline "New collection" card will create. Fixed once created. */
  const [draftKind, setDraftKind] = useState<CollectionKind>("grid");
  /** Which collection a pending file-picker choice belongs to. */
  const coverTarget = useRef<string | null>(null);
  const coverInput = useRef<HTMLInputElement | null>(null);

  const byFolder = useMemo(() => episodesByFolder(userTags), [userTags]);
  // Alphabetical: a grid of named things is scanned by name, not by size.
  const ordered = useMemo(
    () => [...spots].sort((a, b) => a.name.localeCompare(b.name)),
    [spots],
  );

  const known = useMemo(() => {
    const map = new Map<string, EpisodeListRow>();
    for (const row of loadedRows) map.set(row.id, row);
    for (const [id, row] of fetched) map.set(id, row);
    return map;
  }, [loadedRows, fetched]);

  // Pull the rows the previews need, in one request.
  useEffect(() => {
    const wanted: string[] = [];
    for (const spot of ordered) {
      for (const id of (byFolder.get(spot.name) ?? []).slice(0, PER_FOLDER)) {
        if (!known.has(id) && !wanted.includes(id)) wanted.push(id);
        if (wanted.length >= MAX_PREVIEW_FETCH) break;
      }
      if (wanted.length >= MAX_PREVIEW_FETCH) break;
    }
    // Previews are a nicety — never let fetching them take the grid down with them.
    if (wanted.length === 0 || typeof window.graph.episodesByIds !== "function") return;
    let alive = true;
    void window.graph
      .episodesByIds(wanted)
      .then((page) => {
        if (!alive) return;
        setFetched((current) => {
          const next = new Map(current);
          for (const row of page.episodes) next.set(row.id, row);
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [ordered, byFolder, known]);

  useEffect(() => {
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const pickCover = (name: string) => {
    coverTarget.current = name;
    coverInput.current?.click();
  };

  const applyCover = async (file: File | undefined) => {
    const name = coverTarget.current;
    coverTarget.current = null;
    if (!name || !file) return;
    const cover = await fileToCover(file);
    if (cover) setCover(name, cover);
  };

  const submitNew = () => {
    const name = draftName.trim();
    if (name) {
      setCollectionKind(name, draftKind);
      onCreate(name, draftKind);
    }
    setDraftName("");
    setDraftKind("grid");
    setCreating(false);
  };

  if (spots.length === 0 && !creating) {
    return (
      <div className="collections-board">
        <div className="empty-state">
          <h3>No collections yet</h3>
          <p className="muted">
            File a save into one by typing <span className="mono">/name</span> as you write it, or
            start an empty collection here.
          </p>
          <button
            className="btn primary"
            aria-label="new-collection"
            onClick={() => setCreating(true)}
          >
            New collection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="collections-board">
      <div className="collections-grid">
        {ordered.map((spot) => {
          const previews = (byFolder.get(spot.name) ?? [])
            .map((id) => known.get(id))
            .filter((row): row is EpisodeListRow => row !== undefined)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, 2);
          return (
            <button
              type="button"
              key={spot.name}
              className={`collection-card${covers[spot.name] ? " has-cover" : ""}`}
              aria-label={`collection-${spot.name}`}
              onClick={() => onOpen(spot.name)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuFor(spot.name);
              }}
            >
              <span
                className="collection-card-menu"
                role="button"
                tabIndex={-1}
                aria-label={`collection-menu-${spot.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuFor((current) => (current === spot.name ? null : spot.name));
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.7" />
                  <circle cx="12" cy="12" r="1.7" />
                  <circle cx="19" cy="12" r="1.7" />
                </svg>
              </span>
              {covers[spot.name] && (
                <span
                  className="collection-card-cover"
                  aria-hidden="true"
                  style={{ backgroundImage: `url(${covers[spot.name]})` }}
                />
              )}
              <span className="collection-card-name">{spot.name}</span>
              {collectionKind(spot.name, kinds) === "canvas" && (
                <span className="collection-card-kind">Canvas</span>
              )}
              <span className="collection-card-previews">
                {previews.map((row) => (
                  <span key={row.id} className="collection-card-preview">
                    {previewText(markdownToSnippet(row.raw_text ?? "") || "Untitled input")}
                  </span>
                ))}
              </span>
              <span className="collection-card-count">
                {spot.count} {spot.count === 1 ? "save" : "saves"}
              </span>
              {menuFor === spot.name && (
                <span className="ctx-menu collection-ctx" onClick={(event) => event.stopPropagation()}>
                  <button
                    onClick={() => {
                      pickCover(spot.name);
                      setMenuFor(null);
                    }}
                  >
                    {covers[spot.name] ? "Change cover…" : "Choose cover…"}
                  </button>
                  {covers[spot.name] && (
                    <button
                      onClick={() => {
                        clearCover(spot.name);
                        setMenuFor(null);
                      }}
                    >
                      Remove cover
                    </button>
                  )}
                  <button
                    className="destructive"
                    onClick={() => {
                      onDelete(spot.name);
                      setMenuFor(null);
                    }}
                  >
                    Delete collection
                  </button>
                </span>
              )}
            </button>
          );
        })}

        {creating ? (
          <div className="collection-card collection-card-new is-editing">
            <div className="collection-kind-picker" role="radiogroup" aria-label="Collection type">
              {(["grid", "canvas"] as const).map((option) => (
                <button
                  type="button"
                  key={option}
                  role="radio"
                  aria-checked={draftKind === option}
                  className={draftKind === option ? "active" : ""}
                  // Pointer-down: the name input's onBlur would otherwise commit first.
                  onPointerDown={(event) => {
                    event.preventDefault();
                    setDraftKind(option);
                  }}
                >
                  {option === "grid" ? "Grid" : "Canvas"}
                </button>
              ))}
            </div>
            <input
              autoFocus
              className="collection-new-input"
              aria-label="new-folder-name"
              placeholder="Collection name"
              value={draftName}
              // Names can never contain a slash, and spaces become dashes so the collection
              // stays targetable as `/name` in the composer.
              onChange={(event) =>
                setDraftName(event.currentTarget.value.replaceAll("/", "").replace(/\s+/g, "-"))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") submitNew();
                if (event.key === "Escape") {
                  setDraftName("");
                  setCreating(false);
                }
              }}
              onBlur={submitNew}
            />
          </div>
        ) : (
          <button
            type="button"
            className="collection-card collection-card-new"
            aria-label="new-collection"
            onClick={() => setCreating(true)}
          >
            <span className="collection-new-plus" aria-hidden="true">+</span>
            <span className="collection-new-label">New collection</span>
          </button>
        )}
      </div>
      <input
        ref={coverInput}
        className="composer-file-input"
        type="file"
        accept="image/*"
        aria-label="collection-cover-file"
        onChange={(event) => {
          void applyCover(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
