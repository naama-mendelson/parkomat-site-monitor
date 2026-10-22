# CLAUDE.md — Parkomat SiteMonitor (system-wide)

Guidance for Claude Code across the whole repo. Component-specific rules live in
[`master/CLAUDE.md`](master/CLAUDE.md) (server) and
[`Parkomat.Agent/CLAUDE.md`](Parkomat.Agent/CLAUDE.md) (site agent) — read those before
editing either component. Source comments are Hebrew; these instruction files are English.

## Current state — measured 13/10/2026 (read this first; older sections below are history where they disagree)

```
Agent (on site) ──HTTPS──→ Supabase (Postgres + pg_cron + Edge Functions) ←── dashboard (Cloudflare Pages)
```

- **No server.** `master` is retired (17/09/2026) and its scheduled tasks on DELL008 are disabled. SQL is applied
  with `master/tools/apply-sql.js` (dry run, then `--apply`). Say "Supabase", not "the server".
- **Every site reports directly:** 78 sites, 78 agent identities, 78 `alive` rows. MQTT/HiveMQ is read by
  nobody. Diagrams below that show HiveMQ → Node server, "LIVE at 2438 · off at 17" or agent v1.0.23 are history.
- **Agents in the field:** 1.0.55 (42), 1.0.57 (34), 1.0.59 (2: the two-system sites 3468 and 1102).
  **1.0.62 (22/10/2026, not installed anywhere yet):** a second agent on the same PC (`ParkomatAgentSetup-1.0.62-agent2.exe`)
  for מעפילי אגוז: שמאל 12282 and ימין 1228 on one NUC. Two ordinary agents, each its own site. See
  `Parkomat.Agent/CLAUDE.md`, *A second agent on the same PC*. ⚠️ 1228 is not registered as a site yet.
- **Dashboard:** deployed by `git push` to `main` (Cloudflare Pages). DELL008's copy is not what people open.
- **Edge Functions:** `invite-user`, `provision-agent`, `notify-fault`, `service-calls` (Wizenet → us),
  `wizenet` (since 15/10/2026: only hands the Wizenet token to relay PCs, see *Wizenet relay*).
- **Database:** 181 MB (18/10/2026); the largest table is `inspection_files` (49 MB of PDFs). ⚠️ **The project is on a paid
  plan, not the free one** (the owner, 18/10/2026; Micro compute is itself a paid add-on). The 500 MB wall and the
  "read-only when full" failure quoted below are free-plan facts and no longer apply: the paid disk starts at 8 GB and
  grows (billed per GB). Storage is a cost question now, not an outage. What still matters on Micro is CPU and
  connections, not disk. Growth measured 18/10: ~1 MB/day of operations + status rows, 0.5–4 MB/day of inspector PDFs
  while the backfill runs; `auth.sessions` and `cron.job_run_details` were the two unbounded tables and are pruned since
  18/10 (see the two sections of that date).
  **Re-measured 18/10 evening: 184 MB.** Operations + status grow ~1.3 MB/day and are capped by the 12-month cleanup
  (~470 MB steady state). Events (7 days), closed service calls (30 days), sign-ins (1 day) and cron history (14 days) are
  all on prunes. The three prunes added that morning first run that night. Inspector PDFs: 50 MB for 122 files (~0.4 MB
  each). Every monitored site already has one; the 130 multipliers would add ~50 MB a year. ⚠️ **The largest future
  growth is PM photos:** since that day every item can carry photos (≤6 per item, ≤40 per visit, about 0.3 MB each after
  compression to 1280px, stored as base64). At ~430 visits a year (monitored + multipliers, twice a year), that is
  roughly 1–2 GB a year if technicians photograph freely, and ~5 GB at the cap. It fits the paid disk; the cost is per GB.
  Storing the bytes as `bytea` instead of base64 would save a quarter. Measure again once real visits start.

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
2. ~~**Everyone may put a site into maintenance.**~~ **Not since 19/10/2026: an editor or a manager** (see *Three
   roles* below; a בקר is read-only). Until then: no credential required. This was the
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

⚠️ **Written for the free tier; the project is on a paid plan since before 18/10/2026, so the 500 MB figures below
are history.** The *shape* of the reasoning still holds (12-month retention plateaus at the high-water mark; cost is
predictable): with 82 reporting sites the operations + status steady state is ~380 MB a year, well inside 8 GB.

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

### ⚠️ Duplicates: one person, one text, one moment — one row (14/10/2026)

The owner: *"אם יש קריאה מאותו בן אדם באותו זמן עם אותו טקסט אז אל תכתבי אותה פעמיים חבל"*.

**Measured in production the same day, and it is large:** at site 1312 **eight** separate tickets opened within
16 seconds — same phone, same name, "המתקן לא מגיב" word for word (774526–774533). Four at site 1376 in 8
seconds ("טכנאי"), four at 1197 in 18 seconds ("בירור"), and four more pairs 2–3 seconds apart. Wizenet clean
it up afterwards by hand: 15 calls marked "מבוטל בשל כפילות" and one "קריאה כפולה". Live effect: 77 tickets
collapse to 60 rows.

- ⚠️ **The collapse is in `app.service_calls_current()`, not at the intake door.** She said "don't write it",
  and the answer is: each of the eight is a **separate ticket number at Wizenet** with its own lifecycle, and
  Wizenet send a status update for each one later. A row we never stored means that update arrives as a brand
  new call and **pops up again** — with nothing left to tie it to the group. And the door is built to accept
  everything and reject nothing, because the address is a contract. So **everything is stored, shown once** —
  and because the collapse sits in the one place that decides state, the card count, the site's list, "קריאות
  היום" and the header count all agree without anyone remembering to filter.
- **The key is site + person + text + a gap of at most `app.service_call_dup_gap()` (60 seconds) from the
  previous call.** ⚠️ Not five minutes: the gap *between consecutive calls* in every measured burst is 2–5
  seconds, and the rule chains (a with b, b with c), so a wide window would also merge a genuine second call
  from someone nobody came back to. Two calls two minutes apart are two calls.
- ⚠️ **The key is built from the FIRST row of the ticket, not the last — and that is not a detail.** Measured:
  **48 of 76** calls changed their text between their first row and their last. Not the content: the encoding.
  Wizenet send the same note once as `<br>`, once as `<br />` with a newline, and once fully escaped as
  `&lt;br /&gt;`. The "טכנאי" burst at 1376 collapsed to 3 instead of 4 for exactly that reason. ⚠️ And text
  cleaning would not have saved it: after tags are stripped, `&lt;br /&gt;` decodes to a literal `<br />` and
  stays different. What does work is comparing what was there **at the moment of opening** — which is also
  right in substance: the duplication is a fact about the opening, not about what the call centre added later.
- **The group key is assembled once** (`gkey`), because three window functions must partition by exactly the
  same thing. In the first version it was written out three times, and a mutation that dropped the site from
  one of them **survived** every test — the other two still partitioned correctly. Duplication there does not
  just look bad: it hides a bug.
- ⚠️ **If any call in the group is open, the group is open**, and the representative is the oldest open one, so
  the status shown always belongs to an open call. Otherwise closing one of the eight would stop the pulse
  while another was still open. (`bool_or` is deliberately redundant against the `open DESC` ordering — the
  mutation that replaces it is equivalent and is not caught. It stays because it *states the rule* instead of
  leaving it to a distant ORDER BY.)
- **The one guard: no text at all means no merging.** A call with no complaint and no notes becomes a group of
  itself. Without it, two empty calls from the same caller in the same second would merge merely because both
  are empty — and a dispatcher who calls without typing anything would lose calls. Identity is *not* a guard:
  two anonymous calls with the same text at the same moment **do** merge, because that is one fault.
- ⚠️ **`btrim` in Postgres trims spaces only — not newlines, not tabs.** So the whitespace normalisation runs
  **before** the trim. In the other order a `\n` at the end of a note survived, became a trailing space, and
  the call did not merge with its twin. Caught by a test, not by reading.
- **The row says `×8`, it does not hide quietly.** Eight presses by one person are *information* — they say
  something there did not answer him — and an unmarked disappearance would also hide that seven more ticket
  numbers exist that Wizenet will keep sending updates about. `dupInfo` in `utils/serviceCalls.js`, a neutral
  outlined `.sc-dup`; the colour on the row already says open or closed.
- Tests: S11 (eight identical → one, the window, different text, one closed in the group, all closed), S12
  (no text, two different people, phone written differently, name without a phone, anonymous, another site,
  re-encoded HTML, whitespace only, grouping by the first opening time, ticket order ≠ time order),
  `service-calls-ui.test.js` for `dupInfo`. **19 of 20 SQL mutations caught**, the survivor being the
  equivalent `bool_or`. Two of the test cases were added only after a mutation survived, and one of them
  (whitespace) found the `btrim` bug.

### ⚠️ An open call is the second sort key on the board (14/10/2026)

The owner asked whether the card order is status → tier → failure rate (it is, plus "no communication" between
maintenance and operating, and "operating" split into exit before entry), and then: *"אני רוצה שתוסיף המיון
השני אחרי הראשון צריך להיות אם יש קריאה פתוחה"*.

- The order is now **status → an open call → tier → failure rate**, in `utils/sortSites.js`.
- **Binary: has one or does not.** A site with three open calls does not come before a site with one — inside
  "has", tier and failure rate decide exactly as before. That is what was asked, and it is also right: the
  number of calls is usually a measure of how many times one person pressed, not of urgency.
- ⚠️ **A comparator factory, not a field on the site.** The count is not part of the site record — it lives in
  `ServiceCallsContext` and refreshes on its own clock. Attaching it to the site object before sorting would
  create new objects on every render and break `React.memo` on the cards: 78 cards repainting on every tick of
  the stopwatch. With no lookup function (`makeCompareSites(null)`) the result is **exactly** the previous
  order, which is what `compareSitesByPriority` still is — the supervisor table and its tie-breakers are
  untouched.
- ⚠️ **No `useMemo` in `OperatorView`**: the sort sits after the loading/error early returns, so a hook there
  would be called conditionally. And `filtered` is a new array on every render anyway.
- Tests in `sort-sites.test.js`: a call does not lift a site above a worse status; inside one status a `basic`
  site with a call comes before a `vip` site without one; three calls do not beat one; no lookup = the old
  order; an unmonitored site stays last even with an open call.

### ⚠️ The compact card had grown to seven rows — icons, and a stopwatch without its own pill (14/10/2026)

The owner, looking at the card for Florentin (3468): *"זה לא הגיוניייי מה קורה פה"*. Measured first: **every item
on it was true.** A real fault at 16:08:07 ("מנהל דולים - דלתות חניון פתוחות", a site-level fault), unit 1
waiting and unit 2 in maintenance (both true at once — `displayStatusFor` takes the worst of *the site status and
the units together*, and that rule is itself the fix for two earlier wrong versions, recorded at this same site),
two open defects, an open service call, and `12:22` — which is **12 minutes 22 seconds**, the stopwatch format
below one hour, not a clock. Nothing was wrong except that the card was unreadable.

Her choice, given the options: **icons only, and keep the stopwatch.**

- **The tasks pill is an icon in compact**, like the calls pill since the morning. 67px → 40px. The full label
  stays in `aria-label` and `title`.
- ⚠️ **And the real culprit was the stopwatch's own pill.** Inside the card pill the `FaultTimer` drew its own
  background, 2×8 padding and a pulsing dot — 27px of chrome inside a 110px pill, in a row that has 180px for
  three items. It is now plain text there (`.tk-card-btn .fault-timer`), and the dot is hidden: the pill is
  already drawn, and the whole card already pulses. In the calls dialog and on the expanded card it is unchanged.
- **Measured in the harness at 1371px, 79 cards:** the end group needs **172px of 180** and no longer wraps on any
  card; every card is **100px** again instead of 124. `probe-tasks` 225/225, `probe-calls` 30/30,
  `probe-calls-today` 20/20.
- ⚠️ **The measurement itself was wrong first, and said "2 rows" about every card.** It counted distinct `top`
  values among the children — but items of different heights on the same line have different tops. Count rows from
  the container's height divided by the tallest child, not from `top`.
- **Declined, and worth recording:** hiding the two system chips on the collapsed card, moving the code back to the
  name row, and hiding the compliance lamps during a fault. All three stay.

### Does the pulse stop when Wizenet close the call? Yes — and here is where it does not

Traced end to end on 14/10/2026 and measured, not assumed: **39 calls moved to a status marked closed, and all
39 read `open = false`** — no false positives. Wizenet do send a new row on every status change (44 of 69
tickets have more than one status), the AFTER INSERT trigger publishes an `events` row in the same transaction,
`events` is in the `supabase_realtime` publication, `App.jsx` calls `loadCallCounts()` on that event with no
debounce, `service_call_counts` is live SQL (no cron table in the way), and `has-open-call` is applied on
`openCalls > 0` alone. So the pulse stops a second or two after the status changes, with no refresh and no
click. What stays is the pill with the day's count — no accent frame, no stopwatch.

The ways it does **not** stop, in order of how much they matter:

- ⚠️ **A status Wizenet add tomorrow would pulse forever, and there is no working path in the UI to add it to
  the list.** An id that is not in `wizenet_lookups` counts as open (deliberate: better to show a call that may
  be closed than hide an open one). But the only way to add one is `wizenet_lookups_save`, reachable solely
  from the `wizenet` Edge Function — and both links to it are hidden while `SERVICE_CALLS_WRITE=false`, and
  even if shown, WIZEAPI blocks access from outside Israel. Today it is hand SQL or nothing. The live proof is
  `TEST-001` with `status = 'test'`, open for nine days.
- ⚠️ **A repeated failure of the counts RPC leaves the card pulsing, silently and indefinitely.**
  `fetchServiceCallCounts().catch(() => {})` keeps the previous numbers so the button does not vanish — but
  the price is a pulse that lies, with none of the dashed "not loaded" treatment the compliance lamps have.
- ~~**A missed Realtime event costs up to 5 minutes.**~~ **Fixed 18/10/2026:** the channel's recovery and the return
  to the tab now run `onRecover` in `App.jsx` — `syncNow` plus the call counts and the task counts (two light calls,
  the same ones the 5-minute timer runs). Realtime still does not redeliver, so an event missed while the tab stays
  visible and connected waits for the timer; a frozen tab catches up on return.
- **Three statuses left `closed = false` mean the call is parked, not active:** `156 מתקן מושבת (באישור מנהל)`,
  `157 יש לחזור ללקוח עד התאריך שבהערות`, `155 טכנאי יצא מהאתר לא להשתמש`. A call parked on one of those pulses
  for days and the stopwatch keeps running. By definition, not a bug — but it is the real answer to "when does
  it stop".
- **Two open calls at one site:** closing one does not stop the pulse. `open` is a count.
- ⚠️ **An event with no `status` key would turn a closed call back into a pulsing one** (NULL → not in the
  list → open). Not observed: all 130 rows carry `status`. But the feed does already contain one row of
  another shape, carrying an `event` key and no `opened_at`.
- **The current state is the last row by our own id, not by their `updated_at`.** A redelivered older event
  after the closing one would reopen the call. Measured: in 69 of 69 tickets the highest id is also the newest
  `updated_at`, so this is structural only.
- ~~**An unmonitored site never pulses at all**~~ (fixed 15/10/2026, see *Still open* below: it pulses now) — the `monitored === false` branch returned early without the
  class, though it does show the pill. The pulse was asked for so people would notice; at Sotefin sites it does
  not happen.
- `prefers-reduced-motion` on a VIP site: the static ring is overridden by `.is-vip`'s own `box-shadow`, so
  only the border colour changes. It still clears with the class.

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
| Inspector tab, PM tab | `InspectionTab.jsx` (a tab in the site window, `InsightsModal`), `PmTab.jsx` (+ `Inspection*`, `Defect*`, `Pm*`) |
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
- ⚠️ **"בודק מוסמך" is a tab in the site window again, like "תחזוקה מונעת"** (owner, 13/10/2026, pointing at
  the PM tab: *"אני רוצה שבודק מוסמך יהיה בתוך חלונית כמו זה"*). From 05/10 to 13/10 it was a full page
  (`InspectionPage`, deleted; `git show cf84e50:dashboard/src/components/Compliance/InspectionPage.jsx`).
  The card lamp and the supervisor table now open the window on that tab, exactly like the PM lamp.
  The window renders `InspectionTab` with `dropAnywhere`, so a PDF dropped anywhere in the window opens
  the upload. Browser: `e2e/probe-insp-window.mjs` (21); `run.mjs` S1/S9/S13 and `probe-overdue` follow it.
- **Dragging a PDF** (managers only) opens the same upload flow with the file already read. In the
  window a file dropped **anywhere** opens it, unless a dialog is already open — then it is ignored,
  so it cannot replace a form being filled. In the window tab a drop outside the zone is swallowed.
  Either way the browser must never open the PDF in place of the dashboard: in the window that holds
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
constraint, same check). ✅ **The inspector is on the live site (Pages) since 06/10/2026; preventive maintenance since 13/10/2026 (see *Maintenance profiles*); before that preventive
maintenance was not** — owner: *"לדחוף רק את הבודק מוסמך"*. One switch hides it everywhere:
`PM_ENABLED` in `utils/compliance.js` (env `VITE_COMPLIANCE_PM=false` turns it off; default on since 13/10), read through
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
    fine. **The rest of the dashboard was checked on 13/10/2026.** A browser sweep over every screen (any element
    with Hebrew text and a computed weight ≥800) plus a read of the rules it could not reach (closed
    `<option>` lists, the executive view, PM) found nine: the expanded card name, `.exp-value--sm`, `.it-due--late`
    / `--soon`, `.ex-head h1`, `.ex-insights-btn`, `.rv-header h1`, `.pm-tpl-group` and the type filter group rows.
    All are 700 now. `tests/hebrew-weight.test.js` lists every remaining ≥800 rule with what it shows (digits,
    symbols, "Parkomat"); a new one fails until someone looks. 6/6 mutations caught.
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
- ~~**The live load runs every 5 min**~~ **— not since 19/10/2026; see *No live load from a timer* below.** It runs
  immediately on a status mismatch: `sites`, `site_globals` and compliance. It is `withStats: false`. The statistics
  fields are carried over from the screen (`keepLastStats`, `STATS_FIELDS` in `utils/siteSync.js`). A test checks
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
  ⚠️ **Until 13/10/2026 only two jobs used it.** `prune-events`, `cleanup-old`, `prune-ingest-drops` and
  `ingestion-health` were still `unschedule` + `schedule`: recreated on every apply (17 times in three days,
  a new `jobid` each time, so their run history split, and a manual pause would have been undone). All six go
  through `ensure_cron_job` now, defined before the first schedule; the file has no `cron.unschedule` left.
  `card-metrics.test.js` pauses all six, re-applies, and checks jobid, pause, schedule and command (5/5
  mutations caught). No apply was needed: the schedules were already identical, only the way of setting them changed.
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

## Sign-in history is not kept: `auth.sessions` is pruned to one day (18/10/2026)

The owner, shown 45,229 rows in `auth.sessions`: *"למה אתה לא מוחק את ההתחברויות? למה בכלל יש טבלה שנשמרת? זה לא
מעניין אותי בכלל מה התחבר! מצידי תשמור רק את של אותו יום"*.

- **Where the rows come from.** Every password sign-in creates a session, a refresh token and an `mfa_amr_claims`
  row; Supabase never deletes them by itself (session time-boxing exists on paid plans and was never turned on here;
  it would also sign *people* out on a timer, which is not what was asked). The agents sign in with
  the password every hour (`TokenPolicy`), and the `service-calls` Edge Function signs in on every request:
  43,660 agent sessions and 1,530 intake sessions since 15/09, 36 MB across the three tables, growing ~1 MB a day. It
  was the only growth in the database not proportional to anything useful.
- **`app.prune_auth_sessions(interval '1 day')`** in `db/cron.postgres.sql`, job `parkomat-prune-auth-sessions` at
  03:57 UTC: a session whose last use (`refreshed_at`, else `updated_at`/`created_at`) is older than a day is deleted
  with its tokens and claims. The deletes are explicit even though the FKs are `ON DELETE CASCADE` — those tables are
  `supabase_auth_admin`'s, not ours to rely on. `SECURITY DEFINER`, owner `postgres`, who has DELETE on `auth.*`.
  ⚠️ `refreshed_at` is `timestamp` **without** time zone (UTC); it is compared through `AT TIME ZONE 'UTC'`.
- **The cost, ordered explicitly:** a person who has not opened the dashboard for a day signs in again next time.
  Someone with the dashboard open daily (hourly refresh) stays signed in. Agents and the Edge Function notice
  nothing; they sign in again anyway.
- Applied 18/10/2026 and run once by hand the same morning (the backlog); afterwards ~1,500 a day. The structural
  fix on the agent side (refresh the token instead of a new sign-in every hour) is not built.
- Tests: `tests/prune-auth-sessions.test.js` (PGlite; the local `auth` stub in `tests/helpers/local-pg.js` now has
  the three tables with just the columns the function reads).

**The same audit, same day — what else is stored without a reader (181 MB in all, measured column by column):**

- **`cron.job_run_details` — pruned to 14 days** (`app.prune_cron_history`, job `parkomat-prune-cron-history`, 04:27 UTC;
  `tests/prune-cron-history.test.js`). pg_cron logs every run and never deletes: 74,266 rows since 24/08, 12 MB,
  0.27 MB a day, 1,440 of them from the minute-by-minute silence scan. No screen reads it; two gates
  (`check-alert-gate`, `check-dashboard-truth`) read the last two hours / one day. First run by hand: 50,770 rows gone.
- **`service_calls.headers` — 1.1 MB of the table's 3.3 MB, the single heaviest column (704 B a row), and nothing
  reads it.** Seventeen Cloudflare/AWS routing headers per webhook (`cf-ray`, `traceparent`, `x-amzn-trace-id`…),
  kept "in case Wizenet ever add a timestamp header"; measured on 14/10 that they send none. **Not stored since
  18/10/2026** (the `service-calls` Edge Function no longer sends the field; the column stays, NULL from now on;
  `remote_ip` is still recorded). ⚠️ The function is deployed with `--no-verify-jwt` — Wizenet send no token, and a
  deploy without the flag turns verification back on and rejects every call. `raw` and `payload` are deliberate duplicates
  (raw is the source of truth). The approved 30-day retention of closed calls is still **not** applied (0 rows are
  old enough yet; the table started 05/10).
- **PDFs are base64 text: 47 MB stored for 36 MB of documents.** `data_b64` costs 33% over `bytea`, on the largest
  table and on every future upload (photos, PM files and signatures use the same scheme; all empty today). The wire
  format can stay base64 (`encode(bytes, 'base64')` in `compliance_file`); the migration is the work. Also: 6 PDFs are
  stored twice under two sites each (1226 + 1048 five times, 1232 + 1352 once) — identical `content_md5`. Whether a
  report may belong to two sites is the owner's call; the dedup check is per machine, so it never saw them.
- **Dead space, not growth:** the three `auth` tables keep their 36 MB after the delete (Postgres reuses, does not
  return; `VACUUM FULL` would, with a short exclusive lock on sign-ins), `ingest_drops` holds 4.4 MB of heap for
  ~0.5 MB of rows (the 8,905 `state_no_change` rows deleted on 12/10). WAL is 128 MB and both Realtime slots retain
  110 kB — nothing hidden.
- **Earns its place:** `operations` indexes are 14 MB against 7.7 MB of rows, but every one is used millions of
  times (`ux_operations_dedup` 8.2M scans, `idx_operations_site_time` 8.3M); `events` is on its 7-day prune (oldest
  row 11/10); `suppressed_faults` (0.6 MB) feeds the insights window; `audit_log` (1 MB) is attribution; `ff_faults`
  (4.5 MB, 4.3 KB of handling text a row) is the FixFlow library. The ISO-text timestamps (25 B each, three per
  operation) cost ~5 MB across the big tables — a legacy of SQLite, not worth a migration.

## "שנה, יומי" on the executive page timed out, and the fix is one scan for all buckets (18/10/2026)

Found by `check-row-cap` on 15/10 and left open then: `executive_series_json` with 367 daily buckets came back from
PostgREST as `57014 canceling statement due to statement timeout` after 8 s. The gate printed it as `-1 איברים`, which
looks like the 1,000-row cap and is not. Nobody saw the error in the UI: the year view simply never loaded.

**Measured first, in production (direct and through PostgREST agree):**

| | before | after |
|---|---|---|
| year, daily (367 buckets), one call | 13.4 s | 2.9 s |
| month, daily (32 buckets), the page default | 3.9 s | 1.6 s |
| `pg_stat_statements` since 07/10 | 2,030 calls, mean 4.2 s, 2.4 h of DB time | |

- **Where the time was:** `site_uptime` once per bucket (`CROSS JOIN LATERAL`), 367 index scans of `status_history` at
  18 ms each — 3.7 of 4.8 s in a 120-bucket chunk. The index `(site_id, started_at)` does not serve the predicate: the
  selective condition is on `ended_at`, so every bucket read ~9,000 rows and filtered 8,870. Three more pieces cost
  ~0.7 s each: matching buckets to elementary segments by comparing every bucket with every segment (134,000 text
  comparisons under collation), twice, and the fault-to-bucket range join (367 × 1,210).
- **`app.site_uptime_buckets(p_site_ids, p_buckets)`** (`functions.postgres.sql`, right before `executive_series`) reads
  `status_history` **once** over the span of all buckets, attaches each segment to the buckets it overlaps through the
  sorted bucket edges (`width_bucket` on its start and end, like the operations since the morning), and then applies
  **exactly** `site_uptime`'s predicates and clipping per (segment × bucket): the same `LEAST(to, now)` window, the
  same ISO-text overlap test, the same `timestamptz` clipping, the same merged maintenance windows per (bucket × site),
  the same sums and rounding. The edge matching is only a prefilter; the original predicate decides, so a segment that
  merely touches an edge is excluded exactly as before. It returns only the three columns `executive_series` consumes;
  `site_uptime` stays the source for the cards and for repair/planned/excluded.
- ⚠️ **Two things the gate caught before production did.** (1) `LEFT JOIN` to the merged windows, then
  `LEAST(w.e, seg_end) - GREATEST(w.s, seg_start)`: with no window the join gives NULLs, and `LEAST`/`GREATEST` **ignore
  NULLs**, so a site with no maintenance window at all got 24 hours of maintenance in every bucket. The original
  correlated subquery never sees a non-matching window. (2) `FROM errs e, edges ed JOIN seg_bucket sb ON … e.started_at`
  — with a comma the `ON` cannot see `e`, and PGlite **hung** on the error instead of reporting it (the test run had to
  be killed after 5 minutes). It is `CROSS JOIN` now.
- ⚠️ **Per-segment grouping was the second cost, not the scan.** The first correct version computed coverage per
  (segment × bucket): 107,000 rows sorted and grouped, 2.3 s. The same arithmetic as two sums per (bucket, site, status)
  — durations, minus intersections with the merged windows, which are disjoint — is exact (`EXTRACT(EPOCH)` is `numeric`)
  and takes 1.7 s for the whole function. A `plpgsql` fence against inlining was measured and changed nothing.
- **Proof, both sides:** `tests/uptime-buckets.test.js` (PGlite: segments crossing edges, open segments, a segment
  ending exactly on an edge, excluded and reclassified rows, overlapping and cancelled windows, a two-day bucket, the
  total bucket, a future bucket, a bucket clipped to now, an inverted bucket, a site with no history, a site filter,
  and `executive_series` itself) and `tools/check-uptime-buckets.js` (production, read only: year daily/weekly/monthly,
  month daily, week daily, a 5-site filter — both sides in one transaction so `now()` is identical; registered in
  `gates.js`). Before the apply, the new `executive_series` was compared with the HEAD version on all nine columns in
  six configurations inside a rolled-back transaction: **0 differences** (78,538 rows for year daily).
- ⚠️ **Splitting the year into several calls was built, measured, and dropped the same day (18/10/2026).** The dashboard
  sent the 367 buckets in calls of 120 (`chunkBuckets` / `mergeChunkedSeries`, the total bucket alone), written while the
  SQL still took 10.9 s, as a safety margin under the 8 s timeout. Measured in production after `site_uptime_buckets`,
  both sides in one transaction (identical numbers: 2,764 rows, 0 differences): one whole call **3.6 s**; five chunks in
  parallel, as `Promise.all` sends them, **4.6 s** until the last one returns, the slowest chunk 4.6 s, and **7.7 s of DB
  time** in all. Every call pays ~1 s of fixed cost (the fault fold over the whole range, `app.error_segments`), and five
  calls contend for Micro's CPU. So the split was slower for the person, doubled the load, and brought the slowest call
  *closer* to the timeout than the whole call. It is not in the code; the measurement is recorded here so it is not
  rebuilt without measuring. The dashboard sends one call with all buckets, as before, and `check-row-cap` sends the same — and since the same
  evening it **times** it and goes red above 5 s (`SLOW_MS`), printing PostgREST's error text instead of `-1` when the
  answer is not an array. Measured 3.4–4.7 s through PostgREST; it grows with the site count, and the gate is how the
  approach to the 8 s timeout is heard months before the graph stops loading. Proven red with a 1 ms copy.
- **A failed load is now visible on screen.** `ExecutiveView` showed an error only with no data at all (`error && !data`).
  Switching from month to year keeps the month's data, so a failed year load left the month on screen with no sign — which
  is why the timeout went unseen for days. A load that fails while data is on screen now shows a line above the header
  (`.ex-stale-error`) saying the current selection failed and that the previous numbers are shown; `fetchRunner` clears
  it at the start of the next load.
- **Mutations, in an isolated copy (deleted afterwards — it carried a copy of `.env`): 8 of 14 caught.** The six
  survivors are equivalent by construction, and that is the point of the design: the edge matching is a *prefilter* and
  the original predicate decides, so dropping the ended_at test in `clipped`, letting a bucket take the segment that
  starts at its own `w_to`, or removing `seg_end > seg_start` from `dur` changes nothing — the other guard still
  holds. Likewise `w.e >= seg_start` adds a zero-length intersection, a cancelled window filtered by its expiry is
  then dropped by `e > s`, and merging windows without the bucket partition cannot bridge two windows of one bucket
  (any bridging window of the same site exists in that bucket too, clipped). The guards stay because they mirror
  `site_uptime` line by line; a reader comparing the two should find the same tests in the same places.
- ~~**Still open, measured, not fixed:** `app.error_segments` itself is ~0.8 s for a year~~ **Fixed in the repo the same evening with
  one partial index, no change to the function — applied to production the same evening at the owner's word ("תעשה בעצמך"); the planner uses it: 0.019 ms per fault, the function 321 ms under EXPLAIN.** The cost was SubPlan 2: for each of 1,226 faults an index scan on
  `idx_status_hist_site` that read ~600 rows and filtered them on `COALESCE(reclassified_to, status) = 'maintenance'`
  (0.415 ms × 1,226, 440k buffer hits). Maintenance segments are 1,553 of 52,795 rows, so
  `idx_status_hist_maint ON status_history(site_id, started_at) WHERE COALESCE(reclassified_to, status) = 'maintenance'`
  (`schema.postgres.sql`) reads 18 rows per fault: measured in production inside a rolled-back transaction, 0.017 ms per
  fault, the function 830 → 315 ms under EXPLAIN. ⚠️ The predicate must stay **word for word** the one in the function,
  or the planner cannot prove the index covers the query and ignores it; `tests/error-segments.test.js` E4 pins both
  texts. ⚠️ The index must be created **after** the `DO` block that adds `reclassified_to` (same reason as
  `reported_at`): placed in the main index block it broke `db.init()` on every fresh database, and every local test with
  it. A rewrite that pulled the maintenance segments into a CTE was measured first and gained nothing: the planner
  inlined it back into the same per-fault SubPlan.
- **`app.error_segments` has its own local test now** (`tests/error-segments.test.js`, E1–E4: which faults count,
  `ended_at` exposed, both maintenance sources with inclusive boundaries, cancelled and excluded windows, reclassified
  and open segments, another site's segment, a fault that started before `p_from` and ended inside it). Until then its
  only coverage was `tools/parity.js` against production. 10/10 mutations caught in an isolated copy; the `>= p_from`
  one survived until the overlapping-fault case was added, because a fault that *ends* before the window is already
  dropped by `site_segments_collapsed` itself.
- **The dry run now compares indexes on every `public` table**, not only `CON_TABLES` (`tools/lib/sql-shape.js`): the
  new index did not show as a gap at all and `--apply` would have created it unannounced. Indexes that exist only in
  production on tables the code does not know (the seven `push_*` ones from
  `supabase/migrations/20260819_push_notifications.sql`, which `apply-sql` never runs) are skipped, so the report stays
  readable; a table missing from the code entirely is still something the dry run does not see.
- ⚠️ **Deploy order: SQL first** (`apply-sql` dry run shows exactly two gaps: the new function and the body of
  `executive_series`). The dashboard change (the error line) does not depend on the SQL.

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
    ⚠️ **Since 19/10/2026 it is a `ChoiceSelect`, not a text field with a `<datalist>`.** From the field: *"אם אני רוצה
    להוסיף, קיים לי רק חשמל"* — a new item inherits the last item's group ("חשמל" in the base list), and a datalist
    offers only what matches the text already in the field, so "לובי" appeared only after clearing it. The picker always
    lists every group of the list, then "בלי קבוצה — שם הרשימה", then "+ קבוצה חדשה…", which swaps in a focused text
    field for that row (Enter, Esc or leaving it returns to the picker). `probe-groups` E1b–E1e (the reported case) and
    E3–E3d, 24/24.
    ⚠️ **Two defects found by the review the same evening, fixed:** Esc in that field reached the site window
    (`InsightsModal` closes on Esc at `document`), which closed or asked "לצאת בכל זאת?" and dropped unsaved edits — the
    handler now calls `stopPropagation` (the list-rename field too). And choosing "+ קבוצה חדשה…" by mistake erased the
    item's group: the previous group is remembered (`newGroupRef`) and restored by Esc, or by leaving the field empty;
    the ref makes the restore happen once, so a late blur cannot undo it. `probe-groups` E1f–E1i (28/28); UI mutations
    in a separate copy 4/4 caught. ⚠️ **Harness:** a separate copy for UI mutations must repoint `e2e/main.jsx`
    (absolute import of `App.jsx` from the repo), use the long path rather than `746F~1` (Vite's allow-list compares
    resolved paths), and allow the real `node_modules`.
  - **The base list has three groups since 19/10/2026: לובי (5), בטיחות ומרתף (3), חשמל (11).** From the field (on
    גרוזנברג 7): *"דלתות מרתף, קופסת מפתח… אלה דברים שקשורים למרתף, לא ללובי"*. The document puts its section 4
    "בטיחות" (parking doors locked, the key box, harnesses at the basement entrance) on the "לובי החניה" page, which is
    why they were loaded under "לובי"; the owner chose a group of their own. Written through `pm_template_save` (stale
    check, history, audit) as a temporary editor named "Claude — קבוצת "בטיחות ומרתף" לבקשת הבעלים", deleted in the same
    transaction (`compliance_history.actor_user_id` is `ON DELETE SET NULL`; the name stays in `actor`). Visits opened
    before keep their snapshot (4 drafts: 1326, 1079, 1297, 1342).
  - ⚠️ **"Where is the mechanical maintenance?"** — it exists and is not in the base list. A site gets the base list
    plus the lists of its machine types: גרוזנברג 7 (2222: piston 1 + XY) gets 46 items — the base 19, "מעלית
    הידראולית" 21 (יחידת כוח, בוכנה, שרשרת, פילוס) and "מיטת XY במרתף" 6. The editor shows one list at a time (the
    picker at its top), which is how only "לובי" and "חשמל" were seen. The document has no section named "mechanical";
    its machine parts are per type.
    A heading appears where a group starts. A new item inherits the last item's group.
  - Tests:
    - `pm-templates.test.js`: 2 tests, 10/10 SQL mutations caught.
    - `probe-groups.mjs` in the scratchpad harness: 17/17, 12 UI mutations.
- ⚠️ **The owner's instruction for new sites is addressed to Claude, not the UI:** *"from now on,
  every time a facility is added you'll need to ask which maintenance to attach to it; usually
  the answer will be like another project"*. When registering a site, **ask** which **profile** it
  gets (since 13/10/2026 the registration form has an optional "פרופיל תחזוקה" field, shown only
  when PM is enabled).
- **Pending from the owner:** the codes for the 12 Sotefin sites (Kaplan 8 + 11). The documents are read
  (13/10/2026, below); the lists are not loaded into production yet. ("אביגיל 18" doesn't exist; it is
  אביגיל 20, 1343, already in the system — and the robotic-parks document lists אביגיל 20 under hydraulic.)

## Maintenance profiles — "like the traffic light" (built 13/10/2026; PM ON on the live site since 13/10/2026)

⚠️ **Since 20/10/2026 a profile no longer decides a site's lists** — see *A site's maintenance is what was chosen for
it* below. The tables and RPCs stay as data; the board and the profile pickers are gone from the UI.

The owner: *"כיון שיש תחזוקה שמתאימה להרבה אתרים אותו דבר — שנקשר את האתר לתחזוקה שמתאימה לו כמו ברמזור"*,
and for the lamp: *"ירוק תקין, צהוב צריך להתכונן לתחזוקה, אדום לא תקין"*. Her choices: a profiles board,
green for PM only (the inspector keeps the black frame), Sotefin sites wait for codes, and PM is turned on
on the live site only after she reviews it.

- **A profile = a name + lists + sites; a site is in one profile** (`pm_profiles`, `pm_profile_templates`,
  `pm_profile_sites` — PK is the site). Closed tables like the rest of compliance; all access via RPCs.
  They live in `compliance.postgres.sql`, not a new file: `app.pm_site_template_ids` is `LANGUAGE sql` and
  is validated at creation, so the tables must exist before it.
- **`app.pm_site_template_ids` is still the one place:** profile → the old per-site assignment
  (`pm_site_templates`, empty in production) → the default list. A profile whose lists are all inactive
  falls through. A visit already open never changes (items are snapshotted).
- **RPCs:** `pm_profiles_list()` (staff; one jsonb, with `unassigned`), `pm_profile_save(id, name,
  template_ids, expected_at, site_codes)` (PT409 on a stale board, ≥1 list, the 40-photo cap across its lists, unique
  name ignoring case/spaces; `site_codes` NULL = sites untouched), `pm_profile_delete(id)` (sites return to the
  default), `pm_profile_sites_set(id, codes, expected_at)` (target state; a site from another profile **moves**),
  `pm_site_profile_set(code, id|null)`. The 4-arg save and 2-arg sites_set are dropped (deploy: SQL first).
- ⚠️ **Review fixes, 13/10/2026 (before PM went live):**
  - The board saves name, lists **and sites in one call**. Two calls left a half-saved profile when the second failed.
  - Every change to a profile's sites bumps `updated_at` of the profile it touched **and of the profiles sites
    moved out of**, so a board opened earlier gets PT409 instead of silently moving a site back.
  - Every writer takes `app.pm_profiles_lock()` (`SHARE ROW EXCLUSIVE` on `pm_profiles`) first: one order for all,
    so two concurrent moves cannot deadlock or race on `pm_profile_sites`.
  - `pm_template_save` checks the 40-photo cap of **every profile that holds the list**, not only the list alone.
  - A value item's threshold must be a number ("הסף בפריט % חייב להיות מספר"); `app.pm_value_num` and `valueNum`
    trim the same characters (space, tab, CR, LF — not NBSP).
  - Not fixed, deliberately: labels for old per-site assignments (`pm_site_templates` is empty in production), and
    no event on a save that changes only the name or lists (no lamp depends on them).
  - Tests: `pm-profiles.test.js` 21; 6/6 review mutations caught (`mut-profiles.cjs`, isolated copy).
  Manager-only writes; `audit_log` gets ids only; a `compliance` event per site that changed (a no-op
  writes nothing). `pm_site` returns `profile`.
- **UI:** "לוח פרופילי התחזוקה" in the PM tab's manager tools (`PmProfilesBoard.jsx`) — rows, not boxes;
  search adds a site and says where it is now ("יעבור מ…"); delete needs a second click. The site row
  (`PmSiteLists.jsx`) is now "פרופיל תחזוקה: X · שינוי" (a `ChoiceSelect`), with the lists read-only below.
  `AddSiteModal` has an optional profile field; a failure there does not fail the registration.
- **Green:** `--cl-pm-ok-*` in `ComplianceLights.css`; every lamp goes through `complianceColor(state,
  area)` (`utils/constants.js`), never `COMPLIANCE_COLORS[state]` directly (the inspector page excepted).
  `check-colors.mjs` checks the PM set (pm-ok/soon/expired/none) is distinct, readable, and actually green.
- **The "value" item** (`kind='value'`, `unit`, `warn_above`): the document's chain gauge — *"להשאיר מקום
  להזין כמה אחוזים תוצאת המדידה"*, report above 2%. The measured value travels in `pm_visit_items.note`
  (the path the offline outbox already syncs), so a value item has no free-text note. "Measured" =
  `app.pm_value_num` (`-?\d{1,9}([.,]\d{1,4})?`), mirrored by `valueNum` in `PmUtils.js` — a required value
  blocks submit until a number is entered; above `warn_above` it is marked in the form and the view.
  CHECKs replaced with DROP/ADD NOT VALID/VALIDATE (`pm_checklist_items_kind/_photo_shape/_value_shape`,
  `pm_visit_items_kind`).
- **Tests:** `pm-profiles.test.js` (17; 22/22 SQL mutations caught, 2 survived until their cases were
  added: an inactive list in a profile, and a no-op re-assignment), `compliance-ui.test.js` (green + value
  helpers). Browser `e2e/probe-pm-profiles.mjs` (109, 1280/390 × light/dark; 11/11 UI mutations caught by
  `mut-pm-ui.mjs` on a separate tree, because her Vite runs on the repo), `probe-lists` L1/L6/L7
  updated to the profile row, `probe-overdue` expects the extra "תחזוקה בתוקף" legend row when PM is on.
- ⚠️ **Harness trap found on the way:** the Wizenet mock had set `window.__calls`, the inspector mock's
  name — marking a defect done threw "reading 'push'" and `run.mjs` / `probe-overdue` stopped at S2. Now
  `window.__serviceCalls`.
- **The content (from Downloads\תחזוקה, read 13/10/2026):** `scratchpad/pm/harness/docsLists.js` (131 items,
  10 lists) matches the documents. ⚠️ Gaps: the electric-lift section is unfinished in the document
  ("@לביא"); the Sotefin R&P document has only the lift (shuttle/dolly/lobby rows are empty); Kaplan 8's
  maintenance-program table (manual pp. 36–38) is scanned images — review before use. The content is
  **not** in the repo (public; one source is Sotefin's manual) and is loaded once via the RPCs.
- **In production since 13/10/2026** (SQL applied, "הייצור זהה לקוד"; loaded through the RPCs as a temporary
  manager named "טעינה מהמסמכים (Claude)", deleted afterwards — that name is what the history shows):
  - 10 lists, 131 items. The default list was renamed **"בסיס פרקומט — לובי וחשמל"** (19 items) — a site with no
    profile gets it (owner's choice; it had been an empty "משותף", so no visit could start).
  - 11 profiles, 68 sites, by the lift and machine type on each site: lift — piston = הידראולית, `electric` and
    **"4 עמודים" = חשמלית** (owner's call); floor — `doli` = דולי, `xy` = מיטת XY, `x/y/matzbet-*` = מיטת X/Y.
    1384 (רופין 20) also gets במת XY, so it has its own profile. 1343 (אביגיל 20) is "הידראולית + דולי" (owner).
    Two Sotefin profiles exist with no sites (R&P; Kaplan 8 marked "לבדיקה"), waiting for the codes.
  - 10 sites have no lift/machine type and no profile: 1033, 1047, 1077, 1082, 1106, 1122, 1225, 1227, 1304, 1376.
  - "אקסטרקטור" is loaded but on no profile: the document names עוזיאל 122, which is not a site in the system.
- ✅ **PM is ON on the live site since 13/10/2026** (owner: *"אני עכשיו חזק על התחזוקה אני רוצה שתדחוף את זה"*).
  The default in `utils/compliance.js` was flipped (`VITE_COMPLIANCE_PM` unset = on; `=false` turns it off),
  because nobody configures Pages env vars here. `compliance-ui.test.js` pins the new default and tests the off
  mode with `["inspection"]` passed explicitly. Every site's PM lamp is red until its first visit (intended); on
  the board it shows only when "תחזוקה מונעת" is chosen in the header filter.
- Tests: `pm-templates.test.js` (12 tests, 10 mutations caught),
  `register-site-unmonitored.test.js`, `sort-sites.test.js`, and `supervisor-shape.test.js`
  (unmonitored case). The browser probe is `e2e/probe-lists.mjs` (scratchpad harness, 14/14,
  run with `VITE_COMPLIANCE_PM=true`, 10 UI mutations caught).

## Maintenance lists by site type — auto, two lifts = two lists, multi-select per site (built 15/10/2026)

⚠️ **Superseded on 20/10/2026: nothing reaches a site by its type any more** — see *A site's maintenance is what was
chosen for it* below. The classification (`category`, `auto_for`) stays: the category places a list in the site's
selects, and `auto_for` feeds the "לפי סוג האתר" hint.

The owner, back on the robotic sites: *"אני רוצה שתסווג לפי מה שמסומן הסוג של האתר. אם יש שתי סוגי מעליות אז שיהיה את
התחזוקה גם של זה וגם של זה. אני רוצה אופציה לערוך את התחזוקה — תסדר את זה לפי סוגים: XY, X או Y, מעלית כזו, מעלית כזו,
ואפשר יהיה לעשות בחירה מרובה. אבל מלכתחילה תשים לכל אתר את מה שמתאים לו ואפשר יהיה להוסיף ולשנות"*. And on the
editor's native `<select>` list: *"תעצב את זה יפה"*.

- **Two columns on `pm_templates`:** `category` (`base` / `lift` / `floor` / `other`, for ordering the pickers) and `auto_for`
  (`text[]` of `lift:<lift_type>` / `floor:<plc_type>` keys from `shared/lift-types.mjs` and `shared/site-types.mjs`). A list
  reaches a site **by itself** when one of the site's type keys (`app.pm_site_type_keys`: `plc_type`, `lift_type`, `lift2_type`)
  is in its `auto_for` — so two lifts of different types give two lift lists, two of the same type give one. `app.pm_auto_template_ids`
  = the default list + every matching active list; **empty** when nothing matches (a site with no type, or a type with no list),
  so such a site falls through to its profile — the multipliers and Sotefin keep theirs.
- ⚠️ **The order changed (`app.pm_site_template_ids`): manual per-site → by type → profile → default.** Until 15/10 the profile
  came first and the per-site assignment (`pm_site_templates`, empty then) second. Manual is now the owner's last word on
  one site ("אפשר להוסיף ולשנות"); the profile is for sites without type fields. `pm_site` returns `templates_source`
  (`explicit` / `auto` / `profile` / `default`), `auto_template_ids` and `type_keys`. `pm_templates_list` carries
  `category` / `auto_for`. New RPC `pm_template_meta_set(id, category, auto_for)` (manager; the default list may only be
  `base` with no keys; keys are checked by shape only — the type lists live in `shared/*.mjs`, not in SQL; it publishes a
  `compliance` event per site whose lists come from its type).
- **Seeded in production (15/10):** הידראולית ← piston 1/2; חשמלית ← electric, 4 עמודים 18/11 KW; מיטת XY ← xy; מיטת X/Y ← x, y,
  matzbet-x/y; דולי ← doli; במת XY and אקסטרקטור are `lift` / `floor` with no keys (no site type for them yet); Sotefin and
  the multipliers are `other`. Simulated first: of 84 monitored sites the automatic result equals the 13/10 profiles for 69,
  gives lists to **3 sites typed after 13/10 that had none** (1077, 1082, 1227 — exactly the gap she described), and 1384
  (רופין 20, also במת XY) is written as a manual assignment. 11 monitored sites have no type that maps (serapid, scissors,
  shuttle, or none) and stay on the default. 1206 holds a manual assignment made by a manager the same day — left as is.
- **UI — the site's PM tab (`PmSiteLists.jsx`):** one line "רשימות תחזוקה: A · B · C (אוטומטי לפי סוג האתר)", a quiet
  "פרופיל: X" line, and for a manager "שינוי": every list as a checkbox **grouped by category**, what the site gets now
  pre-checked, the base locked ("לכולם"), the site's type keys in words, the profile picker underneath. One "שמירה": lists
  are written as manual **only if the checkbox set changed** (otherwise choosing a profile alone would freeze today's lists
  as manual); the profile is written only if it changed. "חזרה לאוטומטי" (shown when manual) clears the manual rows.
- **UI — the list editor (`PmTemplateEditor.jsx`):** the picker is a `ChoiceSelect` grouped by category (`ChoiceSelect` now
  accepts `group` on an option: a heading row before the first option of each group, not focusable), 380px wide so the
  long names do not wrap; under the bar `PmTemplateMeta.jsx` — category + chips of lift / machine types the list applies to.
  ⚠️ `key={current.id}`: without it the form showed the previous list's classification for one render (caught by the probe).
- Pure rules in `utils/pmLists.js` (`PM_CATEGORIES`, `groupTemplates`, `typeKeyOptions`, `typeKeyLabel`, `sourceLabel`,
  `initialSelection`, `lockedIds`). Tests: `pm-auto.test.js` (6; precedence, two lifts, no-type sites, type change,
  `auto_for` change, validation, idempotency), `pm-profiles.test.js` (the precedence test rewritten), `pm-lists-ui.test.js`
  (6). Browser: `e2e/probe-pm-types.mjs` (28; `?pm=docs&types=floor:xy,lift:electric` — the PM mock now resolves lists like
  SQL and exposes `templates_source`), `probe-lists` 15/15 and `probe-pm-profiles` 133/133 updated to the new rows. Full
  `npm test` 1158/1158. **Mutations (isolated copy `scratchpad/sqlmut`, `pmauto/mut-pm-auto2.cjs`): 9/9 caught** — no base
  in the auto set, the second lift ignored, type before manual, "base only" instead of empty when nothing matches (which
  would override every profile — 19 failures), the default list accepting a classification, any key shape, profile before
  type in the source, keys not persisted, operators allowed. ⚠️ Write mutation runners with the Write tool and without
  backslashes (newlines via `String.fromCharCode`): both the Bash heredoc and the Write tool ate `\n` twice here.
- **Production audit (`pmauto/audit.cjs`, read-only, 18/19):** an independent JS recomputation of keys, auto set, source
  and resolved lists agrees with SQL for all 214 sites; two-lift site 1102 gets both; no monitored site in the multipliers
  profile; the only manual rows are 1384 and 1206. The one ⚠️ is a **question, not a bug**: the 88 multipliers on profile
  12 get list 11 alone, without the base "לובי וחשמל" — the automatic rule always adds the base, a profile does not.
  Whether a stacker needs the lobby/electrical list is the owner's call.

### Control system and console are type keys too; "לפי סוג האתר" in the PM tab (19/10/2026)

The owner, on a card badge "XY · ביטנקם · הידראולית בוכנה 1 · קונזול אורכי": *"צריך בתחזוקה לראות שיש מענה גם לביטנקם,
XY, הידראולית בוכנה 1, קונזול אורכי — מה שצריך ויש בשביל זה תשים"*. Measured first: machine and lift types were covered
(except shuttle-x and hydraulic scissors, 3 sites each), but the control system (ביטנקם 16 / לולק 68) and the console
(longitudinal 15 / transverse 55) were not keys at all, and the documents have no maintenance item specific to either.
Her answers: **both** (a per-attribute display, and classification by system and console), and **"אין צורך בתחזוקה
נפרדת"** — what has no list of its own is shown as covered by the general lists, not as missing.

- **`app.pm_site_type_keys`** now returns, in the badge's order: `floor:` → `system:<control_system>` → `lift:` →
  `console:<lift_console>` → the second lift and its console. `system:` is the Hebrew name itself, as in
  `sites.control_system` and `shared/control-systems.mjs`.
  ⚠️ No list is classified by system or console today, so **nothing changes** in which lists reach which site; the keys
  only make such a list possible. The day one is classified (say `system:סוטפין`), the type-before-profile order means
  the sites it matches get it automatically — including unmonitored Sotefin sites, which today live on their profile.
- **`pm_template_meta_set`** accepts `console:<ascii>` and `system:<1–40 chars, no space, colon or control character>`.
- **`pm_site.type_coverage`** (`[{key, lists:[{id, name, assigned}]}]`, the badge's order, a key once): the active lists
  classified for each attribute, and whether the site really gets each one now. The decision is SQL; the dashboard only
  translates (`coverageRows` in `utils/pmLists.js`).
- **The PM tab** (`PmSiteLists`) shows "לפי סוג האתר:" and a row per attribute: "מתקן: XY — מיטת XY במרתף", "מערכת:
  ביטנקם — מכוסה ברשימות הכלליות", "קונזול אורכי — …" (the console label already says "קונזול"). A list classified
  for the attribute that a manual choice or a profile left out reads "יש רשימה (X) — לא משויכת לאתר" in amber. An old
  database without the field shows no rows.
- **The list editor** (`PmTemplateMeta`) has two more chip groups, "מערכת הפעלה" (the four systems) and "קונזול".
- Tests: `pm-auto.test.js` (the badge order, a duplicate console once, a system-classified list reaching ביטנקם sites,
  either key enough, `assigned` after a manual drop, validation; the existing `type_keys` expectation now includes the
  console). **SQL mutations (isolated copy, `mut1910/run-mut6.cjs`): 7 of 7 caught.** `pm-lists-ui.test.js`
  (`typeKeyOptions` / `typeKeyLabel` for systems and consoles, `coverageRows`). Browser `e2e/probe-pm-cover.mjs` 17/17
  (rows and order at 1280 light and 390 dark, the unassigned row after a manual drop, the editor chips saved); the
  harness PM mock builds `type_coverage` like the SQL and accepts the new key shapes.

### The list editor opened from a site shows all of the site's lists, stacked (19/10/2026, evening)

The owner, on "עריכת רשימת הבדיקה (46)" at הרצל 50 that showed only "בסיס פרקומט — לובי וחשמל": *"צריך להיות הרבה
יותר — מעלית הידראולית, מיטת XY, למה זה לא מוסף שם"*. The lists were there, in the picker, one at a time — exactly what
was not visible (the second time that day someone saw only lobby and electrical). Her choice, of two: **all the site's
lists one under another**, over a button per list.

- **`PmListEditor.jsx`** (new) is the editor of one list: load, the stale-edit token, items, the group picker, save. It
  is the old body of `PmTemplateEditor`, moved unchanged. ⚠️ It reports `dirty` / `busy` up with `useLayoutEffect`, so
  the picker above locks in the same frame as the edit, not one frame later. ⚠️ It must **not** clear the "נשמר — N
  פריטים" message when it loads: the save itself reloads, and a reset there erased the message the moment it appeared
  (`probe-pm-profiles` V caught it). A list switch is a new instance anyway (`key`).
- **`PmTemplateEditor.jsx`** is now the frame: the picker, "+ רשימה חדשה", "שינוי שם" and the classification
  (`PmTemplateMeta`), and either one `PmListEditor` or, when opened from a site (`siteTemplates` = `pm_site.templates`,
  passed by `PmTab`), one per site list. The picker's first option is **"הרשימות של האתר הזה · N רשימות · M פריטים"**,
  and the editor opens on it; picking one list returns to the single editor with its classification (not shown in the
  stacked view); "שינוי שם" needs one list. Each section has a heading — the list's name, its item count and
  `sharedLabel`: **"משותפת ל-N אתרים — שינוי כאן חל על כולם"**, or "רק באתר הזה" — its own "+ הוספת פריט" and its own
  "שמירת הרשימה". The info banner is shown once, at the top.
- ⚠️ **Siblings need distinct keys:** `PmTemplateMeta` and the single `PmListEditor` sit in one parent, and both were
  keyed by the list id alone — React duplicated a component (two classification panels on screen). They are
  `meta-<id>` / `list-<id>` now.
- ⚠️ **Dirty and busy are computed over the lists on screen only**, so a list that leaves the site mid-load cannot
  leave a stale "busy" that locks the picker for good.
- **`pm_templates_list.site_count` now means the sites that really get the list** — once per site through
  `app.pm_site_template_ids` (`CROSS JOIN LATERAL`, ~0.5 s for all sites, measured in production; it runs when the
  editor opens and after a save). ⚠️ **The CTE must be `AS MATERIALIZED`.** The first apply (the same evening) took
  **3.4–4.0 s**: Postgres inlined the CTE into each list's correlated subquery, so the resolver ran per site × list.
  Measured read-only on the query alone: 4.0 s without, 0.4 s with. Re-applied at once under the same approval (same
  function, same numbers); 511 ms through the function afterwards. `pm-auto.test.js` counts the resolver's calls inside
  one transaction (`track_functions`) and demands exactly one per site; the mutation that drops `MATERIALIZED` is caught. Until then it counted only profiles and manual assignments, so since 15/10 (lists by
  type) "מעלית הידראולית" was counted through the old profiles only. Production numbers that day: base 126, hydraulic
  52, XY bed 30, electric 29, dolly 29, multipliers 89.
- Tests: `pm-auto.test.js` (`site_count` follows a new typed site and a manual drop, and equals the resolver for every
  list), `pm-lists-ui.test.js` (`sharedLabel`). Browser `e2e/probe-pm-sitelists.mjs` 15/15 (three sections in the site's
  order, the picker's label and total, each heading's count and sharing, an edit locks the picker and leaves the other
  saves disabled, the save writes one list only, "נשמר" stays, one list and back, 390 dark). `probe-groups`,
  `probe-lists`, `probe-pm-types` and `pm/run` (an empty-list check now waits for the text, since the frame appears
  before the list loads) follow the new shape; `probe-pm-profiles` 133/133, `probe-pm-cover` 17/17, `pm/run` 141/142.
- ⚠️ **Deploy order: SQL first.** Before it, `site_count` keeps its old meaning and the headings would show the wrong
  number of sites.
- **From the independent review of these commits (20/10/2026), fixed in the next change:**
  - A list that leaves the site's set while it has unsaved edits, or a save in flight, stays on screen, marked "כבר לא
    נבחרה לאתר — לשמור או לבטל את השינויים". Before, its `PmListEditor` unmounted, the edits were lost silently, and the
    close guard stopped asking. Removing a list in the selects above makes this easy to hit. The held ids come from
    `states` (dirty || busy), names from a ref of the last seen.
  - A rename draft closes on any view switch (`pick`). Before, "שינוי שם" left open on list A renamed list B after a
    switch, and in the site view (no `current`) crashed on `null.id`. "יצירה" / "שמירת השם" are disabled while dirty.
  - The classification save calls `onSaved` too, so the tab reloads its "לפי סוג האתר" hint. Create and rename do the
    same, and `PmTab` bumps `rev` on `PmSiteLists`, so a new list appears in the selects without closing the window.

### A site's maintenance is what was chosen for it — base for robotic, multi-selects, nothing automatic (20/10/2026)

The owner: *"אני רוצה שתעשה רשימה ויצטרכו לבחור מה אנו רוצים. יש כמובן בסיס — זה נמצא לכל האתרים. ואז צריך לבחור XY וכו'
(בחירה מרובה). ואז צריך לבחור מעליות (בחירה מרובה). עד שלא בוחרים אין כלום עדיין. יש כמה SELECTS, שם בוחרים בכל אחד מה
שצריך ולפי זה נוצרת התחזוקה המונעת"*. Her answers to three questions: **everyone starts from zero** (over keeping today's
lists as a choice, or keeping the type as a suggestion), **the selects live in the site's PM tab** (not in add-site or
the admin row), and **the base is for robotic sites only**.

- **`app.pm_site_template_ids` is now one rule:** a robotic site (`monitored IS NOT FALSE`) gets the default list (the
  base) plus its rows in `pm_site_templates`. A site without a controller gets only its rows. The type (`auto_for`) and
  the profile are not read. ⚠️ A stored row for the base decides nothing (a multiplier never gets the base through an old
  row, e.g. 1206), and `pm_site_templates_set` no longer stores it.
- **`templates_source`:** `explicit` (something beyond the base was chosen), `base` (robotic, nothing chosen), `none`
  (a multiplier with nothing chosen). `pm_site` adds `site.monitored`. `templates_assigned` ignores a base row.
  `auto_template_ids` and `type_coverage` stay, as hints; `assigned` in `type_coverage` = chosen.
- **`pm_visit_start` on a site with nothing** says "לא נבחרה תחזוקה לאתר — יש לבחור רשימות בלשונית "תחזוקה מונעת""
  instead of "רשימת הבדיקה ריקה".
- **The 40-photo cap:** at choice (`pm_site_templates_set`) it counts the base for a robotic site. On saving a list
  (`pm_template_save`), the profile check became a per-site check: every site whose lists include this one, its lists
  together, naming the site ("הרשימה משויכת לאתר X…"). A materialized CTE calls the resolver once per site.
- **`pm_template_meta_set` sends no events any more:** the classification no longer changes who gets a list. Until then
  it sent one `compliance` event per "auto" site (~70), and every open screen reloaded the lamps once per site.
- **The PM tab** (`PmSiteLists.jsx`, rewritten): "רשימות התחזוקה של האתר" with a fixed "בסיס" row (robotic only), then a
  row per group, **מתקן / מעליות / אחר** (`PM_CHOICE_GROUPS` in `utils/pmLists.js`, by the list's category; a list with
  no category, or a non-default `base`, goes to "אחר"). Each row is a `ChoiceSelect` with **`multiple`** (new: the value
  is an array, a pick toggles and the menu stays open, `aria-multiselectable`, and an option may carry a quiet `hint`,
  here the item count). Under the rows: "בביקור: N פריטים" from the draft, or for a multiplier with nothing, "לא נבחרה
  תחזוקה לאתר — עד שבוחרים, אין ממה לפתוח ביקור". A change shows "שמירה" / "ביטול" and is written only on "שמירה". An
  unsaved choice reaches the window's close guard ("בחירת רשימות התחזוקה של האתר לא נשמרה."). A בקר sees text. The
  "לפי סוג האתר" rows stay underneath, now reading "יש רשימה (X) — לא נבחרה לאתר".
- **The start button** on a site with no lists is disabled and says "לא נבחרה תחזוקה לאתר — יש לבחור רשימות למעלה".
- **Removed from the UI:** the profiles board (`PmProfilesBoard.jsx` / `.css`, deleted — `git show 61ba9f4:dashboard/src/components/Compliance/PmProfilesBoard.jsx`),
  the profile picker in the tab, and "פרופיל תחזוקה" in add-site. A new site starts with the base (robotic) or nothing.
  The editor's classification now reads "מתאימה ל", not "חלה אוטומטית על".
- Pure rules in `utils/pmLists.js`: `choiceGroups`, `baseTemplate`, `chosenIds`, `visitItemCount`, `sourceLabel` (new values).
- Tests: `pm-auto.test.js` rewritten (9: nothing chosen, choosing on a robotic site, a multiplier, type and profile no
  longer decide, validation, system/console hints, `site_count`, the photo cap with the base, idempotency),
  `pm-profiles.test.js` (the profile tests now assert that a profile decides nothing; the value-item tests use a
  multiplier and a choice), `pm-templates.test.js` (like another site, the cap at save), `pm-lists-ui.test.js` (+2).
  Full suite 1238/1238. **SQL mutations (isolated copy, `mut1910/run-mut8.cjs`): 12 of 12 caught** (base for every
  site, no base for a robotic site, a stored base row, lists by type back, the base stored, the cap ignoring the base,
  no per-site cap on save, source/assigned counting a base row, every site "robotic", the old empty message, events per
  site on classification). Browser:
  `e2e/probe-pm-choose.mjs` 39/39 (robotic, multiplier, read-only, 390 dark, the held section and the rename draft);
  `probe-lists` 15/15, `probe-pm-cover` 17/17, `probe-pm-sitelists` 15/15 and `probe-groups` 28/28 follow the new
  shape; `probe-pm-types` and `probe-pm-profiles` are retired (`.obsolete.mjs`); `pm/run` 141/142 (the calendar one).
  The harness PM mock resolves lists like the new SQL and takes `?monitored=0` for a multiplier.
- **What it does in production (read-only preview, 20/10/2026):** of 86 robotic sites, 85 drop to the base alone (the
  lists they got by type are gone until chosen); 1384 keeps its stored choice. Of 130 sites without a controller, 88
  lose "מכפילים סמויים — Max2/Max3" (it came from profile 12) and 41 lose the base: all have nothing until chosen; 1206
  keeps Max2/Max3 (its stored choice), without the base. The four open drafts (1326, 1342, 1297, 1079) do not change.
- ⚠️ **Deploy order: SQL first.** The dry run shows exactly seven function bodies. A new bundle against the old SQL would
  show every site's type lists as "chosen" (they come back in `templates`).

## PM visit form: a photo on every item, and a larger detail line (18/10/2026)

From the field, forwarded by the owner: *"חייבת להיות אפשרות להוסיף תמונה\ות לכל סעיף, כמו שתמיד היה לנו. זה חלק
מ'ת. הביטוח' שהדבר נעשה + כנגד תלונות או תביעות לאחר מעשה"*, and *"צריך גם להגדיל את הכתב בשורת הפירוט, הוא ממש קטן
ובמובייל או אפילו על צג של לפטופ"*.

- **Every item shows "צילום" / "מהגלריה"** (`PmVisitForm.jsx`), not only `photo` / `check_photo`. On an item that does
  not ask for photos they are optional and quiet (`PhotoPicker quiet`: no solid camera button), so they do not read as
  required. Required photos are still decided only by `min_photos`, a photo never ticks a check item, and the "N
  תמונות" tag appears on such an item only once it has one.
- **No SQL change:** `pm_visit_photo_add` never checked `kind`, the reads return photos for every item, and the
  submitted-visit view already draws them for any item. The caps stay: 6 per item, **40 per visit**, 15 MB per visit.
  ⚠️ With a photo possible on every item, a long list (two lists of ~20 items) can reach 40 photos in one visit; raising
  it is a SQL change in `pm_visit_photo_add` (and `MAX_PHOTOS_PER_VISIT` in `PmUtils.js`), not made.
- ⚠️ **A photo budget, from the code review the same evening.** Optional photos could use up the 40 per visit before
  the required ones were taken; then `pm_visit_photo_add` refuses the required photo, and submit is blocked.
  `PmVisitForm` computes `requiredPhotosLeft` (required items still short of `min_photos`) and `optionalPhotoRoom`
  (40 − taken − that). An item whose photos are optional gets a picker `max` of what it holds plus that room. When the
  room is 0 and required photos are missing, one line says so under the progress bar.
- **The item's detail line is 15px** (`.pm-item > .pm-hint`; was 13). Every other `.pm-hint` in the PM tab is **14px**
  (was 13), the size of `.pm-muted` (the owner, the same day, comparing the start box with "היסטוריית ביקורים": *"התחתון
  יותר גדול ונוח, ועדיף שיהיה כך"*). The start button was not made smaller; there was room.
- Browser: `pm/harness/probe-photos-all.mjs` 16/16 (phone + desktop): both buttons on all five mock items, quiet only on
  the check items, the detail line 15px, a photo on a check item reaches the visit and leaves the item still to do.

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

## Wizenet service calls on the site card (built 13/10/2026, live since 14/10/2026)

The operations email (24/09/2026): the call centre sees a site in fault, but maybe no tenant opened a call in Wizenet, so
show the calls next to the system data. The owner chose **a marker on the site card**, and **anyone (any staff
user)** may change a call's status and type.

| Piece | Where |
|---|---|
| Intake (live since 05/10) | `supabase/functions/service-calls` → `service_calls` (insert-only identity). One row **per event**, not per call |
| The table, the clock converter, the readable columns | `master/db/service-calls.postgres.sql` — `app.wizenet_ts`, `opened_il` / `received_il` and their trigger |
| Board SQL | `master/db/service-calls-board.postgres.sql` (loaded after `tasks`: it needs `require_staff`, audit, events) |
| Relay to Wizenet | `supabase/functions/wizenet` — `handler.ts` (all logic, tested in Node) + `index.ts` (Deno wiring) |
| Dashboard | `services/serviceCallsDirect.js`, `utils/serviceCalls.js`, `components/ServiceCalls/`, `SiteCard` (`callsPill` / `callsButton`), `App` (counts + event) |
| Tests | `service-calls-board.test.js` (10 tests, 16/16 + 8/8 SQL mutations), `wizenet-fn.test.js` (9), `service-calls-ui.test.js`; browser `e2e/probe-calls.mjs` (30) + `probe-calls-today.mjs` (20) |

- **A call's state is its last row** (by `ticket_number`), and above it our last change per field **if newer**
  (`service_call_changes`). We may not get an update back from Wizenet for a change made through their API; that
  is the open question to Wizenet.
- **Site = project code:** `project_code` if they send one (operations suggested switching to it), else the first part of
  `parking_code` (`1226-1-02` → `1226`) matched to `sites.code`. A call with no matching site is counted nowhere.
  ⚠️ **11 project codes that arrive have no site anywhere in our data** — not in `sites`, not on the traffic-light
  board, not in FixFlow. Their calls are therefore invisible. Registering them as "ללא בקר מחובר" sites is the fix,
  and the code alone is enough to register one.
- **Open = its status is not marked `closed` in `wizenet_lookups`.** An unknown status counts as open: better to
  show a call that may be closed than to hide an open one. `closed` is guessed from the name only for a **new**
  row (סגור / נסגר / בוטל / הסתיים / טופל / הושלם) and is **never overwritten** by a reload; check it by eye.
  **13/10: 20 statuses and 11 types were loaded. 14/10: the owner marked ten statuses as closed.**
  ⚠️ **And the list cannot be reloaded from the dashboard today.** Both links to the reload are hidden while
  `SERVICE_CALLS_WRITE=false`, and the reload itself goes through WIZEAPI, which blocks access from outside
  Israel. A status Wizenet add has to be inserted by hand in SQL — see the pulse section below.
- **The Wizenet token never reaches the browser.** It is an Edge Function secret (`WIZENET_TOKEN`, plus
  `WIZENET_QRY_STATUS` / `WIZENET_QRY_TYPE`). ⚠️ Never in a file: the repo is public. The function checks
  `my_role()` against the database **before** calling Wizenet, and records the change **only after** Wizenet
  answered `update successfully` (a 200 with an error in the body is an error).

### ⚠️ Wizenet send **Israel local time** with a `Z` suffix — and a whole screen read three hours into the future

This is the one trap in the feature, and it was visible to the owner before it was understood: *"הזמן שמוצג לא הגיוני,
עדיין לא הגיע השעה הזו!!!"*. 74 calls were displayed at a time that had not yet arrived.

- **Measured, not inferred (14/10/2026):** of the 87 feed messages, **87** had `updated_at` exactly +3.00 h against our
  own receipt — i.e. a second or two *before* we got it, stamped three hours ahead. (The only two outliers were rows
  hand-sent on 08/10 during testing.) So their `Z` is not UTC; it is a wall clock.
- **`app.wizenet_ts(text)`** is the single place that converts: it reads the text as a *local* wall clock and converts
  through `AT TIME ZONE 'Asia/Jerusalem'`. ⚠️ **Not a fixed −3 h:** Israel is +3 in summer and +2 in winter, and the
  changeover is close. ⚠️ And **not `to_timestamp`**, which returns `timestamptz` and sends `AT TIME ZONE` the other
  way, *adding* three hours instead of subtracting (caught by test S9, after it had happened).
- **`STABLE`, not `IMMUTABLE`** — the conversion depends on the time-zone database, which can be updated.
- ⚠️ **It is defined in `service-calls.postgres.sql`, not in the board file**, because the readable-column trigger and
  its backfill call it and the board file loads *after*. Defining it there would have failed the boot of any fresh
  database — a restore, or the test database — and passed every existing test.
- **Two readable columns on the table itself** (the owner, looking at the Supabase table editor: *"תעשה לי בטבלה
  עמודה ששם כתוב באיזה שעה הגיעה הפניה"*). `received_at` is correct and unreadable: UTC, one run-on string.
  - `opened_il` — when the call was **opened at Wizenet**, Israel time. What the tenant experienced.
  - `received_il` — when the message reached **us**, Israel time.
  - ⚠️ **Two and not one, and that is the point:** the table holds one row per *event*, so a status change on a
    week-old call is a new row, and "when did it arrive" then means two different things. The gap between the two
    columns is the latency, readable by eye — which is exactly the question that was asked the same day, *"למה זה
    מגיע רק עכשיו?"*.
  - ⚠️ **A trigger, not `GENERATED`:** a generated column needs an `IMMUTABLE` expression and a time-zone conversion
    is `STABLE`. That fails on apply, not in tests.
  - ⚠️ **And `SECURITY DEFINER` is not decoration:** the only writer to this table is the intake identity, and
    `app.wizenet_ts` is revoked from `PUBLIC` — a plain trigger runs with the inserter's rights and dies on
    *permission denied*, i.e. **every new call would be rejected**. The mutation that drops it fails 7 of the 10 tests.
  - The backfill is `WHERE received_il IS NULL`, so an apply does not rewrite the whole table; the condition is on
    `received_il` and not `opened_il` because the latter is legitimately NULL for a message with no `opened_at`.
  - Test S10, 8/8 mutations caught. It is also the first test to re-apply `service-calls.postgres.sql` twice.
- **The latency, measured in production (14/10/2026)** — first message per call, calls opened after the feed went live:
  **about 3 seconds in the median, and that is an upper bound.** Raw figures over 40–43 such calls: minimum 1.2 s,
  median 2.8–2.9 s, p90 4.1 s, maximum **11.5 s** (ticket 774542, site 1197).
  - ⚠️ **It is an upper bound, and quoting three decimals is false precision.** Wizenet's `opened_at` / `updated_at`
    carry **whole seconds only** — 0 of 104 messages contain a fraction — while our `received_at` is in milliseconds.
    So the truth is between the measured value minus one second and the measured value: the real median is somewhere
    between 1.9 and 2.9 s. Clock skew between their server and Supabase is not measurable from this data at all.
  - **The split matters more than the total, and it exonerates us:** their signature → a row in our database is a
    median of **1.4 s, worst 2.5 s**, and stable. Their own leg (`updated_at` − `opened_at`) is a median of 1 s and a
    worst of **10 s** — so the whole spread, including the 11.5 s outlier, sits **inside Wizenet**. Insert → `events`
    row is 0 ms (same transaction).
  - **And our 1.4 s can be split further, from a real timestamp in the headers.** `sb-request-id` is a UUIDv7 whose
    first 48 bits are epoch milliseconds, and `cf-ray` decodes to the same instant (the Supabase gateway runs as a
    Cloudflare Worker, TLV). Both land a median of **445 ms before `received_at`** — so ~0.45 s is ours (gateway →
    function → connect → insert) and ~1.05 s is their send plus the network.
  - ⚠️ **Wizenet send no timestamp of their own.** Their request carries `host`, `content-type` and `content-length`
    and nothing else — not even a `user-agent`. A blind search over all 110 header values found no date, hour, GMT
    string or epoch anywhere. Every timestamp in `headers` was created by Cloudflare / Supabase / AWS **after** the
    request arrived. The intake function does store every header except `authorization` / `apikey` / `cookie`, so if
    they ever add one it will be there — but a header could not answer "when did the person call" anyway: their
    *server* sends the request, when the call already exists on their side. Only a body field (`opened_at`) can.
  - ⚠️ **The sample is 3.2 hours of one weekday morning** (07:50:56Z–11:06Z): no evening, no night, no weekend, no
    peak. There is no basis for "no call ever took longer".
  - ⚠️ **Measure on the first message per call, and only on calls opened after the feed went on.** A status update on an
    older call is also a row, and counting those gives a median of ~175 s and a maximum of 29 hours — a number about the
    historical gap, not about the feed. That mistake was made and corrected here.
  - ⚠️ **A filter on one leg of the thing being timed is circular.** A first attempt kept only messages where
    `updated_at − opened_at ≤ 5 s`, which mechanically caps the total at 5 s + transit — and it dropped exactly one
    call of 40: the worst one. Do not filter the sample by a component of the measurement.
  - ⚠️ **Any script that hardcodes −3 h breaks on 25/10/2026**, when Israel returns to UTC+2. Use `app.wizenet_ts`.

### What is on the card, and what is still off

- ⚠️ **ON since 14/10/2026:** `SERVICE_CALLS_ENABLED` defaults to on; `VITE_SERVICE_CALLS=false` turns it off. It was
  off until the status list existed, because without it nothing can tell a closed call from an open one.
  `service-calls-ui.test.js` pins the default.
- ✅ **Changing a status or a type is ON since 15/10/2026, through the relay** (`SERVICE_CALLS_WRITE` defaults to true;
  `VITE_SERVICE_CALLS_WRITE=false` turns it off). Until then it was off, and not because of us: the update goes to
  WIZEAPI, and Wizenet block access from outside Israel (their answer, 14/10/2026: the token is an additional layer and
  does not replace the restriction). Supabase Edge Functions have no fixed outbound address, so without the flag the
  picker looked like it worked and every click ended in "ויזנט לא ענו בזמן" after 15 seconds. The browser cannot be the
  relay either: no CORS headers, and the token would leak. The relay (site PCs, see *Wizenet relay* below) passed the
  live test through a real relay (1414 claimed a list refresh in 0.5 s), and the owner asked for it: *"אי אפשר
  מה-DASHBOARD לשנות סוג וסטטוס — תן את האופציה"*. ⚠️ As in Wizenet itself, some statuses send the tenant an SMS (the
  list has "ללא SMS" variants). Their push **to** us is unaffected.
- **The marker counts the day's calls, not only the open ones** (the owner wanted the call visible on the site's card).
  When something is open the whole card **pulses** (`has-open-call`, `@keyframes callPulse`, 1.8 s, with a
  `prefers-reduced-motion` fallback) — her words: *"אם יש בקשה פתוחה היא צריכה להבהב על כל הכרטיס כי אני רוצה שישימו
  לב אליה"*.
- **A stopwatch, not a timestamp** (*"אני רוצה שיהיה כזה סטופר לפני כמה זמן נפתחה הפניה"*): the same `FaultTimer` used
  for faults, in a new `--call` tone — the accent colour and not red, because an open call is not a fault in the
  machine. On the card it replaces the count while something is open (the count stays in `aria-label`); in the dialog
  every open call has one. It needs a real timestamp, which is why `service_call_counts` returns `oldest_open` and
  `service_calls_open` / `_recent` return `opened_utc` per call, both through `app.wizenet_ts`, both falling back to our
  receipt time when `opened_at` is missing — a stopwatch starting from zero on missing data is a lie.
- ⚠️ **A card bug found on the way, and fixed:** `.card-row-end` did not wrap, so the site code was squeezed to zero
  width and **disappeared** — it did not move to the next line, it was simply not drawn. Nothing there shrinks now and
  the row breaks instead. The cost: a card with an open call is 128px (100 with the count, 74 with no call), and the
  grid aligns a whole row to it.
- **"קריאות היום" in the header** — everything that arrived in the last 24 hours, including calls with no matching
  site. `service_calls_recent(p_hours)`, capped at 168 hours. ⚠️ **Since 15/10/2026 also every open call, of any age,
  and the tile says how many are open** (owner: *"שיהיה כתוב כמה פתוחות"*): a third line, "N פתוחות" / "אין פתוחות",
  from `service_calls_recent_summary` → `{ total, open }`. The list was widened in the same change, because the number
  on the tile and the list it opens must be the same set — measured that day: 14 open, one of them not updated within
  the day, which the old list would not have shown. Cost: "קריאות היום" now also counts an old call that is still open.
  `service_calls_recent_count` stays for an old bundle and reads the same set. On a phone the third line makes that row
  of tiles ~15px taller (`probe-calls-today` T1c checks it never becomes the tallest tile and that no line wraps).

### The card's dialog: open calls only, and "להיסטוריה" (15/10/2026)

The owner: *"כשלוחצים על כרטיס כדי לראות את הקריאות — יראו רק קריאות פתוחות, ויהיה כפתור שכתוב עליו 'להסטוריה',
וכשלוחצים עליו רואים את הקריאות הקודמות שכבר נסגרו"*. Until then the dialog from the card showed the open calls and
whatever closed in the last 24 hours, and a call closed from the dialog stayed in it, marked "סגורה".

- **One builder, two lists.** `app.service_calls_site(code, hours, history, limit)` builds every row (the 18 fields)
  and returns `{ calls, total }`; `service_calls_open` (open, oldest first) and `service_calls_history` (closed, newest
  first by opening time) are thin wrappers. A second copy of the 18 fields would drift silently — a field added to
  one list only.
- **The history is capped at 100 (500 at most) and says so:** `total` is the full count, the subtitle says "N קריאות
  שנסגרו" from `total`, and a line under the list says "מוצגות 100 האחרונות מתוך N". Closed calls accumulate with no
  retention yet (*Still open*), so an uncapped list would be a jsonb that grows forever on every open.
- **`service_calls_open` keeps `p_hours`** for an old bundle (wall screen, PWA) that still sends it; without it, it is
  open calls only, which is what the new bundle asks for.
- **A call that leaves the list after a change says where it went** (`movedNote`, one `role="status"` line):
  "קריאה X נסגרה ועברה להיסטוריה", or from the history "… נפתחה מחדש ועברה לקריאות הפתוחות". The history rows keep
  their pickers on purpose: that is the way back from a call closed by mistake.
- ⚠️ **A merged row (`dup_n > 1`) changes one ticket only.** The picker sends the change for the representative
  ticket; the other identical tickets stay open at Wizenet, and the row stays on screen under another ticket number.
  So for a merged row the line says only "קריאה X נסגרה", never "עברה להיסטוריה". Closing all of them is Wizenet's
  side (they already mark duplicates "מבוטל בשל כפילות" by hand).
- **"פתוחה"/"סגורה" on each row and the dimming of closed rows are kept for "קריאות היום" only**, where the two are
  mixed. In the card's dialog every row has the same state, and the same word on every row is noise.
- ⚠️ **Every load is numbered, and only the latest reaches the screen.** A change goes through the relay and takes
  seconds; switching to the history meanwhile, or back, would otherwise put the previous list under the new title.
  The change's reload goes through `loadRef` (the view shown now), and switching invalidates any load in flight.
- ~~**A site whose calls all closed today** still shows the quiet pill with the day's count~~ — **not since 18/10/2026**
  (the owner, on a "2 📞" pill: *"להעיף — רק אם יש קריאה פתוחה אני רוצה לראות סטופר, אם אין קריאה פתוחה לא צריך
  לראות כלום"*): the compact card's pill appears only with an open call, always with the stopwatch. The expanded
  card's "קריאות שירות" button still appears for the day's closed calls too — it is the card's only way to
  "להיסטוריה"; its dialog says "✓ אין קריאות פתוחות".
- Tests: SQL S13 (open only, the old `p_hours` behaviour, history order, `total`, the cap at 1 and at 100,000, same
  keys in both lists, non-staff refused) and S14 (the widened "today" list and its summary agree);
  `service-calls-ui.test.js` (`siteCallsSummary`, `movedNote`); browser `probe-calls` 55/55 (42/42 with
  `VITE_SERVICE_CALLS_WRITE=false`) — including a slow history load that lands after switching back — and
  `probe-calls-today` 25/25.

### Still open

- ✅ **Retention is applied (18/10/2026, evening).** The owner settled the rule the same day: *"תשמור אותם רק פתוחות"* →
  *"סגורות תשמור לחודש"* — open calls kept at any age, closed ones for 30 days — and then *"תעשה בעצמך"*: applied
  through a direct pg script after both `apply-sql --apply` and the Supabase connector were refused by the session's
  permission layer; the dry run reads "הייצור זהה לקוד" since. A rolled-back run of the function right after returned 0. The owner, shown the table on 15/10: *"אין צורך
  שישמרו"*. `app.prune_service_calls(interval '30 days')` (`service-calls-board.postgres.sql`; cron
  `parkomat-prune-service-calls`, 04:17 UTC): **an open call is kept at any age**; "closed" is the ticket's current
  status marked `closed` in `wizenet_lookups`, by the same rule as `service_calls_current` (last Wizenet row, overridden
  by a newer dashboard change), so an unknown status is never deleted; ⚠️ the age is measured **from the closing
  moment** (owner, the same evening: *"אחרי שהיא נסגרת"*): the start of the trailing run of closed Wizenet rows, or
  the dashboard change that closed it while Wizenet's last row was still open — a later note on an already-closed
  call does not extend it, and a call reopened and closed again counts from the last closing. (The first version,
  live for a few hours, measured from the last event; replaced and re-applied the same evening.) A ticket goes with all its rows and its
  `service_call_changes`; a row with no ticket number goes by age alone. Measured before the apply: 1,615 rows, 596
  tickets, 569 closed, **0** old enough, so the first deletions fall around 07/11. ⚠️ A duplicate group is not
  considered: a closed member of a still-open group is deleted after 30 days and `×N` drops by one.
  `tests/prune-service-calls.test.js` (P1–P4); 7/7, then 11/11 for the closing-moment version, mutations caught in an isolated copy — ⚠️ three of them first
  "survived" because the anchor text also exists in `service_calls_current` and the runner mutated *that* function;
  anchor a mutation inside the function under test.
- ~~Opening WIZEAPI to foreign access (asked of Wizenet 13/10), or a relay with a fixed IP.~~ Built differently on
  15/10/2026: site PCs in Israel (*Wizenet relay* below). The three secrets are set and the function is deployed;
  redeploy it with
  `npx supabase functions deploy wizenet --project-ref xvfsikwaaaohnmldjbtv --use-api` (the CLI is logged in on the dev
  machine). ⚠️ Deno phrases a timeout as `"Signal timed out."`, so `/timeout|abort/` missed it and the user saw
  "הפעולה נכשלה"; the handler checks the error name first and says whether Wizenet or Supabase failed to answer
  (`wizenet: true` on errors from the Wizenet fetch). 5/5 mutations caught.
- ~~The 11 project codes with no site.~~ **Measured 15/10/2026: 25 codes, 79 of 184 current calls.** Wizenet send no project
  name. ⚠️ **They were registered as sites by mistake and must be undone.** "תציג אותם" was read as these codes; the owner:
  *"לא הבנת, תעיף אותם, לא התכוונתי לזה! אני רוצה שהאתרים שנמצאים במכפילים שברמזור — ליצור אותם ולערוך ידנית את
  הקוד שלהם"*. "המכפילים" is the **`multipliers` board of the traffic light** (130 rows: אתר, סוג הסכם שירות, סוג
  מתקן, עם/בלי שלט…), which has **no "קוד אתר" column**. What exists now:
  - `tools/undo-wizenet-sites.js` (dry run / `--apply`): deletes the 25 — the criterion is structural, an unmonitored site
    named exactly "אתר <its code>"; one that was renamed by hand is kept. The calls stay and simply detach again.
  - `tools/create-multiplier-sites.js` (dry run / `--apply`): one unmonitored site per board row, name = the "אתר" cell,
    temporary code `MX-001`…`MX-130` in board order (not digits, so it cannot pass for a project code), no type (no
    "מכפיל" in `site-types`; she classifies), tier `basic` (the only values `sites.tier` takes). Idempotent by name and
    code. The real code is typed in AdminPanel's edit row ("קוד" → `update_site p_new_code`, manager only) — that is what
    attaches the Wizenet calls. ⚠️ The tier badge will read "לא חובר": `site_service_links` reads `board = 'robotic'`
    only, and the multipliers board had no code column to link by. **Closed the same evening** (owner: *"שיהיה אופציה
    לחבר את זה לסוג של זה וכן להוסיף את קוד של האתר"*): `traffic-light.postgres.sql` seeds a "קוד אתר" column on the
    ⚠️ **For an unmonitored site the multipliers board wins** (owner, later that evening, on יפת 117 showing VIP: *"יפת
    בכלל נמצא במכפילים"*: its code 1347 also sits in the robotic cell "1347, 1342" of שפר 20-22, which is VIP). The
    robotic row is only the fallback when the multiplier has no row of its own, and its "להתייחס כ" is nulled when the
    multipliers row wins, or `effectiveTier` would show it first. Monitored sites: robotic only, as before. ⚠️ The board
    cell itself was **not** changed — the owner: *"אל תשנה שום דבר ברמזור"* (a fix I had started was reverted).
    multipliers board (`c_mx_site_code`, position 1.5; `INSERT … WHERE NOT EXISTS`, not `DO $$` — a DO block hung
    PGlite), and `site_service_links` also reads that board — **for `monitored = false` sites with no robotic row only**,
    so the availability window of a monitored site cannot be touched (the robotic-only guard in `service_agreement` /
    `service_plan` / `site_uptime_service` is unchanged). Its Hebrew menu is translated by `app.tl_mx_plan` (בסיסי →
    basic, לא בשירות / לא פעיל → no_service, אין / לא נמסר → none; granted to `authenticated` because the links
    function runs as the caller). The board cell must equal `sites.code` — whatever it is, `MX-007` or the real
    project code. Tests: `service-links.test.js` (M1–M4, U3), `traffic-light-boards.test.js` (counts 12 / 5, the seeded
    column). Applied 15/10/2026 ("הייצור זהה לקוד").
  - **And the creation is in the dashboard, not the CLI** (owner, the same evening: *"אני רוצה אופציה לערוך את זה
    ב-DASHBOARD"*). In the traffic light, multipliers board, **table view**, a last column "אתר בדשבורד": "✓ <code>"
    when the "קוד אתר" cell is a site, "—" when the row has no name, and in edit mode a "צור אתר" button that
    registers an unmonitored site named from the "אתר" cell with the code in the cell, or the next free `MX-nnn`
    written back into the cell. The toolbar has "אתרים לכל השורות (N)" (confirm; sequential; stops at the first
    error and names the row). Pure rules in `utils/multipliers.js` (`nextMxCode`, `mxRowState`); the light read is
    `fetchSiteCodes` (`sites` — one row per site). Bands view has no per-row button; the toolbar button works there
    too. `tools/create-multiplier-sites.js` is now the fallback. Harness: `e2e/mock-board.js` (the board was never
    mocked before — it hit the network and was blocked), `probe-mx-create.mjs` (26).
  - **The real project codes came from Wizenet's project list** (owner: *"בהורדות יש מסמך EXCEL בשם רשימת פרויקטים
    וייזנט — משם תיקח את הקודים לאתרים שאין להם ותוסיף"*; the file is `רשימת פרויקטים וויזנט.csv`, 433 projects, not in
    the repo). `tools/link-multiplier-codes.js <csv>` (dry run / `--apply`): the board's "קוד אתר" cell wins when it holds a
    real code (57 rows she typed), otherwise the list is matched by **street + house number + city** after normalising
    city abbreviations (ר"ג, ת"א, י-ם, כ"ס, רשל"צ…; ⚠️ `` does not work with Hebrew in JS regexes — lookarounds),
    the city only at the end of the name ("שדרות ירושלים 92, רמת גן"), a leading ה on a street (הפלמח/פלמח), all-short
    street words ("חד נס", "תל חי"), and "15/16" vs "16/15". Unique best match only. It renames the MX site
    (`update_site p_new_code`) and writes the cell (`tl_set_cell`). Run 15/10/2026: **128 of 130 written**; left:
    ברנדיס 10 (MX-021 — the list says 1366, but 1366 is the monitored site "שד' ירושלים 8, רמת גן": a conflict in our
    data) and תרצה 28 חולון (MX-102, not in the list). After it, `site_service_links` gives 128 multiplier sites a plan
    (104 basic, 20 no_service, 3 none, 1 ext). The 20 Wizenet project codes with calls and no site are **not** multipliers
    (מאנה 6, יונה הנביא 36, גרוזנברג 7… all "בהסכם שירות" in the list): robotic sites never registered, the owner's call.
  - **`tools/check-multipliers.js [csv]`** (owner: *"תעשה בדיקות שכל הנתונים אמינים"*): 29 read-only checks — sites,
    board ↔ sites, Wizenet list ↔ our codes (street + number), the link to the plan, calls, identities, compliance rows.
    Clean state 15/10/2026: 23/29, the six ⚠️ being **findings, not bugs**: ברנדיס 10 (the list says 1366, held by a
    monitored site), ארנון 3 typed as 2419 (the list: 2420), and four monitored sites whose code does not match the list
    (1366 ≈ 1336 שד' ירושלים 8; 1200 ≈ 1280 אהרונסון 40; 2222 ≈ 1080 גרוזנברג 7, whose 9 calls are orphaned; 3439 ≈
    3493 מסריק 1). ⚠️ Changing a monitored site's code changes its agent user (`site-{code}@`), so each fix needs a new
    identity and a password on the site PC — the owner decides, nothing was changed.
  - **Preventive maintenance for the multipliers (15/10/2026, evening).** The owner pointed at `הוראות תחזוקה תקופתית
    מכפילים סמויים ספטמבר 2020` (PDF + PPTX in Downloads; the PDF's Hebrew has no unicode map, read the PPTX with
    python-pptx). Loaded through the RPCs as a temporary manager, like the 13/10 lists: list **11 "מכפילים סמויים —
    Max2/Max3"** (23 items in three groups: מבנה 17, הידראוליקה 2, הפעלה ובקרה 4; hints carry the detailed action,
    tools and the ⚠️ warnings) and profile **12 "מכפילים — Max2/Max3"** with **89** unmonitored sites whose board
    "סוג מתקן" is in the Max2/Max3 family. Not assigned, for the owner: MaxFree (11), Others (8), empty type (17),
    "לא פעיל" (1), תרצה 28. ⚠️ The content is Parkomat's manual — it lives in production and in the scratchpad
    (`pmdoc/load-mx-pm.cjs`), **never in the repo**. ⚠️ The first run moved the monitored site 1366 into this profile,
    because the board row ברנדיס 10 carries code 1366 — a board code is not proof of an unmonitored site. Reverted
    with `pm_site_profile_set('1366', 1)`; the loader filters `monitored = false` now.
  - `tools/register-wizenet-sites.js` stays in the repo as the record of the mistake; do not run it.
  - Both tools run as a temporary manager (`lib/gate-user`); the auto-mode classifier blocks them from Claude, the owner
    runs them from `master` on the dev PC.
  - The sort and the pulse below were built for this and stay: `utils/sortSites.js` — an unmonitored site with an open
    call ranks **0.5**, right after `error` and before `maintenance`; without a call it stays last (7).
    `makeCompareSites(null)` is unchanged (`sort-sites.test.js`). The unmonitored card now carries `has-open-call`.
    Browser: `e2e/probe-shell-sort.mjs` (12; `?shell=1&shellcall=1`).

## "רובוטיים" / "מכפילים" — always exactly one kind on the board; and "תקלות חוזרות" (19/10/2026)

⚠️ **Replaces the 18/10 single toggle described in the next section.** The owner: *"תוסיף סינון רובוטיים וזה נמצא
אוטומטית. אם לוחצים על מכפילים — רואים רק מכפילים; אם מסירים מכפילים — הרובוטיים חוזרים; אם לוחצים על רובוטיים
ומכפילים קיים — מכפילים נעלמים ורק רובוטיים נשאר"*. And, in the same turn: *"אני רוצה סינון של כאלו שהתקלות שיש להם את
הסימון הזה של תקלות חוזרות"*.

- **Two tiles, "רובוטיים" and "מכפילים", exactly one pressed** (`kind-head-btn`, `rb-head-btn` / `mx-head-btn`,
  `data-kind`). Robotic (= `monitored` not false) is the default; multipliers → only `monitored === false`; pressing
  multipliers again, or robotic → robotic; pressing robotic again changes nothing. **There is no "both" view any more**
  — that was what "מכפילים גלויים" did. Each tile's big number is the count of its kind; only "מכפילים" counts in
  "N פעילים" (non-default, as everywhere). Rules in `utils/multipliers.js` (`matchesSiteKind`, `nextSiteKind`,
  `sanitizeSiteKind`, `countRobotic`); `matchesMultipliersView` / `sanitizeShowMultipliers` are gone.
- **Remembered per user per device under a new key, `parkomat.siteKind:<uid>`** (`hooks/useSiteKind.js`;
  `useShowMultipliers` deleted). ⚠️ Not the old `showMultipliers` key: its `true` meant "multipliers next to the
  robotic sites", and reading it as "multipliers only" would have opened such a user on a multipliers-only board.
- `boardSites` in `Header` = the chosen kind, so every other tile counts what the board shows.
- ⚠️ **Consequences, stated plainly:** the 15/10 sort rule that put an unmonitored site with an open call right after
  the faults (`sortSites` rank 0.5) still exists but can no longer meet a robotic card on one board; `probe-shell-sort`
  is retired. An unmonitored site's open call shows only on the multipliers board. ⚠️ **Since the evening of 19/10 both
  are no longer true:** "קריאות פתוחות" pressed shows both kinds (see *The header in three groups* below), and there the
  rank-0.5 rule meets robotic cards again.
- **"תקלות חוזרות"** (`rf-head-btn`, after "קריאות פתוחות"): a toggle like "קריאות פתוחות" — pressed → only sites
  with the ↻ mark (`site.repeatFaults` a non-empty array, the same condition as the card badge); the big number is how
  many sites on the board have it; default off; remembered (`hooks/useShowRepeat.js`, `parkomat.showRepeatFaults:<uid>`);
  rules in `utils/repeatFaults.js`. The mark comes from `site_card_metrics` (30 days), which is read on page entry, so
  the tile reflects the statistics load, not the live one.
- ⚠️ **Header width:** the two new tiles broke the row again — measured with 78/130 sites, ~77px short at 1280 and
  ~91px at 1440 (the tightened padding stops at 1400). Between 641 and 1600px a two-word label now wraps to two lines
  (`.filter-label`, `max-width: 4.6em`): "קריאות / פתוחות", "תקלות / חוזרות", "תחזוקה / מונעת", "אין / תקשורת". The
  tiles are 125px tall anyway (the type/system/tier/lift box), so nothing grows: one row and a 212px header at every
  width from 1280 to 1920 (`dbg-header-row.mjs`, with the counts set to 78/130/20). A first try at 6.4em changed
  nothing — the label barely wrapped.
- Tests: `multipliers-view.test.js` rewritten (5: kinds, clicks, storage incl. the old `true`, repeat rules). Browser
  `e2e/probe-site-kind.mjs` 36/36 (replaces `probe-mx-tile`, now `.obsolete.mjs`). ⚠️ **Harness:** `openPage` defaults
  to `multipliers: false` (robotic, like the site); `multipliers: true` switches to multipliers only; `setKind(page, k)`
  switches mid-probe. Probes that needed 9001 beside robotic cards now switch for that step: `probe-call-age` 26,
  `probe-card-click` 36, `probe-tasks-filter` 45, `probe-lists` 15, `probe-tier-all` 39, `probe-cf` 30,
  `probe-keyboard-tiles` 12.

## "מכפילים" — a header tile that shows or hides the sites without a controller (18/10/2026)

⚠️ **Superseded on 19/10/2026 by the section above** — kept for the history of the wording.

The owner: *"אני רוצה שיהיה כפתור סינון נוסף האם המכפילים מופיעים או לא מופיעים"*. Since 15/10 the board carries 128
multiplier sites (and the Sotefin ones) as "ללא בקר מחובר" cards between the 78 live sites.

- **"מכפיל" on the board = `monitored === false`** (`isMultiplierSite` in `utils/multipliers.js`). That is every site
  without a controller, Sotefin included; the tile is named in her word. The rules are pure and tested
  (`tests/multipliers-view.test.js`): `matchesMultipliersView(site, shown)`, `countMultipliers`, `sanitizeShowMultipliers`.
- **The tile** sits in the header filter row after "בודק מוסמך", built like a status tile: the big number is how many
  such sites exist, and the text says the **state** — "מכפילים / מוסתרים" while hidden, "מכפילים / מוצגים" while shown,
  on two lines because the tile is narrow. ⚠️ An action wording ("הצג מכפילים" while hidden) was tried in between and
  read as the opposite of what the board showed (the owner: *"זה אמור להיות הפוך… וודא שהכיתוב תואם"*); the action
  lives in `aria-label` only.
  ~~Hidden = `active`, `aria-pressed`, and it counts as one filter~~ — **reversed the same day** (the owner: *"מכפילים
  מוסתרים לא צריך להיות לחוץ כי זה הברירת מחדל"*): only **shown**, the non-default, is highlighted, `aria-pressed` and
  counted in "סינון ותצוגה · N פעילים", like "בודק מוסמך" and "משימות". One click toggles.
- ⚠️ **The final wording is a fixed label, "מכפילים גלויים"** (the owner, the same evening: *"כתוב מכפילים מוסתרים והם
  באמת מוסתרים — זה צריך להיות הפוך: כשהמכפילים מוסתרים יהיה כפתור שכתוב עליו מכפילים גלויים, וכשילחצו עליו יראו
  אותם"*). The highlight is the state (pressed = visible), and there is no state line under it. It changed four times
  that day: action ("הצג/הסתר מכפילים"), then state ("מכפילים מוסתרים/מוצגים"), then this. Do not reword it without
  asking.
- **Hidden means gone from the board under every other filter** — the rule runs first in `OperatorView`'s filter. ⚠️ And
  the other tiles count what the board shows: `Header` passes `boardSites` (without multipliers when hidden) to the
  status tiles, the type box and "בודק מוסמך", so "הכל" does not read 206 over 78 cards. The multipliers tile itself
  counts the full list, because its number says how many are hidden.
- **Remembered per device, per user** (`hooks/useShowMultipliers.js`, the `useComplianceView` pattern: localStorage,
  key with the user id, written only on a choice). **Default: hidden** (the owner, minutes after the first version:
  *"הפוך בברירת מחדל הם מוסתרים"*); only a stored `true` shows. So a screen that never chose shows the 78 live sites,
  and the multipliers are one click away, remembered.
- Not touched: the supervisor table and the executive page never showed unmonitored sites (`toSupervisorShape`).
- **Browser (harness, 18/10/2026, later):** `e2e/probe-mx-tile.mjs` 38/38 at 1371 light and 390 dark: hidden by default
  with the state text and one active filter, one click shows, "הכל" equals the cards on the board in both states,
  remembered after reopening, another user on the same device starts hidden, hidden again stays hidden, both lines on
  one line each, no horizontal scroll, and hidden wins over "בודק מוסמך: כל האתרים". ⚠️ Every probe that uses
  `?shell=1` must now show the multipliers first (`.mx-head-btn`); `probe-shell-sort` does. The card pill change
  (`bcfa96a`) is covered by `probe-calls` 62/62: no pill for closed-only calls, the expanded card's button still opens
  them. The harness mock had no `fetchServiceCallBoard` and silently fell through to the real Supabase (aborted), so
  no call counts loaded at all — added.

## On a collapsed card the icons only show; they open things on the expanded card (18/10/2026)

The owner: *"אני לא רוצה שזה שלוחצים על האיקונים בכרטיסים של האתרים שהם יפתחו, אני רוצה שרק בתצוגה יותר מוגדלת,
כי אחרת אין איך לפתוח את הכרטיס — כל מקום שלוחצים נפתח האייקונים האלו"*. With the lamps, the tasks pill and the
calls pill each carrying a 32px (44px on touch) hit area, a compact card had almost no spot left that expanded it.

- **Collapsed card:** the lamps (`ComplianceLights` / `MiniMark` rendered **without** `onOpen`) and both pills are
  `<span role="img">` with the same label and title, class `cl-static` / `is-static`: no `::before` hit area, no hover
  brightening, the card's own cursor. Any click or tap on them reaches the card and expands it. Size and spacing are
  unchanged, so no card moves. A span is not a tap target, so Chrome's touch adjustment (the 08/10 name-tap bug) has
  nothing to snap to.
- **Expanded card:** unchanged: the lamps, "קריאות שירות", "משימות" and "פירוט מלא" are buttons that open their windows.
- ⚠️ **A card without a controller keeps its buttons.** It has no expanded card, so its lamps and pills are the only way
  from it to the inspector, PM, tasks and calls (`pillsAct = site.monitored === false` in `SiteCard.jsx`).
- The supervisor table still passes `onOpen`, so its lamps still open the site on their tab.
- From the code review the same evening: the help panel now says a lamp opens the details **on an open card**, and
  `.cl-mini.cl-static::before` removes the mini mark's hit area (a later `.cl-mini::before` won at the same
  specificity). "כל האתרים" under "משימות" now counts in "N פעילים", like "כל האתרים" under "בודק מוסמך"
  (`tasksViewActive` = anything but the default).
- ⚠️ **A card without a controller shows its calls pill only while "קריאות פתוחות" is pressed**, unlike its tasks pill.
  The review flagged it as unreachable by default. That is the owner's rule for calls (*"כשלא לחוץ לא רואים"*), and
  pressing the tile reaches it. Left as is on purpose.
- Browser: `e2e/probe-card-click.mjs` 36/36 (1371 light mouse, 390 dark touch): every icon on a collapsed card expands
  it and opens nothing; the expanded card's lamp and both buttons open their windows; the no-controller card's lamp and
  calls pill still open. ⚠️ Older probes that click a collapsed card's lamp or pill to open a window (`probe-calls`,
  `probe-tasks`, `run.mjs`, `probe-overdue`…) now expand the card instead; go through the expanded card.

## "משימות" in the header filter, by kind; the task pill only when asked for (18/10/2026)

The owner: *"להסתיר כשאין משימות פתוחות, ושיהיה סינון מסוג משימות — מלכתחילה שלא יוצגו"*, and asked how, *"לפי סוג
משימה"*.

- **A "משימות" tile** after "בודק מוסמך" (`components/TasksFilter/TasksFilter.jsx`), the same list:
  "בלי משימות" (**default**), "כל האתרים · N", "כל הפתוחות · n", "קשרי לקוחות" / "טכני" / "מוקד" · n.
  - Default: no task pill on any collapsed card.
  - "כל האתרים": the pill on sites with an open task only, the board unchanged.
  - "כל הפתוחות" or a kind: only those sites on the board.
  - Only the filtering choices count in "סינון ותצוגה · N פעילים". Counts are over what the board shows (`boardSites`,
    so hidden multipliers are not counted).
  - A task with no kind counts in "כל הפתוחות" and in no kind.
- **The pill never shows with zero open tasks.** It shows its count of all open tasks, whatever kind is chosen. The
  expanded card's "משימות" button is always there; that is where tasks are added.
- ⚠️ **A card without a controller keeps its tasks pill as a button, always.** It has no expanded card, so the pill is
  its only way to its tasks.
- ⚠️ **Until the counts load (`taskCounts` null) the board is not filtered.** Otherwise it empties on every load, and
  stays empty if the query fails.
- **Remembered per user per device:** `hooks/useTasksView.js`, `parkomat.tasksView:<uid>`, written only on a choice.
  `sanitizeTasksView` handles what is read back: a removed kind becomes "all", anything broken becomes "off".
- **Model** (pure, `utils/tasks.js`): `countsBySite` now also returns `byKind` (`none` for no kind), plus
  `matchesTasksView`, `tasksFilterCounts`, `tasksPillsShown`, `tasksViewActive`. Tests: `tasks-ui.test.js` (+3).
- **The dropdown is shared now:** `components/ComplianceFilters/FilterPicker.jsx` holds the keyboard, close-outside and
  phone positioning, and `AreaPicker` is a thin wrapper over it with the same DOM. `probe-cf` passes 30/30 after the
  move.
- **Browser:** `e2e/probe-tasks-filter.mjs` 45/45 (1371 light and 390 dark). ⚠️ The harness `openPage` now shows the
  multipliers by default (`multipliers: true`), because older probes expect them on the board. A probe that tests the
  default passes `multipliers: false`. A probe that counts "N פעילים" must remember that "מוצגים" now counts.

## "קריאות פתוחות" in the header replaces "קריאות היום" (18/10/2026)

The owner: *"שיתווסף סינון ליד כל הסינונים של מכפילים מוסתרים וכו' לראות קריאות פתוחות — כשלוחצים על קריאות פתוחות
רואים קריאות פתוחות, וכשלא לחוץ לא רואים כברירת מחדל"*. Asked how, she chose *"רק אתרים עם קריאה פתוחה"*. Then, about
"קריאות היום": *"תעיף את זה"*.

- **A toggle tile "קריאות פתוחות"**, after "מכפילים גלויים", with a fixed label. The big number is how many sites on the
  board have an open call.
  - **Not pressed (the default):** every site is on the board. There is no stopwatch pill, no pulse (`has-open-call`), and
    a call does not lift a site in the sort.
  - **Pressed:** only sites with an open call are on the board, with the stopwatch and the pulse. It counts as one
    active filter.
  - Remembered per user per device (`hooks/useShowOpenCalls.js`, `parkomat.showOpenCalls:<uid>`).
- ⚠️ **This reverses the 14/10 pulse decision** (*"שישימו לב אליה"*): by default nothing on the board says a site has an
  open call. That is what was asked.
- **The expanded card's "קריאות שירות" button stays**, stopwatch included. It is the card's way to its calls and to
  "להיסטוריה".
- **Plumbing:** `calls.show` rides on `ServiceCallsContext` and is read by `SiteCard` (`markOpen`) and by `OperatorView`
  (the filter, and `makeCompareSites(null)` when not pressed). The pure rules are `matchesOpenCallsView`,
  `countSitesWithOpenCalls` and `sanitizeShowOpenCalls` in `utils/serviceCalls.js`, tested in `service-calls-ui.test.js`.
- **"קריאות היום" is removed** from the header (`git show 76664a6:dashboard/src/components/Header/Header.jsx` restores
  it). ⚠️ The consequence: **calls whose project code has no site of ours are now visible nowhere**. That tile was their
  only screen. `ServiceCallsDialog`'s `recent` mode and `service_calls_recent` stay in the code, unreachable.
  `fetchServiceCallBoard` still returns the summary; nothing reads it.
- **The three per-device choices share one hook now:** `hooks/useDeviceChoice.js` (multipliers, tasks and open calls;
  same keys as before).
- ⚠️ **A real bug found on the way:** picking a status in the calls dialog collapsed the expanded card behind it. The
  ChoiceSelect list is a portal outside `.tk-overlay`, so `SiteGrid` read the pick as a click outside the card. It
  stayed hidden while the dialog opened from a collapsed card. `SiteGrid` now also ignores `.cs-menu` / `.cs-backdrop`.
- **Browser:** `e2e/probe-open-calls.mjs` 26/26. `probe-calls` 63/63 opens the dialog from the expanded card and presses
  the tile first. `probe-relay` 24/24 dropped R6 (it used the removed tile). `probe-calls-today` is retired
  (`.obsolete.mjs`). `probe-card-click` and `probe-shell-sort` press the tile where they need the stopwatch.

## Filter by lift type in the "סוג, מערכת, רמה ומעלית" box (18/10/2026)

The owner: *"אני רוצה שיהיה גם סינון לפי סוגי מעליות שיתווסף פה"*, pointing at the type, system and tier box.

- **A fourth selector, "כל המעליות":** the seven `LIFT_TYPES`, each with its site count. "לא הוגדר" is listed only when
  such sites exist or it is the current choice.
  - A site with two lifts matches if either lift is of the chosen type, and it is counted once per type.
  - Not remembered across refreshes, like the other selectors in that box. It counts as one active filter.
- **The rule** is `matchesLiftFilter` and `NO_LIFT` in `shared/lift-types.mjs`, called from `matchesSiteFilters`.
  Tested in `lift-types.test.js`.
- ⚠️ **Height:** a plain fourth row grew the box from 120 to 149px, and every tile in the row stretched with it. A 2×2
  grid made it wide, and two tiles wrapped to a second line at 1371px. So with a mouse (`pointer: fine`) the column is
  tighter (`.site-filter-tile--four`), and the row is 125px. On touch the selectors keep their size.
  ⚠️ `.filter-btn` (StatusFilters.css) loads later at the same specificity, so a `display` set on the tile class alone
  does not apply.
- Browser: `e2e/probe-lift-filter.mjs` 19/19, with the mock flag `?lifts=1` (2438 serapid; 1001 piston 1 + electric;
  1002 electric).
- ⚠️ **Header height (measured the same evening):** with that day's tiles the row wrapped at 1280px, and the sticky header
  grew from 212 to 286px. `StatusFilters.css` now tightens the side padding (10 instead of 16) and the gap (6 instead of
  8) between 641 and 1400px, which gives one row and 212px at 1280. **At 1024×768 it is still two rows and 338px (44% of
  the screen).** There it covered the first row of cards as soon as the page scrolled.
  ⚠️ **Fixed the same evening at the owner's word ("כן")**: the filters now fold into "סינון ותצוגה" up to **1240px**,
  not only up to 640px (`Header.css`; the open/close logic never depended on width). Measured with 78 sites, the row
  wraps below 1220px. 1240 leaves room for three-digit numbers, and a 1280 laptop stays open. At 1024 the header is now
  185px closed (it was 338). `probe-square` passes 201/201.

## Repeated fault: the same fault text more than 3 times in 30 days at one site (18/10/2026)

From the field, forwarded by the owner: *"אם ישנה שורת תקלה שחוזרת מעל 3 פעמים באותו אתר (בחודש נניח) — שיתריע לנו
בצורה מסויימת (צבע, מסגרת או הערה, מה שתחליטו). אם אפשר להחריג למשל דלתות פתוחות או חירום — זה יהיה מעולה"*.

**Measured first (production, 30 days):**
- 32 (site, text) pairs exceed 3. The two exclusions remove 8 of them: open doors at 6 sites, and "חירום נלחץ" twice at
  2441. That leaves about 24 pairs at about 19 sites, for example 1275 "מעלית - זמן מקסימלי להרמת גג" ×14.
- **294 of 784 faults had no text from the controller.** They cannot be "the same fault" and are not counted.

**SQL** (`card-metrics.postgres.sql`):
- `app.fault_text_key` builds the key. All whitespace (newline and tab too) becomes one space, and a trailing ":" or
  space is dropped, because the controller sends the same fault both with and without the colon. ⚠️ The whitespace is
  normalised *before* the trim, because `btrim` only trims spaces.
- `app.repeat_fault_excluded` is the one place for exclusions: `%דלתות%פתוחות%`, `%חירום%`, and an empty key.
- `app.repeat_faults(from, to, p_min = 4)` counts the same faults as everywhere else: `app.error_segments`, flicker
  collapsed, excluded segments dropped, and faults during maintenance left out. The text is that of the `status_history`
  row where the segment starts.
- The result goes into a new column, `site_card_metrics.repeat_faults` (`[{text, n, last_at}]`, highest first, NULL
  when there is none). It is filled by the existing 10-minute cron over the last 30 days, so no screen computes it.

**Dashboard:**
- `sitesDirect` reads `site_card_metrics` with `select("*")`, no longer a column list. A new column in the list would
  have been a 400 before the SQL was applied, and every card statistic would have failed to load.
- `repeatFaults` is in `STATS_FIELDS`, so a live load keeps it. `site-sync.test.js` detects `rfById`.
- **Collapsed card:** a small "↻ N" in the status row's end group (`.rf-badge`), N being the highest count. It is
  display only, and the hover text lists every repeated fault.
- **Expanded card:** a "תקלה חוזרת · 30 הימים האחרונים" line under the fault line (`.rf-line`), up to three texts with
  ×n.
- Orange tint and frame, ink `--repeat-ink` per theme, weight 700.

**Tests:** `tests/repeat-faults.test.js` (7, PGlite: the key, more than 3 versus exactly 3, the exclusions, no text, the
30-day edge, maintenance, order, what the cron stores, re-applying the file, two sites with a fault in the same second) and
`card-metrics.test.js` 15/15. Browser: `e2e/probe-repeat.mjs` 14/14 (mock `?repeat=1`). **Mutations (19/10/2026, isolated
copy): 11 of 11 SQL caught**, after two cases were added: the cron's own window (a fault at 35 days; the one at exactly 40
days could not tell 30 from 40) and the same-second case (without `h.site_id = es.site_id` one site's text lands on
another's fault).

⚠️ **The window is still the owner's question** (18/10/2026: *"אני רוצה שפשוט כל יום תשמור את כל סוגי התקלה לכל אתר
ותמחוק את זה אחרי זה, או אולי את ה-12 שעות האחרונות כל פעם... או 24 שעות אחרונות, צריך לחשוב"*). Measured the same day,
same rule, sites flagged: **12 h — 0, 24 h — 0, 7 days — 5, 30 days — 19**. Nothing new is stored either way: the count
reads the existing history, and the table keeps one overwritten row per site. The window is `rf_from` in
`refresh_site_card_metrics`.
⚠️ **And yet it is LIVE, with 30 days — measured 19/10/2026 08:40:** the three functions and the column exist in
production, the cron fills them, 20 sites are flagged, and the dry run no longer lists the four gaps. It was **not**
applied from the session that built it (its transcript has two dry runs, both "4 פערים", and no `--apply`); someone
applied it after the second one. pg_stat_statements keeps no trace of the DDL. Who and why is the owner's to say.

⚠️ **Fault texts cut by two letters at three sites** (seen in the same data): at 1377, 1384 and 2431 every text is missing
its first two letters, consistently ("טה 25" for "מיטה 25", "לית" for "מעלית", "הל חניון", "בט שאטל"). The agent reads one
character per register from `FaultTextRegister` (default 2), so this fits a site config of 4, or a PLC that writes from
0. The repeat count is unaffected (every occurrence is cut the same way); the text on the card is not, and neither,
possibly, is FixFlow text matching. Check the register screen on those site PCs.

⚠️ **Deploy order:** the dashboard is safe before the SQL (it shows nothing until the column is filled). The SQL dry run
shows 4 gaps: the three functions and the body of `refresh_site_card_metrics`. The new column does not appear in the
dry run, but `--apply` creates it.

## Checks on the morning of 19/10/2026: an unindexed foreign key that would have cost an hour a month

The Supabase advisors are refused through the connector ("no permission"), so the same lints were run read-only by hand.
Clean: no public table without RLS, no grant on a table without RLS, no `SECURITY DEFINER` function anon can execute,
no definer view, no RLS policy re-evaluating `auth.*` per row. The 24 tables with RLS and no policy are the closed
tables (compliance, tasks, settings, Wizenet) — by design. ⚠️ The 60 functions flagged "mutable search_path" are all
**invoker** functions, and must stay that way where it matters: `SET search_path` on a SQL function stops inlining
(`app.served_operations` — 64 ms inlined, 661 ms not). `pg_net` in `public` is Supabase's own.

- **`operations.superseded_by` had no index** (`ON DELETE SET NULL` to `operations(id)`). On every deleted operation
  Postgres runs `SELECT 1 FROM ONLY operations x WHERE superseded_by = $1 FOR KEY SHARE`, which was a full scan: measured
  10 ms per row on 50k rows. `app.cleanup_old_data` cuts on a **month** boundary, so from 01/08/2027 it deletes a whole
  month on the 1st (~40k rows at today's rate) from a ~half-million-row table: ~100 ms × 40k ≈ an hour of scanning on
  Micro, the burstable CPU that took Auth, PostgREST and Supavisor down together on 07/10. Locally, 2,900 deletions from
  100k rows: **33.5 s without, 27 ms with**. Fixed with a partial index, `idx_operations_superseded_by ON operations
  (superseded_by) WHERE superseded_by IS NOT NULL` (1,241 of 50,069 rows), in `db.js` beside the FK.
  `tests/operations-fk-index.test.js` reads the **generic** plan of that exact query (RI uses a prepared statement) and
  shows it is a seq scan without the index. ⚠️ PGlite starts with `enable_seqscan=off` (source: command line); a plan
  test must turn it on, or "uses the index" passes by force rather than by cost.
- **`idx_suppressed_site_time` duplicated `idx_suppressed_dedup`** (same columns; the other one is unique) — dropped in
  `schema.postgres.sql` with `DROP INDEX IF EXISTS`, since deleting a `CREATE IF NOT EXISTS` line drops nothing.
- ✅ **Applied 19/10/2026** together with the call aging (see *An open call that is not handled…*), at the owner's word.
- **`admin-gate.test.js` was red on `main` since 5cc5cd7**: it still asserted "a code on every open, nothing stored" —
  the decision the owner reversed that day. It now pins the new one, and a new test runs `adminCodeStillValid` /
  `rememberAdminCode` against a fake `sessionStorage` (exactly 30 minutes, per user, only the expiry stored, blocked
  storage locks). The browser probe never checked the 30 minutes themselves. Lesson: run the full suite after a change
  that reverses a product decision; the old decision usually has a test.
- **Mutations of the 18–19/10 rules (isolated copy, `scratchpad/mut1910`): 43 of 44 caught**; the survivor (unlocking
  without the explicit `rememberAdminCode`) is equivalent, because the effect remembers as soon as `codeOkThisOpen` is
  set. Three were real gaps and got cases: "כל האתרים" in the tasks filter counted against a site with no counts row,
  plus the two repeat-fault cases above.
- **Keyboard:** `e2e/probe-keyboard-tiles.mjs` 12/12: Tab reaches the tasks, multipliers and open-calls tiles, all 24
  header stops show a focus mark in both themes, and the tiles work with Enter, Space, the arrows and Esc. ⚠️ Read focus
  styles after the transition (`.search-bar` fades its border in 0.15 s), or the search box reads as unmarked.
- **Load, 10 minutes:** 42 s of DB time (7% of one core), as the evening before. The old pair of call-count RPCs is gone
  from every screen. The top is `site_globals` (27 × 610 ms) — the 5-minute live load of every visible screen.
- **Load, measured again at 08:40–08:50 (owner: "תעשה בדיקות שאין עומס על SUPABASE") — none.** 34 s of DB time in 10
  minutes (6% of one core, ~2 s of it the measuring scripts). Connections 20 of 60, almost all Supabase's own
  (`authenticator` 9, `supabase_admin` 8); nothing running over 5 s, nothing idle in a transaction, no lock waits.
  2,655 commits against 3 rollbacks in 8.7 minutes, and the 3 were the scripts' own read-only rollbacks — no failing
  RPC, no statement timeout. Cache hit 100%, 0 blocks read from disk (the 185 MB database fits in 256 MB of shared
  buffers). Realtime: 14 subscriptions, both slots retain 59 kB. 761 `ingest_batch` calls (80 agents beating).
  **The throttle gauge** is the silence scan's run time in `cron.job_run_details` (1,440 runs a day; normal 0.012 s):
  since 08/10 no run over 1 s and a worst of 0.11 s; the last throttling was 06–07/10 (worst 117 s), and all 80 cron
  failures in 14 days are from those two days ("job startup timeout"). Read this gauge first next time.
  ⚠️ **Two cumulative counters look alarming and are history, not load** — `pg_stat_database` and
  `pg_stat_user_tables` count since 30/06: 817 GB of temp files and 2.27 billion scans of `app_users` (~236/s on
  average). The 10-minute delta says 3.1 scans/s now (one per request: the policies are correctly wrapped as
  `(SELECT app.is_active_user())`, an InitPlan, not per row), and temp writes of 150 MB per 10 minutes (~0.25 MB/s),
  more than a third of it `site_globals` (2.8 MB per call over `work_mem` 3.5 MB). Measure deltas (`delta-load.cjs`
  pattern: two snapshots, subtract), never these totals.
  ~~Room for later: `site_globals` is the largest app-side cost and grows with the number of visible screens~~ —
  **removed the same morning** at the owner's word (*No live load from a timer*, below). Still room for later:
  `service_calls_board` scans the 31-row `wizenet_lookups` once per call row (~36 scans/s); Realtime's own WAL
  polling (10.5 s per 10 minutes) is Supabase's and constant. The Supabase connector also refuses the logs
  (`query_logs`: "no permission"), so errors are measured by the rollback counter.

## No live load from a timer (19/10/2026)

The owner, told that every visible screen ran the live load every 5 minutes: *"למה הוא מריץ את המצב החי? אני לא
רוצה!"*. It was `sites` + `site_globals` + `site_compliance`, ~0.5 s of DB time per screen per load, the largest
app-side cost (20–27 calls per 10 minutes, and 2.8 MB of temp spill each).

- **The minute timer runs only the cheap status check** (`fetchSiteStatuses`, one query on `sites`). A full live load
  only when it finds a mismatch. `syncNow({ allowFull })` in `App.jsx`: an age-based full load (`fullReloadDue`, at
  most every 5 minutes) only on **recovery** — the return to a hidden tab and the Realtime channel's reconnect, when
  events really may have been missed. A missed maintenance start is invisible to the cheap check (it does not compare a
  site in a window), so recovery keeps that load.
- **A page-entry statistics load counts as a full load** (`enterPage` and the role switch set `lastFullAt`). Before,
  a return to the tab ran the statistics load *and*, right after it, the recovery load — two loads, measured in the
  harness.
- ⚠️ **What the timed load was silently doing, now done explicitly:**
  - **The end of a maintenance window.** `inMaintenance` comes from `site_globals` at load time, the dashboard does not
    end a window by itself, and the cheap check skips sites in a window; the 5-minute load is what took "בתחזוקה" off a
    card. Now `sitesDirect` carries `maintenanceUntil` (`site_globals.maintenance_expires_at`), and `statusesMatch`
    returns false once it has passed — one full load in the minute the window ends. No time known, or an unparsable
    one: no decision (never a load per minute).
  - **The lamps.** They are coloured by the day (30 days before expiry, a fix date that passed), and a failed fetch
    left them dashed until the next timed load. `complianceRefreshDue(lastOkAt, lastFailAt)` in
    `utils/complianceMerge.js`: when the **Israel** date changes (not UTC midnight; `israelDay`), or 5 minutes after a
    failure. Then `useSites.refreshComplianceIfDue` fetches `site_compliance` alone (~0.1 s) and merges it like a full
    load (last-known kept dashed on failure, a newer targeted patch not overwritten). Changes someone makes still come
    as `compliance` events.
  - **Recovery from a failed load.** "⚠️ העדכון האחרון נכשל" stays until a load succeeds; the timed load used to clear
    it, and without it the stripe would stay for hours over a screen whose minute check is fine. While `error` stands,
    `syncNow` retries the full load at most every 5 minutes (`sitesErrorRef`).
- **Cost, stated plainly:** an operation event that is lost while the screen stays connected and visible is not
  corrected by any timer (the last-operation time on the card stays old until a mismatch, a return to the tab or the
  next page entry). Statuses are still caught by the minute check. The task and call counts keep their light 5-minute
  safety timers (`service_calls_board` ~0.1 s, `task_counts`).
- Tests: `site-sync.test.js` (window end: before, exactly at, after, none, unparsable; the timer runs no age-based
  load; `sitesDirect` passes the end time), `compliance-ui.test.js` (Israel day vs UTC midnight, retry after 5
  minutes, a later success cancels). Browser: `probe-stats` 21/21 (S2: 30 quiet minutes, zero live loads, the cheap
  check every minute; S7: a 3-minute window — no load before, one load as it ends, the card leaves maintenance, quiet
  after), `probe-load` 15/15 (no load at 5 minutes; a return after 8 minutes = one load, not two; again within 5 =
  cheap check only; a failed load shows the stripe, is retried within 5 minutes, then quiet), `run.mjs` S10 rewritten 8/8 (same day no refresh, Israel midnight one refresh, it fails →
  dashed, retried after 5 minutes, recovers, then 30 quiet minutes). ⚠️ `probe-load` and `probe-stats` were not in the
  batch list, which is how `probe-load` had gone stale; they are now. Batch of 40 probes after the change: all green
  but `probe-docs` (needs a separate demo server on 5180, not the harness) and `probe-repeat` R2 on desktop, whose first
  click landed on the "הפעלת התראות קוליות" overlay (`.alert-unlock-backdrop`, shown while a site is in fault and
  audio is locked) — the probe now dismisses it with `.alert-unlock-card-btn` first; 14/14.

## An open call that is not handled turns the card from white to black (built 19/10/2026)

The owner: *"כשיש קריאה ככל שעובר זמן והיא לא טופלה המצב מחמיר… אתרים מכפילים כל 24 שעות שעוברות והפניה לא טופלה
המצב מחמיר כלומר צבע הכרטיס מתחיל מלבן ולאט לאט מחמיר בצבעי הרמזור עד שיכול להגיע לשחור. כך גם לגבי רובוטיים אבל
כל שעה… זמן שלא בשעות השירות לא מחושב… בהתאם לסוג השירות של כל אתר. את סוג השירות של המכפילים תיקח מהרמזור"*.
Her answers to the four questions: **white → yellow → orange → red → ~~black~~ dark red** (levels 0–4; the same day: *"שלא יגיע לשחור אלא הכי גרוע זה אדום כהה"* — level 4 is a solid dark red card, with light text); a multiplier steps every
~~**24 service hours** (literal — not every service day; on basic that is a step every ~2.7 working days)~~ **service
day** (see the evening change below); a site with no service hours stays white; the colour shows **only while "קריאות
פתוחות" is pressed**.

⚠️ **The evening of 19/10: a multiplier steps once per service day, not per 24 service hours.** The owner, on two basic
multipliers that were still white after 3 days and 19 hours: *"למה זה בצבע לבן"*. Measured: their calls opened Thursday
afternoon, so only 13 and 16 service hours had passed (basic is Sunday–Thursday 08:00–17:00; Friday, Saturday and
nights do not count). Asked, she first chose to keep 24 hours, then interrupted with *"לפי יום שירות"*.
- `app.service_day_seconds(kind)` is the length of the plan's ordinary weekday: basic 9 hours, ext and VIP 15. It is
  computed from `app.service_windows` on a fixed Sunday (18/10/2026), not written as a number, so it cannot drift from
  the windows. Any other kind gives NULL.
- `app.call_age_level(secs, monitored, kind)`: a robotic site still steps every service hour, whatever its plan. A
  multiplier steps every service day of its plan. A multiplier with no service day stays at 0.
- The two-argument signature is dropped, so a forgotten caller cannot keep counting 24 hours silently.
  `service_calls_board` passes the kind.
- ⚠️ **The `LEAST` trap again:** `COALESCE(LEAST(4, x / NULL), 0)` is 4, because `LEAST` ignores NULL. The `COALESCE`
  sits inside the `LEAST`. The test caught it before any mutation did.
- Preview in production (read only, before the apply): 1153 and 1206 go from white to yellow, and 1191 (open since
  13/10, 37.8 service hours) goes from yellow to dark red. Robotic sites are unchanged.
- Tests: S17 (the service day per plan, the steps at 9 and 15 hours, the robotic rate unchanged for any plan, no service
  day = 0, one signature only; on the board, a basic multiplier open a week is 45 service hours = level 4, where the old
  rule gave 1). Mutations in the isolated copy: 9 of 9 caught (`mut1910/run-mut3.cjs`).
- The dry run shows exactly three gaps: the two functions and the body of `service_calls_board`. The dashboard needs no
  change (it only translates `age`). ✅ **Applied 19/10/2026 at the owner's word ("כן, להחיל")**, then "הייצור זהה
  לקוד". The first `--apply` died on `ECONNRESET` before writing anything (checked: the old two-argument function was
  still there, so the board kept working); the second took 13 seconds. Checked right after through `service_calls_board`
  as a manager: 1153 and 1206 at 1 (yellow), 1191 at 4, the robotic 2438 / 3468 / 1225 at 4 as before; 81 agents beating,
  28 events in 10 minutes.

- **The level is decided in SQL** (`service-calls-board.postgres.sql`): `app.service_seconds(kind, from, to)` sums
  `app.service_windows` (basic/ext/vip, Israel time; any other kind — 0), and `app.call_age_level(secs, monitored)` =
  `LEAST(4, floor(secs / (monitored ? 3600 : 86400)))`. `service_calls_board` adds `age` and `age_hours` to every site
  row, from the **oldest open** call (open = not marked closed, as everywhere), with the kind the card shows:
  `COALESCE(agreement, plan)` from `site_service_links` (for a site without a controller the multipliers board wins).
  "Robotic" = `monitored`, "multiplier" = not (Sotefin included), as the "מכפילים גלויים" tile.
- **Not stored, computed per board call** — the board already reloads on every call event and on the light 5-minute
  count timer, so a robotic step (one service hour) shows at most 5 minutes late. Measured in production: +4 ms on a
  ~63 ms board (`site_service_links`), the windows themselves ~0.
- **The dashboard only translates** (`utils/serviceCalls.js`: `countsBySite` keeps the highest `age`, `callAge`,
  `callAgeClass`, `callAgeText`; old database without the field → 0 → no colour, so the bundle is safe before the SQL).
  `SiteCard` adds `call-age-N` (1–4) only when `markOpen` (tile pressed), on all three card variants; the calls pill's
  label says "פתוחה N שעות שירות". CSS: a 20–24% tint of `--call-age-1/2/3` over the card, the pulse and frame in the
  level's colour (`--call-ring`); level 4 overrides the card's own variables (`--bg-card` #7f1d1d — it was #050505 until the owner said "not black", `--text-*`,
  `--accent` lightened so the pill and stopwatch stay readable, `.exp-open` dark text) — everything inside turns light
  without per-element rules. The status strip (`border-inline-start`) is untouched. Dark theme: level 0 is the normal
  dark card; the dark red card's frame is dark red in light, light red in dark (`--call-age-4-frame`).
- **What it looks like today** (read-only preview, 19/10 morning): 3468 (ext, 17 service hours) and 2438 (vip, 19) black,
  1225 (ext, 2.4) orange; multipliers 1191 (basic, 35 service hours over 6 days) yellow, 1206 / 1153 white.
- Tests: SQL S17 (service seconds per kind and weekday, reversed range, every level boundary both rates, the board:
  oldest open call, closed calls ignored, not linked / "לא בשירות" → 0, "להתייחס כ" before "במקור", a VIP multiplier
  one day open = 14–15 service hours and still white), S16 compares only the shared fields now;
  `service-calls-ui.test.js` (+2). **Mutations (isolated copy): 16 of 16** — one survived until the test put the higher
  level first. Browser `e2e/probe-call-age.mjs` 24/24 (not pressed → no colour; pressed → 4/2/3 incl. a card without a
  controller; level 4 dark red (not black), its name ≥ 7:1 and the pill on it ≥ 4.5:1 against the card; orange and red names ≥ 4.5:1; expanded card keeps it; released →
  gone; 1371 light and 390 dark).
- ⚠️ **Harness:** the browser now launches with `--autoplay-policy=no-user-gesture-required` (`lib.mjs`). The
  "הפעלת התראות קוליות" overlay appears with a variable delay, longer under load, and swallowed a probe's first click —
  `probe-repeat` R2 and `probe-card-click` B failed only in parallel runs. A probe that needs the overlay must launch its
  own browser.
- ⚠️ **Deploy order: SQL first is not required** — the dashboard shows nothing until `age` arrives. The dry run shows
  exactly five gaps: the two functions, the body of `service_calls_board`, and this morning's two index changes.
  ✅ **Applied 19/10/2026 at the owner's word ("כן, להחיל הכול")**: 10 seconds, then "הייצור זהה לקוד" — the aging and
  the two index changes together. Checked right after: 2438 and 3468 black, 1225 red (3.3 service hours), 1191 yellow,
  the rest white; `idx_operations_superseded_by` present, `idx_suppressed_site_time` gone; 81 agents beating, events
  flowing. Dashboard live as `index-CVQappDw.js` (998d47b).
- ⚠️ **No more blinking (the same day).** The owner, looking at the live board with the tile pressed: *"תפסיק את
  ההיבהוב"*. `.has-open-call` no longer animates (`callPulse` is gone); it is a steady frame — the style that until then
  only `prefers-reduced-motion` got — in the level's colour. This reverses the 14/10 *"היא צריכה להבהב על כל הכרטיס"*.
  `probe-calls` now asserts `animationName: none` and a frame.
- ⚠️ **In the dark theme levels 1–3 are solid, not tints (the same evening).** The owner: *"על רקע כהה השקופים נראים
  כהים יותר מהאדומים"*. Measured: 20–24% yellow / orange / red over the dark card (#182238) gave olive, brown and wine at
  L\* 22–26, darker than level 4's dark red (L\* 28), so the scale read backwards; secondary text on them was 2.4:1.
  Now `#854d0e` → `#9a3412` → `#b91c1c` → `#7f1d1d` (L\* 38 / 37 / 40 / 28; the worst is the darkest), with level 4's
  light ink set; hover darkens slightly instead of lightening (lightening dropped the stopwatch to 4.1:1). The light
  theme keeps its tints.
  - **Inline-coloured chips get a dark backing on every solid card** (level 4 in both themes, 1–3 in dark): the tier
    badge, the status chip, system chips/rows, the stuck chip, availability, and the expanded card's call stopwatch.
    Their colours (`STATUS_COLORS`, tier colours, `availabilityColor`) are tuned for a dark card, and on amber or red they
    measured 1.8–3.6:1 ("בסיסי" was 3.3:1 on the live dark red too). The backing keeps their own colour: green "מוכן",
    red low availability. `.tk-count` (white on the light accent, 1.22:1) gets dark text, like `.exp-open`.
  - `probe-call-age` A9: in dark, levels 2 and 3 are lighter than level 4 by more than 4 L\*, and every text on a solid
    card is ≥ 4.5:1 against its composited background (29/29). The old CSS measured L\* 26 / 22 against 28 and 2.39:1, so
    A9 fails it. `scratchpad/e2e/dbg-age-dark.mjs` prints every text's contrast per level (`CAND=` injects a stylesheet).
  - ~~**Not fixed, found on the way:** in the light theme `STATUS_COLORS` are the dark-theme inks~~ — **fixed the same
    evening, see *Status and tier inks per theme* below.**

## Status and tier inks per theme (19/10/2026, evening)

Found while measuring the dark aging cards, and done on "תמשיך": the same fix the owner asked for on 15/10 for "אין
תקשורת" alone (*"כיתוב אפור על רקע אפור לא רואים"*) — the other inks had the same problem. `STATUS_COLORS.text`,
`TIER_COLORS.text` and `STUCK_COLOR.text` were the dark theme's light shades in **both** themes. Measured on a white card
(`scratchpad/e2e/dbg-light-ink.mjs`): "מוכן" / "בתחזוקה" 1.5:1, the system number 1.93:1, the availability % 2.15:1 (it
used the *dot* colour as text), "בסיסי" 2.25:1.

- **Every `text` is now a theme variable** (`--status-ready-ink`, `-operating-`, `-error-`, `-maint-`, `--stuck-ink`,
  `--tier-vip-ink`, `-ext-`, `-basic-`, in `styles/theme.css`), like `--status-nocomm-ink`. Light: dark shades of the same
  family (green-800, the brand blue, red-700, amber-800, purple-800, a dark gold, violet-700, slate-600), each ≥ 4.5:1 on
  its own chip tint over white. Dark: the old values, except two lifted because they were under 4.5:1 on the expanded
  card — "בסיסי" `#94a3b8` → `#a3afc2` (4.11 → 4.75) and the error ink `#f87171` → `#f98b8b` (4.38 → 4.9).
  The dot, the border and the chip tint did not change.
- ⚠️ `text` is used only as a CSS `color` (inline), where a variable works. Anything that computes with a colour or feeds
  a chart must use `dot` (the header status tiles already do: dot background, white text).
- **The availability % uses the ink, not the dot** (`availabilityColor` in `SiteCard.jsx`). `scripts/check-card-metric.mjs`
  checks that function's direction by pattern; it now accepts `.text` as well as `.dot`.
- **The system number** (`.system-num` / `.sys-chip-num`) uses the ink too (it used the dot).
- **The dark-red card (level 4) sets these variables back to the dark-theme values** in both themes, because its chips
  sit on their own dark backing; the dark ink of the light theme would vanish there.
- `.systems-note` / `.systems-note-bad` read `--muted` / `--err-text`, which do not exist, so the fallbacks always applied
  (`#b23c3c` on the dark card: 2.72:1). They read `--text-muted` / `--status-error-ink` now.
- The call stopwatch in dark: `--call-ink` (`#93b4f5`, dark theme only; `FaultTimer.css` falls back to `--accent`). The
  brand light blue on its own tint was 3.06:1 on the expanded card.
- ⚠️ **Deliberately not touched:** the grey secondary text (`--text-muted`, ~3.05:1 light / 3.58:1 dark: the site code,
  "פעולות", "lift", hints). It is a theme-wide choice across every screen, not a card bug. Also white on the accent
  buttons in dark (`.exp-open`, `.tk-count`: 4.31:1).
- Browser: `e2e/probe-ink.mjs` 5/5 — the state / tier / system / availability / stopwatch inks on the board and on an
  expanded card, ≥ 4.5:1 in both themes, and I3 injects the old light green and expects the check to fail (1.55:1). The
  card probes (call-age 29, tier-all 39, calls 63, card-click 40, repeat 14) and `check-colors` pass; unit tests 1233.
- **From the review the same evening:** plain coloured text on a solid aging card ("מערכת 1 בתקלה", the systems age,
  the agreement gap) was still 2.8–3.6:1 — it sits on the amber/red itself, not on the chip backing. On solid cards it is
  a pale shade of its colour (`#fee2e2` / `#fef3c7`). `.systems-age` and `.card-agreement-gap` read `--warn-text` /
  `--amber`, which do not exist (fallbacks 3.6:1 dark / 3.19:1 light); they read `--status-maint-ink` now.
  `probe-ink` I4 puts each solid level on the collapsed two-system card and checks every coloured text (12/12). And
  `useAuth` no longer lets a dialog that already closed write the signed-out user back into the shared `lastUser`.

## The expanded card spread over the whole row after returning to an empty board (fixed 19/10/2026)

The owner, with a screenshot of a full-width expanded card: *"למה שיניתי את הגודל רציתי שיהיה מרובע"*. The square card (2–4
columns, since 05/10) depends on `SiteGrid` measuring its columns and width (`cols`, `box`). That measurement ran once,
in an effect with `[]` deps, and returned at once when there was no grid element. A board that **mounted empty** —
returning to "בקר" while a filter matched nothing ("לא נמצאו אתרים"), e.g. "קריאות פתוחות" pressed with none open, or
a status tile at 0 — was never measured: `cols` stayed 0, `placementFor` returned `undefined`, and the expanded
card fell back to the CSS `grid-column: 1 / -1`. The effect now depends on `sites.length > 0`, so it attaches when the
grid appears. Reproduced and pinned by `e2e/probe-expand-square.mjs` (7: full from the start; emptied and refilled;
remembered filter at load; emptied, refilled and resized; **back to an empty board, then released** — the one that
failed: no inline placement, 1,552px wide). Not caused by that day's changes; the new filters only make an empty board
more frequent.

## The header in three groups; "קריאות פתוחות" on its own and across both kinds (19/10/2026, evening)

Four requests from the owner the same evening, in order:

1. *"אני רוצה מלבנים שמכל אחד מהם נובע כמה דברים — מצבים (הכל, מוכן, בפעולה, בתקלה, בתחזוקה, אין תקשורת), מידע (סוג,
   מעליות, סוג שירות), תוספים (בודק מוסמך, תחזוקה מונעת, קריאות)… ושני ריבועים, מכפילים ורובוטיים, שעליהם מתבצעים בעצם
   הריבועים"*. Her answers: "משימות" and "תקלות חוזרות" go in "תוספים", and "מערכת" goes in "מידע".
2. On the native `<select>` list of the type filter: *"תעצב את זה יותר מודרני ויפה"*, and *"כל הסוגים, כל המערכות, כל
   הרמות, כל המעליות — תעשה כמו שעושים עם המצבים"*.
3. *"קריאות פתוחות שים אותם בתור סינון נפרד, ושלוחצים על זה זה שם את הקריאות הפתוחות גם של המכפילים וגם של הרובוטיים"*.
4. *"תקלות חוזרות — מיין לפי המתקן עם המספר תקלות חוזרות הגבוה ביותר"*. In between she flagged the stopwatch: *"זה נראה
   כאילו כתוב 21 ימים ו-3 שעות, וזה הפוך"*.

**The row** is now: "רובוטיים", "מכפילים", "קריאות פתוחות", then three groups (`components/FilterGroup/`): **מצבים**
(`StatusFilters`), **מידע** (type, system, service tier, lift), **תוספים** (inspector, PM, tasks, repeat faults). It used to
be one row of 14 tiles.
- A closed group shows its name, ▾, and what is active under it: "הכל" / "בתקלה + בתחזוקה" / "N מצבים", "מסנן אחד",
  "כבויים" / "N פעילים". It is highlighted when something in it differs from the default.
- Over "מכפילים" the statuses group reads "לא חל על מכפילים" and is not counted.
- The panel stays open while choosing (several statuses can be picked). It closes on its rectangle, on an outside click,
  or on Esc. A list that opens inside it is part of it: its Esc closes only the list.
- ⚠️ The panel content is always rendered and `hidden` when closed, so the filters keep their state. Tab therefore skips
  the tiles of a closed group.
- ⚠️ **No height cap and no scrolling on the panel.** The tiles' own lists (`FilterPicker`) float over it, and in a
  scrolling panel they were clipped inside it.
- Up to 1240px the header is folded into "סינון ותצוגה", and a group opens in place, full width. The closed header is
  165px at 1371px (it was 212).

**"מידע" is four tiles like the statuses** (`SiteFilterTile`, rewritten). Each is a `filter-btn` with a big count and
the current choice ("כל הסוגים" / "כל המערכות" / "כל הרמות" / "כל המעליות", ▾). A chosen tile is highlighted and shows
the choice, its count, and the dimension underneath.
- Each opens the same styled list as "בודק מוסמך" and "משימות" (`FilterPicker`: ✓, counts, arrows/Enter/Esc).
- In the type list a family row is bold and its models are indented under it (`info-family` / `info-sub`).
- The options, counts and rules are exactly those of the old `<select>`: a family is a selectable row; "לא הוגדר" appears
  only when such sites exist or it is chosen; a non-tier service state appears only when it has sites or is chosen.
  `matchesSiteFilters`, `NO_TYPE` and `NO_SYSTEM` are unchanged.
- The old `.site-filter-tile` / `.sft-select` styles are gone.

**"קריאות פתוחות" is a tile of its own, and pressed it brings both kinds.**
- `matchesBoardKind(site, kind, openCalls)` in `utils/multipliers.js`: pressed (only `=== true`), any kind passes;
  otherwise it is exactly `matchesSiteKind`. The board then shows every site with an open call, robotic and multipliers
  together, with the stopwatch and the aging colour.
- While it is pressed, neither kind tile is highlighted, and "מכפילים" is not counted in "N פעילים". Pressing a kind
  tile leaves "קריאות פתוחות" and shows that kind. Its number counts sites with an open call of both kinds. `boardSites`
  in `Header` is both kinds in this mode, so the other tiles count what the board shows.
- With statuses selected, the status filter applies to the robotic sites only. A multiplier with an open call passes,
  because it has no status.

**"תקלות חוזרות" pressed sorts by the number on ↻, highest first.**
- `repeatTop(site)` is the maximum `n` (not `[0]`), and `compareByRepeat(then)` in `utils/repeatFaults.js`.
- A tie keeps the board's usual order. Released, the usual order is back. It also applies with "קריאות פתוחות" pressed.

**The stopwatch reads in the right order.** `.fault-timer` is `direction: ltr` (for "12:22"), and that put the days number
of "3 ימים 21 שע׳" at the far left, so it read as "21 days 3 hours". The text is now an inner span with `dir="auto"`:
with a Hebrew word it is RTL, and "12:22" still inherits LTR. The pulsing dot does not move. This applies everywhere the
timer appears (the card pill, the expanded card's button, the calls dialog).

**Fixes from the independent code review of the morning's work** (all in this change):
- **A recovery is deferred, not dropped.** `pendingRecover` in `App.jsx`. A recovery (tab return, Realtime reconnect)
  that came less than 5 minutes after the last full load used to be thrown away. A cancelled maintenance window, whose
  event was lost while disconnected, does not change `sites.status`, so the card stayed "בתחזוקה" until the original end.
  Now it is remembered, also while hidden or while a check runs, and the minute timer performs it when due. Every full
  load clears it.
- **The tab-return listener is registered once** (`enterPageRef`). Depending on `enterPage`, it was re-registered after
  a role switch, *after* `useSSE`'s, so the recovery ran first and `enterPage` loaded again: two loads per return.
- **A stuck cheap check no longer blocks all later checks.** A network drop with no timeout left `checking` set
  forever; after 30 s it is ignored (`checkingSince`).
- **A maintenance window scheduled ahead now starts on the card.** Its start changes neither `sites.status` nor sends
  an event, and the timed load that used to catch it is gone. `sitesDirect` reads the uncancelled future windows
  (`maintenance_windows`, `cancelled_at IS NULL`, `started_at > now`; ISO text with "T", like `toISOString`) and carries
  the earliest as `maintenanceNextStart`. `statusesMatch` asks for a full load once it has passed. A failed read means
  no hint, not a failed load.
- **The dark-red card (level 4) in the dark theme:** the lamp, no-comm and repeat-badge inks are re-set on the card
  (`.call-age-4` in `SiteCard.css`). The theme's dark-mode values were tuned for a dark navy card and fell under 4.5:1
  on #7f1d1d.
- **The status filter does not apply on the multipliers board.** A multiplier has no status, and a leftover "בתקלה"
  emptied the board.
- Checked and left: every service kind in production (vip / ext / basic / none) is one the aging recognises.

**"קריאות פתוחות" pressed sorts by who has waited longest, and the calls pill opens the calls** (owner, later that
evening: *"תמיין לפי מי שמחכה הכי הרבה זמן ושלחצו על קריאות ישר תיפתח הקריאה"*).
- The key is the stopwatch's time: the oldest open call of the site, in real time (`oldestOpen`). It is not the service
  hours behind the colour, so a site waiting since Thursday comes before one waiting since this morning, even if its
  colour is lighter. A site with no known time goes last, and ties keep the usual order. The rule is
  `waitingSince` / `compareByWaiting` in `utils/serviceCalls.js`. With "תקלות חוזרות" pressed too, the ↻ count is the
  first key and waiting time decides within it.
- **On a collapsed card the calls pill is a button again.** It opens the site's calls dialog and the card stays
  collapsed. This is an exception to the 18/10 "icons on a collapsed card only show" rule. The pill appears only while
  "קריאות פתוחות" is pressed, i.e. when the person came to handle calls. The lamps and the tasks pill stay display-only.
- Tests: `service-calls-ui.test.js` (+1). Browser: `probe-open-calls` (O2 / O5 order) 60/60, `probe-card-click` B2 (the pill
  opens the dialog, the card stays collapsed, it is this site's calls) 40/40.

**A second independent review (the same evening) found seven more, all fixed:**
- ⚠️ **Every return to a tab caused a full live load 5 minutes later.** The return ran the page-entry load (which clears
  `pendingRecover`), then `useSSE`'s recovery set it again, and the minute timer performed it at +5. Switching tabs
  therefore brought back the timed live load the owner removed. Now `useSSE` passes the reason
  (`"reconnect"` / `"visible"`). Only a channel reconnect, where events may really have been lost, is deferred
  (`syncNow({ allowFull, defer })`). A tab return loads at once if due, otherwise only the cheap check. `probe-load` has a
  new step: 6 quiet minutes after two returns, no full load.
- **Calls mode from the multipliers board ignored the status filter.** `statusApplies` (Header) and the matching
  condition in `OperatorView` are now `callsMode || siteKind !== multipliers`.
- **In calls mode the header counted every site**, about 208, over a board of ~14. `boardSites` is now also filtered to
  sites with an open call.
- **The header and the board disagreed until the call counts loaded.** The header's `callsMode` now requires
  `callCounts`, exactly as `OperatorView` does.
- **A scheduled window start was missed when the browser's clock is ahead of the database's.** The query now also keeps
  a window that started within the last 10 minutes and has not expired (`started_at > now − 10 min`,
  `expires_at > now`).
- **Tab out of a group left its panel open**, so two panels overlapped. `FilterGroup` closes on a `blur` whose
  `relatedTarget` is outside it. A click on empty space inside the panel (`relatedTarget` null) does not close it.
- **A stuck cheap check that finished late released the newer one.** Each check now has a number (`checkToken`); a stale
  answer neither releases the lock nor triggers a load.
- Browser: `probe-open-calls` O6 (from the multipliers board, "בתקלה" leaves only the multiplier with a call; the header
  counts are the board's), `probe-keyboard-tiles` K1c (Tab out closes; an empty-space click keeps it open), 56/56 and
  18/18. Unit tests 1222/1222.

**Tests:**
- Unit tests: `multipliers-view.test.js` 7 (`matchesBoardKind`, `repeatTop` / `compareByRepeat`), `site-sync.test.js`
  (window start, the timer structure with `pendingRecover`, `enterPageRef`), `sites-direct-cache.test.js` 9. The fake
  client now supports `.is()` / `.gt()`, and the next-start test includes a failed read. Full suite 1221/1221.
- Browser probes, new: `probe-repeat-sort` 10 (mock `?repeat=sort`), `probe-timer-bidi` 10 (the visual order of the
  tokens; T4 puts `ltr` back on the text and the same check fails), `probe-open-calls` O5 (47 in all).
- Browser probes, rewritten for the groups and tiles: `probe-lift-filter` 23, `probe-tile` 12, `probe-unlinked` 19,
  `probe-cf` 30, `probe-keyboard-tiles` 14 (Tab: two kind tiles, the calls tile and three groups, nothing inside a
  closed group; Enter opens "תוספים" and Tab enters it), `probe-call-age` 26 (9001 on the same board when pressed).
- Batch of 24 probes, all green.
- ⚠️ **Harness:** `lib.mjs` has `infoOptions(page, kind)` (the list in the old `<select>` shape, `{v, t: "label (n)"}`),
  `pickInfo`, `infoValue` and `infoActive`, with kind = type | system | tier | lift. `openGroup(page, "fg-info")` is
  built in. `probe-prod`, `probe-stale` and `probe-svc` still read the old `<select>`. They sign in to production and
  were not ported.

## Three roles: manager, editor, operator (built 19/10/2026)

The owner: *"אני רוצה שיהיה עורך, בקר ומנהל. בקר אין לו שום יכולת לשנות כלום רק לראות. עורך יש לו יכולות עריכה של הכל
חוץ ממחיקת אתר, הוספת משתמשים ומחיקת משתמשים"*.

**Her answers:**
- The three operators of that day (the call centre's account among them) **became editors**, so the call centre
  keeps working.
- V on a task stays as it was: sherut@, or an editor/manager who types the admin code. A בקר cannot, even with the code.
- X on a task: every editor and manager.
- The 13 managers stay managers. She reassigns people herself from the users screen, which now has a three-way picker.

**In the database (the authority):**

| | Who | Where |
|---|---|---|
| Read | all three (`require_staff` / RLS) | `app.is_staff` now includes `'editor'` |
| Every write | manager or editor | `app.require_editor()` (`writes.postgres.sql`), `app.can_edit()` (`security.postgres.sql`) |
| Manager only | delete a site; users (invite, deactivate, role, the list); the admin code; the deleted-site leftovers tools (`compliance_storage/orphans/reattach/purge`); the field-reports inbox | `app.require_manager()` / `is_manager()` |

- `require_editor` has the same shape as `require_manager`: identity first, then the role read from `app_users` (a
  demoted role takes effect at once), then the second factor. The refusal reads "בקר יכול רק לצפות — הפעולה מותרת
  לעורכים ולמנהלים". ⚠️ The `mfa_required_for_manager` flag (off) would now cover all editing, not only manager actions.
  Otherwise turning it on would protect site deletion and leave the editing that moved here from `require_manager`
  without a second factor.
- ⚠️ **The Wizenet intake identity holds the manager role in production.** `is_staff` already excluded it, and
  `require_editor` excludes it explicitly too (`is_intake_client`). Without that, a manager-role intake could edit.
  Since the review the same evening, `current_app_role()` returns `'intake'` for it, so manager actions are closed to it
  too (see *The review of 702eb98* below).
- **What moved, beyond the obvious:**
  - Maintenance (start / schedule / cancel) used to be open to "any active user" ("attribution, not prevention"). It
    now requires an editor.
  - Tasks (add / ⏳ / V / X), the Wizenet relay requests, all inspector and PM writes, the traffic light (`tl_*`),
    `register_site` / `update_site`, reclassify, test marks, controller replaced, announcements and the reload
    broadcast.
  - `can_delete_task` = staff and an editor; `can_close_task` = staff, an editor, and sherut@.
- ⚠️ **Three manager overrides stay manager-only on purpose** (`compliance_verified_manager`): discarding a colleague's
  draft visit mid-work, the files of a deleted report, and a deleted visit. These are overrides, not editing. If editors
  had them, the protection of a technician's draft from colleagues would disappear entirely, since everyone who writes
  is now an editor or a manager.
- `submit_field_report` stays open to every active user (a letter to the manager, not site data), as does marking an
  announcement as seen. Say so if a בקר should not report either.
- `set_user_role` accepts three roles. Demoting a manager, to editor or to operator, keeps both guards: not yourself,
  and not the last active manager.
- **The role constraint** (`app_users_role_check`) includes `'editor'`. The `DO` block in `schema.postgres.sql`
  replaces it once (its condition now looks for `editor`).
- **The one-time move** (`security.postgres.sql`): `UPDATE app_users SET role = 'editor' WHERE role = 'operator'`,
  guarded by `settings.roles_editor_migrated`. Without the flag every apply would silently turn every new operator into
  an editor. On a fresh database it runs when there are no users and sets the flag. ⚠️ It writes no `audit_log` rows:
  the three changes are recorded here and in the owner's answer.
- **Edge Functions:** `invite-user` accepts `editor` (inviting stays manager-only); `provision-agent` also accepts an
  editor, because an editor registers sites and the agent identity is created in the same action. ⚠️ **Both must be
  redeployed** (`npx supabase functions deploy <name> --project-ref xvfsikwaaaohnmldjbtv --use-api`; neither uses
  `--no-verify-jwt`). Until then an editor's new site gets no agent identity, and the modal says so (`agentError`).

**On screen** (`utils/roles.js`: `canEdit`, `isManagerRole`, `roleLabel`, `READ_ONLY_MSG`, the same sentence as the
database):
- **A בקר sees no write controls:**
  - Tasks: no add form; ⏳ / V / X are locked, and a click explains under the row with no code field.
  - Calls: status and type are plain text, not pickers.
  - Maintenance in the site window: the state only, plus the sentence. The supervisor table has no "בטל".
  - Inspector: no upload, no actions, no "סימון כבוצע".
  - PM: no start, continue or restart, and no tools.
  - Site management: the lock screen with "התפקיד שלך: בקר".
  - Traffic light: no edit mode. Service-agreement link: no buttons.
- **An editor gets the manager's screens except:** "מחק" in site management, "שנה קוד מנהל", the users button (👥, now
  manager-only in the header), the field-reports inbox, and discarding someone else's draft.
- 42501 messages: the data layer used to translate every 42501 to "מנהלים בלבד". It now shows the function's own Hebrew
  message and translates only Postgres's own "permission denied".

**Tests:**
- `tests/roles.test.js` (9):
  - ⚠️ **a census:** every public function must be classified as editor, manager or read. A new unclassified function
    fails, so a write cannot be added behind `require_staff` (which lets a בקר in) without a decision.
  - a בקר refused on every kind of write, and reads work;
  - an editor edits, and is refused delete / users / admin code;
  - `set_user_role` with three roles; the one-time move runs once; the intake identity is not an editor; the screen
    helpers and the sentence match the database.
- Existing tests: the users who write became editors, and a real read-only operator was added to the permission tests
  (compliance 5/20/22/27/38, tasks T17–T21, PM lists and profiles). New: tasks T23 (sherut@ demoted to operator: no V
  or X in the list, and V refused). `admin-gate.test.js` pins `editable` in the direct arm, and `isManager` on "שנה
  קוד מנהל". Full suite 1232/1232.
- **Mutations (isolated copy, `mut1910/run-mut4.cjs`): 14 of 14 caught.** Among them: require_editor letting a בקר
  through, can_edit including operator, delete_site opened to editors, the one-time move on every apply, the intake
  identity not excluded, the demotion guard only for 'operator', and the compliance overrides opened to editors.
  ⚠️ `can_close_task` without `can_edit` survived at first. Writes were still refused (`task_done` checks the editor
  first), but the list told a בקר sherut@ that V was allowed. T23 was added for it.
- Browser: `e2e/probe-roles.mjs` 12 (three roles: users button, call pickers, site management), `probe-tasks` K13 (a
  real בקר) 241/241, `insp/run` E (a בקר cannot mark done), `pm/run` (the technician is an editor; a בקר gets no start
  or tools) 141/142 (the remaining one fails by the calendar since 10/10).
- ⚠️ **Harness:** `mock-useAuth` in e2e and insp accepts `role=editor`. In pm (`main.jsx`) the default is now `editor`,
  the technician, keeping the same `uid-op`. Every probe that runs a technician's flow uses `role=editor`: `fx.mjs`,
  `fx2.mjs`, `probe-photos-all`, `probe-tap`, `pm/run`.
- The maintenance form lives in the site window's overview, which the harness does not render ("תובנות אינן מדומות"),
  so its read-only state is checked by code reading only.

**Deploy order:**
1. SQL. The three operators become editors in the same apply.
2. The two Edge Functions.
3. The dashboard.

An old bundle before step 3 shows an editor as "בקר" in labels, but can do everything the database allows.

✅ **Deployed 19/10/2026 at the owner's word ("כן, לפרוס את הכול"), in that order.**
- **SQL:** 12 seconds, then "הייצור זהה לקוד". Checked right after: 3 active editors and 15 managers, the flag set, the
  constraint with `editor`, both functions present. An editor gets `my_role = editor`, `can_edit = true`,
  `is_staff = true`. 81 agents beating.
- **Edge Functions:** `invite-user` v7 and `provision-agent` v6, both with `verify_jwt = true` as before;
  `service-calls` untouched.
- **Dashboard:** pushed.
- The owner also confirmed that a בקר may still send a field report ("כן, בקר יכול לדווח").

### The review of 702eb98, and what it fixed (19/10/2026)

An independent review called every public function as a בקר and as an editor (PGlite with Supabase's default grants)
and found no write a בקר can reach and nothing manager-only an editor can reach. Five defects at the edges:

1. **Every token refresh briefly turned the migrated editors back into בקרים on screen.** The one-time move and
   `set_user_role` change only `app_users`; the token keeps the old `parkomat_role` (`operator` for the three, the call
   centre among them). `onAuthChange` first reported the token's role, then the database's, so for one round trip
   editor-only parts were **unmounted**: a one-time agent password in "זהויות אתרים" gone for good, PM tools with
   unsaved edits gone. Fix: `services/auth.js` keeps the last `my_role()` answer per user id (`dbRole`,
   `withKnownRole`) and the quick token callback uses it; sign-out clears it. `useAuth` shares the last known user
   across instances (`lastUser`), so a dialog that mounts later starts from the real role instead of null ("בקר").
   Not done: writing `parkomat_role` into `app_metadata` on a role change (needs the Secret key, i.e. an Edge Function).
2. **"אין כרגע ממסר פעיל" never appeared** — `loadRelay` was a `useCallback(…, [])` reading `canWrite`, which is false
   on the first render. Deps `[canWrite]`. Same root in `TasksDialog`'s focus effect (deps `[editable]`). The harness
   could not catch either: its `mock-useAuth` returns the user synchronously.
3. ⚠️ **The Wizenet intake identity is `manager` in `app_users` in production** (measured; the design said it would
   have no row at all). `require_editor` and `is_staff` excluded it, `require_manager`, `my_role()` and the two Edge
   Functions did not: with its password one could delete sites, invite users and rotate agent passwords. Fixed at the
   root: `app.current_app_role()` returns **`'intake'`** for the identity in `settings.intake_user_id`, so
   `is_manager`, `can_edit`, `my_role()` and every Edge Function check see a non-human role. The condition is written
   inline (not `is_intake_client()`, which is defined in a later file, and a `sql` function is validated at creation).
   The intake only inserts into `service_calls`, under a policy that does not read the role.
4. **"השבת" / "הפעל מחדש" in "זהויות אתרים" always failed for an editor** (`set_user_active` is manager-only). Shown
   to managers only. And `provision-agent` now refuses an editor's "סיסמה חדשה" on a **disabled** identity, since a new
   password sets `is_active = true` — an editor could otherwise undo a manager's deactivation.
5. **`claim_service_command` / `complete_service_command` were revoked from PUBLIC only.** Under Supabase's default
   grants a fresh database leaves them executable by `anon` / `authenticated`. In production they were already closed
   (measured); the file now revokes from both explicitly, so every database built from the code matches.

Tests: `roles.test.js` 9 (the intake: `my_role = intake`, not manager, not editor, `delete_site` / `set_user_role` /
`list_users` refused; the two functions closed to both roles). Mutations (`mut1910/run-mut5.cjs`): 4 of 4 caught. Full
suite 1233/1233; probes roles 12, tasks 241, calls 63, agentpw 19, admin-sticky 14, relay 24.

✅ **Deployed 19/10/2026 at the owner's word** ("כן, להחיל" / "כן, לפרוס"): the dashboard by push; the SQL — the dry run
showed exactly one gap (`current_app_role` body; the two REVOKEs were already true in production), applied in 9 s,
then "הייצור זהה לקוד"; `provision-agent` redeployed (`verify_jwt` still on — a request without a token gets the
gateway's 401). Checked in rolled-back transactions: intake → `my_role = intake`, not manager / editor / staff; a manager,
an editor and an agent unchanged. 80 of 84 agents beating.

## Login code by email — two-step sign-in (built 20/10/2026, behind a flag, NOT live)

The owner: *"כל פעם כשמישהו רוצה להיכנס לדשבורד נשלח לו מהדשבורד למייל שהוא חיבר כשהוא נרשם מייל עם קוד בן 4 ספרות.
המייל של הדשבורד הוא dashboard@parkomat.co.il"*. Her four answers, all as recommended: **on every new sign-in** (not on
every page load), **all users**, **sent through Microsoft 365 with Graph** (the company's mail is Exchange Online — MX
`parkomat-co-il.mail.protection.outlook.com`, SPF `include:spf.protection.outlook.com … -all`), and **the email code
replaces the TOTP app**, whose screens were deleted (nobody had enrolled; `auth.mfa_factors` was empty).

- **The unit is the sign-in, not the user.** Every password sign-in is a GoTrue session; its id rides in every access
  token as `session_id` and survives token refresh. A verified code marks that session (`login_codes.session_id`), so a
  wall screen stays verified for days, and a new sign-in — or a session pruned after a day unused — asks again.
  ⚠️ `changePassword` re-signs-in to check the current password, which is a new session: after a password change the
  person is asked for a code again. Accepted.
- **Enforced in SQL, in the four functions every permission goes through** (`security.postgres.sql`): `app.session_ok()`
  is added to `current_app_role` (returns **`'unverified'`**, so `is_manager`, `can_edit`, `my_role()` and every Edge
  Function check see no role), `is_active_user` (every RLS read policy), `current_app_user`, and `is_staff`
  (`compliance.postgres.sql`). A password without the code reads and writes nothing, through PostgREST too.
- **Exempt:** calls with no token (the server, the gates' GUC identity), agents (`role = 'agent'` — a machine reads no
  mail, and a site waiting for a code is a site that stopped reporting), and the Wizenet intake identity. The code applies
  to manager / editor / operator.
- **The flag:** `settings.login_code_required` — `'all'`, or a comma list of emails for a pilot (case and spaces ignored).
  Absent = off; `''` = nobody.
- **The doors** (all SQL; the Edge Function only carries the mail, rule 3):
  - `public.login_code_status()` → `{required, verified, email}` (authenticated).
  - `public.login_code_verify(code)` → `{ok}` or `{ok:false, error: wrong|locked|expired|none|format|no_session, left}`.
    It never raises on a wrong code, so the attempt count commits.
  - `public.login_code_issue(user, session, force)` — **service_role only**, because it returns the code itself. Statuses:
    `send` (with `code`, `email` from `app_users`, `name`, `ttl_min`), `pending` (a valid code exists and `force` is false —
    reopening the screen sends nothing), `wait` (`resend_in`), `limit` (`per: hour|day`), `verified`, `not_required`,
    `no_user`. An advisory lock per session stops two tabs from issuing two codes.
  - `public.login_code_unsend(session)` — service_role; the mail failed, so the code is cleared and "שלח קוד חדש" works
    at once. ⚠️ The send still counts toward the caps, or a broken M365 would turn every click into another call there.
- **The numbers:** 4 digits from 32 strong random bits (`gen_random_uuid`, not `random()`), stored as sha256(session:code),
  10 minutes, 5 attempts per code, a new code at most once a minute, 5 an hour and 20 a day per user (per user, not per
  session — a new sign-in does not reset it). At most ~100 guesses a day (1%) for someone who **already has the password**.
- **No sign-in history:** no `audit_log` row (the owner, 18/10: *"זה לא מעניין אותי בכלל מה התחבר"*).
  `app.prune_login_codes()` runs inside `app.prune_auth_sessions` (03:57 UTC): rows of sessions that no longer exist (after
  an hour's grace), and sends older than two days.
- **`app.current_actor` / `current_role` / `current_aal` cast with `NULLIF(…, '')::json` now.** After a `SET LOCAL` ends
  the setting is `''`, not NULL, and `''::json` throws — a connection that once carried a token (the pooler, or a test)
  failed every later query. The new `session_ok` depends on it, so it was fixed at the root.
- **Edge Function `send-login-code`** (`handler.ts` tested in Node + `index.ts`): checks the caller with GoTrue
  (`/auth/v1/user`, and the token's `sub` must match), reads `sub` / `session_id` from the token the gateway already
  verified, calls `login_code_issue` with the service key, gets a Graph token (client credentials, cached about an hour,
  one retry on 401) and sends from `dashboard@parkomat.co.il` (`saveToSentItems: false`). The response never carries the
  code. Missing Graph settings → 503 **before** issuing a code. Secrets: `MS_TENANT_ID`, `MS_CLIENT_ID`,
  `MS_CLIENT_SECRET` (and `LOGIN_CODE_FROM`, default `dashboard@parkomat.co.il`); every value is trimmed. Deployed
  without `--no-verify-jwt`.
- **The dashboard:** `AuthGate` asks `login_code_status` after sign-in, and again when the user changes or the role from
  the database becomes `'unverified'`. `LoginCode.jsx` sends the code on open, auto-submits at 4 digits (paste of the
  subject line works), counts the resend down from a deadline (a background tab throttles timers), and has "יציאה". A
  failed status check is neither "no code" nor "locked": a retry screen that retries every 15 seconds. After the code,
  `reloadRole()` (`services/auth.js`) re-reads `my_role()` — the token does not change on verification, so nothing else
  would. `check-switch` allows the three `loginCodeDirect` names (no server arm, like the TOTP ones before).
- **Tests:** `login-code.test.js` 11 (PGlite with Supabase's default grants; off, on, issue/verify, randomness, attempts and
  expiry, caps, unsend, exemptions, pilot, grants, prune) — **30 of 30 SQL mutations caught** (`mut1910/run-mut9.cjs`);
  `login-code-fn.test.js` 7 (the Edge Function with a fake fetch: what goes where, the code never returns, secrets stay on
  their hosts, Graph failures unsend); `login-code-ui.test.js` 3; `roles.test.js` census (+4). Full suite 1259/1259.
  Browser: `scratchpad/lc/probe-lc.mjs` 39/39 — a separate mini harness (the real `AuthGate` + `LoginCode`, mocked
  `loginCodeDirect` / `auth` / `useAuth`), 1280 light and 390 dark. It found two real defects before any user did: a
  `maxLength` that cut a pasted subject line before its digits, and the "יציאה" link at 3.7:1 in dark.

**Status 22/10/2026** (the owner: *"אני רוצה שיהיה אימות דו שלבי… המייל של הדשבורד זה dashboard@parkomat.co.il"*):
step 1 is done (the SQL went out with the Ituran apply; `login_codes` / `login_code_sends` and the four `login_code_*`
functions are in production), step 3 is done (`send-login-code` v1 deployed, `verify_jwt` on; no token → 401, the anon
key → its own "אימות נכשל" 401), step 4 is done (the screen has been in the live bundle since 20/10). **The only blocker is
step 2**: `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` are not in the Edge Function secrets — it needs whoever
administers Parkomat's Microsoft 365. The flag is absent, so nobody is asked for a code.
⚠️ **Later on 22/10:** the IT admin registered the app ("Dashboard"), and the three secrets are now set in Supabase. The
owner pasted them into the chat; they went to Supabase through a temp file that was deleted, and they are in no file in
the repo. A direct Graph test from the dev PC got a token, but the token carried **`roles: []`**, and `sendMail` as
dashboard@ returned **403 ErrorAccessDenied**. So **Mail.Send was not granted as an *Application* permission with admin
consent** — most likely added as Delegated, or the consent was not granted. No mail went out. The fix is on the M365
side only. After it, re-run the same direct test (the roles must include `Mail.Send`), then the pilot for the owner.

**To go live, in this order** (as written 20/10):
1. SQL (`apply-sql` dry run: 21 gaps — 10 new functions, 8 bodies, 3 indexes; the two tables do not show, `--apply` creates
   them). With the flag absent nothing changes for anyone.
2. The M365 admin: a mailbox `dashboard@parkomat.co.il` (a shared mailbox is enough), an Entra app registration with the
   **application** permission `Mail.Send` and admin consent, a client secret, and an Application Access Policy that limits
   the app to that one mailbox (`New-ApplicationAccessPolicy -AppId <client id> -PolicyScopeGroupId
   dashboard@parkomat.co.il -AccessRight RestrictAccess`). The three values go into Supabase → Edge Functions → Secrets.
   ⚠️ **The client secret expires** (up to 24 months): on that day no code is sent, and everyone the flag covers is locked
   out until the secret is renewed or the flag is removed.
3. `npx supabase functions deploy send-login-code --project-ref xvfsikwaaaohnmldjbtv --use-api`.
4. The dashboard (push). With the flag absent the screen never appears.
5. Pilot: `login_code_required` = one person's email. Then `'all'`.
- ⚠️ **Turning on `'all'` signs everyone out of the data at once:** existing sessions are unverified, so open dashboards
  get empty reads and, at the next token refresh (≤ an hour), the code screen. Every wall screen needs someone to type a
  code once. Pick the time.
- ⚠️ **Every covered account needs a mailbox someone reads**, the shared ones included (`sherut@`, `moked@`, `sales@` —
  measured 20/10: 17 active human accounts).
- ⚠️ **Gates that sign in with a real token** (`check-security`, `check-mfa`, `check-writes`… through `lib/gate-user`)
  will see `'unverified'` once the flag covers their throwaway user. Not handled yet.

## Technicians' vehicles from Ituran — a live map (built and live 20/10/2026)

The owner: *"יש לפרקומט רכבים של אנשי תחזוקה, על כל רכב יש איתוראן"* → asked what she wants, *"כל מידע אפשרי הכלל"* →
phase 1 is a live map, and **everyone signed in sees it** (her choice over "managers and editors"). Ituran opened API access
for the account after a signed form, and created an API user (its name and password are in the Edge Function secrets,
never in the repo — it is public); the docs are a Stoplight project
(`docs.ituran.com`, behind bot protection — the OpenAPI JSON comes from
`ituran.stoplight.io/api/v1/projects/ituran/ituran-api-v2/nodes/reference/Ituran-API-V2.json`, 142 operations, server
`https://api.ituran.com`).

**Measured against the real API (read-only, 20/10/2026):** `POST /api/v1/oauth/token` with
`{grant_type: "password", username, password}` → a token for 1440 minutes plus a refresh token. `GET /api/v2/vehicles`
returns **38 vehicles**, but **no location unless asked**: `realtime_fields=LastLocation&realtime_fields=Driver&
realtime_fields=Places`. Then each vehicle has `last_location.location.point {lat, lon}`, `address.location` ("street,
city"), speed, heading, odometer, `timestamp`, `motion_status` (parking / idle / driving) and `places` (Ituran geofences —
only two exist: משרד, מחסן). ⚠️ **The timestamps are Israel wall-clock time with no zone** (the Wizenet trap again): read
as Israel time the newest was 22 s old. ⚠️ `current_driver` is useless (16 vehicles say "scooter4all", the rest empty); the
technician is in the vehicle's `nickname` (with the plate appended, and "ישן" / "חדש" / "זמני" in some). One unit has
not reported since 08/09. The API answered from Israel and from abroad (no country block like Wizenet's), so Supabase
calls it directly — no relay.

- **SQL** (`master/db/vehicles.postgres.sql`, loaded after `wizenet-relay`): `vehicles_live` — **one row per vehicle,
  updated in place, no history** (Ituran keeps it; storing it would be ~55,000 rows a day with no reader). `vehicles_sync`
  — one row: last success, last error, vehicle count, and `token_fetches` (how often a cold function had to sign in — to
  measure, not guess). Both closed (RLS, no policies, REVOKE from anon/authenticated).
  - `app.ituran_ts(text)` — no zone = `Asia/Jerusalem` (not a fixed −3: 25/10 goes back to +2); `Z` / offset as is;
    unparsable → NULL, never an exception. `app.ituran_num(text)` — the same for numbers.
  - `public.ituran_ingest(vehicles, meta)` — **service_role only**. Parses Ituran's array as it came. The position moves
    only when a position arrived, and only forward in time (a reply without `LastLocation` or a late older one changes
    nothing). 0,0 is "no position". A vehicle missing from the reply is deleted **only** when `meta.complete` and the reply
    was not empty, so a partial or empty answer cannot wipe the fleet.
  - `public.ituran_sync_failed(error)` — service_role; the screen says so instead of showing old positions as current.
  - `public.vehicles_live_list()` — `require_staff` (manager, editor, operator; not agents, not the intake, not an
    unverified login-code session). One jsonb.
  - `app.ituran_sync_request()` + cron `parkomat-ituran-sync` every minute: `net.http_post` to the Edge Function with the
    anon key and a shared secret from `settings.ituran_caller_secret` (the `push_request` pattern). **No secret = not
    enabled: returns NULL and sends nothing** (the screen says "not enabled yet"); a secret without `push_anon_key` is
    recorded as a failure.
  - ⚠️ **No `events` row**, on purpose: an old bundle treats an unknown event type as "reload everything" (the 07/10
    overload), and 1,440 syncs a day would be 1,440 full reloads on every screen. The map polls instead.
- **Edge Function `ituran-sync`** (`handler.ts`, tested in Node + `index.ts`): checks `x-parkomat-ituran-secret`
  (constant time; no secret configured = closed), keeps the Ituran token **in memory only** (not the database, not a file),
  renews it with the refresh token five minutes before it expires, falls back to the password if the refresh fails, and
  on a 401 from the vehicles signs in again once. Pages through the vehicles (100 a page) and passes the raw array to
  `ituran_ingest` with `{complete, token_fresh, pages, ms}`. Failures go to `ituran_sync_failed`. Secrets:
  `ITURAN_USERNAME`, `ITURAN_PASSWORD`, `ITURAN_CALLER_SECRET` (and `ITURAN_BASE`, default `https://api.ituran.com`);
  all trimmed. Deployed **without** `--no-verify-jwt` (the cron sends the anon key).
- **Dashboard:** a floating "🚐 רכבים" button in the corner opposite "רמזור" (where the AI assistant was), only in direct
  mode. It opens `components/Vehicles/VehiclesMap.jsx` full screen, **lazy-loaded** (Leaflet 1.9.4, the only new
  dependency, 47 KB gz in its own chunk; the main bundle is unchanged). OpenStreetMap tiles with attribution; in the dark
  theme the tiles are inverted (the markers are not). Markers are coloured by state (green driving with a heading arrow,
  amber engine on, blue parked, grey hollow "not reporting" = no report for 24 h or never); permanent name labels only for
  vehicles that move (38 labels — 12 at the office — would hide the map). A side list (below the map on a phone) sorted
  driving → idle → parked → not reporting, with search (name, plate, address, place); a row flies to the vehicle and opens
  its popup (name, plate, state and speed, address, place, "עודכן לפני X", a Google Maps link). It polls
  `vehicles_live_list` every minute **only while open and visible**; Esc closes. The sync line says "עודכן לפני X", or a
  warning: not enabled yet / no success for 5 minutes / the last sync failed (with Ituran's reason). Leaflet is used
  without a React wrapper: the map is built once and markers update in place, so an open popup and the user's zoom
  survive each poll. Pure rules in `utils/vehicles.js`.
- **Tests:** `vehicles.test.js` 7 (PGlite: the clock in summer and winter and around 25/10, every field from Ituran's shape,
  forward-only position, 0,0, broken fields, delete only on a complete non-empty reply, sync status and token count, grants,
  the cron request with and without the secret) — **15 of 15 SQL mutations caught** (`mut1910/run-mut10.cjs`; a 16th was
  skipped, its anchor lost a backslash in the shell); `ituran-sync-fn.test.js` 6 (fake fetch: the secret, the token cached /
  refreshed / re-issued on 401, paging, what reaches the database, failures, secrets never leave their hosts);
  `vehicles-ui.test.js` 6. Full suite 1278/1278. Browser `e2e/probe-vehicles.mjs` 55/55 (1371 light, 390 dark; tiles served
  as a blank image): it caught the heading arrow rotating around a point above the marker's centre. **Live:** the real
  `handler.ts` against the real Ituran API into a throwaway PGlite — 38 vehicles, all with position, time and address, the
  newest 22 s old, the token reused on the second run.
- `check-bundle` now looks for `veh-row-name`; three stale markers there (removed screens) were replaced.

✅ **Live since 20/10/2026, at the owner's word ("כן"), in this order:** (1) SQL — it carried the login-code functions too
(they stay off without their flag); (2) the three secrets and `npx supabase functions deploy ituran-sync --project-ref
xvfsikwaaaohnmldjbtv --use-api`; (3) the same random value into `settings.ituran_caller_secret` — the cron started within a
minute (`vehicles_sync.last_ok_at`); (4) the dashboard pushed.
⚠️ The Ituran password was pasted into the chat on 20/10/2026: change it at Ituran, and keep the new one only in the Edge
Function secrets (`ITURAN_PASSWORD`).
⚠️ **Open, the owner's call: every sync signs in to Ituran.** Measured after go-live: 77 of 77 runs got a fresh token — pg_cron
calls once a minute and every call lands on a cold function instance, so the in-memory token never survives: ~1,440 sign-ins
a day at Ituran. Keeping the token in a closed table would stop it, but the token may allow vehicle commands (the account has
immobilizer events), which is why it was kept in memory. The alternatives: accept the rate, or sync every 2–3 minutes.
Later phases (not built): nearest technician to a site in fault, visits to sites (needs coordinates for the sites — none are
stored today — and a geofence per site), reports from Ituran's full report.

### The state on the map is decided in SQL — "לא מתעדכן", "חונה מאז", power alert (20/10/2026, evening)

The owner, a few hours after go-live: the data looks wrong; and on one technician shown as driving: *"לא בנסיעה"*. A
multi-agent audit (a full-fleet snapshot plus ten one-minute samples of the list against Ituran's full report) found the
**positions, addresses, places and clock correct** and two things wrong:
- **`motion_status` is "ignition + speed of the last record", and it never expires.** A unit that stops transmitting mid-drive
  (an underground car park, most likely) stays "driving" for hours: 4 of the 7 "moving" vehicles were frozen 40 minutes to
  7 hours. Measured cadence while the ignition is on: a fix at least every 160 s driving (p99 ~70 s) and 300 s at speed 0;
  parked units send heartbeats every 10 minutes up to ~12 hours, or nothing.
- **"עודכן לפני 4 דק'" on a parked vehicle was the last heartbeat**, not when it parked: a vehicle parked since yesterday
  17:45 read as updated four minutes ago.

What changed:
- **`app.vehicle_state(motion, located_at, synced_at)`** — `driving` while the last fix is ≤ 300 s old, `idle` ≤ 600 s,
  beyond that both are **`silent`** ("לא מתעדכן"); `parking`; `unknown`; **`no_report`** when there is no fix or it is older
  than 24 h (twice the longest parked heartbeat). ⚠️ The age is measured against the row's **`synced_at`, not `now()`**: a
  stalled sync is the sync line's job, not a reason to turn the whole fleet grey (test: a row synced two hours ago with a
  one-minute-old fix stays `driving`).
- **"חונה מאז"** — `app.vehicle_parked_since(events, lat, lon)`, from Ituran's `Events` realtime field (the latest event of
  each type, ≤ 5 per vehicle, now stored raw in `vehicles_live.events`): the latest switch-off / engine-off (else "vehicle
  stopped") **within 200 m of the fix and after every switch-on / engine-on / moving event**. Measured: 27 of 28 parked
  vehicles get a time; the one that does not has events from two months ago, elsewhere. `app.ituran_event_kind(id, name)`
  maps the account's own event ids (off 10181704 / 12746436, stop 12746438, on 12746440 / 5295693 / 12746437, power cut
  12746446 / 12746445, power back 12746447), with the name as a fallback (names are editable at Ituran; spaces are collapsed —
  "חיבור  מתח" has two). `app.geo_distance_m` is a plain haversine (no PostGIS: the exit door).
- **Power alert** — `app.vehicle_power_alert(events)`: the **first** power cut / low battery after the latest power-back
  **or switch-on** (a vehicle that was started has its power back; "חיבור מתח" appeared in no snapshot, so without that rule an
  alert would never clear). Measured: one scooter reported a power cut and low battery four and five minutes after it was
  switched off, and has reported rarely since; the map said nothing.
- **Ingest guards** (`ituran_ingest`): a record without a valid position (0,0, one coordinate, out of range) no longer sets
  `located_at`, so it cannot erase a known position (one unit with a GPS fault sends 0,0 records with speed and heading −999
  and "!! Address not found !!"); speed outside 0–999 and heading outside 0–360 → NULL; an address starting with "!!" → NULL;
  `places` follow the forward-only position rule and are kept when the key is absent; `events` are kept when absent.
- **`vehicles_live_list`** adds `state`, `state_since` (parking → the parked-since time or NULL; silent / no_report → the last
  fix) and `power_alert {at, name}`. `ituran-sync` asks for `LastLocation`, `Places` and `Events` (`Driver` dropped: no unit
  returns a driver).
- **The dashboard only translates** (`utils/vehicles.js`): "חונה מאז 09:12", "לא מתעדכן מאז 11:02", "לא מדווח מאז 13/10
  08:00" in Israel time ("אתמול 17:45" by calendar date, not 24 hours — 25/10 is a 25-hour day); the age column only for
  driving / idle; "מקום אחרון: …" for silent and no_report; "⚠ ניתוק מתח" in the row and "… מאז 08:54" in the popup. A
  silent vehicle is a grey dashed marker with no arrow, no speed and no label, sorted after the parked ones, and counted in
  the summary ("1 לא מתעדכן"). ⚠️ The Leaflet popup is white in both themes, so it forces the light-theme colours (the dark
  greens on white were 1.5–2:1). Without `state` in the reply (an older database) the screen keeps the old rule.
- **Preview in production** (read only, the rows as synced at 15:00): 4 driving, 2 engine on, 25 parked, 5 not updating (the
  four frozen ones, plus one silent for 14 minutes), 2 not reporting.
- **Tests:** `vehicles.test.js` 11 (state boundaries at 4:59/5:00/5:01, 9:59/10:01, 24 h; event kinds; parked-since and power
  scenarios; the guards; `synced_at`), `vehicles-ui.test.js` 12, `ituran-sync-fn.test.js` 6. Browser `probe-vehicles` 70/70
  (silent row and popup, parked with and without a time, the power alert, popup contrast in dark, an old database). Full
  suite 1288/1288.
- ⚠️ **Deploy:** the SQL dry run shows 7 gaps (5 new functions, 2 bodies); the `events` column does not show, `--apply`
  creates it. Then redeploy `ituran-sync` (Events) and push. Any order is safe: the old `ituran_ingest` ignores `events`, and
  an old bundle ignores `state`. ✅ Deployed 20/10/2026 at the owner's word ("תעלה לייצור"): 1bf14e5.
- **The independent review of 1bf14e5** (mutations, a replay of the morning's real snapshots through the new SQL, three
  reviewers with three skeptics per finding) confirmed the four frozen units, the GPS-fault unit, 27 of 28 "חונה מאז" and the
  scooter's power alert on real data, caught 19/21 SQL and 11/15 UI mutations, and found, fixed the same evening:
  - ⚠️ **High: the power alert came back after every park.** Ituran's `Events` keep the latest event of each **pair**
    (switch on/off, engine on/off, moving/stopped), not of each type: 0 of 30 parked vehicles carried an "on" event. The kinds
    are now `ign_on` / `ign_off` / `moving` / `stop` / `power_cut` / `power_ok`, and **any ignition event after the cut — on or
    off — clears it** (a vehicle that was started has its power back). ⚠️ `moving` / `stop` do **not** clear it: a vehicle
    towed away on backup power moves without power, which is exactly when the alert matters.
  - **The repeated hour on 25/10** (01:00–02:00 happens twice; `AT TIME ZONE` picks winter): a first-pass fix was stored an
    hour in the future and a silent unit read "בנסיעה" for about an hour. `app.ituran_ts_at(text, ref)` takes the summer
    reading when the winter one is more than 5 minutes after the reference and the wall-clock hour really repeats; used for
    `last_location` (ref = ingest time) and for event times (ref = now()).
  - **Event names:** "חיבור מתח" is defined as "חיבור" + space + **U+00A0** + "מתח", which `\s` does not match, and the old
    order (trim, then collapse) left an edge tab as a space. `app.ituran_event_name` turns every whitespace (incl. U+00A0,
    U+2007, U+202F) into one space first, then trims.
  - Screen: the summary broke inside an item on phones (each item is `nowrap` now, the "·" glued to the item before it);
    "לא ידוע" was missing from it; "3 מנוע דולק" → "עם מנוע דולק"; the tone colours on the counts never applied
    (`.veh-summary b` won on specificity); the selected-row tint dropped the state colours under 4.5:1 (8% now, and the stale
    grey is `#5b6472`); "לא מתעדכן" and "לא מדווח" were the same grey disc on the dark map (a light dashed ring now); the row
    and the popup used "מקום אחרון" for two different fields (now "מקום" = the Ituran place, "כתובת" = the address).
  - Test gaps closed: out-of-range and one-coordinate records, the ±90/180 boundary, "yesterday" by the Israel date across
    UTC midnight and the 23-hour day, a clock ahead across midnight, exactly 24 h in the old-database fallback.

### "טכנאים" — a header tile, site locations and "which sites they are near" (20/10/2026, evening)

The owner, the same evening: *"שגם יראו בתוך מפה מסודרת איפה הם נמצאים, מצידי בלי מפה — רק מיקומים ולאיזה אתרים הם
קרובים"*; asked how to get site coordinates (there were none), *"כן, עכשיו"* to an approximate location from each site's
address, confirmed or corrected on the map; and then *"אני רוצה שהרכבים יקראו לעמוד הזה טכנאים, וזה יהיה סינון למעלה לצד
הקריאות פתוחות"*.

- **The tile "טכנאים"** (`tech-head-btn`, right after "קריאות פתוחות") replaces the site cards with `TechniciansView` (the
  map and the list), below the header — no floating button, no ✕, no Esc that closes. Pressing "רובוטיים" / "מכפילים" /
  "קריאות פתוחות" or the tile again goes back to the cards (pressing "קריאות פתוחות" from it shows the calls, it does not
  toggle the remembered choice off). While it is pressed the three groups read "לא חל על טכנאים" and are disabled
  (`FilterGroup` has a `disabled` prop now), and the kind tiles are not highlighted. It shows a 🛵 instead of a count: the
  vehicles are fetched only while the view is open. **Not remembered** across reloads, on purpose: the view polls every
  minute, and a wall screen left on it would keep polling. `techMode` lives in `App.jsx`; the header measured one row and
  165px at every width from 1280 to 1920.
- **Site locations:** `sites.lat` / `lon` / `geo_source` (`geocoded` / `manual`) / `geo_precision` (`house` / `street` /
  `area` / `pin`) / `geo_set_at` / `geo_set_by` (`schema.postgres.sql`), with `sites_geo_shape`: all or nothing, inside
  Israel (29.3–33.4 / 34.2–35.95, so a swapped lat/lon or 0,0 fails). "משוער" on screen = `street` / `area`.
  - `public.site_geo_import(rows)` — service only, used by the tool; **never overwrites `manual`**; a bad row is counted, not
    fatal.
  - `public.site_geo_set(code, lat, lon, expected_at)` — editor; confirm (same coordinates → `manual` / `pin`), move, or
    clear (NULLs); `expected_at` = the `geo_set_at` the screen saw (`''` = it saw none) → PT409 for a stale screen;
    audit `site.geo`; **no `events` row** (pinning 219 sites must not reload every screen 219 times).
  - `public.site_locations_list()` — staff; one jsonb.
  - `app.near_sites(lat, lon, 1500 m, 3)` — bounding box, then `geo_distance_m`; `vehicles_live_list` adds `near`
    `[{code, name, m, approx}]` for every vehicle (its last known position).
- **The geocoder, `tools/geocode-sites.js`** (dry run by default, `--apply`, `--only=`, `--refresh`, `--csv=<Wizenet
  project list>`): OpenStreetMap Nominatim, at most one request per 1.1 s with an identifying User-Agent, **only the address
  is sent**, results cached in the machine's tmp dir (not the repo). The address comes from the site name through
  `shared/site-address.mjs` (35 city spellings measured — ת"א / ת''א / יפו ת"א, רשל"צ / רשל'''צ / ראשלצ, י''ם / ירשלים,
  רמהש, הודש, בת-ים…; ranges → the first number; ⚠️ no `\b`, which never matches Hebrew in JS — the 15/10 normaliser in
  `link-multiplier-codes.js` has that bug). A result counts only in the same city **and** on the same street, compared on a
  skeleton without י/ו, geresh and a final א/ה (OSM writes "שינקין", "וילנה", "ארלוזורוב", "כינרת" where our names say
  "שנקין", "וילנא", "ארלוזרוב", "כנרת"). Queries in order: structured, free text, the English address from Wizenet's project
  list (its range "67-69" → "67": Nominatim returns nothing for a range), the street alone, the English street alone.
  Measured on the 219 sites: **126 at the building, 74 approximate (street), 19 not found** (15 + the four with no number or
  city: נמל מסילות, פלורנטין, נמל דולי, פייבל 17) — those are pinned by hand. ⚠️ OSM writes Tel Aviv "תל־אביב–יפו" (maqaf and
  en dash); the city compare normalises both. ⚠️ The first run held the database connection through minutes of searching
  and the pooler dropped it at site 80; the tool now reads, disconnects, searches, and reconnects only to write.
- **On screen:** each row gets "ליד הרצל 50 · 120 מ׳" (the nearest site within 1.5 km, the name without the city;
  "כ-300 מ׳" when the site's location is approximate); the popup lists up to three ("אתרים קרובים: …"); the list search also
  matches the nearby site's name. "אתרים במפה" turns on the site layer (small squares: confirmed = filled blue, by address =
  filled grey, approximate = dashed, none = dotted in the list) and a second tab, "אתרים לבדיקה · N" (no location first, then
  area, then street). An editor confirms from a site's popup ("אישור המיקום"), drags it ("הזזה" → "שמירה כאן"), or pins a
  site with no location (a banner, a click on the map, "שמירה כאן"; Esc cancels). A בקר sees it all with no buttons.
  `components/Vehicles/siteLayer.js` is plain Leaflet (popup buttons wired with `onclick`, so a re-opened popup cannot save
  twice); `utils/vehicles.js` has `distanceText`, `nearList`, `nearText`, `SITE_GEO`, `siteGeoKey`, `sitesNeedingCheck`,
  `siteGeoCounts`.
- **Tests:** `vehicles.test.js` 17 (shape, import, set/confirm/clear/stale, permissions, nearest sites, the review cases),
  `site-address.test.js` 5, `geocode-sites.test.js` 7, `vehicles-ui.test.js` 14, roles census (`site_geo_set` editor;
  `site_locations_list`, `site_geo_import` other), `check-row-cap` declares the three. Full suite 1308/1308. Browser
  `e2e/probe-vehicles.mjs` 96/96 (the tile and its place, the groups disabled, back to the cards, "ליד", the site layer —
  confirm, pin with Esc in between, a failed save, a read-only בקר — polling only while open, 1371 light and 390 dark);
  `probe-keyboard-tiles` 18, `probe-site-kind` 36 (its "הכל" selector now skips the new tile), `probe-open-calls` 60,
  `probe-square` 201, `probe-cf` 30.
- ⚠️ **Deploy:** SQL first (the dry run shows 11 gaps: 6 new functions, 5 bodies; the six `sites` columns and
  `sites_geo_shape` do **not** show — check `information_schema.columns` after `--apply`), then
  `node --env-file=.env tools/geocode-sites.js --csv=<project list> --apply`, then push. An old bundle ignores `near`.
  ✅ Deployed 20/10/2026 (c8b6348): SQL applied, 200 locations written, pushed.

### A card per technician, a quiet map, and what each one did today (21/10/2026)

The owner: *"כשלוחצים על טכנאים יש אופציה לראות מפה של מיקומים אבל בלי מפה אמיתית מבלבלת מתחת, וכן אופציה לראות כרטיס
לכל טכנאי. לכל טכנאי רואים איפה הוא נמצא, האם הוא נמצא באתר (אם הרכב שלו חונה ליד אתר שלנו), ועוד כל פרט וסטטיסטיקה —
תהיה יצירתי ותחשוב גדול, חזק ויפה"*; and, looking at the first quiet map: *"שלא יהיו אחד על השני — שיהיה ברור מה קורה"*.

- **"טכנאים" has two views, "כרטיסים" (default) and "מפה"** (`TechniciansView.jsx`: the header, the segmented switch, the
  team line, the sync and stats warnings). The choice is remembered per user per device (`parkomat.techView:<uid>`). One
  query feeds both views: `vehicles_live_list`, once a minute while open and visible.
- ⚠️ **"טכנאי" here is a vehicle in Ituran** (the name from its nickname). The coordinator's board, with a technician ↔
  plate mapping and statuses, is built in SQL and dormant (*The coordinator's board* below).
- **"באתר" = stopped near one of our sites**, decided in SQL: `app.site_at(lat, lon)` — the nearest site within
  `app.site_radius_m`: **150 m** for a site located at the building or confirmed by hand, **300 m** for an approximate
  (street / area) site, marked `approx`. Only when the state is parking, idle or silent (a unit that went quiet next to a
  site — an underground car park — is "באתר, אין קליטה"; decision 14 of the technicians plan). Driving past a site is
  never "at the site". `vehicle_json` returns it as `at_site` (shared with the dispatch board). Measured the morning of
  21/10: 7 parked vehicles within 115–324 m of a site, 6 of them by an approximate site — hence the "מיקום האתר משוער —
  ייתכן שהוא חונה ליד, לא בו" note on such a card.
- **What is stored for the statistics — summaries, not tracks** (`master/db/vehicle-stats.postgres.sql`):
  - `vehicle_days` — one row per vehicle per Israel day: km (Ituran's odometer: start of day → last), seconds driving and
    at sites, stops, max speed, first and last movement, and the **day timeline** — segments `[kind, from minute, to
    minute, site code]`, minutes from the Israel midnight (`day_minutes` is 1380 / 1440 / 1500 on DST days).
  - `vehicle_visits` — one row per visit to a site: arrived (the ignition-off time when the vehicle parked there within the
    last 12 hours, else the sample), last seen, ended, `no_signal`. A visit under 2 minutes is deleted on close (a traffic
    light next to a site is not a visit). One open visit per vehicle (partial unique index).
  - **No coordinates in either table.** ~38 day rows and a few hundred visits a day. Both closed (RLS, no grants).
  - Retention (`app.prune_vehicle_stats`, cron `parkomat-prune-vehicle-stats` 04:47 UTC): visits 90 days, day summaries
    13 months, their timelines 90 days. An open visit is never pruned.
- **The sample is every sync.** `ituran_ingest` calls `app.vehicles_track(now())` at its end, **in its own block**: a
  failure there is caught and written to `vehicles_sync.stats_error` (the screen says "הסטטיסטיקה של היום לא התעדכנה —
  המיקומים כן"); the fleet sync never fails because of statistics. The time between two samples belongs to the **previous**
  state, capped at 5 minutes — a longer gap (a sync outage) is a `none` segment, not two hours of driving. `kind` =
  `app.vehicle_kind`: drive (driving, or engine on away from a site — a traffic light), site, park, silent, none. Only
  vehicles that came in this sync are counted; a sample older than the last one is ignored; a day caps at 400 segments.
  A vehicle that left the Ituran account has its open visit closed.
- ⚠️ **Found by the tests, fixed before anyone saw it:** closing and deleting a short visit in one statement (`WITH c AS
  (UPDATE …) DELETE … USING c`) never deleted anything — the two parts of one statement do not see each other's changes,
  so every traffic light stayed a visit. Two statements now.
- **`vehicles_live_list` adds** `stats` per vehicle (`app.vehicle_stats_json`: the open visit, today, today's visits, seven
  days) and `alerts` (`app.vehicle_alerts_json`): every site in fault (`status = 'error'`, with a controller) or with an
  open Wizenet call (`app.service_calls_current`, the one definition), with the vehicles already there (open visit) and the
  three nearest that are not "לא מדווח" — "מי הכי קרוב".
- **The cards** (`TechCards.jsx`, `TechCards.css`, pure rules in `utils/techStats.js`):
  - On top, **"צריכים טכנאי עכשיו"**: each site in fault or with a call — the controller's fault text, "טכנאי באתר: X",
    or "הכי קרוב: X · 1.2 ק״מ · חונה"; a name scrolls to and highlights that card; "לקריאות" opens the calls dialog.
  - **"הצוות היום"**: km, hours driving, visits, distinct sites, the first departure, how many moved today.
  - Filters by group (הכול / באתרים / בתנועה / חונים / לא מתעדכנים, singular for one) and a search (name, plate, address,
    the site he is at, the sites he visited today).
  - **Each card**: a stripe and an initials circle in the group's colour, the state chip, **where now** ("באתר הרצל 50 ·
    1227 · מ-10:42 · 35 דק׳", "בנסיעה · 54 קמ"ש · ליד …", "חונה מאז 09:30 · 640 מ׳ מהרצל 50", "לא מתעדכן מאז … · ליד …"),
    and when at a site: the site in fault (with the text), in maintenance, its open calls and tasks as buttons that open
    the existing dialogs. Then four numbers (km, hours driving, visits, departed at), the day timeline (06:00–22:00,
    widened to the hour of any activity; parking from midnight does not stretch it), today's visits, seven bars for the
    week, max speed, "במפה" and "ניווט".
  - "לא מדווחים" (no report for a day) are folded at the bottom.
- **The map is quiet** (`FleetMap.jsx`, the old map moved out of the view): **no street tiles by default** — a dotted
  background, our sites as small grey reference dots, city names at the centre of their sites, sites that need a technician
  in a red (fault) or amber (call) ring. "רחובות" brings OpenStreetMap back; "אתרים במפה" turns it on by itself (a site
  cannot be pinned without streets). "כולם" fits every vehicle; the first view fits the core of the fleet
  (`corePoints`: within 3× the median distance from the median centre, at least ~3 km) so Gush Dan fills the screen, not
  Ashkelon and Jerusalem.
- ⚠️ **"שלא יהיו אחד על השני"** (`utils/declutter.js`): every technician is a label (a dot in the state colour, the name,
  the site code when at a site). After every zoom, refresh or resize the labels are placed one at a time — moving and at-site
  first — each at the free spot nearest its true point (rows the label's height, columns of 16 px), and a thin line leads
  from the label to a small dot at the true point when it moved. A label of a vehicle on screen stays inside the map; one
  off screen is not pulled in. City names that collide with a label or a bigger city are hidden. ⚠️ The first version
  pushed overlapping pairs apart and did **not** converge: 38 labels still overlapped after 160 rounds (the unit test).
  Greedy placement has no overlap by construction. ⚠️ The relayout after a resize runs in the next frame — inside the
  ResizeObserver callback it fired "ResizeObserver loop completed".
- **Tests:** `vehicle-stats.test.js` 11 (radius by precision, kinds, a whole day minute by minute — drive, a visit, a traffic
  light next to a site, km, speed, stops, the timeline — a sync gap, a repeated / late sample, midnight and DST day
  lengths, silent at a site, arrival by ignition-off, a removed vehicle, the 400 cap, the ingest hook and its failure,
  "מי הכי קרוב", permissions, prune), `vehicles.test.js` and `technicians.test.js` updated, `tech-stats-ui.test.js` 9,
  `declutter.test.js` 6. Full suite 1350/1350. Browser (scratchpad harness): `probe-techcards.mjs` 66 (cards, alerts, team,
  filters, the calls dialog from a card, the map with 30 vehicles in one block: no label overlaps at three zooms, lines to
  the true points, no tiles until "רחובות", "במפה" from a card; 1371 light, 390 dark) and `probe-vehicles.mjs` 109
  (rewritten for the switch and the labels). Mock: `mock-vehicles.js` (`?veh=dense|statsfail|old`), `?techsites=1`.
- ⚠️ **Privacy, the owner's call:** visits and day summaries are a record of where each vehicle stopped and when it
  started its day. Decision 6 of the technicians plan (store, delete coordinates after 30 days, **tell the technicians in
  writing first**) covers it — the written notice is still to be sent.
- ⚠️ **Deploy:** SQL first. The dry run lists the new and changed functions; the two tables, the `vehicles_sync` columns and
  the dispatch board's tables do **not** show — check `information_schema` after `--apply`. Until the SQL is applied the
  cards show "—" (an old database has no `stats`) and the map works as before.

### The coordinator's board — built in SQL, dormant (20/10/2026)

Phase 1 of the technicians plan (the owner approved decisions 1–8 as recommended): `master/db/technicians.postgres.sql`
— `technicians` (name, the Ituran plate, the current status, `rev` for stale screens), `tech_dispatches` (a site or a free
place, details, a Wizenet ticket, arrived / entered / ended as times, `end_kind` done / cancelled / moved, one open per
technician) and `tech_log` (one row per change, `source`, a vehicle snapshot on dispatch milestones only; coordinates
cleared after 30 days, everything after 90 — `app.prune_technicians`, cron 04:37 UTC). RPCs: `tech_board`, `tech_day`
(read, staff), `tech_save`, `tech_set_status`, `tech_dispatch`, `tech_dispatch_mark`, `tech_dispatch_end` (editor). The 8
statuses are in four copies (`app.tech_statuses()`, two CHECKs, `TECH_STATUSES` in `utils/technicians.js`), compared by a
test. "בדרך" / "באתר" come only from a dispatch, and no status changes while a dispatch is open (ending it sets the next
status) — so they hold exactly while a dispatch is open. Explicit times are bounded (`app.tech_when`): not in the future,
≤ 12 hours back, not before the dispatch / arrival, not after entering; a time on an existing mark is a correction row.
**Pilot gate:** `settings.technicians_board` = `'all'` or a list of emails; absent = off for everyone (the board returns
`{enabled: false}` and every write is refused). `technicians.test.js` 17; `services/techniciansDirect.js` is the data
layer. ~~**No UI yet**~~ — since 21/10/2026 the cards use it for "צא ל:" (below); the statuses and the day log still have no
UI.

### "צא ל:" on every technician card — step 1 of 4 (built and deployed 21/10/2026, d56b1b2; pilot: one account)

✅ **Deployed 21/10/2026, at the owner's word ("מאשרת לפרוס"), together with step 2 and the cards below.**
- **SQL:** 60 gaps, 11 s, "הייצור זהה לקוד".
- **Function:** `provision-technician` deployed. A call with no token gets the gateway's 401.
- **Pilot:** `settings.technicians_board` = the owner's account only.
- **Push:** live bundle `index-B3BlDTeD.js`.
- **Checked right after:**
  - The five new tables are closed (RLS, no grants).
  - The role constraint includes `technician`.
  - Both prune jobs are scheduled.
  - The Ituran sync runs with `stats_error` NULL.
  - There were 38 `vehicle_days` rows and 7 visits after the first syncs.
  - 86 of 89 agents were beating.
- ⚠️ To open it to the coordinator, add his email to `technicians_board` (a comma list), or set it to `all`.
- **22/10/2026: two editors were added at the owner's request** (*"את האופציה של הטלפון גם ל-…"*). Told that the pilot
  covers all of the board ("צא ל:", "טלפון", the next task), not the phone alone, she answered "כן, תוסיף אותם אתה". The
  list is now three accounts. It was written by a guarded update (only if the value was still the owner's account alone).
  There is no separate "phone only" permission.
- **Later on 22/10: eyal@ was added** (the owner: *"אני רוצה שגם אצל אייל יהיה את האופציה לעשות את ה-QR לטכנאים"*). He is a
  manager, so only the pilot list was missing. It was appended by a guarded update (only if the list still had exactly
  the three accounts), and the list is now four. He sees "צא ל:", "טלפון" and the next task the next time he opens
  "טכנאים".
- ⚠️ **The pilot first named the wrong account.** It got the email the session runs under, not the one the owner signs in
  to the dashboard with, so she saw no "צא ל:". Measured from `auth.sessions` and moved to her dashboard account the same
  morning. Check who actually signs in before setting a pilot.
- **The same morning, from her screenshot:** *"מנוע דולק זה לא נקרא בתנועה"*. On the cards "מנוע דולק" is now a group of
  its own (`idle` in `GROUPS`, `utils/techStats.js`, the map's amber), between בתנועה and חונים. It has a filter chip and a
  place in the summary ("N עם מנוע דולק").
  - Until then idle was counted as "בתנועה" (move).
  - Idle at a site is still "באתר".
  - Tests: `tech-stats-ui.test.js`, `probe-techcards` 74, `probe-vehicles` 109.
- A failed first load of `tech_board` now shows a line ("המשימות של הטכנאים לא נטענו"). Before, "צא ל:" simply did
  not appear, with no sign why.

The owner: *"שכל כרטיס יהיה סוג של ניהול הטכנאי: כפתור משימה 'צא ל:', ואז SELECT עם כל שמות האתרים — שמתחילים להקליד
פחות או יותר — ואז זה שואל מה המשימה, טקסט חופשי, ובסופו של דבר שזה יצפצף לאותו טכנאי בצורה של APK"*, *"צעד צעד"*.

**The plan has four steps.** Her answers:
- The phone connects by scanning a QR from the card.
- On the phone: קיבלתי / הגעתי / סיימתי, plus navigation.
- The beep repeats every 2 minutes, up to 3 times, until "קיבלתי".
- **First install from Chrome (Web Push).** A native APK with its own ringtone comes only if the beep is not heard in the
  field. Her choice, after the trade-offs: a Firebase project, Android Studio on the dev PC (none installed now), a signing
  key kept forever, and a manual reinstall on every phone for every update.

**Step 1 (this):** the dashboard on the existing SQL. Steps 2–4: a `technician` role with a paired phone, the phone screen,
and the push through a `notify-tech` Edge Function.

- **The button and who sees it.**
  - "צא ל:" is in every card's footer (`TechCards.jsx`).
  - It shows only when `tech_board()` is `enabled` (the pilot `settings.technicians_board`) and `can_edit`. A בקר sees the
    open task without buttons.
  - The cards are per **vehicle**. `techByPlate` maps the board's technicians onto them, and a mapped card shows the
    technician's name instead of the Ituran nickname.
- **`DispatchDialog.jsx`, a combobox inside the dialog** (not a portal).
  - Focus stays in the field; the arrows, Enter and Esc work (Esc clears the field, it does not close the dialog).
  - With no typing it lists the sites in fault and with open calls (`dispatchSites`).
  - The last row is "מקום אחר: …" (`p_place`).
  - Then "מה המשימה?", free text up to 500 characters (`p_details`).
  - A technician with an open task gets "יש לו משימה פתוחה: X" and the button "החלפה ושליחה" (`tech_dispatch` closes the
    old one as `moved`).
  - **A vehicle with no technician** is asked "מי הטכנאי ברכב הזה?" (suggested from the nickname) → `tech_save`, then the
    dispatch. A technician created in a failed attempt is reused on retry.
  - `client_id` per draft, renewed on any change to the draft.
  - The backdrop does not close a draft.
- **"פחות או יותר" — `utils/siteSearch.js`.**
  - Every typed word, in any order.
  - Quotes dropped (ת"א = תא), final letters folded, hyphens = spaces.
  - A city abbreviation matches the city both ways (the official city from `shared/site-address.mjs` is added to each
    site's key).
  - A skeleton without י/ו and final א/ה (the same rule as `tools/geocode-sites.js`, which was **not** changed to import
    it; it is a CJS tool).
  - One typo (Damerau) in a word of 4+ letters.
  - Digits match a code or a house number that **starts** with them, never "contains" (5 ≠ 65).
  - Ranking: exact code > code prefix > name prefix > words as typed > skeleton > typo. Ties by name.
  - The keys are built once per site list (`siteKey`).
- **On the card:** "משימה: <dest>", the text, and "נשלח 10:42 ע״י X · הגיע 10:58" (`dispatchLine`), in a quiet block above
  "איפה עכשיו". An editor gets "סיום משימה" (`tech_dispatch_end` done) and "ביטול" in two clicks (4 s). A failure is shown
  in the card.
- **Loading:** `TechniciansView` fetches `vehicles_live_list` and `tech_board` together (`allSettled`): one failing does not
  hide the other, and a failed board keeps the previous one with a line. ⚠️ That is a second per-minute query while the
  view is open. `tech_board` builds `vehicle_json` per technician, which the cards do not use. Measure after deploy; a
  lighter board call is the fix if it shows.
- Tests:
  - `technicians-ui.test.js` (8: normalization, codes, words, cities, spelling and typos, ranking, the list with no query,
    the card line). **Mutations: 25 of 26 caught** (`mut2110/run-mut13.cjs`). The survivor, the city alias read after
    folding final letters, is equivalent: the only alias with a final letter is "ים", and "ימ" is a substring of
    "ירושלימ" anyway.
  - Browser `e2e/probe-dispatch.mjs` 71/71 (who sees it; search by name, typo + city, order, code; keyboard; send; replace;
    another place; a vehicle with no technician; end and cancel; the backdrop; the phone at 44px; network failure and
    retry with the same id; a stale screen; a failed end). The harness mock is `?tboard=edit|view|off&tfail=…` in
    `mock-vehicles.js`. `probe-techcards` 70/70 and `probe-vehicles` 109/109 are unchanged (`tboard` defaults to off).
- **Deploy:** nothing new in SQL. It needs the pending SQL apply (technicians / vehicle-stats) and the pilot setting, then
  the push.

### The technician's phone — a QR from the card — step 2 of 4 (built and deployed 21/10/2026, d56b1b2)

The owner chose "סריקת QR מהכרטיס". Each technician gets a user of his own, in a new role, **`technician`**, that sees
only his own task.

- **What that role sees** (all decided in SQL):
  - It is not staff (`is_staff`), so it gets no board, no vehicles and no closed tables.
  - It is not an "active user" for the RLS read policies: `app.is_active_user` excludes it, so it reads no sites,
    operations or anything else.
  - It is not an editor.
  - It reaches exactly one RPC, **`tech_me()`**: its name and plate, and its open dispatch (destination, details, who
    sent it and when, and the site's `lat`/`lon` for navigation). `tech_me` also writes `phone_seen_at`, at most once a
    minute.
  - The login code by email does not apply to it (`login_code_applies` covers manager / editor / operator only).
  - It is hidden from `list_users`, like the agents, and `set_user_role` refuses an agent or technician row ("זו זהות של
    סוכן או של טלפון").
  - `app_users_role_check` gains `technician`. ⚠️ The constraint has two copies in `schema.postgres.sql`. The `DO` block
    that updates an existing database is the one production runs, and a fresh test database never runs it. A test now
    rebuilds the old constraint and re-applies the file.
- **The flow:**
  1. `tech_phone_begin(tech)` runs as the caller: editor, pilot gate. It bumps `technicians.phone_gen` and returns the
     email `tech-<id>-<gen>@parkomat.co.il`, the old user's id and the actor. It writes the `tech.phone_qr` audit row.
  2. Edge Function **`provision-technician`** (`handler.ts` tested in Node, `index.ts`) creates the user with the Secret
     key: 32 random bytes, `parkomat_role: technician` in `app_metadata`, and `email_confirm`.
  3. `tech_phone_link(tech, gen, uid, actor)` is **service_role only**. It accepts only the user of the current `gen`, so
     a QR made in parallel wins and the older one gets PT409. It sets the new row to `technician` / active, deactivates
     the previous phone user, and links `technicians.app_user_id`.
  4. The function deletes the old user from GoTrue, which also kills its refresh token. A failed delete is a warning, not
     a failure, since the row is already inactive.
  5. If link fails, the function deletes the user it just created.
- ⚠️ **A new user for every QR, not a new password for the same user.** An access token stays valid for up to an hour
  after a password change. Only an inactive user is closed immediately, because `current_app_user` requires `is_active`.
  So a lost phone, or a photo of an old QR, opens nothing from the moment a new QR is made or "ניתוק טלפון" is pressed.
- **More functions:**
  - `tech_phone_unpair(tech)` (editor, pilot) deactivates the user and unlinks it.
  - `tech_save` deactivating a technician deactivates his phone too.
  - `app.technician_id()` is NULL unless the caller is an active `technician` linked to an active technician. Callers
    treat NULL as a failure, like `agent_site_id`.
  - `tech_json` adds `phone {paired, paired_at, paired_by, seen_at}`.
- **The card:**
  - A "טלפון" button opens `TechPhoneDialog.jsx`. It shows "טלפון ✓" with a green frame once the phone has opened the
    app, and an amber frame for a QR that was not scanned yet. The title says when it was last opened.
  - The dialog shows the status, then "יצירת QR לטלפון", "QR חדש" (two clicks, with a warning that the current phone is
    cut off) and "ניתוק טלפון" (two clicks). A vehicle with no technician is first asked for the name.
  - The QR is drawn in the browser with **`qrcode-generator` 1.4.4** (MIT, no dependencies, its own lazy chunk, 7.6 KB
    gz), black on white in both themes, so the link never goes to any service.
  - While the QR is open, the dialog polls `tech_board` every 4 s and says "✓ הטלפון התחבר" as soon as `seen_at` fills.
  - The password lives only in the dialog's memory. Closing it loses it.
- **The link:** `<origin>/#pair=<base64url {e, p}>` (`pairLink` / `parsePairHash` in `utils/techPhone.js`). The
  credentials sit after `#`, so they are never sent to any server. `parsePairHash` accepts only a `tech-<n>-<n>@` email
  and a base64url password.
- **The phone** (`services/techDevice.js`, `components/TechPhone/`):
  - `AuthGate` routes the `#pair=` link to `PairScreen` before anything else. A browser signed in as a person is asked
    first, because pairing signs it out.
  - `pairThisDevice` signs in, then at once **replaces the password** with one only the phone knows. That makes the QR
    one-time. If the replacement fails, the phone keeps the QR password and pairing still succeeds.
  - It stores the credentials in `localStorage` (`parkomat.techDevice`) and clears the hash from the URL.
  - A phone whose session was pruned (`auth.sessions` after a day unused) signs in again silently from the stored
    credentials. If that fails, it tries once and then shows the login screen; it does not loop.
  - A `technician` user, or a `tech-…@` email whose role came back `anonymous` (an unpaired phone), gets `TechPhone`,
    never the dashboard.
  - `TechPhone`:
    - shows the name and plate, the task in large type, and a Waze button (`navLink`, only when the site has a location);
    - otherwise shows "אין משימה כרגע";
    - polls `tech_me` every 30 s while visible, and when the screen returns;
    - keeps the task on a network error and says it is retrying;
    - when unpaired, says "לבקש מהרכז QR חדש";
    - ~~offers "ניתוק הטלפון הזה" in two taps, which clears the device and signs out.~~ **Removed 22/10/2026** (the owner:
      *"אין בו צורך, תעיף אותו"*): the phone has no disconnect button; a phone is disconnected only from the coordinator's
      card ("ניתוק טלפון"). `forgetDevice` and `selfUnpairPhone` are gone from the dashboard; `tech_self_unpair` stays in
      SQL with no caller. Browser `tp/probe-tp` 31, `probe-tpfix` 25 (both now assert there is no button and nothing is
      disconnected), `probe-tpbeep` 46, `probe-tpnext` 11. Pushed e6152cf.
- **Tests:**
  - `technicians.test.js` +3 (20). The QR is for an editor in the pilot only. The phone sees only its own task, and no
    board, vehicles or site rows: RLS on `sites` is switched on inside the test, because PGlite does not have it and
    Supabase does. A parallel QR is refused, a foreign user is refused, and link is service-only. A new QR closes the
    old phone at once. Unpair and deactivation also close it. The test checks rows changed by hand, the users list, the
    role guard, the login code, and the old-constraint path.
  - **SQL mutations: 19 of 19 caught** (`mut2110/run-mut14.cjs`); 6 survived at first and got cases.
  - `provision-technician-fn.test.js` 6: what goes where, begin as the caller, the service key only to GoTrue and link,
    cleanup, warnings and failures. **8 of 8 mutations caught** (`run-mut15.cjs`).
  - `tech-phone-ui.test.js` 6; roles census (+4).
  - Full suite 1374/1374.
  - Browser:
    - `e2e/probe-techphone.mjs` 50/50 (who sees it; QR; scanned; the card; QR again; unpair; a vehicle with no
      technician; failure). **Q0** rebuilds the expected QR in Node from the returned credentials and compares it module
      by module with the one on screen, since there is no `BarcodeDetector` in the harness Chromium.
    - `tp/probe-tp.mjs` 27/27: a new mini harness with the real `AuthGate`, `PairScreen` and `TechPhone`. It covers
      pairing, the replaced password, the cleaned URL, a used QR, a signed-in person, silent resume and its single
      failure, unpaired, no network, and a failed password replacement.
    - `probe-dispatch` 71 and `probe-techcards` 70 are unchanged.
- **Deploy, each step with the owner's yes:**
  1. SQL. The dry run will show the new functions and the bodies of `is_active_user`, `list_users`, `set_user_role`,
     `tech_save` and `tech_json`. The `technicians` columns and the role constraint do not show.
  2. `npx supabase functions deploy provision-technician --project-ref xvfsikwaaaohnmldjbtv --use-api`. It needs no
     secrets of its own, and is deployed **without** `--no-verify-jwt`.
  3. Push.
- ⚠️ **What the phone does not do yet:** ~~beep (step 4)~~ (built, below), and the הגעתי / סיימתי buttons (step 3). It does
  not take the phone's location. Location comes only from the vehicle.

### The beep and "קיבלתי" — step 4 of 4 (built and deployed 21/10/2026, 94353df)

✅ **Deployed 21/10/2026, at the owner's word ("כן"), in this order:**
- **SQL:** 18 gaps (8 new functions, 6 bodies, the cron job and the table's indexes), 12 s, then "הייצור זהה לקוד".
  Checked by hand: the five dispatch columns exist; `tech_push_subs` is closed (RLS, no policies, no grants) and empty;
  `parkomat-tech-push-repeat` runs every minute; both push settings are present.
- **The Edge Function `notify-tech`:** a call without a token gets the gateway's 401. With the public key and a wrong
  secret it gets the function's own `unauthorized`, not `not configured`, so its secrets are in place.
- **Push.**
- At deploy time no technician phone was paired and there was one open dispatch, so nothing could beep yet. The first
  beep to a real phone needs its own yes.

The owner chose the beep before step 3 ("קודם הצפצוף"). It repeats every 2 minutes, up to 3 times, until "קיבלתי". "צא ל:"
and "טלפון" are for the coordinator only ("לרכז בלבד"); his email has not been given yet. There is no explainer page for
technicians yet ("לא עכשיו").

- **The flow:**
  1. `tech_dispatch` calls `app.tech_push_request(dispatch)` inside its own `EXCEPTION` block. A failed beep never fails a
     dispatch: the reason goes to `push_error` and the card shows it. The request is `net.http_post` (sent after the
     commit) to the Edge Function **`notify-tech`**, with `push_anon_key` and the existing `push_caller_secret` (the same
     pair as `notify-fault`). With no secret or key it sends nothing, and `push_error` = "הצפצוף אינו מוגדר במערכת".
  2. `notify-tech` (`handler.ts`, tested in Node, and `index.ts`) checks the secret in constant time. It calls
     **`tech_push_claim`** (service only), which decides **everything**:
     - whether to send: not when the dispatch is gone, ended or acked, after 3 beeps, or within 90 s of the last one;
     - to whom: the subscriptions of an active `technician` user linked to an active technician;
     - the title ("משימה חדשה: …", then "תזכורת — משימה ממתינה: …") and the body (whitespace collapsed, 180 characters);
     - `tag` = `dispatch-<id>`.
     A technician without a subscription is `no_phone`: `push_error` = "הטלפון של הטכנאי לא הפעיל צפצוף", and it is not
     counted as an attempt.
  3. Web Push to each device (`@negrel/webpush`, the existing VAPID keys, `urgency: high`, TTL 10 minutes). Then
     **`tech_push_result`** records `push_sent` / `push_error` and deletes the dead subscriptions, only the technician's
     own. ⚠️ **Only 404 and 410 delete a subscription.** `PushMessageError` has an empty message, so the status is read from
     `error.response.status`. `notify-fault` looks for "410" in the text, so it never deletes a dead subscription (not
     fixed there).
  4. pg_cron job `parkomat-tech-push-repeat` runs every minute (`app.tech_push_repeat`). It picks dispatches that are open,
     not acked, under 3 beeps, 2 minutes past the last beep (or past the dispatch), and whose technician has a
     subscription. Each request runs inside its own `EXCEPTION` block.
  5. "קיבלתי" on the phone calls **`tech_self_ack`**. It works only on the technician's own dispatch (PT404 otherwise),
     not on an ended one (PT409), and a second press changes nothing. It bumps `rev` and writes `tech.ack` to the audit
     log.
- **Tables and columns:**
  - `tech_push_subs` (one row per device, endpoint `UNIQUE`, `https` only) is closed and **separate from**
    `push_subscriptions`. That table exists only in a Supabase migration that `apply-sql` never sees.
  - `tech_dispatches` gains `acked_at`, `push_count`, `push_last_at`, `push_sent` and `push_error`.
  - The subscriptions are deleted when a new QR is made, on unpair, and when a technician is deactivated.
- **`tech_json` and `tech_me`:**
  - `tech_json` adds `acked_at`, the push fields and `push_max` to the dispatch, and `push_ready` to the phone.
  - `tech_me` adds `acked_at` and `push_devices`.
- **The service worker** (`public/sw.js`), for `kind = "dispatch"`:
  - The notification stays until it is touched (`requireInteraction`).
  - It vibrates `[400,150,400,150,800]`.
  - It uses the dispatch's `tag` with `renotify`, so a reminder replaces the previous one and beeps again.
  - It posts `{type: "dispatch"}` to every open window, so an open app reloads at once.
  - Fault alerts are unchanged (`tests/sw-dispatch.test.js` runs the file in a `vm`).
- **The phone** (`TechPhone.jsx`, `services/techPush.js`):
  - "הפעלת צפצוף" is a button, because the browser asks permission only on a tap. Once granted, the screen says
    "✓ צפצוף מופעל".
  - Denied: how to allow it in the settings. Unsupported: install from Chrome.
  - A permission already granted re-sends the subscription once per open (`syncTechPush`), since a new QR deletes the old
    subscriptions.
  - "קיבלתי" is a big button. Afterwards: "✓ קיבלת ב-HH:MM".
  - **Since 22/10/2026 an unconfirmed task opens as a full-screen window** (`AckPopup`, `role="alertdialog"`): "משימה
    חדשה" (or "המשימה הבאה"), the destination, the details, who sent it, and a 64px "קיבלתי" with focus. The owner: *"שזה
    יהיה פופאפ — ברגע שהוא מאשר את המשימה הפופאפ נעלם ונסגר"* (asked where, she chose the technician's phone, not the
    coordinator's dashboard). It closes **only** on confirmation: no ✕, Esc or backdrop. A failed confirmation keeps it open
    with the error inside; a task ended meanwhile (PT409/PT404) is reloaded away, and the window with it. It covers the
    "הפעלת צפצוף" bar until confirmed. Body scroll is locked while open. Harness: `?acked=1` in the phone mock gives a task
    already confirmed (no window) for tests of the screen behind; `probe-tpbeep` 56 (A0: the window, full screen, focus, Esc
    and backdrop do not close it; A1–A3 through it; S1 a new task arrives in it), `probe-tpnext` P2, `probe-tp` 31,
    `probe-tpfix` 25.
  - The light-theme green is teal-800: teal-700 on its own tint measured 4.24:1.
- **The card** — ~~`pushLine`, one small line~~ replaced on 22/10/2026 by **`ackLine`**, a chip right under the task's
  destination, on every open task (the owner: *"כשטכנאי מאשר את המשימה אני רוצה לראות על הכרטיס שהוא אישר. אם הוא לא אישר
  — שיראו שהוא עדיין לא אישר"*). Until then nothing said "not confirmed" after "הגיע", and a phone without the beep showed
  only a red reason.
  - "✓ אישר 10:43" (green, `--tc-site`).
  - "עוד לא אישר" (amber; light `--tc-ack-wait` #92400e — `--tc-call` on its own tint measured 4.25:1), with the beep
    under it in small text: "צפצף בטלפון 10:42 (1 מתוך 3)", "שולח צפצוף לטלפון…", or "⚠ <reason>" (e.g. "הטלפון של הטכנאי
    לא הפעיל צפצוף"). After "הגיע" — the chip with no beep line.
  - "✕ לא אישר" (red) after 3 beeps, "צפצף בטלפון 3 פעמים, בלי תשובה".
  - An old database (no `push_count` and no `acked_at`) — no chip, rather than a made-up "not confirmed".
  - Tests: `technicians-ui.test.js`; mutations 7 of 7 (`scratchpad/mutui/run-ack.cjs`); browser `probe-techbeep` 30/30
    (every state, the chip right after the destination, contrast ≥ 4.5 in both themes: 4.6–7.4), `probe-techcards` 66,
    `probe-dispatch` 71, `probe-next` 27, `probe-tcmore` 40.
  - "טלפון ✓" has an amber frame when the phone is paired but the beep was not turned on.
- **Tests:**
  - `technicians.test.js`: 24.
  - **SQL and handler mutations: 42 of 43 caught** (`mut2110/run-mut16.cjs`). The survivor is `FOR UPDATE` in the
    claim, which PGlite cannot test (one connection). The inactive-user and wrong-role cases were added after Q8
    survived.
  - `notify-tech-fn.test.js` 5, `sw-dispatch.test.js` 4, and the UI tests.
  - Full suite: 1388/1388.
  - Browser:
    - `e2e/probe-techbeep.mjs` 18: the card in every state.
    - `tp/probe-tpbeep.mjs` 46: the phone with `services/techPush` swapped. It covers every permission state, the enable
      click and its failure, a single sync, קיבלתי / a network failure / an ended dispatch, and an open app reloading on
      the service worker's message.
    - `probe-tp` 27, `probe-dispatch` 71, `probe-techphone` 50.
- **Deploy, each step with the owner's yes:**
  1. SQL. The dry run shows the new functions and bodies. The table and the dispatch columns do not show.
  2. `npx supabase functions deploy notify-tech --project-ref xvfsikwaaaohnmldjbtv --use-api`, **without**
     `--no-verify-jwt`. It uses the existing `PUSH_CALLER_SECRET`, `VAPID_*` and service key.
  3. Push.
  - ⚠️ A beep to a real technician's phone reaches a person, and it needs its own yes.

### A reminder when he starts the vehicle (built 22/10/2026; SQL applied)

The owner: *"כשהוא מפעיל את הרכב, אם יש לו משימה לעשות — תזכיר לו שוב לאן הוא צריך לנסוע ומה המשימה"*.

- **The signal is Ituran's ignition events**, already stored raw in `vehicles_live.events` by every sync.
  `app.vehicle_ignition_on_at(events, ref)` returns the latest ignition-on ("פתיחת סוויץ", "מנוע עובד") that has no
  ignition-off after it, or NULL. Ituran keep the latest event of each pair, so an "on" newer than every "off" means the
  vehicle has been running since then.
- **`app.tech_ignition_scan(now)`** runs in every `ituran_ingest`, after the leave-site scan, in its own block. A failure is
  written to `advance_error` as "תזכורת בהתנעה: …"; a success does not clear it. It picks every dispatch that:
  - is open, not marked "הגיע" and not "נכנס" ("a task to do"). This includes tasks already confirmed with "קיבלתי": the
    reminder says where to go, it does not ask for confirmation;
  - has an ignition at least 2 minutes after the task was sent (`app.tech_ignition_grace`). A technician who starts the car
    right away already got the task's own beep;
  - has an ignition within the last 15 minutes (`app.tech_ignition_fresh`), so a sync that comes back after an outage does
    not beep about an hour-old ignition;
  - has an ignition newer than `ign_on_at`, so there is one reminder per ignition;
  - whose vehicle has **not** been at the task's site since it was sent (then he is leaving it, not driving to it);
  - whose technician has a phone subscription.
- It sets `ign_on_at` and `ign_pending` and calls **`app.tech_push_post`**. That function is new: `tech_push_request` is now
  "count an attempt, then post", so ignitions do not use up the 5 attempts of the "קיבלתי" beeps. `push_requested_at` is
  set too, so "השירות לא ענה" still works.
- **`tech_push_claim`** sends a pending reminder first, before the "קיבלתי" checks: title "תזכורת — לאן לנסוע: <destination>",
  the details as body, the dispatch's `tag`, and `kind: 'ignition'`. It clears `ign_pending` even when it does not send
  (marked "הגיע" or "נכנס" meanwhile; no phone), and sets `ign_reminded_at`, `ign_reminds` and `push_last_at`, but not
  `push_count`.
- **No Edge Function change.** `notify-tech` sends whatever the claim returns.
- Tests: `technicians.test.js` +3 (34). They cover the ignition reading, every inclusion and exclusion above, the claim, one
  reminder per ignition and a new ignition after an off, arrival between the request and the claim, no push settings, and
  the hook inside the sync with its failure. **Mutations (isolated copy, `scratchpad/mutpark/run-ign.cjs`): 14 of 14
  caught.**
- **Deploy:** SQL only. The dry run should show the new functions (`vehicle_ignition_on_at`, `tech_push_post`,
  `tech_ignition_*`) and the bodies of `tech_push_request`, `tech_push_claim` and `ituran_ingest`. The four
  `tech_dispatches` columns do not show; check them after `--apply`.

### The technician card: no day bar and no week bars; the detail opens on a click (21/10/2026)

The owner, after the meaning of every mark on the card was explained: "לא מובן לי מה כל סימון אומר". She approved a legend
and a caption ("תעשה"), saw them, and then said: *"זה ממש לא מובן, עד שנחשוב על רעיון אחר תעיף את זה, אולי רק אם ילחצו על
הכרטיס יהיה פירוט יותר מלא"*.

- **Removed:** the day timeline (with its legend) and the seven week bars. They can be restored with
  `git show 80c5944:dashboard/src/components/Vehicles/TechCards.jsx` (`Timeline` / `Week`). `timeline` and `weekBars` in
  `utils/techStats.js` stay, with their tests, for "another idea".
- **A click anywhere on the card opens the detail, and a second click closes it** (`is-open`, a ▾ in the header). Clicks on
  a button, a link or a text selection do not toggle. For the keyboard, the header is `role="button"` with
  `aria-expanded` / `aria-controls`, and Enter or Space toggles it. The detail is text only:
  - today's visits;
  - "7 הימים האחרונים: X ק״מ · N ביקורים", once there is more than one tracked day;
  - "עדכון אחרון מהרכב לפני X";
  - "מהירות שיא היום".
- **Stays on the closed card:** where he is now, the site's state, and the four numbers.
  - **A site in maintenance:** a technician icon followed by **"האתר בתחזוקה — טכנאי באתר"**. The owner: *"שיהיה כתוב
    האתר בתחזוקה טכנאי באתר או שיהיה כזה סמל"*, then *"תשים איקון טכנאי באתר"*.
  - **The icon:** `TechIcon`, an inline SVG of a figure in a work helmet, 18px, `currentColor` (the maintenance ink).
    It is SVG rather than 🧑‍🔧 because that emoji is drawn differently on every system, and older Windows splits it into
    two glyphs. A 🔧 was there for an hour before it.
  - **Earlier wording:** "האתר במצב תחזוקה בדשבורד" for a few hours, and before that "האתר בתחזוקה".
  - The site's state shows only when the vehicle stands at that site (`site` = `at_site`), so "טכנאי באתר" is always true
    there.
  - Browser: `e2e/probe-tcmaint.mjs` 18.
- ⚠️ Today's numbers count only from 11:09 on 21/10, when the tracking started.
- Browser: `e2e/probe-tcmore.mjs` 38 (closed by default, opened by a click, a button inside does not toggle, the keyboard,
  a text selection, "צא ל:" from an open card, 1371 light and 390 dark). `probe-techcards` C4 was updated (74).
  `probe-tclegend` is retired.

### "טכנאי באתר" on the site cards of the main board (built and deployed 21/10/2026, 74187ee)

✅ **Deployed** after the owner's *"לא רואה שום אייקון למה אתה לא שם"*.
- **SQL:** one new function.
- **Push:** live bundle `index-LZCB2LFl.js`.
- **Checked in production, as a manager in a rolled-back read-only transaction:** 13 vehicles at 9 sites (204 ms over the
  network); anon cannot execute it.
- ⚠️ **Watch:** four vehicles stood for about two hours at one multiplier (3488), and one stood five hours at another
  (1186). If such a place is where technicians park (office, warehouse, home), the icon there is noise and that site
  needs excluding. The owner was told; there is no answer yet.

The owner had asked for "האתר בתחזוקה טכנאי באתר, או שיהיה כזה סמל שטכנאי באתר" and then "תשים איקון טכנאי באתר". It
was first put on the technician card only (above). Looking at the board, she said: *"אני לא רואה שום איקון שטכנאי
טיפל"*. She meant the site cards.

- **The data:** `public.tech_on_site()` (`vehicle-stats.postgres.sql`, staff only, one jsonb). It returns the open
  visits that `vehicles_track` already records every minute: `{site_id, code, plate, nickname, tech, since, no_signal}`.
  - A visit counts only when it started at least 2 minutes ago. Shorter is a traffic light next to a site, the same
    rule as deleting a short visit.
  - A visit counts only when its `last_at` is within 15 minutes. Older means the sync stopped, and the technician may
    have left.
  - A visit whose site was deleted (`site_id` NULL) does not count.
  - `tech` is the active technician mapped to the plate on the coordinator's board. Without a mapping, the dashboard uses
    the Ituran nickname without the plate (`vehicleName`).
- ⚠️ **Display only.** It never changes the site's status. The automatic move to maintenance when a technician is on site
  is still paused (18/10: no reliable end signal).
- **The board:** `App` loads it every 2 minutes, skips hidden tabs, and reloads on return to the tab (`onRecover`). There
  is no event for it: the Ituran sync writes no `events`, on purpose. A failure keeps the last answer. A database without
  the function shows no icons. `TechOnSiteContext` provides `Map site_id → [{name, since, noSignal}]`, built by
  `techOnSiteBySite` (`utils/technicians.js`).
- **The card** (`SiteCard.jsx`):
  - The collapsed card has the icon **inside the status chip**, in the chip's colour ("בתחזוקה" + a technician). It is
    display only, so a click expands the card. Its `aria-label` / `title`: "טכנאי באתר: אבי לוי · מ-10:42", or "2 טכנאים
    באתר: …" (`techOnSiteText`).
  - The expanded card has a line in words with the icon (`.exp-tech-onsite`).
  - A site without a controller has the icon beside "ללא בקר מחובר".
- **The icon** is `components/TechIcon/TechIcon.jsx`, shared with the technician card. It is an inline SVG of a figure in
  a work helmet, coloured `currentColor`.
- ⚠️ **On the board it sits in a bright yellow circle with a glow** (`.tech-onsite`: `#facc15`, a `#ca8a04` frame, two
  glow shadows, a `#3b2600` icon at 9.4:1). The owner, after seeing the plain icon in the chip: *"זה לא מספיק בולט,
  תעשה את זה צהוב זורח"*. Deployed 219444e. It does not blink, since she asked to stop blinking on cards (19/10). The
  same circle sits on the expanded card's line.
- Tests: `vehicle-stats.test.js` (the 2-minute and 15-minute rules, an ended visit, a deleted site, an inactive
  technician, order, anon and non-staff refused), `technicians-ui.test.js` (`techOnSiteBySite` / `techOnSiteText`), roles
  census (`tech_on_site` in OTHER). Browser: `e2e/probe-onsite.mjs` 32 (the chip, two technicians in order, the colour,
  none elsewhere, a click expands, the line on the expanded card, a multiplier, leaving, a failed load, every 2 minutes
  with a fake clock; 1371 light and 390 dark). Mock: `?onsite=1` / `?onsitefail=1`.

### The bug hunt of 21/10/2026 — eleven fixes, and a QR that led nowhere (built and deployed 21/10/2026, c6af979)

✅ **Deployed at the owner's word ("yes"):**
- **SQL:** 14 gaps (4 new functions, 8 bodies, 2 policies), 19 s, then "הייצור זהה לקוד".
- **Checked by hand, read-only:**
  - The two `tech_dispatches` columns and both policies are in place.
  - `tech_self_unpair` is closed to anon.
  - A manager reads 111 users; an agent reads 0 users and 0 log rows.
  - `vehicles_live_list` carries `tech` on all 38 vehicles.
  - 86 of 89 agents are beating, and the Ituran sync, the silence scan and the beep repeat all succeed.
- **Push:** live bundle `index-DfHZDG87.js`.

The owner: *"תנסה לעבור על המערכת ולמצוא באגים"*. Four independent reviews plus a read-only production health check found
11 important bugs and about 25 small ones. Her answer, "אוקי", was to the plan: fix the eleven now, test, ask before
publishing, and leave the small ones for a later round.

**The eleven fixes:**

1. **The staff list and the audit log were readable by almost any signed-in token.**
   - `app_users_read_authenticated` used `is_active_user`, which includes the agents. An agent's password sits on every
     site PC, and the list holds every employee's email.
   - `audit_log_read_authenticated` checked nothing about the caller. The log was readable by agents, by a technician's
     phone (even after unpairing, until the token expired), by a deactivated user until expiry, and by a sign-in that
     never typed the login code.
   - Both now require `current_app_role() IN ('manager', 'editor', 'operator')` (`security.postgres.sql`).
     `current_app_role` returns its own value for every non-human identity, which is why the list is explicit.
2. **A phone disconnected from the phone itself kept beeping.**
   - The cause: "ניתוק הטלפון הזה" only deleted the credentials stored on the device. The user stayed active and linked,
     the push subscription stayed, and the card said "צפצוף מופעל".
   - **`public.tech_self_unpair()`** (authenticated, no pilot gate):
     - deletes the subscriptions, unlinks the technician and deactivates the user;
     - writes the audit row `tech.phone_self_unpair`;
     - on a phone that is already disconnected, returns `changed: false` and raises no error.
   - The phone (`forgetDevice` in `services/techDevice.js`):
     - calls it, then cancels the browser's push subscription (`unsubscribeTechPush`);
     - remembers that it was disconnected (`{off: true}`), then signs out;
     - with no network, it still cancels the subscription and signs out.
3. **The reminder looped forever when `notify-tech` did not answer.**
   - The cause: `push_count` counts only after a claim. A function that never answered (a wrong secret, not deployed,
     crashed) left it at 0, so the cron sent a request every minute with no end. The card stayed on "שולח צפצוף…".
   - The fix:
     - two new columns, `tech_dispatches.push_attempts` and `push_requested_at`;
     - every `tech_push_request` is counted;
     - a cap, `app.tech_push_attempts_max()` = 5: three beeps plus two retries;
     - after 90 seconds with no claim, the card says "שירות הצפצוף לא ענה — הצפצוף לא נשלח".
   - In the same function:
     - **20 seconds of tolerance on the 2 minutes.** The claim stamps `push_last_at` a second or two into the minute, so
       "exactly 2 minutes" was 118 seconds and slipped to the next minute: beeps went out at 0, 2.5 and 5.5 minutes.
     - **No beep after the coordinator marks "הגיע".** The claim returns `reason: 'arrived'`, the repeat skips it, and
       the card's push line (`pushLine`) shows nothing.
4. **A false "צפצוף מופעל" on the phone.**
   - The cause: the phone trusted the browser's permission. If the database no longer knew its subscription (deleted
     after a 404/410, or never saved), nothing beeped.
   - Now `missing` = permission granted and `tech_me.push_devices === 0`.
   - The phone then re-subscribes by itself with a new subscription, at most every 5 minutes. If that fails, it shows
     "⚠ הצפצוף לא פעיל בטלפון הזה" with a "הפעלת צפצוף מחדש" button.
   - The errors are in Hebrew.
   - A phone that cannot beep is told "צריך טלפון אנדרואיד עם Chrome". The old text, "install from the Chrome menu", is
     gone: an iPhone has no such menu, and installing there loses the session.
5. **A paired phone fell back to the email-and-password form.**
   - **No reception during the silent sign-in:**
     - It shows "אין חיבור כרגע — מנסה להתחבר שוב…".
     - It retries every 20 seconds, on `online`, and on return to the screen.
     - The credentials are kept.
   - **Credentials that are really invalid:**
     - It shows `PhoneOff`: "הטלפון אינו מחובר לטכנאי… לבקש מהרכז QR חדש", with "כניסה עם מייל וסיסמה" for a person.
     - The same screen appears after a reload, with no further attempt.
   - **Pairing with no reception** no longer says "ה-QR כבר שימש". It says "ה-QR עדיין בתוקף" and offers "נסו שוב".
   - **The replacement password is saved before `updateUser`, as `pending`.** A response lost in the middle of the swap
     cannot lock the phone out, because the silent sign-in tries both passwords.
6. **A deadlock on "קיבלתי".**
   - `tech_self_ack` locked the dispatch, then the technician. Every other writer locks the technician, then the
     dispatch. So "קיבלתי" pressed at the moment the coordinator pressed "סיום" or "הגיע" failed one of them with 40P01.
   - The technician is locked first now.
   - Not testable in PGlite, which has one connection.
7. **A unit that went silent mid-drive near a site counted as "at the site" for hours**, with the yellow icon on the
   board.
   - The cause: silence always counted as standing (meant for an underground car park).
   - **`app.vehicle_may_be_at_site(state, motion, speed)`:** parking or idle; or silent, but only when the last report
     was at most 20 km/h or Ituran did not say "driving".
   - Used by `vehicle_json.at_site` and by `vehicles_track`.
8. **Double visits.**
   - The cause: a parked vehicle whose position jumped out of range for one sync, or a sync with no state, closed the
     visit. The return then opened a second one, overlapping the first, with the same arrival time (the ignition-off).
     "ביקורים באתרים" counted it twice.
   - **Reopen:** a return to the same site within 15 minutes, with no other visit in between, reopens the same visit.
   - **No overlap:** a new visit never starts before the end of the vehicle's previous visit
     (`LEAST(GREATEST(arrival, prev_end), now)`).
   - ⚠️ `GREATEST` ignores NULL, and the first version had `LEAST` alone. With no previous visit the arrival became
     "now". A test caught it.
   - **One rule for "a visit happening now":** `app.visit_current` (at least 2 minutes old, `last_at` within 15
     minutes). It is used by the board icon and by "טכנאי באתר" in "צריכים טכנאי עכשיו"; until now only the icon
     checked.
   - **"הכי קרוב" leaves out vehicles already at that site**, before the `LIMIT`. Until now they took one of the three
     places.
9. **The map was drawn over the help window.**
   - The cause: Leaflet's panes (z-index 400–1000) sat in the root stacking context, above the help window, which lives
     inside the header (z-index 100).
   - The fix: `.veh-map { position: relative; z-index: 0; isolation: isolate }`.
   - Measured in the harness: with the old CSS the vehicle labels covered the help window; with the fix, none do.
   - ⚠️ The sticky header itself was not covered in the harness either way, though the bug hunt suspected it. The probe
     keeps it as a guard.
10. **On a phone, tapping a vehicle on the map scrolled the page**, through the list row's `scrollIntoView`. Now it
    scrolls only inside `.veh-side`, and only when that list scrolls on its own (desktop).
11. **The name from the coordinator's board appeared only in the card's header.**
    - `vehicle_json` now carries `tech`, the active technician mapped to the plate.
    - `vehicleName(v)` prefers it. The search, "צריכים טכנאי עכשיו", the map labels and the list now show the same name as
      the card and the board icon.

**12. The QR led nowhere** (the owner, the same afternoon: *"סרקנו את הקוד QR… לא ניתן לגשת לאתר"*).
- **The cause:** the link was built from `window.location.origin`. The four QRs made that day (13:40–15:24, all in
  production, none ever opened) came from the dashboard running on the dev PC, `localhost:5173`, which talks to production
  Supabase. The link inside them was `http://localhost:5173/#pair=…`, an address that exists only on that PC. The DELL008
  copy would have failed the same way (office network only), and a Pages preview URL changes on every deploy.
- **The fix:** `pairOrigin` in `utils/techPhone.js` sends the link to the live site, `PUBLIC_ORIGIN` =
  `https://parkomat-site-monitor.pages.dev`. `VITE_PUBLIC_ORIGIN` overrides it only with a valid `https://` origin (no
  path); anything else falls back to the live site.
- Tests: `tech-phone-ui.test.js` (localhost, an office IP, plain http, a path, `javascript:`, a valid override).
  `probe-techphone` Q0 now rebuilds the QR from the live site's address and compares it module by module; Q0b checks the
  QR is not the harness's localhost link (51/51).

**And one more:** the audit rows of the phone's actions (`tech.ack`, `tech.phone_self_unpair`) carry the fixed actor
"טלפון של טכנאי". They used to carry the technician's name, in a log that every user can read (the log is ids only).

**Tests:**
- `technicians.test.js`:
  - The reminder test is rewritten: the arrived case, the cap, the edge at 110 seconds, the "did not answer" error,
    `push_attempts`, and the claim's `arrived`.
  - A new test, "בדיקת הבאגים": who reads the log and the list, `tech_self_unpair`, and the fixed actor.
- `vehicle-stats.test.js`:
  - silent while fast versus slow;
  - edge jitter gives one visit;
  - no overlap;
  - arrival by ignition-off with no previous visit;
  - "הכי קרוב" in three stages;
  - the technician's name in `vehicles_live_list`.
- `compliance.test.js` test 6: agent and intake see 0 log rows; the leak check runs as a בקר.
- The roles census: `tech_self_unpair`.
- UI: `technicians-ui`, `vehicles-ui`, `tech-stats-ui`.
- **Full suite 1395/1395.** **SQL mutations (isolated copy, `mut2110/run-mut17.cjs`): 27 of 27 caught.** Two survived
  at first, and each got its case in `vehicle-stats.test.js`: a return after 20 minutes is a new visit (the reopen is
  within 15 minutes only), and S1 → S2 → S1 gives three visits (reopening the first would overlap the visit at S2).
- Browser:
  - `tp/probe-tpfix.mjs` 25 (new): the phone not known, re-subscribing, no reception, pairing with no reception,
    unsupported, disconnecting with no network.
  - `tp/probe-tp.mjs` 31 and `tp/probe-tpbeep.mjs` 46, updated.
  - `e2e/probe-techfix.mjs` 25 (new):
    - the help window over the map, with X1b putting the old CSS back and expecting the labels over it;
    - the header after scrolling;
    - a tap on the map at 390px leaves the page in place;
    - the board's name in the card, the search, "צריכים טכנאי", the labels and the list.
  - The mock takes `window.__vehTech[plate]`.

**Deploy (each step with the owner's yes):**
1. SQL. The dry run shows the new functions (`tech_self_unpair`, `tech_push_attempts_max`, `vehicle_may_be_at_site`,
   `visit_current`) and the changed bodies. ⚠️ The two `tech_dispatches` columns and the two policies may not show:
   check `information_schema.columns` and `pg_policies` after `--apply`.
2. Push.
- SQL first, though either order is safe. A new bundle against the old SQL: `tech_self_unpair` returns 404, and the phone
  still cancels the subscription and signs out (tested). `push_devices` is already in production.

### Only the service technicians' vehicles are shown — "רכבים ברשימה" (built and deployed 21/10/2026, 0e100e2)

✅ **Deployed at the owner's word ("YES"), in this order:**
1. **SQL:** 7 gaps, 12 s, then "הייצור זהה לקוד".
2. **The list:** 14 vehicles, each matched to its Ituran nickname, loaded right after the SQL. The audit row is
   `fleet.set`, by "Claude — רשימת טכנאי השירות לבקשת הבעלים".
3. **Push:** live bundle `index-DuLl7RRs.js`.

**Checked as a manager in a read-only transaction:**
- `vehicles_live_list` returns 14 vehicles, all from the list (418 ms).
- The 12 sites that need a technician reference only listed vehicles.
- `tech_on_site` has 3 rows.
- `fleet_list` returns 38 vehicles and 14 shown.
- The table and `fleet_shown_set` are closed to anon and to users.
- 86 of 89 agents are beating, and the Ituran sync runs.

⚠️ **A real name had been committed earlier, in `vehicles-ui.test.js` (20/10).** It is replaced with an invented one;
the git history still holds it.

From the service team, pasted by the owner: no need to show the vehicles of named office staff and installers (names left out here: the repo is public), and if
everyone must appear, *"אפשרות לבצע סינון על מנת שלמוקד יהיה ברשימה רק את הטכנאים הרלוונטים"*. Then a list of service
technicians, and three who work with Parkomat sometimes.

**Her answers:**
- **"אל תציג אותם":** the other vehicles disappear entirely. There is no "all vehicles" switch.
- The occasional technicians appear **like everyone else**, with no mark.
- Where one name matched several Ituran vehicles, she picked which one. A technician's old vehicle, and another's
  temporary one, are shown too.
- 14 vehicles in all. One technician on the list has no vehicle in Ituran.

**How it works:**
- **A list in the database, not in the code.** `fleet_shown` (`vehicles.postgres.sql`) is one row per plate. It is closed
  (RLS, no grants), with **no FK** to `vehicles_live`: a vehicle that drops out of an Ituran reply is deleted there, and its
  row here stays, so it is shown again when it comes back.
  ⚠️ Names and plates never go to git, since the repo is public. The list was loaded by a script in the scratchpad, and
  is kept up to date from the dashboard.
- **One rule:** `app.fleet_shown(plate)`, plain SQL so it is inlined. It applies in:
  - `vehicles_live_list` (the cards, the map, the team line);
  - `vehicle_alerts_json`, in both `on_site` and `nearest` (an office car passing a site in fault is not "הכי קרוב";
    the fourth in line takes its place);
  - `tech_on_site` (an office car parked near a site does not light the yellow icon on the board).
- **Hidden vehicles are still synced and tracked** (`vehicles_track`), so a vehicle added to the list comes with today's
  numbers.
- ⚠️ **An empty list shows no vehicle at all.** A new vehicle in Ituran (a technician gets a new car) does not appear until
  it is added.
- **`public.fleet_list()`** (editor; one jsonb): every vehicle from Ituran with `shown`, and `shown` = the list itself,
  including a vehicle that left Ituran. A בקר does not get it: the full list includes the office cars.
- **`public.fleet_shown_set(plates, seen)`** (editor) saves the whole list:
  - `seen` is the list the screen saw. Another editor who saved in between means PT409, not a silent overwrite.
    `NULL` skips the check.
  - Spaces, duplicates and empty values collapse.
  - A plate **new** to the list must exist in Ituran (PT404). One already on it that left Ituran stays as is.
  - A save that changes nothing writes nothing and logs nothing.
  - `LOCK TABLE … SHARE ROW EXCLUSIVE`, so two saves go one after the other.
  - The audit row is `fleet.set` with `{added, removed}`, plates only.
- **The dashboard:** a "רכבים ברשימה" button at the end of the technicians header, for editors and managers only
  (`canEdit`). It opens `FleetListDialog.jsx`:
  - checkboxes, names without the plate, the plate beside each, and a search by name or plate;
  - "מסומנים N מתוך M", with a warning when nothing is ticked;
  - a vehicle on the list that left Ituran, listed at the bottom so it can be removed;
  - one "שמירה". A draft does not close on the backdrop or Esc. A stale screen gets a message and a reload.
  - After a save the view reloads.
- ⚠️ **A real bug found on the way: the "צריכים טכנאי עכשיו" strip and the map's rings never reached production.**
  `fetchVehicles` (`services/vehiclesDirect.js`) returned `vehicles`, `sync` and `now`, and dropped `alerts`. The browser
  probes replace this layer with a mock that returns `alerts` directly, so they never saw it.
  - It is passed through now (`undefined` on an old database).
  - `tests/vehicles-direct.test.js` runs the real file against a fake Supabase, and the mutation that drops the line
    fails it.
- ⚠️ **The strip is removed from the cards** (owner, 21/10/2026). She saw it for the first time on her local dashboard
  (localhost:5173 runs the working tree), as 12 boxes over most of the screen. She first chose "a row per site", then,
  seeing it: *"לא רוצה את זה"*.
  - `alerts` stays in the data: the map rings the sites that need a technician with it (red fault / amber call), and
    those rings appear now too.
  - To restore the strip: `git show 12d689a:dashboard/src/components/Vehicles/TechCards.jsx` (`AlertStrip`).
  - The jump-to-card highlight (`is-flash`) existed only for the strip and went with it.
  - `probe-techcards` C2 now asserts there is no strip.
- **Tests:**
  - `vehicles.test.js` (+1):
    - an empty list shows nothing;
    - `fleet_list` and `fleet_shown_set` for a manager, refused to a בקר, an agent and anon;
    - collapsing; a stale screen; an unknown plate; a no-op is not logged; add and remove together;
    - a vehicle that left Ituran and came back; `seen` NULL; an empty list; the table closed.
  - `vehicle-stats.test.js`: a vehicle off the list is neither "באתר" nor "הכי קרוב", and not on the board.
  - Roles census: both functions under EDITOR. `check-row-cap` declares both.
  - ⚠️ The older tests insert vehicles without a list. Their `user` helper now marks every test vehicle shown before each
    call, which is how they behaved until now. The hiding tests use `userRaw`.
  - **SQL mutations (isolated copy, `mut2110/run-mut18.cjs`): 14 of 14 caught.**
  - Full suite: 1398/1398. Probes after removing the strip: techcards 66, techfix 23, tcmore 38, fleet 24, vehicles 109, dispatch 71.
  - Browser `e2e/probe-fleet.mjs` 24:
    - who sees the button;
    - the window; unticking two vehicles; the count; a draft that stays open;
    - the save (the whole list plus what was seen), the cards without the two, and reopening;
    - the search; a stale screen; a vehicle that left Ituran; none ticked; 390 dark.
  - The harness mock takes `window.__fleetShown` (a Set; null = all, as before), `__fleetGone` and `?fleetstale=1`.
- **Deploy, each step with the owner's yes:**
  1. SQL. The dry run shows 7 gaps: the table's key, three new functions and three bodies.
  2. Load the list right after it: `scratchpad/tech/load-fleet.cjs`, a dry run and then `--apply`. Until then the
     technicians view is empty.
  3. Push.
  - An old bundle against the new SQL simply shows the 14. The new bundle needs `fleet_list` only for the window.

### The next task — it starts by itself when he leaves the site (built and deployed 22/10/2026, 79bc65e)

✅ **Deployed at the owner's word ("כן"):**
- **SQL:** 19 gaps, 11 s, then "הייצור זהה לקוד".
- **Checked read-only:**
  - `tech_next` is closed (RLS, no grants) and empty.
  - `follows`, `advance_error` and `advance_error_at` exist.
  - Each changed function has exactly one signature.
  - The Ituran sync ran after the apply with `advance_error` NULL.
  - 86 of 89 agents are beating.
- **Push:** live bundle `index-DNhD7q8P.js`.

The owner: *"כשהוא יוצא מהאתר, אם יש לו משימה נוספת שהקצו לו, שיתזכר אותו לאיפה הוא צריך לנסוע למשימה הבאה"*.

**Her answers:**
- **One next task at most.** A new one replaces it.
- **The next starts by itself.** When his vehicle leaves the site of the current task:
  - the current one closes ("יצא מהאתר");
  - the next becomes a regular dispatch;
  - the phone beeps "המשימה הבאה: X", with navigation and "קיבלתי".
- She was told the risk and chose it: driving off for a minute to fetch a part ends the task early.

**How it works:**
- **`tech_next`** (`technicians.postgres.sql`, at the end) is one row per technician (PK), closed.
  - It is a separate table, not a row in `tech_dispatches`. "One open dispatch per technician", the beep and "קיבלתי" stay
    exactly as they were; the next turns into a dispatch only when it starts.
  - `tech_dispatches.follows` points to the dispatch it followed. It has a partial index, because the prune deletes old
    dispatches.
- **`tech_next_set(tech, site_code, place, details, ticket, client_id, rev)`** — editor, pilot.
  - It needs an open dispatch; otherwise PT409 "אין לטכנאי משימה פתוחה — אפשר לשלוח אותו ישר".
  - A new next replaces the existing one (`replaced`).
  - The same `client_id` again returns what was saved, also after the next has started (the id moves to the dispatch).
    ⚠️ A next that was **replaced** is gone, and so is its id: a stale retry of that old draft would set it again. This is
    accepted; it needs a retry after a different save.
  - `tech_next_clear(tech, rev)` — editor, pilot. With nothing to clear it changes nothing.
  - The audit actions are `tech.next`, `tech.next_clear` and `tech.next_start`.
- **One path for every dispatch.** `app.tech_dest_check` validates the destination, and `app.tech_dispatch_create` creates
  the row, sets "בדרך", logs, and requests the beep inside its own `EXCEPTION`. `tech_dispatch` was refactored onto both,
  and the 57 existing tests pass unchanged.
- **When the next starts** (`app.tech_next_start`, called after the current one closed, with the technician locked):
  1. **Leaving the site** (`app.tech_leave_scan`), run in every Ituran sync after the visits, in its own block:
     - a failure is written to `vehicles_sync.advance_error`, shown in the technicians screen, and cleared by the next
       good sync;
     - "left" = a visit at the task's site that ended after the task was sent, at least 2 minutes ago, with no open visit
       there now;
     - the current task closes as `done`, `ended_by` "יצא מהאתר", `ended_at` = the exit time (never before arrival or
       entry);
     - the log's source is `gps`.
  2. **A manual end** (`tech_dispatch_end`, done or cancelled) **when the next status is "פנוי"**:
     - Otherwise a task at a "מקום אחר" (no site, so no exit) would block it.
     - "הפסקה" / "סיום יום" leaves it queued.
     - Replacing the current task ("החלפה ושליחה") leaves the next queued.
  - **The started dispatch:** `created_by` is whoever queued it. The log row is source `system`.
  - **The phone:** the beep's first title is "המשימה הבאה: …" instead of "משימה חדשה: …".
- **The source of a log row** comes from a transaction-local GUC, `app.tech_source`, read by `tech_log_add`. A parameter
  would have made a second signature of a function everybody calls. Each setter restores the previous value, and a test
  checks that the coordinator's next "הגיע" is `dispatcher` again.
- **A deactivated technician** loses his next task (`tech_save`).

**On screen:**
- **"צא ל:"** on a technician with an open task:
  - The dialog says "אפשר להוסיף את זו כמשימה הבאה — היא תתחיל לבד כשייצא מהאתר — או להחליף את הנוכחית", and that an
    existing next will be replaced.
  - The main button is **"הוספה כמשימה הבאה"**, so the current task is not replaced by habit. "החלפה ושליחה" is the
    second button (`.dp-replace`).
- **The card's task block:**
  - A dashed line "הבאה: X · פרטים", from `tech_json.next`.
  - For an editor, "ביטול הבאה" in one click: nothing has reached the phone yet.
- **The phone:**
  - "אחרי זה: X", with the details on their own line and "תתחיל לבד, עם צפצוף, כשתצא מהאתר".
  - A task that started from the queue is headed "המשימה הבאה" (from `tech_me.dispatch.follows`).

**Tests:**
- `technicians.test.js` (+5, 30 in all):
  - setting, replacing, idempotency, permissions and the pilot, keeping the next when the current is replaced, clearing,
    the audit rows, a deactivated technician, the closed table;
  - a manual end starts it (also a cancel), with `follows`, the status, the beep title and the log sources; "הפסקה"
    waits;
  - leaving: an old visit, under 2 minutes, back at the site, exit time, `gps`, once only; no next, another site, a
    place, no vehicle;
  - the scan inside `ituran_ingest`, and a failing scan that does not break the sync and clears again;
  - `tech_me`.
  - ⚠️ The ingest case uses a plate outside `FLEET`. An earlier test puts TC1 at the FLEET vehicles' location, so they
    have an open visit there and are rightly "still at the site".
- `technicians-direct.test.js` (new): the request bodies, with explicit nulls.
- The roles census and `check-row-cap` cover both new functions.
- Full suite 1404/1404. **SQL mutations (isolated copy, `mut2110/run-mut19.cjs`): 22 of 23 caught.** The survivor is equivalent:
  not restoring `app.tech_source` after the next starts, since nothing logs again in the same transaction (each request
  is its own). The restore stays as a safeguard.
- Browser: `e2e/probe-next.mjs` 27 (the dialog, adding, the card line, replacing, cancelling, a manual end, a בקר, a
  failure, 390 dark), `tp/probe-tpnext.mjs` 11, `probe-dispatch` 71 (C4 follows the new buttons) and `probe-techbeep` 18 (its
  `sendTo` presses "החלפה ושליחה" on a technician with an open task). Unchanged and green: techcards 66, techphone 51,
  vehicles 109, fleet 24, tcmore 38, techfix 23, tp 31, tpbeep 46, tpfix 25.
- The harness mocks take `queueNextTask` / `clearNextTask`, and the phone takes `?me=next|follows`.

**Deploy (each step with the owner's yes):**
- SQL first. The dry run shows 19 gaps: 6 new functions, 9 bodies, and the new table's indexes. ⚠️ The `tech_next` table
  and the `follows` / `advance_error` columns do not show; check `information_schema` after `--apply`.
- Then push. An old bundle against the new SQL simply never shows a next task.

### Two technicians at the same site (built and deployed 22/10/2026, b2e0835 — together with the next section)

The owner: *"יכול להיות שיהיו שני טכנאים באותו אתר. לכן אם יש שני טכנאים ממש קרובים לאתר מסוים — שים אותם באותו אתר"*.

**Measured first, read-only.** Every vehicle got the site nearest to it, so two technicians at one place between two
adjacent sites were split:
- the morning of 22/10: two vehicles 33 m apart, at 1163 and 1343 (sites 48 m apart) for 3 minutes;
- 21/10: two vehicles at 3458 and 3461 (56 m apart) for almost 3 hours.

40 site pairs lie within 100 m of each other, several at the same point (approximate street geocoding).

**`app.vehicle_site(plate, lat, lon)`** (`vehicle-stats.postgres.sql`) is now the one place that decides **which** site a
standing vehicle is at. It is used by the visits (`vehicles_track`) and by the screen (`vehicle_json.at_site`), so also by
"טכנאי באתר" on the board. **Whether** the vehicle is at a site does not change: a vehicle with no site within its own
radius stays without one, even next to a neighbor at a site. The rules, in order:
1. **The vehicle's technician has an open task at a site within its reach** — that site. This also keeps the next task's
   "יצא מהאתר" measured against the right site.
2. **Neighbors:** other standing service vehicles (`fleet_shown`) within `app.fleet_together_m()` (100 m) that have a
   site within their own reach.
   - **(a)** A neighbor's open task at a site within reach of both — that site.
     ⚠️ Without this step the sync's processing order decided: whoever was processed first opened a visit at the site
     nearest to it, and the one sent to the adjacent site stayed alone there.
   - **(b)** Otherwise, the open visit that started first, his own or a neighbor's, at a site within his reach. Whoever
     arrived first decides, and the second joins.
   - **(c)** Otherwise, the site nearest to the midpoint between them, if it is within his reach.
3. **Otherwise** — the nearest (`app.site_at`). Office cars, and neighbors who are driving, never pull.

The `m` returned is the distance from this vehicle to the chosen site.

**Preview in production** (the functions created inside a rolled-back transaction): the 6 standing service vehicles at a
site all keep the site they have. The 1343 pair is already together at that moment. The rule prevents the splits measured
above; it moves nobody now.

**Tests:** `vehicle-stats.test.js` (+1), one pair of sites 50 m apart per case, far from the others:
- coming together picks the site nearest the midpoint, even when the vehicle near the other site is processed first;
- stable over minutes, and on screen too;
- whoever arrived first decides;
- an open task decides for both, and for a lone vehicle;
- 120 m apart is not "close";
- a driving neighbor and an office car do not pull;
- no site within reach stays none;
- a midpoint site outside his reach is not taken.

Full suite 1405/1405.

**SQL mutations (isolated copy, `mut2110/run-mut20.cjs`): 11 of 12 caught.**
- Three survived at first, and their cases were added or sharpened: a driving neighbor and an office car, whose geometry
  could not change the result, and a site out of reach.
- The survivor, "a neighbor with no site in reach counts", is equivalent in practice. With a 150 m site radius and a
  100 m neighbor radius, such a neighbor cannot pull the midpoint to another site within reach.

**Deploy:** SQL only. The dry run shows 4 gaps: 2 new functions and the bodies of `vehicle_json` and `vehicles_track`.
There is no dashboard change.

### "באתר" only for a vehicle that drove today; "מאז 21/10" instead of "7 הימים האחרונים" (built and deployed 22/10/2026, b2e0835)

✅ **Deployed at the owner's word ("כן, לפרסם ולמחוק 8 ביקורים"), together with the two-technicians rule above:**
- **Preview first** (the new functions inside a rolled-back transaction): of 14 service vehicles, exactly one changed —
  the old scooter parked by 3488 since tracking began lost "באתר"; the 7 others at sites had driven that day.
- **SQL:** 6 gaps, 11 s, then "הייצור זהה לקוד". The sync ran 5 s later with `stats_error` and `advance_error` NULL, and
  closed the four open visits of the vehicles that had not moved. 86 of 89 agents beating.
- **Data:** the 8 visit records whose start day had no movement were deleted by hand, in one transaction guarded to
  exactly 8 (3 by 3488 since tracking began, 5 of a non-service scooter whose unit reports no speed or odometer).
- **Push:** b2e0835, live bundle `index-DBMWrali.js` (the week line is in `TechniciansView-C_nFPSAn.js`).

The owner, on a scooter shown "באתר" at a multiplier for 22 hours next to "0 ק״מ היום" and "יצא לדרך —": *"אם הוא לא נסע איך
הוא הגיע לאתר? אני רוצה שאם הוא לא נוסע אז אל תכתוב אותו שהוא באתר, כנראה הוא גר שם"*. And on the card's detail: *"מה
זה אומר 7 הימים האחרונים, רק מאתמול יש לנו איתוראן"*.

**Measured first, read-only.**
- Three vehicles had been parked by 3488 since tracking began (21/10 11:09) without moving, one of them a service
  vehicle. A fourth was by 1218. That is the place the 21/10 "watch" item was about: a parking spot, not a site visit.
- The odometer is whole kilometers. 3 vehicles had a "drive" segment today with no movement (engine on away from a site).
- One scooter that is not on the service list reports only "engine on" at speed 0, with a stuck odometer. It visited
  five sites one evening.

**`app.vehicle_moved_today(plate, now)`** (`vehicle-stats.postgres.sql`) — today's row (Israel day) shows real movement:
- `max_speed` (set only on a "driving" sample with speed ≥ 1), or
- the odometer advanced (`odo_last`, or the live odometer, against `odo_start`).

⚠️ It does **not** use `first_move`: that is also set by engine-on away from a site. A vehicle warming up at home near a
site would become "drove today", and at the next sample "באתר".

⚠️ It reads the **live** odometer as well. `vehicles_track` decides the site before it updates the day row, so a drive
that fell between two samples counted only one sample after the arrival.

**`app.vehicle_site` returns NULL first thing when the vehicle has not moved today.** It now takes `p_now`:
- `vehicles_track` passes its sample time;
- `vehicle_json` passes the row's `synced_at`, like the state, not `now()`.

A neighbor that has not moved today is not a neighbor (rule 2 of the two-technicians rule). So the visits, the card, the
"באתרים" group and the yellow icon on the board all follow one rule.

The card can therefore never say "באתר" next to "0 ק״מ / יצא לדרך —".

**The cost: midnight.** A visit across midnight (a night call) closes at the last sample before midnight, and reopens only
after the vehicle moves. **`app.tech_leave_scan` therefore also requires the vehicle to be out of the site's radius**
(`vehicles_live` vs `site_radius_m`). Without that, a queued next task would start, with a beep, at 00:02 while the
technician was still on site. A vehicle with no live row is not blocked.

⚠️ A unit that reports neither speed nor odometer is never "באתר". That is the scooter above, and it is not a service
vehicle.

**The week line in the card's detail** (`weekLabel` / `visitsText` in `utils/techStats.js`):
- it reads "מאז 21/10: 45 ק״מ · ביקור אחד" until all seven days of the week are tracked;
- after that it reads "7 הימים האחרונים";
- a missing day in the middle also gives "מאז".

**Tests:**
- `vehicle-stats.test.js`:
  - a new test covers parked since the morning (not a visit, not on screen), then a drive and a visit; engine on without
    moving; the odometer between samples; midnight, closed until it moves.
  - The six existing tests that parked without driving now drive first (`drove`).
  - The two-technicians test gained case 8 (a neighbor that did not move does not pull).
- `technicians.test.js`: a visit closed while the vehicle is still in range is not "left"; once it moves away, it is.
- `tech-stats-ui.test.js`: the label.
- Browser: `probe-tcmore` 40/40 (the line reads "מאז DD/MM"), `probe-techcards` 66/66.
- Full suite 1408/1408.

**Mutations (isolated copy, `mut2110/run-mut21.cjs`): 11 of 11 caught.** They cover:
- no gate;
- a neighbor that did not move;
- each of the three movement signals, and `first_move` instead;
- the day in UTC, or any day;
- `now()` in the tracking, or on the screen;
- no in-range guard.

**Deploy:** SQL first (dry run: 6 gaps — `vehicle_moved_today`, `fleet_together_m`, `vehicle_site`, and the bodies of
`vehicle_json`, `vehicles_track`, `tech_leave_scan`; this includes the two-technicians rule above), then push.
The open visits of the vehicles that did not move close at the next sync. Their 8 records (open and closed) are not
deleted by the SQL. Removing them is a separate data step.

### "סטטיסטיקה" for the technicians, a history per technician, and "ניהול טכנאים" for managers (built 22/10/2026; SQL applied and pushed, e6152cf)

The owner: *"אני רוצה לראות גם היסטוריה של אתרים שבהם כל אחד ביקר, וכמה שעות בממוצע נמצא טכנאי באתר, כמה כל אחד מהם, מי
נוסע הכי מהר וכו' — תפרט הרבה מידע וכמה שיותר סטטיסטיקות. תן אופציה להוסיף עוד טכנאי ולמחוק — רק למי שהוא מנהל"*.

**Her answers:**
- A technician is a name plus his vehicle in Ituran. This replaces "רכבים ברשימה", which editors could use.
- Everyone signed in sees the statistics.
- Visit history is kept for **a year** (it was 90 days).
- Speed means max and average, from data that is already collected; nothing new is gathered.

**The report** (`vehicle-stats.postgres.sql`, at the end) is a summary of `vehicle_days` and `vehicle_visits`. It covers
service vehicles only (`fleet_shown`). The period is Israel days, `[from, to]` inclusive, up to 400 days
(`app.report_range`, 22023 beyond that). All three functions are `require_staff` and return one jsonb.
- **`public.tech_stats(from, to)`** returns, per technician:
  - days tracked and work days (days it drove: speed or odometer, the same rule as "באתר");
  - km, km per work day, driving time, time at sites, stops;
  - visits, distinct sites, and time at a site (average, total, longest);
  - average departure, average finish and average workday length (work days only);
  - max speed, and average speed = km per driving hour (only from 10 minutes of driving);
  - the most-visited site (ties go to total time).
  It also returns `team` (distinct sites across all of them, not a sum) and `first_day`.
- **`public.tech_history(plate, from, to)`** returns one technician's days (newest first, visits per day), all his visits
  (newest first, up to 1000, plus the total), and his sites (count, total, average, longest, last).
  - A vehicle that is not on the list is PT404.
  - Site names are the current ones from `sites`, not the snapshot.
- **`public.site_visit_stats(from, to)`** returns, per site: visits, how many technicians and who (with counts and time),
  average / total / longest, and the last visit.
- A visit counts as on the card: 2 minutes or more, or open. It belongs to the day it started.
- **Retention:** `app.prune_vehicle_stats` keeps visits for **365 days**, changed in the default. ⚠️ The dry run does not
  show a changed parameter default, but `--apply` writes it.

**"ניהול טכנאים"** (`technicians.postgres.sql`, at the end) is manager only (`require_manager`), with no pilot gate. The
list is `fleet_shown` with a name per vehicle from `technicians`.
- `public.tech_roster()` returns the technicians on the list and the Ituran vehicles that are not.
- `public.tech_roster_set(plate, name)` adds or renames:
  - A vehicle that is not on the list must be in Ituran (PT404).
  - The name of another active technician who has a vehicle is PT409.
  - An active technician with that name and no vehicle gets this vehicle.
  - A save that changes nothing writes nothing to the audit log.
- `public.tech_roster_remove(plate)` takes the vehicle off the list and deactivates its technician, through
  `app.tech_release`: the phone user is deactivated, the push subscriptions are deleted, and the next task is deleted.
  - An open task is PT409.
  - History is kept.
- `app.tech_release` is the one place for what goes with a deactivated technician. `tech_save` now calls it, with the same
  behaviour as before.
- **`fleet_list` / `fleet_shown_set` are dropped**, along with the "רכבים ברשימה" window (`FleetListDialog.jsx`). An old
  bundle that opens that window gets a 404.
- The audit actions are `tech.roster_set` and `tech.roster_remove`, with ids and plates only.

**On screen:**
- **"טכנאים" has a third view, "סטטיסטיקה"** (`TechStats.jsx`):
  - periods היום / 7 ימים (default) / 30 / 90 / שנה, and "לפי טכנאי" / "לפי אתר";
  - "הנתונים מ-21/10, מאז שהמעקב התחיל" when the period starts earlier;
  - a team line;
  - "שיאים", one row per question: most km, visits, sites, time at sites, longest average visit, max speed, highest
    average speed, earliest departure, longest workday;
  - a table per technician, sortable by any column (null always last, `aria-sort`);
  - a table per site.
  - It loads only when the period or tab changes, not every minute.
- **A name opens `TechHistoryDialog.jsx`**, from the table, from "שיאים", and from "היסטוריה וסטטיסטיקה ←" in the
  card's detail (30 days). It shows a summary, sites, day by day ("לא נסע" for a day without driving, departure–finish
  in Israel time) and every visit, with its own period switch.
- **"ניהול טכנאים"** (`TechRosterDialog.jsx`) is for managers only:
  - add (a name and a vehicle from a `ChoiceSelect`), rename inline, and remove in two clicks (4 s);
  - tags: "שם מאיתוראן", "לא נמצא כרגע באיתוראן", "משימה פתוחה", "טלפון מחובר";
  - a draft does not close on Esc or the backdrop.
- Pure rules are in `utils/techReport.js`: periods by the Israel day, `COLUMNS`, `sortTechs`, `records`, `teamFacts`, and
  time texts.

**Preview in production** (the functions inside a rolled-back transaction, 22/10): `tech_stats` takes 0.2–0.3 s for 1, 7
or 365 days; `site_visit_stats` 0.1 s; `tech_history` for a year 0.2 s.
- 14 technicians, one of them named on the coordinator's board.
- 21/10 was a partial day (tracking started 11:09), so the average departures are late for now.
- 3488, the parking spot near the office, is one vehicle's "most-visited site". ~~Excluding it is the owner's call.~~
  The owner: "להוציא את 3488" — see *Technicians' parking spots* below.

**Tests:**
- `vehicle-stats.test.js` (+1, fixed December data):
  - every figure per technician and for the team;
  - the 2-minute rule, the Israel day edges, an open visit;
  - an office car excluded;
  - a day with the engine on but no driving (not a work day, not in the departure average);
  - a five-minute drive with km gets no average speed;
  - the history and its order;
  - by site;
  - the range checks;
  - an agent and anon refused.
- The prune test: visits at 364 days are kept, at 366 deleted.
- `vehicles.test.js`: the old list test is replaced by the roster test:
  - manager only (editor, בקר, agent, anon refused);
  - add, rename, no-op, a taken name, linking a technician without a vehicle, an unknown plate;
  - a vehicle that left Ituran;
  - an open task;
  - removal with the phone and push subscriptions;
  - re-adding;
  - a vehicle with no technician row.
- `tech-report-ui.test.js` (5), `vehicles-direct.test.js`, and the roles census.
- Full suite 1415/1415.
- **SQL mutations (isolated copy, `mut2110/run-mut22.cjs`): 24 of 24 caught.** Two cases were sharpened first, so that a
  mutation could tell them apart: the engine-on day got a `first_move`, and the short drive got km.
- Browser `e2e/probe-techreport.mjs` 48/48; `probe-fleet` is retired.

**Deploy:** SQL first. The dry run shows 9 gaps: 8 new functions and the body of `tech_save`. ⚠️ It shows neither the
365-day default nor the two dropped functions; check both after `--apply`. Then push. An old bundle against the new SQL
loses "רכבים ברשימה" (404); the new bundle against the old SQL has no statistics and no management (404 on those calls).

✅ **SQL applied 22/10/2026 at the owner's word, the site NOT pushed** (*"אני רוצה לראות את זה ב-SUPABASE אבל אל תעשה
DEPLOY לאתר — רק ב-LOCALHOST"*): she reviews it on her local Vite (localhost:5173, the working tree, against production).
11 s, then "הייצור זהה לקוד". Checked read-only right after: `fleet_list` / `fleet_shown_set` are gone, the four new
public functions exist and are closed to anon, the visit retention default is 365 days, the Ituran sync ran 42 s after
the apply with `stats_error` / `advance_error` NULL, 87 of 90 agents beating. ⚠️ **Until the push, "רכבים ברשימה" on the
live site fails (404)** — the live bundle still has that window. Editors only; nothing is lost. ✅ Pushed the same day at the owner's word ("כן"), e6152cf; Pages `completed success`, live bundle `index-Dd9UTvk0.js` with `tech_roster` / `tech_stats`, the `TechniciansView` chunk with `ts-kpis` / `ts-gantt` / `ts-mix` and no `fleet_list`, and the `TechPhone` chunk without the disconnect button.

### "סטטיסטיקה" is visual, not a table (22/10/2026, pushed e6152cf)

The owner, looking at the table: *"לא רוצה כזו תצוגה, אני רוצה תצוגה ויזואלית, מעניינת, צבעונית וברורה"*. The screen
(`TechStats.jsx`) is now:
- **six team tiles** (ק״מ, בנסיעה, ביקורים באתרים, אתרים שונים, זמן ממוצע באתר, ימי עבודה);
- **"מי הכי"** — one card per record, with a stripe in its colour;
- **"השוואה בין הטכנאים"** — one measure at a time (chips: ק״מ, ביקורים, זמן באתרים, זמן נסיעה, אתרים שונים, ק״מ ליום,
  זמן ממוצע באתר, מהירות ממוצעת, מהירות שיא), horizontal bars from the leader down, the value after each bar, and
  "N בלי נתון" under them (zero and no data are not bars);
- **"יום העבודה"** — average departure to average finish on an hour axis, morning on the right, earliest first;
- **"איך עובר יום עבודה"** — one split bar per technician: נסיעה / באתרים / חונה ואחר, from `drive_s` / `site_s` per
  work day out of `workday_min` (if driving + sites exceed the day, the day is their sum and "אחר" is 0); most time at
  sites first;
- **"לפי אתר"** — bars by visits / total time / average time, technician chips (×n) and the facts line under each.
- **The full table stays, behind "כל המספרים בטבלה"** — every number, and a reading without colour.

Colour follows the measure's family, always the same: road (distance, driving) blue, site (sites, visits) aqua, speed
orange, time (hours of the day) violet; "אחר" grey. Validated with the dataviz validator against the card surface (white /
`#182238`): CVD ΔE ≥ 9.2, normal vision ≥ 20.9. ⚠️ Light blue is step 500 `#256abf` (white on it 5.4:1; step 450 was 4.4).
⚠️ Light aqua is 2.8:1 against white, so every bar has a visible value label and text never takes the data colour. On a
phone the name sits above a full-width bar (beside it the bars were tiny), hour labels show every two hours, and the
record cards are two columns. Pure rules in `utils/techReport.js` (`METRICS`, `barRows`, `recordFamily`, `clockAxis`,
`spanRows`, `MIX_PARTS`, `dayMix`, `mixRows`, `SITE_METRICS`, `siteBarRows`); `teamFacts` is gone.

Tests: `tech-report-ui.test.js` 9 (+4); **mutations 13 of 13** (isolated copy `scratchpad/mutui/run.cjs`; two survived
until their cases were added: departure order equal to finish order in the test, and no work days with both times set).
Browser `e2e/probe-techreport.mjs` 64/64 (V: tiles, cards, bar order and proportional widths, the family colour from the
CSS variable, switching measure, timeline order and right-to-left, the axis, the split filling its row, the table hidden
until clicked, sites; on a phone the leading bar takes most of the row and hour labels do not overlap). Full suite 1420/1420.

### Technicians' parking spots — 3488 is not a site for the vehicles (built 22/10/2026; SQL applied)

The owner, on 3488 (ישראל בק 11-19, a multiplier next to the office, where technicians park): *"להוציא את 3488"*.

- **`settings.tech_parking_sites`** is a comma list of site codes (spaces ignored). The file seeds it with `3488` only when
  the key is missing (`ON CONFLICT DO NOTHING`), so a re-apply never overwrites a changed list. An empty value, or no row,
  means no parking spots. `app.tech_parking_codes()` reads it.
- **A parking spot is never "at a site", at any step:**
  - `app.site_at` skips it (the nearest site within its radius);
  - `app.vehicle_site` skips it in all three rules that can pick a site by themselves: his own open task, a neighbour's
    open task, and the open visit that started first (an old open visit at a spot, from before it was listed, does not
    pull anyone in).
  - So it gets no visit, no "באתר" on the card, no yellow icon on the board, no time at sites, and is never "the site he
    visited most".
- **"ליד" does not change** (`near_sites`): the card still says "ליד ישראל בק…", and "הכי קרוב" still lists vehicles
  near it.
- ⚠️ **The cost, by her choice:** a real job at 3488 is not counted either. A task sent to 3488 never sees "יצא מהאתר",
  so a queued next task there starts only on a manual end. A technician handling a call at 3488 is not "טכנאי באתר".
- ⚠️ `s.code <> ALL ((SELECT app.tech_parking_codes()))` — the first version — is parsed as `ALL (subquery)` and fails on
  `text <> text[]`. It is `<> ALL (app.tech_parking_codes())`.
- **Measured before deploy (read only):** no other site within 400 m of 3488 (street precision, 300 m radius), so nothing
  else is affected. One past visit remains there (a service vehicle, 4 hours, closed); the 8 others were deleted on the
  morning of 22/10. It still counts in the statistics until it is deleted — a separate data step, the owner's call.
- Tests: `vehicle-stats.test.js` "חניות הטכנאים" (the seed; re-apply keeps a changed list; spaces; parking is not a visit
  and the timeline says "park"; a task — his or a neighbour's — at a spot next to a regular site gives the regular site;
  an old open visit at a spot does not pull a neighbour; empty or missing list). File 18/18; `vehicles` 18, `technicians`
  31, `roles` 9. **Mutations (isolated copy, `scratchpad/mutpark/run-mut.cjs`): 8 of 8 caught** (each of the four
  exclusions, `btrim`, an overwriting re-apply, another seed, another key). ⚠️ The copy needs `node_modules`: PGlite is
  an ESM import and ignores `NODE_PATH`. A junction works; remove it with `cmd /c rmdir` (the link only) before deleting
  the copy, or the delete can reach the repo's `node_modules`.
- **Deploy:** SQL only, together with the statistics above (dry run on 22/10: 12 gaps — 9 new functions, among them
  `tech_parking_codes`, and the bodies of `site_at`, `vehicle_site`, `tech_save`). The seed row does not show in the dry
  run; check `settings` after `--apply`. ✅ Applied 22/10/2026 with the statistics (above): `tech_parking_sites` = `3488`,
  no open visit at 3488 afterwards. The one past 3488 visit was **not** deleted (asked, no answer yet).

## "לא פעיל" — sites that are not active go to the end of the board (built 22/10/2026; applied and pushed)

A request from the field that the owner passed on: sites that are not active but show as "תקלה" or "תחזוקה" should drop to
the bottom of the list, under the heading "לא פעיל". The examples were ברנדייס 13 (1114, in maintenance since the morning
of 22/10) and הזורע 2 (1311, in maintenance since 16/09). Both show maintenance because of what the controller reports; no
maintenance window was opened for either.

**Her answers:**
- **Only the position on the board changes.** The status, the header tiles, the alarm on a fault and the statistics all
  stay as they are.
- **Editors and managers set it, from the card.** A בקר sees the line only.

**How it works:**
- **SQL.** `sites.inactive_at` / `inactive_by` / `inactive_reason` (ISO text, like the other times in `sites`).
  `public.site_inactive_set(code, inactive, reason)` uses `require_editor`:
  - The reason is optional. Whitespace is collapsed, and it is cut at 200 characters.
  - Marking a site that is already marked updates only the reason; when and by whom stay.
  - Clearing removes all three.
  - The same state with the same reason changes nothing: no audit and no event.
  - The audit row is `site.inactive` with the id only, not the reason (free text).
  - The event is `site_inactive`, with type and code inside the payload, because that is what the dashboard receives.
- **The board** (`OperatorView`, `utils/siteInactive.js`): `splitInactive` keeps the usual order inside each part. The
  inactive sites get a second `SiteGrid` under `<h2>לא פעיל · N</h2>`. ⚠️ It is a separate grid because a heading inside the
  grid would break the expanded card's row placement (`placementFor`). With no sites at all, the first grid still renders,
  so the board still says "לא נמצאו אתרים".
- **The expanded card:**
  - The line reads "לא פעיל מ-22/10 ע״י דנה · בשיפוץ".
  - For an editor there is a button, "סימון כלא פעיל" / "לא פעיל — שינוי".
  - The button opens `InactiveDialog`: a reason, "סימון כלא פעיל" or "החזרה לפעיל" / "שמירת הסיבה". It uses `.tk-overlay`, so
    the card does not collapse behind it and Esc closes only the window.
  - `SiteInactiveContext` from `App` carries `{canEdit, open}`.
- **On an event,** `App` does a live reload (no statistics), like the traffic light. `needsRefetch` ignores the event. An old
  bundle treats it as unknown and does one full reload per mark; marks are rare.
- A site without a controller has no expanded card, so it cannot be marked from the board.

**Tests:**
- `site-inactive.test.js` (4): mark, update, clear, no-op, the 200 cap, the verified name, audit without the reason, the
  event payload, a בקר / anon / unknown site / a missing choice, and re-applying the files.
- **SQL mutations: 7 of 7 caught** (`scratchpad/mutpark/run-inactive.cjs`).
- `site-inactive-ui.test.js` (2) and the roles census (`site_inactive_set` under EDITOR). Full suite 1429/1429.
- Browser `e2e/probe-inactive.mjs` 23/23:
  - no heading without marks; the heading with marked sites last, in order and with the same card count; the tiles do not
    change;
  - the line and button on a marked card; returning to active; marking with a reason;
  - Esc keeps the card open; a בקר gets no button; a failure stays in the window; 390 dark.
  - The mock takes `?inactive=2438,1003` and `?inactivefail=1`, and exposes `window.__inactiveCalls`.
  - `probe-expand-square` 7, `probe-card-click` 40 and `probe-techcards` 66 still pass.

**Deploy:** SQL first. The dry run shows the new function; the three columns do not show, so check them after `--apply`.
Then push. A new bundle against the old SQL: the board shows nothing (no `inactive_at`), and the button gets a 404.

✅ **Deployed 22/10/2026 at the owner's word ("אוקי תעשה את זה"), with the ignition reminder and the phone popup.** SQL: 9 gaps
(6 new functions, 3 bodies), 12 s, then "הייצור זהה לקוד". Checked read-only right after: the three `sites` columns and the four
`tech_dispatches` columns exist, `site_inactive_set` is closed to anon, the Ituran sync ran 38 s after the apply with
`stats_error` / `advance_error` NULL, and 89 of 91 agents were beating. Push 2c171d5. The live bundle has `op-inactive` /
`site_inactive_set`, and the `TechPhone` chunk has `tp-pop`. Nothing is marked yet: 1114 and 1311 are for the owner or an
editor to mark.

## Gates re-run on the evening of 18/10/2026: five outdated, one real gap

The owner asked for the checks to be run again. Local: 1199/1199, 37 browser probes all green. Selected production gates
(read only, chosen by hand: the full `gates.js` is ~80 gates):

- **Outdated gates, fixed:**
  - `check-effective-status` flagged `d.status` in `app.site_uptime_buckets`. That `d` is the `dur` CTE, already built
    from `COALESCE(reclassified_to, status)`. The alias was added to the explicit allow list with that reason.
  - `check-dashboard-truth` ("chip versus open segment") and `check-direct-write` ("no identity") counted the ~130 sites
    without a controller. Both now skip `monitored = false`.
  - `check-silent-sites` treated *any* open `no_comm` segment from the last 36 h as its own leftover, so the real silent
    sites (1418, 2438) failed it. A leftover of that gate is a *second* open segment on a site, so that is what it counts
    now.
- **Real gap, fixed:** `check-row-cap` — `service_calls_board` (added that morning) was not declared. It is a single
  jsonb.
- **Expected:** `check-dashboard-truth` "pg_cron jobs run". The three prunes added that morning had not reached their
  first run.
- ⚠️ **`check-no-residue` stays red, on purpose:** 449 `audit_log` rows by `gate…@parkomat.co.il`, all from 15/10. They are
  **the real record** of that day's tool runs as a temporary manager: 155 `site.register`, 25 `site.delete` (the
  Wizenet-codes mistake), 256 `site.update` (linking the project codes), and the PM list and profile loads. Deleting
  them would erase the attribution of real changes. The gate pattern cannot tell a tool from a test; a tool should run
  under a name that says so.
- **Real-world findings, not code:**
  - 3 silent sites: 1373 since 16/10, 1418 since 17/10 evening, 2438 since 18/10 14:54.
  - Agent clock drift: 3450 is 3h10m behind (the Israel offset, probably a time zone setting on that PC); 2438, 1326
    and 1418 are about 30 minutes behind.
  - Wizenet relay 3513 has its socket down and works on the 60 s poll.

## Site management: the admin code is remembered for 30 minutes, and the background no longer closes it (19/10/2026)

The owner: *"במצב עריכה כשאני בתוך ניהול האתרים, כל לחיצה הכי קטנה בצידי המסך מוציאה אותי מהעריכה, ובחזור צריך להקיש
כל פעם קוד מחדש… שזה יחזיק את הקוד נגיד לפחות לכחצי שעה… ב-5 דק האחרונות הקשתי אותו לפחות 10 פעמים"*.

- **The management screen does not close on a background click** (`AdminPanel.jsx`). Only ✕ closes it. A click beside
  the window in the middle of an edit used to close the whole panel, and the edit was lost. The code and role screens
  still close on the background, because nothing is lost there.
- **The code is remembered for 30 minutes, sliding** (`useAdmin`). This reverses the 07/10 "locked on every open":
  - Only the expiry is stored, never the code, as `parkomat.adminCodeOkUntil:<user id>` in **sessionStorage**
    (`rememberAdminCode` / `adminCodeStillValid` in `services/adminCodeDirect.js`).
  - Closing the tab locks it again. Another user on the same screen is asked for their own code.
  - Every open of the panel extends the window by 30 minutes. Within one open the panel never locks mid-edit, even after
    30 minutes (`codeOkThisOpen`).
  - The protection is unchanged: `app.require_manager()` in the SQL. The code is a confirmation step against an
    accidental delete, not a lock.
- Browser: `e2e/probe-admin-code.mjs` 9/9 (first open asks; background clicks during an edit keep it; reopen and
  reload skip the code; past 30 minutes asks again; nothing stores the code; a new tab asks). `probe-notier`,
  `probe-lift2`, `probe-agentpw` and `probe-mx-create` still pass.

## Site management: the header and the search stay pinned while the list scrolls (19/10/2026)

The owner: *"שהכותרת תישאר קבועה כשאני גולל מטה — עד וכולל שורת החיפוש. מוצא את עצמי לא מעט צריך לגלול חזרה עד למעלה בשביל
לצאת מהמסך או לחזור לשורת החיפוש"*.

- One pinned block, `.adm-top` (`AdminPanel.jsx` / `.css`), holds the title, the buttons including ✕, the search, and
  the "עודכן" / error line. The message is in it, so saving an edit far down the list shows its result without
  scrolling. The search moved up from the list into this block (it is still shown only with more than 6 sites, and
  not on the identities screen).
- `position: sticky` inside the modal, which is what scrolls.
  - ⚠️ **The modal has no top padding; the 22px are inside `.adm-top`, and it is `top: 0`.** The first version (the
    same evening) was `top: -22px` on a padded modal: exact in Chrome, which pins sticky at the inner edge of the
    scroll container's padding, but dependent on a detail browsers do not agree on. The owner then saw it on her
    screen: *"היא לא ממוקמת בטופ ויש לה שורה שנגללת כאילו מעליה"*. It could not be reproduced in Chromium (DPR 1 to
    1.75, 78 sites, any scroll position), so the fix removes the dependency instead of tuning the number. The
    block's own `border-radius` was dropped too: the modal's clip already rounds it, and a second radius left corner
    slivers.
  - The negative margin and the padding cover the modal's padding on the sides too.
  - The background is the modal's, and a soft shadow underneath separates it from the rows.
- Browser: `e2e/probe-admin-sticky.mjs` 14/14 (1280 light, 390 dark). Scrolled, the block sits at the modal's top edge,
  and no row shows above, beside or inside it (`elementFromPoint`). The search filters from there, and ✕ closes from
  there. `probe-notier`, `probe-admin-code`, `probe-roles`, `probe-agentpw`, `probe-lift2` and `probe-mx-create` still pass.

## Every open dashboard answered every Wizenet event — 56% of DB time, fixed by not refreshing hidden tabs (18/10/2026)

Measured after the day's SQL work, to find the next real cost: a 10-minute delta of `pg_stat_statements` (two read-only
snapshots; the cumulative table since July is dominated by the pre-07/10 card loads and says nothing about today).

| 10-minute window | calls | DB time | mean |
|---|---|---|---|
| `service_call_counts` | 104 | 43 s | 413 ms |
| `service_calls_recent_summary` | 104 | 43 s | 413 ms |
| everything else together | | ~68 s | |

- **The function itself is cheap: ~55 ms** when run alone as a staff user. 413 ms is contention: `realtime.subscription`
  held **29** open subscriptions (≈ open dashboards, office tabs and wall screens), and every `service_calls` event
  made every one of them, hidden tabs included, fire both RPCs in the same second — 8 events in those 10 minutes.
  A real Wizenet burst (8 tickets in 16 s from one tenant, 14/10) is 8 events in a row.
- **Two rules, in `utils/coalesce.js`, proven in `tests/coalesce.test.js` (6/6 mutations):** a hidden tab does not
  refresh at all (the return to the tab refreshes through `onRecover`, built the same morning), and a burst collapses
  into one load 1.5 s after the last event (the measured gap inside a burst is 2–5 s). The 5-minute timers skip hidden
  tabs too (`unlessHidden`). `request()` never calls the loader directly, not even the first time — otherwise 29 screens
  would still fire together on the first event of a burst. The same applies to the task counts.
- **What did not change:** an open dialog still reloads on its own event (`callsRev` / `tasksRev`); that is one screen,
  not 29.
- **And the two RPCs became one (the same evening): `public.service_calls_board(p_hours)`** returns
  `{ sites: [...service_call_counts rows...], summary: {total, open} }` from one materialized pass over
  `app.service_calls_current()` — measured in production 55 ms against 55 + 55 for the pair, and S16 compares it
  row for row with both old functions (they stay for old bundles). `fetchServiceCallBoard` in `serviceCallsDirect.js`
  is what `App.loadCallCounts` calls now; `REVOKE … FROM PUBLIC, anon` like its siblings (S5 enumerates every public
  `service_call*` function anon can execute and expects none — it caught the missing revoke). Applied 18/10, evening.
  Net per event per visible screen: 2 × 55 ms → 1 × 55 ms, 1.5 s after the last event of a burst, and nothing on
  hidden tabs.
- **Measured the same day, ~50 minutes after the deploy** (same 10-minute delta): **43 s of DB time in all, against
  ~154 s in the morning** (7% of one core). The call counts are 13 s (41 + 41 calls of the old pair from screens not
  yet reloaded, now ~125 ms each instead of 413; 30 calls of `service_calls_board` at 99 ms), against 86 s. The top
  of the list is now `site_globals` — 22 calls, 485 ms each, 10.7 s: the 5-minute live load of every visible screen.
- ⚠️ Measure deltas, not the cumulative view: the top of `pg_stat_statements` today is still `site_stats` from before
  07/10. The script pattern is two snapshots of `(queryid, total_exec_time, calls)` and a subtraction; `queryid` is
  stable across the window. ⚠️ A regex in a Bash heredoc loses its backslashes here; use `[.]`, `[(]`, `[[:space:]]`.

## Agent 1.0.61 — Modbus RTU over a COM port, for a controller with no Ethernet (20/10/2026)

Two new sites came with their controller documents the same day, and the owner asked of each whether the agent fits.

- **יהודה הלוי 16 — Modbus UDP, port 502, FC 03, 105..107: the existing agent (1.0.48+) fits, no code change.** Its
  request is byte for byte the one already sent to גרוזנברג 7 (2222). The only difference is that this controller, by
  its document, echoes the transaction id and fills the length field; our UDP channel ignores both, so it reads either.
  Proven with a test that answers in the document's exact shape (`ModbusUdpChannelTests.PlcReaderReadsAStandardUdpControllerExactlyAsItsDocumentDescribes`).
  Setup: Transport UDP, FC 3, Cycle 105 / MODE 106 / Card 107.
- **עוזיאל 122 — Modbus RTU over RS232 → USB-Serial, COM6, 9600 8N1, FC 03, 405..407: a third transport in the same
  agent, 1.0.61** (*"צריך לבנות לזה AGENT חדש?"* — no). Details in [`Parkomat.Agent/CLAUDE.md`](Parkomat.Agent/CLAUDE.md),
  *Modbus RTU over a COM port*: our own channel tested against the document's bytes, the port opened for each read and
  closed right after (the technician programs over the same cable), and a busy port is a failed read — ten of them
  report "PLC unreachable", **the owner's choice** (*"תקלה, כמו נתק בכל אתר"*). Agent tests 710/710; **mutations 15 of
  15 caught** (isolated copy, failing test *names* compared with the baseline — five baseline tests fail in a copy
  without git and the shared contract, and the relay soak tests fail under load, so a count alone proves nothing; the
  first run's "survivor" M15 exposed a test that passed for the wrong reason, now tightened).
  Installer: `Parkomat.Agent/installer-output/ParkomatAgentSetup-1.0.61.exe`.
- ⚠️ **What the dashboard will show at עוזיאל 122, by its document:** MODE 2/3 stays while the machine waits for the
  driver (the operation stays open; the card may mark "תקוע" after 30 minutes); power-on shows 5 for a moment and then
  4, so a fault is recorded until auto is chosen; technician test cycles raise only the counter. The site is not
  registered yet; the "אקסטרקטור" maintenance list exists for it.

## Wizenet relay — status changes go out through site PCs (built 15/10/2026)

WIZEAPI answers only from Israel (Alex, Wizenet, 14/10: *"מוגבלת לפניות מישראל… לחלופין, ניתן לבצע את הפניות דרך שרת
בישראל"*). The owner's idea, instead of a paid server with a fixed IP: *"לכל אתר יש מחשב… אני רוצה שנשתמש ב-1 מהם ונעשה
כמה לגיבוי"*, with a WebSocket for speed. Measured first: from an Israeli PC a request with no token gets `302` to the
login page in 0.7 s, and from Supabase it hangs until the timeout. It is a **country** block, not an address list, so
any site PC passes with nothing to ask of Wizenet. Chosen relays: **1399, 1414, 3513**: no disconnects of their own in 30
days, three cities, none of them a firewall-restricted site.

```
dashboard → wizenet_request_update (staff) → wizenet_requests row + events "doorbell"
  → agent at a relay site hears it (Realtime) or asks anyway every 60 s → wizenet_claim
  → POST to WIZEAPI from Israel → wizenet_complete with the raw answer
  → SQL decides success ("update successfully") and only then records the change
dashboard asks wizenet_request_status every second until done / failed / expired
```

| Piece | Where |
|---|---|
| Queue, relays, claim/complete, parsing, expiry, daily job | `master/db/wizenet-relay.postgres.sql` (after the board file in `db.js`); cron `parkomat-wizenet-daily` |
| Recording (no longer public) | `app.service_call_store_change`, `app.wizenet_lookups_store` in `service-calls-board.postgres.sql` |
| Token door | `supabase/functions/wizenet`, action `relay_config` only |
| Agent | `Parkomat.Agent.Core/Wizenet/*` + `WizenetRelayService` (1.0.60); see `Parkomat.Agent/CLAUDE.md` |
| Dashboard | `serviceCallsDirect.js` (`waitForWizenet`), `ServiceCallsDialog.jsx` ("אין כרגע ממסר פעיל") |
| Tests | `wizenet-relay.test.js` (17), `service-calls-board.test.js` S5א, `wizenet-fn.test.js` (5), `service-calls-direct.test.js` (7), agent `WizenetRelayTests.cs` (32), browser `e2e/probe-relay.mjs` (26) |

- **All decisions are in SQL; the agent is dumb.** The request row carries the exact Wizenet calls (`func` + `body`);
  the agent sends them and returns HTTP status and text. What counts as success, the Hebrew error messages, and parsing
  the status list (`app.wizenet_parse_lookup`, ported from `parseLookup`) are SQL. A Wizenet-side change is a SQL change,
  not a reinstall at three sites. The one exception is an **allow-list of three function names in the agent**: whoever
  takes over the database still cannot make a relay call another Wizenet function with the token.
- ⚠️ **The token is never in a file or in the database.** It stays an Edge Function secret; the relay asks for it
  (`relay_config`) and keeps it in memory. The function hands it over only when `wizenet_relay_me()` says the caller is a
  relay. That is decided in SQL from the identity (`app.agent_site_id()` + an enabled row in `wizenet_relays`), not from
  a parameter. A token Wizenet reject (3xx, 401, 403) is dropped and asked for again.
- **A relay is a row, not a setting.** Every 1.0.60 agent runs the loop, but only a site in `wizenet_relays` opens a
  socket and claims; the others ask once every 30 minutes. Removing a row stops that relay within a minute
  (`wizenet_claim` returns 42501 → 403), and it forgets the token.
- ⚠️ **The doorbell is `events`, type `service_calls`, action `relay`, carrying the request id only.** Not a new type:
  an old bundle (wall screen, PWA) treats an unknown type as "reload everything", which is what overloaded the database on
  07/10. On `service_calls` an old bundle reloads the call counts, one light query. The new bundle ignores `relay`.
- ⚠️ **Realtime is only the doorbell.** It does not redeliver, and site internet is flaky. The request lives in the
  table, and the relay also claims every 60 s; that call is its sign of life (`polled_at`). Alive = asked within 3
  minutes. Typical latency is about a second, at worst a minute while the socket is down.
- **Three clocks** (`app.wizenet_request_ttl` 2 min, `app.wizenet_claim_lease` 120 s, `app.wizenet_relay_fresh` 3 min).
  ⚠️ The lease was 60 s and the review measured a relay's worst case at about 90 s (sign-in, a 401 retry, the token, two
  15 s Wizenet calls): another relay would have resent a change already made, and the first one's success been rejected.
  Nobody claimed it in 2 minutes: expired, **"לא נשלח"**. Claimed, and no answer after the lease: expired, **"לא ידוע
  אם השינוי הגיע"**. A claimed request does not expire inside its lease, or a late `update successfully` would be thrown
  away. A late answer from a relay whose lease passed is rejected (`claimed_site` + `attempt`).
- **Refused at once, not queued to expire:** no live relay (PT503), 20 open requests (PT429), unknown ticket (PT404).
- ⚠️ **A relay that did not reach Wizenet hands the request back** (review, 15/10). A relay whose ISP Wizenet do not see
  as Israeli, or with broken DNS, still asks the queue, so it is "alive", wins its share of doorbells, and failed every
  request it took. Now a `network` / `config` answer (nothing reached Wizenet) puts the request back to `pending`, adds
  the relay to `failed_sites` (it never claims that request again), and rings again. If every live relay has failed it,
  it fails at once with the reason. A **timeout** still fails: Wizenet may have applied it, so it is not resent.
- **The dashboard waits through a failed status check** (review, 15/10). One fetch failing on a phone used to report
  "הפעולה נכשלה" while the request was still queued and applied seconds later, inviting a second click. Only PT404
  ends the wait early; the safety cap is 5 minutes. Busy state and errors are per call, since a change now takes seconds.
- ⚠️ **15/10/2026: `public.wizenet_lookups_save` and `public.service_call_record_change` were dropped.** Until then any
  staff user could record "a change Wizenet confirmed", or load "a list from Wizenet", straight from the browser with
  nobody asking Wizenet. They are now internal (`app.*`, no grants) and only `wizenet_complete` reaches them. The name
  and role recorded are the requester's, not the relay's.
- **Daily at 04:07 UTC** `app.wizenet_daily()` prunes requests older than 30 days and, if a relay is alive, refreshes the
  status and type lists. This closes "a new Wizenet status pulses forever": it is in the list within a day (whether it
  counts as closed is still a guess from the name).
- Mutations: **SQL 45/45** (isolated copies, `scratchpad/sqlmut*`, `mut-relay.cjs`), **agent 39/39** (a copy under
  Documents). Two SQL mutants survived at first: a redundant "relay alive" check in the daily job (removed, and its
  swallow narrowed from `WHEN others` to PT503/PT429 so a real bug is not hidden), and a disabled relay counted in the
  status (a test added). ⚠️ A mutation script that does `src.replace(from, to)` with a **string** reads `$'` in `to` as
  a JS replace pattern, so two mutants of regexes ending in `$'` produced a broken file and "failed" every test. Use a
  replacement function.

### ⚠️ Tested live before any site PC got it — and it caught a bug nothing else could

`master/tools/check-relay-live.js` (`node --env-file=.env tools/check-relay-live.js`) makes a synthetic site, agent and
relay row, runs the agent's real relay code (`WizenetRelayLiveTests`) from the dev PC, which is in Israel, and puts three
real requests in the queue: a list refresh (read only), a status change for a call that does not exist (`999999999`;
Wizenet answer `call not found`, so nothing changes on their side), and the same again after the realtime token is
renewed on the open connection. It removes everything afterwards. No `db.init()`: a plain pg client, only its own rows.

- ⚠️ **The first run failed every call with `411 Length Required`.** The `WIZENET_TOKEN` secret ends with a **newline**.
  Deno's fetch (and Node's) strip it silently, which is why it worked from the Edge Function on 13/10. .NET's
  `TryAddWithoutValidation` sends it as is: the newline closes the headers early, `Content-Length` falls into the body,
  and Wizenet see a POST with no length. The fake handlers could never show this. It is fixed in **three places**: the
  Edge Function trims the token, base and query ids; the agent trims; the forwarder refuses any control character and
  says why. Found by printing only the token's length and the codepoints of its non-alphanumeric characters (`6:U+0020
  47:U+000A`), never the token itself.
- **Measured:** claimed **0.25–0.57 s** after it entered the queue (the doorbell, not the 60 s check), closed in about 1 s.
  After the token renewal the doorbell still rang in 0.43 s, with no reconnect. The list came back with 20 statuses and
  11 types, so the SQL port of `parseLookup` reads the real response.
- A transient `The SSL connection could not be established` appeared once on the first call and recovered by itself 30 s
  later. Failures are now logged with the innermost cause (`WizenetRelayLoop.Describe`), since the outer message alone
  says nothing a technician can act on.

**Soak tests** (`WizenetRelaySoakTests`): 30,000 reconnects and 30,000 requests, with the heap measured at cycle 5,000 and
at the end. ⚠️ They found a real leak: each closed connection left its 25 s heartbeat timer registered on the long-lived
token, 7.7 MB over 29,500 reconnects. The timer is now tied to the session. ⚠️ And the first version of the soak test was
blind, which a mutation proved: with fakes that complete synchronously, `RunAsync` ran all 30,000 cycles before returning,
so "the middle" was measured after the end and a deliberate leak passed. It runs on `Task.Run` now and measures from
inside the loop, at a fixed cycle. Over 120,000 requests the heap is flat after the warm-up (5,072 → 5,073 KB).

**A relay that Wizenet do not answer steps aside** (`MissesBeforePause` = 3, `RelayTimings.Pause` = 10 min). Being
blocked by Wizenet looks like a **timeout**, which is how the Supabase calls failed from abroad, and a timeout on an update
is not handed back (it may have gone through). So three timeouts or network failures in a row, with a success resetting
the count, take the relay out: it stops asking the queue, drops out of "alive", and the backups take everything. A list
refresh is read only, so a timeout there **is** handed back.

**Rollout order:** apply the SQL (dry run first), deploy the `wizenet` function, install 1.0.60 at the three sites, insert
the three `wizenet_relays` rows, live test (refresh the lists, then one real change the owner picks), then flip
`SERVICE_CALLS_WRITE`. Rollback: `UPDATE wizenet_relays SET enabled = false`; the picker greys out within 3 minutes.

✅ **Done 15/10/2026, ~11:10–11:30:** 1.0.60 installed at 1399, 1414 and 3513; all three report `socket_ok` and poll
every minute. The safe test through the real relays passed (1414 claimed a list refresh in 0.50 s, done in 1.01 s), and
the flag was flipped at the owner's request: the first real change is hers, from the dashboard. At 1399 the agent started
three times between 11:08:17 and 11:08:48 and then settled (one process, `LocalAppData` install); the cause was being
checked when the flag went on.
