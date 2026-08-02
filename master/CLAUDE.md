# CLAUDE.md — SiteMonitor Master (server)

Guidance for Claude Code when working in the `master/` server. Source comments here are
in **Hebrew**; keep that style when editing.

## Overview
The Master is the Node.js server side of Parkomat/SiteMonitor. It ingests MQTT messages from
site Agents (`sites/{code}/state`, `sites/{code}/operation`, `sites/{code}/bridge`), stores them
in **PostgreSQL (Supabase)**, and serves the dashboard/API. Data-access lives in `db/queries.js`.

## The database is PostgreSQL, not SQLite

This project **was** SQLite (`better-sqlite3`) and was migrated to Supabase. Several traps
follow from that history — a fresh reader will get all of them wrong by default:

- **Schema is `db/schema.postgres.sql`.** `db/schema.sql` is the **dead SQLite original**; it is
  read by nothing. `better-sqlite3` is still in `package.json` — also dead. Both are slated for
  removal; do not add to them.
- **Everything is async.** `db.prepare(sql).get/all/run(...)` return **Promises**. Every caller
  must `await`. Forgetting one does not throw — spreading a Promise (`{...maybePromise}`) yields
  `{}` and the field silently vanishes. This has already caused one production bug.
- **Placeholders stay `?`.** `db/db.js` converts `?` → `$1,$2` in one place (`toPositional`) so
  the ~200 existing queries didn't have to change. Keep writing `?`.
- **`COUNT`/`SUM` return BIGINT, and `pg` returns BIGINT as a *string*.** `db.js` installs
  `types.setTypeParser(20, parseInt)` to fix this globally. Without it `operations === 0` fails
  silently against `"0"`.
- **Postgres lowercases unquoted aliases.** `SELECT x AS siteCode` arrives as `sitecode`. Quote
  camelCase aliases: `AS "siteCode"`. This shipped a bug where the dashboard's error list
  rendered blank rows.
- **Connection is the Supabase *pooler*, not the direct host** (`db.<ref>.supabase.co` is
  IPv6-only and will not resolve). We use **transaction mode, port 6543**. It rejects
  multi-statement DDL, so `init()` runs the schema over a one-off **session** connection (5432)
  and everything else runs on the transaction pool.

`DATABASE_URL` is required; the server refuses to start without it.

## Testing — never against production

`DATABASE_URL` used to point only at production, so every test wrote to real customer data.
It has happened. There is now a **separate Supabase project** for tests, configured in
`master/.env.test` (git-ignored; template in `.env.test.example`).

```sh
npm run test:db:init     # create schema + stamp the test marker
npm run test:db:seed     # deterministic synthetic data (--sites=200 --days=365 for load tests)
npm run test:db:reset    # wipe clean, keep the marker
npm run test:server      # run the server against the test DB
```

**The guard is a positive marker, not a blacklist** (`db/test-guard.js`). A test DB carries
`settings['environment'] = 'test'` **inside the database**; destructive scripts demand to see it
and abort otherwise. Production has no such row and never will, so it is protected even from
URLs nobody anticipated. **Fails closed: in doubt, refuse.**

Second guard, and it is not theoretical: in Node an **existing `DATABASE_URL` in the shell
overrides `--env-file`**. One terminal with production exported would have made
`npm run test:db:reset` wipe production. `assertEnvFileWins()` catches that specifically.

Any new destructive tool **must** call `assertTestDatabase()` first.

## Cycle counter model (`cycle_total` vs the PLC counter)
`cycle_total` on a site is the **machine's cumulative cycle count** — how many physical
cycles the barrier/machine has done. The raw counter comes from the PLC in each `operation`
message (`cycle_counter`). `applyCycleCounter` (queries.js) maintains it:

- **`plc_cycle_last`** = the last raw PLC value seen (baseline for computing the delta).
- On each new reading we add the **delta** (`current - last`) to `cycle_total`; a `current < last`
  is treated as a controller **reset**; a message older than `cycle_last_ts` is **backfill** and ignored.
- **First reading (`plc_cycle_last === null`)** depends on the site's `is_new_site` flag:
  - **`is_new_site = 1` (new site):** `cycle_total` stays **0**. The PLC value (e.g. 1,376 from
    factory tests/installation) is stored only as the baseline. Only growth from here is counted.
  - **`is_new_site = 0` (veteran site):** `cycle_total` **adopts** the PLC value (e.g. 1,376,000) —
    the real historical machine count — then continues counting deltas.

### `is_new_site` field (`sites` table)
`is_new_site INTEGER NOT NULL DEFAULT 1` — `1` = new (counter starts at 0), `0` = veteran
(adopt the controller's historical counter). **Default 1 is the safe choice** (never inflates
numbers). Set via `insertSite(code, name, meta, isNewSite)` (4th arg, default 1) or the test tool:
`node tools/add-test-site.js <code> "<name>" new|existing` (`new` = default).

## Failure rate is computed on OPERATIONS, not on `cycle_total`
This is a hard rule. **Failure rate = errors ÷ operations**, where `operations` is the **count of
rows in the `operations` table** (`getSiteStats`: `is_anomaly = 0 AND start_end = 'end'`) — i.e.
operations actually *measured* since install. It is **never** derived from `cycle_total`.

So a veteran site with `cycle_total = 1,376,000` but only, say, 500 measured operations and 5
errors has a failure rate of **1%** (5 / 500), not 5 / 1,376,000. `cycle_total` (machine wear /
preventive-maintenance signal) and `operations` (measured activity) are separate concepts — don't
mix them. Same for `generateMonthlySummary` / `getSystemSummary` (both sum monthly `operations`).

## Availability has exactly ONE definition

It used to be computed three different ways in three places, which meant the same site showed
different uptime on different screens. There is now one function — **`availabilityFrom()` in
`queries.js`** — and every caller goes through it:

```
availability = (ready + operating) / (ready + operating + error + no_comm)
```

**Planned maintenance is excluded from the denominator entirely** — it is neither uptime nor
downtime. Taking a site down deliberately must not look like a failure, and must not be rewarded
as availability either. If you need availability anywhere new, **call `availabilityFrom()`**.
Do not re-derive it.

`measuredHours === 0` means *no data*, and the API returns `null` so the dashboard shows `—`.
Never `0%` — that reads as "totally broken" when it means "we don't know".

## Ingestion ordering is load-bearing

- **One FIFO queue per site** (`enqueue()` in `master.js`). Messages from a single site are
  processed strictly serially. The async migration made handlers concurrent and immediately
  corrupted real data (duplicate `operating` segments, four simultaneously-open status segments,
  negative durations). Do not make ingestion concurrent per-site.
- **`applyStateChange` locks the row** (`SELECT id FROM sites WHERE id = ? FOR UPDATE`) and runs
  its backfill/no-change guards **inside** the transaction.
- **`last_seen` only moves forward** (`CASE WHEN` in `updateSiteStatus`). A late-arriving message
  used to drag it backwards.
- **Timestamps must be floored to whole seconds.** The agent contract is unix *seconds*. A
  millisecond-precision timestamp written by the server always looks "newer" than the agent's
  resync, the backfill guard rejects the resync, and the **site stays stuck in `no_comm` forever**
  after it has already recovered. This is exactly what happened.

## Disconnect detection: two LWT layers, no server-side timer

There is **no watchdog and no heartbeat** — one was written and deliberately removed. The "90
second rule" is **1.5 × the 60s MQTT keepalive**, enforced by the brokers, not by a `setInterval`.

1. **Agent → local Mosquitto** — LWT, JSON `{"timestamp":0,"state":"no_comm"}` on
   `sites/{code}/state`. Covers: *the agent process died, the PC is alive.*
2. **Mosquitto bridge → HiveMQ** — payload `"1"`/`"0"` on `sites/{code}/bridge`
   (`ingestion/bridge-handler.js`). Covers: **the whole PC died (power loss)** — Mosquitto dies
   with the agent, so nobody is left to publish layer 1. Only HiveMQ, which holds the bridge's
   will, can report it.

Layer 2 is the one that matters most in a real car park and it was the one missing: the bridge
config had `notifications_local_only true`, so the disconnect notice stayed on a powered-off PC
and the server showed the site as "ready" forever.

**`no_comm` never updates `last_seen`.** A disconnect is not a sighting.

## Auth is a shared secret, and it is enforced server-side

`requireAdmin` guards every write route (site registration, maintenance start/cancel). It checks
an `x-admin-code` header against a sha256 hash in the `settings` table, compared with
`timingSafeEqual`.

This is **not real authentication** — it is one shared code, and it is a placeholder until
Supabase Auth lands. But it is enforced **on the server**: hiding a button in the dashboard is
not security. If you add a write endpoint, it gets `requireAdmin`.

## Metrics also live in SQL now — and there is a parity gate

`db/functions.postgres.sql` is applied by `db.init()` on **every boot**, after the schema
and before `security.postgres.sql`. Every function is `CREATE OR REPLACE`, so re-running is
a no-op; rollback is "revert the file and restart". There is no migration framework and
none is needed — **the file is the target state.**

| Function | Ports |
|---|---|
| `public.site_uptime` | `getUptimeBreakdown` + `availabilityFrom` |
| `public.site_segments_collapsed` | `collapseNoCommFlicker` |
| `public.site_stats` | `statsFromData` |

**Four rules every function here follows. Breaking any of them is a bug:**

1. **Filter lexically on TEXT; cast only for arithmetic, only after filtering.** Dates are
   TEXT ISO-8601 (deliberate — see schema). `WHERE started_at < p_to` uses
   `idx_status_hist_site`; `WHERE started_at::timestamptz < …` casts the *column*, kills the
   index, and turns a range scan into a seq scan on the biggest table.
2. **Take a site-id array, return a row per site.** `NULL` means all sites — same convention
   as `loadRangeData`, and for the same reason: otherwise the caller must fetch ids first, a
   whole round trip in series. A per-site function called in a loop rebuilds the N+1 that was
   deleted from `queries.js`.
3. **`::double precision` on every returned number.** `ROUND(x,2)` returns NUMERIC and the
   `pg` driver returns NUMERIC **as a string**; the dashboard does arithmetic on these, so a
   string silently turns addition into concatenation.
4. **No `auth.*` inside a metric function.** `auth.uid()` exists only on Supabase. Scoping
   belongs to RLS at the table level, not to the computation.

**`npm run parity` is the adoption gate.** It compares JS against SQL on real data before a
port is trusted: 13 sites × week/month/year plus 29 seeded edge cases, currently 939
comparisons / 0 differences. It uses `db.js`'s own pool on purpose (so `keepAlive` matches by
construction, not by a copy that drifts), and it compares the *rounded, user-visible* value —
JS accumulates whole milliseconds while Postgres accumulates seconds as double, so bit
equality is the wrong bar.

Two things the harness taught us, both worth keeping in mind:

- **Production parity and seeded edge cases catch different bugs.** Removing the flicker
  fold's look-back was caught by both. Removing `ORDER BY` from its `LAG` window was caught
  by production only — all 7 edge cases passed, because each case has too few segments for
  arbitrary ordering to change the answer.
- **Mutate before you trust a pass.** Every port here was run against deliberately broken
  versions first. One of those mutations was itself partial (`false AND EXISTS` disabled only
  one of two branches) and the tests correctly passed — the bug was in the mutation.

## `events` is the event contract, not the transport

Every semantic event is written to `events` by `bus.publish()` — one place, not the eight
scattered `bus.emit` calls it replaced. Same payload the SSE stream sends.

- **Replay:** `GET /api/stream/since?after=<id>`. SSE alone cannot do this — a message sent
  to a disconnected tab is simply gone.
- **Two readers, one contract:** Supabase Realtime can subscribe to inserts here, and the
  existing SSE reads the same table. Switching is changing a reader, not a rewrite.
- **Order matters in `publish`:** emit first, persist second — SSE must not wait on an INSERT.
  ⚠️ Consequence: if the INSERT fails the event is broadcast but not recorded, leaving a hole
  in replay. Deliberate — an event is derived data, and failing an ingestion message over it
  would be worse. The audible alert derives from state diffing, not events, precisely so it
  survives such holes.
- `site_id` is `ON DELETE SET NULL` with `site_code` kept alongside: deleting a site *emits*
  an event, and a cascading FK would delete the announcement along with the site.
- Retention is 7 days, pruned by the daily job. Real history lives in `status_history` and
  `operations` and does not depend on this table.

## Identity is abstracted; nothing is enforced yet

`app.current_actor()` reads the `sub` claim from `request.jwt.claims`, falling back to the
`app.user_id` session GUC. Both are the same mechanism — Supabase's `auth.uid()` *is* a
`current_setting('request.jwt.claims')` read that PostgREST populates. Twenty lines of
indirection is what lets the same policy file run on plain Postgres.

**Never write `auth.uid()` in a policy or a function.** Go through the helper.

`app.current_role()` returns the *application* role (operator/supervisor/executive), read
from a `parkomat_role` claim — **not** `role`, which Supabase uses for the Postgres role.

RLS was **already enabled** on every table by Supabase (`rls_auto_enable`); what was missing
were policies, and a table with RLS and no policy returns zero rows. Policies now grant
`SELECT` to `authenticated`. The server is unaffected because `postgres` has
`rolbypassrls = true` — verify that before touching policies, or ingestion stops instantly.

**`settings` has no policy on purpose** — it holds the admin-code hash. If the dashboard ever
needs a value from it, expose that one key through a `STABLE` function; do not add a policy to
the table.

## Only company email addresses can be created

A `BEFORE INSERT` trigger on `auth.users` calls `app.enforce_email_domain()` and rejects any
address outside `app.allowed_email_domains()`. **Two domains are allowed on purpose** —
`parkomat.co.il` and `parkomat.com` are both in real use, and allowing only one would have
locked out the owner of the other. To change the list, edit the array in
`db/security.postgres.sql` and restart; the file is the target state.

It is a **database** trigger and not a check in `POST /api/users/invite`, because there are
three ways a user gets created and the invite route is only one of them. The one that matters:
**self-signup** — `disable_signup` is `false`, so `/auth/v1/signup` is open to anyone on the
internet and never touches our server. The Admin API is the third. (Google sign-in was a
fourth and has been removed from the product; the trigger would have covered it, and will
cover any external provider added later without anyone remembering to add a check.)

- **`SECURITY DEFINER` is load-bearing.** GoTrue connects as `supabase_auth_admin`, which has
  no `USAGE` on `app`. Without it the trigger body fails on permission denied for *every*
  insert — including allowed domains — surfacing only as `Database error creating new user`.
  Chosen over granting `supabase_auth_admin` access to `app` so no Supabase-specific role name
  is baked into our SQL. `search_path` is pinned, as it must be for any `SECURITY DEFINER`.
- **`BEFORE INSERT` only.** Existing users are never re-checked, so narrowing the list later
  cannot lock out somebody already in.
- **Portability:** the logic sits in `app` and travels in `pg_dump`; the trigger binds to
  `auth.users` and does not. Recreating one trigger is the migration cost — and it is a trigger
  rather than an FK because an FK into `auth.users` is forbidden (root `CLAUDE.md`, rule 1).
  Note `pg_dump` needs `--schema=public --schema=app`.
- ⚠️ **Test the allowed case, not just the blocked one.** The first version of this blocked
  everybody, and the gmail rejection still "passed" — from a permission error, not the rule.
  A negative-only test would have reported green.

`auth/provider.js` follows the `ai/provider.js` pattern: two providers, chosen by
`AUTH_PROVIDER`, uniform interface. **The seam is token verification, not sign-in** — under
Supabase, sign-in happens in the browser against GoTrue and the server never sees a password;
self-hosted it must be a server endpoint. That asymmetry is real, is tested, and is not to be
"fixed" by adding `signIn` to one provider only. 27 tests run every case against **both**
providers so the dormant path cannot rot.

## Do not reintroduce N+1

The executive/supervisor views once ran ~100 queries and took 3.5s. They now run a **fixed 9
queries** regardless of site count, via a batch layer in `queries.js`:

- `loadRangeData(siteIds, {from,to})` — 3 queries, loads ops/segments/windows into Maps.
  Still used by supervisor/executive/analytics; **no longer used by `GET /api/sites`**, which
  now computes in Postgres via `site_stats` / `site_uptime`.
- `getAllSitesGlobals(siteIds)` — 5 queries (`DISTINCT ON`, CTE).
- Then pure in-memory functions: `statsFromData`, `uptimeFromData`, `directionFromData`,
  `heatmapFromData`.

**A `for` loop with an `await db...` inside it is the bug.** If you need per-site numbers, load
once and compute from the Maps.

> ⚠️ Known limit: the in-memory pass is `O(sites × buckets × ops_per_site)`. Measured at 200
> sites × 365 days it blocks the event loop for ~26s. Node is single-threaded, so that stalls
> ingestion too. Fix before scaling past ~20 sites.

## Cache and CORS ordering

- **CORS must be the first `app.use`.** It used to sit after the cache and after the admin
  routes, so cache HITs and every admin response went out with **no CORS headers at all**.
- The cache (`api/cache.js`) is **opt-in per route** (`cache(ttl)`), never global. It is bounded
  (`MAX_ENTRIES = 200`, LRU), keyed off a **whitelist** of query params, caches only 200s, and
  **single-flights** identical concurrent requests (50 simultaneous → 1 query, 49 coalesced).
- Any `siteUpdate` on the bus clears it.

## `site_globals`, and what it taught about the gate

`public.site_globals` ports `getAllSitesGlobals` — the function that blocked the
dashboard from reading directly. Five queries become CTEs; `ids` is the driver so a
site with no history still gets a row, matching `at()` in the JS.

**The lesson here is about the harness, not the port.** Four mutations were run
against production data and only one was caught — not because the SQL was right,
but because the data has no such cases: every production site has had a fault, no
two operations share a timestamp, and no maintenance window has been cancelled.
Three checks were blind. Ten seeded scenarios were added; all four mutations fail
now.

Mutation A taught a second thing: *"a site that never failed"* did **not** catch
`LEFT JOIN` → `INNER`, and correctly so — it has status rows, so the faults CTE
returns a row (with a NULL fault) and the INNER finds it. The divergence only
appears with **no `status_history` at all** — a real case, operations arriving
before the first state message.

### Rounding ties are not differences

`readyHours` for site 3513 came out JS=130.51 vs SQL=130.52 while the raw value was
identical to ten decimals (`130.5150000000`). That is the `.005` boundary: in
`double` the number sits just under half, in `NUMERIC` exactly on it. Neither side
is wrong — Postgres is arguably more correct, and it is the side that survives the
migration.

So a **one-cent** difference is counted and printed separately but does not fail.
Anything larger still fails, and integers stay exact. A gate that goes red because
the data moved is a gate people learn to ignore.

## One connection, one query at a time

Inside `db.transaction()`, `executor()` returns a single client — so `Promise.all`
fires several queries down one connection. A Postgres connection has one protocol
channel; `pg` flags this ("client is already executing a query") and results can be
dropped or interleaved.

This is not theoretical: `getAllSitesGlobals` does exactly that with five queries.
On a REST route it runs on the pool and is fine; the moment it ran inside a
transaction it failed intermittently — which surfaced only when it entered the
parity gate.

`runOn()` now chains every query on a given client behind the previous one. **In
production this costs nothing** — queries inside a transaction are serial anyway —
and it removes the hazard from any future code that runs `Promise.all` in a
transaction. The pool path is untouched.

## Users are created by invitation only — enforced in the database

Two triggers on `auth.users`, at different stages, for a reason.

**Domain** — `enforce_user_creation`, BEFORE INSERT. The address must end in a domain from
`app.allowed_email_domains()`; today that is `parkomat.co.il` alone.

**Invite-only** — `enforce_invite_only`, `DEFERRABLE INITIALLY DEFERRED`. At commit time
`app_metadata` must carry `parkomat_role`. Only the Admin API can set it, so the rule is in
effect *"created by whoever holds the Secret key"*.

### Why the second is deferred, and why that is not a style choice

The first attempt checked `parkomat_role` in BEFORE INSERT. **It failed, and it was
measured**: at INSERT time both paths produce a byte-identical row —

```
{"provider": "email", "providers": ["email"]}
```

GoTrue inserts the row and writes `app_metadata` *afterwards*, so BEFORE INSERT cannot tell
self-signup from an Admin-API create — the requirement blocked the invite path too. A
deferred constraint trigger runs at commit, where the difference does exist.

Forgery was tested, not assumed: `app_metadata` in the signup body, `parkomat_role` via
`data`, via `options.data`, and `role`/`aud` overrides — all rejected. `app_metadata` is not
client-writable, the same property the role system already relies on.

- **Every user creation must set `parkomat_role`**, including future Admin API calls.
  Deliberate: without one, `app.current_role()` reads `anonymous`.
- A blocked self-signup sees GoTrue's generic *"Unexpected failure"* — deferred trigger
  errors are not surfaced. Acceptable: nobody should reach that path, and the invite path
  never does.
- `disable_signup` is still `false` in the project config. The database no longer cares, but
  flipping it in the Supabase dashboard would reject those requests one layer earlier.
