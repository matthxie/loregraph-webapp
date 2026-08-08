/**
 * Renderer-side attachment helpers: turn dropped/pasted files into the base64
 * DraftFileInput the bridge stages, plus small pure display helpers. Bytes cross the bridge
 * (main owns the staging dir) — the renderer never handles filesystem paths.
 */
import type { DraftFileInput } from "../shared/api";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_FILES = 50;
const MAX_ATTACHMENT_BATCH_BYTES = 100 * 1024 * 1024;

/**
 * Wrap one File as a DraftFileInput; null if it can't be attached (directory / oversize).
 * The bytes ride as the Blob itself — there is no IPC boundary to base64 them across, and
 * the upload streams straight to S3.
 */
export async function fileToDraftInput(file: File, nameOverride?: string): Promise<DraftFileInput | null> {
  if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) return null;
  return {
    name: nameOverride ?? file.name ?? "attachment",
    contentType: file.type || null,
    blob: file,
  };
}

/** Read a FileList/array into DraftFileInputs, skipping the ones that can't be read. */
export async function filesToDraftInputs(files: FileList | File[]): Promise<DraftFileInput[]> {
  const arr: File[] = [];
  let total = 0;
  for (const file of Array.from(files)) {
    if (arr.length >= MAX_ATTACHMENT_FILES) break;
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) continue;
    if (total + file.size > MAX_ATTACHMENT_BATCH_BYTES) continue;
    total += file.size;
    arr.push(file);
  }
  const results = await Promise.all(arr.map((f) => fileToDraftInput(f)));
  return results.filter((r): r is DraftFileInput => r !== null);
}

/** Image files pasted from the clipboard, renamed "Pasted image.png" (main de-dupes numbers). */
export async function pastedImagesToInputs(data: DataTransfer | null): Promise<DraftFileInput[]> {
  if (!data) return [];
  const imgs: File[] = [];
  let total = 0;
  for (const file of Array.from(data.files)) {
    if (imgs.length >= MAX_ATTACHMENT_FILES) break;
    if (!/^image\//i.test(file.type) || file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) continue;
    if (total + file.size > MAX_ATTACHMENT_BATCH_BYTES) continue;
    total += file.size;
    imgs.push(file);
  }
  const results = await Promise.all(
    imgs.map((f) => {
      const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      return fileToDraftInput(f, `Pasted image.${ext}`);
    }),
  );
  return results.filter((r): r is DraftFileInput => r !== null);
}

/** Whether a drag carries files (drives the drop-zone affordance). */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes("Files");
}

/**
 * A sync response only has authority over attachments that were included in its request.
 * Files added while that request was in flight must survive even though the stale response
 * cannot list them yet.
 */
export function missingAttachmentIdsFromSync(
  currentIds: string[],
  requestedIds: ReadonlySet<string>,
  availableIds: ReadonlySet<string>,
): string[] {
  return currentIds.filter((id) => requestedIds.has(id) && !availableIds.has(id));
}

/** Middle-truncate a filename for a chip: "some_very_long_name.png" → "some_ve…me.png". */
export function middleTruncate(name: string, max = 22): string {
  if (name.length <= max) return name;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

/** Human byte size for a chip caption. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
