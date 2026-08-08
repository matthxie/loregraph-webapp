/**
 * Spots (user tags) for the memory board. A `/name` TYPED in the composer is a filing
 * command, not text: at submit it lands in the UserTagMap (keyed by the pending
 * record id, migrated to the episode id once the daemon reports it), and the token is
 * stripped from the card's displayed text (the stored raw stays verbatim). A `/` arriving via
 * paste is inert — plain text, no spot. Because filing is recorded at capture, spot
 * membership is exactly the UserTagMap: chips, the rail, and `/name` search filters all read
 * ONLY that map — extraction entities/concepts stay out of the spot system (they remain
 * neutral chips in the detail view and feed plain-text search). Rows captured under the old
 * `#hashtag` syntax get their raw hashtags backfilled into the map once
 * (backfillHashtagUserTags), and their `#tokens` still display-strip.
 *
 * Tag names match case-insensitively. The known-tag list (for the `/` popup in the composer
 * and search) is a tiny shared store fed by the board's rows; none of this touches the daemon.
 */
import { useSyncExternalStore } from "react";
import { readPref, writePref } from "./prefs";
import type { AskFolderAction, AskFolderActionResult } from "../shared/api";

/** `/token` at start-of-text or after whitespace; letters, numbers, _ , - . Folder names can
    never contain `/`, so a token FOLLOWED by a slash (`/usr/local`) is a path, not a command —
    the lookahead rejects it outright (and bans backtracking into a shorter token). Mid-word
    slashes (URLs, and/or) don't match either. */
const TAG_PATTERN = /(?:^|\s)\/([\p{L}\p{N}_-]+)(?![\p{L}\p{N}_/-])/gu;

/** The pre-slash command: `#token`. Kept for the one-time backfill of old notes and for
    display-stripping tags filed under the old syntax (its old bracket prefixes included). */
const LEGACY_TAG_PATTERN = /(?:^|[\s([{])#([\p{L}\p{N}_-]+)/gu;

/** Slash-syntax tags (`/token`, current) — only strip when preceded by start-of-text or
    whitespace (no brackets), since filing requires whitespace-or-start. The followed-by-slash
    guard keeps path segments un-stripped. */
const SLASH_STRIP_PATTERN = /(^|\s)\/([\p{L}\p{N}_-]+)(?![\p{L}\p{N}_/-])/gu;

/** Hash-syntax tags (`#token`, legacy) — keep bracket prefixes for old notes.
    The followed-by-slash guard keeps path segments un-stripped. */
const HASH_STRIP_PATTERN = /(^|[\s([{])#([\p{L}\p{N}_-]+)(?![\p{L}\p{N}_/-])/gu;

/** Fold a raw folder name into a spot-command-safe shape: strip a leading `#`/`/`, drop all
    slashes, and collapse every run of whitespace to a single `-`. Spaces can never survive in a
    folder name, because the `/name` filing token stops at whitespace (see TAG_PATTERN) — so a
    "ceb app" folder would be untargetable. Dashes are in the token class, so `ceb-app` is. */
export function normalizeFolderName(name: string): string {
  return name
    .trim()
    .replace(/^[#/]/, "")
    .replaceAll("/", "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Unique, lowercased tag names (without the `/`) in the order first mentioned. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const match of text.matchAll(TAG_PATTERN)) {
    const tag = (match[1] as string).toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * Display-strip the card's spot commands from its text: remove each `/token` (or legacy
 * `#token`) whose name is in `names` (lowercased), leaving every other `/` and `#` alone
 * (pasted ones are ordinary text).
 * Purely presentational — the stored raw is never edited. Tidies the holes left behind:
 * doubled spaces collapse, lines that were only a tag disappear, and runs of blank lines cap
 * at one so paragraphs don't drift apart.
 */
export function stripTags(text: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return text;
  // Strip "/" syntax (current) — only with (^|\s) prefix, no brackets
  let stripped = text.replace(SLASH_STRIP_PATTERN, (match, prefix: string, tag: string) =>
    names.has(tag.toLowerCase()) ? prefix : match,
  );
  // Strip "#" syntax (legacy) — keep bracket prefixes for old notes
  stripped = stripped.replace(HASH_STRIP_PATTERN, (match, prefix: string, tag: string) =>
    names.has(tag.toLowerCase()) ? prefix : match,
  );
  if (stripped === text) return text;
  const lines = stripped.split("\n").map((line) => line.replace(/[ \t]{2,}/g, " ").trim());
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "" && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

/**
 * Split a search query into tag filters and the remaining text query. A token that is exactly
 * `/name` (optionally quoted, as omnibar filter pills are) is a tag filter; everything else
 * stays in the text query. Multiple tags intersect — a card must carry all of them.
 */
export function splitSearchTags(query: string): { tags: string[]; rest: string } {
  const tags: string[] = [];
  const rest: string[] = [];
  // Quoted filters let folders contain spaces: `"/project ideas"`. Unquoted text retains the
  // existing whitespace tokenization.
  for (const token of query.match(/"[^"]*"|\S+/g) ?? []) {
    if (!token) continue;
    const quoted = token.startsWith('"') && token.endsWith('"');
    const bare = quoted ? token.slice(1, -1) : token;
    if (/^\/[^/]+$/u.test(bare) && (quoted || !/\s/u.test(bare))) {
      tags.push(bare.slice(1).toLowerCase());
    }
    else rest.push(token);
  }
  return { tags: [...new Set(tags)], rest: rest.join(" ") };
}

/** True when the text's tags include every wanted tag (the intersection rule). */
export function hasAllTags(textTags: readonly string[], wanted: readonly string[]): boolean {
  return wanted.every((tag) => textTags.includes(tag));
}

// ---------------------------------------------------------------------------
// The spot store — episode id (or pending record id, mid-capture) → tag names, in
// user_prefs. Typed `/spots` land here at submit and the card's + button adds here too;
// reconciled like pins (an edit replaces episode A with B; deletes prune).
// ---------------------------------------------------------------------------

const USER_TAGS_KEY = "user-tags";

export type UserTagMap = Record<string, string[]>;

export function loadUserTags(): UserTagMap {
  try {
    const raw = JSON.parse(readPref(USER_TAGS_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const map: UserTagMap = {};
    let migrated = false;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(value)) {
        migrated = true;
        continue;
      }
      const tags: string[] = [];
      const seen = new Set<string>();
      for (const valueTag of value) {
        if (typeof valueTag !== "string") {
          migrated = true;
          continue;
        }
        const tag = normalizeFolderName(valueTag);
        const normalizedKey = tag.toLowerCase();
        if (!tag || seen.has(normalizedKey)) {
          migrated = true;
          continue;
        }
        seen.add(normalizedKey);
        tags.push(tag);
        if (tag !== valueTag) migrated = true;
      }
      if (tags.length > 0) map[key] = tags;
      else migrated = true;
    }
    if (migrated) {
      try {
        writePref(USER_TAGS_KEY, JSON.stringify(map));
      } catch {
        // Storage disabled/full — the canonical in-memory names still apply this session.
      }
    }
    return map;
  } catch {
    return {};
  }
}

let userTagsState: UserTagMap | null = null;
const userTagListeners = new Set<() => void>();

export function getUserTags(): UserTagMap {
  if (!userTagsState) userTagsState = loadUserTags();
  return userTagsState;
}

export function setUserTags(next: UserTagMap): void {
  if (next === userTagsState) return;
  userTagsState = next;
  try {
    writePref(USER_TAGS_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled/full — added tags simply won't persist this session.
  }
  userTagListeners.forEach((listener) => listener());
}

export function updateUserTags(change: (map: UserTagMap) => UserTagMap): void {
  setUserTags(change(getUserTags()));
}

export function subscribeUserTags(listener: () => void): () => void {
  userTagListeners.add(listener);
  return () => userTagListeners.delete(listener);
}

export function useUserTags(): UserTagMap {
  return useSyncExternalStore(subscribeUserTags, getUserTags);
}

/** Test-only: drop the module cache so a fresh read happens. */
export function resetUserTagsForTests(): void {
  userTagsState = null;
}

export function addUserTag(map: UserTagMap, episodeId: string, name: string): UserTagMap {
  // Tolerate a typed / (or old #); collapse spaces to dashes so `/name` filing stays targetable.
  const withoutPrefix = name.trim().replace(/^[#/]/, "");
  if (withoutPrefix.includes("/")) return map; // folder names can never contain a slash
  const trimmed = normalizeFolderName(name);
  if (!trimmed) return map;
  const current = map[episodeId] ?? [];
  if (current.some((tag) => tag.toLowerCase() === trimmed.toLowerCase())) return map;
  return { ...map, [episodeId]: [...current, trimmed] };
}

export function removeUserTag(map: UserTagMap, episodeId: string, name: string): UserTagMap {
  const current = map[episodeId];
  if (!current) return map;
  const kept = current.filter((tag) => tag.toLowerCase() !== name.toLowerCase());
  if (kept.length === current.length) return map;
  const next = { ...map };
  if (kept.length > 0) next[episodeId] = kept;
  else delete next[episodeId];
  return next;
}

/** A pending entry as reconcile needs it — matches PendingWriteEntry. */
export interface UserTagEntryHint {
  id: string;
  episodeId: string | null;
  replacesEpisodeId?: string | null;
}

/**
 * Keep user tags honest against the live list: follow a fresh capture's key hand-off (typed
 * `/spots` are filed under the pending record id at submit, then move to the episode id the
 * daemon assigns), follow an edit's episode replacement (A → B, merging tag sets), keep keys
 * that are mid-flight, and drop keys whose episode was deleted — but only when `pruneMissing`
 * says the full list has loaded.
 */
export function reconcileUserTags(
  map: UserTagMap,
  liveIds: ReadonlySet<string>,
  entries: readonly UserTagEntryHint[],
  pruneMissing: boolean,
): UserTagMap {
  const migrations = new Map<string, string>();
  const inFlight = new Set<string>();
  for (const entry of entries) {
    // Capture hand-off: tags keyed by the pending record id follow it to its episode.
    if (entry.episodeId && entry.episodeId !== entry.id) migrations.set(entry.id, entry.episodeId);
    else inFlight.add(entry.id);
    const replaced = entry.replacesEpisodeId;
    if (!replaced) continue;
    if (entry.episodeId && entry.episodeId !== replaced) migrations.set(replaced, entry.episodeId);
    else inFlight.add(replaced);
  }
  let changed = false;
  const next: UserTagMap = {};
  const merge = (key: string, tags: string[]) => {
    const existing = next[key] ?? [];
    const merged = [...existing];
    for (const tag of tags) {
      if (!merged.some((candidate) => candidate.toLowerCase() === tag.toLowerCase())) merged.push(tag);
    }
    next[key] = merged;
  };
  for (const [key, tags] of Object.entries(map)) {
    if (liveIds.has(key)) {
      merge(key, tags);
      continue;
    }
    const migrated = migrations.get(key);
    if (migrated) {
      merge(migrated, tags);
      changed = true;
      continue;
    }
    if (inFlight.has(key) || !pruneMissing) {
      merge(key, tags);
      continue;
    }
    changed = true; // episode is gone — drop its tags
  }
  return changed ? next : map;
}

// ---------------------------------------------------------------------------
// Card chips: user spots (the map) in accent ∪ entities/concepts in neutral, deduped.
// ---------------------------------------------------------------------------

export interface CardTagChip {
  /** Display name — no `/`, original casing preserved. */
  name: string;
  /** True for spots the user filed (typed `/name` + the card's + button); false for extraction. */
  user: boolean;
}

/**
 * The card's bottom tag section: the user's spots (the UserTagMap entry — typed hashtags land
 * there at capture) in accent, followed by the extraction's entities and concepts in neutral —
 * repeats collapsed case-insensitively, with the user variant winning.
 */
export function cardTagChips(
  row: { raw_text: string | null; entities?: string[]; concepts?: string[] },
  userAdded: readonly string[] = [],
): CardTagChip[] {
  const chips: CardTagChip[] = [];
  const seen = new Set<string>();
  const push = (name: string, user: boolean) => {
    const display = name.trim();
    const key = display.toLowerCase();
    if (!display || seen.has(key)) return;
    seen.add(key);
    chips.push({ name: display, user });
  };
  for (const tag of userAdded) push(tag, true);
  for (const entity of row.entities ?? []) push(entity, false);
  for (const concept of row.concepts ?? []) push(concept, false);
  return chips;
}

/**
 * Lowercased name set a `/tag` search term or rail selection matches against — the card's
 * USER spots only. Extraction entities/concepts deliberately don't count: "test" appearing in
 * (or extracted from) the text must not make the card answer for a /test spot.
 */
export function spotNames(userAdded: readonly string[] = []): Set<string> {
  return new Set(userAdded.map((name) => name.toLowerCase()));
}

/** Spots the user has created, on live cards — the `/` popup's list. */
export function knownCreatedTags(
  rows: ReadonlyArray<{ id: string; raw_text: string | null }>,
  userTags: UserTagMap,
): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    for (const tag of userTags[row.id] ?? []) names.add(tag.toLowerCase());
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * One-time migration for rows captured before filing moved into the map: copy each live row's
 * raw-text `#hashtags` (the OLD command syntax — hence the legacy pattern, not parseTags) into
 * its UserTagMap entry. Returns the same map reference when nothing changed. After this runs,
 * raw text is never again read for spots — which is what makes pasted tokens inert.
 */
export function backfillHashtagUserTags(
  rows: ReadonlyArray<{ id: string; raw_text: string | null }>,
  map: UserTagMap,
): UserTagMap {
  let next = map;
  for (const row of rows) {
    for (const match of (row.raw_text ?? "").matchAll(LEGACY_TAG_PATTERN)) {
      next = addUserTag(next, row.id, (match[1] as string).toLowerCase());
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// The folder list — every folder the user has, whether or not a card is filed in it. Folders
// arrive here from "New folder", from the card's folder picker, and (via registerFolders) from
// every `/name` the cards carry, and they only ever leave through deleteFolder. That is what
// makes an EMPTY folder a real thing: unfiling its last card, or deleting that card, leaves
// the folder standing, ready to be filed into again. The board's sidebar is this list unioned
// with the folders the live cards carry. Names are lowercased and can never contain a slash.
// ---------------------------------------------------------------------------

const CREATED_FOLDERS_KEY = "created-folders";

export function loadCreatedFolders(): string[] {
  try {
    const raw = JSON.parse(readPref(CREATED_FOLDERS_KEY) ?? "null") as unknown;
    if (!Array.isArray(raw)) return [];
    const names: string[] = [];
    let migrated = false;
    for (const value of raw) {
      if (typeof value !== "string") {
        migrated = true;
        continue;
      }
      const name = normalizeFolderName(value).toLowerCase();
      if (!name || names.includes(name)) {
        migrated = true;
        continue;
      }
      names.push(name);
      if (name !== value) migrated = true;
    }
    if (migrated) {
      try {
        writePref(CREATED_FOLDERS_KEY, JSON.stringify(names));
      } catch {
        // Storage disabled/full — the canonical in-memory names still apply this session.
      }
    }
    return names;
  } catch {
    return [];
  }
}

let createdFoldersState: string[] | null = null;
const createdFolderListeners = new Set<() => void>();

export function getCreatedFolders(): string[] {
  if (!createdFoldersState) createdFoldersState = loadCreatedFolders();
  return createdFoldersState;
}

export function setCreatedFolders(next: string[]): void {
  if (next === createdFoldersState) return;
  createdFoldersState = next;
  try {
    writePref(CREATED_FOLDERS_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled/full — the folder simply won't survive the session.
  }
  createdFolderListeners.forEach((listener) => listener());
}

export function subscribeCreatedFolders(listener: () => void): () => void {
  createdFolderListeners.add(listener);
  return () => createdFolderListeners.delete(listener);
}

export function useCreatedFolders(): string[] {
  return useSyncExternalStore(subscribeCreatedFolders, getCreatedFolders);
}

/** Test-only: drop the module cache so a fresh read happens. */
export function resetCreatedFoldersForTests(): void {
  createdFoldersState = null;
}

/** Create a folder by name — sanitized like every folder name; a duplicate is a no-op. */
export function addCreatedFolder(name: string): void {
  const trimmed = normalizeFolderName(name).toLowerCase();
  if (!trimmed) return;
  const current = getCreatedFolders();
  if (current.includes(trimmed)) return;
  setCreatedFolders([...current, trimmed]);
}

function normalizedFolderName(value: string): string | null {
  const raw = value.trim().replace(/^#/, "");
  if (raw.includes("/") || /[\u0000-\u001f\u007f]/u.test(raw)) return null;
  const name = normalizeFolderName(raw).toLowerCase();
  if (!name || name.length > 80) return null;
  return name;
}

function allFolderNames(map: UserTagMap, created: readonly string[]): Set<string> {
  const names = new Set(created.map((name) => name.toLowerCase()));
  for (const tags of Object.values(map)) {
    for (const tag of tags) names.add(tag.toLowerCase());
  }
  return names;
}

/**
 * Delete a folder WITHOUT touching its entries: the name leaves every card's tag list and the
 * created-folders list, and the cards themselves stay on the board, filed wherever else they
 * were. Deleting a folder is a filing decision, never a data deletion.
 */
export function deleteFolder(name: string): boolean {
  const target = normalizeFolderName(name).toLowerCase();
  if (!target) return false;
  let changed = false;
  const map = getUserTags();
  const nextMap: UserTagMap = {};
  for (const [episodeId, tags] of Object.entries(map)) {
    const kept = tags.filter((tag) => tag.toLowerCase() !== target);
    if (kept.length !== tags.length) changed = true;
    if (kept.length > 0) nextMap[episodeId] = kept;
  }
  if (changed) setUserTags(nextMap);
  const created = getCreatedFolders();
  const nextCreated = created.filter((folder) => folder.toLowerCase() !== target);
  if (nextCreated.length !== created.length) {
    setCreatedFolders(nextCreated);
    changed = true;
  }
  return changed;
}

/**
 * Record every folder the cards carry in the durable list, so a folder outlives its cards: a
 * folder created here (or by typing `/name`) exists until it is explicitly deleted. Unfiling
 * the last card, editing the `/name` away, or deleting the entry leaves an EMPTY folder — the
 * one thing that removes a folder is deleteFolder.
 */
export function registerFolders(names: Iterable<string>): void {
  const current = getCreatedFolders();
  const seen = new Set(current);
  const next = [...current];
  for (const name of names) {
    const folder = normalizeFolderName(name).toLowerCase();
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    next.push(folder);
  }
  if (next.length !== current.length) setCreatedFolders(next);
}

// ---------------------------------------------------------------------------
// Hidden folders — folders the user has muted from the default (no-selection) board view.
// Hiding never touches a folder's cards or tags; it only suppresses them from the ALL view
// until the folder is explicitly selected in the sidebar (or typed as a `/tag` search term),
// which always wins over the hidden flag. Persisted like createdFolders, lowercased names.
// ---------------------------------------------------------------------------

const HIDDEN_FOLDERS_KEY = "hidden-folders";

export function loadHiddenFolders(): string[] {
  try {
    const raw = JSON.parse(readPref(HIDDEN_FOLDERS_KEY) ?? "null") as unknown;
    if (!Array.isArray(raw)) return [];
    const names: string[] = [];
    for (const value of raw) {
      if (typeof value !== "string") continue;
      const name = normalizeFolderName(value).toLowerCase();
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

let hiddenFoldersState: string[] | null = null;
const hiddenFolderListeners = new Set<() => void>();

export function getHiddenFolders(): string[] {
  if (!hiddenFoldersState) hiddenFoldersState = loadHiddenFolders();
  return hiddenFoldersState;
}

export function setHiddenFolders(next: string[]): void {
  if (next === hiddenFoldersState) return;
  hiddenFoldersState = next;
  try {
    writePref(HIDDEN_FOLDERS_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled/full — the hide simply won't survive the session.
  }
  hiddenFolderListeners.forEach((listener) => listener());
}

export function subscribeHiddenFolders(listener: () => void): () => void {
  hiddenFolderListeners.add(listener);
  return () => hiddenFolderListeners.delete(listener);
}

export function useHiddenFolders(): string[] {
  return useSyncExternalStore(subscribeHiddenFolders, getHiddenFolders);
}

/** Test-only: drop the module cache so a fresh read happens. */
export function resetHiddenFoldersForTests(): void {
  hiddenFoldersState = null;
}

/** Hide or unhide a folder from the default board view — a no-op if already in that state. */
export function setFolderHidden(name: string, hidden: boolean): void {
  const trimmed = name.toLowerCase();
  const current = getHiddenFolders();
  if (hidden) {
    if (current.includes(trimmed)) return;
    setHiddenFolders([...current, trimmed]);
  } else {
    const next = current.filter((candidate) => candidate !== trimmed);
    if (next.length !== current.length) setHiddenFolders(next);
  }
}

/** Drop hidden names whose folder no longer exists (deleteFolder is the one remover). */
export function pruneHiddenFolders(existing: ReadonlySet<string>): void {
  const current = getHiddenFolders();
  const kept = current.filter((name) => existing.has(name));
  if (kept.length !== current.length) setHiddenFolders(kept);
}

// ---------------------------------------------------------------------------
// Folder visibility — the toolbar's "Only show / Don't show" dropdown. Two modes over the
// same board: "dont" suppresses the checked folders from the default view (that list IS the
// hidden-folders store above, shared with the sidebar's Hide), while "only" narrows the
// board to nothing but the checked folders. Explicit selection (rail click, typed `/tag`)
// always wins over either mode. Persisted lowercased, like the stores above.
// ---------------------------------------------------------------------------

const FOLDER_VISIBILITY_KEY = "folder-visibility";

export type FolderVisibilityMode = "dont" | "only";

export interface FolderVisibility {
  mode: FolderVisibilityMode;
  /** The folders the board is narrowed to in "only" mode. Empty = no narrowing. */
  only: string[];
}

export function loadFolderVisibility(): FolderVisibility {
  try {
    const raw = JSON.parse(readPref(FOLDER_VISIBILITY_KEY) ?? "null") as unknown;
    if (typeof raw !== "object" || raw === null) return { mode: "dont", only: [] };
    const candidate = raw as Partial<FolderVisibility>;
    const only: string[] = [];
    if (Array.isArray(candidate.only)) {
      for (const value of candidate.only) {
        if (typeof value !== "string") continue;
        const name = normalizeFolderName(value).toLowerCase();
        if (name && !only.includes(name)) only.push(name);
      }
    }
    return { mode: candidate.mode === "only" ? "only" : "dont", only };
  } catch {
    return { mode: "dont", only: [] };
  }
}

let folderVisibilityState: FolderVisibility | null = null;
const folderVisibilityListeners = new Set<() => void>();

export function getFolderVisibility(): FolderVisibility {
  if (!folderVisibilityState) folderVisibilityState = loadFolderVisibility();
  return folderVisibilityState;
}

export function setFolderVisibility(next: FolderVisibility): void {
  if (next === folderVisibilityState) return;
  folderVisibilityState = next;
  try {
    writePref(FOLDER_VISIBILITY_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled/full — the filter simply won't survive the session.
  }
  folderVisibilityListeners.forEach((listener) => listener());
}

export function subscribeFolderVisibility(listener: () => void): () => void {
  folderVisibilityListeners.add(listener);
  return () => folderVisibilityListeners.delete(listener);
}

export function useFolderVisibility(): FolderVisibility {
  return useSyncExternalStore(subscribeFolderVisibility, getFolderVisibility);
}

/** Test-only: drop the module cache so a fresh read happens. */
export function resetFolderVisibilityForTests(): void {
  folderVisibilityState = null;
}

export function setFolderVisibilityMode(mode: FolderVisibilityMode): void {
  const current = getFolderVisibility();
  if (current.mode !== mode) setFolderVisibility({ ...current, mode });
}

/** Check or uncheck a folder in the "only" list — a no-op if already in that state. */
export function setFolderOnly(name: string, only: boolean): void {
  const trimmed = name.toLowerCase();
  const current = getFolderVisibility();
  if (only) {
    if (current.only.includes(trimmed)) return;
    setFolderVisibility({ ...current, only: [...current.only, trimmed] });
  } else {
    const next = current.only.filter((candidate) => candidate !== trimmed);
    if (next.length !== current.only.length) setFolderVisibility({ ...current, only: next });
  }
}

/** Drop "only" names whose folder no longer exists, mirroring pruneHiddenFolders. */
export function pruneOnlyFolders(existing: ReadonlySet<string>): void {
  const current = getFolderVisibility();
  const kept = current.only.filter((name) => existing.has(name));
  if (kept.length !== current.only.length) setFolderVisibility({ ...current, only: kept });
}

// ---------------------------------------------------------------------------
// Pending filings — typed `/spots` queued at submit, joined to their episode BY TEXT.
// Record/pending ids are unstable (block re-keying) and the episode id can appear and vanish
// within one render batch, so the durable join is the submitted text itself: the composer
// pushes entries here, and the BOARD consumes them — one consumer, at the one moment a
// permanent key exists, when a refetch first shows a row whose verbatim raw_text matches. The
// composer only peeks, to wear the chip on its pending card while the note ingests; consuming
// there would spend the entry on a provisional key the board's reconcile then prunes, losing
// the filing for good. In-memory only: the queue dies with the session, which also means a
// restart can never mis-file an old identical note.
// ---------------------------------------------------------------------------

export interface PendingFiling {
  /** The submitted draft text — equals the episode's stored raw_text (raw is verbatim). */
  text: string;
  spots: string[];
}

let pendingFilings: PendingFiling[] = [];

export function pushPendingFiling(filing: PendingFiling): void {
  pendingFilings = [...pendingFilings, filing];
}

/** The first unconsumed filing for this text, without consuming it (the composer's chip). */
export function peekPendingFiling(text: string): PendingFiling | undefined {
  return pendingFilings.find((filing) => filing.text === text);
}

/** Consume and return the first filing matching this text — one entry per submission, so two
    identical notes each keep their own filing. */
export function takePendingFiling(text: string): string[] | null {
  const index = pendingFilings.findIndex((filing) => filing.text === text);
  if (index < 0) return null;
  const [taken] = pendingFilings.splice(index, 1);
  return taken ? taken.spots : null;
}

/** Test-only: drop queued filings between cases. */
export function resetPendingFilingsForTests(): void {
  pendingFilings = [];
}

// ---------------------------------------------------------------------------
// Known tags (composer autocomplete) — fed by the board's loaded rows.
// ---------------------------------------------------------------------------

let knownTags: string[] = [];
const listeners = new Set<() => void>();

export function setKnownTags(tags: string[]): void {
  if (tags.length === knownTags.length && tags.every((tag, index) => knownTags[index] === tag)) return;
  knownTags = tags;
  listeners.forEach((listener) => listener());
}

export function getKnownTags(): string[] {
  return knownTags;
}

export function subscribeKnownTags(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKnownTags(): string[] {
  return useSyncExternalStore(subscribeKnownTags, getKnownTags);
}

/** Test-only: reset the shared known-tag list. */
export function resetKnownTagsForTests(): void {
  knownTags = [];
}

// ---------------------------------------------------------------------------
// `/` composer autocomplete
// ---------------------------------------------------------------------------

/**
 * The in-progress `/tag` token at the end of the draft, or null when the draft doesn't end in
 * one (whitespace after the token ends it — the tag is already complete text, nothing to do).
 */
export function tagTyping(text: string): { prefix: string; partial: string } | null {
  const match = /(^|\s)\/([\p{L}\p{N}_-]*)$/u.exec(text);
  if (!match) return null;
  return { prefix: text.slice(0, text.length - (match[2] as string).length), partial: (match[2] as string).toLowerCase() };
}

/** Known tags matching the partial being typed, excluding an exact match (nothing to complete). */
export function tagSuggestions(known: readonly string[], text: string): string[] {
  const typing = tagTyping(text);
  if (!typing) return [];
  // No cap — the popup is a scrollable list of everything previously created that matches.
  return known.filter((tag) => tag.startsWith(typing.partial) && tag !== typing.partial);
}

/** Complete the trailing partial with the chosen tag and a trailing space. */
export function applyTagSuggestion(text: string, tag: string): string {
  const typing = tagTyping(text);
  if (!typing) return text;
  return `${typing.prefix}${tag} `;
}

export function applyAskFolderAction(action: AskFolderAction): AskFolderActionResult {
  const name = normalizedFolderName(action.name);
  if (!name) return { ok: false, message: "Folder names must be 1–80 characters and cannot contain /.", changed: false };

  const map = getUserTags();
  const created = getCreatedFolders();
  const names = allFolderNames(map, created);

  if (action.kind === "create") {
    if (names.has(name)) return { ok: true, message: `Folder "${name}" already exists.`, changed: false };
    setCreatedFolders([...created, name]);
    return { ok: true, message: `Created folder "${name}".`, changed: true };
  }

  if (!names.has(name)) return { ok: false, message: `Folder "${name}" does not exist.`, changed: false };

  if (action.kind === "delete") {
    deleteFolder(name);
    return { ok: true, message: `Deleted folder "${name}". Its entries were kept.`, changed: true };
  }

  const newName = normalizedFolderName(action.newName);
  if (!newName) return { ok: false, message: "Folder names must be 1–80 characters and cannot contain /.", changed: false };
  if (newName === name) return { ok: true, message: `Folder "${name}" already has that name.`, changed: false };
  if (names.has(newName)) return { ok: false, message: `Folder "${newName}" already exists.`, changed: false };

  let tagsChanged = false;
  const nextMap: UserTagMap = {};
  for (const [episodeId, tags] of Object.entries(map)) {
    const renamed = tags.map((tag) => tag.toLowerCase() === name ? newName : tag);
    if (renamed.some((tag, index) => tag !== tags[index])) tagsChanged = true;
    nextMap[episodeId] = renamed;
  }
  if (tagsChanged) setUserTags(nextMap);
  const nextCreated = created.map((folder) => folder.toLowerCase() === name ? newName : folder);
  if (nextCreated.some((folder, index) => folder !== created[index])) setCreatedFolders(nextCreated);
  return { ok: true, message: `Renamed folder "${name}" to "${newName}".`, changed: true };
}
