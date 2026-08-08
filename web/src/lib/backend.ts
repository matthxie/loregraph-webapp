/**
 * Route-level view of the graph service — one method per API.md route, no client state.
 * graphClient.ts builds the CebApi surface on top; mockServer.ts is the other implementation.
 */
import type {
  ColdImportParams,
  ColdImportResult,
  EpisodeGraphPreview,
  EpisodeReingestResult,
  EpisodeResult,
  EpisodesListResult,
  FactsResult,
  HealthResult,
  InboxDiscardResult,
  InboxStatusResult,
  ProfileResult,
  RetrieveParams,
  RetrieveResult,
  SearchNlResult,
  SearchResult,
  StatsResult,
  ChatAnswerParams,
  ChatAnswerResult,
} from "../shared/protocol";
import type {
  AppSettingsData,
  AskConversationMessage,
  AskEvent,
  Capabilities,
  CaptureEcho,
  ChatMessage,
  DeletedEntrySummary,
  DeletedRestoreResult,
  LinkPreviewResult,
  PendingDeleteInput,
  StorageUsageResult,
  UsageLimitsSnapshot,
} from "../shared/api";
import { request, stream } from "./http";

export interface PresignResult {
  attachmentId: string;
  uploadUrl: string;
  headers: Record<string, string>;
}

export interface HealthPayload extends HealthResult {
  capabilities: Capabilities;
}

export interface Backend {
  health(): Promise<HealthPayload>;
  episodesList(params: {
    offset?: number;
    limit?: number;
    shuffle?: boolean;
    seed?: string;
  }): Promise<EpisodesListResult>;
  episodesByIds(ids: string[]): Promise<EpisodesListResult>;
  episode(id: string): Promise<EpisodeResult>;
  graphPreview(id: string): Promise<EpisodeGraphPreview>;
  search(terms: string, k?: number): Promise<SearchResult>;
  searchNl(query: string, k?: number): Promise<SearchNlResult>;
  retrieve(params: RetrieveParams): Promise<RetrieveResult>;
  facts(entity: string, asOf?: string | null, includeClosed?: boolean): Promise<FactsResult>;
  profile(): Promise<ProfileResult>;
  stats(since?: string, until?: string): Promise<StatsResult>;

  capture(text: string, operationId?: string, attachmentIds?: string[]): Promise<CaptureEcho>;
  inboxStatus(spoolIds?: string[]): Promise<InboxStatusResult>;
  inboxDiscard(spoolId: string): Promise<InboxDiscardResult>;
  episodeDelete(id: string): Promise<void>;
  episodeReingest(
    id: string,
    text: string,
    operationId?: string,
    attachmentIds?: string[],
  ): Promise<EpisodeReingestResult>;
  pendingDelete(input: PendingDeleteInput): Promise<void>;
  trashList(): Promise<DeletedEntrySummary[]>;
  trashRestore(id: string): Promise<DeletedRestoreResult>;
  trashDeleteNow(id: string): Promise<void>;

  chatAnswer(params: ChatAnswerParams): Promise<ChatAnswerResult>;
  chatStream(
    question: string,
    history: AskConversationMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<AskEvent>;
  chatHistory(): Promise<ChatMessage[]>;

  presignMedia(name: string, contentType: string | null, size: number): Promise<PresignResult>;
  mediaUrl(leaf: string): string;

  coldImport(params: ColdImportParams): Promise<ColdImportResult>;
  settingsGet(): Promise<AppSettingsData>;
  settingsSet(patch: Partial<AppSettingsData>): Promise<AppSettingsData>;
  storageUsage(): Promise<StorageUsageResult>;
  usageLimits(): Promise<UsageLimitsSnapshot>;
  linkPreview(url: string): Promise<LinkPreviewResult | null>;
  dictationTranscribe(wav: ArrayBuffer): Promise<string>;
}

export const httpBackend: Backend = {
  health: () => request<HealthPayload>("/health"),
  episodesList: (params) =>
    request<EpisodesListResult>("/episodes", {
      query: {
        offset: params.offset,
        limit: params.limit,
        shuffle: params.shuffle ? 1 : undefined,
        seed: params.seed,
      },
    }),
  episodesByIds: (ids) =>
    request<EpisodesListResult>("/episodes", { query: { ids: ids.join(",") } }),
  episode: (id) => request<EpisodeResult>(`/episodes/${encodeURIComponent(id)}`),
  graphPreview: (id) => request<EpisodeGraphPreview>(`/episodes/${encodeURIComponent(id)}/graph`),
  search: (terms, k) => request<SearchResult>("/search", { query: { q: terms, k } }),
  searchNl: (query, k) => request<SearchNlResult>("/search/nl", { body: { query, k } }),
  retrieve: (params) => request<RetrieveResult>("/retrieve", { body: params }),
  facts: (entity, asOf, includeClosed) =>
    request<FactsResult>("/facts", {
      query: { entity, as_of: asOf ?? undefined, include_closed: includeClosed },
    }),
  profile: () => request<ProfileResult>("/profile"),
  stats: (since, until) => request<StatsResult>("/stats", { query: { since, until } }),

  capture: (text, operationId, attachmentIds) =>
    request<CaptureEcho>("/capture", {
      body: { text, operation_id: operationId, attachment_ids: attachmentIds },
    }),
  inboxStatus: (spoolIds) =>
    request<InboxStatusResult>("/inbox/status", { query: { spool_ids: spoolIds?.join(",") } }),
  inboxDiscard: (spoolId) =>
    request<InboxDiscardResult>("/inbox/discard", { body: { spool_id: spoolId } }),
  episodeDelete: (id) =>
    request<void>(`/episodes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  episodeReingest: (id, text, operationId, attachmentIds) =>
    request<EpisodeReingestResult>(`/episodes/${encodeURIComponent(id)}/reingest`, {
      body: { text, operation_id: operationId, attachment_ids: attachmentIds },
    }),
  pendingDelete: (input) => request<void>("/pending/delete", { body: input }),
  trashList: () => request<DeletedEntrySummary[]>("/trash"),
  trashRestore: (id) =>
    request<DeletedRestoreResult>(`/trash/${encodeURIComponent(id)}/restore`, { body: {} }),
  trashDeleteNow: (id) => request<void>(`/trash/${encodeURIComponent(id)}`, { method: "DELETE" }),

  chatAnswer: (params) => request<ChatAnswerResult>("/chat/answer", { body: params }),
  chatStream: (question, history, signal) =>
    stream<AskEvent>("/chat", { question, history }, signal),
  chatHistory: () => request<ChatMessage[]>("/chat/history"),

  presignMedia: (name, contentType, size) =>
    request<PresignResult>("/media/presign", {
      body: { name, content_type: contentType, size },
    }),
  mediaUrl: (leaf) => `${import.meta.env.VITE_API_BASE_URL}/media/${encodeURIComponent(leaf)}`,

  coldImport: (params) => request<ColdImportResult>("/import/cold", { body: params }),
  settingsGet: () => request<AppSettingsData>("/settings"),
  settingsSet: (patch) => request<AppSettingsData>("/settings", { method: "PATCH", body: patch }),
  storageUsage: () => request<StorageUsageResult>("/storage/usage"),
  usageLimits: () => request<UsageLimitsSnapshot>("/usage/limits"),
  linkPreview: (url) => request<LinkPreviewResult | null>("/link-preview", { body: { url } }),
  dictationTranscribe: async (wav) => {
    const { text } = await request<{ text: string }>("/dictation/transcribe", {
      raw: wav,
      contentType: "audio/wav",
    });
    return text;
  },
};
