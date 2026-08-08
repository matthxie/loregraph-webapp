/**
 * Wire types for engine/PROTOCOL.md (version 1).
 *
 * Newline-delimited JSON-RPC 2.0 over the daemon's stdio. These shapes mirror §3 of the
 * protocol file; unknown keys arriving from the daemon must be ignored by consumers
 * (index signatures are deliberately NOT used — extra keys simply don't appear in the types).
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// JSON-RPC envelopes
// ---------------------------------------------------------------------------

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** §4 error codes (plus the client-synthesized ones). */
export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_FOUND: -32000,
  NOT_IMPLEMENTED: -32001,
  STORE_ERROR: -32002,
  PROVIDER_UNAVAILABLE: -32003,
  INVALID_INPUT: -32004,
  BUSY: -32005,
  SHUTTING_DOWN: -32006,
  /** Client-synthesized only: the pipe broke mid-request (never sent by the daemon). */
  DAEMON_GONE: -32007,
  /** Client-synthesized only: per-method timeout elapsed (not a protocol code). */
  CLIENT_TIMEOUT: -32008,
  /** v1.1 (§7.9): model.ensure could not complete the embedding-model download at all. */
  MODEL_UNAVAILABLE: -32009,
} as const;

// ---------------------------------------------------------------------------
// Shared object shapes (§3)
// ---------------------------------------------------------------------------

export interface Fact {
  source: string;
  predicate: string;
  target: string;
  status: "asserted" | "ended" | "retracted";
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string;
  episode_id: string;
  confidence: number;
  provenance: string;
  functional: boolean;
  disputed_by: Array<{ episode: string; action: string; confidence: number; at: string }>;
  rendered: string;
}

export interface EpisodeRef {
  id: string;
  title: string;
  created_at: string;
  snippet: string;
  score?: number;
}

export interface HealthResult {
  ok: boolean;
  engine_version: string;
  /**
   * Which line of development the loaded engine is (kg.BRANCH). Absent on a main-line
   * build — and absent from older daemons, so treat undefined as "main".
   */
  engine_branch?: string | null;
  protocol: number;
  /** v1.1 (§7.1): additive minor-version signal. Absent ⇒ 0 (a v1 daemon). */
  protocol_minor?: number;
  pid: number;
  uptime_s: number;
  data_dir: string;
  store_exists: boolean;
  embedder: { model: string; loaded: boolean; verified?: boolean; sha256?: string };
  /** Additive (P4, PROTOCOL §3.1): the configured LLM provider. Config only, never probed. */
  llm?: { provider: "codex" | "claude" | "anthropic" | "openai" | "mock" | "none" };
}

export interface StatsResult {
  nodes: number;
  edges: number;
  /** Present when stats is requested with a since/until time window. */
  added?: { nodes: number; edges: number };
  episodes: number;
  entities: number;
  concepts: number;
  mentions: number;
  relations: number;
  facts: { open: number; closed: number; retracted: number };
  by_node_type: Record<string, number>;
  by_edge_type: Record<string, number>;
}

export interface RetrieveParams {
  query: string;
  k?: number;
  rerank?: boolean;
  as_of?: string | null;
  /**
   * GAP-3 knobs (query-options popover). PROTOCOL v1's retrieve does not take these yet, but
   * §1 says unknown params keys are ignored — sending them is safe and forward-compatible.
   */
  mmr_lambda?: number | null;
  since?: string | null;
  until?: string | null;
}

export interface RetrieveResult {
  query: string;
  as_of: string | null;
  episodes: EpisodeRef[];
  context_episode_ids: string[];
  facts: Fact[];
  conflicts: string[];
  rendered_text: string;
}

export interface SearchParams {
  terms: string;
  k?: number;
}

export interface SearchResult {
  terms: string;
  episodes: EpisodeRef[];
}

export interface SearchNlParams {
  query: string;
  k?: number;
  as_of?: string | null;
}

/** A §9.5 hit: EpisodeRef plus the signals that found it. */
export interface SearchNlEpisodeRef extends EpisodeRef {
  /** Subset of ["semantic", "keyword"]; absent/empty against a daemon that omits it. */
  sources?: string[];
}

/**
 * `search.nl` (§9.5): the hybrid graph walk and BM25 fused by reciprocal rank — one ranked
 * list for a question-shaped query. Probe-discovered (capabilities.searchNl), so callers
 * must degrade when it is unavailable. `score` is fused RRF mass: an ORDERING, never
 * comparable to `search`'s BM25 or `retrieve`'s PPR scores.
 */
export interface SearchNlResult {
  query: string;
  as_of: string | null;
  episodes: SearchNlEpisodeRef[];
}

export interface FactsParams {
  entity: string;
  as_of?: string | null;
  include_closed?: boolean;
}

export interface FactsResult {
  entity: string;
  resolved: boolean;
  as_of: string | null;
  facts: Fact[];
}

export interface EpisodeResult {
  id: string;
  note_id: string;
  title: string;
  created_at: string;
  recorded_at: string;
  modality: string;
  source: string;
  raw_text: string | null;
  description: string | null;
  media_paths: string[];
  concepts: string[];
  entities: string[];
  /** Broad graph glyph category for each entity label. Absent on older engine builds. */
  entity_categories?: Record<string, EntityCategory>;
  /** Additive. The raw store subgraph this ingest created (PROTOCOL §3.6) — mention/tag/entity
   *  nodes and their real edge types, rendered as the dev graph; also the navigation seed. */
  graph_preview?: EpisodeGraphPreview;
  facts: Fact[];
}

export interface ProfileParams {
  as_of?: string | null;
  top?: number;
}

export interface ProfileResult {
  as_of: string | null;
  facts: Fact[];
  entities_by_type: Record<string, Array<{ name: string; doc_frequency: number }>>;
  themes: Array<{ name: string; doc_frequency: number }>;
  episode_ids: string[];
  rendered_text: string;
}

export interface Task {
  id: string;
  title: string;
  due: string | null;
  status: "open" | "done" | "dismissed";
  created_at: string;
  completed_at: string | null;
}

export interface TasksListResult {
  tasks: Task[];
}

export interface TasksAddResult {
  task: Task;
}

export interface TasksCloseResult {
  task: Task;
  open_remaining: number;
}

export interface CaptureParams {
  text: string;
  /** Authorship marker. `assistant` is reserved for AI-generated chat summaries. */
  source?: "capture" | "assistant";
  media?: string[];
  created_at?: string | null;
  replaces?: string | null;
  operation_id?: string | null;
  operation_fingerprint?: string | null;
}

export interface CaptureResult {
  status: "spooled" | "empty";
  spool_id: string | null;
  pending: number;
  episode_id?: string | null;
}

export interface PendingSpool {
  spool_id: string;
  created_at: string;
  source: string;
  text: string | null;
  urls: string[];
  attachments: string[];
  replaces: string | null;
}

export interface InboxStatusResult {
  pending: PendingSpool[];
  draining: boolean;
  batch: {
    total: number;
    done: number;
    current: string | null;
    items: Record<string, { state: "queued" | "processing" | "done" | "failed"; episode_id?: string; error?: string }>;
  } | null;
  last_receipts: Array<{ spool_id: string; note_ids: string[]; at: string; discarded?: boolean }>;
}

export interface InboxDiscardResult {
  spool_id: string;
  status: "discarded" | "processed" | "missing";
  episode_id: string | null;
}

export interface InboxDrainParams {
  spool_ids?: string[] | null;
}

export interface InboxDrainResult {
  receipts: Array<{
    spool_id: string;
    status: "ingested" | "failed" | "skipped";
    episode_id?: string;
    error?: string;
    at: string;
  }>;
  ok: number;
  failed: number;
  skipped: number;
  pending_remaining: number;
  /** What this batch's extraction cost, priced by the engine's own meter. */
  usage?: EngineSpend;
}

/**
 * Engine-priced spend for one request, in USD. The app cannot re-derive these — only kg's
 * meter sees the extraction/answer token counts — so the daemon reports dollars and main
 * subtracts them from the day's budget (main/usageLimits.ts). Always a per-request DELTA:
 * the meters behind it are cumulative.
 */
export interface EngineSpend {
  cost_usd?: number;
}

export interface InboxProgressParams {
  spool_id: string;
  state: "processing" | "done" | "failed" | "skipped";
  episode_id?: string;
  error?: string;
  done: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Cold import (`import.cold`) — bulk-ingest a codebase / chat-history export / Obsidian vault.
// One verb, discriminated by `kind`; per-kind options are ignored by the other kinds. The
// daemon runs it synchronously (no timeout client-side) and returns a normalized summary plus
// the raw engine report. Probe-discovered capability (coldImport), never minor-implied.
// ---------------------------------------------------------------------------

export type ColdImportKind = "codebase" | "chat" | "obsidian";

export interface ColdImportParams {
  kind: ColdImportKind;
  /** A directory (codebase, vault) or a file (chat export .json/.zip). */
  path: string;
  /** chat only — export flavor; "auto" sniffs it. */
  source?: "auto" | "chatgpt" | "claude" | "gemini";
  /** obsidian only — run LLM body extraction (slower/richer). false = structure-only, no LLM. */
  extract?: boolean;
  /** codebase only — ISO date lower bound for commit history. */
  since?: string | null;
  /** codebase only — cap on commits walked. */
  max_commits?: number;
  /** codebase only — the git ref to ingest (branch name; default "HEAD"). The engine reads
      that ref's tree via plumbing, so the repo's checked-out branch doesn't affect the run. */
  ref?: string;
  /** codebase only — last-synced commit; makes the run incremental over `base..ref`. The
      engine checks base is an ancestor of ref and falls back to a full ingest when it isn't
      (rebase / force-push / branch swap), so callers can always just pass their marker. */
  base?: string | null;
}

export interface ColdImportResult {
  /** What this import's extraction cost, priced by the engine's own meter. */
  usage?: EngineSpend;
  kind: ColdImportKind;
  /** Episodes ingested (chat/obsidian) or commits+files ingested (codebase). */
  imported: number;
  skipped: number;
  /** codebase only — file episodes tombstoned this run because their path no longer exists on
      the tracked ref (deleted or renamed away), so search stops returning dead code. Absent on
      an older engine that predates deletion reconciliation. */
  removed?: number;
  errors: string[];
  seconds: number;
  /** The verbatim engine report (fields vary by kind) for detail display. For codebase this
      carries `ref` / `head` / `base` / `full` — `full: true` on a run that passed a `base`
      means the engine rejected it as stale and re-ingested the whole ref. */
  report: Record<string, unknown>;
  /** chat/codebase only — ids of the episodes this run created, so the client can file them
      into a per-provider (chat) or per-repo (codebase) folder. Empty on an idempotent
      re-import/re-sync; absent for obsidian and on an older daemon that predates auto-foldering. */
  episode_ids?: string[];
}

/** `import.progress` notification — one per flushed batch (chat/obsidian only; codebase is
    single-pass and emits none, so its bar stays indeterminate). */
export interface ImportProgressParams {
  kind: ColdImportKind;
  done: number;
  total: number;
}

export interface ChatAnswerParams {
  question: string;
  k?: number;
  as_of?: string | null;
}

export interface ChatAnswerResult {
  answer: string;
  citations: string[];
  /** What this answer cost the app's daily budget, priced by the engine's own meter. */
  usage?: EngineSpend;
  /** Additive (P4, PROTOCOL §3.12): cited ids that failed the validation gate (stripped from `answer`). */
  invalid_citations?: string[];
  context: {
    episode_ids: string[];
    facts: Fact[];
    conflicts: string[];
    rendered_text: string;
  };
}

// ---------------------------------------------------------------------------
// v1.3 `chat.agent` (PROTOCOL §9) — agentic answering with graph + web tools.
// Probe-discovered (never implied by protocol_minor); main capability-gates it.
// ---------------------------------------------------------------------------

export interface ChatAgentParams {
  question: string;
  k?: number;
  as_of?: string | null;
  /** Tool-loop step ceiling; the daemon clamps to its own maximum. */
  max_steps?: number;
}

/** One completed tool call in the agent's run, in execution order (§9.2). */
export interface ChatAgentTraceStep {
  seq: number;
  tool: string;
  input_summary: string;
  output_summary: string;
}

/** `chat.agent` result = the `chat.answer` shape plus the tool trace (§9.2). */
export interface ChatAgentResult extends ChatAnswerResult {
  trace: ChatAgentTraceStep[];
  steps: number;
}

/** `agent.progress` notification params (§9.3), pushed while a chat.agent call runs. */
export interface AgentProgressParams {
  seq: number;
  state: "thinking" | "tool" | "done" | "failed";
  tool?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// GAP methods - speculative wire shapes the client is built against.
// The daemon may not serve these yet; main probes and degrades (see main/ipc.ts).
// ---------------------------------------------------------------------------

/** GAP-1 `episodes.list {offset, limit}` - full rows, newest-first. */
export interface EpisodeListRow {
  id: string;
  title: string;
  created_at: string;
  snippet: string;
  raw_text: string | null;
  /**
   * Additive (§7.2): the extraction's analyzed account of attachments / resolved links (the
   * media "image description"). Search surface; absent/null on older engine builds.
   */
  description?: string | null;
  media_paths: string[];
  modality: string;
  source: string;
  /** Additive search labels; absent when connected to an older engine build. */
  concepts?: string[];
  entities?: string[];
  entity_categories?: Record<string, EntityCategory>;
  /** Additive. The raw store subgraph this ingest created — episode + mention/tag/entity nodes
   *  and their real edge types (PROTOCOL §7.2), rendered as the dev graph. */
  graph_preview?: EpisodeGraphPreview;
}

/** Cooked kinds (episode/entity/concept) come from the topological `graph.preview`; the
 *  dev episode view (episode_raw_graph) additionally emits the raw store node types below. */
export type EpisodeGraphNodeKind =
  | "episode"
  | "entity"
  | "concept"
  | "mention"
  | "tag"
  | "relation"
  | "source"
  | "community";
export type EntityCategory = "person" | "place" | "thing";

export interface EpisodeGraphPreviewNode {
  id: string;
  label: string;
  kind: EpisodeGraphNodeKind;
  /** The contract is one hop (0|1); 2 is tolerated from older two-hop engines and clamped by the renderer. */
  hop: 0 | 1 | 2;
  /** Visible node's unique connections that continue beyond the rendered neighborhood. */
  external_connections: number;
  /** Cooked view: entity glyph category (person/place/thing; clients fall back to thing).
   *  Raw dev view: the entity's semantic type string (concept/preference/quantity/…). */
  entity_category?: EntityCategory | null;
}

export interface EpisodeGraphPreviewEdge {
  source: string;
  target: string;
  kind: string;
  label: string;
}

export interface EpisodeGraphPreview {
  nodes: EpisodeGraphPreviewNode[];
  edges: EpisodeGraphPreviewEdge[];
}

export interface EpisodesListResult {
  episodes: EpisodeListRow[];
  total: number;
}

export type BuiltinSmartRoom = "text" | "images" | "links";

export type RoomRule = { type: "builtin"; value: BuiltinSmartRoom };

export interface RoomRecord {
  id: string;
  kind: "smart";
  name: string;
  icon: string;
  count: number;
  rule?: RoomRule;
}

export interface RoomsListResult {
  rooms: RoomRecord[];
}

export interface RoomEpisodesResult extends EpisodesListResult {
  room: RoomRecord;
}

/** GAP-2 `episode.delete {id}` / `episode.reingest {id, text}`. */
export interface EpisodeDeleteResult {
  ok: boolean;
  id: string;
}

export interface EpisodeReingestResult {
  ok: boolean;
  spool_id: string;
  pending: number;
  episode_id?: string | null;
}

export interface ReadyParams {
  protocol: number;
  /** v1.1 (§7.1): additive minor-version signal on the handshake. Absent ⇒ 0. */
  protocol_minor?: number;
  engine_version: string;
  pid: number;
  data_dir: string;
}

// ---------------------------------------------------------------------------
// v1.1 GAP-4/7/6 wire shapes (PROTOCOL §7.6–§7.8). The daemon may not serve these on a v1
// build; main capability-gates them (protocol_minor ≥ 1 or a per-method probe).
// ---------------------------------------------------------------------------

/** GAP-7 `model.ensure` result (§7.7). The checksum-gate outcome rides state:"failed"+wiped.
 * Older protocol-compatible daemon builds may return only a state and error, so every field
 * beyond `state` remains optional. */
export interface ModelEnsureResult {
  state: "ready" | "failed" | "unavailable";
  model?: string;
  revision?: string;
  artifact?: string;
  sha256?: string;
  expected_sha256?: string;
  bytes?: number;
  wiped?: boolean;
  error?: string | null;
}

/** GAP-7 `model.progress` notification (§7.7). */
export interface ModelProgressParams {
  state: "downloading" | "verifying" | "ready" | "failed";
  received_bytes: number;
  total_bytes: number;
  error?: string;
}

/** GAP-6 `codex.usage` window + result (§7.8). Fails soft to available:false. */
export interface CodexUsageWindow {
  label: string;
  used_percent: number;
  resets_at: string | null;
  minutes: number | null;
}

export interface CodexUsageResult {
  available: boolean;
  plan: string | null;
  windows: CodexUsageWindow[];
}

export interface CodexSignoutResult {
  ok: boolean;
  detail?: string;
}
