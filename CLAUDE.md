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

⚠️ **Since 12/10/2026 a "no change" state is no longer recorded** (owner: *"למה SUPABASE שומר הודעות
שאין בהם שינוי!! חבל על המקום"*).
- **Why it piled up:** in the direct path almost every car operation produced one row. In a batch the
  operation comes before the state message and already sets `operating` (`ingest_operation` on
  `start`), so the state right after it is "no change". Measured: 8,905 of 10,432 rows (85%), about
  5,000 a week.
- **Real rejections are still recorded:** late, suppressed during maintenance, LWT late, duplicate
  operation.
- `ingest_batch` returns `no_change` to the agent as before. Only the row is gone.
- The existing rows were deleted the same day, after checking that none had arrived since the apply.
- `ingest-drops-once.test.js` checks both directions, and both mutations were caught. The
  outer-layer example is now `state_suppressed`.
- `check-direct-drops` asserts that the row is **not** written. It now reads only rows created inside
  its own transaction. "The last 5 rows" caught a real 2438 row from a minute before the apply.

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

⚠️ **A state from the minutes before the silence mark goes into history, not into the bin (13/10/2026).**
The scan marks `no_comm` 3–4 minutes after the last beat. A state the agent saw in those minutes reaches
us from its queue only after it returns, timed **before** the open `no_comm` segment, and was dropped as
`state_late_vs_open_segment`. The agent got a 200 and deleted it. Measured: 340 in 30 days at 24 sites,
3 of them faults that vanished from the failure rate. The message proves the agent saw the PLC at that
moment, so the mark was early relative to it. `app.ingest_state` (step 3) now closes the segment that ends
exactly at the `no_comm` start at the message time, and inserts the message's state from there up to the
`no_comm` start. A sequence (fault, then recovery) goes in one after the other.
- **Only** when the open segment is `no_comm`, and only inside the segment that ends exactly where it
  starts. A message earlier than that segment is broken order and is still dropped, and so is any late
  message when the open segment is not `no_comm`.
- **No event and no `sites.status` change:** a `state` event would ring the alarm and push an alert for a
  fault that ended long ago. The current state is still set by the return from disconnect.
- `last_seen` moves forward only. Outcome `backfilled`, `applied = true`, so it is not recorded as a drop.
- ⚠️ It compares the **raw** `status`, not `COALESCE(reclassified_to, status)` (review, 13/10): against the
  reclassified value, a repeat `error` from the queue split a fault the manager had reclassified as maintenance,
  and the new piece counted. Same rule as steps 4–5. A late fault text for a closed error segment is kept there
  (it was lost); an existing text is never overwritten. O7, O8.
- ⚠️ The retired `master` JS path has no such rule, so `parity-ingest-*` would now differ on these cases.
- Tests O1–O6 in `sql-local.test.js`; 10/10 mutations caught (two survived until O4 used a whole second
  and O6 covered a gap in the history).

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
- **The lamp state is decided in SQL only** — `app.compliance_machine_rows` (the pure validity in
  `app.compliance_light`; "a month" = `app.compliance_warn_days()`, 30, for the report *and* for fix
  dates). The dashboard translates; it never thresholds — even the per-defect "within the month"
  mark comes from SQL (`due_state` in `inspection_site`).
- ⚠️ **The managers' "דורש טיפול" list was built and removed** (owner, 06/10/2026, looking at 60
  rows of "אין תסקיר בודק": *"אני בכלל לא רוצה כזה דבר, תעיף את זה"*). It was a header button
  (`ComplianceAlertsButton` + `utils/complianceAlerts.js`, 60 days ahead for the inspector, 14 days
  awaiting a clean report); `git show b284e8b` holds it. ⚠️ **Consequence, stated plainly:** the
  original request said managers are warned *two months* and one month before expiry. With the list
  gone, the only signal is the lamp, which turns yellow at **30** days — nothing on screen says
  "two months" any more. Push alerts (P5) are still not built. Do not re-add the list without asking.
- ⚠️ **Seven states, one colour each — the owner's table (06/10/2026, evening).** The same day went
  red → yellow → this; the table is the decision, the two before it are history:

  | state (SQL) | owner case | colour | glyph | label |
  |---|---|---|---|---|
  | `ok` | 2 valid, no defects | black/white ("מסגרת שחורה"; dark theme: white frame) | ✓ | בודק בתוקף |
  | `fixing` | 1 valid, defects still in time | green | … | בודק בתוקף · ליקויים בטיפול |
  | `soon` | 4 expires within a month · 9 a fix date within a month | yellow | ! | עומד לפוג תוך חודש / בתוקף · מועד תיקון בעוד פחות מחודש |
  | `awaiting` | 8 defects handled, waiting for the clean report (also `review`) | **solid** yellow — "צהוב יותר חזק מהצהוב של 4 ו-9" | ◷ | בודק בתוקף · ממתין לתסקיר נקי |
  | `overdue` | 3 a defect past its fix date | orange | ‼ (+U+FE0E) | בודק בתוקף · עבר מועד תיקון |
  | `expired` | 5, 6, 7 report not valid / no report after go-live — whatever the defects | red | ✕ | בודק לא בתוקף |
  | `none` | no report, go-live unset | hollow grey | ○ | בודק — אין נתונים |

  Precedence (`app.light_rank`, mirrored by `SEVERITY` in `utils/compliance.js`): expired > overdue >
  awaiting > soon > fixing > ok > none; a site is its worst machine. ⚠️ `awaiting` outranks `soon`,
  so a report about to expire whose defects are handled is solid yellow (both mean "summon the
  inspector"). "Within a month" = `due_on - today <= 30` with today included (not overdue);
  overdue = `due_on < today`; current cycle only, soft-deleted excluded. `validity_state` stays the
  **pure** validity and labels are built from both — "בודק בתוקף · עבר מועד תיקון", never "לא בתוקף",
  which would send someone to summon an inspector when the job is to fix a defect. ⚠️ Lamp labels
  never say "באיחור" (the owner replaced the word; the hover text still counts "N באיחור").
  Consequence worth knowing: an **urgent** defect is due on the inspection day itself, so it is
  yellow that day and orange from the next. New fields: `due_soon_n` / `due_soon_defects` /
  `machines_detail.due_soon` / `inspection_site.machines[].due_soon`, and `due_state` per defect.
  An unknown state ranks like "?" in the dashboard, never 0 (an orange site sorted under a green
  one was the silent failure the mapping found). SQL test 49 (nine cases, precedence, month
  boundaries, two-machine sites, `due_state`), UI tests (the `CASES` table, completeness of rank /
  glyph / label / colour per state, ordering, no "באיחור").
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
- **A new periodic report replaces the previous one. Its defects stop counting, but what happened
  to them stays visible** (owner, 11/10/2026: *"גם אם התקלות הקודמות לא טופלו יש להתעלם מהתקלות
  הקודמות ולהתמקד רק במסמך החדש, אך יראו מה היה המצב של המסמך הקודם... וכן האם הדוח החדש עלה
  באיחור"*).
  - **Ignoring them was already in place.** The lamp, the counts and the open list all come from the
    current cycle (`compliance_machine_rows`). Nothing is closed or deleted in the database.
  - **New in `inspection_site`:**
    - Per defect: `done_on`, `late_days` and `not_handled`. For a defect closed by a clean follow-up,
      `done_on` is that report's inspection day, not `done_at`, so a late upload does not blame a
      fix that was on time. Fixed on the due date itself = on time.
    - Per report: `superseded` (a later periodic report exists for the same machine, using the same
      order as `cyc`).
    - Per periodic report: `outcome` (counts for the whole cycle) and `prev`. `prev.valid_until` is
      the previous report's effective validity, where a follow-up with its own validity overrides,
      like `ovr`. `gap_days` = this report's inspection day minus that validity. Positive means it
      was done after the previous one expired.
    - `due_state` is NULL for a defect in a superseded cycle, so an old defect never shows as
      "overdue".
  - **Display only, and the dashboard computes nothing** (`outcomeParts`, `gapPart`, `previousOf`,
    `lateText` in `InspectionUtils.js`):
    - The status card has two quiet lines per machine that has a previous report.
    - In the history, a replaced report reads "הוחלף בתסקיר חדש: …", and an old open defect reads
      "לא טופל · מועד התיקון היה …" instead of "פתוח".
    - A fixed defect shows "N ימים אחרי המועד".
    - Only what was late is colored (`.it-late`).
  - **"Late" means against the previous expiry, not the upload date.** The historical backfill is
    uploaded months after the inspections, which would make every one of them look late.
- **"דוח ישן" (`kind = 'archive'`) — an old report kept for history only** (owner, 11/10/2026:
  *"שיהיה ניתן לעלות דוחות ישנים כדי שישמרו בהיסטוריה. בדוחות אלו לא ישמר האם התקלות שבו טופלו או
  לא — רק ישמר בהיסטוריה. וכשמעלים כזה דוח יהיה צריך לאשר את התאריכים כמו כל דוח"*).
  - ⚠️ **When it is offered: when the document's inspection date is earlier than the machine's
    latest inspection** (any kind: periodic, follow-up, old). The owner: *"לא כשתאריך הבדיקה הבאה
    עבר, אלא כאשר תאריך הבדיקה שהתבצעה קטן מהתאריך האחרון שהבדיקה התבצעה"*.
    - The first version that day offered it when the next inspection date had passed. That was
      wrong.
    - The comparison is per machine, so a newer inspection of machine A does not make B's report
      "old".
    - A machine with no reports never gets the question.
    - Same day as the latest is not earlier.
    - The form computes the same rule from `inspection_site` reports (`latestInsp`, `isOld`).
  - The form then asks, in her words, **"זוהה קובץ ישן, לשמור?"**, with two answers: "כן — כדוח ישן,
    להיסטוריה בלבד" and "לא — כתסקיר רגיל, עם מעקב ליקויים". ⚠️ **"כן" is pre-chosen** (owner,
    11/10/2026: *"ברירת המחדל תסמן כן כדוח ישן להיסטוריה בלבד אבל יהיה אופציה להזיז ללא"*; the
    first version had no default). `oldPick = f.oldChoice || "archive"`. "כן" hides the defects
    question. Dates are confirmed like any report.
  - **It is a third kind, not a flag, on purpose.** Every query that filters `kind = 'periodic'`
    skips it by itself: the cycle and the lamp, the parent of a follow-up, and bringing a machine
    back into use. With a flag, each of those would need an `AND NOT archived`, and the one that
    was forgotten would colour a lamp from an old report.
  - The constraints `inspection_reports_kind`, `inspection_reports_followup_shape`
    (`(kind = 'followup') = (followup_of IS NOT NULL)`) and `inspection_reports_validity_shape` are
    replaced in the 1.4א block, using the DROP / ADD NOT VALID / VALIDATE pattern.
  - **Enforced in SQL:**
    - It needs a later report of the same machine (`inspected_on` strictly earlier than another
      live report's). So a newer report always drives the lamp, and an old report can never hide
      the current state, even while it is itself still valid.
    - Validity is required, as in a periodic report.
    - No defects at upload, in `inspection_defect_save` or via "clean".
    - Editing the inspection date or the machine re-checks the rule, against reports other than
      itself. Otherwise, once its newer report was deleted, it would pass against its own old date.
    - No follow-up can belong to it.
    - The same PDF on the same machine as both "periodic" and "archive" is a duplicate (PT409).
  - **It does count as "the previous report"** (`prev`, with `kind`). After a backfill it is usually
    the previous report of the current one, and without it "נעשה N ימים אחרי שהתסקיר הקודם פג"
    would show for no site at all. The status line then reads "דוח ישן — הליקויים לא נרשמו"
    instead of counts. The history card reads "נשמר להיסטוריה בלבד — בלי מעקב ליקויים", and the
    edit dialog has no "נקי" checkbox for it.
  - Uploading an old report never changes the lamp. Test 51 compares the status before and after.
  - Tests:
    - SQL test 51, rewritten for the new rule. Its cases: no reports, the same day, still valid,
      per machine, a follow-up counts as an inspection, and an edit that compares against itself.
      Five mutations of the rule were all caught. The self-comparison one survived until its case
      was added.
    - Same-day mutations from the first version: 8 of 8 caught.
    - `inspection-previous.test.js`.
    - Browser: `insp/harness/probe-archive.mjs` (29: no reports means no question, newer means no
      question, older but still valid means the question). `probe-dates` T3 is on a site with no
      reports, so it gets no question. `insp/run` B3's document is older than the machine's latest,
      so it answers "לא".
  - Tests: SQL test 50 (6 of 6 mutations caught; the boundary case "fixed on the due date" was added
    after a `>=` mutation survived), `inspection-previous.test.js` (4), and the browser
    `insp/harness/probe-prev.mjs` (28). ⚠️ The two added lines in the status card push the page
    down by about 30px. `insp/run` A7 now scrolls to the thumbnail, because they load lazily via
    IntersectionObserver, and the `probe-page` P1 threshold is 460.
- ⚠️ **Actions on a report that was already uploaded, and "קובץ זה כבר קיים" (11/10/2026).**
  - **The request:** *"אופציה למחוק דוח שעלה כבר או לערוך את התאריכים שלו או להוסיף ליקויים או כל
    דבר. אם מעלים קובץ והתאריכים קיימים כבר אז לכתוב קובץ זה כבר קיים"*.
  - **Measured first:** editing and deleting already existed, behind an unlabeled "⋯" on each row of
    "היסטוריית תסקירים", near the bottom of the page (about 900px down on a phone). No report had
    ever been deleted in production. "+ הוספת ליקוי" was hidden whenever the newest report was
    clean, which is every report uploaded with "אין ליקויים".
  - **The owner chose four changes, all as recommended:**
    1. **"קובץ זה כבר קיים" blocks the upload.** The rule: same site + machine, same `inspected_on`
       and same `valid_until` (NULL-safe) as a live report, of any kind (periodic, follow-up,
       archive). A different file of the same inspection is caught, unlike the md5 check.
       - The form shows it live under the two dates (`sameDatesReport`, `.iu-dup`) and disables
         saving. ⚠️ The form skips the check after an uncertain failure (`locked`). Otherwise the
         report it had just saved would block its own "נסה שוב". The server tells a replay from a
         real duplicate.
       - `inspection_upload` enforces it before the file is handled. A same-bytes, same-dates upload
         therefore gets this message, not the md5 one. It runs under
         `pg_advisory_xact_lock(hashtext('inspection_dates:'||site||':'||machine))`. It is the first
         transaction-scoped advisory lock in the SQL files. `db/single-instance.js` takes a
         session-level one with a two-int key, a separate key space. It is not `FOR UPDATE` on
         `sites`, because ingestion holds that row.
       - ⚠️ **Lock order: row first, then the advisory lock**, as `inspection_report_update` does
         (`FOR UPDATE` on the report). A follow-up upload therefore reads its parent `FOR SHARE`
         *before* the advisory lock. The other order was a deadlock: the follow-up's FK takes
         `KEY SHARE` on the parent, behind an edit that was itself waiting for the advisory lock.
       - After the lock, the upload repeats the `client_id` lookup. A retry that overlapped its
         still-running original gets `replayed`, not "קובץ זה כבר קיים" about its own report.
       - Neither the lock nor that second lookup can be tested in PGlite, because the tests run
         one at a time.
       - "Same dates" means the **stored** values. A follow-up that inherits (NULL) is not the same
         as one with an explicit date equal to its parent's validity. This is deliberate: comparing
         effective validity would block a legitimate same-day follow-up as a "duplicate" of its
         own periodic.
       - A deleted report does not block. That is how you replace one: delete it, then upload again.
       - `inspection_report_update` refuses an edit of dates or machine that would collide with
         another live report ("כבר קיים תסקיר עם אותו תאריך בדיקה ואותה בדיקה הבאה למתקן הזה").
         Moving a periodic to another machine also checks the follow-ups that move with it.
         `compliance_reattach` still has no such check. It is a rare path (orphans of a deleted site).
       - Production had no such duplicates when this was added.
    2. **"עריכה" and "מחיקה" are visible buttons on every history row**, beside "צפייה במסמך". The
       "⋯" menu is gone from `InspectionHistory`. Deleting a periodic that has live follow-ups
       explains why under the row itself (`.it-del-why`). It used to flash a notice at the top of the
       page, out of view for someone scrolled down to the history.
    3. **"+ הוספת ליקוי" also appears when the newest report of the cycle is a clean periodic.**
       - The first defect removes the clean mark, atomically. This needs a new
         `p_unclean boolean DEFAULT false` on `inspection_defect_save`. The 6-arg signature is
         dropped, because two live copies make PostgREST refuse the call. The UI sends the flag only
         when it is true, so an ordinary add also works against a database without it.
       - Without the flag the old refusal stands. A stale screen cannot silently un-mark a report
         someone else marked clean.
       - A clean **follow-up** stays blocked, even with the flag: the inspector closed that cycle,
         and a new defect comes with a new report.
       - The flag is honoured only while the periodic is still the newest of its cycle: no live
         follow-up, and no later live periodic for the same machine. This is the same rule as
         `addTarget`. A stale screen that still offers the button after someone uploaded a follow-up
         or a newer report gets the refusal, so it cannot reopen a closed cycle.
       - The dialog says it cannot be undone (`.it-unclean`). D7 counts deleted defects too, so after
         this the only way back to clean is to delete the report and upload it again.
    4. **Editing `inspected_on` shifts the `due_on` of every live (non-deleted) defect of that report
       by the same number of days, done defects included.**
       - ⚠️ **Done defects too** (owner, same day, on a second question). The first version shifted
         open defects only, and that was the option she had chosen. The review then showed what it
         cost:
         - A done defect's deadline comes from the same wrong date. After a one-year correction, a
           fix made on time read "355 ימים אחרי המועד".
         - A done defect reopened later (D24) came back already overdue and turned the lamp orange.
       - `done_at` (when it was fixed) never moves.
       - A follow-up's own defects (it has its own date) and deleted defects do not move.
       - Each shift is a `compliance_history` row with the reason "מועד התיקון זז עם תאריך הבדיקה".
         `ChangeRow` now prints what changed in a defect update ("לתיקון עד: X ← Y"). Before, it
         printed only the body, so a shift would have shown as an empty "עריכת ליקוי".
       - The audit row carries `due_shifted` / `shift_days`.
       - The edit dialog says how many dates move and by how much (`.it-shift`). Before this,
         correcting a date left every due date on the old one. That is why seven defects at 1118
         had to be moved by hand.
  - **Tests:**
    - SQL tests 52–55.
    - Tests 7 and 10 were moved to distinct inspection days. ⚠️ Test 10's md5 case now uses another
      date and asserts the md5 *message*. With equal dates, the new check answered first with the
      same PT409, and the md5 path was left untested while the test still passed.
    - Test 6 accepts the new audit keys.
    - `inspection-actions.test.js` (`sameDatesReport`, `addTarget`).
- **Nothing in "בוצע" is required** (owner, 06/10/2026: *"אופציונלי — להמשיך גם בלי להעלות
  תמונה"*, then *"שיוכלו לעשות סמן כבוצע בלי למלא את הכל"*). An empty performer name records the
  signed-in user — `app.actor_display_name()`, from the verified identity, never the request — so
  every row still says who marked it and `done_by_name` stays NOT NULL. (PM's own "שם המבצע" on a
  visit is still required; only the defect close changed.) The RPC no longer demands a photo; `inspection_defects_done_shape` is replaced in the
  1.4א block (DROP/ADD NOT VALID/VALIDATE — the CREATE TABLE copy is dead text) and now allows
  *at most* one evidence instead of exactly one. When photos exist, the first is still
  `done_photo_id` (D8). ⚠️ **The rewrite exposed a NULL hole:** `length(btrim(NULL)) >= 2` is NULL,
  and CHECK accepts NULL — the old XOR had been turning the expression FALSE and hiding it, so
  "done" with no name passed until `done_by_name IS NOT NULL` was added (caught by test 14).
  Done is still not clean: the cycle waits for the inspector's clean report. Test 48.
- **The traffic light is explained in the "?" help panel** (owner's choice over the inspector
  page), section *בודק מוסמך ותחזוקה מונעת* in `HelpPanel.jsx`. The samples are `LampSwatch`
  from `ComplianceLights.jsx` — the same classes and `colorVars` as the card lamp, so the legend
  cannot drift from what the card shows. One row per state, in the table's order, plus the neutral
  count and "?". Its wording quotes SQL thresholds (30 days for the report and fix dates, 6 months,
  overdue = `due_on < today`); change them together.
- **The inspector page is rows, not boxes** (owner, 06/10/2026: *"תעיף את זה ותעצב את כל העמוד
  נורמלי ויותר מסודר"*). No chips in the status card — the open count lives in the defects heading,
  "awaiting a clean report" in its banner, and a line under the headline says *why* the lamp is
  coloured while the report is valid — orange "N ליקויים עברו את מועד התיקון", or yellow "מועד
  התיקון של N ליקויים בעוד פחות מחודש" when that is what colours it. Defects, completed defects and
  reports are flat rows split by a thin line (`.it-list:has(...)` drops the gap), with a 3px start
  border only on an overdue defect (orange) or one due within the month (yellow, from `due_state`). "סימון כבוצע" is an outlined small button, not a solid
  one per row; "צפייה במסמך" sits in the report's title row; validity-source tags are grey text.
  The drop zone on the page is one 52px strip (dropping works anywhere on the page anyway). The
  page lamp uses the same `COMPLIANCE_COLORS` tint as the card — it had stayed solid red.
- **Lamp colours: clear, but tasteful** (owner, 06/10/2026: *"שיהיה הכל ברור אבל לא מוגזם, שיהיה
  בטעם"* and *"שכל הצבעים יהיה ברור איזה צבע הם"*). Earlier that day, when every site was red, a
  solid fill was "אדום מדי חזק" and a 14–16% tint "עדיין מדי חזק", so lamps went to 8–10%; with seven
  states that was too faint to tell yellow from orange. Now: a 12–22% tint with a **full-hue**
  border and a dark glyph of the same hue; only `awaiting` is solid. ⚠️ **The values live only in
  `ComplianceLights.css`**, per theme (`--cl-<state>-fill/border/ink`); `COMPLIANCE_COLORS` just
  references them, because black/white is black-on-white in light and white-on-card in dark — no
  single value fits both. The inspector page lamp, the help legend and the mini mark all read the
  same variables (the page's own `--it-ink-*` copy had already drifted once). `check-colors.mjs`
  measures the **rendered** lamps: every state has fill/border/ink in both themes and each value
  parses (an unreadable value fails instead of passing as NaN), ink ≥ 4.5:1 on its fill as seen over
  the card, any two states ΔE ≥ 25 in fill or border, and every glyph is different — 6 mutations,
  all caught. ⚠️ The defect-count badge is always a neutral outline (owner: *"למה העיגול אדום? זה
  מפריע"*); the lamp's colour already says whether one is overdue. PmTab's lamp (`PmLamp` in
  `PmCommon.jsx`) had three solid, hard-coded fills. **Aligned 08/10/2026:** it now takes the same
  `COMPLIANCE_COLORS` variables, inline, like the inspector page. ⚠️ `PmCommon.jsx` imports
  `ComplianceLights.css` itself, because the `--cl-*` variables live there. Without it, a tab rendered
  with no cards (the PM harness) drew "expiring" in black and white.
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
  invoice-page date, and that rule picks a week-wrong inspection date. `parseInspectionReport` is
  used **only** to split a multi-report file into page blocks. Parser tag `dates-2` (since 11/10).
- ⚠️ **"Exactly k months" became "exactly, or k months less one day" (11/10/2026), and "the earliest
  date" was measured and rejected.**
  - **The question:** the owner asked *"איך תדע מה התאריך בו בוצעה הבדיקה? קח את התאריך הכי מוקדם
    שאתה רואה במסמך"*.
  - **How it was measured:** all 68 production reports were downloaded read-only and checked against
    the date beside "מאשר כי ביום… בדקתי" / "תאריך הבדיקה" / "תאריך הבחינה". That label reading is
    for measurement only and is not in the product. The PDFs stay in Supabase and the scratchpad.
  - **The earliest date was right in only 35 of 68.** In the rest it was the inspector's licence date
    ("תאריך הרשיון", decades old, in 10 reports) or the previous report's date ("דו"ח קודם מתאריך",
    "תאריך בדיקה קודמת"). The owner chose the improved rule over it.
  - **The exact-months rule was wrong in 3 of 68.** One inspector's form writes the next date as one
    year less a day (e.g. inspected 05/04, next 04/04 the year after). With no exact pair, the rule fell back to
    "latest and the one before", which took the signing date, months after the inspection. In another
    report it found the exact pair previous report → this report, which put the inspection a year early.
  - **The improved rule: for each later date (latest first), any exact pair, then any "less a day"
    pair.** It got 68 of 68 for both dates. Each part of that order has a test that fails without it:
    - the later date on the outside, or "previous → this, exactly" wins;
    - exact before less-a-day, or the printing date (the day after the inspection) wins;
    - exact **at any distance** before less-a-day. A shortest-distance-first version was tried and
      broke one real report: a date one month after the inspection made "11 months less a day" with
      the next date, and that beat 12 exact.
  - Rule names are `months` / `months_less_day` / `latest`, and they go to `parse_meta.notes` as
    `suggest_<rule>`. Tests: `parse-inspection.test.js` (5 new; 5 of 5 mutations caught on a scratch
    copy).
  - **Four stored dates were corrected the same day, with the owner's approval.** They went through
    `inspection_report_update` (audited, as her identity, with the reason in the call):
    - 1097, 1355 and 1118: the rule's mistakes.
    - 1400: an old report she uploaded that morning, where the signing date, three days later, was saved
      over the correct suggestion.
    - ⚠️ **At the time, editing `inspected_on` did not move defect due dates** (`due_on` is stored
      at insert). So the 7 open defects at 1118 were moved by hand, by the same shift, through
      `inspection_defect_save` (one year later). **Since later that day, `inspection_report_update`
      moves them itself** (see *Actions on a report that was already uploaded* below). Do not shift
      due dates by hand after a date edit any more: they would move twice.
- ⚠️ **Since 11/10/2026 the form shows BOTH dates, as visible fields: "תאריך הבדיקה" above
  "הבדיקה הבאה".** There is no "מתקן" field on a one-machine site.
  - The owner's words: *"שלא יהיה כתוב מתקן בכלל, במקום זה יהיה כתוב מתי הבדיקה התבצעה, כמו
    שבודקים מתי הבדיקה הבאה"*.
  - **The history, shortest first:**
    - 05/10: one date only (*"שיהיה רק תאריך שצריך לאשר וזהו"*). The inspection date was taken from
      the pair and sent hidden; its field appeared only when it did not fit (`showInsp`).
    - Morning of 11/10: it was added to the confirmation line, with a "שינוי" link (*"להוסיף את
      תאריך הבדיקה לאישור ידני"*). Measured then: all 67 reports in production had `inspected_on`
      exactly as parsed and never seen by anyone, and it sets the report order, the fix deadlines,
      "נעשה N ימים אחרי שהתסקיר הקודם פג" and "זוהה קובץ ישן".
    - Afternoon of 11/10: the field is simply always there. `showInsp` and "שינוי" are gone.
  - The confirmation line still repeats both dates ("בדקתי מול המסמך: נבדק ב-X, הבדיקה הבאה Y"),
    and editing either date clears it.
  - **"מתקן" is shown only when there is something to choose:** two or more active machines, or
    only retired ones (`activeMachineCount !== 1`). With one active machine, or none, `makeForm`
    picks it, or "1" on a new site. That covers all 67 sites today (measured: one machine each,
    key "1").
  - Still no date buttons, no +12/+6, no note, no "הוצע: …" line.
  - Harness: `probe-dates` (T1: two date inputs and both dates in the line; T7: the field is visible
    from the start and above the next date, and an edit clears the confirmation and is what gets
    sent). `insp/run` B1 / C1 updated to match. `probe-archive` checks "no 'מתקן' on a one-machine
    site" and the default "כן".
  - ⚠️ `e2e/probe-insp-drop` is stale since 06/10: it waits for the inspector inside the site
    window, which has been a full page since then.
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

## משימות — one button per site, three kinds, ⏳ / V / X on every task, full history (built 06/10/2026, reworked 11/10 and 12/10/2026)

The owner, 06/10: *"יש המון משימות שנפתחות כל יום בשירות"*. These are customer-relations tasks ("tell
the customer he parked wrong") and technical ones ("grease…, replace…", mostly for one site). On 11/10:
*"שלכל אתר יהיה כפתור משימות... אופציה להוסיף משימה, אופציה לעשות משימה בטיפול, אופציה לסמן V...
שלוש אופציות... כתוב את זה יפה ושיראו את כל ההסטוריה של המשימות"*. She chose **one** button per site,
not one per kind as on 06/10, and asked for it on the collapsed card too. On 12/10: *"אני רוצה שיהיה X ו-V ליד
כל משימה וסימון של בתהליך"*. The same evening the kinds came back, with a third: *"שיהיה: קשרי לקוחות / טכני
/ מוקד"*, and then, looking at the result: *"תעצב את הכל בצורה יותר מסודרת"*.

| Piece | Where |
|---|---|
| Tables + RPCs | `master/db/tasks.postgres.sql`. Tables `tasks` and `task_history`; RPCs `tasks_list`, `task_counts`, `task_add`, `task_start`, `task_unstart`, `task_done`, `task_delete`. Registered in `db.js` after compliance; applied with `tools/apply-sql.js`. |
| SQL tests (PGlite) | `master/tests/tasks.test.js`: 20 tests; 24/24 + 8/9 (sherut; the 9th is equivalent) + 6/6 (no kind) + 8/8 (X) + 7/7 (X for managers) + 10/11 (three kinds; the 11th, removing `MATERIALIZED`, is equivalent today — see below) SQL mutations caught |
| UI logic (pure) | `dashboard/src/utils/tasks.js`: `TASK_KINDS`, `kindLabel`, `taskState`, `splitOpen`, `historySteps`, `openSummary`, `countsBySite`. Tested in `master/tests/tasks-ui.test.js`. |
| Data layer test | `master/tests/tasks-direct.test.js`: the real `tasksDirect.js` with a fake Supabase; checks the request body (`p_kind` as sent, `null` when there is none) |
| Data layer | `dashboard/src/services/tasksDirect.js`, re-exported by `dataSource.js`. No server arm. |
| UI | `components/Tasks/TasksDialog.jsx`, `Tasks.css`, `TasksContext.js`. The button lives in `SiteCard.jsx`: `taskPill` on the collapsed card, `taskButton` on the expanded one, and `rowEnd`. |
| Browser | `e2e/probe-tasks.mjs` in the scratchpad harness: 200 checks (K1–K11; K11 = kinds and layout, with `?tasks=kinds`), and 16/16 + 4/4 + 18/18 (`mut-tkkinds.mjs` / `mut-tkkinds2.mjs`: kinds, layout, weight 800) UI mutations caught (`mut-icons-ui.mjs` / `mut-del-ui.mjs`, in a separate tree). Every scenario runs inside `guard`, so a stuck scenario becomes a FAIL that names where it stopped, and the next scenarios still run. `ONLY=K1,K4` and `THEMES=light` narrow a run. |

Rules that are easy to break:

- **The state is derived, never stored.** `done_at` set → done; otherwise `started_at` set → in
  progress; otherwise to do. `tasks_list` returns it as `state`. A state column could say "done" with no
  who or when.
- ⚠️ **One list of open tasks, and ⏳ / V / X beside every one** (12/10/2026). The owner's choices: a mark
  on the task (not the two sections of 11/10), X = **delete completely** (not "cancelled"), and V and X
  "רק sherut, כולם רואים".
  - The open list keeps the SQL order (oldest first). In progress is a row property: the badge says
    "בתהליך", and the ⏳ button is pressed (`aria-pressed`, `is-on`). The state word is now "בתהליך" (her
    word), and so are the history steps: "בתהליך" / "הוסר 'בתהליך'". The old labels were "בטיפול",
    "הועברה לטיפול" and "הוחזרה לביצוע".
  - **⏳** toggles: `task_start` / `task_unstart`, one click, for any staff user.
  - **V** = `task_done`. **X** = `task_delete`. Both ask to confirm for 4 seconds, and only one confirm is
    pending at a time. V straight from "to do" is allowed.
    - ⚠️ **The question ("לאשר?" / "למחוק?") is a bubble above the button (`.tk-ask`, absolutely
      positioned), not text inside it.** Text inside widened the armed button by 33–36px over its
      neighbour's old spot, so a "corrective" click on the neighbour confirmed the irreversible action.
      K1/K8 check that arming moves nothing.
    - ⚠️ **A second click counts only on its own:** not `e.detail > 1` (the second half of a double
      click or tap), not within `ARM_MIN_MS` (600) of arming, and not a held Enter (`e.repeat` is
      `preventDefault`-ed). Before this, a habitual double-click on X deleted a task and its history
      with "למחוק?" on screen for 5–170 ms. K8 checks `dblclick` and a CDP auto-repeat Enter, and also
      that one deliberate Enter still confirms.
    - Both were found by the pre-deploy review, together with the old-bundle count and the off-screen
      explanation below.
  - **Who sees V and X:** everyone. V follows `can_close` (sherut@). X follows `can_delete` (every
    manager, and sherut@ — owner, same day: *"תן אופציה למנהלים למחוק משימה"*). When one is false
    the button is grey (`is-locked`, `aria-disabled`), **not `disabled`**.
    - A click explains **under that task's row** (`.tk-row-msg`, scrolled into view) and sends
      nothing. V and X each have their own sentence (`NO_RIGHTS.done` / `.delete`). On a phone there
      is no hover, so the click is the explanation. The first version wrote it above the list, and on a
      phone, scrolled to a lower task, it was off screen (K9).
    - ⚠️ `.tk-row-msg` uses `width: 100%`, **not `flex-basis`**. On a phone the row is a column, so
      `flex-basis: 100%` set its *height* to the whole row (142px).
    - ⚠️ The two sentences are second copies of the rules in `app.can_close_task` /
      `app.can_delete_task`. Change them together.
    - Playwright refuses to click an `aria-disabled` element, so K7 / K10 use `force`.
    - K7 is a manager who is not sherut (V grey, X works). K10 is an operator (both grey).
  - "בוצעה" stays final: there is no reopen, and done rows have no buttons.
- ⚠️ **X deletes completely: `task_delete`.** Until 12/10 there was no DELETE at all.
  - **Who:** `app.can_delete_task` = staff AND (`app.is_manager()` OR `app.can_close_task`): every
    manager, plus sherut@ even if one day it is not a manager. The role is read from `app_users`, so a
    demoted manager loses it at once (T18). Until the owner asked for managers (12/10, later the same
    day), X used the V rule, sherut@ only.
  - `tasks_list` returns `can_delete` per row, beside `can_close`. The dashboard falls back to
    `can_close` when the key is missing (an older database).
  - **Open tasks only.** A done task is PT409, "המשימה כבר בוצעה", so a stale screen cannot erase service
    history after someone pressed V.
  - It deletes the `task_history` rows explicitly, in the same transaction. The FK stays without
    `ON DELETE`, so a hand `DELETE` still fails loudly.
  - A task that is already gone returns `false`, not an error (double click, two screens).
  - What remains: one `audit_log` row (`task.delete`, ids only) and an `events` row (`action: 'delete'`).
  - T17 covers it, and 8 of 8 mutations were caught.
- **The admin code opens V and X for any staff user** (owner, 12/10/2026, evening: *"מי שיודע את הסיסמה יוכל
  לסמן במשימות כמו השירות… אם הוא נמצא דרך המייל של השירות אז הוא לא צריך סיסמה"*).
  - It is the **existing** admin code (`settings.admin_code_hash`, the same hash as `verify_admin_code`), checked in
    SQL by `app.task_code_ok`. ⚠️ Never a literal in the code: the repo is public, and changing the code in the admin
    panel changes it here too.
  - `task_done` / `task_delete` take `p_code text DEFAULT NULL`; the 1-arg signatures are dropped (two copies →
    PostgREST refuses). The identity rule is checked first; the code is only a fallback. The name recorded is still
    the verified one, and `audit_log` gets `by_code` (like `trust` in maintenance).
  - In the dialog, a grey V/X opens a password field under that row (`.tk-code`), checked with `verifyAdminCode`.
    The right code performs what was pressed, with no extra confirm. The code is kept **in memory only**
    (`setTaskCode` in `tasksDirect.js`), so a reload forgets it. A code the database later rejects is forgotten and
    asked for again. ⚠️ It also belongs to the user who typed it: sign-out or a different user clears it
    (`onAuthStateChange`). Without that, on a shared office screen the next person to sign in inherited V/X (review,
    13/10).
  - ⚠️ **Deploy order: the SQL first.** The bundle sends `p_code` only after a code was entered, and against the old
    SQL that is a 404 (PGRST202).
  - Tests: T21 (10/10 SQL mutations caught), `tasks-direct.test.js`; browser K7/K9/K10 updated, K12 new.
  - ⚠️ **No length rule on the admin code** (owner, 13/10/2026: *"אני לא רוצה שיחייבו איזה קוד… גם להחליף לקוד
    הפשוט ביותר"*). Any non-empty code, in the form and in `public.set_admin_code`. That function now lives in
    `writes.postgres.sql` (it was only in `supabase/migrations/20260819_push_notifications.sql`, which `apply-sql`
    never sees). Empty is still refused: `task_code_ok` rejects an empty code, so it would lock the tasks silently.
    It is the **only shared code** in the system (admin panel + tasks); personal sign-in passwords are separate
    Supabase Auth accounts and do not follow it. T22, 4/4 mutations caught.
- **12/10/2026: the two tasks in production were deleted at the owner's request** (*"תמחק את כל המשימות
  הקיימות"*, then "שתיהן" when shown that one was a colleague's real task). It was done by hand in
  SQL, because `task_delete` was not deployed yet: 2 tasks, 17 history rows, and a `delete` event per
  site. There are no `audit_log` lines for it. Later the same day her own test task ("משימה", 2431) was
  deleted the same way (*"תמחק את המשימה שהוספתי"*), because only sherut@ could press X then.
- **The history lives in `task_history`: one row per change** (`created` / `started` / `unstarted` /
  `done`).
  - The RPC that makes the change writes the row. A call that changes nothing (a second start, or
    returning a task that is already "to do") writes no row, no event and no audit line.
  - The columns hold where a task is now. The table holds everything that happened to it, including a
    start that was later undone.
  - The FK has no `ON DELETE`, so deleting a task by hand fails loudly and the history cannot vanish
    with it.
  - Tasks created before the table existed get `created` / `done` rows built from their columns. That
    backfill is idempotent and lives in the file. Production had 0 tasks on 11/10, so it changed
    nothing there.
- **Two people press ⏳ at once: the first one keeps it.** The second call returns the existing
  stamp and does not overwrite it.
- **Starting or returning a task that is already done fails with PT409, "המשימה כבר בוצעה".** The dialog
  shows the message and reloads. ⚠️ This message has its own state (`actError`). The first version put
  it in `loadError`, and the reload that follows cleared it before anyone could read it (measured in
  the browser).
- ⚠️ **Three kinds: קשרי לקוחות / טכני / מוקד — removed in the morning of 12/10/2026, back that evening
  with a third.** Morning, pointing at "קשרי לקוחות / טכני" in the add form: *"תעיף את זה"*. Evening, a
  colleague's request she pasted and then confirmed ("להחזיר עם 3 סוגים"): *"אשמח שתוסיפי במשימות גם
  אפשרות למשימות מוקד. כלומר שיהיה: קשרי לקוחות / טכני / מוקד"*.
  - Keys `customer` / `technical` / `call_center`, in her order. Nothing in the code had an English
    name for "מוקד"; "dispatcher" already means the ingestion router.
  - ⚠️ **Three copies of the list, and T19 compares all three:** `app.task_kinds()` (what `task_add` and
    `tasks_list` check), the CHECK `tasks_kind_chk` (a literal: a CHECK that calls a function is not
    re-validated when the function changes), and `TASK_KINDS` in `utils/tasks.js`, which the picker,
    the labels and the "יש לבחור סוג" sentence are built from. A kind added to only one of them is refused
    on save, or saved and shown as an English key.
  - **Required in the dialog, with no default.** "הוספה" without a kind says *"יש לבחור סוג משימה —
    קשרי לקוחות, טכני או מוקד"* inside the form and frames the picker in red (`is-missing`,
    `aria-invalid`); nothing is sent. The choice stays for the next task in the same dialog.
  - ⚠️ **SQL still accepts NULL, on purpose.** Tasks opened in the hours without a choice are NULL, and a
    stale bundle (wall screen, open tab, PWA) still sends `p_kind: null`. Refusing it would tell that
    screen "יש לבחור סוג" in a form that has no choice. NULL shows as an empty kind cell.
  - V is still sherut@ only, for every kind including מוקד; X is still every manager and sherut@.
  - **`tasks_list` no longer lists the kinds.** Until 12/10 it had a variable per kind and a `CASE` on
    them, so a new kind would have fallen into the `ELSE` meant for NULL. Now `perm AS MATERIALIZED`
    calls `can_close_task` / `can_delete_task` once per kind present in the result, joined with
    `LEFT JOIN … IS NOT DISTINCT FROM`. `LEFT` because a missing permission must read as "not allowed",
    never drop the task from the list. `IS NOT DISTINCT FROM` because `=` leaves the NULL-kind row
    without permissions. `MATERIALIZED` is a guarantee, not a measured fix: today the planner puts a
    Materialize under that nested loop anyway, and the number of calls is the same with or without it.
    ⚠️ A first measurement here said "8 without". That was PGlite: `pg_stat_get_xact_function_calls`
    keeps counting across transactions, so the second reading was cumulative (found by the review). T20
    counts the calls as a difference inside one transaction: for 24 tasks of 4 kinds, 4 ×
    `can_delete_task` and 8 × `can_close_task` (an operator's `can_delete` calls `can_close` too).
  - Kept from the hours without kinds: `addTask` sends `p_kind` explicitly, `task_counts` returns `'none'`,
    and `countsBySite` counts every row (below).
- **The NULL-kind plumbing, from the morning of 12/10, still in force:**
  - `ALTER TABLE tasks ALTER COLUMN kind DROP NOT NULL` is in the file because production skips the
    `CREATE TABLE`. T16 puts `NOT NULL` back first and re-applies the file. Without that, the test
    would run on a table built fresh and never exercise the `ALTER`.
  - ⚠️ **`addTask` sends `p_kind: null` explicitly.** `task_add` has no default for `p_kind`. PostgREST
    picks a function by the keys in the body, so a missing key is a different signature: 404
    (PGRST202) on every add. `undefined` disappears in `JSON.stringify`.
    `tests/tasks-direct.test.js` checks the body as it goes out.
  - ⚠️ **`countsBySite` used to skip a row with no kind**, so every new task would have been missing
    from the card count. It now counts every row of the site, and the result is `{ open }` only.
    ⚠️ **`task_counts` returns `kind = 'none'` for a task with no kind, not NULL.** The old bundle's
    `countsBySite` skips a row with an empty kind. A wall screen, an open tab or an installed PWA keeps the
    old bundle until it reloads, because `sw.js` forces nothing. With NULL, every new task would be
    missing from those cards. The pre-deploy review found this (three of four reviewers, independently).
    T16 checks the row against the old logic too.
  - A NULL kind gets its own `can_close_task(NULL)`, not the technical one. The rule ignores the kind
    today, but a per-kind rule must not quietly treat "no kind" as "technical".
  - Mutations: 6 of 6 in SQL.
- ⚠️ **The dialog was laid out again the same evening** (owner, looking at the field, three chips of a
  different height and "הוספה" crammed into one row: *"תעצב את הכל בצורה יותר מסודרת"*).
  - **The form is two rows.** The field gets a row of its own, full width. Under it are "סוג", the kind
    picker and "הוספה" at the end. All three controls are one height: 42px, or 44px on a phone. A thin
    line separates adding from the list. The error message sits inside the form, above that line.
  - **The kind picker is one frame in three parts** (radio inputs, `role="radiogroup"`), not three
    loose chips. The chosen part is tinted and bold. The focus ring is drawn inside the frame
    (`outline-offset: -3px`), because `overflow: hidden` cuts an outer one.
    - ⚠️ The chosen text is the accent mixed 60% into the text colour, not the bare accent. In dark,
      the bare accent on its own tint measured 3.1:1 (the review); now 9.4:1 light and 5.7:1 dark. K11
      measures it.
    - "הוספה" without a kind moves focus to the picker, and the message is linked to it
      (`aria-describedby`). It is re-rendered on every attempt (`key`), so a screen reader announces
      it again.
  - **A row is a grid of three columns:** kind | the task and its state | ⏳ V X.
    - The kind column has a fixed width (6.5rem), so the kinds line up, and so does the start of every
      task.
    - A task with no kind keeps an empty cell (`data-kind="none"`, `aria-hidden`). Without it the task
      would slide into the kind column.
    - The kind sits beside the task's first line (`align-self: start`), not between its two lines.
    - The kind is a grey tag without a frame. The frame belongs to the state badge, and a neutral framed
      "לביצוע" next to a framed kind looked like two of the same thing.
    - On a phone the row is one column: the kind is a label above the task, and a missing kind takes
      no space.
  - ⚠️ **No Hebrew text at weight 800 or more.** The dashboard's font on Windows is "Segoe UI", which has
    no 800. Hebrew letters at 800 and 900 fall back to another font, smaller and different; only Latin
    digits stay in Segoe. This was measured with the weights side by side, and it is exactly how the
    chosen "טכני" looked in her screenshot. In `Tasks.css` every Hebrew label moved to 700 (the badge,
    "לאשר?"/"למחוק?", "בוצעו", the chosen kind). K11 fails if any Hebrew text in the dialog renders at
    800 or more. The three left in `Tasks.css` style symbols and digits (⏳ ✓ ✕, the count), which render
    fine. ⚠️ **Elsewhere the dashboard still has 31 uses of 800/900 in 17 CSS files.** They were not
    changed: some style digits, which render fine, and each needs a look.
- ⚠️ **A row shows the state now and who set it, not the timeline** (owner, 12/10/2026, pointing at
  a row with five steps: *"לא רוצה לראות את הלוג אלא מה המצב עכשיו. ומי עשה את זה. שתיהיה מעוצב יותר
  ברור"*).
  - The row shows a state badge (`.tk-badge`: לביצוע / בתהליך / בוצעה, tinted per state), then who
    set that state and when. After it, quieter, who opened the task and when.
  - Who and when come from the **columns** (`created_* / started_* / done_*`), via `taskNow` in
    `utils/tasks.js`. When "בתהליך" is removed, `started_*` is cleared, so the row goes back to
    "נפתחה ע״י" the opener.
  - Names drop "@parkomat.co.il" (`shortName`). Every user is on that domain, which SQL enforces, so
    nothing is lost.
  - The separators "·" are text, not CSS `::before`. `innerText` and screen readers do not see
    generated content.
  - The badge uses `rem`: inheriting from the 0.8em line made it about 10px.
- **All the history is still kept and reachable.** It is in `task_history`, and shown on hover over
  the meta line (`title` = "היסטוריה: …"). The previous behaviour, kept for the record:
  - Every row showed its full timeline: "נפתחה … ע״י … ← הועברה לטיפול … ← בוצעה …".
  - "בוצעו" stays collapsed (owner, 06/10: *"תיזרק למקום שלא מציג אותה, למטה"*).
  - When opened it shows the newest 200. "הצגת כולן" fetches the rest with `p_done_limit => NULL`.
  - The count always shows the full total.
- **`tasks_list(p_kind, p_site_code, p_done_limit DEFAULT 200)`.**
  - The old two-argument signature is dropped (PostgREST refuses a name with two overloads).
  - A browser still on the old bundle calls with two arguments, and that still resolves.
  - The keys `open` / `done` / `done_total` did not change, so an old bundle keeps working: it shows an
    in-progress task as open, which is correct.
  - The limit applies only to done tasks. Open tasks are never cut.
- **The button is on every card, collapsed ones included.** Not in `mini`, which is dormant.
  - On a collapsed card it is a quiet 20px pill, "משימות". When anything is open (to do + in progress),
    the count appears in accent.
  - ⚠️ **When anything is open, the frame is the full accent** (owner, 12/10/2026: *"אם יש משימות
    בהמתנה אז שהמסגרת של המשימות תהיה יותר כהה"*). This applies to the pill and to the expanded
    card's button (`has-open` on both). Before, the frame was 45% accent mixed into grey and could
    barely be told apart. Measured against the card: light 9.5:1 (open) vs 1.35:1 (none), and dark
    3.7:1 vs 1.3:1. On the expanded button only the frame changes, not the text.
    `e2e/probe-tkframe.mjs` (18) checks it in the harness.
  - Its hit area is 32px (44px on touch), made with `::before` like the lamps.
  - It sits with the site code in `.card-row-end`, at the end of the status row.
  - ⚠️ **Measured on 78 compact cards at 1371px.** Without the inspector lamps it fits: 57 + 107 of
    180px, and cards stay 74px. With the lamps on, or with a long fault timer, the button and the code
    move to a line of their own **together**, and cards grow to 100px. That cost is known and accepted.
  - On the expanded card it is one "משימות" button.
- **The input takes focus only with a mouse** (`pointer: fine`). On a phone, focusing it opens a keyboard
  that hides the list.
- ⚠️ **Only the account sherut@parkomat.co.il may mark a task "done"** (owner, 11/10/2026: *"רק מי
  שמתחבר מתוך sherut@parkomat.co.il"*).
  - This covers every kind (מוקד too), and no other manager.
  - Until then, any staff user could close a task. The original request (06/10) was "customer
    tasks by customer relations", and the system has roles, not teams.
  - **The single place is `app.can_close_task(kind)`.**
    - It compares `app_users.email` of the **verified** identity (`supabase_uid = current_actor()`)
      after `lower(btrim())`. It never uses the token, and never `full_name`, which is free text.
    - `p_kind` is kept, so a per-kind rule would change only that function.
    - `tasks_list` returns `can_close` per row. Everyone else simply has no "✓ בוצע" button.
    - `task_done` refuses with 42501, "אין הרשאה לסמן משימה זו כבוצעה".
    - A repeated `task_done` on a task that is already done returns the existing stamp to anyone, not
      an error. It writes nothing.
  - ⏳ (start / un-start) stays open to any staff user, because it does not close a task. Since 12/10 the same rule also governs X (`task_delete`).
  - ⚠️ **The address is written in the SQL.** Renaming or deleting that account leaves nobody able to
    close tasks, silently. The other buttons keep working.
  - Tests:
    - T11: a manager, a user whose display name is the address, `xsherut@`, upper case with spaces,
      an inactive account, both kinds.
    - 8 of 9 mutations were caught. The survivor drops `is_staff()` from the function, which is an
      equivalent mutant: every caller already runs `require_staff()`.
- **Closed tables** (`tasks` and `task_history`): RLS on, no policies, no grants, like compliance.
  - Every read and write is a `SECURITY DEFINER` RPC behind `app.require_staff()`.
  - The name recorded is the verified display name, never typed.
  - `audit_log` gets ids only (`task.add` / `.start` / `.unstart` / `.done` / `.delete`), because every active user
    can read it.
- **`tasks_list` returns a single jsonb value.** PostgREST silently cuts responses at 1,000 rows, and
  done tasks only accumulate. Declared in `check-row-cap`.
- **Live updates.**
  - Every write publishes `events.type='tasks'`, with action `add` / `start` / `unstart` / `done` / `delete`.
  - `App` refreshes the counts and any open dialog on that event.
  - `sitePatch.needsRefetch` ignores it, so a task never reloads the site list.
  - Counts also refresh every 5 minutes. A failed fetch keeps the last counts rather than hiding the
    buttons.
- **The dialog does not change the card.** Opening it from a collapsed card does not expand the card
  (`stopPropagation`). `SiteGrid`'s outside-click handler ignores clicks inside `.tk-overlay`;
  otherwise closing the dialog dropped you on a collapsed card.
- `client_id` is per draft: an add that is sent twice creates one task. It is regenerated after a
  success **and on any change to the draft** (text or kind). Without the second rule, a request that
  committed but lost its response, followed by a kind change and "הוספה" again, returned the first task
  with the old kind, silently (found by the review). The same was already true of an edited text.
- To restore the two-buttons version (one per kind):
  `git show 147ac83:dashboard/src/components/Tasks/TasksDialog.jsx`, and the same for `SiteCard.jsx`
  and `master/db/tasks.postgres.sql`.

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

### The structural fixes, same day

- **Card statistics are computed once, not per screen.** `pg_cron` job `parkomat-card-metrics`
  runs `app.refresh_site_card_metrics()` every 10 minutes and writes one row per site to
  `site_card_metrics` (`master/db/card-metrics.postgres.sql`). It calls the same four
  functions, and every column is their output. The window comes from `app.card_metrics_window`,
  which matches `periodFromIso("week")` exactly, DST included (`tests/card-metrics.test.js`).
  The columns are `json`, not `jsonb`, so floats keep PostgREST's representation. `sitesDirect`
  reads the table. It never falls back to computing live, because a silent fallback would
  bring the load back unseen. An empty table shows "0 operations".
- **`app.op_served` is gone. Read operations from `app.served_operations()`.** A scalar SQL
  function whose body is a subquery is never inlined. Measured on 40k operations: 196 ms as it
  was, **661 ms with `SET` removed**, and 64 ms as an inlinable set-returning function (anti
  join). Results are identical. ⚠️ Never give it `SET` or `SECURITY DEFINER`, because either one
  silently stops the inlining. A test checks the query plan.
- **Applying SQL no longer re-enables a paused cron job.** `app.ensure_cron_job` creates a job
  that doesn't exist. For one that does, it updates the schedule and command and leaves
  `active` alone. Before this, `apply-sql.js --apply` (the full `db.init()`) would have quietly
  re-enabled `parkomat-agent-silence`.
- **Mass-silence guard in `mark_silent_agents`.** If at least 5 sites, and at least half of
  those currently alive, go silent in the same scan, it marks none of them. It writes one
  `ingest_drops` row (`silence_mass_skipped`), which raises the hourly drops alert. Sites don't
  fail together; a slow database does. The function also now reports and marks from a single
  list of IDs, where before it wrote the same conditions twice.
- ✅ **`parkomat-agent-silence` re-enabled 07/10/2026 14:21.** It was paused until the compute
  upgrade (owner's call). The project had in fact been resized NANO → **MICRO (1 GB)** at 09:41 that
  morning. Check it with `pg_postmaster_start_time()` and `SHOW shared_buffers` (256MB); don't trust
  older notes. A read-only preview before enabling showed it would mark 0 sites (58/62 beating, 4
  already `no_comm`). Runs take 12–17 ms, against 52 s when throttled. ⚠️ **Micro is burstable
  too.** Throttling came back at 10:52, after the resize, under the old dashboard load, so the fixes
  above are what keep it healthy, not the size alone.

## Sites without a controller, and maintenance lists per type (built 07/10/2026, deployed 08/10/2026)

The owner, on Sotefin facilities: *"the site isn't linked to the facility itself, because it's
Sotefin's, but it does exist, and it does need the inspector, maintenance and tasks"*. On
maintenance: *"some things are common to almost every site, and some maintenance actions are
specific to the type of facility"*.

- **`sites.monitored`** (default `true`; `false` = no controller connected). It is separate from
  `control_system`: that field is the facility's operating system and decides the FixFlow
  library, and a Sotefin facility can be connected (`סוטפין-לולק`) or not. Such a site has no
  agent identity (`registerSiteDirect` returns before `provisionAgentDirect`). Its `status` stays
  at the default `'no_comm'`; the dashboard ignores it:
  - the card shows "ללא בקר מחובר" (dashed), the compliance lamps and the tasks buttons, with no
    status chip, no metrics and no expanded card;
  - it is not counted in the status filters and is hidden under any status filter;
  - it sorts last;
  - it is filtered out of `toSupervisorShape`, which also feeds the executive page;
  - AdminPanel shows no agent-identity or "controller replaced" button for it;
  - it is left out of the identity list.
  The register form has a "ללא בקר מחובר" checkbox. `update_site` cannot toggle the flag yet.
- **Maintenance lists** (`pm_templates`, `pm_checklist_items.template_id`, `pm_site_templates`).
  The old global list became the **default list** ("משותף"). ⚠️ **A site with no assignment
  gets the default list, exactly as before.** `app.pm_site_template_ids` is the single place
  that resolves a site's lists. The visit snapshot orders the lists by `seq` and renumbers items
  `1..n`. The 40-photo cap is checked per list on save and again across the site's lists, both
  at assignment and at visit start. Existing RPCs keep working: `pm_template()` and
  `pm_template_save(items, token)` with no list id mean the default list. Template names are
  never written to `audit_log` (D22).
- **Groups within a list** (`pm_checklist_items.section`, snapshotted into `pm_visit_items.section`).
  They come from the Sotefin document: *"4 rows for the technician — lift, shuttle, dolly, lobby.
  Tapping one opens the tasks; when all are done the row turns green and he moves to the next"*.
  - The visit snapshots each item's group, or the list name when the item has none. So every item
    in a new visit belongs to a group, and renaming a group later does not move items in an open
    visit.
  - The form groups consecutive items into rows that open on tap. A row shows done/required and
    turns green (tint, ✓) when nothing required is missing. Only the first incomplete row starts
    open.
  - When an **open** row becomes *finished* (nothing required is missing and every checkbox is
    ticked, optional ones included), it closes and the next incomplete row opens. A row whose only
    remaining items are optional stays open, so it does not jump away from the technician.
  - ⚠️ Items in a closed row are `hidden`, not unmounted. A PhotoPicker unmounted mid-compression
    would lose the photo. `.pm-items { display:flex }` would override the browser's `hidden`. What
    actually hides the row is the existing `.pm [hidden] { display:none !important }` at the top of
    `PmTab.css`, and the probe checks real layout (`offsetHeight`), not the attribute.
  - "Missing item" links open the row first and scroll after the render.
  - A visit with one group, or one from before groups existed, renders flat as before, with no
    header.
  - In the editor, every item has a "קבוצה" field with suggestions from the list's existing groups.
    A heading appears where a group starts. A new item inherits the last item's group.
  - Tests:
    - `pm-templates.test.js`: 2 tests, 10/10 SQL mutations caught.
    - `probe-groups.mjs` in the scratchpad harness: 17/17, 12 UI mutations.
- ⚠️ **The owner's instruction for new sites is addressed to Claude, not the UI:** *"from now on,
  every time a facility is added you'll need to ask which maintenance to attach to it; usually
  the answer will be like another project"*. When registering a site, **ask** which lists it gets.
- **Pending from the owner:** the three documents to turn into lists (Kaplan 8, the rest of the
  Sotefin facilities, "מפרט טיפול לחניונים רובוטיים"), and the codes for the 11 Sotefin sites.
  ("אביגיל 18" doesn't exist; it is אביגיל 20, 1343, already in the system.)
- Tests: `pm-templates.test.js` (12 tests, 10 mutations caught),
  `register-site-unmonitored.test.js`, `sort-sites.test.js`, and `supervisor-shape.test.js`
  (unmonitored case). The browser probe is `e2e/probe-lists.mjs` (scratchpad harness, 14/14,
  run with `VITE_COMPLIANCE_PM=true`, 10 UI mutations caught).

## "בודק מוסמך" in the header filter (built and deployed 08/10/2026)

Five versions in one day. The owner's words decided each one, so they are recorded:

1. *"סרגל בצד של סינון שיציג רק אתרים פגים או אתרים נקיים וכו'"*. A sidebar on the board.
2. *"תהיה אופציה בצד לסמן האם רוצים לראות בודק מוסמך... תחת כל סימון כזה יפתח תפריט"*. Her answers
   added that every state is always listed, even at 0.
3. *"תעיף את זה, זה לא קיים"*, about the "אין נתונים" and "לא נטען" rows. Then a narrow column in the
   header's colour, glued to the edge, *"דומה לסינון שנמצא ב-HEADER"*.
4. *"אני רוצה שבודק מוסמך יופיע בסינון ב-HEADER"*. And the lamp on the card *"מופיעה רק כשמסמנים"*.
5. ⚠️ **The current one:** *"כשלוחצים על בודק מוסמך יפתח תפריט מתחת, ואז יצטרכו לבחור מה רואים,
   ואז זה יסגר בסיום הבחירה"*. **There is no sidebar any more.**

**What it is now:**
- **The header's filter row** has a "בודק מוסמך" tile (and "תחזוקה מונעת" when `PM_ENABLED`), after
  the type/system/tier box. It uses the status tiles' `filter-btn` class, with the area icon in place
  of the count.
- **The tile opens our own list underneath. It was a `<select>` and was replaced on 08/10,** after the
  owner said *"תעשה את זה יותר יפה"*. The OS draws a `<select>`'s list, white and without colour or
  lamp, and it cannot be styled. The list is a card (`role="listbox"`) with:
  - "בלי בודק מוסמך" — the default ("בלי נורות בכרטיסים");
  - "כל האתרים · N" — shows the lamps, filters nothing;
  - the 7 states, each with its lamp (`LampSwatch`) and count. PM has 4.

  The current choice is marked ✓. Thin lines separate the three groups.
- **What the `<select>` gave for free is rebuilt explicitly:**
  - closing on a choice, on a click outside, or on Esc;
  - arrows, Home/End and Enter;
  - focus returning to the tile.
- ⚠️ **Two traps on a phone, both measured:**
  - Focusing the selected row with a plain `focus()` scrolled the page. A scroll closes the whole
    "סינון ותצוגה" panel (`Header.jsx`), so the list vanished under the finger. The fix is
    `focus({ preventScroll: true })`.
  - The header is sticky, so the list inside it does not move with a page scroll. Its height is capped
    at what is left of the screen, and the rest scrolls inside it.

  It also flips to the tile's left edge when there is no room to its left.
- **The closed tile reads like the status tiles beside it.**
  - "בלי": the icon, the area name and ▾.
  - "כל האתרים": the same, plus a "כל האתרים" line.
  - A state: big count + its lamp, the state's name, "בודק מוסמך" underneath, and the tile filled in the
    state's colour (via the status tiles' `--filter-bg/-border/-text` variables, with dark ink on
    yellow and white).
- **One choice at a time**, like the selects beside it. The model's `only` array can hold several;
  the UI does not offer that. An active tile counts as one filter in "סינון ותצוגה · N פעילים".
- ⚠️ **Probe trap:** wait for the list's open animation to finish (`getAnimations().finished` with a
  `catch`) before a Playwright `tap`. Otherwise it stalls on "not stable", and screenshots show the
  list half-transparent.
- ⚠️ **By default ("בלי"), the area's lamp is not drawn on the board's cards.** This was chosen
  knowingly, and it is a change: before 08/10 the inspector lamp was always there. Any choice draws it.
  The help panel says so.
- **The choice is remembered from last time, per user, per device.** The owner said *"לפי הבחירה האחרונה
  של הבן אדם מהפעם הקודמת"* and chose "each device separately". It lives in localStorage under
  `parkomat.complianceView:<user id>` (`hooks/useComplianceView.js`), unlike the other board
  filters, which reset on refresh.
  - The key carries the user id, so two people on a shared office screen each get their own choice.
  - It is written only when the user chooses, never from an effect. An effect would store "בלי" on the
    first render, before the saved choice was read, and wipe it.
  - What is read back goes through `sanitizeComplianceView`. A removed state ("none") or a foreign
    key becomes "כל האתרים", and broken JSON becomes "בלי". A stale value must never filter the board
    to zero with no option that explains why.
  - Probe R1–R6.
- **The choice combines with the status and type filters (AND),** and the two areas combine with AND.
  An unmonitored site *is* matched.

| Piece | Where |
|---|---|
| View model (pure) | `DEFAULT_COMPLIANCE_VIEW` (`{ show: false, only: [] }` per area), `lampAreasFor`, `matchesComplianceView`, `complianceActiveCount`, `COMPLIANCE_FILTER_ROWS` / `complianceFilterKey` / `complianceFilterCounts`, in `utils/compliance.js` |
| Hiding a lamp | `LampAreasContext` in `ComplianceLights.jsx`, provided by `OperatorView` around `SiteGrid`; `markFor` respects it too |
| The tile | `components/ComplianceFilters/`, rendered by `Header` in the status row; state `complianceView` in `App.jsx` |
| Tests | `compliance-ui.test.js` (6 tests, 21/21 mutations caught, run on a scratch copy); browser `e2e/probe-cf.mjs` (28) + `dbg-cf-pmoff.mjs` (3) |

- **The key is the SQL state.** "אין תסקיר" is split from "לא בתוקף" by `stateLabel`'s own rule
  (`missing`, except under `none`). An unrecognised state gets the key `unknown`.
- ⚠️ **`none` and `unknown` have no option**, so such a site shows only under "כל האתרים". "אין
  נתונים" cannot occur in production since go-live was set (06/10). "לא נטען" is a network failure.
- **The context reaches only the board.** The supervisor table keeps its lamps (probe C8).
- ⚠️ **The harness `openPage` now picks "כל האתרים" in every area by default** (`showLamps`,
  `lamps: true`), because the old probes click lamps. `probe-cf` opens with `lamps: false`. A probe
  that reloads must call `showLamps` again (`run.mjs` S4).
- ⚠️ **It exposed a card bug, still fixed.** The lamp label was `nowrap`, and "בודק בתוקף · מועד תיקון
  בעוד פחות מחודש" is longer than a 270px card, so it stuck out and gave the page a horizontal scroll.
  `.cl-label` now wraps (`min-width: 0`).
- **Deployed 08/10/2026, 10:03 (`f249d66`), together with the 07/10 work.** The SQL went first
  (`apply-sql --apply`: 16 gaps, all new, then "הייצור זהה לקוד"). Pages served the new bundle at
  10:04, checked by finding `cf-area-btn` in the live JS. Afterwards 64 of 65 sites had a fresh beat
  and events kept flowing.
  ⚠️ **The dry run does not show missing tables or columns.** `pm_templates`, `pm_site_templates`,
  `sites.monitored` and `pm_checklist_items.template_id` / `section` were all absent from production,
  and none of them appeared in the 16 gaps. Only their functions and some constraints did. `--apply`
  runs the full `db.init()`, so they were created, but before applying, check
  `information_schema.columns` / `.tables` by hand. Do not read "16 gaps" as the whole change.
- ⚠️ **Found along the way, fixed the same day: with PM enabled, tapping a site's name on a phone
  opened the PM tab.** Chrome adjusts a touch to the nearest *tap target*. A `<span>` is not one,
  because React listens at the root, not on the card. The PM lamp's 44px hit area ends 7px below the
  centre of the name. Measured: a touch at (215,309) became a click on `cl-lamp--soon` at (214,317),
  while a mouse click at the same point expanded the card.
  - **Proved before fixing:** a native click listener on the name (injected in the harness) stopped the
    snapping, and `cursor: pointer` did not.
  - **The fix:** the name is now a real `<button class="card-name-text card-name-btn">` with no handler
    of its own, so the click bubbles to the card as before. It is styled exactly like the span (no
    padding, so `useFitName`'s measurement is unchanged), and a card can now be opened from the
    keyboard.
  - **Verified:** `probe-tasks` K4 with PM **on** is 57/57; it failed before.

## Defect-fix PDF for the certified inspector (built 08/10/2026)

The owner: *"כשמתקנים ליקוי ומעלים תמונה — שייווצר מסמך PDF עם הליקוי והתמונה שמראה את התיקון, שאפשר
יהיה להוריד ולשלוח לבודק המוסמך"*. She first chose one document per defect. Before it shipped she changed
it: *"כשיש כמה ליקויים, כשמוסיפים עוד תיקון לעוד ליקוי — שיצטרף לאותו PDF"*. Her answers:

- **One document for all the fixes of the machine's current inspection.** A new report means a new
  document.
- **A fix marked done without a photo is included,** labelled "לא צורפה תמונה".

| Piece | Where |
|---|---|
| PDF writer (pure, no dependency) | `dashboard/src/utils/pdfImages.js` — `jpegPagesToPdf`, `pdfTextString` |
| Which fixes, what the page says, layout (pure) + drawing (browser) | `dashboard/src/utils/defectPdf.js` — `fixesForPdf`, `summaryFacts`, `fixFacts`, `fixesPdfFileName`, `planPages`, `wrapWords`, `layoutPhotos`, `fitContain`; `buildFixesPdf` |
| The button | `FixesPdfButton` in `components/Compliance/DefectRows.jsx`, in the head of each machine's "בוצעו" list (`DoneList` in `InspectionTab.jsx`) |
| Tests | `master/tests/defect-pdf.test.js` (14, 29/29 mutations caught on a scratch copy; the output is opened with pdfjs); browser `e2e/probe-defect-pdf.mjs` (10) |

- **"Joins the same PDF" means the document is rebuilt from every fix on each download, not a file that
  gets edited.** No stored copy can drift from the screen, and nothing is added to the database. Report
  PDFs already live there.
- **One button per machine, next to "בוצעו (N)"**: "הורדת PDF לבודק (k)". It stays visible while the list
  is collapsed. k counts the defects fixed in the field. One closed by a clean follow-up report is left
  out, because the inspector already saw it. The order is the fix order, oldest first, so a new fix
  joins at the end.
- **The page is drawn on a `<canvas>` and packed as one JPEG per page.** JS PDF libraries do not lay out
  bidirectional text, so Hebrew comes out reversed or needs hand-reversed strings plus an embedded font.
  The browser draws "בוצע ב-08/10/2026 ע״י משה" correctly (`direction = "rtl"`).
  - **The cost:** the text in the PDF cannot be selected or searched. For evidence sent to an inspector,
    that is acceptable.
  - **No library:** a PDF of JPEG pages is a few dozen lines (`DCTDecode`).
  - The title metadata is UTF-16BE.
- **Layout:**
  - The brand band with the logo, then the title "דיווח תיקון ליקויים" ("ליקוי" for one).
  - On page 1 only, a summary table: site + code, machine (multi-machine sites only, key alone when
    there is no label), the report or reports, and the number of fixes.
  - Then one compact block per fix: "ליקוי n מתוך N", the defect highlighted, then due / fixed / by in
    two columns, then the note.
  - A "מתסקיר" line appears per fix only when the fixes come from more than one report.
  - Photos: one fills the width, several go in two columns, first on the right, top-aligned. Max 460px
    with several fixes, 560px with one.

  `planPages` keeps every fix whole on one page. It shrinks photos to 280px to fit, then breaks the page.
  The first fix on a page is never pushed to an empty page. Each page is packed to JPEG and released as
  soon as it is drawn, because a phone may hold twenty photos.
- **Photos are fetched only on click** (`fetchComplianceFile('defect_photo', …)`, one after another),
  and the builder is a dynamic import. The file is named `תיקון-ליקויים-<code>-<last fix day>.pdf`.
  Dates are Israel days.
- ⚠️ **Node needs the `.js` in `import … from "./compliance.js"`.** Vite resolves without it. pdfjs 6 has
  no `doc.destroy()`: destroy the loading task.
- The harness serves `dashboard/public` now (`publicDir`). Without it the logo was missing from the
  harness and from the PDF.

## ⚠️ Opening the "בודק מוסמך" list closed the whole filter panel on a phone (fixed 08/10/2026)

Found while re-running `probe-cf` after the harness started serving the logo. It failed 2 runs out of 3.

**The cause:** opening the custom list fires a `scroll` event on the document **without the document
moving**. That was measured in Chrome, and it happens even with `focus` disabled. `Header.jsx` closes
"סינון ותצוגה" on any scroll once its 250ms grace period has passed. So anyone who opened the panel,
paused for a second, then tapped "בודק מוסמך" saw the whole panel close with the list under their
finger. The earlier passes were timing luck: the tap landed inside the grace period.

**The fix is in the header's rule, not the list.** It ignores a document scroll that did not move the
document (< 8px) and any scroll inside `.app-header`. The second matters because the list scrolls
inside itself on a short phone. A real scroll, of the document or of the card grid, still closes the
panel. `probe-cf` P1b (a late tap, after 1.2s) and P7 (a real wheel scroll closes the panel) pin both
directions, three runs in a row.

## The service agreement on every card, and "לא חובר" changes the moment a site is linked (11/10/2026)

The owner asked for two things: *"אני רוצה שיופיע ההסכם שירות על כל כרטיס בכל מצב"*, then
*"שיופיע בשורה של שם האתר"*. She also asked: *"ברגע שמחברים אתר לשורת הסוג שירות שלו — שישתנה ישר
הכיתוב 'לא חובר'"*.

**The badge (`TierBadge`) is now on every card, on the site-name row.**
- **Before:** it was missing on every collapsed card in production. The grid always switches to
  compact above 60 sites (the phone is compact too), and the badge was normal-only. It was also
  missing on unmonitored cards.
- **In compact, the badge takes the site code's place, and the code moves to the left end of the
  status row** (`codeInRow`). Both were measured on the 69 real names (`real=1` in the harness).
  With the badge *and* the code on the name row, 46 of 79 names lost their city part and the badge
  overlapped the code at every width, even 1920. With the swap, VIP matches the old layout and
  "מורחב" goes from 10 to 21 trimmed names at 1280. No name is cut, and the smallest font is 11.5px.
- **A smaller badge in compact** (`.density-compact .tier-badge`), and a lower name floor there
  (4.75rem). Without the lower floor, "תחזוקה בלבד" (76px) and "לא בשירות" (65px) spilled out of
  the card at 1280. Neither label exists in production today: all 69 sites are vip, ext or basic.
- **The normal density is unchanged.** The type badge stays normal-only.

**Why "לא חובר" did not change, and the fix.**
- **The cause:** since 07/10 the tier came from `svc` in `site_card_metrics`, which the cron
  refreshes every 10 minutes and the screen reads only on page entry. `ServiceAgreement.onLinked`
  did reload the list, but it read the stale value. Linking directly in the board did not reload
  anything at all.
- **`public.site_service_links()`** (`service-hours.postgres.sql`) returns only the link: the board
  scan, with no hours. `sitesDirect` calls it on **every** load, live loads included. So `tier` has
  left `STATS_FIELDS` and `SERVICE_FIELDS`, and a failed call keeps the last known tier
  (`tierStale` → `keepLastTier`). ⚠️ The function duplicates the matching in `site_uptime_service`.
  `tests/service-links.test.js` compares the two on one board full of edge cases, so a change to
  one without the other fails.
- **A statement trigger on both board tables** (`traffic-light.postgres.sql`,
  `app.tl_board_changed`) publishes `events.type='service_link'`, **once per transaction**:
  `tl_paste_rows` inserts row by row, so per-statement firing would mean one event per pasted row.
  `App` does a live reload on that event (no stats, no `dataVersion`). A trigger rather than nine
  `tl_*` edits, so a future writer cannot forget it.
- **What still lags:** availability within service hours comes from the table until the next cron
  run (≤10 min). Only the label is immediate.

**The manual "דרגת אתר" field is gone from add-site and from the admin edit row** (owner,
11/10/2026, pointing at it: *"את זה תעיף"*).
- **Why it was dead weight:** the tier on every card comes from the board (`site_service_links`).
  The form only set `sites.tier`, which is shown only when the board read fails (`effectiveTier`'s
  fallback, kept by `keepLastTier`).
- `registerSiteDirect` already sends `'basic'` when no tier is passed, and `updateSiteDirect` omits
  `p_tier`, so `sites.tier` keeps its value.
- The read-only "דרגה: …" in the admin row stays: it shows the board's tier.
- To restore: `git show 1fda799:dashboard/src/components/AddSiteModal/AddSiteModal.jsx` and the
  same path for `AdminPanel.jsx`.
- Browser check: `e2e/probe-notier.mjs` (3/3). It unlocks the panel with any code (the harness
  mock's `verifyAdminCode` returns true), and the panel is reached via the supervisor view.

Tests: `service-links.test.js` (7; 5 of 5 SQL mutations caught), `service-merge.test.js` and
`sites-direct-cache.test.js` (updated, plus `keepLastTier` and the fresh-tier cases). Browser:
`e2e/probe-tier-all.mjs` (34/34; 27/27 with `REAL=1`); `dbg-tier-gap.mjs` / `dbg-tier-names.mjs`
measure trimming and overflow. The harness mock no longer puts `tier` in `LIVE_DEFAULTS`.

## "סוג מעלית": up to two lifts per site, and the console question (built 11/10/2026, reworked 12/10/2026)

The owner: *"כשמוסיפים אתר צריך 'סוג מעלית' שיהיה SELECT … 1, 2, 6 — אם בוחרים באופציות האלו
תיפתח השאלה קונזול אורכי או קונזול רוחבי"*.

Her decisions the same day:
- **Required when a site is registered.** For types 1, 2 and 6, the console is required too.
  ⚠️ **Reversed on 12/10/2026, evening:** *"תעשה שלא יהיה חייבים לבחור מה סוג המעלית"*. The type is
  optional in both forms, and "לא הוגדר" is a real option you can also go back to. The console is still
  required once a type that opens it (1, 2, 6) is chosen.
- **Also in the admin edit row**, so the sites already registered can be completed. Until then
  they stay NULL.

And on 12/10/2026: *"אני רוצה שתהיה אופציה להוסיף עוד מעלית. יש אתרים שיש בהם שתי מעליות. וכן בסוגי
מעליות להוסיף סוג בשם מספריים הידרואלית ותעצב את הSELECT יותר יפה וחדשני"*. Her answers: **up to two**
lifts, the scissors type **with no console**, and a **styled dropdown** ("רשימה נפתחת מעוצבת").

| Piece | Where |
|---|---|
| The list (keys, labels, which types open the question) | `shared/lift-types.mjs`: `LIFT_TYPES` (7), `LIFT_CONSOLES`, `MAX_LIFTS`, `liftNeedsConsole`, `liftLabel`, `liftProblem`, and for two lifts `siteLifts`, `liftsLabel`, `liftsProblem` |
| Columns + shape | `sites.lift_type` / `lift_console` and `sites.lift2_type` / `lift2_console`; CHECKs `sites_lift_shape` and `sites_lift2_shape` (`schema.postgres.sql`) |
| Validation | `app.check_lift_type`, `app.check_lift_console`; `register_site` (12 args) and `update_site` (11 args) in `writes.postgres.sql` |
| UI | `components/ChoiceSelect` (the styled dropdown) and `components/LiftFields` (one or two lifts: the dropdown, a two-part console, "+ עוד מעלית", "✕ הסרה"), used by `AddSiteModal.jsx` (`variant="form"`) and the `AdminPanel.jsx` edit row (`variant="row"`). The card's type badge and the admin row show both, joined by " + " |
| Tests | `sql-local.test.js` (6 lift tests; 13/13 SQL mutations, `mut-lifts-sql.cjs` in the isolated copy `scratchpad/sqlmut`), `lift-types.test.js` (the four copies of the list, and the helpers), `register-site-unmonitored.test.js` (what the data layer sends); browser `e2e/probe-lift2.mjs` (106, 1280 light and 390 dark) and `probe-liftbadge2.mjs` (11), UI mutations `mut-lifts-ui*.mjs` (separate tree; 18 of 19, V18 equivalent in Chromium). `probe-lift.mjs` (51) drove the old `<select>` and is superseded |

- **Keys are English and labels Hebrew**, as in `site-types`. The labels are exactly hers, in her
  order. "הידראולית" is spelled correctly; she typed "הידרואלית".
- ⚠️ **The list exists in four copies, and `lift-types.test.js` compares them:** the shared module,
  the two check functions, and the two table CHECKs (one per lift). A type added to only one of them
  would show in the form and be refused on save, or be saved through SQL and break the screen.
- **The CHECK enforces the shape, not the requirement.** A type is from the list or NULL; the
  console is from the list; and a console exists **exactly** for types 1, 2 and 6. Outside the
  RPCs (hand SQL, a tool) nothing can store "4 עמודים with a console" or "a piston without one".
  `sites_lift2_shape` adds one rule: **no second lift without a first** (`lift2_type IS NULL OR
  lift_type IS NOT NULL`). Otherwise "the second lift" would be a site's only lift, and everything
  that reads `lift_type` would say "לא הוגדר".
- **Two lifts are columns, not a table.** Exactly up to two, and the card and both forms read them from
  the same row (`select("*")`) with no extra query per site.
- **`register_site`:** no requirement since 12/10 evening (NULL or empty = "לא הוגדר"). A type that
  opens the question still needs its console. A second lift needs a first ("יש להגדיר קודם את המעלית
  הראשונה", in words before the CHECK says it without them). Checks run **after** the duplicate-code
  check: `tools/check-writes.js` expects 409 for a repeated code without a lift type.
- **`update_site`:**
  - NULL means untouched, so the old bundle and a plain rename don't affect the lift fields.
  - An empty string **clears** — for the first lift since 12/10 evening (until then it was refused as
    a required field), and for the second it means remove ("✕ הסרה"). Clearing the first while a second
    remains is refused: "אי אפשר לנקות את המעלית הראשונה כשיש שנייה — יש להסיר קודם את השנייה".
  - ⚠️ **Both lifts are computed first and written in one `UPDATE`.** The CHECK is evaluated on the
    final row, so one call can set both on a site with no lift, or clear both. Two `UPDATE`s fail on the
    intermediate state (mutation L13). A lift that was not sent keeps its values, console included
    (mutation L8 survived until the case "change the first, the second keeps its console" was added).
  - Changing a type recomputes its console. A type without a console clears it, otherwise the
    CHECK would refuse. A console alone changes the console of the current type.
  - ⚠️ **The first `SELECT` takes `FOR UPDATE`.** The single `UPDATE` writes both lifts, including the
    one that was not sent, from the values read at the start. Without the lock, two managers editing
    the same site at once would write each other's old value back (found in the review after
    f463712). PGlite has one connection, so `lift-types.test.js` checks this structurally.
- **Old signatures are dropped:** `register_site` with 8 and 10 args, `update_site` with 7 and 9. Two
  live copies make PostgREST refuse the call. The new parameters are `DEFAULT NULL`, so a call from the
  old bundle (10 keys) still resolves.
- ⚠️ **Deploy order: the SQL first, then the push.** The new bundle sends `p_lift2_*` only when there
  is a second lift, so a one-lift registration also works against the old SQL. But a second lift is
  404 (PGRST202) there, and clearing the first lift is refused as a required field.
- ⚠️ **The idempotency test now re-applies `schema.postgres.sql` too** (plus `tasks` and
  `card-metrics`), against `sites` rows that already exist. Until then no test re-applied it.
  Removing the `DROP CONSTRAINT IF EXISTS sites_lift_shape` line passed all 1008 tests, and would
  have failed only on the next production apply (42710). The review found it, and the case was
  checked.
- **In the forms** (`LiftFields`):
  - The first lift offers "לא הוגדר" (like the machine type and the system), **only while there is no
    second**. The second has no empty option: you remove it instead, and its placeholder is
    "— לבחור —". A second added without a type: "יש לבחור סוג למעלית השנייה, או להסיר אותה".
  - "+ עוד מעלית" appears only once the first has a type, and not past `MAX_LIFTS` (2).
  - The console is one frame in two parts (radio inputs). Switching to a type without a console clears
    it, so a hidden value is never sent.
  - The edit row sends only what changed per lift (`initialLifts` vs `lifts`): a removed second lift is
    `lift2_type: ""`, a cleared first is `lift_type: ""` with no console key.
- **`ChoiceSelect` — the dropdown, instead of `<select>`** (the OS draws a `<select>`'s list and it
  cannot be styled; same reasoning as the "בודק מוסמך" filter).
  - ⚠️ **The list opens in a portal, `position: fixed`.** The add-site modal scrolls
    (`overflow-y: auto`), so an absolutely positioned list inside it was clipped. It is measured from
    the button, follows scroll and resize, and opens upward when there is no room below. A click inside
    the portal is not "outside" for the modals: React portal events bubble through the component tree,
    so the modals' `stopPropagation` still holds.
  - ⚠️ **While open, a transparent backdrop (`.cs-backdrop`) covers the screen and swallows the
    outside click**, as `<select>` does. The first version closed on a `document` `pointerdown` and let
    the click through, so a click on the area around the add-site form closed the list *and the whole
    form*, and what had been typed was lost. The same happened to the admin panel in the middle of an
    edit (found in the review). The backdrop closes on `click` with `stopPropagation`. Closing on
    `pointerdown` (V18) survived the probe. In Chromium a click whose pressed element disappears is
    dispatched nowhere, so it is equivalent there. It is not guaranteed in other browsers, which is
    why it stays `click`. A wheel over the backdrop also closes it.
  - Rebuilt by hand, as `<select>` gave them for free: closes on choice, outside click, Esc and Tab;
    arrows, Home/End, Enter/Space; focus back to the button; `role=listbox`/`option`/`aria-selected`;
    `focus({preventScroll})`, so the modal does not scroll the button away from its list.
- **The other selects in both forms were restyled, not replaced.** "סוג המתקן" (it has groups) and
  "מערכת" stay `<select>`, with `appearance: none` and the same SVG chevron, height and corners as the
  dropdown. In the add-site form every field is 40px (44px on touch).
- ⚠️ **Found on the way: the add-site buttons had no style at all.** "רשום אתר" and "ביטול" relied on
  `.btn` / `.btn-primary` from `DetailPanel.css`, deleted in 6830603, and showed as plain text since.
  Their style now lives in `AddSiteModal.css`, scoped to `.addsite-modal`.
- ⚠️ **`AdminPanel.css` rules for the edit row are scoped to direct children**
  (`.adm-edit > label > span|input|select`). `.adm-edit span` gave every span inside the new
  component a 34px width and a muted colour, and `.adm-edit input` styled the console's radio inputs.
- The `master` server arm does not know the field. It is retired, and the direct arm is the only
  one in use.

## FixFlow is always automatic; the supervisor table sorts by failure rate (11/10/2026)

The owner, pointing at the "יעד ב-FixFlow" picker: *"תעיף את זה. שזה יעשה אוטומטי בכל מקרה"*. In
the same message: *"שהעמוד מנהל בקרה שהאתרים ימוינו לפי אחוז כשל"*.

**FixFlow: no manual choice anywhere.**
- **Removed:**
  - the picker in add-site and in the admin edit row;
  - the card's "שייכי ספריית תקלות" and its "✎".
  - `FixFlowPicker.jsx`, `FixFlowAssign.jsx`, `savedAssignment.js` and its test are deleted.
- A card whose derivation fails shows "אין ספריית תקלות". The reason is in the title, for example
  "לא הוגדר סוג מכונה". The fix is the site's machine type or system, or the mapping. It is no longer
  a choice on the site.
- **Measured before removing.** 13 of 69 sites had a manual `fixflow_profile`:
  - 7: automatic gave the identical target;
  - 3 (1212, 1376, 3501): the same library and document count. The only difference is a library
    link instead of a FixFlow-site link, and those sites have no site overrides;
  - 3502: automatic would pick a different library;
  - 1200 and 1342: automatic failed.
- **The owner chose "automatic for all", and three fixes keep the same libraries:**
  - **A new mapping, `doli` + ביטנקם → `דולי ביטנקם`.** The evidence: אהרונסון 40 (1200) is filed
    under it in FixFlow. It also gives 1222 a library; it had none.
  - **3502 (אנטיגונוס 13) gets `plc_type` = `matzbet-x`.** The owner said the recorded Y was wrong;
    its manual choice was the X library, as at אנטיגונוס 11.
  - **1342 (שפר 20-22) gets `matzbet-x` and `control_system` = לולק.** That is how FixFlow files it.
    Its name did not match because of "22-20" against "20-22".
- After the 13 choices were cleared, 68 of 69 sites resolve. **1418 (פייבל 17)** has no machine
  type; it had no library before either.
- ⚠️ **Order matters:** clear the choices only after the dashboard with the new mapping is live.
  Otherwise 1200 has no library in between.
- `sites.fixflow_profile` and `update_site(p_fixflow_profile)` stay in place: `resolveChosen` still
  honours a value. Nothing in the UI sets one any more.

**The supervisor table** (`SupervisorView`) now opens sorted by **אחוז כשל, high to low**. Ties
(most sites are at 0%) fall back to the old urgency order (`compareSitesByPriority`: status → tier).
Clicking a header still sorts by that column.

## Wizenet service calls on the site card (built 13/10/2026, OFF until the lists are loaded)

The operations email (24/09/2026): the call centre sees a site in fault, but maybe no tenant opened a call in Wizenet, so
show the calls next to the system data. The owner chose **a marker on the site card**, and **anyone (any staff
user)** may change a call's status and type.

| Piece | Where |
|---|---|
| Intake (already live since 05/10) | `supabase/functions/service-calls` → `service_calls` (insert-only identity). One row **per event**, not per call |
| Board SQL | `master/db/service-calls-board.postgres.sql` (loaded after `tasks`: it needs `require_staff`, audit, events) |
| Relay to Wizenet | `supabase/functions/wizenet` — `handler.ts` (all logic, tested in Node) + `index.ts` (Deno wiring) |
| Dashboard | `services/serviceCallsDirect.js`, `utils/serviceCalls.js`, `components/ServiceCalls/`, `SiteCard` (`callsPill` / `callsButton`), `App` (counts + event) |
| Tests | `service-calls-board.test.js` (7, 16/16 SQL mutations), `wizenet-fn.test.js` (9), `service-calls-ui.test.js` (5); browser `e2e/probe-calls.mjs` (25) |

- **A call's state is its last row** (by `ticket_number`), and above it our last change per field **if newer**
  (`service_call_changes`). We may not get an update back from Wizenet for a change made through their API; that
  is the open question to Wizenet.
- **Site = project code:** `project_code` if they send one (operations suggested switching to it), else the first part of
  `parking_code` (`1226-1-02` → `1226`) matched to `sites.code`. A call with no matching site is counted nowhere.
- **Open = its status is not marked `closed` in `wizenet_lookups`.** An unknown status counts as open: better to
  show a call that may be closed than to hide an open one. `closed` is guessed from the name only for a **new**
  row (סגור / נסגר / בוטל / הסתיים / טופל / הושלם) and is **never overwritten** by a reload; check it by eye.
- **The Wizenet token never reaches the browser.** It is an Edge Function secret (`WIZENET_TOKEN`, plus
  `WIZENET_QRY_STATUS` / `WIZENET_QRY_TYPE`). ⚠️ Never in a file: the repo is public. The function checks
  `my_role()` against the database **before** calling Wizenet, and records the change **only after** Wizenet
  answered `update successfully` (a 200 with an error in the body is an error).
- **The card marker shows only when there is an open call** (unlike "משימות", which is always there because tasks
  are added from it). Same look as the tasks pill, in `.card-row-end`.
- ⚠️ **OFF by default:** `VITE_SERVICE_CALLS` (like `PM_ENABLED`). Without the status list there is no way to know
  which calls are closed, and the pickers would show numbers. `service-calls-ui.test.js` pins the default.
- **To turn it on, in order:**
  1. `apply-sql --apply` (the new file).
  2. `supabase secrets set WIZENET_TOKEN=… WIZENET_QRY_STATUS=… WIZENET_QRY_TYPE=…` and
     `supabase functions deploy wizenet` (the CLI is not installed on the dev machine yet).
  3. Load the lists once: the link "טעינת הרשימות מוויזנט" in the calls dialog (any staff user; afterwards a quiet
     "רענון…" link at the bottom). Then check the names and the `closed` guesses.
  4. Tell Wizenet to switch on the push (their mechanism is ready and waiting for us).
  5. `VITE_SERVICE_CALLS=true` in Pages.
- ⚠️ **13/10/2026: steps 1–2 are done, and the WIZEAPI server answers only from Israel.** The three secrets are set and
  `wizenet` is deployed (the CLI is now logged in on the dev machine; deploy with `npx supabase functions deploy wizenet
  --project-ref xvfsikwaaaohnmldjbtv --use-api`). The token works: from the dev PC the status list came back at once.
  From the function, every call timed out. Measured with check-host.net: `parkomat.wizenet.co.il` (37.19.124.254, Triple C,
  Tel Aviv) accepts TCP 443 from two Israeli nodes and from **none** in DE/NL/FR/UK/US, twice; same DNS answer everywhere;
  `www.wizenet.co.il`, `www.parkomat.co.il` and `www.gov.il` are reachable from the same foreign nodes. Supabase runs in
  Germany, so steps 3 and the status/type change wait for Wizenet to open WIZEAPI to foreign access (asked 13/10). The
  browser cannot be the relay either: no CORS headers, and the token would leak. Their push **to** us is unaffected.
- **Found on that deploy:** Deno's timeout message is `"Signal timed out."`, so `/timeout|abort/` missed it and the user
  saw "הפעולה נכשלה". The handler now checks the error name first, and says whether Wizenet or Supabase did not answer
  (`wizenet: true` on errors from the Wizenet fetch). 5/5 mutations caught.
