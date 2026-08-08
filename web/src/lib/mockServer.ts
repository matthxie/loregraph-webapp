/**
 * In-memory implementation of Backend, used when VITE_API_BASE_URL is unset.
 *
 * It exists to prove the contract in API.md is complete and to develop the UI before the
 * service lands. Ingest is simulated with a timer: capture returns a spool id, and the note
 * turns into an episode a couple of seconds later, so the board's pending-card lifecycle is
 * exercised for real.
 */
import type { EpisodeListRow, InboxStatusResult } from "../shared/protocol";
import type {
  AppSettingsData,
  AskEvent,
  CanvasDocument,
  CaptureEcho,
  ChatMessage,
} from "../shared/api";
import type { Backend, HealthPayload, PresignResult } from "./backend";

const CAPABILITIES = {
  episodesList: true,
  episodeDelete: true,
  episodeReingest: true,
  searchNl: true,
  chatAnswer: true,
  coldImport: false,
  shuffle: true,
};

function daysAgo(days: number, hour = 10): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

let nextId = 1;
function makeRow(text: string, createdAt: string, extra: Partial<EpisodeListRow> = {}): EpisodeListRow {
  const id = `ep_${nextId++}`;
  return {
    id,
    title: text.slice(0, 48),
    created_at: createdAt,
    snippet: text.slice(0, 160),
    raw_text: text,
    media_paths: [],
    modality: "text",
    source: "capture",
    concepts: [],
    entities: [],
    ...extra,
  };
}

const SEED_NOTES: Array<[string, number]> = [
  ["Kyoto in April — Fushimi Inari before 7am, the whole trail is empty and the light through the torii is worth the alarm.", 0],
  ["Dentist moved to the 14th at 3pm. Cleaning plus the crown they keep threatening me with.", 0],
  ["The trick with sourdough is the levain, not the starter. 20% at peak, cold retard overnight.", 1],
  ["Read: 'The Rise and Fall of the Third Chimpanzee'. Diamond's earlier one — rougher than Guns Germs and Steel but the argument is cleaner.", 1],
  ["Squat 3x5 at 225 felt easy today. Bar speed is finally back after the deload.", 2],
  ["Meeting notes — Priya wants the ingest path measured before we touch the retriever. Fair. Instrument first.", 3],
  ["Coffee: Onyx Monarch, 1:16, 205F, 3:30 total. Chocolate and dried cherry, way less acidic than the Ethiopian.", 4],
  ["That restaurant on Dundas with the cold noodles — Mother's Dumplings? No, the one two doors down.", 5],
  ["Idea: a graph view that shows which notes are actually connected, not just tagged. Tags are what you thought at 2am; edges are what's true.", 6],
  ["Mom's birthday is the 22nd. She mentioned the ceramic kettle in the shop window on Ossington.", 7],
  ["Rust's borrow checker finally clicked — it's not about memory, it's about aliasing. One mutable path at a time.", 9],
  ["Flight AC118 lands 6:40am. Do not book anything before noon, past me is an optimist.", 11],
  ["The Bilbao Guggenheim is better from the river than from inside. Gehry designed the outside for the walk.", 14],
  ["Try: cutting the embedding dim to 256 and seeing if recall@10 even moves. Cheap experiment.", 18],
  ["Sleep tracked 5h12m and I felt fine, which is exactly the lie the data is supposed to catch.", 21],
];

let rows: EpisodeListRow[] = SEED_NOTES.map(([text, days]) => makeRow(text, daysAgo(days)));
const trash: Array<{ row: EpisodeListRow; deletedAt: string }> = [];
const spools = new Map<string, { text: string; state: "queued" | "done"; episodeId: string | null }>();
const chatLog: ChatMessage[] = [];
const canvases = new Map<string, { doc: CanvasDocument; etag: string }>();
let settings: AppSettingsData = {
  provider: "app-key",
  rerank: true,
  tourSeen: true,
  devCardView: false,
};

/** Deterministic shuffle so a given seed always yields the same sample (API.md §4). */
function seededSample(source: EpisodeListRow[], limit: number, seed: string): EpisodeListRow[] {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const ranked = source.map((row, index) => {
    let value = hash ^ Math.imul(index + 1, 2654435761);
    value ^= value >>> 15;
    return { row, key: value >>> 0 };
  });
  ranked.sort((a, b) => a.key - b.key);
  return ranked.slice(0, limit).map((entry) => entry.row);
}

function matches(row: EpisodeListRow, terms: string): boolean {
  const haystack = `${row.raw_text ?? ""} ${row.title}`.toLowerCase();
  return terms
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function toRef(row: EpisodeListRow, score: number) {
  return { id: row.id, title: row.title, created_at: row.created_at, snippet: row.snippet, score };
}

const delay = <T,>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

export const mockBackend: Backend = {
  health: async () =>
    delay<HealthPayload>({
      ok: true,
      engine_version: "0.2.0-mock",
      protocol: 1,
      protocol_minor: 3,
      pid: 0,
      uptime_s: 1,
      data_dir: "s3://ceb-mock/local-user/",
      store_exists: true,
      embedder: { model: "BAAI/bge-small-en-v1.5", loaded: true },
      capabilities: CAPABILITIES,
    }),

  episodesList: async ({ offset = 0, limit = 60, shuffle, seed }) => {
    const episodes = shuffle
      ? seededSample(rows, limit, seed ?? "0")
      : [...rows]
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(offset, offset + limit);
    return delay({ episodes, total: rows.length });
  },

  episodesByIds: async (ids) => {
    const wanted = new Set(ids);
    return delay({ episodes: rows.filter((row) => wanted.has(row.id)), total: rows.length });
  },

  episode: async (id) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error("not found");
    return delay({
      id: row.id,
      title: row.title,
      created_at: row.created_at,
      raw_text: row.raw_text,
      media_paths: row.media_paths,
      modality: row.modality,
      source: row.source,
      facts: [],
      entities: [],
      concepts: [],
    } as never);
  },

  graphPreview: async () => delay({ nodes: [], edges: [] }),

  search: async (terms, k = 100) => {
    const hits = rows.filter((row) => matches(row, terms)).slice(0, k);
    return delay({ episodes: hits.map((row, index) => toRef(row, 1 - index / 100)) } as never);
  },

  searchNl: async (query, k = 20) => {
    // No embeddings here: fall back to loose word overlap so the UI still ranks something.
    const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
    const scored = rows
      .map((row) => {
        const haystack = (row.raw_text ?? "").toLowerCase();
        return { row, score: words.filter((word) => haystack.includes(word)).length };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return delay({ episodes: scored.map((entry) => toRef(entry.row, entry.score)) } as never);
  },

  retrieve: async () => delay({ episodes: [], facts: [] } as never),
  facts: async () => delay({ facts: [] } as never),
  profile: async () => delay({ profile: "", facts: [] } as never),
  stats: async () =>
    delay({
      nodes: rows.length * 6,
      edges: rows.length * 9,
      episodes: rows.length,
      entities: rows.length * 3,
      concepts: rows.length * 2,
      mentions: rows.length * 4,
      relations: rows.length * 2,
      facts: { open: 12, closed: 3, retracted: 0 },
      by_node_type: {},
      by_edge_type: {},
    } as never),

  capture: async (text) => {
    const spoolId = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    spools.set(spoolId, { text, state: "queued", episodeId: null });
    // Simulated ingest: the note becomes an episode shortly after, like a real worker.
    setTimeout(() => {
      const row = makeRow(text, new Date().toISOString());
      rows = [row, ...rows];
      spools.set(spoolId, { text, state: "done", episodeId: row.id });
    }, 2200);
    return delay<CaptureEcho>(
      { status: "spooled", spoolId, text, at: new Date().toISOString() },
      60,
    );
  },

  inboxStatus: async (spoolIds) => {
    const tracked = spoolIds ?? [...spools.keys()];
    const items: InboxStatusResult["batch"] = { total: 0, done: 0, current: null, items: {} };
    const receipts: InboxStatusResult["last_receipts"] = [];
    for (const spoolId of tracked) {
      const spool = spools.get(spoolId);
      if (!spool) continue;
      items.total += 1;
      if (spool.state === "done") {
        items.done += 1;
        items.items[spoolId] = { state: "done", episode_id: spool.episodeId ?? undefined };
        receipts.push({
          spool_id: spoolId,
          note_ids: spool.episodeId ? [spool.episodeId] : [],
          at: new Date().toISOString(),
        });
      } else {
        items.items[spoolId] = { state: "processing" };
      }
    }
    const pending = [...spools.values()].filter((spool) => spool.state === "queued").length;
    return delay({
      pending: [],
      draining: pending > 0,
      batch: items.total > 0 ? items : null,
      last_receipts: receipts,
    });
  },

  canvasGet: async (collection) => {
    const stored = canvases.get(collection);
    return delay(
      stored
        ? { doc: stored.doc, etag: stored.etag }
        : {
            doc: {
              version: 1 as const,
              items: [],
              shapes: [],
              view: { x: 0, y: 0, zoom: 1 },
            },
            etag: null,
          },
    );
  },

  canvasSave: async (collection, doc, etag) => {
    const stored = canvases.get(collection);
    // Mirrors the service's optimistic-concurrency check.
    if (stored && etag !== stored.etag) throw new Error("canvas changed elsewhere");
    const next = `w/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    canvases.set(collection, { doc, etag: next });
    return delay({ etag: next }, 40);
  },

  inboxDiscard: async (spoolId) => {
    spools.delete(spoolId);
    return delay({ spool_id: spoolId, status: "discarded" as const, episode_id: null });
  },

  episodeDelete: async (id) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (row) trash.push({ row, deletedAt: new Date().toISOString() });
    rows = rows.filter((candidate) => candidate.id !== id);
    return delay(undefined);
  },

  episodeReingest: async (id, text) => {
    const spoolId = `sp_${Date.now()}`;
    const replaced = rows.find((candidate) => candidate.id === id);
    const row = makeRow(text, replaced?.created_at ?? new Date().toISOString());
    rows = rows.map((candidate) => (candidate.id === id ? row : candidate));
    return delay({ spool_id: spoolId, episode_id: row.id } as never);
  },

  pendingDelete: async (input) => {
    if (input.spoolId) spools.delete(input.spoolId);
    if (input.episodeId) rows = rows.filter((row) => row.id !== input.episodeId);
    return delay(undefined);
  },

  trashList: async () =>
    delay(
      trash.map((entry) => ({
        id: entry.row.id,
        episodeId: entry.row.id,
        title: entry.row.title,
        snippet: entry.row.snippet,
        createdAt: entry.row.created_at,
        deletedAt: entry.deletedAt,
        purgeAt: new Date(Date.parse(entry.deletedAt) + 30 * 864e5).toISOString(),
        attachmentCount: entry.row.media_paths.length,
      })),
    ),

  trashRestore: async (id) => {
    const index = trash.findIndex((entry) => entry.row.id === id);
    if (index === -1) throw new Error("not found");
    const [entry] = trash.splice(index, 1);
    if (!entry) throw new Error("not found");
    rows = [entry.row, ...rows];
    return delay({
      spoolId: null,
      episodeId: entry.row.id,
      text: entry.row.raw_text ?? "",
      createdAt: Date.parse(entry.row.created_at),
      attachmentCount: entry.row.media_paths.length,
    });
  },

  trashDeleteNow: async (id) => {
    const index = trash.findIndex((entry) => entry.row.id === id);
    if (index !== -1) trash.splice(index, 1);
    return delay(undefined);
  },

  chatAnswer: async (params) =>
    delay({
      answer: `(mock) I don't have a real model here, but you asked: "${params.question}".`,
      citations: [],
      context: { episode_ids: [], facts: [], conflicts: [], rendered_text: "" },
    }),

  async *chatStream(question, _history, signal) {
    const runId = `run_${Date.now()}`;
    yield { kind: "started", runId } as AskEvent;
    await delay(null, 300);
    if (signal.aborted) return;
    yield { kind: "activity", runId, label: "searching your graph…" } as AskEvent;
    await delay(null, 600);
    if (signal.aborted) return;
    const hits = rows.filter((row) => matches(row, question.split(/\s+/).slice(-2).join(" "))).slice(0, 2);
    const answer = hits.length
      ? `(mock) Based on ${hits.length} note${hits.length === 1 ? "" : "s"}, here's what you wrote about that.`
      : "(mock) I couldn't find anything in your notes about that.";
    const message: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: "assistant",
      text: answer,
      at: new Date().toISOString(),
      sources: hits.map((row) => ({
        kind: "memory" as const,
        label: `memory: ${row.title.slice(0, 24)}`,
        episodeId: row.id,
        snippet: row.snippet,
      })),
    };
    chatLog.push(message);
    yield { kind: "answer", runId, text: answer, sources: message.sources } as AskEvent;
    yield { kind: "done", runId, ok: true } as AskEvent;
  },

  chatHistory: async () => delay([...chatLog]),

  presignMedia: async (name) =>
    delay<PresignResult>({
      attachmentId: `att_${Date.now()}_${name.replace(/\W+/g, "")}`,
      uploadUrl: "",
      headers: {},
    }),

  mediaUrl: (leaf) => leaf,

  coldImport: async () => {
    throw new Error("cold import is not available in the mock backend");
  },

  settingsGet: async () => delay(settings),
  settingsSet: async (patch) => {
    settings = { ...settings, ...patch };
    return delay(settings);
  },
  storageUsage: async () =>
    delay({ totalBytes: 41_238_912, documentBytes: 12_884_901, mediaBytes: 28_354_011 }),
  usageLimits: async () => {
    const resets = new Date();
    resets.setHours(24, 0, 0, 0);
    return delay({
      limitUsd: 0.5,
      spentUsd: 0.11,
      remainingUsd: 0.39,
      remainingPercent: 78,
      resetsAt: resets.getTime(),
    });
  },
  linkPreview: async () => delay(null),
  dictationTranscribe: async () => delay("(mock transcription)"),
};
