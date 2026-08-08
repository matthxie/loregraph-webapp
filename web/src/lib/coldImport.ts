/**
 * Shared state for the single in-flight cold import (bulk ingest of a codebase / chat export /
 * Obsidian vault). Lives here — not in a component — so both the Settings → Upload page (which
 * triggers it) and the global ImportToast (which shows it while Settings is closed) read the same
 * job. Coarse by design: the daemon runs the import synchronously with no progress callback in the
 * shipped engine wheel, so the states are just running → done | error, driven by the promise.
 */
import { useSyncExternalStore } from "react";
import type { ColdImportKind, ColdImportParams, ColdImportResult } from "../shared/protocol";
import { addCreatedFolder, addUserTag, updateUserTags } from "./tags";

/** Resolved chat provider (report.source) → the folder its imported sessions are filed into. */
const CHAT_SOURCE_FOLDERS: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
};

/**
 * File a finished chat import's episodes into a per-provider folder (ChatGPT / Claude / Gemini).
 * The daemon returns the exact episode ids the run created (empty on an idempotent re-import) and
 * the resolved provider rides on report.source; we add each id to the UserTagMap under that folder
 * and register the folder so it shows in the rail. No-op when either piece is missing — an older
 * daemon that omits episode_ids, or a source outside the known set.
 */
function fileImportedChats(result: ColdImportResult): void {
  const ids = result.episode_ids;
  if (!ids || ids.length === 0) return;
  const source = typeof result.report?.source === "string" ? result.report.source : "";
  const folder = CHAT_SOURCE_FOLDERS[source.toLowerCase()];
  if (!folder) return;
  updateUserTags((map) => ids.reduce((next, id) => addUserTag(next, id, folder), map));
  addCreatedFolder(folder);
}

/** Leaf of a repo path (e.g. "/x/brainbrain" -> "brainbrain"); addUserTag/addCreatedFolder do
    the actual folder-name normalization. */
function repoFolderName(repoPath: string): string {
  const parts = repoPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? repoPath;
}

/**
 * File a finished (or freshly re-synced) codebase import's episodes into a per-repo folder.
 * Mirrors fileImportedChats: no-op when there are no new episodes (an idempotent re-sync with
 * an unchanged HEAD never reaches this at all — see RepoSyncer).
 */
export function fileImportedRepo(episodeIds: readonly string[], folderName: string): void {
  if (episodeIds.length === 0) return;
  updateUserTags((map) => episodeIds.reduce((next, id) => addUserTag(next, id, folderName), map));
  addCreatedFolder(folderName);
}

export interface ColdImportJob {
  kind: ColdImportKind;
  path: string;
  phase: "running" | "done" | "error";
  result?: ColdImportResult;
  error?: string;
  startedAt: number;
  /** Per-batch progress while running (chat/obsidian); absent for codebase (single-pass). */
  progress?: { done: number; total: number };
}

let job: ColdImportJob | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ColdImportJob | null {
  return job;
}

/** The current job (null when none has run this session or it was dismissed). */
export function useColdImportJob(): ColdImportJob | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function isColdImportRunning(): boolean {
  return job?.phase === "running";
}

/** Human label for a kind, reused by the page and the toast. */
export const COLD_IMPORT_LABELS: Record<ColdImportKind, string> = {
  codebase: "codebase",
  chat: "chat history",
  obsidian: "Obsidian vault",
};

/**
 * Run a cold import. Only one at a time (the daemon serializes writes anyway, and a second import
 * would just block behind the first). Publishes the job to the shared store as it moves through
 * running → done | error. Resolves with the result or rejects with the (cleaned) error.
 */
export async function runColdImport(params: ColdImportParams): Promise<ColdImportResult> {
  if (job?.phase === "running") throw new Error("An import is already running.");
  const startedAt = Date.now();
  job = { kind: params.kind, path: params.path, phase: "running", startedAt };
  emit();
  // Live per-batch progress (chat/obsidian). Ignore events for a different kind in case one
  // arrives late; drop the subscription once the promise settles either way.
  const unsubscribe = window.graph.onImportProgress((p) => {
    if (job?.phase !== "running" || p.kind !== params.kind) return;
    job = { ...job, progress: { done: p.done, total: p.total } };
    emit();
  });
  try {
    const result = await window.graph.coldImport(params);
    if (params.kind === "chat") fileImportedChats(result);
    else if (params.kind === "codebase") fileImportedRepo(result.episode_ids ?? [], repoFolderName(params.path));
    job = { kind: params.kind, path: params.path, phase: "done", result, startedAt };
    emit();
    return result;
  } catch (e) {
    const error = (e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");
    job = { kind: params.kind, path: params.path, phase: "error", error, startedAt };
    emit();
    throw e;
  } finally {
    unsubscribe();
  }
}

/** Dismiss a finished (done/error) job. No-op while one is still running. */
export function clearColdImportJob(): void {
  if (job?.phase === "running") return;
  job = null;
  emit();
}
