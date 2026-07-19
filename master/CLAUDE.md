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

## Do not reintroduce N+1

The executive/supervisor views once ran ~100 queries and took 3.5s. They now run a **fixed 9
queries** regardless of site count, via a batch layer in `queries.js`:

- `loadRangeData(siteIds, {from,to})` — 3 queries, loads ops/segments/windows into Maps.
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
