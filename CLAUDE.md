# CLAUDE.md — Parkomat SiteMonitor (system-wide)

Guidance for Claude Code across the whole repo. Component-specific rules live in
[`master/CLAUDE.md`](master/CLAUDE.md) (server) and
[`Parkomat.Agent/CLAUDE.md`](Parkomat.Agent/CLAUDE.md) (site agent) — read those before
editing either component. Source comments are Hebrew; these instruction files are English.

## ⚠️ Decision, 17/09/2026 — `master` is being retired. Target: Supabase + dashboard only

The product owner: *"I don't need the server. I want only Supabase and the dashboard."*
Do not build new work on `master`, and do not suggest moving something *into* it.

**Measured the same day — what still depended on it, and the state of each:**

| Dependency | State |
|---|---|
| **The AI assistant** | **Removed from the dashboard** (owner's choice over moving it to an Edge Function). `/api/chat` still exists in `master` but nothing calls it. |
| **7 sites reported over MQTT only** — 1343, 1348, 1416, 2439, 3439, 3456, 3465 | **5 done on 22/09; 1416 and 3465 remain.** The cause was **not** the agent: those PCs have Windows Firewall with `DefaultOutboundAction = Block` on all three profiles, with an exception for port 8883 only — i.e. exactly the old path through HiveMQ. The agent logged `An attempt was made to access a socket in a way forbidden by its access permissions`, and `curl` returned `000`. Fix per site: an outbound allow rule for `Parkomat.Agent.Service.exe` on TCP 443 (plus UDP 123, since NTP is blocked too and the clocks were unsynced), and at two sites also a freshly issued password — accounts recreated on 15/09 invalidated whatever was typed before. |
| **Daily data backup** (`backup` container on DELL008) | **Stays for now.** The owner plans Supabase Pro, which includes backups. It is the only copy outside Supabase — stopping DELL008 entirely stops it. The `backup` container does not run `db.init`. |
| **SQL is applied at `master` boot** (`db.init`) | **Replaced — `master/tools/apply-sql.js`.** Dry run compares production against what `db.init()` builds on a local Postgres (PGlite) — every function body, `SECURITY DEFINER`, grants, policies, cron — and `--apply` writes. It **refuses to write while `master` is alive**, because a running `master` overwrites it at its next boot. |

⚠️ **The hazard above was not theoretical for even one day.** On 17/09, hours after the decision,
a scheduled task on DELL008 (`Parkomat-Watchdog`, `docker compose up -d` every 5 minutes) brought
the old container back. Its `db.init()` re-created old copies of `register_site`, `update_site`
**and `ingest_batch`** — and two copies of a function make PostgREST refuse the call, so **every
site stopped writing** and silence detection marked 26 of them disconnected. It also reverted
seven function bodies, including the one that writes `events`; nothing broke loudly, the screen
simply stopped updating by itself for five days until it was measured (50 faults, 2,138 status
changes, **0 live events**). Both scheduled tasks are now `Disabled`; do not re-enable them, and
do not run `deploy.ps1` on DELL008.

**Dead but not yet deleted:** the "restart the server" feature (`serviceCommandsDirect`,
`app.claim_service_command`, the `service_commands` table, `tools/check-service-commands.js`,
`ops/command-poller.ps1`). The button is already out of the UI and the poller task is disabled.
Removing the rest is a five-file surgery with a destructive DB step; it is left deliberately,
not forgotten.

⚠️ **Turning `master` off before those 7 sites move silences them *and hides it*:**
`app.mark_silent_agents` only watches sites that have an `alive` row, so an MQTT-only site
that stops reporting keeps showing its last status indefinitely.

## Architecture today

```
Agent (on site) ──→ HiveMQ ──→ Node server ──→ Supabase (Postgres)
       ╎                            ↓                  ↑
       ╎                      SSE + assistant    dashboard reads directly
       ╎
       ╌╌╌╌╌ (HTTPS, direct) ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌→   ⚠️ LIVE at 2438 · off at 17
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
| `Parkomat.Agent/` | C# / .NET 10, on a PC at the site. Reads the PLC over Modbus-TCP, publishes to MQTT — and, **when configured**, writes to Supabase directly as well. v1.0.23. |
| `master/` | Node/Express. MQTT ingestion + the AI assistant. Two routes. |
| `dashboard/` | React 19 / Vite. Reads Supabase directly. |

⚠️ **The dotted line is live at one site (2438, since 03/09/2026) and off at the other 17.**
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
| The public door | **Live, and in use at one site.** `public.ingest_batch` takes **no site id** — it derives it from the identity, so an agent cannot write to another site by changing a number. |
| Durable queue in the agent | **Shipped in 1.0.22.** |
| The agent speaks HTTPS | **Shipped in 1.0.22, disabled.** ⚠️ And **only** HTTPS since — `SupabaseConfig.Enabled` requires an absolute `https` URL, because the first request carries the site's **password in the body** and every batch after it carries the token in a header. There was no validation before: a technician who typed `http://` got a working agent, which is exactly what makes that failure invisible. |
| Heartbeat + silence scan | **Built.** See below. |

⚠️ **And for its whole life it swallowed every rejection.** `db/ingest.postgres.sql`
warns in its own footnote that the ingestion functions return the reason in `outcome` and
leave the caller to record it. The caller is `ingest_batch`, and it recorded only
`unknown_kind` — a case the agent never produces.

**Measured on 08/09/2026, not inferred from reading:** of all 1,055 rows in `ingest_drops`,
**zero** carried a `direct/` topic. Site 2438 had been direct-only since 06/09, and that day
a no-change state message was accepted there — the same message that writes a
`state_no_change` row when it arrives over MQTT.

The consequence is not theoretical: as sites migrate, `ingest_drops` empties — not because
less is rejected, but because rejections stop being recorded. It is the only table that
answers *"why did that message not arrive"*.

Fixed by recording on `NOT applied` / `NOT inserted` rather than a list of outcomes — a list
would need extending for every new outcome, and the one forgotten is exactly the one nobody
would learn about. The reason is written as `state_<outcome>` so `state_no_change` comes out
**identical** to the name the MQTT path writes; otherwise one phenomenon would be counted
under two names and every historical query would miss the newer half. `check-direct-drops`
proves it end to end — impersonating the agent through the `app.user_id` GUC, inside a
transaction that rolls back — and four mutations fail it.

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
created and gets `400` on every cycle — on a PC nobody is sitting at, with no line on any
screen. The site looks perfectly installed and simply never reports.

⚠️ **That was a known gap and it is now closed** — `check-agent-email` (static, `noEnv`, no
network). It reads all three files, rebuilds the address from each with a real site code, and
demands the three **resulting strings** be identical. Comparing the source text would fail on
`${code}` vs `{siteId.Trim()}` — a difference that means nothing — and pass on a real drift
written in the same style.

It also checks the fourth party, the one that actually enforces: the domain must appear in
`app.allowed_email_domains()`. All three copies can agree and be wrong together, and then
`enforce_user_creation` rejects the address before there is an agent to sign in at all.

Two things the gate itself got wrong first, both worth keeping:

- **It read line by line and could not see the C# copy**, whose definition breaks after `=>`.
  It reported *"the form changed"* — i.e. the gate was red about itself. It reads a
  three-line window now, and *"not found"* stays a **failure** rather than a skip: a skipped
  copy is exactly the one that would drift unwatched.
- ⚠️ **The anchor matched any mention of `emailFor`, not the definition.** A mutation that
  renamed the definition made the gate latch onto a *call site* and parse an unrelated
  template beside it (`Bearer ${token}`). It went red — by luck, because that string differs.
  A neighbouring template that happened to look right would have produced a **green** gate on
  broken code. The anchor now requires `const` / `string` before the name.

## ⚠️ MQTT is OFF at site 2438 — 06/09/2026

The dotted line is not merely live at one site; at that site it is now the **only**
line. Measured end to end, with both halves observed in the same minutes:

```
מחשב האתר:   Parkomat.Agent.Service · Parkomat.Agent.Tray      ← ואין mosquitto
config.json: Mqtt.Disabled = true
Supabase:    beats 4314 → 4315 · status ready · agent 1.0.36
```

**There is no local broker running, so the agent cannot publish over MQTT at all** —
not "does not", *cannot*. `master` receives nothing from this site. And `beats` only
moves through `public.ingest_batch`, which is reachable solely through PostgREST with
the site's own identity; the server has no route to it and never did.

⚠️ **The sharper proof came from a controlled outage**, because a heartbeat alone
proves liveness rather than delivery. The agent was run with the broker deliberately
down, and the two logs line up to the second:

```
site log   14:47:51.765  [ERR] Failed to connect to local broker
site log   14:47:56.867  -> Supabase: 1 message(s) written directly
database   11:47:51Z     ready
```

A real message was produced, the broker was provably dead, and the row landed.

### What that day cost, and the four bugs it found

Getting here took eleven agent versions in one day, and **none of the four defects was
in the direct path itself** — all four were in things around it that made the path
silently ineffective:

1. **The direct write sat inside the MQTT `try`.** Stage ג' opens with
   `EnsureConnectedAsync`, which throws when the local broker is down — so the write
   *and the heartbeat* were skipped. The path built to survive MQTT going down could
   only run in a cycle where MQTT was up. This is exactly why every direct write in the
   logs appeared seconds after a reconnect.
2. **Uninstall deleted `{commonappdata}\Parkomat`.** Reinstalling therefore erased
   `config.json` — site id, HiveMQ password, Supabase password. The log said
   `Config loaded for site ''` and the agent published nothing. ⚠️ And this is why five
   fixes to `ConfigStore` changed nothing: they preserve fields from a file that had
   already been deleted.
3. **Saving the settings form re-enabled MQTT.** `OnSave` rebuilds `MqttConfig` from
   four form fields, and `Disabled` has no control, so every save silently reset it.
   In the field this looked exactly like the installer erasing the flag.
4. **`bridge.conf` as the tray's signal was a race.** `Start()` launches the agent and
   immediately checks the file — before the agent deletes it. The log said
   *"MQTT is OFF"* while Mosquitto ran beside it, i.e. the site published on both paths
   while configured for one. The tray now reads the config, and **kills** Mosquitto
   rather than merely declining to start it.

⚠️ **And one gap that only a measurement could have found:** with MQTT off the site kept
beating and the screen still said `no_comm`. The birth message and the resync live
*inside* stage ג', which direct-only skips. **A heartbeat proves the agent is alive; it
says nothing about state** — and `sites.status` moves only on a state message, which at
a site doing one operation a day may not arrive for days. A live site that reads as
disconnected is precisely the failure this migration exists to remove.

### ⚠️ Turning MQTT off at a site leaves a **retained will** behind on HiveMQ

Mosquitto publishes its bridge notification **retained**, so HiveMQ keeps the last value and
hands it to every new subscriber. A site that moved to the direct path and had its Mosquitto
stopped leaves `"0"` there — *the bridge is down* — **forever**.

**Measured 08/09/2026.** Every `master` restart re-delivered 2438's will from 06/09 and marked
a live site disconnected. The fingerprint is unmistakable: five `bridge` messages from sites
that do not exist (1122, 1234, 4444, 0, empty) inside two seconds — retained delivery to a
fresh subscription — with the real site's `no_comm` in the same second.

Two things fix it, and both are needed:

- **The guard** (`ingestion/bridge-handler.js`) rejects a will for a site with a fresh beat.
  It handles the symptom: the message still arrives and is still recorded as a drop.
- **`tools/clear-retained-will.js` deletes it at the source** — a zero-length retained publish,
  the only way to remove a retained message in MQTT.

⚠️ **`MASTER_USERNAME` cannot publish**, and an ACL-denied publish **returns no error** — the
PUBACK simply never arrives and the tool hangs silently. Point it at a publishing account with
`CLEAR_USERNAME` / `CLEAR_PASSWORD` (the agent account works).

⚠️ **And verifying by re-subscribing on the same connection is worthless.** The first version
did exactly that, reported *“the wills were deleted”*, and the retained `0` was still there —
a broker does not re-deliver a retained message to a client that already holds the subscription,
so absence looked identical to success. The check now opens a **separate connection**, which is
what `master` does on boot.

⚠️ **The tool refuses to clear the will of a site that is still on MQTT.** There the will is
the *only* power-loss detector, and deleting it leaves a dead site looking healthy.

**Add this to the cut-over procedure for every future site.**

⚠️ **No longer needed since `master` was retired (17/09/2026).** It was `master` that
subscribed and turned the retained `"0"` into `no_comm`. With nothing reading HiveMQ, a
stale will harms nobody, and agent 1.0.57 turns MQTT off at every site with a password
anyway.

### The switch, and why it is derived

⚠️ **Since agent 1.0.57 (04/10/2026) the switch is the Supabase password alone:
`MqttEnabled = !Supabase.Enabled`.** Every site with a password drops MQTT and Mosquitto
with no hand edit, and `Mqtt.Disabled` is kept in the file but decides nothing. Why:
`master`, HiveMQ's only reader, has been off since 17/09. At site 2431 the connection test
showed a red HiveMQ DNS error while the Supabase check was cut off below a fixed-height
window. The test no longer checks HiveMQ, and a site without a password shows red. Details
are in [`Parkomat.Agent/CLAUDE.md`](Parkomat.Agent/CLAUDE.md), *Direct only*. The paragraph
below records the 06/09 design; the principle in it still holds.

`Mqtt.Disabled` in `config.json`, and `SiteConfig.MqttEnabled` was
`!(Mqtt.Disabled && Supabase.Enabled)`. A site with no Supabase password stays on MQTT
whatever the file says, because *"reports nowhere"* is the worst state in this system:
the agent runs, the PLC is read, the tray icon is green, and nothing anywhere says the
data reaches no one. Same principle as `SupabaseConfig.Enabled` — **a state that must
not exist should not be expressible.**

⚠️ **No checkbox in the settings form, deliberately.** One click in the field would
silence a site — the same trap the TLS checkbox was removed for. ~~Turning it on is a
hand edit.~~ Since 1.0.57, entering the password *is* the switch.

### Still open

- **The password does not always survive an install.** It is far more dangerous now:
  with MQTT off, a wiped password means a *dead* site rather than a degraded one. The
  derivation above is what keeps that survivable — it falls back to MQTT.
- ~~**17 sites still need an agent identity** before they can follow.~~ ⚠️ **Measured
  08/09/2026: all 21 sites already have one.** Every site has an active `role='agent'`
  row in `app_users`, so identity is no longer the blocker and the remaining work is
  per-machine configuration, not provisioning.

  ⚠️ **But only 18 of the 21 passwords exist anywhere.** `provision-agent-user.js --all`
  wrote `agent-passwords-2026-09-03-*.txt` (git-ignored) for 18 sites; **1326, 1414 and
  3510** were provisioned later through the dashboard, which shows the password **once**
  and stores only a hash. Those three cannot be connected without rotating — and
  rotating them is free today precisely because they are still on MQTT and the password
  is used by nothing. It stops being free the moment one of them is switched over.

  ⚠️ **And the identity count says nothing about who is actually reporting.** 21 sites
  hold an identity; **`alive` has exactly one row — 2438.** An identity that no agent
  signs in with looks identical in every query to one that works.

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

## בודק מוסמך + תחזוקה מונעת (compliance) — built 04/10/2026

Two per-site tabs ("בודק מוסמך", "תחזוקה מונעת") and two lamps on every card. The owner's
request: every site needs an external certified inspection once a year and preventive maintenance
twice a year; defects from the inspector's PDF must be tracked to closure, ~~**a defect can be marked
done only with a photo**~~ (photo optional since 06/10/2026 — see below), and managers are warned 2 months
and 1 month before expiry.

| Piece | Where |
|---|---|
| Tables, RPCs, the one traffic-light definition | `master/db/compliance.postgres.sql` (applied with `tools/apply-sql.js`; registered in `db.js`) |
| SQL tests (PGlite) | `master/tests/compliance.test.js` — 42 tests, 50/50 SQL mutations killed |
| Data layer | `dashboard/src/services/complianceDirect.js`, re-exported by `dataSource.js` (no server arm) |
| PDF reading (in the browser) — **dates only** | `extractDates` + `suggestInspectionDates` in `shared/parse-inspection.mjs`, `dashboard/src/utils/pdfText.js` (pdfjs, lazy chunk) |
| Inspector page, PM tab | `InspectionPage.jsx` (full page, frames `InspectionTab.jsx`), `PmTab.jsx` (+ `Inspection*`, `Defect*`, `Pm*`) |
| Lamps | `ComplianceLights.jsx`, `utils/compliance.js` |
| UI unit tests | `master/tests/compliance-ui.test.js` |

Rules that are easy to break and expensive to notice:

- **All ten tables are closed** (RLS on, no policies, no grants — D2). Every read is a bounded
  `SECURITY DEFINER` RPC gated by `app.require_staff()`. Do not "fix" a 403 with a policy or a
  `GRANT SELECT`: that is exactly what would expose `data_b64` (PDFs up to 8 MB) to every
  `select("*")`, and the tables to the agents and the intake identity. `compliance_file` is the
  only door that returns bytes.
- **Green/yellow/red is decided in SQL only** (`app.compliance_light`, 30 days). The dashboard
  translates; it never thresholds.
- ⚠️ **The managers' "דורש טיפול" list was built and removed** (owner, 06/10/2026, looking at 60
  rows of "אין תסקיר בודק": *"אני בכלל לא רוצה כזה דבר, תעיף את זה"*). It was a header button
  (`ComplianceAlertsButton` + `utils/complianceAlerts.js`, 60 days ahead for the inspector, 14 days
  awaiting a clean report); `git show b284e8b` holds it. ⚠️ **Consequence, stated plainly:** the
  original request said managers are warned *two months* and one month before expiry. With the list
  gone, the only signal is the lamp, which turns yellow at **30** days — nothing on screen says
  "two months" any more. Push alerts (P5) are still not built. Do not re-add the list without asking.
- **The lamp words are the owner's, and they are a traffic light** (06/10/2026): *"בתוקף / עומד
  לפוג עוד חודש / לא בתוקף — ירוק תקין, צהוב צריך להתכונן לתחזוקה או לזמן בודק, אדום לא תקין"*.
  So `LIGHT_LABEL` reads בודק / תחזוקה **בתוקף · עומד(ת) לפוג תוך חודש · לא בתוקף** for both
  areas — "בקרוב" and "באיחור" were replaced. The colours did not change: they already were
  exactly this (`ok` / `soon` ≤ 30 days / `expired`). Yellow from a cycle awaiting a clean report
  fits the same rule — it means *summon the inspector* — and keeps its own wording ("בודק בתוקף ·
  ממתין לתסקיר נקי"). ⚠️ Grey ("אין נתונים", no report at all) is a fourth state the owner's list
  does not name; it turns red only when `settings.compliance_go_live` is set (see *State* below).
- ⚠️ **A defect past its fix date turns the inspector lamp YELLOW on a valid report — not red.**
  Owner, 06/10/2026, looking at a site with four such defects shown red: *"זה צריך להיות צהוב כיון
  שהמסמך בתוקף אבל הליקויים לא טופלו"*. ⚠️ That reverses a choice made the same morning (red =
  "not OK"); **red now means the validity only** (expired / no report). In
  `app.compliance_machine_rows` the light is raised to `'soon'` when `overdue_n > 0` (open,
  `due_on < today`, current cycle only, soft-deleted excluded) and the validity is ok — the same
  rule as an awaiting cycle; an expired report stays red. `validity_state` stays the pure validity. **Keep the two apart** — the label is built
  from both: "בודק בתוקף · עבר מועד תיקון", not "בודק לא בתוקף", which would send someone to
  summon an inspector when the job is to fix a defect. `machines_detail` carries `validity` for the
  same reason, and `machineLampLabel` reads both shapes (`validity` / inspection_site's
  `validity_state`). ⚠️ The reason avoids the word "באיחור" — the owner replaced it in lamp
  labels, and `probe-lamps` asserts it is gone. Consequence worth knowing: an **urgent** defect is due on the inspection day
  itself, so it is yellow from the next day until closed — including defects typed in during a
  historical backfill. The page's reason line ("N ליקויים עברו את מועד התיקון") is amber, like the
  lamp. SQL test 46, UI tests in `compliance-ui.test.js`; both directions mutated (back to red,
  and no raise at all) and caught.
- ⚠️ **Only the inspector's document makes a cycle clean — fixing the defects does not** (owner,
  06/10/2026: *"אם תקנו את הליקויים — אז באמת אין ליקויים, אבל צריך מסמך נקי שמעלה בודק מוסמך
  שוב ומאשר"*). Measured on site 1343 the same day: a defect deleted with the reason "טופל", then
  the *original* report edited to `declared_clean` — green with no document from the inspector.
  So a report in which a defect was **ever** recorded (deleted ones count) cannot be marked clean in
  `inspection_report_update`, and a cycle whose last report had defects, all deleted, is
  `awaiting_clean` ("summon the inspector"), not `review`. `review` remains only for a report that
  never had a defect and whose clean mark was removed — re-marking it is legitimate there.
  `inspection_site` carries `deleted_defects` so the edit dialog does not offer the checkbox.
  Defects typed by mistake: delete the report and upload it again with "אין ליקויים". SQL test 47,
  3/3 mutations killed.
- **"בוצע" needs the performer's name; the photo is optional** (owner, 06/10/2026, on the close
  dialog: *"אני רוצה שזה יהיה אופציונלי, כלומר יהיה אפשר להמשיך גם בלי להעלות תמונה ולציין מי
  תיקן"*). The RPC no longer demands a photo; `inspection_defects_done_shape` is replaced in the
  1.4א block (DROP/ADD NOT VALID/VALIDATE — the CREATE TABLE copy is dead text) and now allows
  *at most* one evidence instead of exactly one. When photos exist, the first is still
  `done_photo_id` (D8). ⚠️ **The rewrite exposed a NULL hole:** `length(btrim(NULL)) >= 2` is NULL,
  and CHECK accepts NULL — the old XOR had been turning the expression FALSE and hiding it, so
  "done" with no name passed until `done_by_name IS NOT NULL` was added (caught by test 14).
  Done is still not clean: the cycle waits for the inspector's clean report. Test 48.
- **The traffic light is explained in the "?" help panel** (owner's choice over the inspector
  page), section *בודק מוסמך ותחזוקה מונעת* in `HelpPanel.jsx`. The samples are `LampSwatch`
  from `ComplianceLights.jsx` — the same classes and `colorVars` as the card lamp, so the legend
  cannot drift from what the card shows. Its wording quotes SQL thresholds (30 days, 6 months,
  overdue = `due_on < today`); change them together.
- **The inspector page is rows, not boxes** (owner, 06/10/2026: *"תעיף את זה ותעצב את כל העמוד
  נורמלי ויותר מסודר"*). No chips in the status card — the open count lives in the defects heading,
  "awaiting a clean report" in its banner, and a red line under the headline says *why* the lamp is
  red while the report is valid ("N ליקויים עברו את מועד התיקון"). Defects, completed defects and
  reports are flat rows split by a thin line (`.it-list:has(...)` drops the gap), with a 3px red
  start-border only on an overdue defect. "סימון כבוצע" is an outlined small button, not a solid
  one per row; "צפייה במסמך" sits in the report's title row; validity-source tags are grey text.
  The drop zone on the page is one 52px strip (dropping works anywhere on the page anyway). The
  page lamp uses the same `COMPLIANCE_COLORS` tint as the card — it had stayed solid red.
- **Lamps are a translucent tint, not a solid fill** (owner, 06/10/2026, once every site went red:
  "זה אדום מדי חזק, תעשה את זה יותר שקוף" — and after a first 14–16% tint with a full-colour
  outline, "עדיין מדי חזק"). Background = `COMPLIANCE_COLORS[state].bg` (8–10%), outline at
  45–50% alpha, glyph in a dark ink of the same hue (`--cl-ink-*` in
  `ComplianceLights.css`). ⚠️ All three colours share the style — a translucent red beside a solid
  green would make "OK" shout louder than "not OK". Each ink is checked against its tint *blended
  over the card*, in both themes, by `scripts/check-colors.mjs` (a low-contrast ink fails it —
  mutated and seen). The overdue-defects badge stays solid red: it is rare and meant to stand out.
- **Changing a table later:** never edit a CHECK inside `CREATE TABLE IF NOT EXISTS` — production
  skips the whole statement. Use `DROP CONSTRAINT IF EXISTS` + `ADD … NOT VALID` + `VALIDATE`
  (pattern in the file header). The apply-sql dry run now compares constraints, triggers, RLS,
  grants and indexes (`CON_SQL`), so a skipped change shows as drift.
- **Only dates are read from the PDF — no wording at all** (owner, 05/10/2026: "אני לא סומכת על
  כך, כיון שיתכנו ניסוחים רבים — אני רוצה שתחלץ רק תאריכים"). The label parser read the inspection
  date, validity, defects, inspector and report number by phrasing ("בתוקף עד", "מה התיקונים"…),
  which works only on a form someone has already seen. Now `extractDates` collects every date in
  the text and `suggestInspectionDates` proposes the pair: **a date exactly a whole number of months
  (1–24) before a later one** — inspection → next; else the latest and the one before it. ⚠️ Not
  "latest and second latest": one real report also carries a signing date a week later and an
  invoice-page date, and that rule picks a week-wrong inspection date. The months rule found the right pair in
  every real report. `parseInspectionReport` is used **only** to split a multi-report file into
  page blocks. Parser tag `dates-1`.
- **The form shows ONE date to confirm — the next inspection** (owner: "שיהיה רק תאריך שצריך
  לאשר וזהו"). No date buttons, no +12/+6, no note, no "הוצע: …" line (each was removed at her
  request). ⚠️ **The inspection date is still required** — defect deadlines count from it and it
  orders the reports — so it is taken from the pair and sent **hidden**. Its field appears, and
  then stays (`showInsp`, latched), only when there is no suggestion or it does not fit: empty,
  in the future, more than ~2 years before the next date, or before the periodic report it
  follows. Without the latch, fixing the field would make it vanish mid-edit.
- **Defects: a select with no default** — "אין ליקויים" / "יש ליקויים". "יש" opens one text input
  per defect, typed by hand from the document beside the form; Enter or "+ עוד ליקוי" adds the
  next (never a second empty one). **"תוך כמה ימים לתקן" is required and has no default** — 45 was
  pre-filled and therefore never checked. No per-row urgent/due in the upload form: those are set
  later in the defect's own edit dialog. Switching to "אין" hides typed rows but does not delete
  them; what is *sent* follows the choice. The page then shows "נשארו X מתוך Y ליקויים" (open +
  done of the current cycles); each is closed separately with a photo, and when all are, the
  cycle is `awaiting_clean` until the clean follow-up report is uploaded.
- **PDFs are drawn with `disableFontFace: true`** (`utils/pdfText.js`). Without it every Hebrew
  report tested rendered garbled — letters on top of each other, some missing — because the
  embedded David/Miriam subsets carry broken hinting ("TT: undefined function") and Chrome rejects
  them as FontFace. Text extraction was never affected, only the picture the person confirms
  against. Pinned by `master/tests/pdf-render.test.js`.
- **Text in the PDF can be selected and copied** (owner, 06/10/2026: "שיהיה אפשר להעתיק מהמסמך
  עצמו" — defects are typed from the document beside the form). `renderText` in `pdfText.js` lays
  pdfjs's transparent text layer over the canvas, in the form preview and in the viewer. Positions
  are percentages and the font size follows `--total-scale-factor`, recomputed by a
  `ResizeObserver` from the **measured** width — the canvas is resized by CSS, never redrawn. The
  layer's size comes from `utils/pdfTextLayer.css` (`!important`, height from the page's
  `aspect-ratio`), not from pdfjs's inline `round()` (unsupported on older phones, and it leans on a
  variable only their viewer defines). Proven in the browser on both real reports: the layer is the
  local maximum of ink coverage against shifts in all four directions, and Ctrl+C → Ctrl+V into a
  defect line gives the same text.
- ⚠️ **"Gives the same text" was proven with a drag that started one pixel inside the span — and a
  person does not start there.** The owner copied the first defect of a third real report and pasted
  `ש לחזק7אומים מסומðים…` for `יש לחזק 7 אומים מסומנים…`. Three causes, three fixes, all in
  `utils/pdfItems.js` + `pdfText.js`, each proven by a browser mutation:
  - **`ð` for `נ`** — the font stores letters by Windows-1255 (נ = 0xF0) without a usable unicode
    map, so pdfjs reads Latin-1. `repairHebrewEncoding` maps à–ú back to א–ת, only in an item that
    already holds Hebrew (or is rtl). Applied to the text layer *and* to `extractPages`.
  - **No space in the document** — "יש לחזק", "7", "אומים…" are three items with a visible gap and
    no space character. `addGapSpaces` inserts a `" "` item in the gap (≥ 0.15 em; zero gap = one
    word split in two, e.g. "יו"+"ם"). Text layer only — date reading assembles split digits by
    position. ⚠️ pdfjs stretches a span to its width only when it has more than one character, so the
    space stayed 3px and a drag starting in the gap before the first letter selected **nothing**;
    `stretchGaps` sets `--scale-x` on those spans after render (and on every resize).
  - **The first letter** — "י" is 2–4 px wide; a drag starting on its left half starts after it,
    and one starting on the left half of "ש" puts the caret at the word's *end* and loses "יש"
    entirely. ⚠️ Patching Chrome's selection did not hold: scanned pixel by pixel along "יש", the
    caret sometimes lands on the span instead of a letter, and Chrome **re-applies its own
    selection after `setTimeout(0)`**. So on mouse release (`pointerType === "mouse"` only — touch
    selects with handles) `fixMouseSelection` **rebuilds** the selection from the press and
    release points (`caretPositionFromPoint`), adds the letter under each point, widens to whole
    words, and applies it after `setTimeout(0)`. (A second apply after the next frame was tried and
    removed: a pixel scan at human pace passes without it, and its mutation was never caught — the
    overrides seen came only from drags 40 ms apart.) Measured at human pace (Ctrl+C 200 ms after release): every start
    from inside the gap to the last pixel of "ש" gives "יש לחזק…"; starts on the following space
    give "לחזק…", which is what the person pointed at.
  - **An independent review (06/10/2026) added:** no gap space when another item sits inside the
    gap (tables — the stretched span would cover it and make it unselectable); font size from the
    *vertical* scale (condensed text got spaces between letters); encoding repair per *word* on
    paste ("café" became "cafי"); the copied boundary space kept against a neighbouring word
    (`insertCleaned`); dropped text cleaned like pasted text (`dropCleaned`); `pointercancel`
    clears the press point; a word split into two adjacent spans ("יו"+"ם") and ת"א / ע"י are
    taken whole; `setBaseAndExtent` keeps the drag direction; `.it-rows` instead of `:has()` (old
    phones). Each rule has a unit test, and each test was mutated and failed. ⚠️ **Not handled, by
    choice:** a *run* of two or more misread 1255 letters may come out in the wrong order (pdfjs
    orders them as Latin), and an item made only of misread letters is marked ltr and not repaired.
    Only an isolated broken letter was measured; reordering on theory could break what works.
  - ⚠️ **A copy/paste test must seed the clipboard.** The first version passed a case where the
    selection was *empty*: Ctrl+C copied nothing and the paste returned the previous round's text.
    `probe-r2` writes a sentinel before every copy, and also asserts the raw selection — the paste
    cleanup repairs `ð` on its own and would hide a broken text layer.
  - Plus: **paste into a defect line** (`pasteCleaned`) turns line breaks into spaces — an
    `<input>` silently deletes them, gluing the last word of one line to the first of the next — and
    drops zero-width / bidi marks.
- ⚠️ **Parentheses come back reversed from some reports, and the fix is per document**
  (`utils/pdfBrackets.js`). Measured: pdfjs returns one real report's text with every bracket flipped —
  including the defect itself (`)בקומה 2-(`) — while another, from other software, is correct
  (`(בדיקה ראשונה)`). A blanket swap breaks the second; none breaks the first.
  The document decides by its RTL items holding both brackets (which comes first), each page counted
  once. Only the text layer goes through it — not the date reading. `master/tests/pdf-brackets.test.js`
  is synthetic; the same checks on the real text run in `real-reports.local.test.js`.
- ⚠️ **Nothing from a real report goes to git — the repository is public** (owner, 06/10/2026:
  *"אני לא רוצה שזה יופיע ב-GITHUB, זה צריך להיות ב-SUPABASE"*). Reports carry inspector names,
  a license number and addresses. The text extracted from two real reports
  (`master/tests/fixtures/inspection/real/`) and every test that reads it
  (`master/tests/*.local.test.js`) are git-ignored **by pattern**, so not even a file name lands;
  they run in every local `npm test` and simply do not exist elsewhere. Public code calls the two
  formats *נוסח א'* (two columns, reversed brackets, invoice page) and *נוסח ב'* ("מה התיקונים",
  six-month validity). ⚠️ Before any push, grep what is staged for names, addresses and report
  numbers — a comment is enough to publish them.
- **The document gets the wide column** in the upload form (form ≤ 420px, dialog up to 1440px) and
  the viewer opens screen-sized for a PDF (page up to 1200px) — owner: "שהמסמך יפתח יותר גדול". A
  page at 400px is 5px letters, and that is what defects are copied from.
- **The viewer closes on the backdrop only if the press *started* there** — with selectable text, a
  selection released over the backdrop would otherwise close it mid-copy (same guard as
  `InspectionDialog`).
- **Validity is never defaulted to a year** (one real report was 6 months). No date in the
  document → both fields shown empty and typed by a person; save stays blocked until then. The
  server records the source by comparing the confirmed date with `parse.parsed` — the suggestion —
  so keeping the suggestion is "מהמסמך" and any typed date is `manual`.
- **A person confirms the date before saving** (`confirm_dates`, UI gate): never pre-checked, its
  label repeats the next date (and the inspection date when its field is shown), and editing a
  date or switching periodic↔follow-up clears it. A site with several machines gets **no** machine
  pre-selected — the document is not read for it.
- **"בודק מוסמך" is a full page, not a tab** (owner's request, 05/10/2026). The card lamp and
  the supervisor table route through `handleSiteClick` to
  `InspectionPage`; the site window keeps the tab in its nav (with the defects badge) but clicking
  it opens the page, and "חזרה" returns to the window **on the tab it left from**. The page renders
  `InspectionTab` itself — never a copy — with `dropAnywhere`. The PM lamp still opens the window.
- **Dragging a PDF** (managers only) opens the same upload flow with the file already read. On the
  page a file dropped **anywhere** opens it, unless a dialog is already open — then it is ignored,
  so it cannot replace a form being filled. In the window tab a drop outside the zone is swallowed.
  Either way the browser must never open the PDF in place of the dashboard: on the page that holds
  for operators too, who get "רק מנהל יכול להעלות תסקיר" instead.
- **The PM form is local-first** (`utils/pmOutbox.js`): ticks/notes in localStorage, photos in
  IndexedDB, drained when reception returns; ticks are never reverted. Submit needs an empty outbox.
- **The card fetches `site_compliance` at most every 5 minutes** (it changes daily, or on an event),
  plus a one-site refetch on each `events.type='compliance'`. A failure keeps the last-known state
  with a dashed "stale" border, and a site with no known state shows a dashed "?". Never let a lamp
  vanish. (A StaleBanner line after three failures was built and **removed at the owner's request**,
  04/10/2026 — the dashed lamp is the signal.)
- ⚠️ **Opening the app always lands on the operator dashboard (`OperatorView`)** — owner,
  06/10/2026: "כשפותחים את האפליקציה מגיעים ישר ל-DASHBOARD הבקר". The site and tab used to be
  kept in the URL (`?site=&tab=`) and reopened on every load, so that a phone killing the PWA
  mid-visit would return the technician to the form; in practice every refresh landed on the
  inspector page. **Removed deliberately, and the cost is known:** after such a kill the technician
  is back on the dashboard and reopens the site. The draft is not lost — `pmOutbox` keeps it on the
  device, per visit. A leftover `?site=&tab=` (old version, bookmark) opens nothing and is stripped.
  Do not re-add the restore without asking.

**State:** ✅ the SQL **is applied to production** (05/10/2026: the 271 new objects, nothing else;
all ten tables empty; post-apply check "הייצור זהה לקוד"; 06/10: the overdue rule (red, then yellow
the same day), the clean-only-by-document rule and the optional photo — function bodies and the one
constraint, same check). ✅ **The inspector is on the live site (Pages) since 06/10/2026; preventive
maintenance is not** — owner: *"לדחוף רק את הבודק מוסמך"*. One switch hides it everywhere:
`PM_ENABLED` in `utils/compliance.js` (env `VITE_COMPLIANCE_PM=true`, default off), read through
`COMPLIANCE_AREAS` by the card lamp, the mini mark, the site-window tab, the
help legend and the supervisor ranking. ⚠️ A Pages build nobody configured must give what was
decided — so off is the default, and `compliance-ui.test.js` pins it. The PM code ships dormant and
stays tested: the pure functions take `areas` explicitly, and the browser harness runs both modes.
Turning it on = set the variable in Pages, or flip the default. **Supabase Pro must be in place
before the historical backfill** (PDFs live in the database; crossing 500 MB makes the database
read-only and stops ingestion at every site). ⚠️ `settings.compliance_go_live` **is set —
`2026-10-06`**, at the owner's request *before* the backfill ("אם אין מסמך בדיקה בתוקף הסימון צריך
להיות אדום"). So "no report" is **red** ("אין תסקיר בודק" / "אין תחזוקה מונעת רשומה") on both lamps
— measured right after: all 60 sites
`expired`/`expired`. That is the intended state, not noise; it clears site by site as reports are
uploaded. Undo = delete the row (grey again). Push alerts (spec phase P5) are not built.

## Dashboard statistics are computed only on page entry (07/10/2026)

Measured that morning (`pg_stat_statements`, 5-minute delta): **97% of database time** was the
card statistics (`site_stats` ×2, `site_uptime_service`, `site_uptime`). One load costs about 12 s
of DB time, and every open screen ran it every minute, hidden tabs included. On NANO compute
that used up the CPU credits, and Auth, PostgREST and Supavisor all timed out together. Agent
heartbeats were 0.2%.

The owner: *"אין צורך לחשב את הסטטיסטיקות כל דקה. אין צורך אלא בשעה שעוברים לדף הזה"*.

- **Statistics run only on page entry:** first load, switching to the operator page, returning
  to a hidden tab (at most once per 5 min, `STATS_ON_RETURN_MIN_MS`), and an admin change.
  A new site in the list gets one automatic statistics load.
- **The live load runs every 5 min, or immediately on a status mismatch:** `sites`,
  `site_globals` and compliance. It is `withStats: false`. The statistics fields are carried
  over from the screen (`keepLastStats`, `STATS_FIELDS` in `utils/siteSync.js`). A test checks
  that list against `sitesDirect`.
- **No timer bumps `dataVersion`.** The supervisor, executive and "all sites" pages compute on
  entry, not every 5 minutes.
- ⚠️ **The known cost was chosen:** a wall screen left visible shows the numbers from when it
  was opened. Do not reconnect statistics to a timer without asking.
