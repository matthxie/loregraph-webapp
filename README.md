# ceb-webapp

The web version of [Ceb](https://github.com/foca-apps/brainbrain) — the same UI, served from the
browser instead of an Electron shell, against a hosted graph service instead of a local Python
daemon.

```
web/          Vite + React 19 SPA (→ Vercel)
  src/shared/api.ts    the contract with the graph service — start here
  src/lib/graphClient  window.graph, implemented over HTTP
  src/lib/mockServer   in-memory backend, used when no service is configured
API.md        what the FastAPI service on EC2 must serve
supabase/     a proposed user_prefs migration (NOT applied)
```

## Running it

```sh
cd web && npm install && npm run dev
```

With no `VITE_API_BASE_URL` set the app runs entirely on `lib/mockServer.ts`: fixture notes,
simulated ingest, local auth (any email/password signs you in). That is the intended way to work
on the UI today — the backend does not exist yet.

```sh
npm run typecheck   # tsc
npm test            # vitest — 199 tests, ported from brainbrain
npm run build
```

## How it relates to brainbrain

The Electron renderer talked to exactly one thing: `window.graph`, the typed bridge in
`src/shared/bridge.ts`. Everything below it — daemon supervision, JSON-RPC, Supabase, the media
protocol, file staging — lived in `src/main/` and never leaked into React. That is what made this
port mostly a copy.

Carried over close to verbatim: `styles.css` / `tokens.css` / `chat.css`, the masonry board
(`HistoryPage`), the omnibar (`InputPage`), the folders sidebar, link previews, the graph preview,
onboarding, and the vitest suite for all of it.

`shared/bridge.ts` became **`shared/api.ts`**: the same operation names and the same
`protocol.ts` result shapes, redescribed as an HTTP contract and mounted as `window.graph` by
`lib/graphClient.ts`. Ported components needed no edits.

### What changed

**The main view is a shuffled 10.** The Electron board paged the *entire* store into the renderer
(2000 rows at a time until it had everything) and filtered client-side. Over a network that is
untenable, so `GET /episodes?shuffle=1&limit=10&seed=…` samples server-side, the board renders one
flat masonry, and a Shuffle button re-rolls. The seed is what keeps the sample still — the board
refetches on every status poll, and without it the cards would reshuffle under the cursor several
times a minute. Newest / Oldest / Random remain in the sort menu and page in order.

Two consequences, both handled: search is now served by the engine rather than by filtering a full
local copy (hits not in the sample are hydrated via `episodesByIds`), and folder counts come from
the tag map rather than the loaded rows, since counting 10 rows would show "1" for a folder holding
forty notes.

**Folders, pins and filings moved to Supabase.** They were localStorage, which on web would strand a
user's folders in one browser. `lib/prefs.ts` keeps a synchronous localStorage mirror and treats
Supabase as write-through sync, so `tags.ts` / `pins.ts` kept their exact store shape and every
consumer is unchanged. **The table does not exist yet** — sync disables itself after a few failures
and the app behaves exactly as the Electron one did until someone applies the migration.

**Chat came back to the bar.** The omnibar has its three modes again — add / search / chat — restored
from the v0.1.6 release, where `chatOpen` rendered `<ChatAnswer />` inline above the composer. There
is no popup window and no global hotkey. **Computer use is out**: no screen capture, no `screenshot`
source kind, no permission plumbing.

**Removed**, all of them local-process surfaces a browser tab cannot reach: the tray, auto-updater,
logs window, local MCP server, Codex/Claude provider panes, tracked git repos, native file pickers,
macOS permission grants, and the whole `main/` process. Settings is down to General / Usage /
Storage / Account / Deleted.

## Status

The UI is complete and runs end to end against the mock. The graph service is not built — `API.md`
is the specification for it, and `mockServer.ts` is a working reference for every route's behavior.
Nothing in the live Supabase project or Stripe has been touched.
