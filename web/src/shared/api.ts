/**
 * The contract between this web app and the hosted graph service.
 *
 * Web descendant of brainbrain's `src/shared/bridge.ts`: same surface, served over HTTPS by the
 * FastAPI service instead of IPC to a local daemon. The UI talks only through this interface,
 * which is why the Electron UI ports across unchanged.
 *
 * Route table and wire schemas: API.md. Result shapes: protocol.ts (verbatim from brainbrain).
 * Auth, sign-in, billing and prefs go to Supabase directly, not through here.
 */
import type {
  ColdImportKind,
  ColdImportParams,
  ColdImportResult,
  ImportProgressParams,
  EpisodeReingestResult,
  EpisodeGraphPreview,
  EpisodeResult,
  EpisodesListResult,
  FactsResult,
  HealthResult,
  InboxStatusResult,
  InboxDiscardResult,
  ProfileResult,
  RetrieveParams,
  RetrieveResult,
  SearchNlResult,
  ChatAnswerParams,
  ChatAnswerResult,
  SearchResult,
  StatsResult,
} from "./protocol";

/**
 * Service reachability, in the shape the ported UI already switches on. Collapses onto whether
 * `GET /health` answers; `stopped` and `backoff` are never produced.
 */
export type EngineState = "stopped" | "starting" | "running" | "backoff" | "unavailable";

export interface EngineStatus {
  state: EngineState;
  /** Always null — no local process. */
  pid: number | null;
  restarts: number;
  detail: string | null;
  health: HealthResult | null;
}

export interface CaptureEcho {
  status: "spooled" | "empty";
  spoolId: string | null;
  text: string;
  at: string; // ISO
  attachments?: number;
  /** Set when an idempotent retry refers to an already-processed spool. */
  episodeId?: string | null;
}

/** A staged attachment. Bytes go straight to S3 via presigned PUT; `url` is a presigned GET. */
export interface DraftAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string | null;
  /** Displayable image URL; null for non-images (renders a file glyph). */
  url: string | null;
  isImage: boolean;
}

export interface DraftState {
  text: string;
  attachments: DraftAttachment[];
}

export interface DraftFileInput {
  name: string;
  contentType: string | null;
  blob: Blob;
}

export interface DraftAddResult {
  draft: DraftState;
  /** Files that couldn't be attached (unreadable / oversize / directory). */
  skipped: number;
}

/** Optional features, declared by `GET /health`. A false flag hides its pane. */
export interface Capabilities {
  episodesList: boolean;
  episodeDelete: boolean;
  episodeReingest: boolean;
  /** §9.5 natural-language search (semantic ⊕ BM25). */
  searchNl: boolean;
  chatAnswer: boolean;
  coldImport: boolean;
  /** Server-side random sampling for the board's default view. */
  shuffle: boolean;
}

export interface IngestSnapshot {
  draining: boolean;
  done: number;
  total: number;
}

export interface StorageUsageResult {
  totalBytes: number;
  documentBytes: number;
  mediaBytes: number;
}

/** Prefix marking a spent-allowance rejection; write surfaces show the sentence after it. */
export const USAGE_LIMIT_PREFIX = "USAGE_LIMIT:";

export function usageLimitMessage(message: string): string | null {
  const at = message.indexOf(USAGE_LIMIT_PREFIX);
  return at === -1 ? null : message.slice(at + USAGE_LIMIT_PREFIX.length).trim();
}

export const DAILY_BUDGET_ENFORCED = true;

/** Today's remaining allowance — one pot per day, drawn on by capture, chat and dictation. */
export interface UsageLimitsSnapshot {
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  remainingPercent: number;
  /** Epoch ms of the next local midnight. */
  resetsAt: number;
}

export interface DeletedEntrySummary {
  id: string;
  episodeId: string;
  title: string;
  snippet: string;
  createdAt: string;
  deletedAt: string;
  purgeAt: string;
  attachmentCount: number;
}

export interface DeletedRestoreResult {
  spoolId: string | null;
  episodeId: string | null;
  text: string;
  createdAt: number;
  attachmentCount: number;
}

export interface PendingDeleteInput {
  id: string;
  text: string;
  createdAt: number;
  spoolId?: string | null;
  episodeId?: string | null;
  attachmentIds?: string[];
}

export interface StatusSnapshot {
  engine: EngineStatus;
  /** The user's storage prefix, shown in Settings › Storage. */
  dataDir: string;
  pendingSpools: number;
  lastCapture: CaptureEcho | null;
  ingest: IngestSnapshot;
  capabilities: Capabilities | null;
}

/** Per-user app settings, in Supabase `user_prefs`. Provider is fixed — no local CLI on web. */
export interface AppSettingsData {
  provider: "app-key";
  rerank: boolean;
  tourSeen: boolean;
  devCardView: boolean;
}

export interface AskConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/** One message in the saved conversation. The service mints id and timestamp. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  error?: boolean;
  sources?: AskSource[];
}

/** A citation chip under an answer. No `screenshot` kind — computer use is out of scope. */
export interface AskSource {
  kind: "memory" | "profile" | "web";
  label: string;
  /** Memory sources: clicking the chip reveals the note on the board. */
  episodeId?: string;
  snippet?: string;
  /** Web sources render as a clickable embed. */
  url?: string;
}

/** Streamed chat events (SSE): started → activity* → answer|error → done. */
export type AskEvent =
  | { kind: "started"; runId: string }
  | { kind: "activity"; runId: string; label: string }
  | { kind: "answer"; runId: string; text: string; sources?: AskSource[] }
  | { kind: "error"; runId: string; message: string }
  | { kind: "done"; runId: string; ok: boolean };

/** A memory write requested by chat, rendered optimistically on the board. */
export interface AskMemoryQueued {
  spoolId: string;
  text: string;
  at: string;
  episodeId: string | null;
  ai: boolean;
  folder: string | null;
  attachments: number;
}

export interface AskMemoryRemoved {
  spoolId: string;
}

export type AskEpisodeMutation =
  | { kind: "deleted"; id: string }
  | {
      kind: "reingest-queued";
      replacesEpisodeId: string;
      spoolId: string;
      text: string;
      createdAt: number;
      episodeId: string | null;
    };

export type AskFolderAction =
  | { kind: "create"; name: string }
  | { kind: "rename"; name: string; newName: string }
  | { kind: "delete"; name: string };

export interface AskFolderActionResult {
  ok: boolean;
  message: string;
  /** True only when state changed and the action can become the undo target. */
  changed?: boolean;
}

/** Actions chat requests that run in the browser, never on the server. */
export type AskAppAction =
  | AskFolderAction
  | { kind: "entry-file"; id: string; folder: string }
  | { kind: "entry-unfile"; id: string; folder: string }
  | { kind: "entry-move"; id: string; fromFolder: string; toFolder: string }
  | { kind: "pin" | "unpin"; id: string }
  | { kind: "open-folder"; name: string }
  | { kind: "apply-filter"; query: string }
  | { kind: "undo" }
  | { kind: "memory-undo-cleanup"; ids: string[]; folder: string | null };

export type AskAppActionResult = AskFolderActionResult;

export interface AuthUser {
  id: string;
  email: string;
}

export type Plan = "free" | "basic" | "pro";

export type LinkPreviewProvider = "web" | "youtube" | "x" | "instagram" | "pinterest";

/** Fetched server-side: a browser can't read cross-origin OG tags, and client fetches would
    leak the user's IP to every link they save. */
export interface LinkPreviewResult {
  url: string;
  canonicalUrl: string;
  provider: LinkPreviewProvider;
  siteName: string | null;
  title: string | null;
  description: string | null;
  imageDataUrl: string | null;
}

/** What `lib/graphClient.ts` exposes, and what the service must serve. */
export interface CebApi {
  // -- status -----------------------------------------------------------------
  status(): Promise<StatusSnapshot>;
  onStatus(listener: (snapshot: StatusSnapshot) => void): () => void;

  // -- graph reads ------------------------------------------------------------
  stats(since?: string, until?: string): Promise<StatsResult>;
  retrieve(params: RetrieveParams): Promise<RetrieveResult>;
  /** BM25 lookup; asked wide (k=100) for name/phrase queries. */
  search(terms: string, k?: number): Promise<SearchResult>;
  /** Semantic ⊕ keyword; asked narrow (k=20) for sentence queries. */
  searchNl(query: string, k?: number): Promise<SearchNlResult>;
  facts(entity: string, asOf?: string | null, includeClosed?: boolean): Promise<FactsResult>;
  episode(id: string): Promise<EpisodeResult>;
  graphPreview(id: string): Promise<EpisodeGraphPreview>;
  profile(): Promise<ProfileResult>;
  /** `shuffle` samples the whole store; `seed` keeps a sample stable across refetches. */
  episodesList(params?: {
    offset?: number;
    limit?: number;
    shuffle?: boolean;
    seed?: string;
  }): Promise<EpisodesListResult>;
  /** Hydrate specific rows — search returns ranked ids that the sampled board may not hold. */
  episodesByIds(ids: string[]): Promise<EpisodesListResult>;
  inboxStatus(spoolIds?: string[]): Promise<InboxStatusResult>;
  inboxDiscard(spoolId: string): Promise<InboxDiscardResult>;

  // -- capture + lifecycle ----------------------------------------------------
  /** Returns once the raw note is durable and queued; extraction runs on the worker. */
  capture(text: string, operationId?: string, attachmentIds?: string[]): Promise<CaptureEcho>;
  episodeDelete(id: string): Promise<void>;
  episodeReingest(
    id: string,
    text: string,
    operationId?: string,
    attachmentIds?: string[],
  ): Promise<EpisodeReingestResult>;
  /** Delete a note still mid-ingest. */
  pendingDelete(input: PendingDeleteInput): Promise<void>;
  deletedList(): Promise<DeletedEntrySummary[]>;
  deletedRestore(id: string): Promise<DeletedRestoreResult>;
  deletedDeleteNow(id: string): Promise<void>;

  // -- chat -------------------------------------------------------------------
  chatAnswer(params: ChatAnswerParams): Promise<ChatAnswerResult>;
  /** Start a streaming run. Rejects while one is in flight, or when the allowance is gone. */
  askSubmit(question: string, history?: AskConversationMessage[]): Promise<{ runId: string }>;
  askCancel(): Promise<void>;
  onAskEvent(listener: (ev: AskEvent) => void): () => void;
  chatHistory(): Promise<ChatMessage[]>;
  onChatMessage(listener: (message: ChatMessage) => void): () => void;
  onAskMemoryQueued(listener: (memory: AskMemoryQueued) => void): () => void;
  onAskMemoryRemoved(listener: (memory: AskMemoryRemoved) => void): () => void;
  onAskEpisodeMutation(listener: (mutation: AskEpisodeMutation) => void): () => void;
  onAskAppAction(listener: (action: AskAppAction) => AskAppActionResult): () => void;

  // -- draft + attachments ----------------------------------------------------
  draftGet(): Promise<DraftState>;
  draftSetText(text: string): Promise<void>;
  draftAddFiles(files: DraftFileInput[]): Promise<DraftAddResult>;
  draftRemoveAttachment(id: string): Promise<DraftState>;
  draftSubmit(textOverride?: string): Promise<CaptureEcho>;
  draftClear(): Promise<void>;
  onDraftChanged(listener: (draft: DraftState) => void): () => void;
  writeAttachmentsGet(): Promise<DraftState>;
  writeAttachmentsSync(attachments: DraftAttachment[], retainedIds?: string[]): Promise<DraftState>;
  writeAttachmentsAdd(files: DraftFileInput[]): Promise<DraftAddResult>;
  writeAttachmentRemove(id: string): Promise<DraftState>;
  /** Resolve a wire `media_paths` entry to a displayable URL. */
  mediaUrl(mediaPath: string): string | null;

  // -- cold import ------------------------------------------------------------
  pickImportPath(kind: ColdImportKind): Promise<string | null>;
  coldImport(params: ColdImportParams): Promise<ColdImportResult>;
  onImportProgress(listener: (p: ImportProgressParams) => void): () => void;

  // -- settings / usage / storage ---------------------------------------------
  settingsGet(): Promise<{ settings: AppSettingsData }>;
  settingsSet(patch: Partial<AppSettingsData>): Promise<AppSettingsData>;
  storageUsage(): Promise<StorageUsageResult>;
  usageLimits(): Promise<UsageLimitsSnapshot>;
  onUsageLimits(listener: (usage: UsageLimitsSnapshot) => void): () => void;

  // -- accounts / billing (Supabase, not the graph service) -------------------
  authStatus(): Promise<{ user: AuthUser | null }>;
  authSignUp(
    email: string,
    password: string,
    phone?: string,
    remember?: boolean,
  ): Promise<{ confirmationRequired: boolean }>;
  authSignIn(email: string, password: string, remember?: boolean): Promise<AuthUser>;
  authSignOut(): Promise<void>;
  planStatus(): Promise<{ plan: Plan }>;
  planRefresh(): Promise<{ plan: Plan }>;
  billingCheckout(plan: Exclude<Plan, "free">): Promise<{ url: string }>;
  billingPortal(): Promise<{ url: string }>;
  tourSeen(): Promise<boolean>;
  tourMarkSeen(): Promise<void>;

  // -- misc -------------------------------------------------------------------
  linkPreview(url: string): Promise<LinkPreviewResult | null>;
  openExternal(url: string): Promise<void>;
  dictationTranscribe(wav: ArrayBuffer): Promise<string>;
}

declare global {
  interface Window {
    graph: CebApi;
  }
}
