/**
 * Settings sheet: General, Usage, Storage, Account, and the Deleted sub-page.
 *
 * The Electron app's provider picker, Codex/Claude connect panes, local MCP server, macOS
 * permission grants, tracked git repos and the logs window are all gone — each drove a local
 * process a browser tab cannot reach. The hosted service runs on the built-in provider.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  DAILY_BUDGET_ENFORCED,
  type AppSettingsData,
  type AuthUser,
  type DeletedEntrySummary,
  type DeletedRestoreResult,
  type Plan,
  type StatusSnapshot,
  type StorageUsageResult,
  type UsageLimitsSnapshot,
} from "../shared/api";
import { DEV_TOOLS } from "../lib/devTools";
import { fmtRelative, fmtReset, previewText } from "../lib/format";


function Switch({ on, onToggle, disabled }: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <div
      className={`switch${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      style={disabled ? { opacity: 0.5 } : undefined}
      onClick={() => !disabled && onToggle()}
    >
      <div className="knob" />
    </div>
  );
}

function Section({ title, children, sectionRef }: {
  title: string;
  children: React.ReactNode;
  sectionRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div className="settings-section" ref={sectionRef}>
      <h3>{title}</h3>
      <div className="settings-group">{children}</div>
    </div>
  );
}

type SettingsCategory = "general" | "usage" | "storage" | "account" | "deleted";
type SettingsNavCategory = Exclude<SettingsCategory, "deleted">;

const SETTINGS_CATEGORIES: ReadonlyArray<{ id: SettingsNavCategory; label: string }> = [
  { id: "general", label: "General" },
  { id: "usage", label: "Usage" },
  { id: "storage", label: "Storage" },
  { id: "account", label: "Account" },
];

const SETTINGS_PAGE_LABELS: Record<SettingsCategory, string> = {
  general: "General",
  usage: "Usage",
  storage: "Storage",
  account: "Account",
  deleted: "Deleted",
};

function SettingsCategoryIcon({ category }: { category: SettingsNavCategory }) {
  if (category === "general") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63h.01A1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9v.01A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
      </svg>
    );
  }

  if (category === "usage") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 19V9m7 10V5m7 14v-7" />
      </svg>
    );
  }

  if (category === "storage") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
        <path d="M4.5 5.5v6c0 1.65 3.36 3 7.5 3s7.5-1.35 7.5-3v-6M4.5 11.5v6c0 1.65 3.36 3 7.5 3s7.5-1.35 7.5-3v-6" />
      </svg>
    );
  }

  if (category === "account") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1" />
      </svg>
    );
  }

  if (category === "sources") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 8a3 3 0 1 1 5 2.2L10 14.2a3 3 0 1 1-1.4-1.4L12.6 8.8" />
        <path d="M15 16a3 3 0 1 1-5-2.2L14 9.8a3 3 0 1 1 1.4 1.4L11.4 15.2" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
      <path d="M5 14v5h14v-5" />
    </svg>
  );
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function usageTitle(label: string): string {
  return `${label} usage`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

/**
 * When the pot refills, on the reader's clock. The boundary is one fixed instant for everyone
 * (usageLimits.ts), so "midnight" would only be true on the US east coast.
 */
function formatResetTime(resetsAt: number): string {
  return new Date(resetsAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatUsageUsd(value: number): string {
  return `$${Math.max(0, value).toFixed(4)}`;
}

function UsageSettingsPage() {
  const [limits, setLimits] = useState<UsageLimitsSnapshot | null>(null);

  // One fetch, then live pushes: the page is often open while the user spends elsewhere, and
  // it must flip back to full at midnight on its own.
  useEffect(() => {
    let alive = true;
    window.graph
      .usageLimits()
      .then((result) => alive && setLimits(result))
      .catch(() => undefined);
    const unsubscribe = window.graph.onUsageLimits((next) => alive && setLimits(next));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  return (
    <Section title="Model usage">
      {DAILY_BUDGET_ENFORCED ? (
        <>
          {/* One pot for the whole day — notes, questions and dictation all draw on it — so the
              bar is the single honest answer to "how much is left?". Deliberately no dollar
              figures: a price tag on every note invites rationing. */}
          <div className="settings-row settings-usage-meter" aria-label="daily-usage">
            <div className="settings-usage-meter-head">
              <span className="label">Today&apos;s usage</span>
              <span className="settings-usage-meter-percent">
                {limits ? `${limits.remainingPercent}% left` : "…"}
              </span>
            </div>
            <div className="settings-usage-meter-track">
              {/* No fill until the real number lands: a default-full bar would flash "all
                  yours" and animate down, briefly showing the opposite of the truth. */}
              {limits && (
                <div
                  className="settings-usage-meter-fill"
                  style={{ width: `${limits.remainingPercent}%` }}
                />
              )}
            </div>
          </div>
          <div className="settings-row">
            <span className="caption">
              {limits ? `Usage resets at ${formatResetTime(limits.resetsAt)}.` : "Usage resets daily."}
            </span>
          </div>
        </>
      ) : (
        <div className="settings-row">
          <span className="caption">Usage isn’t capped.</span>
        </div>
      )}
    </Section>
  );
}

const PLAN_LABELS: Record<Plan, string> = { free: "Free", basic: "Basic", pro: "Pro" };

const PAID_PLANS: ReadonlyArray<{
  id: Exclude<Plan, "free">;
  price: string;
  blurb: string;
  features: readonly string[];
}> = [
  {
    id: "basic",
    price: "$5",
    blurb: "For steady, everyday capture.",
    features: ["Allowances reset at midnight", "Cancel anytime"],
  },
  {
    id: "pro",
    price: "$20",
    blurb: "For heavy use and big imports.",
    features: ["Allowances reset at midnight", "Cancel anytime"],
  },
];

function CheckGlyph(): React.JSX.Element {
  return (
    <svg className="plan-check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** Checkout happens in the browser, so the app is told nothing — watch for the change instead. */
const PLAN_POLL_MS = 3_000;
const PLAN_POLL_ATTEMPTS = 40; // ~2 min

function AccountSettingsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void window.graph.authStatus().then((r) => alive.current && setUser(r.user)).catch(() => undefined);
    // Cache first so the badge paints instantly, then the real value from Supabase.
    void window.graph
      .planStatus()
      .then((r) => alive.current && setPlan(r.plan))
      .catch(() => undefined)
      .finally(() => {
        void window.graph
          .planRefresh()
          .then((r) => alive.current && setPlan(r.plan))
          .catch(() => undefined);
      });
    return () => {
      alive.current = false;
    };
  }, []);

  // Coming back from the browser is the strongest hint that billing just changed.
  useEffect(() => {
    const onFocus = () => {
      void window.graph
        .planRefresh()
        .then((r) => alive.current && setPlan(r.plan))
        .catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const clean = (e: Error) => e.message.replace(/^Error invoking remote method '[^']+': Error: /, "");

  const refreshPlan = async () => {
    setBusy("refresh");
    setError(null);
    try {
      setPlan((await window.graph.planRefresh()).plan);
    } catch (e) {
      setError(clean(e as Error));
    } finally {
      setBusy(null);
    }
  };

  /** Poll until the webhook has landed the new tier, so the page settles without being touched. */
  const watchForPlanChange = (before: Plan | null) => {
    setWatching(true);
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (!alive.current || attempts > PLAN_POLL_ATTEMPTS) {
        window.clearInterval(timer);
        if (alive.current) setWatching(false);
        return;
      }
      void window.graph
        .planRefresh()
        .then((r) => {
          if (!alive.current || r.plan === before) return;
          setPlan(r.plan);
          window.clearInterval(timer);
          setWatching(false);
        })
        .catch(() => undefined);
    }, PLAN_POLL_MS);
  };

  const openBilling = async (action: "portal" | Exclude<Plan, "free">) => {
    setBusy(action);
    setError(null);
    try {
      const { url } = action === "portal"
        ? await window.graph.billingPortal()
        : await window.graph.billingCheckout(action);
      await window.graph.openExternal(url);
      watchForPlanChange(plan);
    } catch (e) {
      setError(clean(e as Error));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    setBusy("sign-out");
    try {
      await window.graph.authSignOut();
      onSignedOut();
    } finally {
      setBusy(null);
    }
  };

  // Checkout only opens a FIRST subscription. Once one exists, every plan change and the
  // cancellation back to Free go through the Stripe portal, or we'd bill two at once.
  const subscribed = plan !== null && plan !== "free";
  const offers = subscribed ? [] : PAID_PLANS;

  return (
    <>
      <Section title="Account">
        <div className="settings-row">
          <span className="label">Signed in as</span>
          <span>{user?.email ?? "—"}</span>
        </div>
        <div className="settings-row">
          <span className="caption">Your notes stay on this device. The account covers your plan and limits.</span>
          <button className="btn danger" onClick={() => void signOut()} disabled={busy === "sign-out"}>
            {busy === "sign-out" ? "Signing out…" : "Sign Out"}
          </button>
        </div>
      </Section>

      <Section title="Plan">
        {error && (
          <div className="settings-row">
            <span className="error-text">{error}</span>
          </div>
        )}
        <div className="settings-row">
          <span className="label">Current plan</span>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="plan-badge">{plan ? PLAN_LABELS[plan] : "…"}</span>
            {watching && <span className="spinner" aria-hidden="true" />}
            <button className="btn quiet" onClick={() => void refreshPlan()} disabled={busy === "refresh"}>
              {busy === "refresh" ? "Checking…" : "Refresh"}
            </button>
          </span>
        </div>

        {offers.length > 0 && (
          <div className="plan-cards">
            {offers.map((candidate) => (
              <div key={candidate.id} className="plan-card">
                <div className="plan-card-head">
                  <strong>{PLAN_LABELS[candidate.id]}</strong>
                  <span className="plan-price">
                    {candidate.price}
                    <span className="plan-price-unit">/mo</span>
                  </span>
                </div>
                <p className="plan-blurb">{candidate.blurb}</p>
                <ul className="plan-features">
                  {candidate.features.map((feature) => (
                    <li key={feature}>
                      <CheckGlyph />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <button
                  className="btn primary"
                  onClick={() => void openBilling(candidate.id)}
                  disabled={busy === candidate.id}
                >
                  {busy === candidate.id ? "Opening…" : `Upgrade to ${PLAN_LABELS[candidate.id]}`}
                </button>
              </div>
            ))}
          </div>
        )}

        {subscribed && (
          <>
            <div className="settings-row">
              <div>
                <div className="label">Switch plan</div>
                <div className="caption">
                  Move between Basic and Pro. Stripe prorates the difference on your next invoice.
                </div>
              </div>
              <button className="btn" onClick={() => void openBilling("portal")} disabled={busy === "portal"}>
                {busy === "portal" ? "Opening…" : "Change plan"}
              </button>
            </div>
            <div className="settings-row">
              <div>
                <div className="label">Cancel subscription</div>
                <div className="caption">
                  Drops you to Free at the end of the period you&apos;ve paid for — you keep your current
                  limits until then. Your notes are never touched.
                </div>
              </div>
              <button className="btn" onClick={() => void openBilling("portal")} disabled={busy === "portal"}>
                {busy === "portal" ? "Opening…" : "Manage billing"}
              </button>
            </div>
          </>
        )}
        <div className="settings-row">
          <span className="caption">
            {watching
              ? "Waiting for Stripe to confirm — this page updates itself once it does."
              : "Billing opens in your browser. This page updates on its own when you come back."}
          </span>
        </div>
      </Section>
    </>
  );
}

function StorageSettingsPage() {
  const [usage, setUsage] = useState<StorageUsageResult | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    window.graph
      .storageUsage()
      .then((result) => alive && setUsage(result))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Section title="Stored documents">
      {!usage && !error && (
        <div className="settings-row">
          <span className="muted">Calculating storage…</span>
        </div>
      )}
      {error && (
        <div className="settings-row">
          <span className="error-text">Storage size couldn&apos;t be calculated.</span>
        </div>
      )}
      {usage && (
        <>
          <div className="settings-storage-summary">
            <strong>{formatBytes(usage.totalBytes)}</strong>
            <span>stored in Ceb</span>
          </div>
          <div className="settings-row">
            <span className="label">Notes &amp; search index</span>
            <span>{formatBytes(usage.documentBytes)}</span>
          </div>
          <div className="settings-row">
            <span className="label">Images &amp; files</span>
            <span>{formatBytes(usage.mediaBytes)}</span>
          </div>
        </>
      )}
    </Section>
  );
}

function DeletedSettingsPage({ onEntryRetrieved }: {
  onEntryRetrieved?: (entry: DeletedRestoreResult) => void;
}) {
  const [entries, setEntries] = useState<DeletedEntrySummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.graph
      .deletedList()
      .then((result) => alive && setEntries(result))
      .catch((cause: Error) => alive && setError(cause.message));
    return () => {
      alive = false;
    };
  }, []);

  const retrieve = async (entry: DeletedEntrySummary) => {
    setBusyId(entry.id);
    setError(null);
    try {
      const restored = await window.graph.deletedRestore(entry.id);
      setEntries((current) => current?.filter((candidate) => candidate.id !== entry.id) ?? []);
      onEntryRetrieved?.(restored);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const deleteNow = async (entry: DeletedEntrySummary) => {
    if (!window.confirm(`Permanently delete “${entry.title}”? This can’t be undone.`)) return;
    setBusyId(entry.id);
    setError(null);
    try {
      await window.graph.deletedDeleteNow(entry.id);
      setEntries((current) => current?.filter((candidate) => candidate.id !== entry.id) ?? []);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  if (entries === null && !error) return <p className="muted">Loading deleted entries…</p>;

  return (
    <div className="settings-deleted-page">
      {error && <p className="error-text">{error}</p>}
      {entries?.length === 0 && (
        <div className="settings-deleted-empty">
          <h3>No entries to be deleted</h3>
        </div>
      )}
      {entries && entries.length > 0 && (
        <div className="settings-deleted-list">
          {entries.map((entry) => {
            const daysLeft = Math.max(0, Math.ceil((Date.parse(entry.purgeAt) - Date.now()) / 86_400_000));
            return (
              <article key={entry.id} className="settings-deleted-entry">
                <div className="settings-deleted-entry-copy">
                  <strong>{previewText(entry.title)}</strong>
                  {entry.snippet && <p>{previewText(entry.snippet)}</p>}
                  <span>
                    {daysLeft === 1 ? "1 day left" : `${daysLeft} days left`}
                    {entry.attachmentCount > 0
                      ? ` · ${entry.attachmentCount} ${entry.attachmentCount === 1 ? "file" : "files"}`
                      : ""}
                  </span>
                </div>
                <div className="settings-deleted-entry-actions">
                  <button
                    className="btn"
                    type="button"
                    disabled={busyId === entry.id}
                    onClick={() => void retrieve(entry)}
                  >
                    Retrieve
                  </button>
                  <button
                    className="btn danger"
                    type="button"
                    disabled={busyId === entry.id}
                    onClick={() => void deleteNow(entry)}
                  >
                    Delete now
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SettingsSheet({ snapshot, onClose, onSettingsChanged, onEntryRetrieved, onSignedOut }: {
  snapshot: StatusSnapshot | null;
  onClose: () => void;
  onSettingsChanged: (s: AppSettingsData) => void;
  onEntryRetrieved?: (entry: DeletedRestoreResult) => void;
  onSignedOut: () => void;
}) {
  const [settings, setSettings] = useState<AppSettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<SettingsCategory>("general");

  useEffect(() => {
    window.graph
      .settingsGet()
      .then((r) => setSettings(r.settings))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = async (p: Partial<AppSettingsData>) => {
    setError(null);
    try {
      const merged = await window.graph.settingsSet(p);
      setSettings(merged);
      onSettingsChanged(merged);
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    }
  };

  // The provider section sits below the Developer toggle that reveals it, which on a short
  // window is below the fold — flipping dev mode would otherwise look like nothing happened.
  const providerSection = useRef<HTMLDivElement>(null);
  const revealProviderSection = () => {
    // Optional call: jsdom has no scrollIntoView, and this firing after a test's unmount
    // must be a no-op, not a crash.
    requestAnimationFrame(() =>
      providerSection.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }));
  };

  const categoryLabel = SETTINGS_PAGE_LABELS[category];

  return (
    <div className="backdrop settings-backdrop">
      <div className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <aside className="settings-sidebar">
          <button className="settings-close" onClick={onClose} aria-label="Close settings">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m14.5 6-6 6 6 6" />
            </svg>
          </button>
          <nav className="settings-nav" aria-label="Settings categories">
            {SETTINGS_CATEGORIES.map((item) => (
              <button
                key={item.id}
                className={category === item.id ? "active" : ""}
                aria-current={category === item.id ? "page" : undefined}
                onClick={() => setCategory(item.id)}
              >
                <SettingsCategoryIcon category={item.id} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="settings-main">
          <header className="settings-page-head">
            <h2>{categoryLabel}</h2>
            {category === "deleted" && (
              <p>Entries will be automatically deleted in 30 days if not retrieved.</p>
            )}
          </header>
          <div className="settings-body">
            {category === "general" && (
              <div className="settings-general-page">
                {error && <p className="error-text">{error}</p>}
                {!settings && <p className="muted">Loading…</p>}
                {settings && DEV_TOOLS && (
                  <Section title="Developer">
                    <div className="settings-row">
                      <div>
                        <div className="label">Dev view on cards</div>
                        <div className="caption">
                          Adds an inspection panel under every card: the entities, concepts and
                          tags the extraction pulled, and that note&apos;s own graph.
                        </div>
                      </div>
                      <Switch
                        on={settings.devCardView}
                        onToggle={() => void patch({ devCardView: !settings.devCardView })}
                      />
                    </div>
                  </Section>
                )}
                <section className="settings-deleted-section" aria-label="Deleted items">
                  <button className="settings-deleted-link" type="button" onClick={() => setCategory("deleted")}>
                    <span>View deleted</span>
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <path d="m7.5 4.5 5 5.5-5 5.5" />
                    </svg>
                  </button>
                  <p>Deleted items are kept for 30 days.</p>
                </section>
              </div>
            )}
            {category === "usage" && (
              <UsageSettingsPage />
            )}
            {category === "account" && <AccountSettingsPage onSignedOut={onSignedOut} />}
            {category === "storage" && <StorageSettingsPage />}
            {category === "deleted" && <DeletedSettingsPage onEntryRetrieved={onEntryRetrieved} />}
          </div>
        </main>
      </div>
    </div>
  );
}
