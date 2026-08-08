import type { AskAppAction, AskAppActionResult } from "../shared/api";
import {
  addCreatedFolder,
  addUserTag,
  applyAskFolderAction,
  getCreatedFolders,
  getUserTags,
  normalizeFolderName,
  removeUserTag,
  setCreatedFolders,
  setFolderHidden,
  setUserTags,
  type UserTagMap,
} from "./tags";
import { getPins, setPins } from "./pins";

interface AppStateSnapshot {
  tags: UserTagMap;
  folders: string[];
  pins: string[];
}

interface ChatActionDependencies {
  applyFilter(query: string): void;
}

let lastUndo: { snapshot: AppStateSnapshot; description: string } | null = null;

function snapshotState(): AppStateSnapshot {
  return {
    tags: Object.fromEntries(Object.entries(getUserTags()).map(([id, tags]) => [id, [...tags]])),
    folders: [...getCreatedFolders()],
    pins: [...getPins()],
  };
}

function stateChanged(before: AppStateSnapshot): boolean {
  return (
    JSON.stringify(before.tags) !== JSON.stringify(getUserTags()) ||
    JSON.stringify(before.folders) !== JSON.stringify(getCreatedFolders()) ||
    JSON.stringify(before.pins) !== JSON.stringify(getPins())
  );
}

function rememberUndo(before: AppStateSnapshot, description: string): void {
  if (stateChanged(before)) lastUndo = { snapshot: before, description };
}

function normalizedFolder(value: string): string | null {
  const raw = value.trim().replace(/^#/, "");
  if (raw.includes("/") || /[\u0000-\u001f\u007f]/u.test(raw)) return null;
  const name = normalizeFolderName(raw).toLowerCase();
  return name && name.length <= 80
    ? name
    : null;
}

function hasFolder(name: string): boolean {
  if (getCreatedFolders().some((folder) => folder.toLowerCase() === name)) return true;
  return Object.values(getUserTags()).some((tags) => tags.some((tag) => tag.toLowerCase() === name));
}

function folderError(value: string): AskAppActionResult | null {
  return normalizedFolder(value)
    ? null
    : { ok: false, message: "Folder names must be 1–80 characters and cannot contain /.", changed: false };
}

/** File a popup-created pending memory and make its local filing part of the same undo step. */
export function recordAskMemoryFiling(id: string, folder: string): void {
  const name = normalizedFolder(folder);
  if (!name) return;
  const before = snapshotState();
  // The daily chat summary's folder starts hidden: chat memory is kept, editable and
  // deletable, without ever crowding the home board. Only its FIRST filing hides it — a
  // user who unhid the folder isn't fought on every later summary.
  if (name === "chat-summary" && !hasFolder(name)) setFolderHidden(name, true);
  addCreatedFolder(name);
  setUserTags(addUserTag(getUserTags(), id, name));
  rememberUndo(before, "memory creation");
}

/** Test-only: isolate action histories. */
export function resetChatActionUndoForTests(): void {
  lastUndo = null;
}

/**
 * Apply the renderer-owned half of the popup action allowlist. Every persistent mutation is
 * snapshotted as one undo step; navigation never replaces the last undoable mutation.
 */
export function applyAskAppAction(
  action: AskAppAction,
  deps: ChatActionDependencies,
): AskAppActionResult {
  if (action.kind === "undo") {
    if (!lastUndo) return { ok: false, message: "There is no chat action to undo.", changed: false };
    const { snapshot, description } = lastUndo;
    lastUndo = null;
    setUserTags(snapshot.tags);
    setCreatedFolders(snapshot.folders);
    setPins(snapshot.pins);
    return { ok: true, message: `Undid the last ${description}.`, changed: true };
  }

  if (action.kind === "open-folder") {
    const name = normalizedFolder(action.name);
    if (!name || !hasFolder(name)) {
      return { ok: false, message: `Folder "${action.name.trim().toLowerCase()}" does not exist.`, changed: false };
    }
    deps.applyFilter(`/${name}`);
    return { ok: true, message: `Opened folder "${name}".`, changed: false };
  }

  if (action.kind === "apply-filter") {
    const query = action.query.trim();
    if (!query) return { ok: false, message: "A search filter cannot be empty.", changed: false };
    deps.applyFilter(query);
    return { ok: true, message: `Applied filter "${query}".`, changed: false };
  }

  const before = snapshotState();

  if (action.kind === "create" || action.kind === "rename" || action.kind === "delete") {
    const result = applyAskFolderAction(action);
    if (result.ok && result.changed) rememberUndo(before, "folder change");
    return result;
  }

  if (action.kind === "pin" || action.kind === "unpin") {
    const current = getPins();
    const pinned = current.includes(action.id);
    if ((action.kind === "pin" && pinned) || (action.kind === "unpin" && !pinned)) {
      return {
        ok: true,
        message: `Entry "${action.id}" is already ${action.kind === "pin" ? "pinned" : "unpinned"}.`,
        changed: false,
      };
    }
    setPins(action.kind === "pin"
      ? [action.id, ...current]
      : current.filter((id) => id !== action.id));
    rememberUndo(before, `${action.kind} action`);
    return { ok: true, message: `${action.kind === "pin" ? "Pinned" : "Unpinned"} entry "${action.id}".`, changed: true };
  }

  if (action.kind === "entry-file") {
    const error = folderError(action.folder);
    if (error) return error;
    const folder = normalizedFolder(action.folder) as string;
    addCreatedFolder(folder);
    const next = addUserTag(getUserTags(), action.id, folder);
    if (next === getUserTags()) {
      return { ok: true, message: `Entry "${action.id}" is already in folder "${folder}".`, changed: false };
    }
    setUserTags(next);
    rememberUndo(before, "entry filing");
    return { ok: true, message: `Filed entry "${action.id}" in folder "${folder}".`, changed: true };
  }

  if (action.kind === "entry-unfile") {
    const error = folderError(action.folder);
    if (error) return error;
    const folder = normalizedFolder(action.folder) as string;
    const next = removeUserTag(getUserTags(), action.id, folder);
    if (next === getUserTags()) {
      return { ok: false, message: `Entry "${action.id}" is not in folder "${folder}".`, changed: false };
    }
    setUserTags(next);
    rememberUndo(before, "entry unfiling");
    return { ok: true, message: `Removed entry "${action.id}" from folder "${folder}".`, changed: true };
  }

  if (action.kind === "entry-move") {
    const fromError = folderError(action.fromFolder);
    const toError = folderError(action.toFolder);
    if (fromError || toError) return fromError ?? toError as AskAppActionResult;
    const from = normalizedFolder(action.fromFolder) as string;
    const to = normalizedFolder(action.toFolder) as string;
    if (from === to) return { ok: true, message: `Entry "${action.id}" is already in folder "${to}".`, changed: false };
    const withoutSource = removeUserTag(getUserTags(), action.id, from);
    if (withoutSource === getUserTags()) {
      return { ok: false, message: `Entry "${action.id}" is not in folder "${from}".`, changed: false };
    }
    addCreatedFolder(to);
    setUserTags(addUserTag(withoutSource, action.id, to));
    rememberUndo(before, "entry move");
    return { ok: true, message: `Moved entry "${action.id}" from "${from}" to "${to}".`, changed: true };
  }

  return { ok: false, message: "That action is not available in chat.", changed: false };
}
