# CLAUDE.md — Parkomat SiteMonitor (system-wide)

Guidance for Claude Code across the whole repo. Component-specific rules live in
[`master/CLAUDE.md`](master/CLAUDE.md) (server) and
[`Parkomat.Agent/CLAUDE.md`](Parkomat.Agent/CLAUDE.md) (site agent) — read those before
editing either component. Source comments are Hebrew; these instruction files are English.

## Architecture today

```
Agent (on site) ──→ HiveMQ ──→ Node server ──→ Supabase (Postgres)
       ╎                            ↓                  ↑
       ╎                      SSE + assistant    dashboard reads directly
       ╎
       ╌╌╌╌╌ (HTTPS, direct) ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌→   ⚠️ built · OFF at every site
```

⚠️ **`master` now serves exactly two routes** — `POST /api/chat` (the assistant) and
`GET /health`. The 29 read endpoints were deleted, not merely bypassed. That was a deliberate
call and it **closed the exit door**: `VITE_SUPABASE_DIRECT=false` is no longer a switch, so
leaving Supabase became a project rather than a config change. (The paragraph below about the
read endpoints being "kept as the way back" describes the state *before* that decision; it is
left in place because the reasoning it records is still what a reader needs in order to judge
the trade.)

The dashboard reads Supabase directly for everything. The server owns ingestion, SSE and the
AI assistant.

| Component | Role |
|---|---|
| `Parkomat.Agent/` | C# / .NET 10, on a PC at the site. Reads the PLC over Modbus-TCP, publishes to MQTT — and, **when configured**, writes to Supabase directly as well. v1.0.22. |
| `master/` | Node/Express. MQTT ingestion + the AI assistant. Two routes. |
| `dashboard/` | React 19 / Vite. Reads Supabase directly. |

⚠️ **The dotted line is real code with 32 gates behind it, and it is off at all 16 sites.**
`SupabaseConfig.Enabled` is *derived*, never stored, so "on but incomplete" cannot be
expressed. Turning one site on is `tools/provision-agent-user.js <code>` plus **one field** —
the password — in that site's settings form; turning it off is clearing it.

⚠️ **It used to be four fields, and three of them were noise.** The project URL and the
publishable key are identical at all 16 sites (and the key is not a secret — it ships to every
browser that opens the dashboard), and the user name is derivable from the site code the agent
already holds: `site-{code}@parkomat.co.il`, the same string `provision-agent-user.js` writes.
Three fields whose answer is known in advance are not flexibility; they are three chances to
mistype something that surfaces only when somebody notices a site stopped reporting. They live
in `SupabaseDefaults` now, and the config fields survive as **overrides** — empty means default
— because a burned-in address is exactly what would otherwise turn leaving Supabase into a
16-machine reinstall. The overrides are not in the form: they are carried through `OnSave`
untouched, since a form that rebuilds the config would otherwise erase them on every save.

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
| C — identity + RLS | **Built.** `app.current_actor()` / `app.current_role()`; RLS enabled on all 7 tables, read granted to `authenticated`, `settings` deliberately policy-less. Real users exist. ⚠️ **Both user routes have since left the server** — invite is the `invite-user` Edge Function, the rest are RPC; `api/routes.js` now serves `/api/chat` and `/health` and nothing else. Verified adversarially: anon reads return `401`, `settings` returns `403` even with a valid token, writes from the browser return `403`. |
| D — dashboard queries directly | **Built and live.** `getAllSitesGlobals` is now `site_globals` in SQL — that was the last blocker. `useSites` goes through `services/dataSource.js`; the site list is read straight from PostgREST. |
| D' — writes go directly too | **Built and live.** `db/writes.postgres.sql`: maintenance (`start`/`cancel`), sites (`register`/`update`/`delete`), users (`list`/`set_active`/`set_role`), plus `public.my_role()`. All reachable from the browser through PostgREST; the server is not involved. 59 live checks in `tools/check-writes.js`. **Invite and delete-user stay on the server** — they need the Secret key, which must never reach a browser. |
| E — delete the read API | **Deliberately not done — see below.** The *other* half of E, moving the daily job to `pg_cron`, **is done.** |
| F — dormant self-hosted auth | **Seam only.** Token verification is implemented and tested; there is no users table, no password hashing, no sign-in endpoint — deliberately. |
| G — the agent writes directly | **Built, proven end to end, and OFF.** Added after the six phases above; see below. |

### G — the agent writes directly (02/09/2026)

Not in the original plan. It came from one question — *"can the agent write straight to
Supabase?"* — whose real motive was **retiring DELL008**, the office PC whose power loss on
27/08 took the system down for 2.5 days.

| Piece | State |
|---|---|
| Per-site identity | **Live.** `role = 'agent'` + `site_id` on `app_users`; a partial unique index makes two active agents for one site impossible. Replaces one shared MQTT password used by all 16 sites, extractable from any installer with `strings`. |

⚠️ **Per-site was questioned and then reaffirmed by the product owner, and the reasoning is
worth keeping** — because the objection was a good one and the answer is not "security wins".

The objection: today a technician types **nothing**. `MqttConfig.Username` is `"agent"` and the
password is burned into the build from a git-ignored file, so an install is zero steps, sixteen
times over. Per-site identity replaces that with a paste per site. That is a real regression in
effort, and it was raised as one.

Three things were established along the way, and only the third settled it:

- **A leaked agent credential cannot touch a barrier.** Not the PLC, not a gate, not a car. It
  reaches **data only**. Overstating this is how a security argument loses credibility.
- **A shared account cannot work as built, and that is mechanical rather than a policy.**
  `app.agent_site_id()` reads `site_id` off the account row, so one account carries one site:
  a shared one would funnel all 16 sites into whichever site it points at, or — with a NULL
  `site_id` — reject every write everywhere. Supporting it means the agent *declares* its own
  site code and the server trusts it, which is exactly the property `ingest_batch` was built
  without.
- **What a shared credential would then allow:** writing false data as *any* site — inflating
  the cycle counter irreversibly, reporting `ready` over a real fault, or beating for a car park
  that is dead. And **no way to tell which site a bad write came from**, which is the part that
  cannot be recovered after the fact.

⚠️ **A middle option was offered and declined, and it was not a bad one:** one account per site
with a *shared, burned-in* password. Zero technician effort, no code change, and the isolation
becomes real later by rotating a single site's password. It is exactly as strong as MQTT today
— no regression, no improvement. It was declined in favour of real per-site passwords.

**So the effort objection is answered with tooling, not with a weaker design.**
`tools/provision-agent-user.js --all` provisions the whole fleet in one command and writes
`agent-passwords-<stamp>.txt` (git-ignored). Two properties are load-bearing: it writes **one
line per site as it goes**, so a failure at site 9 cannot take the eight already-issued
passwords with it — they are unrecoverable — and an already-provisioned site is a **skip**, not
a failure, so re-running against a partly-provisioned fleet finishes the rest.

⚠️ **The remaining ongoing cost is real and unsolved:** every *new* site needs its account
created. The fix is to make site registration create it — `register_site` is an RPC and account
creation needs the Secret key, so it would go through an Edge Function, for which `invite-user`
is the precedent. Until that exists, adding a site means remembering one command, and forgetting
it produces a site that looks installed and silently never reports.
| Ingestion in SQL | **Live, unused.** Five functions, 1,098 comparisons against the existing path. |
| The public door | **Live, unused.** `public.ingest_batch` takes **no site id** — it derives it from the identity, so an agent cannot write to another site by changing a number. |
| Durable queue in the agent | **Shipped in 1.0.22.** |
| The agent speaks HTTPS | **Shipped in 1.0.22, disabled.** ⚠️ And **only** HTTPS since — `SupabaseConfig.Enabled` requires an absolute `https` URL, because the first request carries the site's **password in the body** and every batch after it carries the token in a header. There was no validation before: a technician who typed `http://` got a working agent, which is exactly what makes that failure invisible. |
| Heartbeat + silence scan | **Built.** See below. |

### Disconnect detection — decided, and it is a heartbeat

⚠️ **This was the blocker on switching HiveMQ off, and it is now settled.** The record of
*why* is worth keeping, because the reasoning is not obvious.

**Silence cannot be the signal, and that is measured.** The agent is edge-triggered, so a
quiet site is normal: per-site gaps between messages reach **61–68 hours** routinely. A
threshold long enough to avoid noise is *longer than the outages we are trying to catch* —
the DELL008 blackout was 59.5 hours. This is not a tuning problem.

**So detecting absence needs either a held connection or a periodic beat. There is no third
mechanism** — and MQTT's will is already the second one: `keepalive_interval 60` means each
of the 16 sites sends a PINGREQ every minute (**25,920 a day, today**), and the "90 second
rule" is 1.5 × that. Moving to HTTPS does not introduce polling; it moves the clock from
HiveMQ into `pg_cron`.

⚠️ **And removing the server removes the will even if HiveMQ keeps running** — the bridge
still publishes it, but `master` is what subscribes and turns it into `no_comm`. Nothing in
Supabase speaks MQTT.

How it works, and why each piece is where it is:

- **The beat is `ingest_batch` with an empty array.** No new endpoint and no new grants — it
  already derives the site from the identity.
- **It lands in `public.alive`: one table for all sites, one row per site, upserted.** ⚠️ The
  first version was a column on `sites`, and that was wrong for a reason that only shows up
  under load: `applyStateChange` holds `SELECT … FOR UPDATE` on the site row for the length of
  the ingestion transaction, so a beat writing the same row **contends with ingestion itself**
  — and the faster the beat, the more often. A separate table decouples them, which is what
  makes a 60-second beat affordable at all. A table *per site* was considered and rejected:
  it means DDL inside site registration, and turns *"who is silent?"* from one scan into one
  query per site.
- **It never grows.** `ON CONFLICT DO UPDATE` overwrites, so 18 rows stay 18 forever — no
  prune job, unlike `events`.
- **Every call writes it, before the messages are processed.** A batch that fails on a
  malformed message still proves the agent is alive and the network works; recording after
  processing would turn a data fault into "the site is dead" and send someone to drive to a
  car park over a bad field.
- **60 seconds — the same cadence the system already runs.** MQTT's `keepalive_interval` is
  60 and the "90 second rule" is 1.5 × it, so each site already beats once a minute today.
  Moving to HTTPS **does not add polling**; it moves the clock from HiveMQ into `pg_cron`.
  Cost: 18 × 1,440 = **25,920 requests/day, ~0.9 GB/month**, ~18% of the free egress tier.
  ⚠️ Two seconds was requested and is **not** what was built: 777,600 requests/day and
  ~26.7 GB/month, 5.3 × the entire free tier — and it buys nothing, because detection latency
  is set by the *scan*, not the beat.
- **`app.mark_silent_agents(3)` has its own `pg_cron` job, every minute.** ⚠️ It used to be a
  fourth section inside `check_ingestion_health`; it was pulled out because the two measure on
  different clocks — ingestion health is a **hours** question, agent silence is a **minutes**
  one, and one job runs at the faster of the two. It runs *inside Postgres*, so it survives the
  fall of `master` — precisely why the other sections of that job caught none of the three
  blackouts.
- ⚠️ **Only sites with an agent identity are expected to beat.** A site still on MQTT alone has
  no `alive` row, and a naive scan would mark all 16 dead the moment it is switched on. The
  marker is a `role='agent'` row in `app_users` — the list maintains itself. The join is
  `LEFT … WHERE seen_at IS NOT NULL` rather than a plain `JOIN`: both filter it out today, but
  the day someone seeds a default row at registration, `JOIN` would light every new site red.
- **Marking goes through `app.ingest_state`, never a direct `UPDATE`.** That is where segment
  closing lives, where the rule that `no_comm` does not touch `last_seen` lives, and where the
  event is published. A direct update would move the chip on screen and leave history without
  the segment — availability that does not know the site was offline.
- **`agent_version` rides along on the beat.** It closes a documented gap — *"no version is
  reported on any topic; there is no way to know remotely which agent is where"* — for the
  price of one column, since the request goes out every minute anyway. `COALESCE` keeps the
  last reported value when a beat omits it, so the column does not empty itself during an
  upgrade, which is the one moment anyone reads it.

**The cost, stated plainly:** detection moves from ~90 seconds to **3–4 minutes** (60-second
beat, 3-minute threshold = three missed beats, 1-minute scan). ⚠️ But the comparison misleads:
in the three real blackouts, detection actually took **days**, because the alert never fired
at all.

⚠️ **And the first implementation of the beat never sent a single request.** `SupabaseWriter.
SendAsync` returns `Success(0)` on an empty list *before* touching the network, so the beat
"succeeded", the agent's timer advanced, and nothing left the wire. Three structural tests
passed, because all three read `Worker.cs` rather than counting HTTP requests. `BeatAsync` is
now the only door that sends an empty batch, and `SupabaseWriterTests` counts requests.

⚠️ **And the beat only covers sites where the direct path is on — zero today.** While MQTT
runs, its will still gives 90 seconds for free. The heartbeat does not replace it; it is what
makes turning it off possible.

⚠️ **And retiring DELL008 needs more than this anyway** — the assistant still holds
`GROQ_API_KEY` and the backup daemon still runs there. Two Edge Functions already exist
(`invite-user`, `notify-fault`), so the precedent for moving them is established; the second
one records the reason plainly: *"master falls, and that is exactly when the alert is needed."*

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

⚠️ **Three of the four entries below said "unchanged" and are now out of date.** They are
kept, struck through in prose rather than deleted, because *what* changed and *why* is the
useful part — a list that quietly rewrites itself teaches nothing.

- ~~**The agent** — unchanged on site PCs.~~ **It changed** (01–02/09/2026, v1.0.22). Two
  fixes and one dormant path: `cleansession false` in the bridge (measured: **0 of 5**
  messages survived an internet outage before, 5 of 5 after), a **disk-backed** send queue
  that survives a power cut, and direct-write to Supabase that **ships disabled**. See
  `Parkomat.Agent/CLAUDE.md`.
- ~~**HiveMQ** — unchanged.~~ **Still the only live path**, and still authoritative — but no
  longer the only one that exists. The direct path runs beside it when a site is configured;
  MQTT stays the source of truth while both run.
- ~~**Ingestion logic** — none of it moves.~~ **Most of it moved**, and it is the one part of
  this project that writes customer data, so nothing was adopted on argument:
  `db/ingest.postgres.sql` holds `decide_cycle_update`, `classify_timestamp`,
  `ingest_operation`, `ingest_state` and the public door `ingest_batch`, proven against the
  existing path by **1,098 comparisons** across four gates.
  ⚠️ **Four modules deliberately did *not* move**, and that is a conclusion rather than a gap:
  `replay-window` and `clamp-memo` exist only to compensate for MQTT delivering one message
  at a time — an agent that sends a batch makes the problem *not exist* rather than solving
  it; `bridge-handler` belongs to the disconnect-detection decision that is still open;
  `fault-text` moves to the agent, before the network. The reasoning is recorded at the foot
  of `db/ingest.postgres.sql`.
- **The numbers.** ✅ Unchanged, and it is the rule that made the rest safe. Every ported
  function must return results identical to the current JS on real data before it is adopted.
  Integers exactly; floats compared on the rounded, user-visible value. Verify against
  production-shaped data *and* seeded edge cases.

⚠️ **And the sharpest lesson of that port was about the harness, not the code.** Of 19
mutations run, **six exposed blindness in a gate that had just been written** — not a bug in
the thing under test. Twice the scenarios only covered the ordinary path (no message ever
arrived late; no `no_comm` was ever sent), and twice an assertion passed for a reason other
than the one intended. *A gate that has never been mutated is a gate whose coverage is
unknown.*

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

## ⚠️ יש **שתי** פריסות של הדשבורד, ורק אחת היא זו שמשתמשים בה

זה לא היה כתוב בשום מקום, ובגלל זה נשרפו שלוש פריסות ביום אחד: הקוד
נדחף, `deploy.ps1` רץ על השרת, והמסך בדפדפן נשאר זהה — כי הוא בכלל לא
מגיע משם.

| | מאיפה מוגש | מתעדכן | מי משתמש |
|---|---|---|---|
| **Cloudflare Pages** ⭐ | `parkomat-site-monitor.pages.dev` | **אוטומטית מכל `git push` ל-main** | ⭐ **זה מה שפותחים** |
| **DELL008 / Docker** | `parkomat-web` דרך Caddy, פורט 8080 | רק ב-`deploy.ps1` ידני | דיבאג מקומי בלבד |

**המסקנה המעשית:**

- **שינוי בדשבורד** → `git push`, וזהו. Pages בונה תוך 1–2 דקות.
  ⚠️ **`deploy.ps1` אינו נחוץ בשבילו.**
- **שינוי ב-master** (קליטת MQTT, הבוט) → `deploy.ps1` על DELL008. **רק
  זה** דורש פריסה ידנית.
- **שינוי ב-SQL** → מוחל בעליית `master`, כלומר גם הוא דרך `deploy.ps1`.
  ⚠️ יוצא מן הכלל: פונקציות שהוחלו ידנית ממחשב הפיתוח כבר חיות מיד.

⚠️ **והדרך היחידה לדעת איזה קוד הדפדפן מריץ היא שם ה-bundle.**
לשונית Network, סינון `index-`. אם השם לא השתנה — הקוד לא השתנה, ולא
משנה כמה פריסות רצו. `Ctrl+F5` לבדו אינו מספיק; צריך
**Application → Clear site data**.

⚠️ **חשבון ה-Cloudflare אינו זה שהדומיין יושב בו.** הפרויקט חי תחת
`naamam@parkomat.co.il`, ולא תחת החשבון שמנהל את `parkomat.co.il`.
`Workers & Pages` בחשבון הלא נכון מציג "No projects found" — מה שנראה
בדיוק כמו "הפרויקט אינו קיים".

### המנהרה — קיימת בקוד, כבויה בפועל

`docker-compose.yml` מגדיר `tunnel` תחת `profiles: ["tunnel"]`, כלומר
`docker compose up -d` רגיל **אינו** מרים אותה. ובנוסף אין
`CLOUDFLARE_TUNNEL_TOKEN` ב-`.env` של DELL008, ולכן היא לא תעלה גם עם
הפרופיל.

**המשמעות:** הדשבורד שמוגש מ-DELL008 נגיש **רק ברשת המשרד**. זו אינה
תקלה — זו הסיבה ש-Cloudflare Pages הוא המסלול האמיתי.

## Agent identity is created by the dashboard, not by a command anyone must remember

Registering a site now provisions its agent in the same action. `registerSiteDirect` calls
`register_site` (RPC) and then the **`provision-agent` Edge Function**, and the modal shows the
password once.

⚠️ **The command was the problem, not the effort.** `tools/provision-agent-user.js` works, but it
is something a person has to *remember* — and forgetting it produces a site that looks perfectly
installed, raises no error, writes no log line, and simply never reports. There is no screen on
which that failure is visible.

- **Edge Function, not RPC** — creating a user is `POST /auth/v1/admin/users`, which needs the
  Secret key. SQL cannot call it and the browser must never hold it (root rule 7). `invite-user`
  is the precedent, and this follows it line for line: role checked with `my_role()` **against
  the table**, not against the token, so a manager demoted five minutes ago cannot provision.
- ⚠️ **No dependency on `master`.** The function runs inside Supabase, so registering a site
  works with DELL008 switched off — which is the entire point of the move.
- **The site row is read as the *caller*, not as `service_role`.** `service_role` has no grant on
  `sites`, deliberately: the narrow grant list is the documentation of who writes where. A
  manager may already read sites, so no grant needed to be widened.
- ⚠️ **A failed provisioning does not fail the registration, and must not.** `register_site` has
  already committed; the site exists. Reporting "registration failed" would send the manager to
  try again and hit "code already exists". So the result carries `agentError` and the modal says
  plainly *the site was registered without an identity and cannot report until one is issued.*
- ⚠️ **The modal does not close by itself, and the password is not a `flash`.** Supabase stores
  only a hash, so the password is displayed exactly once — an auto-dismissing toast or a
  click-outside would destroy it and leave a site that cannot be connected. Closing is a
  deliberate act ("העתקתי — סגור").
- **The recovery path exists in the UI**, not only in a terminal: every row in `AdminPanel` has a
  *זהות סוכן* button. Without it the only way back from a failed provisioning is the command on
  DELL008 — precisely what this change exists to remove.
- **A site that already has an identity returns `409`, not a silent re-issue.** Rotating breaks a
  working site until its config is updated, so it has to be asked for explicitly.

`provisionAgent` in `dataSource.js` has **no server arm**, and that is not an omission: `master`
serves two routes and never knew how to create an agent identity, so there is nothing to fall
back to. In server mode it throws a message saying so.

⚠️ **Three copies of one convention.** `site-{code}@parkomat.co.il` is written in the Edge
Function, in `tools/provision-agent-user.js` (`emailFor`), and in the agent
(`SupabaseDefaults.EmailFor`). If one drifts, the agent signs in as a user that was never
created and gets `400` on every cycle. The agent side is pinned by a test; the other two are
not, and that is a known gap.

## ⚠️ First site live on the direct path — 2438 (מגדל 1), 03/09/2026

The dotted line in the architecture diagram is no longer dotted for one site.

```
אתר 2438 · פעימות עולות כל 60 שניות · גרסה 1.0.23
```

Measured within minutes of the install, and each line answers a question that had no answer
before:

- **It writes over HTTPS straight to Supabase**, with no hop through DELL008. If the office PC
  dies today, this is the one site of eighteen that keeps reporting.
- **The heartbeat beats.** `beats` increments on a steady 60-second cadence — the first proof
  that `BeatAsync` reaches the wire, after a first implementation that never sent a request.
- **`agent_version` reports `1.0.23`.** The documented gap — *"no version is reported on any
  topic; there is no way to know remotely which agent is where"* — is closed.

### ⚠️ And dual-path writing does **not** duplicate operations

The original plan warned in bold: *"do not write on both paths at once — it will double the
operations."* **Measured on the live site: zero duplicates.** What appears instead is one
`state_no_change` row in `ingest_drops` — the same message arrived twice (MQTT and direct),
and the no-change guard rejected the second. The protection holds in the field, so MQTT can
stay authoritative during the pilot instead of being switched off blind.

**Rollback is one field.** Clearing the password in the site's settings turns the direct path
off; `SupabaseConfig.Enabled` is derived, so there is no half-on state to clean up.

## ⚠️ The gates run against production, and it shows on the bill

Free-plan egress is 5 GB per cycle. Measured on 03/09/2026: **6.03 GB used, 1.03 GB over.**

The daily chart is not flat — it spikes on *development* days (~970 MB on 01/09, ~570 MB on
18/08). Eighteen edge-triggered sites do not produce that; **the gate suite does.** `parity`
alone pulls 2,400 comparisons across 18 sites × week/month/year, and the full suite was run
six times in one day.

⚠️ **A second symptom points the same way: `1,857 MAU` against 32 real users.** Every gate run
creates a throwaway auth user and deletes it — but deletion does not un-count it. Roughly
1,800 one-shot users in a cycle. Far from the 50,000 limit, and a clear fingerprint.

**The mechanism to fix it already exists and was never switched on:** `master/.env.test.example`
is a template for a **separate Supabase project** for tests, and `db/test-guard.js` enforces a
positive marker so destructive tools refuse to touch production. Only the template is in the
repo; no `.env.test` exists.

Until that is configured, the rule is behavioural: **do not re-run the full suite to confirm a
result you have already verified.** Run the one gate you changed. A full run that teaches
nothing still costs ~300 MB against a quota that is already exceeded.
