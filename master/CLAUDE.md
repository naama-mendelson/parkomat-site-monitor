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
`shared/executive.mjs`** — and every caller goes through it:

```
availability = (ready + operating) / (ready + operating + error)
```

**Two states are excluded from the measurement entirely** — neither numerator nor denominator:

- **Maintenance.** A deliberate shutdown must not look like a failure, and must not be rewarded
  as availability either.
- **`no_comm`.** ⚠️ **This changed, and it was a product decision, not a calculation fix.** It
  used to sit in the denominator, i.e. counted as the machine failing. But a disconnect means
  the agent, the PC, or the network is not reporting — **the barrier itself may be working fine
  and serving cars the whole time.** We do not know, and that is the point: *not knowing is not
  a failure.*

If you need availability anywhere new, **call `availabilityFrom()`**. Do not re-derive it.

**The cost of excluding `no_comm`, stated plainly:** it hides a real operational signal.
Measured — site 2439 goes from 72.8% to 99.3%, because it is disconnected roughly a quarter of
the time. The number no longer says that. **`UptimeBar` therefore shows a mandatory note when
`noCommHours > 0`**, naming the excluded hours and the hours actually measured. That note is not
decoration; it is the other half of this decision, and removing it deletes the information.

Side effect, and it is correct: a site disconnected for the *whole* period gets
`measuredHours = 0` → availability `null` → the dashboard shows `—`. Nothing was measured, and
`0%` would read as "totally broken".

⚠️ **`tests/availability.test.js` pins this definition in numbers.** It exists because the
`no_comm` change moved every screen in the system and **not one of the 196 tests failed** — the
parity gate passed too, and correctly so: it compares JS against SQL, and both sides changed
together. *A parity gate proves two implementations agree. It cannot prove the definition is
right.*

## A stuck machine still counts as available — and that is the product owner's call

`operating` has **no upper bound**. A frozen `operating` segment of 94 hours (site 2438,
20–27 July) reports **100.0% availability** on a week with 3 completed operations. The cause is
that the agent is edge-triggered — it reports only on MODE *change*, so a frozen register sends
nothing and the segment grows without limit. Measured across all data: **381 hours sit in
`operating` segments longer than 30 minutes, against 153 hours of real operations** — 71% of
what is counted as "operating".

⚠️ **This was built and then removed at the product owner's request.** A `stuck` split at 30
minutes was implemented in `uptimeFromData` and `site_uptime`, excluded from the measurement,
shown as its own bar segment and legend row, and covered by 9 unit tests plus 6 seeded parity
cases. It worked and the gates were green. It was removed because the product owner did not want
it on screen. **Do not re-add it without asking** — the numbers above are not a discovery, they
are a known and accepted state.

Two things worth keeping from that attempt, should it ever come back:

- The threshold to use is **30 minutes** — the value `dashboard/src/utils/stuck.js` already uses
  to flag the card on screen. Two different thresholds would call the same machine "stuck" on the
  card and "operating normally" in the metric, at the same moment.
- The cut must come from the segment's **full `started_at`**, never the clipped window start — and
  a mutation that got this wrong **passed 1,374 production comparisons**, because no production
  `operating` segment currently straddles a range start. Only seeded cases caught it.

**Both kinds of maintenance count**, and until recently only one did:

- `status = 'maintenance'` in `status_history` — what the PLC reported.
- A row in `maintenance_windows` — what someone pressed in the dashboard.

The second was invisible to `site_uptime` / `uptimeFromData`, and that was not neutral, it was
backwards. A fault during maintenance is dropped at ingestion (`state-handler`), so the `ready`
segment simply continues — **broken time was counted as available**. Measured: 24 hours with 12
under a manual window returned `maintenance_hours = 0` and 100%.

- **Overlapping windows are merged first.** An extension, or two people starting one, would
  otherwise be counted twice and produce more maintenance than the measured window contains.
- **`uptimeFromData` reads `data.windows` directly and is deliberately not defensive.** A caller
  that forgets to load windows should crash, not quietly return inflated availability.
- Production has **zero** manual windows, so the 1,297-comparison parity run says nothing about
  this rule — the five seeded scenarios are its only coverage. All three mutations (SQL stops
  excluding, JS stops excluding, merge disabled) are caught.

⚠️ **Still open, and it is a spec gap rather than a bug:** a fault suppressed during a window is
gone for good, and the agent is edge-triggered so it never resends. After the window expires the
site keeps showing its pre-maintenance status until the next MODE change or agent restart. The
documented decision ("maintenance suppresses fault logging entirely") implies this; whether a
suppressed fault should resurface at expiry is a product call that has not been made.

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

## Auth is a shared secret on the server routes — and the dashboard no longer uses them

`requireAdmin` guards every write route (site registration/update/delete, maintenance
start/cancel). It checks an `x-admin-code` header against a sha256 hash in the `settings`
table, compared with `timingSafeEqual`.

This is **not real authentication** — it is one shared code, its default value (`admin123`)
is in the open source, and it has never been rotated. It is enforced **on the server**, which
is the one thing it gets right: hiding a button in the dashboard is not security. If you add a
server write endpoint, it gets `requireAdmin`.

**The dashboard has moved off it.** All five write paths now go to Postgres directly (below),
and `useAdmin` gates the management screen on the **verified role** instead. The routes stay
because they are the exit door, so `requireAdmin` stays with them — `useAdmin` still uses the
code in the server arm of the switch, which is exactly where it is still the mechanism.

Two reasons the code was not kept "as well, for safety" in direct mode — it subtracts safety:

- **It locks out a real manager.** The default `admin123` is in the open source. The day it is
  rotated, every manager is shut out of a screen they are entitled to, and nobody will
  remember that the database stopped looking at that code.
- **It promises a permission it does not carry.** An operator who knows the code would enter
  the screen, press "delete site", and get a `403` from Postgres. Safe — but a screen that
  offers actions it cannot perform is the reliable way to make someone conclude the system is
  broken.

`tests/admin-gate.test.js` pins the wiring (3 tests, all three mutations caught). It is a
**structural** test, not a behavioural one — there is no DOM here, so it proves the wiring, not
the rendering.

## Writes live in SQL too — `db/writes.postgres.sql`

Applied by `db.init()` **after** `security.postgres.sql`; that order is load-bearing, because
the write functions call `app.actor_display_name()` / `app.current_app_role()` /
`app.is_manager()`, which are defined there. Reverse order fails on *"function does not
exist"*.

| Function | Who may call it |
|---|---|
| `public.start_maintenance(text,numeric,text)` | any **active** user |
| `public.cancel_maintenance(text)` | any **active** user |
| `public.register_site(text,text,text,text,boolean)` | **manager only** |
| `public.update_site(text,text,text,text,text)` | **manager only** |
| `public.delete_site(text)` | **manager only** |
| `public.list_users()` | **manager only** |
| `public.set_user_active(integer,boolean)` | **manager only** |
| `public.set_user_role(integer,text)` | **manager only** |
| `public.my_role()` | any authenticated user — returns **their own** role |

**RPC, not table policies + `GRANT`.** A policy answers *"may this row be written"*; it cannot
compute `expires_at`, enforce the 720-hour cap, write an audit line, or publish an event. And
with `GRANT UPDATE` the browser could set `set_by_name` to anything, which kills the whole
attribution model. RPC also stays portable — a plain Postgres function travels in `pg_dump`,
unlike an Edge Function (forbidden by root rule 3).

**`SECURITY DEFINER` means the check must be inside the body.** These functions bypass RLS by
construction; `app.actor_display_name()` returning NULL → `insufficient_privilege` is the only
thing standing between the public anon key and silencing every site. `check-writes.js` case 1
is that assertion, and if it ever fails, everything is open.

**Two rules that cost real debugging:**

1. **`RETURNS TABLE (id integer, …)` makes `id` a variable, so `WHERE id = v_id` is
   `column reference "id" is ambiguous` (42702) → PostgREST **400**.** Measured: every
   `update_site` call returned 400 while `register_site` (no `WHERE`) and `delete_site` (no
   `id` output parameter) worked — so it read as *"only the update is broken"* rather than as
   a naming error. Every `WHERE` in this file is therefore qualified `sites.id = v_id`.
2. **Raise `PT404` / `PT409`, never `no_data_found`.** PostgREST maps `PTxxx` to the HTTP code
   in the digits; `P0002` becomes **500**, i.e. "server fault" for a mistyped site code.

**Role comes from `app_users`, not from the token.** `app.is_manager()` → `current_app_role()`
→ table read. A demoted manager loses access immediately instead of when their hour-old JWT
expires. Cost: one query per call, which is why it is not read from the claim.

**What is lost in the move, stated plainly:** the client **IP**. The server recorded it from
`req.ip`; SQL has no access to PostgREST's client address. The identity is stronger than
before (verified token instead of a shared code) but where it came from is gone.

## User management: three of five operations moved, two cannot

This is the full answer to *"why isn't user management just in Supabase?"* — most of it now is.

| Operation | Where it runs | Why |
|---|---|---|
| list | **Postgres** (`list_users`) | reads `app_users`, joins `auth.users` for last sign-in |
| deactivate / restore | **Postgres** (`set_user_active`) | touches `app_users` only |
| change role | **Postgres** (`set_user_role`) | touches `app_users` only |
| **invite** | **server** | `POST /auth/v1/admin/users` needs the **Secret key** |
| **delete** | **server** | removing the GoTrue user needs the **Secret key** |

The Secret key bypasses RLS entirely, so it must never reach a browser (root rule 7). That is
the whole reason the last two stay. `UsersPanel` therefore imports three functions from
`services/dataSource` and two from `services/api` — half-and-half on purpose.

**What unblocked the role change** was `public.my_role()`. Before it, a role change had to
write **two** places — `app_users` *and* the token's `app_metadata` — because the dashboard read
the role from the claim, and the second write needs the Admin API. Once the dashboard reads
`my_role()`, `app_users` is the single side of truth. **Stated cost:** `app_metadata` in the
Supabase dashboard keeps the old role. It is not the authority, but anyone reading it there sees
something the system does not enforce. The server arm still syncs it.

`list_users` is the **only** place outside the `auth.users` triggers that touches Supabase's auth
schema, and the join is `LEFT` on purpose — a user with no auth row must still appear, since that
is exactly the anomalous row a manager needs to see. Migration cost is one `JOIN` line.

⚠️ **The "last active manager" guard cannot fire in the dangerous case, and that is worth
knowing before someone "fixes" it.** `require_manager()` demands the caller be an *active
manager*, so if only one active manager exists, they are the caller — and any target equal to
them is already refused by the "not yourself" check. The invariant *never zero managers* is
therefore held by the self-check; the count is defence in depth. It does fire in one state: an
**inactive** manager target while one active manager exists, where it blocks a harmless change
with a misleading message. **Both copies (JS `auth/deactivation.js` and SQL) agree, and it was
left alone** — loosening a lock-out guard is a product decision, not a port side effect.
`check-writes.js` proves the SQL branch blocks, by building the state inside a **rolled-back
transaction** (the `app.user_id` GUC injects identity without a token) and then asserting the
database was fully restored — the only safe way to test it against production.

⚠️ **`POST /api/sites` on the server has never worked.** `insertSite` in `queries.js` lists six
columns and supplies eight placeholders — measured against the database:
*"INSERT has more expressions than target columns"*. So every site registration through the
server returned 500, and it was never caught because **no gate registered a site**; the 12
existing sites were added with `tools/add-test-site.js`. `register_site` in SQL is now the
working path and `check-writes.js` covers it. **The server route is still broken** — it is the
exit door, and fixing it is a separate task, not a side effect of this one.

## Gates build their own user — they no longer borrow a human account

`npm run gates` runs all 13 and **all 13 run**, with no environment variables.

⚠️ **Three of them used to need `PARITY_EMAIL` / `PARITY_PASSWORD` — a real person's
address and password.** The account they used was deleted, and from that moment
`parity-insights`, `parity-executive` and `parity-shape` could not run at all. They did not
go red; they reported *"did not run"*, which is the honest answer and also the one people
scroll past. Three of thirteen were dark and the summary still said nothing had failed.

`tools/lib/gate-user.js` creates a throwaway manager through the Admin API, signs in, and
deletes **both sides** at the end. Points worth keeping:

- **It returns the password, not only the token.** `parity-shape` signs in through
  `supabase.auth.signInWithPassword` on the real client — the browser's own path, which is
  the whole point of that gate — and a raw token would not populate a session.
- **The role is written to `app_users` by hand.** `provision_app_user` runs AFTER INSERT,
  before GoTrue writes `app_metadata`, so the row lands as `operator`; `current_app_role()`
  reads the table, so without that line the "manager" is manager in name only.
- **Cleanup removes the auth user *and* the `app_users` row**, and runs on every exit path
  including failure. Deleting only the auth side manufactures exactly the orphan that
  `check-writes` now fails on — a gate that produces the fault it hunts is the worst kind.
- **`gates.js` no longer pre-skips.** The `needsAuth` short-circuit decided before the gate
  started, so it outranked the gate itself: even after they learned to self-provision,
  `gates.js` kept printing "did not run". A gate that can authenticate decides for itself
  and returns code 2 if it cannot.
- `PARITY_EMAIL` / `PARITY_PASSWORD` still win when set — signing in as a real account
  stays testable.

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
| `public.site_globals` | `getAllSitesGlobals` |

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
port is trusted: every registered site × week/month/year plus 43 seeded edge cases, currently 1,262
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

A `BEFORE INSERT` trigger on `auth.users` calls `app.enforce_user_creation()` and rejects any
address outside `app.allowed_email_domains()` — today **`parkomat.co.il` alone**. To change
the list, edit the array in `db/security.postgres.sql` and restart; the file is the target
state.

⚠️ **The domain is a necessary condition, not a sufficient one.** It used to be sufficient:
this same trigger injected `parkomat_role = 'operator'` into any row that arrived without
one, so anyone with a company address could self-register and land as an operator. That was
reversed — an operator now exists only because a manager added them — and the injection is
gone. See *Users are created by invitation only* below; the two rules are one mechanism and
reading either alone gives the wrong answer.

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

## Every user action writes an audit line — and until recently none did

⚠️ **Measured: `audit_log` held zero `user.%` rows.** Invite, deactivate/role and delete all
wrote `console.log` and nothing else — a log that dies with the container. A user was
deleted in production and *"who deleted them, and when"* had no answer anywhere. Deletion is
the one irreversible operation here and it was also the only one with no durable record.

`recordAudit()` in `queries.js` now writes one row per action. Why not the SQL helper
`app.record_write_audit`: it derives the actor from `app.current_actor()`, a JWT claim the
server does not have (it connects as `postgres`), it pins `trust = 'token'`, and it has no
access to the client **IP** — which the server does have and records.

- **Action names match the SQL side exactly** (`user.enable` / `user.disable` / `user.role`).
  Both arms write to the same table, and the same action under two names cannot be filtered,
  i.e. *"who was deactivated this month"* becomes unanswerable.
- **The temp password never enters `details`.** `audit_log` is readable by every active user.
- **Writing the row never fails the action.** A missing audit line loses information; an
  action that fails *because of* its audit line loses the action — and the user would be told
  "delete failed" about a delete that already happened in Supabase.
- **The line is written after the delete, not before**, or it would attest to something that
  did not happen.

### Deleting a user in the Supabase dashboard leaves an orphan

The dashboard removes the GoTrue user and knows nothing about `app_users`, so the row stays —
active, listed, and unable to ever sign in. Two such rows were found in production. The
route's "Supabase first, our table second" order produces the same shape when the second half
fails, which is the lesser evil but still not *detected*.

`check-writes.js` now fails when any active `app_users` row has a `supabase_uid` with no auth
account. Rows with a NULL `supabase_uid` are not orphans — those were seeded by hand and
never linked.

⚠️ The check was first added *after* the results table was printed, so it listed the two
orphans and the gate still reported ✅. Position in the file was the whole bug.

## Removing a user: deactivate *and* delete — two different operations

Both exist, and keeping them distinct is the point.

- **`PATCH /api/users/:id { is_active: false }`** — reversible. Access is cut, the row
  stays, and any manager can restore it.
- **`DELETE /api/users/:id`** — irreversible. Removes the `app_users` row **and** the
  Supabase auth user. Coming back means a fresh invitation with a new id.

⚠️ **Deletion used to be forbidden, and the reason turned out to be wrong.** The rule was
"a user has traces in the audit log and in every maintenance window they opened; deleting
them would leave history pointing nowhere." But no historical row *points* at a user —
`audit_log.actor_name` and `maintenance_windows.set_by_name` are **text snapshots with no
FK**, deliberately. An audit line still says who did what after the user is gone.

What *did* point were the two FKs inside `app_users` itself (`created_by`, `disabled_by`).
They now carry **`ON DELETE SET NULL`**, added as idempotent DDL in `schema.postgres.sql`.

- **`SET NULL`, never `CASCADE`.** These are self-referencing FKs — `CASCADE` would delete
  everyone the deleted user ever invited, so removing one manager could wipe half the table.
- **Without the clause, deletion fails on exactly the wrong people.** The default is
  `NO ACTION`, so anyone who had ever invited or deactivated someone could not be deleted —
  i.e. the long-serving accounts, which are precisely the ones anyone wants to remove.
  Verified by mutation: dropping the clause turns the delete into a `500` and leaves an
  orphan pointer.
- **Order in the route: Supabase first, our table second.** The reverse leaves, on failure,
  a user who can still sign in with no `app_users` row — authenticated, with no identity,
  and `provision_app_user` will never rebuild it because there is no new INSERT. This order
  is pinned by a test, not just a comment.
- **The same two locks as deactivation apply, and matter more here** (`canDelete` in
  `auth/deactivation.js`): nobody deletes themselves, and the last *active* manager cannot
  be deleted. A manager who deactivates themselves can be restored by another; one who
  deletes themselves with no other manager leaves no route back from the UI at all.

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

⚠️ **And deferring alone is not enough — the trigger must `SELECT` the row, not read `NEW`.**
`NEW` in a deferred trigger is a snapshot taken *at the INSERT*; Postgres does not re-read it
at commit. So the version that deferred correctly and still checked `NEW` saw the same empty
`app_metadata` as BEFORE INSERT and **blocked the invite path exactly as before** — the Admin
API returned `500` with our own message. The working body is:

```sql
SELECT raw_app_meta_data ->> 'parkomat_role' INTO v_role
  FROM auth.users WHERE id = NEW.id;
```

This is the whole reason `check-signup.js` case 1 writes the role in an `UPDATE` *after* the
`INSERT` instead of inline. A gate that inserts the role directly passes against both the
correct and the broken trigger, and the break only shows up in production.

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

## One instance only — this is a correctness rule

`mqtt/subscriber.js` uses a **fixed** `clientId`, which is what lets HiveMQ hold the queue
while the server is down. But MQTT requires client ids to be unique, so **two server
processes disconnect each other in an endless loop** and neither processes anything. The
log shows `connected → connection closed → reconnecting` forever.

Observed in production, and the symptom is misleading: it looks exactly like "the new
server does not work" when the real problem is that the old one is still alive. This is
also why `docker-compose.yml` forbids `replicas` / `scale`.

**It is now enforced, not just documented** (`db/single-instance.js`). A second process
refuses to start, names the holder and its start time, and exits **before the MQTT
subscriber connects** — so the reconnect loop never begins.

- **A Postgres session advisory lock, not a lock file or a port bind.** Those catch only
  a duplicate on the *same machine*. The real hazard crosses machines: the office server
  in Docker and a manual run on a workstation talk to the **same** database and the same
  HiveMQ, and neither can see the other. The database is where they actually meet.
- **Released automatically when the session ends** — including `kill -9`. There is no
  stale lock to clear by hand, which is what makes a lock file a nuisance after a crash.
- ⚠️ **It catches the worse case too.** Two processes with *different* `MASTER_CLIENT_ID`
  do not fight over MQTT at all — both ingest, both write, and the data corrupts silently
  with nothing in the log. The lock does not depend on MQTT, so it still refuses.
- **Session connection (5432), never the transaction pooler.** A session-level advisory
  lock lives as long as the session; through the pooler each query may land on a different
  backend, so the lock would be taken and dropped instantly — passing always, protecting
  nothing. Same reason the schema runs on 5432.
- **Connecting retries; the lock itself does not.** Measured: the session pooler resets
  connections on its own (attempt 1 `ECONNRESET`, attempt 2 fine). Without the retry the
  guard would refuse to boot on a random network blip — the protection becoming the
  outage. But `pg_try_advisory_lock` returning `false` is the *correct answer*, not a
  transient fault, so retrying it would turn "another server is running" into a blind wait.

Nothing on the server side starts the process — that is deployment's job
(`restart: unless-stopped` in `docker-compose.yml`). When it is not running, **no
messages are lost**: HiveMQ keeps them (`clean:false` + fixed clientId) and delivers them
all with their original timestamps on the next start. Measured: 15 hours down, 240
messages, zero lost. What *is* lost is knowing — the dashboard showed 15-hour-old state
with no indication anything was wrong.
