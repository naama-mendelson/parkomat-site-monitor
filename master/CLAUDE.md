# CLAUDE.md — SiteMonitor Master (server)

Guidance for Claude Code when working in the `master/` server. Source comments here are
in **Hebrew**; keep that style when editing.

## Overview
The Master is the Node.js server side of Parkomat/SiteMonitor. It ingests MQTT messages from
site Agents (`sites/{code}/state`, `sites/{code}/operation`), stores them in SQLite
(`sitemonitor.db`, via `better-sqlite3`, WAL mode), and serves the dashboard/API. Schema lives
in `db/schema.sql`; data-access lives in `db/queries.js`. `db/db.js` opens the DB, runs the
schema, and applies column migrations (`addMissingColumns`) for already-existing DBs.

- DB path override for tests: set `SITEMONITOR_DB` env var to point at a throwaway DB.

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
