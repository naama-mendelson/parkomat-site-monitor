# CLAUDE.md — Parkomat SiteMonitor (system-wide)

Guidance for Claude Code across the whole repo. Component-specific rules live in
[`master/CLAUDE.md`](master/CLAUDE.md) (server) and
[`Parkomat.Agent/CLAUDE.md`](Parkomat.Agent/CLAUDE.md) (site agent) — read those before
editing either component. Source comments are Hebrew; these instruction files are English.

## Architecture today

```
Agent (on site) → HiveMQ → Node server → Supabase (Postgres)
                              ↓
                     dashboard asks the server
```

The server does everything: ingests MQTT, writes, computes every metric, and serves the
dashboard. ~6,000 lines. The dashboard never touches the database.

| Component | Role |
|---|---|
| `Parkomat.Agent/` | C# / .NET 10, runs on a PC at the site. Reads the PLC over Modbus-TCP, publishes to MQTT. |
| `master/` | Node/Express. MQTT ingestion + all metric computation + REST/SSE for the dashboard. |
| `dashboard/` | React 19 / Vite. Talks only to `master`. |

---

# DIRECTION — PARTLY BUILT

The goal: Supabase becomes the active provider and is used to the fullest, the dashboard
queries it directly, the server shrinks to what genuinely cannot move — and a self-hosted
escape path exists in the repo, written and tested but inactive.

**Status. The code is the authority — if it disagrees with anything below, the code wins.**

| Phase | State |
|---|---|
| A — metrics into SQL | **Built.** `db/functions.postgres.sql`: `site_uptime`, `site_segments_collapsed`, `site_stats`. Verified by `tools/parity.js` (939 comparisons, 0 differences). |
| A' — first live adoption | **Built.** `getAllSitesWithMetrics` (`GET /api/sites`) computes in Postgres. 203ms → 109ms, 2,200 rows over the wire → 26. |
| B — `events` table | **Built.** One row per semantic event, `bus.publish`, replay via `GET /api/stream/since?after=<id>`, 7-day retention. |
| C — identity + RLS | **Partly.** `app.current_actor()` / `app.current_role()` exist; RLS policies grant read to `authenticated`; `auth/provider.js` has two tested providers. **Nothing is enforced yet** — no route requires a token. |
| D — dashboard queries directly | **Not built.** Blocked on product decisions, not code (see below). |
| E — delete the read API | **Not built.** |
| F — dormant self-hosted auth | **Seam only.** Token verification is implemented and tested; there is no users table, no password hashing, no sign-in endpoint — deliberately. |

**What still runs the old way.** `supervisor`, `executive`, `analytics`, `insights` and the
activity log still load rows into memory and compute in JS (`loadRangeData` +
`statsFromData` / `uptimeFromData`). Those two functions **must not be deleted**: they are
still used by those paths *and* they are the reference side of the parity harness.

**Deliberately staying in JS:** `buildActivityLog` (207 lines, and it holds the read
layer's only real test coverage — 31 of 141 tests) and `computeInsights` (224 lines,
presentation thresholds rather than a metric definition).

**What D is actually blocked on** — two product decisions, neither derivable from the code:
does an operator see all sites or a subset (that decides whether a user↔site table is
needed), and who may trigger maintenance. Until those are answered, RLS deliberately stays
at "authenticated may read everything" rather than encoding a guess and locking it in with
tests. There are **no users at all** today — the dashboard role is `useState("operator")`
in the browser.

## Target architecture

```
Agent (on site) → HiveMQ → small server → Supabase ← dashboard queries directly
```

The server keeps only two jobs, both of which genuinely cannot move:

1. **MQTT ingestion** — needs a process that stays connected. The ack is held until the
   write commits; ordering is per-site FIFO; writes are transactional with `FOR UPDATE`.
   There is no serverless primitive for holding a persistent MQTT session.
2. **The AI assistant** — holds `GROQ_API_KEY`, which must never reach a browser.

~2,200 lines. Everything else — 17 of 18 read endpoints — goes away.

## What each part becomes

**Supabase.** Metric computation moves into SQL functions (availability, failure rate,
operations, flicker collapse, period boundaries, and the rest). The dashboard calls them
directly. RLS enforces access at the row level, since the client now connects to the
database. Supabase Auth replaces the shared admin code, and the operator / supervisor /
executive roles become real instead of a client-side `useState`.

**The server.** MQTT ingestion (dedup, plausibility, timestamps, transactions, FIFO) plus
the assistant. The daily maintenance job can move to `pg_cron`, which is already running
on the instance and is a standard extension, not a Supabase invention.

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
| E | Delete the read API; move the daily job to `pg_cron`. |
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

At 13 sites the Supabase free tier is a non-issue: ~1 MB of application data, and a
12-month-retention steady state around 47–82 MB. At 200 sites the limit is reached in
6–12 months and the steady state is 560 MB – 1.1 GB. The crossover is roughly 60–80 sites.
`DELETE` does not return disk to the OS, so retention plateaus at the high-water mark
rather than sawtoothing down. If the exit is ever triggered, cost is the likely reason —
and unlike most migration triggers, this one is predictable well in advance.
