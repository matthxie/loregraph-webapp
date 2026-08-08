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

**Sign-in is real.** It uses the same Supabase project as the Electron app, so existing accounts
work — auth is deliberately independent of the graph service, which is still mocked.

With no `VITE_API_BASE_URL` set, the board runs on `lib/mockServer.ts`: fixture notes and
simulated ingest. Set `VITE_MOCK_AUTH=1` to skip real sign-in too (any credentials become a fixed
dev user) when you want the UI with no network at all.

```sh
npm run typecheck   # tsc
npm test            # vitest — 217 tests, mostly ported from brainbrain
npm run build
```

## What the backend must provide

This app is UI only. Everything below is what it calls out to — full schemas in
[API.md](API.md), typed in [`web/src/shared/api.ts`](web/src/shared/api.ts), and implemented
in-memory by `lib/mockServer.ts` as a reference.

### Connections

| Service | Used for | Configured by |
|---|---|---|
| **Graph service** (FastAPI on EC2, :443) | every graph read and write | `VITE_API_BASE_URL` |
| **Supabase** | sign-in, plan/billing, `profiles.tour_seen`, user prefs — called direct from the browser, never through EC2 | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| **S3** | attachment bytes, via presigned PUT/GET the service mints | — (never addressed directly) |
| **SQS + worker** | ingest, entirely behind `POST /capture` | — (invisible to the client) |

Auth is one Supabase JWT as `Authorization: Bearer` on every EC2 call; the service takes the
user id from the `sub` claim and scopes all storage by it. CORS must allow the Vercel origin and
`http://localhost:5273`.

### Endpoints it calls

**Reads** — `GET /health` (liveness + a `capabilities` object that gates UI panes),
`/episodes` (`?shuffle&seed&limit&offset`, and `?ids=` to hydrate specific rows),
`/episodes/{id}`, `/episodes/{id}/graph`, `/search`, `/search/nl`, `/retrieve`, `/facts`,
`/profile`, `/stats`.

**Canvas collections** — `GET`/`PUT /collections/{name}/canvas`, one gzipped JSON object per
collection. See [API.md §7](API.md); the `PUT` must honour the `etag` and 409 on a stale one.

**Writes** — `POST /capture` → 202 `{spoolId}` (durable + queued, extraction is async);
`GET /inbox/status?spool_ids=` polled at 1.2s to follow it; `DELETE /episodes/{id}`;
`POST /episodes/{id}/reingest`; `POST /pending/delete`; `GET /trash`, `POST /trash/{id}/restore`,
`DELETE /trash/{id}`.

**Chat** — `POST /chat` as SSE (`started → activity* → answer|error → done`), `POST /chat/cancel`,
`GET /chat/history`.

**Everything else** — `POST /media/presign` and `GET /media/{leaf}`; `POST /link-preview` (must be
server-side: a browser can't read cross-origin OG tags, and client fetches would leak the user's IP
to every link they save); `POST /dictation/transcribe`; `GET /usage/limits`; `GET /storage/usage`;
`GET`/`PATCH /settings`; `POST /import/cold`.

Two of these are new rather than ports of `daemon.py`: `shuffle`/`seed` sampling, and `?ids=`
hydration. Both exist because the board holds a sample instead of the whole store.

### Behaviour the client depends on

- **`seed` must be stable** — same seed, same rows. The board refetches on every status poll; without
  it the cards reshuffle under the cursor several times a minute.
- **`operation_id` is an idempotency key** — a repeat must return the original `spoolId`, or a flaky
  connection duplicates notes.
- **402 messages must start with `USAGE_LIMIT:`** — every write surface shows the sentence after it
  instead of a generic failure.
- **A `false` capability returns 501, not 404** — the client hides the pane rather than erroring.
- **No `screenshot` source kind on chat answers.** Computer use is out of scope.

## What changed from the Electron app

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

**Collections are grids or canvases.** Chosen at creation and fixed after. A grid lays its saves
out like the feed; a canvas lets you drag them anywhere and draw lines, arrows, rectangles and
ellipses between them. The *kind* is one enum in prefs; the canvas *document* lives on the graph
service, because it is large and rewritten on every drag — the opposite profile from prefs. There
is deliberately no freehand ink: it dominates the stored size and simplification is fiddly to get
right.

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
