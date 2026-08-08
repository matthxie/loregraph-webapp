/**
 * The answer bubble, shared by both chat surfaces: the omnibar in chat mode and the ⌃⌥Space
 * popup render this same component, floating just above the input.
 *
 * There is no transcript on screen any more — the conversation's memory lives in main
 * (chatHistory.ts rides the past day into every question, and the daily summarizer folds each
 * day into the graph). What the user sees is one bubble holding the answer to the question
 * they just asked: typing dots while the run works, then the answer typing itself in.
 *
 * The bubble belongs to the visit, not to the log. Leaving chat clears it, so coming back is
 * a clean bar rather than yesterday's answer still sitting there — the conversation is
 * remembered, its last screenful isn't. On the board that falls out of unmounting; the popup
 * is only hidden, so it clears on the reshow signal instead.
 */
import React, { useEffect, useRef, useState } from "react";
import type { AskSource, ChatMessage } from "../shared/api";
import { renderMarkdown } from "../lib/askMarkdown";

/** Web pages an answer stood on, painted under it. The user's own memories are not cited
    back at them — that reads as a machine showing its work. */
export function embedSources(sources: readonly AskSource[] | undefined): AskSource[] {
  return (sources ?? [])
    .filter((source) =>
      source.kind === "web" &&
      typeof source.url === "string" &&
      /^https?:\/\//i.test(source.url))
    .slice(0, 3);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * How long the whole answer takes to type, regardless of length: a short reply and a long one
 * both land in about this, so the effect never becomes a wait. Only an answer that arrives
 * while the surface is mounted types — the saved answer painted at open is already said.
 */
const TYPE_MS = 420;

/** Reveal `text` a character at a time when `animate`, else show it whole. */
function useTypedText(text: string, animate: boolean): string {
  const [shown, setShown] = useState(animate ? "" : text);
  useEffect(() => {
    if (!animate) {
      setShown(text);
      return;
    }
    let frame = 0;
    const startedAt = performance.now();
    const step = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / TYPE_MS);
      setShown(text.slice(0, Math.ceil(text.length * progress)));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, animate]);
  return shown;
}

function AnswerBody({ text, animate = false }: { text: string; animate?: boolean }) {
  const shown = useTypedText(text, animate);
  // renderMarkdown escapes before it introduces any markup, so the model can never supply a
  // tag or an executable link scheme. Links come out as inert [data-href] spans — the click
  // handler is what opens them, in the user's browser rather than in the app.
  return (
    <div
      className="chat-answer-text"
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest<HTMLElement>("[data-href]");
        const href = link?.dataset.href;
        if (!href) return;
        event.preventDefault();
        void window.graph.openExternal(href);
      }}
      // Rendered per frame from the partial string, so markdown resolves as it arrives rather
      // than showing its syntax and then snapping.
      dangerouslySetInnerHTML={{ __html: renderMarkdown(shown) }}
    />
  );
}

export function ChatAnswer() {
  /** The answer to the question asked on this visit — nothing is restored from the log. */
  const [answer, setAnswer] = useState<ChatMessage | null>(null);
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  /**
   * The one answer that should type itself: an assistant message that arrived while this
   * surface was mounted. The saved answer loaded at open is history — it types nothing.
   */
  const typingIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);

  // Leaving chat unmounts the drawer, so re-entering it already starts on a clean bubble —
  // no reset hook needed as there was for the popup, which only hid itself.

  // Every appended answer.
  useEffect(() => window.graph.onChatMessage((message) => {
    if (message.role !== "assistant") return;
    if (!message.error) typingIdRef.current = message.id;
    setAnswer(message);
  }), []);

  // The run's breadcrumb. Whichever surface asked, both show that something is happening.
  useEffect(() => window.graph.onAskEvent((event) => {
    if (event.kind === "started") {
      runIdRef.current = event.runId;
      setRunning(true);
      setActivity("thinking");
      return;
    }
    if (event.runId !== runIdRef.current) return;
    if (event.kind === "activity") setActivity(event.label);
    else if (event.kind === "done") {
      runIdRef.current = null;
      setRunning(false);
      setActivity(null);
    }
  }), []);

  if (!running && !answer) return null;

  const sources = running || !answer ? [] : embedSources(answer.error ? undefined : answer.sources);

  return (
    <div className="chat-answer-row">
    <div
      className={`chat-answer${!running && answer?.error ? " error" : ""}`}
      role="status"
      aria-label="chat-answer"
    >
      {running ? (
        <div className="chat-answer-pending">
          <span className="chat-typing" aria-hidden="true"><i /><i /><i /></span>
          <span className="chat-typing-label">{activity ?? "thinking"}</span>
        </div>
      ) : answer ? (
        <>
          {answer.error
            ? <div className="chat-answer-text">{answer.text}</div>
            : <AnswerBody text={answer.text} animate={answer.id === typingIdRef.current} />}
          {sources.length > 0 && (
            <div className="chat-embeds">
              {sources.map((source) => (
                <button
                  type="button"
                  key={source.url}
                  className="chat-embed"
                  title={source.url}
                  onClick={() => void window.graph.openExternal(source.url as string)}
                >
                  <span className="chat-embed-title">
                    {source.label || hostOf(source.url as string)}
                  </span>
                  <span className="chat-embed-host">{hostOf(source.url as string)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
    </div>
  );
}
