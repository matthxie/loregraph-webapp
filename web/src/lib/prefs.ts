/**
 * Per-user prefs (folders, pins, filings, settings) backed by Supabase `user_prefs`.
 *
 * Reads are synchronous off a localStorage mirror, so tags.ts/pins.ts keep their existing
 * store shape — in-memory cache, listeners, useSyncExternalStore — unchanged. Writes go to
 * localStorage immediately and to Supabase in the background. `hydratePrefs()` pulls the
 * account's rows down at sign-in, which is what makes folders follow the user across browsers.
 */
import { supabase } from "./supabase";

const PREFIX = "ceb.prefs.";

let userId: string | null = null;
let flushTimer: number | null = null;
/** Sync switches off after repeated failures — e.g. the table hasn't been created yet. The
    localStorage mirror keeps working, so prefs stay per-browser rather than breaking. */
let syncEnabled = true;
let failures = 0;
const dirty = new Set<string>();
const hydrationListeners = new Set<() => void>();

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // Storage disabled — the value still applies this session and still syncs below.
  }
  if (!userId || !syncEnabled) return;
  dirty.add(key);
  if (flushTimer !== null) return;
  // Coalesced: a folder drag can fire several writes in a frame.
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushPrefs();
  }, 400);
}

async function flushPrefs(): Promise<void> {
  if (!userId || !syncEnabled || dirty.size === 0) return;
  const keys = [...dirty];
  dirty.clear();
  const rows = keys.map((key) => ({
    user_id: userId,
    key,
    value: JSON.parse(readPref(key) ?? "null"),
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from("user_prefs").upsert(rows, { onConflict: "user_id,key" });
  if (!error) {
    failures = 0;
    return;
  }
  failures += 1;
  if (failures >= 3) {
    syncEnabled = false;
    return;
  }
  // Re-queue so a dropped connection doesn't lose the write.
  keys.forEach((key) => dirty.add(key));
}

/** Pull this account's prefs into the local mirror. Call once per sign-in, before the UI reads. */
export async function hydratePrefs(id: string): Promise<void> {
  userId = id;
  const { data, error } = await supabase.from("user_prefs").select("key, value").eq("user_id", id);
  if (error) {
    syncEnabled = false;
    return;
  }
  if (!data) return;
  for (const row of data) {
    try {
      localStorage.setItem(PREFIX + row.key, JSON.stringify(row.value));
    } catch {
      // Storage disabled — this session reads whatever is in memory.
    }
  }
  hydrationListeners.forEach((listener) => listener());
}

/** Stores re-read from the mirror when hydration lands. */
export function onPrefsHydrated(listener: () => void): () => void {
  hydrationListeners.add(listener);
  return () => hydrationListeners.delete(listener);
}

export function clearPrefs(): void {
  userId = null;
  dirty.clear();
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Storage disabled — nothing to clear.
  }
}
