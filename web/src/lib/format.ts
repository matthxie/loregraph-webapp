/** Small formatting helpers shared by the renderer pages. Pure — unit-testable. */

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function fmtFullDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return `${date} at ${fmtTime(iso)}`;
}

export function fmtShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export type TextSegment = { kind: "text"; text: string } | { kind: "link"; url: string };

/** Split text into text/link segments (bare URLs linkified; trailing punctuation trimmed). */
export function linkifySegments(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    let url = match[0];
    // trim trailing sentence punctuation, per the spool URL contract (see spool.ts)
    while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "link", url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/**
 * A card's extracted entities, located verbatim in its note text so the board scans by what each
 * note is about. Nothing is generated or rewritten — an entity only marks up when its name
 * literally appears in the user's words (the engine's own mention spans are this same
 * case-insensitive find, so inferred/canonicalized entities simply don't highlight).
 */
export type EntitySegment = TextSegment | { kind: "entity"; text: string };

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

/** Occurrences of `name` in `text` on word boundaries, case-insensitive. */
function entityMatches(text: string, name: string): Array<{ start: number; end: number }> {
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase().trim();
  if (!needle) return [];
  const out: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (;;) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    const end = start + needle.length;
    // Word boundaries: "war" must not light up inside "software". Only guard edges that are
    // word characters themselves — an entity like "c++" keeps its punctuation edge.
    const beforeOk = start === 0 || !WORD_CHAR_RE.test(haystack[start - 1]!) || !WORD_CHAR_RE.test(needle[0]!);
    const afterOk = end === haystack.length || !WORD_CHAR_RE.test(haystack[end]!) || !WORD_CHAR_RE.test(needle[needle.length - 1]!);
    if (beforeOk && afterOk) out.push({ start, end });
    from = start + 1;
  }
  return out;
}

/** One text run split around its entity occurrences; longer names win overlaps ("oat milk" > "milk"). */
function splitEntities(text: string, entities: string[]): EntitySegment[] {
  const candidates = entities
    .flatMap((name) => entityMatches(text, name))
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const picked: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const match of candidates) {
    if (match.start < cursor) continue;
    picked.push(match);
    cursor = match.end;
  }
  const out: EntitySegment[] = [];
  let last = 0;
  for (const match of picked) {
    if (match.start > last) out.push({ kind: "text", text: text.slice(last, match.start) });
    out.push({ kind: "entity", text: text.slice(match.start, match.end) });
    last = match.end;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** Linkified segments with entity occurrences marked inside the text runs (never inside URLs). */
export function entitySegments(text: string, entities: string[]): EntitySegment[] {
  if (entities.length === 0) return linkifySegments(text);
  return linkifySegments(text).flatMap((segment) =>
    segment.kind === "text" ? splitEntities(segment.text, entities) : [segment],
  );
}

/** Markdown stripped to a plain snippet (feature spec card text). */
export function markdownToSnippet(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

// A dash run with its horizontal padding; newlines are left alone so line structure survives.
const DASH_RUN_RE = /[^\S\n]*[—–]+[^\S\n]*/g;

/**
 * The house style for preview text — card snippets, link cards, citation chips: all lowercase,
 * and em/en dashes read as commas. Applies to shown text only; the stored raw stays verbatim.
 * URLs keep their case (paths are case-sensitive) and their punctuation.
 */
export function previewText(text: string): string {
  const dashed = text.replace(DASH_RUN_RE, (match, offset: number, whole: string) => {
    const atLineStart = offset === 0 || whole[offset - 1] === "\n";
    const atLineEnd = offset + match.length >= whole.length || whole[offset + match.length] === "\n";
    // A dash with nothing on one side of it joins nothing — a comma there would dangle.
    return atLineStart || atLineEnd ? "" : ", ";
  });
  return linkifySegments(dashed)
    .map((segment) => (segment.kind === "link" ? segment.url : segment.text.toLowerCase()))
    .join("");
}

/** Predicate underscores → spaces (fact rows). */
export function humanPredicate(predicate: string): string {
  return predicate.replace(/_/g, " ");
}

/** "synced 2 min ago" / "never" — relative phrasing for a tracked repo's last sync. */
export function fmtRelative(iso: string | null, now = new Date()): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return fmtShortDate(iso);
}

/** "resets <time|date>" for a rate-limit window: time if it resets today, else short date. */
export function fmtReset(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? fmtTime(iso) : fmtShortDate(iso);
}
