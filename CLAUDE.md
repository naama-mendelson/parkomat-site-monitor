# CLAUDE.md — Parkomat SiteMonitor (system-wide)

Guidance for Claude Code across the whole repo. Component-specific rules live in
[`master/CLAUDE.md`](master/CLAUDE.md) (server) and
[`Parkomat.Agent/CLAUDE.md`](Parkomat.Agent/CLAUDE.md) (site agent) — read those before
editing either component. Source comments are Hebrew; these instruction files are English.

## Architecture today

```
Agent (on site) → HiveMQ → Node server → Supabase (Postgres)
                              ↓                    ↑
                        SSE + assistant      dashboard reads directly
```

The site list is read straight from PostgREST; the server still computes every other read
(supervisor, executive, analytics, insights, activity log) and owns ingestion, SSE and the
AI assistant. **~8,700 lines** — the read endpoints are no longer on the hot path but are
deliberately kept as the way back (see *Phase E is cancelled*, below).

| Component | Role |
|---|---|
| `Parkomat.Agent/` | C# / .NET 10, runs on a PC at the site. Reads the PLC over Modbus-TCP, publishes to MQTT. |
| `master/` | Node/Express. MQTT ingestion, the AI assistant, SSE, and the read endpoints that have not moved. |
| `dashboard/` | React 19 / Vite. Reads sites from Supabase directly; everything else through `master`. One flag switches it all back. |

---

# DIRECTION — PARTLY BUILT

The goal: Supabase becomes the active provider and is used to the fullest, the dashboard
queries it directly, the server shrinks to what genuinely cannot move — and a self-hosted
escape path exists in the repo, written and tested but inactive.

**Status. The code is the authority — if it disagrees with anything below, the code wins.**

| Phase | State |
|---|---|
| A — metrics into SQL | **Built.** `db/functions.postgres.sql`: `site_uptime`, `site_segments_collapsed`, `site_stats`, `site_globals`. Verified by `tools/parity.js` (1,262 comparisons, 0 differences). |
| A' — first live adoption | **Built.** `getAllSitesWithMetrics` (`GET /api/sites`) computes in Postgres. 203ms → 109ms, 2,200 rows over the wire → 26. |
| B — `events` table | **Built.** One row per semantic event, `bus.publish`, replay via `GET /api/stream/since?after=<id>`, 7-day retention. |
| C — identity + RLS | **Built.** `app.current_actor()` / `app.current_role()`; RLS enabled on all 7 tables, read granted to `authenticated`, `settings` deliberately policy-less. Real users exist. `POST /api/users/invite` and `GET /api/users` are behind `requireAuth` — token only. Verified adversarially: anon reads return `401`, `settings` returns `403` even with a valid token, writes from the browser return `403`. |
| D — dashboard queries directly | **Built and live.** `getAllSitesGlobals` is now `site_globals` in SQL — that was the last blocker. `useSites` goes through `services/dataSource.js`; the site list is read straight from PostgREST. |
| D' — writes go directly too | **Built and live.** `db/writes.postgres.sql`: maintenance (`start`/`cancel`), sites (`register`/`update`/`delete`), users (`list`/`set_active`/`set_role`), plus `public.my_role()`. All reachable from the browser through PostgREST; the server is not involved. 59 live checks in `tools/check-writes.js`. **Invite and delete-user stay on the server** — they need the Secret key, which must never reach a browser. |
| E — delete the read API | **Deliberately not done — see below.** The *other* half of E, moving the daily job to `pg_cron`, **is done.** |
| F — dormant self-hosted auth | **Seam only.** Token verification is implemented and tested; there is no users table, no password hashing, no sign-in endpoint — deliberately. |

**What still runs the old way.** `supervisor`, `executive`, `analytics`, `insights` and the
activity log still load rows into memory and compute in JS (`loadRangeData` +
`statsFromData` / `uptimeFromData`). Those two functions **must not be deleted**: they are
still used by those paths *and* they are the reference side of the parity harness.

**Deliberately staying in JS:** `buildActivityLog` (207 lines, and it holds the read
layer's only real test coverage — 31 of 141 tests) and `computeInsights` (224 lines,
presentation thresholds rather than a metric definition).

## The two access decisions — settled

Both were product decisions, not code questions. They are now answered, and the answers are
recorded here because they are cheap to hold and expensive to re-derive:

1. **Every user sees every site.** No subsets, no user↔site association table. RLS is
   therefore `USING (true)` for `authenticated` — that is the exact expression of the rule,
   not a shortcut standing in for something finer.
2. **Everyone may put a site into maintenance.** No credential required. This is also the
   original design: the dashboard button was never role-gated, and the form has always
   required the user to type their name.

⚠️ **Registering, renaming and deleting a site are the exception — those are manager-only**
(`app.require_manager()`), and the difference is not inconsistency. `code` is the `{code}` in
the MQTT topic, so changing it redirects which site incoming messages belong to; deletion
removes history and cannot be undone. Attribution-after-the-fact is not enough for either.

So the rule is **attribution, not prevention** — and that is a deliberate trade, not an
oversight. Maintenance suppresses fault logging entirely and excludes the site from the
availability denominator, so anyone can silence any site for up to 30 days. What stands
between "someone silenced a site" and "we have no idea who" is:

- **A name is mandatory.** `400` without one. That is the one thing the endpoint does insist on.
- **`set_by_name` prefers verified identity.** A bearer token wins over the body; the typed
  name is used only when there is no token. Verified Hebrew names round-trip intact — tested.
- **An audit line per action**, on both start and cancel, recording name, IP, and a `trust`
  level: `token` / `admin-code` / `anonymous`. **Do not remove `trust`** — without it every
  name looks equally trustworthy, and an anonymous claim reads like a verified identity.

`identifyActor` (in `api/routes.js`) is therefore **not a gate** — it populates `req.actor`
and always calls `next()`. Two deliberate details: a token that is *sent and rejected* is
still a hard `401` (someone who sent a token meant to identify themselves, and silently
downgrading them to anonymous would hide a real auth failure); and making the route blocking
later is **one line** — uncomment the `return res.status(401)` at the end of the middleware.
Do that once users exist.

## How accounts work now

**Invitation only, and it is the database that enforces it.** Two triggers on `auth.users`:

- **Domain** — the address must be `@parkomat.co.il`. One domain exactly.
- **Invite-only** — a `DEFERRABLE INITIALLY DEFERRED` constraint trigger requires
  `parkomat_role` in `app_metadata` at commit. Only the Admin API can set it, so in effect
  only the holder of the Secret key can create a user.

It is enforced in SQL and **not** in server code, on purpose: `/auth/v1/signup` is open to
the internet and never touches our server, so a check in `auth/admin.js` would guard one of
three creation paths. The server only *relays* the database's reason (Postgres error `23514`)
so the inviter sees why, instead of a bare `502`.

Details, including why the invite rule had to be deferred, are in
[`master/CLAUDE.md`](master/CLAUDE.md).

**Google sign-in was built and then removed** at the product owner's request. Email and
password only.

## Phase E is cancelled, and that is a decision — not an omission

Deleting the 17 read endpoints was the plan. **It directly contradicts the exit
door.** Those endpoints *are* the way back: with them gone, leaving Supabase stops
being a config change and becomes a migration project.

So they stay. **The server shrinks by not being used, not by losing code.** The
switch is one variable:

```
dashboard/.env
VITE_SUPABASE_DIRECT=true    ← today: dashboard reads PostgREST directly
VITE_SUPABASE_DIRECT=false   ← everything routes back through the server
```

Both arms of `services/dataSource.js` return **the identical shape**, which is what
makes it a switch rather than a rewrite. Verified in the browser: 12 site cards,
character-for-character identical in both positions, each hitting only its own
data path.

Two consequences worth holding on to:

- **No automatic fallback.** It is tempting to make a failed direct read retry
  through the server. That is exactly how a broken RLS policy, an expired session,
  or an unapplied function becomes invisible. The switch is explicit.
- **A path that never runs rots.** Test both positions before a release — the same
  reasoning that keeps the dormant self-hosted auth covered by tests.

Full procedure, costs, and ordering: [`EXIT-PLAN.md`](EXIT-PLAN.md).

## Target architecture

```
Agent (on site) → HiveMQ → small server → Supabase ← dashboard queries directly
```

The server keeps only two jobs, both of which genuinely cannot move:

1. **MQTT ingestion** — needs a process that stays connected. The ack is held until the
   write commits; ordering is per-site FIFO; writes are transactional with `FOR UPDATE`.
   There is no serverless primitive for holding a persistent MQTT session.
2. **The AI assistant** — holds `GROQ_API_KEY`, which must never reach a browser.

~2,200 lines was the original target, reached by deleting the 17 read endpoints. **That
target is no longer the plan** — deleting them would close the exit door, so they stay and
the server stays around 8,700 lines. See *Phase E is cancelled* above; this is a trade that
was made deliberately, not a goal that was missed.

## What each part becomes

**Supabase.** Metric computation moves into SQL functions (availability, failure rate,
operations, flicker collapse, period boundaries, and the rest). The dashboard calls them
directly. RLS enforces access at the row level, since the client now connects to the
database. Supabase Auth replaces the shared admin code, and the operator / supervisor /
executive roles become real instead of a client-side `useState`.

**The server.** MQTT ingestion (dedup, plausibility, timestamps, transactions, FIFO) plus
the assistant. **The daily job is gone from it entirely** — `dailyMaintenance` was removed from
`master.js`; `pg_cron` 1.6.4 is installed and `db/cron.postgres.sql` schedules what survived.

Each of the four steps got its own verdict, and only two moved:

- **Backup — deleted, nothing to move.** ⚠️ This file used to claim it "writes a file to our own
  disk" and therefore could not move. **That was wrong**: `tools/backup-db.js` is a deliberate
  no-op that logs one line. The local backup was disabled during the Supabase migration —
  copying the SQLite file after the data left it would have produced *the illusion of a backup*,
  which is worse than none. Supabase backs the database up itself.
- **`events` prune (7 days) and cleanup (12 months) — moved.** ⚠️ Stopping the prune was never an
  option: `events` is the table Realtime subscribes to, and unpruned it grows forever.
- **Monthly summary — deleted, not moved, and that is a decision.** `monthly_summary` is read only
  by two dormant server routes the dashboard never calls, and it is documented as wrong
  (`report_monthly` was moved off it to live computation for exactly that reason). Measured why:
  it cuts months on the **local** clock while everything else uses UTC — July 801 vs 806. Porting
  a wrong computation into SQL would have set it in stone.

**What the move bought:** the old timer was `setTimeout(10s)` at boot then `setInterval(24h)`, so
the hour drifted with every restart, a server restarted more often than daily never reached the
24h timer at all, and a server that was **down** at the appointed hour simply skipped — on
2026-08-22 it was down 14.7 hours. `pg_cron` runs at a fixed hour inside Postgres regardless.

⚠️ **Schedules live in `db/cron.postgres.sql`, never in the Supabase UI** (rule 6). A schedule
that exists only in the dashboard does not travel in `pg_dump` and is not in git. Applying it is
wrapped in `try` on purpose: `pg_cron` may be absent on a fresh instance or on non-Supabase
Postgres, and maintenance that failed to schedule is a loss — ingestion that failed to start is
damage.

**The dashboard.** `fetch('/api/sites')` becomes a Supabase query through PostgREST.
Live updates come from a new `events` table: ingestion writes one row per semantic event,
the dashboard subscribes. This also buys replay after a disconnect — query events newer
than the last seen id — which SSE cannot do today.

## The exit door

Leaving Supabase must stay possible:

- **Data** — `pg_dump`, standard Postgres.
- **Computation** — SQL functions travel in the dump and run on any Postgres 15+.
- **Direct access** — PostgREST is standalone software and runs self-hosted too. *This is
  why PostgREST is the chosen access layer.*
- **Auth** — behind a provider seam (same pattern as [`master/ai/provider.js`](master/ai/provider.js)):
  a registry, an env var picks the active one, a uniform interface. Swapping means
  changing the implementation and re-enrolling users, which is accepted scope.

The self-hosted path is written and covered by tests that run, even while inactive —
untested dormant code rots silently and fails exactly when it is needed.

## Rules that keep the exit open

Violating any of these makes migration expensive or impossible. They cost almost nothing
to follow now.

1. **Never create a foreign key into `auth.users`.** This is the default pattern in every
   Supabase tutorial and it binds the user graph to their auth schema —
   `pg_dump --schema=public` will not carry it. Use `public.app_users` as the canonical
   user table, with at most a nullable `supabase_uid` column and **no FK**.
2. **No `auth.*` inside metric functions or policies.** Go through one helper
   (`app.current_actor()`) that reads JWT claims and falls back to a session GUC. Twenty
   lines of indirection; without it every policy is a rewrite at migration time.
3. **No business logic in Edge Functions.** Deno-specific and not portable.
4. **No Supabase Storage for anything durable.** No portable equivalent.
5. **Never import `supabase-js` inside a component.** All data access goes through
   `dashboard/src/services/` — that seam already exists, do not destroy it.
6. **Cron schedules live in SQL migration files**, not in the Supabase dashboard UI.
7. **Never put the `service_role` key in the browser.** It bypasses RLS, which both
   creates a security hole and hides policy bugs until migration.
8. **The `events` table is the event contract**, not the transport. Realtime and SSE are
   two readers of one table.

## Order of work

Six phases, ~20–28 days. Each is useful on its own; stopping after any of them leaves the
system better than before.

| Phase | Work |
|---|---|
| A | SQL migration — metrics into the database. Do one vertical slice end-to-end first. |
| B | `events` table (~1 day; improves the current system immediately). |
| C | RLS + Supabase Auth, with the `app.current_actor()` indirection from the start. |
| D | Dashboard queries directly, behind the existing `services/` seam. |
| E | ⚠️ **Split in half.** The daily job **has** moved to `pg_cron`. Deleting the read API is **cancelled** — it is the exit door. |
| F | Dormant self-hosted auth — **deliberately last**, after real users exist. |

Phase F is last on purpose. There are no users today (role is React state), so building a
second auth implementation now means designing it against a guess and locking that guess
in with tests.

## What does not change

- **The agent** — unchanged on site PCs.
- **HiveMQ** — unchanged.
- **Ingestion logic** — dedup key on `reported_at`, plausibility gating, clamp, LWT
  ordering, cycle-counter rules. None of it moves.
- **The numbers.** Every ported function must return results identical to the current JS
  on real data before it is adopted. Integers exactly; floats compared on the rounded,
  user-visible value. Verify against production-shaped data *and* seeded edge cases.

## Cost trigger worth knowing

At the current site count (12) the Supabase free tier is a non-issue: ~1 MB of application data, and a
12-month-retention steady state around 47–82 MB. At 200 sites the limit is reached in
6–12 months and the steady state is 560 MB – 1.1 GB. The crossover is roughly 60–80 sites.
`DELETE` does not return disk to the OS, so retention plateaus at the high-water mark
rather than sawtoothing down. If the exit is ever triggered, cost is the likely reason —
and unlike most migration triggers, this one is predictable well in advance.

## How the dashboard is reached — Cloudflare Tunnel, and why not a local CA

```
דפדפן/טלפון → Cloudflare (TLS) → cloudflared → Caddy → web | parkomat:4000
```

**No port is published to the office network.** `cloudflared` opens an *outbound* connection to
Cloudflare, so there is no inbound port, no port-forwarding, and nothing to scan. `8080` and
`4000` are bound to `127.0.0.1` only — reachable on the server itself for debugging, and from
nowhere else.

⚠️ **A local CA was built first and rejected, for two reasons that are worth keeping.** The
first version used Caddy's `tls internal`: a private CA whose root had to be installed on every
machine. It was turned down as impractical — and it was also *wrong*:

- **Phones.** Installing a root CA on iOS/Android is impractical across a company, and teaching
  people to accept certificate warnings is worse than no warning at all: a real attacker's
  forged certificate produces the identical warning.
- **The dashboard is a PWA** (`manifest.json`, `sw.js`, web push). Browsers refuse to register a
  service worker over plain `http://`, so **the app on a phone could not work at all** — and an
  untrusted certificate does not fix that. Only a real one does.

The domain is already on Cloudflare (`rafe`/`gabe.ns.cloudflare.com`), so this needed no DNS
migration and nothing installed on any device.

**One origin, so CORS does not exist.** `services/api.js` uses relative URLs when
`VITE_API_BASE` is empty, and Caddy routes `/api/*` and `/health` to the server and everything
else to the static dashboard. ⚠️ `VITE_API_BASE` **must stay empty** — it is baked in at build
time, and any explicit value makes the browser block the requests. The screen loads, the data
does not arrive, and there is no comprehensible error. `deploy.ps1` clears it for exactly this
reason.

⚠️ **`trust proxy` had to grow, and without it two things break silently.** The chain now ends
at Caddy, so `req.ip` became the proxy container's address — *the same address for every person
in the company*. That silently erases the IP half of attribution (see *attribution, not
prevention*), and both rate limiters, which key on IP, would let one person lock out everyone.
`clientIp()` prefers `CF-Connecting-IP` — Cloudflare sets it and strips any client-supplied
value — and `tests/client-ip.test.js` pins all of it, including that the helper must not call
itself: a blanket `req.ip` → `clientIp(req)` replacement once turned it into infinite recursion
that would have crashed the server on every request lacking the header.
