/**
 * Ingest indicator chip + queue popover. Invisible when idle with nothing
 * pending; spinner + k/n while draining; pending count while spools wait. Click opens the
 * queue popover (progress bar + per-spool rows with state glyphs; failed rows show the error
 * and stay queued — the daemon's no-receipt-on-failure semantics).
 */
import React, { useEffect, useRef, useState } from "react";
import type { StatusSnapshot } from "../shared/api";
import type { InboxStatusResult } from "../shared/protocol";
import { previewText } from "../lib/format";

function stateGlyph(state: string): React.ReactNode {
  switch (state) {
    case "processing":
      return <span className="spinner" aria-label="processing" />;
    case "failed":
      return <span style={{ color: "var(--warning)" }}>⚠</span>;
    default:
      return <span className="tertiary">🕓</span>;
  }
}

export function IngestChip({ snapshot }: { snapshot: StatusSnapshot }) {
  const [open, setOpen] = useState(false);
  const [queue, setQueue] = useState<InboxStatusResult | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);

  const { ingest, pendingSpools } = snapshot;
  const visible = ingest.draining || pendingSpools > 0;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const refresh = () => {
      window.graph
        .inboxStatus()
        .then((q) => alive && setQueue(q))
        .catch(() => alive && setQueue(null));
    };
    refresh();
    const timer = setInterval(refresh, 1_200); // re-reads live as the batch advances
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, snapshot.ingest.done, snapshot.pendingSpools]);

  if (!visible && !open) return null;

  const batchItems = queue?.batch?.items ?? {};

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={anchor}
        className="ingest-chip"
        aria-label="ingest-queue"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>⤒</span>
        {ingest.draining ? (
          <>
            <span className="spinner" />
            <span>
              {ingest.done}/{ingest.total}
            </span>
          </>
        ) : (
          <span>{pendingSpools}</span>
        )}
      </button>
      {open && (
        <div className="popover" style={{ right: 0, top: 28, width: 320 }} onMouseLeave={() => setOpen(false)}>
          <strong>Thoughts queue</strong>
          {ingest.draining && (
            <div style={{ margin: "8px 0" }}>
              <div className="muted" style={{ marginBottom: 4 }}>
                {ingest.done} of {ingest.total}
              </div>
              <div className="progressbar">
                <div style={{ width: `${ingest.total > 0 ? (ingest.done / ingest.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            {queue && queue.pending.length === 0 && (
              <p className="muted">{ingest.draining ? "Finishing up…" : "Nothing waiting to file."}</p>
            )}
            {queue?.pending.map((spool) => {
              const item = batchItems[spool.spool_id];
              const state = item?.state ?? "queued";
              return (
                <div key={spool.spool_id} className="queue-row">
                  {stateGlyph(state)}
                  <div className="text">
                    {spool.text?.trim()
                      ? previewText(spool.text)
                      : spool.attachments.length > 0
                        ? `${spool.attachments.length} attachment(s)`
                        : "(empty)"}
                    {item?.error && (
                      <div className="error-text" style={{ fontSize: 12 }}>
                        {item.error}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
