/**
 * Full-window gate shown whenever no session exists (App.tsx). Email + password against
 * Supabase; the app is unusable until one succeeds — except in a dev or staging build, which
 * also offers the local account (main/devAccount.ts) so testing a branch doesn't start with
 * typing credentials into every fresh per-branch userData tree.
 */
import React, { useState } from "react";
import type { AuthUser } from "../shared/api";

type Mode = "sign-in" | "sign-up" | "confirm-sent";

/** The white mark from assets/icon.svg on its blue plate — shared with Onboarding. */
function CebMark(): React.JSX.Element {
  return (
    <svg className="login-mark" viewBox="98 98 828 828" aria-hidden="true">
      <rect className="onb-mark-plate" x="98" y="98" width="828" height="828" rx="186" />
      <path
        className="onb-mark-glyph"
        d="M286.37,364.98 A31,31 0 0 1 317.37,333.98 L358.87,333.98 A31,31 0 0 1 389.87,364.98 L389.87,398.48 A21,21 0 0 0 410.87,419.48 L444.37,419.48 A31,31 0 0 1 475.37,450.48 L475.37,491.98 A31,31 0 0 1 444.37,522.98 L402.87,522.98 A31,31 0 0 1 371.87,491.98 L371.87,458.48 A21,21 0 0 0 350.87,437.48 L325.37,437.48 A21,21 0 0 0 304.37,458.48 L304.37,491.98 A31,31 0 0 1 273.37,522.98 L231.87,522.98 A31,31 0 0 1 200.87,491.98 L200.87,450.48 A31,31 0 0 1 231.87,419.48 L265.37,419.48 A21,21 0 0 0 286.37,398.48 Z M634.13,364.98 A31,31 0 0 1 665.13,333.98 L706.63,333.98 A31,31 0 0 1 737.63,364.98 L737.63,398.48 A21,21 0 0 0 758.63,419.48 L792.13,419.48 A31,31 0 0 1 823.13,450.48 L823.13,491.98 A31,31 0 0 1 792.13,522.98 L750.63,522.98 A31,31 0 0 1 719.63,491.98 L719.63,458.48 A21,21 0 0 0 698.63,437.48 L673.13,437.48 A21,21 0 0 0 652.13,458.48 L652.13,491.98 A31,31 0 0 1 621.13,522.98 L579.63,522.98 A31,31 0 0 1 548.63,491.98 L548.63,450.48 A31,31 0 0 1 579.63,419.48 L613.13,419.48 A21,21 0 0 0 634.13,398.48 Z"
      />
    </svg>
  );
}

export function LoginPage({ onSignedIn }: { onSignedIn: (user: AuthUser) => void }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clean = (cause: unknown) =>
    (cause as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "sign-up") {
        const { confirmationRequired } = await window.graph.authSignUp(email, password, phone, remember);
        if (confirmationRequired) {
          setMode("confirm-sent");
          return;
        }
      }
      onSignedIn(await window.graph.authSignIn(email, password, remember));
    } catch (cause) {
      setError(clean(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-card" role="main" aria-label="login">
        <CebMark />
        {mode === "confirm-sent" ? (
          <>
            <h1>Check your email</h1>
            <p className="login-sub">
              We sent a confirmation link to <strong>{email}</strong>. Sign in once you&apos;ve clicked it.
            </p>
            <button className="btn login-submit" onClick={() => setMode("sign-in")}>
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <h1>{mode === "sign-in" ? "Welcome back" : "Create your account"}</h1>
            <p className="login-sub">
              {mode === "sign-in"
                ? "Sign in to pick up where you left off."
                : "Your notes stay on this device — the account covers your plan."}
            </p>
            <form className="login-form" onSubmit={(e) => void submit(e)}>
              <input
                type="text"
                placeholder="Email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <input
                type="password"
                placeholder="Password"
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
              {mode === "sign-up" && (
                <input
                  type="tel"
                  placeholder="Phone number (optional)"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              )}
              <label className="login-remember">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Stay signed in
              </label>
              {error &&<p className="error-text login-error">{error}</p>}
              <button className="btn primary login-submit" type="submit" disabled={busy}>
                {busy ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Create account"}
              </button>
            </form>
            <button
              className="login-toggle"
              type="button"
              onClick={() => {
                setError(null);
                setMode(mode === "sign-in" ? "sign-up" : "sign-in");
              }}
            >
              {mode === "sign-in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
