/**
 * The card's folder list, opened from the card's ⋯ → Folders. Every folder the user has, one
 * row each, with a check beside the ones this memory is filed in — clicking a row files or
 * unfiles it, no intermediate chips or hover menu. A new folder can be created and filed in
 * one step from the bottom of the list.
 */
import React, { useMemo, useState } from "react";
import {
  addCreatedFolder,
  addUserTag,
  removeUserTag,
  updateUserTags,
  useCreatedFolders,
  useKnownTags,
  useUserTags,
} from "../lib/tags";

function FolderGlyph() {
  return (
    <svg className="folder-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function CardFolderPicker({ episodeId }: { episodeId: string }) {
  const userTags = useUserTags();
  const knownTags = useKnownTags();
  const createdFolders = useCreatedFolders();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");

  const ownNames = useMemo(
    () => new Set((userTags[episodeId] ?? []).map((tag) => tag.toLowerCase())),
    [userTags, episodeId],
  );
  /** Every folder that exists anywhere: the composer's known list, created-but-empty ones, and
      whatever the cards themselves carry — one row per name, first casing wins. */
  const folders = useMemo(() => {
    const names = new Map<string, string>();
    const add = (name: string) => {
      const display = name.trim();
      const key = display.toLowerCase();
      if (display && !names.has(key)) names.set(key, display);
    };
    knownTags.forEach(add);
    createdFolders.forEach(add);
    Object.values(userTags).flat().forEach(add);
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }, [knownTags, createdFolders, userTags]);

  const toggleFolder = (name: string) => {
    updateUserTags((map) => ownNames.has(name.toLowerCase())
      ? removeUserTag(map, episodeId, name)
      : addUserTag(map, episodeId, name));
  };

  const commitNewFolder = () => {
    const name = text.trim().replace(/^[#/]/, "").replaceAll("/", "").trim();
    if (name) {
      addCreatedFolder(name);
      updateUserTags((map) => addUserTag(map, episodeId, name));
    }
    setAdding(false);
    setText("");
  };

  return (
    <div className="card-folder-sheet" aria-label={`folders-${episodeId}`}>
      <div className="card-folder-list" role="menu" aria-label={`folder-list-${episodeId}`}>
        {folders.length === 0 ? (
          <div className="card-folder-empty">No folders yet</div>
        ) : folders.map((name) => {
          const selected = ownNames.has(name.toLowerCase());
          return (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={selected}
              aria-label={`folder-${name}`}
              className={selected ? "selected" : ""}
              key={name.toLowerCase()}
              onClick={() => toggleFolder(name)}
            >
              <FolderGlyph />
              <span>{name}</span>
              <span className="card-folder-check" aria-hidden="true">✓</span>
            </button>
          );
        })}
      </div>
      {adding ? (
        <input
          className="card-folder-input"
          value={text}
          aria-label={`new-folder-input-${episodeId}`}
          placeholder="Folder name"
          autoFocus
          // Spaces become dashes so the folder stays targetable via `/name` in the composer.
          onChange={(event) =>
            setText(event.currentTarget.value.replaceAll("/", "").replace(/\s+/g, "-"))
          }
          onBlur={commitNewFolder}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              commitNewFolder();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setAdding(false);
              setText("");
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="card-folder-create"
          onClick={() => {
            setText("");
            setAdding(true);
          }}
        >
          <span aria-hidden="true">＋</span>
          New folder
        </button>
      )}
    </div>
  );
}
