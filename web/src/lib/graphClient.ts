/**
 * The CebApi implementation mounted as `window.graph`. Everything the ported UI calls lands
 * here: route calls go to the backend, and the stateful bits Electron main used to own —
 * status polling, the capture draft, attachment staging, the chat event bus — live here now.
 */
import type {
  AppSettingsData,
  AskAppAction,
  AskAppActionResult,
  AskConversationMessage,
  AskEpisodeMutation,
  AskEvent,
  AskMemoryQueued,
  AskMemoryRemoved,
  AuthUser,
  CebApi,
  CaptureEcho,
  ChatMessage,
  DraftAttachment,
  DraftFileInput,
  DraftState,
  Plan,
  StatusSnapshot,
  UsageLimitsSnapshot,
} from "../shared/api";
import type { Backend } from "./backend";
import { httpBackend } from "./backend";
import { mockBackend } from "./mockServer";
import { USE_MOCK } from "./http";
import { supabase, setSessionPersistence, SUPABASE_CONFIGURED } from "./supabase";
import { readPref, writePref } from "./prefs";

const backend: Backend = USE_MOCK ? mockBackend : httpBackend;

// -- small event bus ---------------------------------------------------------

function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    on(listener: (value: T) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value: T): void {
      listeners.forEach((listener) => listener(value));
    },
    get size(): number {
      return listeners.size;
    },
  };
}

const statusBus = emitter<StatusSnapshot>();
const draftBus = emitter<DraftState>();
const usageBus = emitter<UsageLimitsSnapshot>();
const askEventBus = emitter<AskEvent>();
const chatMessageBus = emitter<ChatMessage>();
const memoryQueuedBus = emitter<AskMemoryQueued>();
const memoryRemovedBus = emitter<AskMemoryRemoved>();
const episodeMutationBus = emitter<AskEpisodeMutation>();

/** Chat's folder/pin/filter actions run in the browser; the shell registers the handler. */
let appActionHandler: ((action: AskAppAction) => AskAppActionResult) | null = null;

// -- status ------------------------------------------------------------------

let snapshot: StatusSnapshot = {
  engine: { state: "starting", pid: null, restarts: 0, detail: null, health: null },
  dataDir: "",
  pendingSpools: 0,
  lastCapture: null,
  ingest: { draining: false, done: 0, total: 0 },
  capabilities: null,
};
let statusTimer: number | null = null;
let failures = 0;

async function refreshStatus(): Promise<StatusSnapshot> {
  try {
    const health = await backend.health();
    const inbox = await backend.inboxStatus();
    failures = 0;
    snapshot = {
      engine: {
        state: health.ok ? "running" : "unavailable",
        pid: null,
        restarts: failures,
        detail: null,
        health,
      },
      dataDir: health.data_dir,
      pendingSpools: inbox.pending.length,
      lastCapture: snapshot.lastCapture,
      ingest: {
        draining: inbox.draining,
        done: inbox.batch?.done ?? 0,
        total: inbox.batch?.total ?? 0,
      },
      capabilities: health.capabilities,
    };
  } catch (cause) {
    failures += 1;
    snapshot = {
      ...snapshot,
      engine: {
        state: "unavailable",
        pid: null,
        restarts: failures,
        detail: (cause as Error).message,
        health: null,
      },
    };
  }
  statusBus.emit(snapshot);
  return snapshot;
}

function ensureStatusPolling(): void {
  if (statusTimer !== null) return;
  void refreshStatus();
  statusTimer = window.setInterval(() => void refreshStatus(), 5000);
}

// -- draft + attachment staging ---------------------------------------------

const DRAFT_KEY = "capture-draft";
const WRITE_KEY = "write-draft";

function loadDraft(key: string): DraftState {
  try {
    const raw = JSON.parse(readPref(key) ?? "null") as DraftState | null;
    if (raw && typeof raw.text === "string" && Array.isArray(raw.attachments)) return raw;
  } catch {
    // Corrupt value — start empty.
  }
  return { text: "", attachments: [] };
}

function saveDraft(key: string, draft: DraftState): void {
  // Object URLs are per-session; persist attachment metadata without them.
  writePref(
    key,
    JSON.stringify({
      text: draft.text,
      attachments: draft.attachments.map((attachment) => ({ ...attachment, url: null })),
    }),
  );
}

let draft = loadDraft(DRAFT_KEY);
let writeDraft = loadDraft(WRITE_KEY);

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Upload one file and return its staged attachment; null if it was rejected. */
async function stageFile(file: DraftFileInput): Promise<DraftAttachment | null> {
  if (file.blob.size === 0 || file.blob.size > MAX_ATTACHMENT_BYTES) return null;
  const isImage = (file.contentType ?? "").startsWith("image/");
  try {
    const presigned = await backend.presignMedia(file.name, file.contentType, file.blob.size);
    if (presigned.uploadUrl) {
      const response = await fetch(presigned.uploadUrl, {
        method: "PUT",
        headers: presigned.headers,
        body: file.blob,
      });
      if (!response.ok) return null;
    }
    return {
      id: presigned.attachmentId,
      name: file.name,
      size: file.blob.size,
      contentType: file.contentType,
      // Local object URL so the preview paints immediately; the presigned GET is only needed
      // after a reload, by which point the card reads media_paths off the episode instead.
      url: isImage ? URL.createObjectURL(file.blob) : null,
      isImage,
    };
  } catch {
    return null;
  }
}

async function addFiles(
  target: "draft" | "write",
  files: DraftFileInput[],
): Promise<{ draft: DraftState; skipped: number }> {
  const staged = await Promise.all(files.map(stageFile));
  const added = staged.filter((attachment): attachment is DraftAttachment => attachment !== null);
  const skipped = staged.length - added.length;
  if (target === "draft") {
    draft = { ...draft, attachments: [...draft.attachments, ...added] };
    saveDraft(DRAFT_KEY, draft);
    draftBus.emit(draft);
    return { draft, skipped };
  }
  writeDraft = { ...writeDraft, attachments: [...writeDraft.attachments, ...added] };
  saveDraft(WRITE_KEY, writeDraft);
  return { draft: writeDraft, skipped };
}

// -- chat --------------------------------------------------------------------

let chatAbort: AbortController | null = null;

async function runChat(question: string, history: AskConversationMessage[]): Promise<string> {
  if (chatAbort) throw new Error("A chat run is already in flight.");
  const controller = new AbortController();
  chatAbort = controller;
  const runId = `run_${Date.now()}`;
  chatMessageBus.emit({
    id: `msg_${Date.now()}`,
    role: "user",
    text: question,
    at: new Date().toISOString(),
  });
  void (async () => {
    try {
      for await (const event of backend.chatStream(question, history, controller.signal)) {
        askEventBus.emit(event);
        if (event.kind === "answer") {
          chatMessageBus.emit({
            id: `msg_${Date.now()}_a`,
            role: "assistant",
            text: event.text,
            at: new Date().toISOString(),
            sources: event.sources,
          });
        }
        if (event.kind === "error") {
          chatMessageBus.emit({
            id: `msg_${Date.now()}_e`,
            role: "assistant",
            text: event.message,
            at: new Date().toISOString(),
            error: true,
          });
        }
      }
    } catch (cause) {
      const message = (cause as Error).message;
      askEventBus.emit({ kind: "error", runId, message });
      askEventBus.emit({ kind: "done", runId, ok: false });
      chatMessageBus.emit({
        id: `msg_${Date.now()}_e`,
        role: "assistant",
        text: message,
        at: new Date().toISOString(),
        error: true,
      });
    } finally {
      chatAbort = null;
    }
  })();
  return runId;
}

// -- media -------------------------------------------------------------------

/** Wire media_paths are "media/<leaf>"; the service serves the leaf under the user's prefix. */
function mediaUrl(mediaPath: string): string | null {
  const leaf = mediaPath.split("/").pop();
  if (!leaf || leaf.includes("..")) return null;
  return backend.mediaUrl(leaf);
}

// -- auth / billing (Supabase directly) --------------------------------------

/**
 * Fallback when no Supabase project is configured (or VITE_MOCK_AUTH=1): any credentials sign
 * you in as a fixed dev user. With a project configured, real accounts are used even while the
 * graph itself is still served by mockServer.
 */
const MOCK_AUTH = !SUPABASE_CONFIGURED;

const MOCK_USER: AuthUser = { id: "u_mock", email: "dev@localhost" };
const MOCK_SESSION_KEY = "ceb.mock.session";

function mockSignedIn(): boolean {
  try {
    return localStorage.getItem(MOCK_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

async function currentUser(): Promise<AuthUser | null> {
  if (MOCK_AUTH) return mockSignedIn() ? MOCK_USER : null;
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  return user?.email ? { id: user.id, email: user.email } : null;
}

async function callEdgeFunction<T>(name: string, body?: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body: body ?? {} });
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`${name} returned no data`);
  return data;
}

const ACTIVE_STATUSES = new Set(["free", "trialing", "active"]);

/** Reads the existing `subscriptions` row; anything not active reads as free. */
async function readPlan(): Promise<{ plan: Plan }> {
  if (MOCK_AUTH) return { plan: "free" };
  const { data, error } = await supabase
    .from("subscriptions")
    .select("plan, status")
    .maybeSingle();
  if (error || !data) return { plan: "free" };
  const active = ACTIVE_STATUSES.has(String(data.status));
  const plan = data.plan as Plan;
  return { plan: active && ["free", "basic", "pro"].includes(plan) ? plan : "free" };
}

// -- the client --------------------------------------------------------------

export const graphClient: CebApi = {
  status: () => refreshStatus(),
  onStatus(listener) {
    ensureStatusPolling();
    listener(snapshot);
    return statusBus.on(listener);
  },

  stats: (since, until) => backend.stats(since, until),
  retrieve: (params) => backend.retrieve(params),
  search: (terms, k) => backend.search(terms, k),
  searchNl: (query, k) => backend.searchNl(query, k),
  facts: (entity, asOf, includeClosed) => backend.facts(entity, asOf, includeClosed),
  episode: (id) => backend.episode(id),
  graphPreview: (id) => backend.graphPreview(id),
  profile: () => backend.profile(),
  episodesList: (params = {}) => backend.episodesList(params),
  episodesByIds: (ids) => backend.episodesByIds(ids),
  inboxStatus: (spoolIds) => backend.inboxStatus(spoolIds),
  inboxDiscard: (spoolId) => backend.inboxDiscard(spoolId),

  async capture(text, operationId, attachmentIds) {
    const echo = await backend.capture(text, operationId, attachmentIds);
    snapshot = { ...snapshot, lastCapture: echo };
    void refreshStatus();
    return echo;
  },
  episodeDelete: (id) => backend.episodeDelete(id),
  episodeReingest: (id, text, operationId, attachmentIds) =>
    backend.episodeReingest(id, text, operationId, attachmentIds),
  pendingDelete: (input) => backend.pendingDelete(input),
  deletedList: () => backend.trashList(),
  deletedRestore: (id) => backend.trashRestore(id),
  deletedDeleteNow: (id) => backend.trashDeleteNow(id),

  chatAnswer: (params) => backend.chatAnswer(params),
  async askSubmit(question, history = []) {
    return { runId: await runChat(question, history) };
  },
  async askCancel() {
    chatAbort?.abort();
    chatAbort = null;
  },
  onAskEvent: (listener) => askEventBus.on(listener),
  chatHistory: () => backend.chatHistory(),
  onChatMessage: (listener) => chatMessageBus.on(listener),
  onAskMemoryQueued: (listener) => memoryQueuedBus.on(listener),
  onAskMemoryRemoved: (listener) => memoryRemovedBus.on(listener),
  onAskEpisodeMutation: (listener) => episodeMutationBus.on(listener),
  onAskAppAction(listener) {
    appActionHandler = listener;
    return () => {
      if (appActionHandler === listener) appActionHandler = null;
    };
  },

  async draftGet() {
    return draft;
  },
  async draftSetText(text) {
    draft = { ...draft, text };
    saveDraft(DRAFT_KEY, draft);
    draftBus.emit(draft);
  },
  draftAddFiles: (files) => addFiles("draft", files),
  async draftRemoveAttachment(id) {
    draft = { ...draft, attachments: draft.attachments.filter((a) => a.id !== id) };
    saveDraft(DRAFT_KEY, draft);
    draftBus.emit(draft);
    return draft;
  },
  async draftSubmit(textOverride) {
    const text = textOverride ?? draft.text;
    const attachmentIds = draft.attachments.map((attachment) => attachment.id);
    const echo = await graphClient.capture(text, undefined, attachmentIds);
    draft = { text: "", attachments: [] };
    saveDraft(DRAFT_KEY, draft);
    draftBus.emit(draft);
    return echo;
  },
  async draftClear() {
    draft = { text: "", attachments: [] };
    saveDraft(DRAFT_KEY, draft);
    draftBus.emit(draft);
  },
  onDraftChanged: (listener) => draftBus.on(listener),

  async writeAttachmentsGet() {
    return writeDraft;
  },
  async writeAttachmentsSync(attachments, retainedIds) {
    const keep = new Set(retainedIds ?? attachments.map((attachment) => attachment.id));
    writeDraft = { ...writeDraft, attachments: attachments.filter((a) => keep.has(a.id)) };
    saveDraft(WRITE_KEY, writeDraft);
    return writeDraft;
  },
  writeAttachmentsAdd: (files) => addFiles("write", files),
  async writeAttachmentRemove(id) {
    writeDraft = { ...writeDraft, attachments: writeDraft.attachments.filter((a) => a.id !== id) };
    saveDraft(WRITE_KEY, writeDraft);
    return writeDraft;
  },
  mediaUrl,

  async pickImportPath() {
    return null; // Cold import is not wired on web yet; Settings hides the pane.
  },
  coldImport: (params) => backend.coldImport(params),
  onImportProgress: () => () => undefined,

  async settingsGet() {
    return { settings: await backend.settingsGet() };
  },
  settingsSet: (patch: Partial<AppSettingsData>) => backend.settingsSet(patch),
  storageUsage: () => backend.storageUsage(),
  async usageLimits() {
    const usage = await backend.usageLimits();
    usageBus.emit(usage);
    return usage;
  },
  onUsageLimits: (listener) => usageBus.on(listener),

  async authStatus() {
    return { user: await currentUser() };
  },
  async authSignUp(email, password, phone, remember = true) {
    if (MOCK_AUTH) {
      localStorage.setItem(MOCK_SESSION_KEY, "1");
      return { confirmationRequired: false };
    }
    setSessionPersistence(remember);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: phone ? { data: { phone } } : undefined,
    });
    if (error) throw new Error(error.message);
    return { confirmationRequired: !data.session };
  },
  async authSignIn(email, password, remember = true) {
    if (MOCK_AUTH) {
      localStorage.setItem(MOCK_SESSION_KEY, "1");
      return MOCK_USER;
    }
    setSessionPersistence(remember);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    const user = await currentUser();
    if (!user) throw new Error("Signed in but no user was returned.");
    return user;
  },
  async authSignOut() {
    if (MOCK_AUTH) {
      localStorage.removeItem(MOCK_SESSION_KEY);
      return;
    }
    await supabase.auth.signOut();
  },

  planStatus: () => readPlan(),
  planRefresh: () => readPlan(),
  billingCheckout: (plan) =>
    callEdgeFunction<{ url: string }>("create-checkout-session", { plan }),
  billingPortal: () => callEdgeFunction<{ url: string }>("create-portal-session"),

  async tourSeen() {
    if (MOCK_AUTH) return true;
    const user = await currentUser();
    if (!user) return true;
    const { data, error } = await supabase
      .from("profiles")
      .select("tour_seen")
      .eq("id", user.id)
      .maybeSingle();
    // Never trap a returning user in onboarding when the read fails.
    if (error || !data) return true;
    return Boolean(data.tour_seen);
  },
  async tourMarkSeen() {
    if (MOCK_AUTH) return;
    const user = await currentUser();
    if (!user) return;
    await supabase.from("profiles").update({ tour_seen: true }).eq("id", user.id);
  },

  linkPreview: (url) => backend.linkPreview(url),
  async openExternal(url) {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  dictationTranscribe: (wav) => backend.dictationTranscribe(wav),
};

/** Chat asks the shell to run a client-owned action (folders, pins, filters). */
export function dispatchAppAction(action: AskAppAction): AskAppActionResult {
  return appActionHandler?.(action) ?? { ok: false, message: "No handler is listening." };
}

/** Announce a chat-created memory so the board can render it optimistically. */
export function announceMemoryQueued(memory: AskMemoryQueued): void {
  memoryQueuedBus.emit(memory);
}

export function announceEpisodeMutation(mutation: AskEpisodeMutation): void {
  episodeMutationBus.emit(mutation);
}

export function announceMemoryRemoved(removed: AskMemoryRemoved): void {
  memoryRemovedBus.emit(removed);
}

export function installGraphClient(): void {
  window.graph = graphClient;
}

export type { CaptureEcho };
