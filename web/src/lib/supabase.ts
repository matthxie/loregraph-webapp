/**
 * Supabase client. Accounts, billing, profiles and user prefs go here directly; the graph
 * service only ever sees the access token.
 */
import { createClient, type Session } from "@supabase/supabase-js";

/**
 * Same project as the Electron app, so existing accounts sign in unchanged. The anon key is
 * public by design — RLS is what gates access, and it grants only what the policies allow.
 */
const url = import.meta.env.VITE_SUPABASE_URL ?? "https://fmllqacroyxmsiivnfyr.supabase.co";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZtbGxxYWNyb3l4bXNpaXZuZnlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNjE0MDcsImV4cCI6MjEwMDkzNzQwN30.JCSr7vMiPPj0-0f0YwRSMpBRU49Jq2PjJ3WAHXeemuo";

/**
 * Whether real accounts are available. Deliberately independent of the graph service: auth is
 * a Supabase concern, and sign-in should work against real accounts while the board is still
 * running on mockServer. Set VITE_MOCK_AUTH=1 to force the fixed dev user instead.
 */
export const SUPABASE_CONFIGURED =
  Boolean(url) && Boolean(anonKey) && import.meta.env.VITE_MOCK_AUTH !== "1";

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** `remember: false` keeps the session in memory only — signed out on next launch. */
export function setSessionPersistence(remember: boolean): void {
  try {
    localStorage.setItem("ceb.auth.remember", remember ? "1" : "0");
  } catch {
    // Storage disabled — the session just won't survive a reload.
  }
}

export function shouldRememberSession(): boolean {
  try {
    return localStorage.getItem("ceb.auth.remember") !== "0";
  } catch {
    return true;
  }
}

/** Current access token for the graph service, refreshed if it has expired. */
export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export function onSession(listener: (session: Session | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => listener(session));
  return () => data.subscription.unsubscribe();
}
