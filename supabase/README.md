# Supabase

**Nothing here has been applied.** The live Supabase project and the Stripe integration are
owned elsewhere and were deliberately not touched — no migrations run, no functions deployed,
no dashboard changes.

`migrations/20260808000000_user_prefs.sql` is a **proposal**, not a deployment. It is the table
the web app wants for folders, pins, filings and settings, which lived in localStorage in the
Electron app. Someone with access should review and apply it.

The app does not require it. `web/src/lib/prefs.ts` reads and writes a localStorage mirror
synchronously and treats Supabase as a write-through sync layer: if the table is absent, sync
disables itself after a few failures and the app keeps working exactly as the Electron one did —
prefs simply stay per-browser until the table exists.

The accounts / billing / usage / profiles tables the app reads (`profiles.tour_seen`,
`usage_daily`, plan status, Stripe checkout and portal Edge Functions) already exist in the
project from brainbrain. Their migrations are **not** duplicated here — brainbrain remains their
home, and keeping a second copy would only invite the two to drift.
