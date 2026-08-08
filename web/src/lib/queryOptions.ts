/**
 * Query-options popover state: defaults are the
 * exact out-of-box retrieve call, so "reset" collapses to all-nil and `isCustomized` drives
 * the filled/tinted popover glyph.
 */
import type { RetrieveParams } from "../shared/protocol";

export type Breadth = "focused" | "broad";

export interface QueryOptionsState {
  /** Point-in-time view; null = current view. YYYY-MM-DD. */
  asOf: string | null;
  /** Focused = engine default (λ≈0.9 → send nothing); Broad = mmr_lambda 0.5. */
  breadth: Breadth;
  /** Event-time window. */
  since: string | null;
  until: string | null;
}

export const DEFAULT_QUERY_OPTIONS: QueryOptionsState = {
  asOf: null,
  breadth: "focused",
  since: null,
  until: null,
};

export function isCustomized(opts: QueryOptionsState): boolean {
  return opts.asOf !== null || opts.breadth !== "focused" || opts.since !== null || opts.until !== null;
}

export function resetOptions(): QueryOptionsState {
  return { ...DEFAULT_QUERY_OPTIONS };
}

export const BROAD_MMR_LAMBDA = 0.5;

/**
 * The retrieve params this state contributes (question/k/rerank added by the caller).
 * Defaults contribute NOTHING — an out-of-box call stays byte-identical to the plain call.
 */
export function toRetrieveParams(opts: QueryOptionsState): Partial<RetrieveParams> {
  const out: Partial<RetrieveParams> = {};
  if (opts.asOf) out.as_of = opts.asOf;
  if (opts.breadth === "broad") out.mmr_lambda = BROAD_MMR_LAMBDA;
  if (opts.since) out.since = opts.since;
  if (opts.until) out.until = opts.until;
  return out;
}

/** Loose YYYY-MM-DD validation for the date fields (empty = unset). */
export function normalizeDateInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}
