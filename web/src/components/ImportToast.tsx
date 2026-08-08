/**
 * Cold-import toast — mirrors UpdateToast, bottom-right above the composer. Shows the single
 * in-flight (or just-finished) bulk import from the shared coldImport store, so the user can
 * close Settings and keep working while a codebase / chat export / Obsidian vault imports.
 * Hidden while the Settings sheet is open, which shows the same status inline.
 */
import React from "react";
import { COLD_IMPORT_LABELS, clearColdImportJob, useColdImportJob } from "../lib/coldImport";

export function ImportToast({ hidden = false }: { hidden?: boolean }): React.JSX.Element | null {
  const job = useColdImportJob();
  if (hidden || !job) return null;

  return (
    <div className="update-toast" role="status">
      {job.phase === "running" && (
        <span className="update-toast-text">
          <span className="spinner" aria-hidden="true" /> Importing {COLD_IMPORT_LABELS[job.kind]}
          {job.progress
            ? ` — ${job.progress.done.toLocaleString()}/${job.progress.total.toLocaleString()}`
            : "…"}
        </span>
      )}
      {job.phase === "done" && job.result && (
        <>
          <span className="update-toast-text">
            Imported {job.result.imported.toLocaleString()} from {COLD_IMPORT_LABELS[job.kind]}
            {job.result.removed ? ` — removed ${job.result.removed.toLocaleString()} stale files` : ""}
          </span>
          <button className="update-toast-dismiss" aria-label="Dismiss" onClick={clearColdImportJob}>
            ×
          </button>
        </>
      )}
      {job.phase === "error" && (
        <>
          <span className="update-toast-text update-toast-error">
            Import of {COLD_IMPORT_LABELS[job.kind]} failed
          </span>
          <button className="update-toast-dismiss" aria-label="Dismiss" onClick={clearColdImportJob}>
            ×
          </button>
        </>
      )}
    </div>
  );
}
