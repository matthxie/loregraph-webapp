/**
 * Collection cover images, keyed by folder name.
 *
 * Covers are downscaled to a small square before storage, so they ride in user_prefs like the
 * rest of the folder state instead of needing an upload round-trip. Collections number in the
 * tens, so a ~20 KB thumbnail each stays well inside what a prefs blob should carry.
 */
import { useSyncExternalStore } from "react";
import { readPref, writePref } from "./prefs";

const COVERS_KEY = "collection-covers";

/** Stored edge length, and the JPEG quality it is encoded at. */
const COVER_SIZE = 256;
const COVER_QUALITY = 0.82;

export type CoverMap = Record<string, string>;

export function loadCovers(): CoverMap {
  try {
    const raw = JSON.parse(readPref(COVERS_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const map: CoverMap = {};
    for (const [name, url] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof url === "string" && url.startsWith("data:image/")) map[name.toLowerCase()] = url;
    }
    return map;
  } catch {
    return {};
  }
}

let state: CoverMap | null = null;
const listeners = new Set<() => void>();

export function getCovers(): CoverMap {
  if (!state) state = loadCovers();
  return state;
}

function setCovers(next: CoverMap): void {
  state = next;
  writePref(COVERS_KEY, JSON.stringify(next));
  listeners.forEach((listener) => listener());
}

export function setCover(name: string, dataUrl: string): void {
  setCovers({ ...getCovers(), [name.toLowerCase()]: dataUrl });
}

export function clearCover(name: string): void {
  const next = { ...getCovers() };
  delete next[name.toLowerCase()];
  setCovers(next);
}

/** Drop covers whose collection is gone, so deleting one doesn't strand its image. */
export function pruneCovers(existing: ReadonlySet<string>): void {
  const current = getCovers();
  const kept = Object.fromEntries(
    Object.entries(current).filter(([name]) => existing.has(name)),
  );
  if (Object.keys(kept).length !== Object.keys(current).length) setCovers(kept);
}

export function useCovers(): CoverMap {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getCovers,
  );
}

/** Test-only: force the next read back through the store. */
export function resetCoversForTests(): void {
  state = null;
}

/**
 * Centre-crop to a square and downscale. Returns a data URL, or null if the file isn't a
 * readable image.
 */
export async function fileToCover(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/")) return null;
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("decode failed"));
      element.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) return null;
    const canvas = document.createElement("canvas");
    canvas.width = COVER_SIZE;
    canvas.height = COVER_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      COVER_SIZE,
      COVER_SIZE,
    );
    return canvas.toDataURL("image/jpeg", COVER_QUALITY);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
