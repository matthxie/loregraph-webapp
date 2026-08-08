import type { EpisodeListRow } from "../shared/protocol";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;
const URL_RE = /https?:\/\//i;

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

function queryParts(query: string): string[] {
  return (query.match(/"[^"]+"|\S+/g) ?? [])
    .map((part) => normalize(part.replace(/^"|"$/g, "")).trim())
    .filter(Boolean);
}

/** The concrete file-type tokens a row's attachments contribute ("png", "pdf", …). */
function fileTypeTokens(mediaPaths: string[]): string[] {
  return mediaPaths.flatMap((path) => {
    const leaf = path.split("/").pop() ?? "";
    const dot = leaf.lastIndexOf(".");
    if (dot <= 0 || dot === leaf.length - 1) return [];
    const ext = leaf.slice(dot + 1);
    // "jpeg photo.jpeg" also matches "jpg"; keep both spellings searchable.
    return /^jpe?g$/i.test(ext) ? ["jpg", "jpeg"] : [ext];
  });
}

/**
 * Search the visible memory surface, its extracted people/topics, the analyzed media/link
 * description, concrete file types, and useful content-type tags. Every query word must
 * match, but the words can live in different fields (for example `image black` or
 * `jude travel` or `pdf receipts`).
 */
export function matchesHistorySearch(row: EpisodeListRow, query: string): boolean {
  const parts = queryParts(query);
  if (parts.length === 0) return true;

  const raw = row.raw_text ?? "";
  const imageCount = row.media_paths.filter((path) => IMAGE_RE.test(path)).length;
  const hasLink = row.modality === "link" || URL_RE.test(raw) || URL_RE.test(row.snippet);
  const tags = [
    row.modality,
    raw.trim() ? "text note writing" : "",
    imageCount > 0 ? "image images photo photos picture pictures" : "",
    hasLink ? "link links url website web" : "",
    row.media_paths.length > imageCount ? "file files attachment attachments" : "",
    ...fileTypeTokens(row.media_paths),
  ];
  const haystack = normalize(
    [
      row.title,
      row.snippet,
      raw,
      row.description ?? "",
      row.source,
      ...(row.entities ?? []),
      ...(row.concepts ?? []),
      ...tags,
    ].join(" \n "),
  );

  return parts.every((part) => haystack.includes(part));
}

/** Openers that make even a short query a question rather than a lookup. */
const QUESTION_OPENERS = new Set([
  "what", "whats", "who", "whose", "whom", "where", "when", "why", "how", "which",
  "did", "do", "does", "is", "are", "was", "were", "can", "could", "should", "would",
  "have", "has", "had", "am", "anything", "something",
  // Imperatives that address the search box like an assistant.
  "find", "show", "tell", "list", "remind", "search", "give",
]);

/**
 * The content-type words the local filter answers precisely (they are synthesized tags, not
 * note text): a query built out of them is a filter, not a question, however long it runs.
 */
const CONTENT_TYPE_WORDS = new Set([
  "image", "images", "photo", "photos", "picture", "pictures", "link", "links", "url",
  "website", "web", "file", "files", "attachment", "attachments", "text", "note", "writing",
  "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tif", "tiff", "pdf", "doc", "docx",
  "txt", "md", "csv", "xlsx", "zip", "mp3", "mp4", "mov", "wav",
]);

/**
 * Is this query a QUESTION (answer it by meaning) or a LOOKUP (answer it by matching words)?
 *
 * The distinction picks the engine verb: a lookup goes to BM25 `search`, where every term must
 * literally appear, and a question goes to `search.nl`, which fuses the semantic walk with that
 * same BM25 lane — because BM25 alone answers "what did I say about the gym" with nothing at
 * all (the sentence's words are the user's, not the note's).
 *
 * Deliberately conservative — the lookup path is the precise one, so ambiguity keeps it:
 *   - a quoted phrase is an exact-match request, whatever else it contains;
 *   - a query made only of content-type words ("pdf receipts", "image black") is the local
 *     filter's own trick, and BM25 indexes the same file-type tokens;
 *   - otherwise it takes a question mark, a question/imperative opener, or four words.
 */
export function isSentenceQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed || trimmed.includes('"')) return false;
  const words = trimmed.split(/\s+/).map((word) => normalize(word).replace(/[^\p{L}\p{N}]/gu, ""));
  const meaningful = words.filter(Boolean);
  if (meaningful.length < 2) return false;
  if (meaningful.some((word) => CONTENT_TYPE_WORDS.has(word))) return false;
  if (trimmed.endsWith("?")) return true;
  if (QUESTION_OPENERS.has(meaningful[0] ?? "")) return meaningful.length >= 3;
  return meaningful.length >= 4;
}
