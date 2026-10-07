// tests/card-metrics.test.js — תיקוני העומס במבנה (07/10/2026), על Postgres 17 מקומי (PGlite).
//
// ⚠️ ביום הזה המסד (NANO) נשאר בלי קרדיטים למעבד. מה שנבדק כאן:
//   1. app.card_metrics_window — **אותו** חלון שהדשבורד ביקש (כולל מעברי שעון).
//   2. site_card_metrics — מה שה-cron שומר זהה למה שארבע הפונקציות מחזירות.
//   3. app.served_operations — מתמזגת לשאילתה, ותוצאתה זהה להגדרה הקודמת.
//   4. app.ensure_cron_job — החלה חוזרת של cron.postgres.sql אינה מדליקה משימה מושהית.
//   5. שומר ההמונים ב-mark_silent_agents — מסד איטי אינו מסמן את כל האתרים כמנותקים.
//
// ⚠️ אזור הזמן של התהליך הוא ישראל — כמו הדפדפן שהחלון שלו מחושב כאן.
process.env.TZ = "Asia/Jerusalem";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
let h;
before(async () => { if (!skip) h = await local.boot(); });
after(async () => { if (h) await h.close(); });

const q = async (sql, p = []) => (await h.pg.query(sql, p)).rows;
const DAY = 86400e3, MIN = 60e3;
const iso = (t) => new Date(t).toISOString();

// ============================================================
// 1. החלון
// ============================================================
// dataSource.js: periodFromIso("week") ו-prevWeekFromIso — אותן פעולות, עם "עכשיו" מוזרק.
function jsWindow(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 6);
  const span = nowMs - d.getTime();
  return { period_from: d.toISOString(), period_to: iso(nowMs), prev_from: iso(d.getTime() - span) };
}

test("⚠️ ההעתק שבבדיקה הוא עדיין מה שהדשבורד מריץ", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../dashboard/src/services/dataSource.js"), "utf8");
  for (const line of [
    "d.setHours(0, 0, 0, 0);",
    `d.setDate(d.getDate() - (period === "month" ? 29 : 6));`,
    "const span = Date.now() - from.getTime();",
    "return new Date(from.getTime() - span).toISOString();",
  ]) assert.ok(src.includes(line), `dataSource.js השתנה — עדכנו את jsWindow ואת app.card_metrics_window: ${line}`);
});

test("החלון זהה לדשבורד — יום רגיל, מעברי שעון וסוף שנה", { skip }, async () => {
  for (const at of [
    "2026-10-07T08:00:00.000Z",   // יום רגיל
    "2026-03-26T22:15:00.000Z",   // 27/03 01:15 — רגע לפני תחילת שעון קיץ
    "2026-03-29T10:00:00.000Z",   // החלון חוצה את תחילת שעון הקיץ
    "2026-10-24T22:30:00.000Z",   // 25/10 01:30 — ליל סוף שעון הקיץ
    "2026-10-26T21:30:00.000Z",   // החלון חוצה את סוף שעון הקיץ
    "2026-12-31T22:30:00.000Z",   // 01/01 00:30 מקומי — מעבר שנה
  ]) {
    const [sql] = await q(`SELECT * FROM app.card_metrics_window($1::timestamptz)`, [at]);
    assert.deepEqual({ ...sql }, jsWindow(Date.parse(at)), at);
  }
});

// ============================================================
// נתונים: 3 אתרים, פעולות לאורך שבועיים, חלונות תחזוקה, תקלות
// ============================================================
let S = [];
async function seed() {
  const now = Date.now();
  S = [];
  for (const code of ["CM1", "CM2", "CM3"]) {
    S.push((await q(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready',$2) RETURNING id`,
      [code, iso(now - 60 * DAY)]))[0].id);
  }
  // פעולה כל 47 דקות לאורך 14 יום, מתחלפת בין האתרים; כל 13 — חריגה
  for (let i = 1, t = now - 14 * DAY; t < now - MIN; i++, t += 47 * MIN) {
    await q(`INSERT INTO operations (site_id, start_end, entry_exit, state, is_anomaly, occurred_at, received_at)
             VALUES ($1,'end',$2,'x',$3,$4,$4)`, [S[i % 3], i % 2 ? "entry" : "exit", i % 13 === 0 ? 1 : 0, iso(t)]);
  }
  // חלון רגיל, חלון שבוטל באמצע, חלון שסומן כניסוי (אינו מכסה דבר)
  const win = async (site, from, hours, extra = {}) => q(
    `INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at, cancelled_at, excluded_at)
     VALUES ($1,'t',$2,$3,$4,$5,$6)`,
    [site, iso(from), hours, iso(from + hours * 3600e3), extra.cancelled ? iso(extra.cancelled) : null, extra.excluded ? iso(from) : null]);
  await win(S[0], now - 3 * DAY, 10);
  await win(S[1], now - 9 * DAY, 10, { cancelled: now - 9 * DAY + 2 * 3600e3 });
  await win(S[2], now - 2 * DAY, 24, { excluded: true });
  // תקלות: מקטעי error סגורים בשני השבועות
  for (const [site, back, mins] of [[S[0], 2, 30], [S[0], 10, 90], [S[1], 1, 5], [S[2], 4, 200]]) {
    const s = now - back * DAY;
    await q(`INSERT INTO status_history (site_id, status, started_at, ended_at) VALUES ($1,'error',$2,$3)`, [site, iso(s), iso(s + mins * MIN)]);
    await q(`INSERT INTO status_history (site_id, status, started_at, ended_at) VALUES ($1,'ready',$2,$3)`, [site, iso(s + mins * MIN), iso(s + mins * MIN + 3600e3)]);
  }
  await h.pg.exec(`ANALYZE operations; ANALYZE maintenance_windows; ANALYZE status_history;`);
}

// ============================================================
// 2. הטבלה
// ============================================================
test("⚠️ מה שה-cron שומר זהה למה שארבע הפונקציות מחזירות — לכל אתר, לכל עמודה", { skip }, async () => {
  await seed();
  const [{ n }] = await q(`SELECT app.refresh_site_card_metrics() AS n`);
  assert.ok(n >= 3, `refresh החזיר ${n}`);
  const rows = await q(`SELECT * FROM site_card_metrics WHERE site_id = ANY($1) ORDER BY site_id`, [S]);
  assert.equal(rows.length, 3);
  const one = async (fn, args, site) => (await q(
    `SELECT to_json(x)::text AS j FROM ${fn}(NULL, ${args}) x WHERE x.site_id = $1`, [site]))[0]?.j ?? null;
  for (const r of rows) {
    const w = { f: r.period_from, t: r.period_to, p: r.prev_from };
    const txt = async (col) => (await q(`SELECT ${col}::text AS j FROM site_card_metrics WHERE site_id = $1`, [r.site_id]))[0].j;
    assert.equal(await txt("stats"), await one("site_stats", `'${w.f}', '${w.t}'`, r.site_id), `stats ${r.site_id}`);
    assert.equal(await txt("prev"), await one("site_stats", `'${w.p}', '${w.f}'`, r.site_id), `prev ${r.site_id}`);
    assert.equal(await txt("uptime"), await one("site_uptime", `'${w.f}', '${w.t}'`, r.site_id), `uptime ${r.site_id}`);
    assert.equal(await txt("svc"), await one("site_uptime_service", `'${w.f}', '${w.t}'`, r.site_id), `svc ${r.site_id}`);
    assert.ok(r.stats.operations > 0, "יש פעולות — הבדיקה אינה משווה ריק לריק");
  }
  // החלון השמור הוא החלון של אותו רגע
  const [w] = await q(`SELECT * FROM app.card_metrics_window($1::timestamptz)`, [rows[0].computed_at]);
  assert.deepEqual([rows[0].period_from, rows[0].prev_from], [w.period_from, w.prev_from]);
});

test("אתר שנמחק — השורה שלו נמחקת; אתר חדש — מופיע בחישוב הבא", { skip }, async () => {
  const id = (await q(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ('CMX','CMX','ready',$1) RETURNING id`, [iso(Date.now())]))[0].id;
  await q(`SELECT app.refresh_site_card_metrics()`);
  assert.equal((await q(`SELECT count(*)::int n FROM site_card_metrics WHERE site_id = $1`, [id]))[0].n, 1);
  await q(`DELETE FROM sites WHERE id = $1`, [id]);
  assert.equal((await q(`SELECT count(*)::int n FROM site_card_metrics WHERE site_id = $1`, [id]))[0].n, 0);
});

test("הרשאות: משתמש פעיל קורא; אנונימי לא; ואיש אינו כותב מהדפדפן", { skip }, async () => {
  const UID = "55555555-5555-5555-5555-555555555555";
  await q(`INSERT INTO app_users (email, role, is_active, supabase_uid, created_at) VALUES ('cm@parkomat.co.il','operator',true,$1,$2)
           ON CONFLICT DO NOTHING`, [UID, iso(Date.now())]);
  const seen = await h.as("authenticated", UID, (tx) => tx.query(`SELECT count(*)::int n FROM site_card_metrics`));
  assert.ok(seen.rows[0].n >= 3);
  // ⚠️ משתמש שהושבת מחזיק אסימון תקף עד שיפוג — ה-RLS הוא מה שעוצר אותו
  const OFF = "66666666-6666-6666-6666-666666666666";
  await q(`INSERT INTO app_users (email, role, is_active, supabase_uid, created_at) VALUES ('cm-off@parkomat.co.il','operator',false,$1,$2)
           ON CONFLICT DO NOTHING`, [OFF, iso(Date.now())]);
  const off = await h.as("authenticated", OFF, (tx) => tx.query(`SELECT count(*)::int n FROM site_card_metrics`));
  assert.equal(off.rows[0].n, 0, "משתמש מושבת רואה את הנתונים");
  await assert.rejects(h.as("anon", null, (tx) => tx.query(`SELECT * FROM site_card_metrics`)), /permission denied/);
  await assert.rejects(h.as("authenticated", UID, (tx) => tx.query(
    `UPDATE site_card_metrics SET computed_at = 'x'`)), /permission denied/);
  await assert.rejects(h.as("authenticated", UID, (tx) => tx.query(
    `SELECT app.refresh_site_card_metrics()`)), /permission denied/);
});

// ============================================================
// 3. served_operations
// ============================================================
test("⚠️ app.served_operations מתמזגת לשאילתה — anti join ולא קריאה לכל שורה", { skip }, async () => {
  const plan = (await q(`EXPLAIN SELECT count(*) FROM app.served_operations() o WHERE o.site_id = $1`, [S[0]]))
    .map((r) => r["QUERY PLAN"]).join("\n");
  assert.match(plan, /Anti Join/, plan);
  assert.doesNotMatch(plan, /Function Scan/, plan);
  // מה ששובר את המיזוג בלי שום שגיאה — ולכן נבדק בשמו
  const [p] = await q(`SELECT p.prosecdef, p.proconfig, p.provolatile, p.prolang = (SELECT oid FROM pg_language WHERE lanname='sql') AS is_sql
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND p.proname = 'served_operations'`);
  assert.deepEqual({ ...p }, { prosecdef: false, proconfig: null, provolatile: "s", is_sql: true });
  assert.equal((await q(`SELECT count(*)::int n FROM pg_proc WHERE proname = 'op_served'`))[0].n, 0, "ההגדרה הקודמת נמחקה");
});

test("⚠️ זהה להגדרה הקודמת (op_served) — כולל גבולות, חלון שבוטל וחלון שסומן כניסוי", { skip }, async () => {
  // ההגדרה הקודמת, מילה במילה — כמקור השוואה בלבד
  await h.pg.exec(`
    CREATE OR REPLACE FUNCTION pg_temp.ref_served(p_site_id integer, p_occurred_at text) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT NOT EXISTS (SELECT 1 FROM public.maintenance_windows w WHERE w.site_id = p_site_id AND w.excluded_at IS NULL
        AND p_occurred_at >= w.started_at AND p_occurred_at < COALESCE(w.cancelled_at, w.expires_at)) $$;`);
  // פעולות על הגבולות בדיוק: בתחילת החלון (אינה שירות) ובסופו (שירות)
  const [mw] = await q(`SELECT started_at, expires_at FROM maintenance_windows WHERE site_id = $1 AND cancelled_at IS NULL AND excluded_at IS NULL`, [S[0]]);
  for (const t of [mw.started_at, mw.expires_at]) {
    await q(`INSERT INTO operations (site_id, start_end, entry_exit, state, occurred_at, received_at) VALUES ($1,'end','entry','x',$2,$2)`, [S[0], t]);
  }
  const ref = await q(`SELECT o.id FROM operations o WHERE pg_temp.ref_served(o.site_id, o.occurred_at) ORDER BY o.id`);
  const now = await q(`SELECT o.id FROM app.served_operations() o ORDER BY o.id`);
  assert.deepEqual(now, ref);
  const all = (await q(`SELECT count(*)::int n FROM operations`))[0].n;
  assert.ok(ref.length < all && ref.length > all / 2, `יש פעולות שהוחרגו וגם שנספרו (${ref.length}/${all})`);
  const ids = new Set(now.map((r) => r.id));
  const edge = await q(`SELECT id, occurred_at FROM operations WHERE site_id = $1 AND occurred_at = ANY($2) ORDER BY occurred_at`, [S[0], [mw.started_at, mw.expires_at]]);
  assert.equal(ids.has(edge.find((e) => e.occurred_at === mw.started_at).id), false, "ברגע תחילת החלון — אינה שירות");
  assert.equal(ids.has(edge.find((e) => e.occurred_at === mw.expires_at).id), true, "ברגע סוף החלון — כבר שירות");
});

// ============================================================
// 4. ensure_cron_job
// ============================================================
test("⚠️ החלה חוזרת של cron.postgres.sql אינה מדליקה משימה שהושהתה ביד", { skip }, async () => {
  const job = async (n) => (await q(`SELECT schedule, command, active FROM cron.job WHERE jobname = $1`, [n]))[0];
  assert.deepEqual({ ...(await job("parkomat-card-metrics")) },
    { schedule: "*/10 * * * *", command: "SELECT app.refresh_site_card_metrics()", active: true });
  await q(`UPDATE cron.job SET active = false, schedule = '0 0 * * *' WHERE jobname = 'parkomat-agent-silence'`);
  await h.pg.exec(fs.readFileSync(path.join(__dirname, "../db/cron.postgres.sql"), "utf8"));
  const s = await job("parkomat-agent-silence");
  assert.equal(s.active, false, "המשימה המושהית הודלקה מחדש בהחלה");
  assert.equal(s.schedule, "* * * * *", "הלוח כן מתעדכן מהקוד");
  assert.equal((await job("parkomat-card-metrics")).active, true);
  await q(`UPDATE cron.job SET active = true WHERE jobname = 'parkomat-agent-silence'`);
});

// ============================================================
// 5. שומר ההמונים
// ============================================================
async function fleet(total, silent, { maint = 0 } = {}) {
  await q(`DELETE FROM app_users WHERE email ILIKE 'site-AG%'`);
  await q(`DELETE FROM sites WHERE code LIKE 'AG%'`);
  await q(`DELETE FROM ingest_drops WHERE reason = 'silence_mass_skipped'`);
  const now = Date.now(), ids = [];
  for (let i = 0; i < total; i++) {
    const code = `AG${i}`;
    const id = (await q(`INSERT INTO sites (code, site_name, status, registered_at, last_seen) VALUES ($1,$1,'ready',$2,$3) RETURNING id`,
      [code, iso(now - 30 * DAY), iso(now - DAY)]))[0].id;
    await q(`INSERT INTO app_users (email, role, is_active, supabase_uid, site_id, created_at) VALUES ($1,'agent',true,$2,$3,$4)`,
      [`site-${code}@parkomat.co.il`, `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`, id, iso(now)]);
    const seen = i < silent ? now - 10 * MIN : now;
    await q(`INSERT INTO alive (site_id, seen_at) VALUES ($1, $2)`, [id, iso(seen)]);
    if (i < maint) {
      await q(`INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at) VALUES ($1,'t',$2,4,$3)`,
        [id, iso(now - 3600e3), iso(now + 3 * 3600e3)]);
    }
    ids.push(id);
  }
  return ids;
}
const marked = async (ids) => (await q(`SELECT count(*)::int n FROM sites WHERE id = ANY($1) AND status = 'no_comm'`, [ids]))[0].n;
const skipped = async () => (await q(`SELECT detail FROM ingest_drops WHERE reason = 'silence_mass_skipped'`));

test("⚠️ 6 מתוך 8 שותקים יחד — אף אחד לא מסומן, ושורה אחת מסבירה למה", { skip }, async () => {
  const ids = await fleet(8, 6);
  const out = await q(`SELECT * FROM app.mark_silent_agents(3)`);
  assert.equal(out.length, 0);
  assert.equal(await marked(ids), 0);
  const d = await skipped();
  assert.equal(d.length, 1);
  assert.match(d[0].detail, /^6 מתוך 8 /);
});

test("אתר בודד שתק — מסומן כמו תמיד, ומדווח", { skip }, async () => {
  const ids = await fleet(8, 1);
  const out = await q(`SELECT * FROM app.mark_silent_agents(3)`);
  assert.deepEqual(out.map((r) => r.site_code), ["AG0"]);
  assert.ok(out[0].quiet_minutes >= 9);
  assert.equal(await marked(ids), 1);
  assert.equal((await skipped()).length, 0);
});

test("4 שתקו (פחות מ-5) — מסומנים; 5 מתוך 12 (פחות ממחצית) — מסומנים", { skip }, async () => {
  let ids = await fleet(6, 4);
  await q(`SELECT * FROM app.mark_silent_agents(3)`);
  assert.equal(await marked(ids), 4, "הפסקת חשמל אזורית של כמה אתרים — עדיין נתק");
  ids = await fleet(12, 5);
  await q(`SELECT * FROM app.mark_silent_agents(3)`);
  assert.equal(await marked(ids), 5);
  assert.equal((await skipped()).length, 0);
});

test("אתר בחלון תחזוקה אינו נספר — לא כשותק ולא כחי", { skip }, async () => {
  // 10 אתרים, 5 שותקים — מתוכם 3 בחלון תחזוקה: 2 שותקים מתוך 7 נשמרים → מסומנים
  const ids = await fleet(10, 5, { maint: 3 });
  const out = await q(`SELECT * FROM app.mark_silent_agents(3)`);
  assert.deepEqual(out.map((r) => r.site_code).sort(), ["AG3", "AG4"]);
  assert.equal(await marked(ids), 2);
});

// ============================================================
// 6. משימת הסטטיסטיקות נכשלת בשקט → בדיקת הבריאות מתריעה
// ============================================================
const health = async () => (await q(`SELECT * FROM app.check_ingestion_health(10, 15)`))
  .filter((r) => r.alerted === "card_metrics_stale");

test("⚠️ הסטטיסטיקות לא עודכנו שעתיים — בדיקת הבריאות מתריעה; אחרי חישוב — שקט", { skip }, async () => {
  await q(`SELECT app.refresh_site_card_metrics()`);
  assert.equal((await health()).length, 0, "טרי — אין התראה");
  await q(`UPDATE site_card_metrics SET computed_at = to_char((now() - interval '2 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  const stale = await health();
  assert.equal(stale.length, 1);
  assert.match(stale[0].detail, /^עודכנו לאחרונה /);
  await q(`SELECT app.refresh_site_card_metrics()`);
  assert.equal((await health()).length, 0, "אחרי חישוב — שוב שקט");
});

test("29 דקות — עוד לא (ריצה אחת שהוחמצה אינה תקלה); טבלה ריקה — 'לא חושבו מעולם'", { skip }, async () => {
  await q(`UPDATE site_card_metrics SET computed_at = to_char((now() - interval '29 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  assert.equal((await health()).length, 0);
  await q(`DELETE FROM site_card_metrics`);
  const never = await health();
  assert.equal(never.length, 1);
  assert.equal(never[0].detail, "לא חושבו מעולם");
  await q(`SELECT app.refresh_site_card_metrics()`);
});
