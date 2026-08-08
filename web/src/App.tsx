/**
 * The main Graph window combines capture and Memory into one surface: a persistent
 * bottom composer writes directly into the masonry board, while episode/entity inspectors
 * and Settings remain overlays.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AskMemoryQueued, AuthUser, DeletedRestoreResult, StatusSnapshot } from "./shared/api";
import type { EpisodeGraphPreview, EpisodeListRow } from "./shared/protocol";
import { Analytics } from "@vercel/analytics/react";
import { LoginPage } from "./components/LoginPage";
import { applyAskAppAction, recordAskMemoryFiling } from "./lib/chatActions";
import { clearPrefs, hydratePrefs } from "./lib/prefs";
import { ImportToast } from "./components/ImportToast";
import { Onboarding } from "./components/Onboarding";
import { HistoryPage, type EpisodeScrollRequest } from "./pages/HistoryPage";
import { InputPage, type PendingWriteEntry } from "./pages/InputPage";
import { SettingsSheet } from "./pages/SettingsPage";

/**
 * An edit committed against a stored note. The rich detail overlay used to raise these; now
 * the board's own text editor does, and the shell still tracks the reingest the same way.
 */
export interface EpisodeEdit {
  replacesEpisodeId: string;
  spoolId: string;
  text: string;
  attachments: PendingWriteEntry["attachments"];
  createdAt: number;
}

export type PendingFollowUp = { kind: "edit"; text: string } | { kind: "delete" };


/** A request may finish after another edit was queued; only consume the operation it launched. */
export function newerPendingFollowUp(
  current: PendingFollowUp | undefined,
  launched: PendingFollowUp,
): PendingFollowUp | undefined {
  return current === launched ? undefined : current;
}

export interface PendingCardEdit extends PendingWriteEntry {
  spoolId: string | null;
  replacesEpisodeId: string | null;
  followUp?: PendingFollowUp;
  mutating?: boolean;
  hidden?: boolean;
}

/** Represent a retrieved entry on the board while its restored capture is processed. */
export function restoredDeletedEntryToPending(restored: DeletedRestoreResult): PendingCardEdit {
  if (!restored.spoolId && !restored.episodeId) {
    throw new Error("Retrieved entry is missing its processing identity.");
  }
  return {
    id: `restore:${restored.spoolId ?? restored.episodeId}`,
    spoolId: restored.spoolId,
    replacesEpisodeId: null,
    text: restored.text,
    attachmentCount: restored.attachmentCount,
    attachments: Array.from({ length: restored.attachmentCount }, () => ({
      size: 0,
      isImage: false,
      aspectRatio: null,
    })),
    status: restored.episodeId ? "done" : "processing",
    episodeId: restored.episodeId,
    createdAt: restored.createdAt,
  };
}

/** Show a real cold-start state until the engine is usable or has a terminal error to explain. */
export function isColdStartLoading(snapshot: StatusSnapshot | null, bridgeError: string | null): boolean {
  if (bridgeError) return false;
  const state = snapshot?.engine.state;
  return state !== "running" && state !== "unavailable";
}

/** Keep the startup cover up until the running engine has returned the board's first page. */
export function isAppLoading(
  snapshot: StatusSnapshot | null,
  bridgeError: string | null,
  initialBoardReady: boolean,
): boolean {
  if (isColdStartLoading(snapshot, bridgeError)) return true;
  return !bridgeError && snapshot?.engine.state === "running" && !initialBoardReady;
}

export function pendingEntryFromAskMemory(memory: AskMemoryQueued): PendingWriteEntry {
  const createdAt = Date.parse(memory.at);
  return {
    id: `ask:${memory.spoolId}`,
    text: memory.text,
    attachmentCount: memory.attachments,
    attachments: [],
    status: memory.episodeId ? "done" : "processing",
    episodeId: memory.episodeId,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    spoolId: memory.spoolId,
  };
}

export function App(): React.JSX.Element {
  // null = signed out, undefined = the initial authStatus() call hasn't answered yet. Never
  // guess: rendering LoginPage before that answer would flash it in front of a returning user.
  const [authUser, setAuthUser] = useState<AuthUser | null | undefined>(undefined);
  useEffect(() => {
    window.graph
      .authStatus()
      .then((r) => setAuthUser(r.user))
      .catch(() => setAuthUser(null));
  }, []);

  // Folders and pins live with the account; pull them before the board reads them.
  useEffect(() => {
    if (!authUser) return;
    void hydratePrefs(authUser.id);
  }, [authUser]);

  const [pendingAskEntries, setPendingAskEntries] = useState<PendingWriteEntry[]>([]);
  const [snap, setSnap] = useState<StatusSnapshot | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** The omnibar's third mode: the bar asks Ceb instead of writing a memory. */
  const [chatOpen, setChatOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  /** The folder the board is currently filtered to (one rail spot), so the composer can
      pre-fill `/folder` and a note added while viewing it files itself there. */
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [episodeScrollRequest, setEpisodeScrollRequest] = useState<EpisodeScrollRequest | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [inputFocusToken, setInputFocusToken] = useState(0);
  const [pendingWriteEntries, setPendingWriteEntries] = useState<PendingWriteEntry[]>([]);
  const [pendingCardEdits, setPendingCardEdits] = useState<PendingCardEdit[]>([]);
  /** Dev-only card inspection panel: dev mode plus its own opt-in (lib/devTools.ts). */
  const [cardDevView, setCardDevView] = useState(false);
  /** The board's first page has landed (or failed) — until then the cover stays up. */
  const [initialBoardReady, setInitialBoardReady] = useState(false);
  /** null until the settings file has answered — never guess, or the tour flashes on relaunch. */
  const [tourSeen, setTourSeen] = useState<boolean | null>(null);
  /**
   * Latched: the tour opens once and only a dismissal closes it. Without this it would be a
   * live expression over engine status, so any flap (cold start settling, a daemon restart)
   * would unmount and remount it — replaying every animation from the top, on screen, as a
   * flash.
   */
  const [tourOpen, setTourOpen] = useState(false);
  const prevDraining = useRef(false);
  const prevPending = useRef(0);
  const refreshedEpisodeIds = useRef(new Set<string>());
  const episodeScrollRequestId = useRef(0);

  useEffect(() => {
    let alive = true;
    const apply = (s: StatusSnapshot) => {
      if (!alive) return;
      setSnap(s);
      setBridgeError(null);
      if ((prevDraining.current && !s.ingest.draining) || s.pendingSpools < prevPending.current) {
        setRefreshToken((t) => t + 1);
      }
      prevDraining.current = s.ingest.draining;
      prevPending.current = s.pendingSpools;
    };
    const refresh = () => {
      window.graph
        .status()
        .then(apply)
        .catch((e: Error) => alive && setBridgeError(e.message));
    };
    refresh();
    const unsubscribe = window.graph.onStatus(apply);
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    window.graph
      .settingsGet()
      .then((r) => setCardDevView(r.settings.devCardView))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // Server-side (profiles.tour_seen), so the tour follows the account rather than the device.
    // A failed read reports true: never trap a returning user in onboarding.
    window.graph
      .tourSeen()
      .then(setTourSeen)
      .catch(() => setTourSeen(true));
  }, []);

  /** Finished or skipped both count as seen, and the flag is written before the tour unmounts. */
  const dismissTour = useCallback(() => {
    setTourSeen(true);
    setTourOpen(false);
    window.graph.tourMarkSeen().catch(() => undefined);
  }, []);


  useEffect(() => {
    return window.graph.onAskMemoryQueued((memory) => {
      const entry = pendingEntryFromAskMemory(memory);
      if (memory.folder) recordAskMemoryFiling(entry.id, memory.folder);
      setPendingAskEntries((current) => [
        ...current.filter((candidate) => candidate.id !== entry.id),
        entry,
      ]);
      if (entry.episodeId) setRefreshToken((token) => token + 1);
    });
  }, []);

  useEffect(() => window.graph.onAskMemoryRemoved((memory) => {
    setPendingAskEntries((current) => current.filter((entry) => entry.spoolId !== memory.spoolId));
    setRefreshToken((token) => token + 1);
  }), []);

  useEffect(() => window.graph.onAskEpisodeMutation((mutation) => {
    if (mutation.kind === "deleted") {
      setRefreshToken((token) => token + 1);
      return;
    }
    setPendingCardEdits((current) => [
      ...current.filter((entry) => entry.replacesEpisodeId !== mutation.replacesEpisodeId),
      {
        id: `edit:${mutation.spoolId}`,
        spoolId: mutation.spoolId,
        replacesEpisodeId: mutation.replacesEpisodeId,
        text: mutation.text,
        attachmentCount: 0,
        attachments: [],
        status: mutation.episodeId ? "done" : "processing",
        episodeId: mutation.episodeId,
        createdAt: mutation.createdAt,
      },
    ]);
    if (mutation.episodeId) setRefreshToken((token) => token + 1);
  }), []);

  useEffect(() => window.graph.onAskAppAction((action) => applyAskAppAction(action, {
    applyFilter: (query) => {
      setShowSettings(false);
      setSearchQuery(query);
    },
  })), []);

  const handlePendingEntriesChange = useCallback((entries: PendingWriteEntry[]) => {
    setPendingWriteEntries(entries);
    let shouldRefresh = false;
    entries.forEach((entry) => {
      if (entry.status !== "done" || !entry.episodeId || refreshedEpisodeIds.current.has(entry.episodeId)) return;
      refreshedEpisodeIds.current.add(entry.episodeId);
      shouldRefresh = true;
    });
    if (shouldRefresh) setRefreshToken((token) => token + 1);
  }, []);

  const editTrackedPending = useCallback((id: string, text: string) => {
    setPendingCardEdits((current) => current.map((entry) =>
      entry.id === id ? { ...entry, text, followUp: { kind: "edit", text }, hidden: false } : entry));
  }, []);

  const deleteTrackedPending = useCallback(async (entry: PendingCardEdit) => {
    try {
      await window.graph.pendingDelete({
        id: entry.id,
        text: entry.text,
        createdAt: entry.createdAt,
        spoolId: entry.spoolId,
        episodeId: entry.episodeId,
      });
      setPendingCardEdits((current) => current.filter((candidate) => candidate.id !== entry.id));
      setRefreshToken((token) => token + 1);
    } catch (cause) {
      setBridgeError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    pendingCardEdits.forEach((entry) => {
      if (!entry.followUp || !entry.episodeId || entry.mutating) return;
      const launchedFollowUp = entry.followUp;
      setPendingCardEdits((current) => current.map((candidate) =>
        candidate.id === entry.id ? { ...candidate, mutating: true } : candidate));
      const run = launchedFollowUp.kind === "delete"
        ? window.graph.episodeDelete(entry.episodeId).then(() => null)
        : window.graph.episodeReingest(entry.episodeId, launchedFollowUp.text);
      void run.then((result) => {
        if (launchedFollowUp.kind === "delete" || result === null) {
          setPendingCardEdits((current) => current.filter((candidate) => candidate.id !== entry.id));
        } else {
          setPendingCardEdits((current) => current.map((candidate) => {
            if (candidate.id !== entry.id) return candidate;
            const nextFollowUp = newerPendingFollowUp(candidate.followUp, launchedFollowUp);
            return {
              ...candidate,
              spoolId: result.spool_id,
              replacesEpisodeId: entry.episodeId as string,
              episodeId: result.episode_id ?? null,
              status: result.episode_id ? "done" : "processing",
              followUp: nextFollowUp,
              mutating: false,
            };
          }));
        }
        setRefreshToken((token) => token + 1);
      }).catch((cause: Error) => {
        setBridgeError(cause.message);
        setPendingCardEdits((current) => current.map((candidate) => {
          if (candidate.id !== entry.id) return candidate;
          const nextFollowUp = newerPendingFollowUp(candidate.followUp, launchedFollowUp);
          return {
            ...candidate,
            mutating: false,
            followUp: nextFollowUp,
            hidden: nextFollowUp ? candidate.hidden : false,
          };
        }));
      });
    });
  }, [pendingCardEdits]);

  const trackedCardEditSpools = useMemo(
    () => pendingCardEdits
      .filter((entry) => entry.status !== "done")
      .map((entry) => entry.spoolId)
      .join("|"),
    [pendingCardEdits],
  );

  useEffect(() => {
    if (!trackedCardEditSpools) return;
    let alive = true;
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      window.graph
        .inboxStatus(trackedCardEditSpools.split("|").filter(Boolean))
        .then((queue) => {
          if (!alive) return;
          const receipts = new Map(
            queue.last_receipts
              .filter((receipt) => !receipt.discarded)
              .map((receipt) => [receipt.spool_id, receipt.note_ids[0] ?? null]),
          );
          const completed = new Map<string, string>();
          const failed = new Set<string>();
          trackedCardEditSpools.split("|").filter(Boolean).forEach((spoolId) => {
            const batchItem = queue.batch?.items[spoolId];
            const episodeId = batchItem?.episode_id ?? receipts.get(spoolId) ?? null;
            if (episodeId) completed.set(spoolId, episodeId);
            else if (batchItem?.state === "failed") failed.add(spoolId);
          });
          if (completed.size > 0 || failed.size > 0) {
            setPendingCardEdits((current) => current.map((entry) => {
              if (!entry.spoolId) return entry;
              const episodeId = completed.get(entry.spoolId);
              if (episodeId) return { ...entry, episodeId, status: "done" };
              if (failed.has(entry.spoolId)) return { ...entry, status: "failed" };
              return entry;
            }));
          }
          if (completed.size > 0) setRefreshToken((token) => token + 1);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 1200);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [trackedCardEditSpools]);

  useEffect(() => {
    const settledIds = pendingCardEdits
      .filter((entry) => entry.status === "done" && !entry.followUp && !entry.mutating)
      .map((entry) => entry.id);
    if (settledIds.length === 0) return;
    const timer = window.setTimeout(() => {
      const settled = new Set(settledIds);
      setPendingCardEdits((current) => current.filter((entry) => !settled.has(entry.id)));
    }, 5500);
    return () => window.clearTimeout(timer);
  }, [pendingCardEdits]);

  const handleEpisodeMutation = useCallback((mutation: EpisodeEdit) => {
    setPendingCardEdits((current) => [
      ...current.filter((entry) => entry.replacesEpisodeId !== mutation.replacesEpisodeId),
      {
        id: `edit:${mutation.spoolId}`,
        spoolId: mutation.spoolId,
        replacesEpisodeId: mutation.replacesEpisodeId,
        text: mutation.text,
        attachmentCount: mutation.attachments.length,
        attachments: mutation.attachments,
        status: "processing",
        episodeId: null,
        createdAt: mutation.createdAt,
      },
    ]);
  }, []);

  const handleDeletedRetrieved = useCallback((restored: DeletedRestoreResult) => {
    const pending = restoredDeletedEntryToPending(restored);
    setPendingCardEdits((current) => [
      ...current.filter((entry) => entry.id !== pending.id),
      pending,
    ]);
    setShowSettings(false);
    setRefreshToken((token) => token + 1);
  }, []);

  const engine = snap?.engine ?? null;
  const engineBroken = engine?.state === "unavailable";
  const coldStartLoading = isColdStartLoading(snap, bridgeError);
  const appLoading = isAppLoading(snap, bridgeError, initialBoardReady);
  useEffect(() => {
    // A daemon that dropped out of running will hand the board a fresh first page; cover it again.
    if (engine?.state !== "running") setInitialBoardReady(false);
  }, [engine?.state]);
  const handleInitialBoardSettled = useCallback(() => setInitialBoardReady(true), []);
  /** Open the tour once, the first time an unseen flag meets a working engine. */
  useEffect(() => {
    if (tourSeen === false && !engineBroken) setTourOpen(true);
  }, [tourSeen, engineBroken]);
  const boardPendingEntries = useMemo<PendingWriteEntry[]>(() => [
    ...pendingWriteEntries,
    ...pendingCardEdits.filter((entry) => !entry.hidden).map((entry) => ({
      ...entry,
      onEdit: (text: string) => editTrackedPending(entry.id, text),
      onDelete: () => deleteTrackedPending(entry),
    })),
  ], [pendingWriteEntries, pendingCardEdits, editTrackedPending, deleteTrackedPending]);

  if (authUser === undefined) return <></>; // brief: authStatus() hasn't answered yet
  if (authUser === null) return <LoginPage onSignedIn={setAuthUser} />;

  return (
    <div className="shell notes-shell">
      <main className="content">
        <div className="content-body">
          {bridgeError && <p className="error-text bridge-error">bridge error: {bridgeError}</p>}
          {engineBroken ? (
            <div className="load-error">
              <div className="icon">⚠️</div>
              <h2>The graph engine couldn’t start</h2>
              <pre>{engine?.detail ?? "unknown error"}</pre>
              <button className="btn" onClick={() => setShowSettings(true)}>
                Settings
              </button>
            </div>
          ) : !coldStartLoading ? (
            <div className="section-surface combined-memory-surface">
              <HistoryPage
                snapshot={snap}
                refreshToken={refreshToken}
                pendingEntries={boardPendingEntries}
                onOpenSettings={() => setShowSettings(true)}
                onMutated={() => setRefreshToken((t) => t + 1)}
                onEpisodeEdited={handleEpisodeMutation}

                searchQuery={searchQuery}
                scrollToEpisode={episodeScrollRequest}
                cardDevView={cardDevView}
                onInitialLoadSettled={handleInitialBoardSettled}
                onActiveFolderChange={setActiveFolder}
              />
            </div>
          ) : null}
        </div>
      </main>

      {!engineBroken && !appLoading && (
        <InputPage
          focusToken={inputFocusToken}
          composerOnly
          activeFolder={activeFolder}
          onPendingEntriesChange={handlePendingEntriesChange}
          onSearchChange={setSearchQuery}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen((open) => !open)}
          onChatSubmit={(text) => {
            void window.graph.askSubmit(text).catch((cause: Error) => setBridgeError(cause.message));
          }}
        />
      )}


      {/* One opaque cover over the whole shell while the engine warms and the board fetches its
          first page: startup shows the spinner alone, never a bare header and composer around an
          empty board. */}
      {appLoading && (
        <div className="cold-start-loading app-loading-overlay" role="status" aria-label="Loading Ceb">
          <span className="spinner cold-start-spinner" aria-hidden="true" />
        </div>
      )}

      {/* Above the cold-start cover on purpose: a first launch spends the engine's warm-up
          reading the tour rather than watching a spinner. An engine that failed outright gets
          the error screen instead — an explanation the tour would only be hiding. */}
      {tourOpen && <Onboarding onDone={dismissTour} />}

      {showSettings && (
        <SettingsSheet
          snapshot={snap}
          onClose={() => setShowSettings(false)}
          onSettingsChanged={(s) => setCardDevView(s.devCardView)}
          onEntryRetrieved={handleDeletedRetrieved}
          onSignedOut={() => {
            setShowSettings(false);
            clearPrefs(); // another account must not inherit this one's folders
            setAuthUser(null);
          }}
        />
      )}
      <ImportToast hidden={showSettings} />
      <Analytics />
    </div>
  );
}
