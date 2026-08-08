# Ceb Web API — the contract between the web app and the graph service

This document specifies what the FastAPI service on EC2 must serve. It is the web equivalent of
brainbrain's `engine/PROTOCOL.md`: there, the Electron main process spoke JSON-RPC over stdio to a
local Python daemon; here, the browser speaks HTTPS to a hosted service. **The operations are the
same ones** — most routes below are a thin HTTP dress over a method that already exists in
`brainbrain/engine/daemon.py`, whose `METHODS` table is the authoritative reference implementation.

The typed client-side mirror of this document is [`web/src/shared/api.ts`](web/src/shared/api.ts)
(the `CebApi` interface). Result shapes come from
[`web/src/shared/protocol.ts`](web/src/shared/protocol.ts), copied verbatim from brainbrain — those
are the daemon's existing return values and **should not be redesigned**. If a field looks odd,
`daemon.py` is why, and the UI already depends on it.

---

## 1. Transport, auth, and errors

- **Base URL** — `https://<ec2-host>` (port 443 only; the diagram's security group). The client
  reads it from `VITE_API_BASE_URL`.
- **Auth** — every request carries `Authorization: Bearer <supabase_access_token>`. The service
  verifies the JWT against the Supabase JWKS
  (`https://fmllqacroyxmsiivnfyr.supabase.co/auth/v1/.well-known/jwks.json`) and takes the user id
  from the `sub` claim. **Every S3 prefix and every graph store is keyed by that `sub`.** A route
  must never accept a user id from the request body or a query parameter.
- **CORS** — allow the Vercel origin(s) and `http://localhost:5273` for local dev, with
  `Authorization` on the allowed-headers list and credentials off (the token is explicit, not a
  cookie).
- **Content type** — `application/json` throughout, except SSE (`POST /chat`) and the presigned S3
  PUT (which goes to S3 directly, not to this service).
- **Errors** — non-2xx returns `{"error": {"code": <string>, "message": <string>}}`. `message` is
  shown to the user, so it must be a sentence, not a stack trace. Codes the client treats
  specially:

  | HTTP | code | Client behavior |
  |---|---|---|
  | 401 | `unauthorized` | Session is stale — the client refreshes the Supabase token once, then signs the user out. |
  | 402 | `usage_limit` | `message` **must** start with `USAGE_LIMIT:` (see `USAGE_LIMIT_PREFIX`). Every write surface renders the sentence after that prefix instead of a generic failure. |
  | 404 | `not_found` | |
  | 501 | `not_supported` | Capability is off; the client hides the pane rather than erroring. |
  | 503 | `unavailable` | Drives `engine.state = "unavailable"` and the app's error screen. |

---

## 2. Route table

`daemon.py` column = the JSON-RPC method whose body this route should reuse.

### Status

| Route | daemon.py | Notes |
|---|---|---|
| `GET /health` | `health` | Returns `HealthResult` plus a `capabilities` object (§3). Called on mount and every 5s. Must be cheap — it is the app's liveness signal. |

### Graph reads

| Route | daemon.py | Notes |
|---|---|---|
| `GET /episodes?offset=&limit=&shuffle=&seed=` | `episodes.list` | See §4 — `shuffle`/`seed` are new and required. |
| `GET /episodes/{id}` | `episode` | |
| `GET /episodes/{id}/graph` | `graph.preview` | Per-episode subgraph for the card dev view. |
| `GET /collections/{name}/canvas` | — | See §7. |
| `PUT /collections/{name}/canvas` | — | See §7. |
| `GET /search?q=&k=` | `search` | BM25. Client asks `k=100` for lookups. |
| `POST /search/nl` | `search.nl` | Semantic ⊕ BM25, rank-fused. Client asks `k=20` for sentence queries. |
| `POST /retrieve` | `retrieve` | Body is `RetrieveParams`. |
| `GET /facts?entity=&as_of=&include_closed=` | `facts` | |
| `GET /profile` | `profile` | |
| `GET /stats?since=&until=` | `stats` | |

### Capture and lifecycle

| Route | daemon.py | Notes |
|---|---|---|
| `POST /capture` | `capture` | See §5. Returns **202** with `CaptureEcho`. |
| `GET /inbox/status?spool_ids=a,b,c` | `inbox.status` | Polled at 1.2s while notes are in flight. Omit `spool_ids` for the whole queue. |
| `POST /inbox/discard` | `inbox.discard` | |
| `DELETE /episodes/{id}` | `episode.delete` | Soft delete → trash, 30-day purge. |
| `POST /episodes/{id}/reingest` | `episode.reingest` | Body `{text, operation_id?, attachment_ids?}`. Returns `EpisodeReingestResult`. |
| `POST /pending/delete` | — | Cancel a note still mid-ingest. Body is `PendingDeleteInput`. If the SQS job hasn't been consumed, drop it; if it has, delete the resulting episode when it lands. |
| `GET /trash` | — | `DeletedEntrySummary[]`. |
| `POST /trash/{id}/restore` | — | Re-enqueues the note; returns `DeletedRestoreResult`. |
| `DELETE /trash/{id}` | — | Purge now. |

### Chat

| Route | daemon.py | Notes |
|---|---|---|
| `POST /chat` | `chat.answer` + `ask/runner.ts` | **SSE stream.** See §6. |
| `POST /chat/cancel` | — | Cancels the caller's in-flight run. |
| `GET /chat/history` | `chat.history.list` | `ChatMessage[]`. |

### Media

| Route | Notes |
|---|---|
| `POST /media/presign` | Body `{name, content_type, size}` → `{attachment_id, upload_url, headers}`. The browser PUTs bytes straight to S3 at `media/<user>/<attachment_id>`. Enforce a size cap and a content-type allowlist **when minting the URL** — after the PUT it's too late. |
| `GET /media/{leaf}` | 302 to a short-lived (≤15 min) presigned GET for `media/<user>/<leaf>`. Reject any leaf containing `/`, `\`, or `..`. |

### Import, settings, usage, misc

| Route | daemon.py | Notes |
|---|---|---|
| `POST /import/cold` | `import.cold` | Body `ColdImportParams` with uploaded attachment ids in place of a local path. Long-running; emits progress over `GET /import/progress` (SSE). |
| `GET /settings` · `PATCH /settings` | — | `AppSettingsData`. May be backed by Supabase `user_prefs` rather than EC2. |
| `GET /usage/limits` | — | `UsageLimitsSnapshot`, from Supabase `usage_daily`. |
| `GET /storage/usage` | — | `StorageUsageResult` — sum the user's S3 prefixes. |
| `POST /link-preview` | `linkPreview.ts` (main) | **Must stay server-side.** A browser cannot read cross-origin OpenGraph tags, and fetching client-side would leak the user's IP to every link they save. Port `main/linkPreview.ts`'s SSRF and size checks as-is. |
| `POST /dictation/transcribe` | `ask/voiceTranscriber.ts` | `audio/wav` body → `{text}`. Bills against the daily allowance. |

### Not served by this service

Sign-in/up/out, session refresh, plan status, Stripe checkout/portal, `profiles.tour_seen`, and
user prefs all go **from the browser directly to Supabase**. The four existing migrations in
`brainbrain/supabase/migrations/` carry over unchanged; this repo adds `user_prefs` (§8).

---

## 3. `GET /health` and capabilities

```json
{
  "ok": true,
  "protocol_version": 1,
  "engine_version": "0.2.x",
  "store": { "episodes": 1240, "entities": 8801, "facts": 15022 },
  "capabilities": {
    "episodesList": true, "episodeDelete": true, "episodeReingest": true,
    "searchNl": true, "chatAnswer": true, "coldImport": false, "shuffle": true
  }
}
```

In Electron, capabilities were *probed* per method because the daemon might be an older build. The
hosted service knows its own feature set, so it declares it — but the field stays, because the UI
genuinely gates panes on it and a service mid-deploy can legitimately turn a feature off. A
capability reported `false` must also make its routes return **501 `not_supported`**, not 404.

---

## 4. `GET /episodes` — and why `shuffle` exists

The Electron board paged the **entire store** into the renderer (2000 rows at a time until
`rows.length >= total`) and filtered client-side. That is unacceptable over a network, and the web
app's main view no longer wants it: **the default board is a random sample of 10 notes.**

```
GET /episodes?shuffle=1&limit=10&seed=7f3a91c2
GET /episodes?offset=0&limit=60            # the "show all" / New / Old paths
```

- `shuffle=1` — sample `limit` rows at random from the user's whole store, not from the newest
  page. Sampling the newest page would defeat the point.
- `seed` — an opaque client-supplied string. **The same seed must return the same rows.** The board
  refetches on every status poll and after every ingest; without a stable seed the user's cards
  would reshuffle under their cursor several times a minute. The client mints a new seed only when
  the user presses Shuffle.
- Response is `EpisodesListResult` (`{episodes: EpisodeListRow[], total: number}`) either way, with
  `total` always the full store count so the UI can say "10 of 1,240".

**Consequence for search:** with 10 rows loaded, the client can no longer filter locally — so
`GET /search` and `POST /search/nl` become the authoritative search path and must cover the whole
store. They already do. The client keeps its local matcher only as an overlay on rows it happens to
have.

---

## 5. `POST /capture` — the write path

```
POST /capture   {"text": "...", "operation_id": "uuid", "attachment_ids": ["..."]}
→ 202 {"status": "spooled", "spoolId": "sp_...", "text": "...", "at": "2026-08-08T...", "attachments": 2}
```

Per the architecture diagram:

1. Write the raw note to `s3://<bucket>/raw/<user>/<note_id>.json`. **The response must not be sent
   until this is durable** — this is the point at which the user's note is safe.
2. Enqueue an SQS message referencing it.
3. Return 202 immediately with the `spoolId`.

The worker then consumes one message at a time, loads that user's `store/<user>/kg.db` into its
in-RAM GraphStore, runs extraction, writes `extractions/<user>/<note_id>.json`, uploads the updated
`kg.db`, and stamps job state into Supabase. `GET /inbox/status` reads that job state.

`operation_id` is an **idempotency key**. The client retries captures on transient failure; a
repeated `operation_id` must return the original `spoolId` (and `episodeId` if it has one already)
rather than creating a second note. This is what keeps a flaky connection from duplicating notes.

The client's optimistic-card machinery (`App.tsx`) already handles the full lifecycle — pending
card → `spoolId` → polled `inbox.status` → `episodeId` → board refetch. It needs no push channel;
polling is sufficient and is what the Electron app did.

> **Scaling note, flagged deliberately:** one worker with a single in-RAM GraphStore and a per-job
> `kg.db` round-trip serializes ingest *across all users*, and re-downloads a store per note. That
> matches the diagram and is fine for early users. The client makes no assumption about ingest
> latency, so sharding workers by user later is a server-side change only.

---

## 6. `POST /chat` — SSE

The omnibar's chat mode (add / search / **chat**) streams. Request:

```json
{"question": "what did I say about the gym", "history": [{"role":"user","content":"..."}]}
```

Response is `text/event-stream`, one JSON `AskEvent` per `data:` line:

```
data: {"kind":"started","runId":"run_1"}
data: {"kind":"activity","runId":"run_1","label":"searching your graph…"}
data: {"kind":"answer","runId":"run_1","text":"...","sources":[{"kind":"memory","label":"memory: gym","episodeId":"ep_1","snippet":"..."}]}
data: {"kind":"done","runId":"run_1","ok":true}
```

Sequence is always `started → activity* → (answer | error) → done`. Sources are of kind `memory`,
`profile`, or `web`.

**No computer use.** The Electron app could capture the user's screen and pass it to the model.
That is out of scope here: there is no `screenshot` source kind, no screen-permission plumbing, and
no `screenRequested` on the `started` event. The service must never emit them.

Chat may also *write* to the graph (saving a memory, editing or deleting a note). Those ride the
normal capture/reingest/delete routes; the client reconciles the board optimistically via its
`onAskMemoryQueued` / `onAskEpisodeMutation` handlers. Folder, pin, and filter actions are
**client-owned** — they never reach this service.

---

## 7. Canvas collections

A collection is a **grid** or a **canvas**, chosen when it is created and fixed after. The *kind*
is one enum per collection and lives in Supabase `user_prefs` with the rest of the folder state (§8).
The canvas *document* does not — it is large and rewritten constantly, which is the opposite
profile from prefs:

```
GET /collections/{name}/canvas   → 200 {"doc": CanvasDocument, "etag": "w/..."}
                                 → 200 {"doc": <empty canvas>, "etag": null}   never saved
PUT /collections/{name}/canvas     {"doc": CanvasDocument, "etag": "w/..."|null}
                                 → 200 {"etag": "w/..."}
                                 → 409 conflict   the stored etag moved on
```

`CanvasDocument` (typed in `shared/api.ts`):

```jsonc
{
  "version": 1,
  "items":  [{ "id": "ep_...", "x": 0, "y": 0, "w": 240, "h": 160, "z": 1 }],
  "shapes": [{ "id": "sh_...", "kind": "line|arrow|rect|ellipse",
               "x1": 0, "y1": 0, "x2": 100, "y2": 40, "color": 0, "width": 3 }],
  "view":   { "x": 0, "y": 0, "zoom": 1 }
}
```

Every shape is two points: lines and arrows run p1→p2, rects and ellipses take the two as
opposite corners. `color` indexes a client-side palette, so the server stores an integer and
never needs to know the theme. There is no freehand ink.

**Storage.** One object per collection, e.g. `canvas/<user>/<collection>.json.gz`. Measured
sizes: a typical canvas (50 saves, 40 shapes) is ~26 KB raw / ~8 KB gzipped; a busy one (200
saves, 150 shapes) is ~138 KB / ~44 KB. Even 1,000 users with 20 canvases each is ~160 MB. The
client rounds all coordinates to whole pixels before sending, which roughly halves it.

**Concurrency.** `etag` is opaque to the client — it sends back whatever it last received.
Return **409** when it doesn't match the stored one rather than overwriting; two tabs open on
one canvas is the ordinary case, not an edge case.

**Write rate.** The client debounces saves (~1.2 s after the last change) and flushes once when
leaving the canvas, so a drag is one write rather than one per frame. An hour of continuous
editing is on the order of 1,800 requests.

## 8. Supabase additions

Four migrations carry over from brainbrain unchanged (`accounts_billing`, `rename_plan_tiers`,
`usage_daily`, `profiles`). This repo adds:

```sql
-- user_prefs: folders, pins, folder visibility, and app settings.
-- In Electron these lived in localStorage. On web that would strand a user's folders in one
-- browser, and the shuffled-10 board cannot count folders from 10 loaded rows anyway.
create table public.user_prefs (
  user_id uuid not null references auth.users(id) on delete cascade,
  key     text not null,
  value   jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.user_prefs enable row level security;
create policy "own prefs" on public.user_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Keys mirror the old localStorage names: `user-tags`, `pins`, `created-folders`, `hidden-folders`,
`folder-visibility`, `settings`, `write-draft`.

An `ingest_job` table is also needed so `GET /inbox/status` has something to read; its shape is the
worker's business, but it must be able to answer, per `spool_id`: state
(`queued|running|done|failed`), resulting `episode_id`, and error text.
