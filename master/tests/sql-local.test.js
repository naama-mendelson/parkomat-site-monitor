// tests/sql-local.test.js — הקליטה, ההרשאות ושעות השירות, על Postgres 17 מקומי.
//
// כל בדיקה כאן נכתבה **לפני** התיקון שלה ונכשלה מהסיבה הנכונה (17/09/2026),
// ושש מוטציות על `ingest_batch` נתפסו כל אחת בבדיקה שנועדה לה. ראה
// tests/helpers/local-pg.js למה זה רץ מקומית ולא מול הייצור.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

let h;
before(async () => { if (!skip) h = await local.boot(); });
after(async () => { if (h) await h.close(); });

const AGENT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const OFF = "33333333-3333-3333-3333-333333333333";
const MGR = "44444444-4444-4444-4444-444444444444";
const H = 3600e3;
const iso = (t) => new Date(t).toISOString();
const sec = (t) => iso(Math.floor(t / 1000) * 1000);   // חותמת סוכן: שניות שלמות

let seq = 0;
async function agentSite({ status = "no_comm", history = [] } = {}) {
  const code = `T${++seq}`;
  const id = (await h.pg.query(
    `INSERT INTO sites (code, site_name, status, registered_at, last_seen) VALUES ($1,$1,$2,$3,$4) RETURNING id`,
    [code, status, iso(Date.now() - 24 * H), iso(Date.now() - H)])).rows[0].id;
  for (const [st, s, e, reclass] of history) {
    await h.pg.query(
      `INSERT INTO status_history (site_id, status, started_at, ended_at, reclassified_to) VALUES ($1,$2,$3,$4,$5)`,
      [id, st, iso(s), e ? iso(e) : null, reclass ?? null]);
  }
  await h.pg.query(`DELETE FROM app_users WHERE supabase_uid = $1`, [AGENT]);
  await h.pg.query(
    `INSERT INTO app_users (email, role, is_active, supabase_uid, site_id, created_at) VALUES ($1,'agent',true,$2,$3,$4)`,
    [`site-${code}@parkomat.co.il`, AGENT, id, iso(Date.now())]);
  return { id, code };
}
const statusOf = async (id) => (await h.pg.query(`SELECT status FROM sites WHERE id=$1`, [id])).rows[0].status;
const batch = (msgs) => h.as("authenticated", AGENT,
  (tx) => tx.query(`SELECT * FROM public.ingest_batch($1::jsonb, '1.0.99')`, [JSON.stringify(msgs)]));
const disconnected = (prev) => {
  const now = Date.now();
  return [...prev(now), ["no_comm", now - 10 * 60e3, null]];
};

// ================================================================
// ingest_batch — ההחזרה מנתק
// ================================================================

test("⚠️ תקלה שנשלחה באותה אצווה של ההחזרה — אינה נזרקת", { skip }, async () => {
  // ההחזרה רצה לפני ההודעות וחתמה במילישניות; כל הודעת מצב באצווה נדחתה כמאוחרת
  const now = Date.now();
  const s = await agentSite({ history: disconnected((n) => [["ready", n - 5 * H, n - 10 * 60e3]]) });
  await batch([{ kind: "state", status: "error", occurred_at: sec(now - 2 * 60e3), fault_text: "x" }]);
  assert.equal(await statusOf(s.id), "error");
});

test("⚠️ תקלה שקרתה לפני סימון הנתק — המצב האחרון באצווה גובר על ההיסטוריה", { skip }, async () => {
  const now = Date.now();
  const s = await agentSite({ history: disconnected((n) => [["ready", n - 5 * H, n - 10 * 60e3]]) });
  await batch([{ kind: "state", status: "error", occurred_at: sec(now - 12 * 60e3) }]);
  assert.equal(await statusOf(s.id), "error");
});

test("⚠️ תחזוקה מהבקר (MODE 0) מוחזרת כתחזוקה — חלון ידני אינו כותב להיסטוריה", { skip }, async () => {
  const s = await agentSite({ history: disconnected((n) => [
    ["error", n - 6 * H, n - 5 * H], ["maintenance", n - 5 * H, n - 10 * 60e3]]) });
  await batch([]);
  assert.equal(await statusOf(s.id), "maintenance");
});

test("ההחזרה לפי started_at ולא לפי id (שורת backfill)", { skip }, async () => {
  const now = Date.now();
  const s = await agentSite({ history: [
    ["operating", now - 2 * H, now - 10 * 60e3], ["no_comm", now - 10 * 60e3, null], ["error", now - 9 * H, now - 8 * H]] });
  await batch([]);
  assert.equal(await statusOf(s.id), "operating");
});

test("תקלה שסווגה מחדש כתחזוקה אינה חוזרת כתקלה", { skip }, async () => {
  const s = await agentSite({ history: disconnected((n) => [
    ["ready", n - 9 * H, n - 5 * H], ["error", n - 5 * H, n - 10 * 60e3, "maintenance"]]) });
  await batch([]);
  assert.equal(await statusOf(s.id), "maintenance");
});

test("פעימה ריקה באתר מנותק שהיה מוכן — חוזר למוכן, ומקטע הנתק נסגר", { skip }, async () => {
  const s = await agentSite({ history: disconnected((n) => [["ready", n - 5 * H, n - 10 * 60e3]]) });
  await batch([]);
  const open = (await h.pg.query(
    `SELECT count(*)::int n FROM status_history WHERE site_id=$1 AND status='no_comm' AND ended_at IS NULL`, [s.id])).rows[0].n;
  assert.deepEqual({ st: await statusOf(s.id), open }, { st: "ready", open: 0 });
});

test("פעימה באתר תקין אינה כותבת מקטע ואינה משנה מצב", { skip }, async () => {
  const now = Date.now();
  const s = await agentSite({ status: "operating", history: [["ready", now - 5 * H, now - H], ["operating", now - H, null]] });
  const count = async () => (await h.pg.query(`SELECT count(*)::int n FROM status_history WHERE site_id=$1`, [s.id])).rows[0].n;
  const before = await count();
  await batch([]);
  assert.deepEqual({ st: await statusOf(s.id), rows: await count() }, { st: "operating", rows: before });
});

test("⚠️ הודעה פגומה אחת — הפעימה נרשמת, שאר ההודעות נקלטות, והפגומה מתועדת", { skip }, async () => {
  const now = Date.now();
  const s = await agentSite({ status: "ready", history: [["ready", now - 5 * H, null]] });
  await batch([
    { kind: "operation", start_end: "start", entry_exit: "entry", card: "1", state: "operating",
      occurred_at: sec(now - 60e3), cycle: "not-a-number" },
    { kind: "state", status: "error", occurred_at: sec(now - 30e3) },
  ]);
  const beat = (await h.pg.query(`SELECT beats FROM alive WHERE site_id=$1`, [s.id])).rows[0];
  const drops = (await h.pg.query(`SELECT reason FROM ingest_drops WHERE site_code=$1`, [s.code])).rows.map((r) => r.reason);
  assert.ok(beat, "הפעימה לא נרשמה");
  assert.equal(await statusOf(s.id), "error");
  assert.ok(drops.includes("message_threw"), `הפגומה לא תועדה: ${JSON.stringify(drops)}`);
});

test("ingest_batch — אנונימי אינו רשאי", { skip }, async () => {
  await assert.rejects(
    h.as("anon", null, (tx) => tx.query(`SELECT * FROM public.ingest_batch('[]'::jsonb)`)),
    /permission denied/);
});

// ================================================================
// הרשאות — לוח הרמזור ו-FixFlow
// ================================================================

test("⚠️ tl_board — אנונימי נדחה (היה SECURITY DEFINER בלי REVOKE)", { skip }, async () => {
  await assert.rejects(h.as("anon", null, (tx) => tx.query(`SELECT public.tl_board()`)), /permission denied/);
});

test("אף פונקציית tl_* אינה ניתנת להרצה אנונימית", { skip }, async () => {
  const r = await h.pg.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'tl\\_%' AND has_function_privilege('anon', p.oid, 'EXECUTE')`);
  assert.deepEqual(r.rows.map((x) => x.proname), []);
});

test("⚠️ משתמש מושבת אינו רואה את הלוח ולא את FixFlow; פעיל רואה", { skip }, async () => {
  await h.pg.query(`INSERT INTO traffic_light_rows (cells, position) VALUES ('{"a":"secret"}', 1)`);
  await h.pg.query(`INSERT INTO ff_systems (id, name) VALUES ('s1', 'מערכת') ON CONFLICT DO NOTHING`);
  await h.pg.query(
    `INSERT INTO app_users (email, role, is_active, supabase_uid, created_at)
     VALUES ('u@parkomat.co.il','operator',true,$1,$3), ('off@parkomat.co.il','operator',false,$2,$3)
     ON CONFLICT (email) DO NOTHING`, [USER, OFF, iso(Date.now())]);
  const read = (uid) => h.as("authenticated", uid, (tx) => tx.query(
    `SELECT jsonb_array_length(public.tl_board()->'rows') AS tl, (SELECT count(*)::int FROM ff_systems) AS ff`));
  assert.deepEqual((await read(USER)).rows[0], { tl: 1, ff: 1 });
  assert.deepEqual((await read(OFF)).rows[0], { tl: 0, ff: 0 });
});

test("מנהל עדיין כותב ללוח; מפעיל נדחה", { skip }, async () => {
  await h.pg.query(
    `INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at)
     VALUES ('m@parkomat.co.il','מנהלת','manager',true,$1,$2) ON CONFLICT (email) DO NOTHING`, [MGR, iso(Date.now())]);
  const row = (await h.pg.query(`INSERT INTO traffic_light_rows (cells, position) VALUES ('{}', 9) RETURNING id`)).rows[0].id;
  await h.as("authenticated", MGR, (tx) => tx.query(`SELECT public.tl_set_cell($1, 'a', '"x"'::jsonb)`, [row]));
  await assert.rejects(h.as("authenticated", USER, (tx) => tx.query(`SELECT public.tl_set_cell($1, 'a', '"y"'::jsonb)`, [row])));
  assert.equal((await h.pg.query(`SELECT cells->>'a' v FROM traffic_light_rows WHERE id=$1`, [row])).rows[0].v, "x");
});

test("כל קבצי ה-SQL אידמפוטנטיים — החלה שנייה עוברת", { skip }, async () => {
  for (const f of ["functions", "security", "writes", "ingest", "cron", "traffic-light", "service-hours", "fixflow"]) {
    await h.pg.exec(fs.readFileSync(path.join(h.MASTER, "db", `${f}.postgres.sql`), "utf8"));
  }
});

// ================================================================
// site_uptime_service — זמינות בתוך שעות השירות
// ================================================================

async function linkedSite(code, plan) {
  await h.pg.query(`INSERT INTO traffic_light_columns (key, label, kind, position) VALUES
    ('c_code','קוד אתר','text',1), ('c_plan','סוג הסכם שירות במקור','text',2), ('c_kind','להתייחס כ','text',3)
    ON CONFLICT (key) DO NOTHING`);
  const id = (await h.pg.query(
    `INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready','2026-01-01T00:00:00.000Z') RETURNING id`,
    [code])).rows[0].id;
  await h.pg.query(`INSERT INTO traffic_light_rows (cells, position) VALUES ($1::jsonb, $2)`,
    [JSON.stringify({ c_code: code, c_plan: plan, c_kind: plan }), 100 + id]);
  return id;
}
const hist = (id, st, s, e, excluded = null) => h.pg.query(
  `INSERT INTO status_history (site_id, status, started_at, ended_at, excluded_at) VALUES ($1,$2,$3,$4,$5)`, [id, st, s, e, excluded]);
const svc = async (id, from, to) => (await h.pg.query(
  `SELECT ready_hours r, error_hours e, maintenance_hours m, measured_hours meas, availability_percent a
     FROM public.site_uptime_service(ARRAY[$1]::int[], $2, $3)`, [id, from, to])).rows[0];
// יום ראשון 06/09/2026, VIP: 07:00–22:00 שעון ישראל = 04:00Z–19:00Z — 15 שעות
const SUN = ["2026-09-06T00:00:00.000Z", "2026-09-07T00:00:00.000Z"];

test("שעות שירות — בסיס: 15 שעות מוכן, 100%", { skip }, async () => {
  const id = await linkedSite("S1", "vip");
  await hist(id, "ready", "2026-09-05T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
  const r = await svc(id, ...SUN);
  assert.deepEqual({ r: r.r, m: r.m, a: r.a }, { r: 15, m: 0, a: 100 });
});

test("שעות שירות — תקלה אמיתית של שעתיים: 13/15", { skip }, async () => {
  const id = await linkedSite("S2", "vip");
  await hist(id, "ready", "2026-09-05T00:00:00.000Z", "2026-09-06T08:00:00.000Z");
  await hist(id, "error", "2026-09-06T08:00:00.000Z", "2026-09-06T10:00:00.000Z");
  await hist(id, "ready", "2026-09-06T10:00:00.000Z", "2026-09-08T00:00:00.000Z");
  const r = await svc(id, ...SUN);
  assert.deepEqual({ r: r.r, e: r.e, a: r.a }, { r: 13, e: 2, a: 86.67 });
});

test("⚠️ שעות שירות — חלון תחזוקה ידני נספר כתחזוקה, לא כמוכן", { skip }, async () => {
  const id = await linkedSite("S3", "vip");
  await hist(id, "ready", "2026-09-05T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
  await h.pg.query(`INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at)
                    VALUES ($1,'בדיקה','2026-09-06T06:00:00.000Z',4,'2026-09-06T10:00:00.000Z')`, [id]);
  const r = await svc(id, ...SUN);
  assert.deepEqual({ r: r.r, m: r.m }, { r: 11, m: 4 });
});

test("⚠️ שעות שירות — מקטע שסומן כניסוי אינו נספר כתקלה", { skip }, async () => {
  const id = await linkedSite("S4", "vip");
  await hist(id, "ready", "2026-09-05T00:00:00.000Z", "2026-09-06T12:00:00.000Z");
  await hist(id, "error", "2026-09-06T12:00:00.000Z", "2026-09-06T13:00:00.000Z", "2026-09-06T14:00:00.000Z");
  await hist(id, "ready", "2026-09-06T13:00:00.000Z", "2026-09-08T00:00:00.000Z");
  const r = await svc(id, ...SUN);
  assert.deepEqual({ r: r.r, e: r.e, a: r.a }, { r: 14, e: 0, a: 100 });
});

test("⚠️ שעות שירות — מקטע פתוח אינו נמשך אל העתיד", { skip }, async () => {
  const id = await linkedSite("S5", "vip");
  const now = Date.now();
  await hist(id, "ready", iso(now - 3 * 24 * H), null);
  const r = await svc(id, iso(now - 24 * H), iso(now + 3 * 24 * H));
  assert.ok(r.meas <= 24, `נמדדו ${r.meas} שעות בטווח שרק 24 מהן עברו`);
});

// ================================================================
// התראות push — הבקשה יוצאת עם מפתח וסוד, והטריגר אינו מפיל קליטה
// ================================================================

const pushMigration = () => h.pg.exec(fs.readFileSync(
  path.join(h.MASTER, "..", "supabase", "migrations", "20260917_push_trigger_wired.sql"), "utf8"));
const setSetting = (k, v) => h.pg.query(
  `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,'x') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
const lastRequest = async () => (await h.pg.query(
  `SELECT headers, body FROM net.http_request_queue ORDER BY id DESC LIMIT 1`)).rows[0];

test("⚠️ תקלת אתר — הטריגר שולח עם Bearer מ-settings ועם הסוד המשותף", { skip }, async () => {
  await pushMigration();
  await setSetting("push_anon_key", "pub-key");
  await setSetting("push_caller_secret", "s3cret");
  const s = await agentSite({ status: "ready", history: [] });
  await h.pg.query(`INSERT INTO status_history (site_id, status, started_at, fault_text) VALUES ($1,'error',$2,'דלת')`,
    [s.id, iso(Date.now())]);
  const r = await lastRequest();
  assert.equal(r.headers.Authorization, "Bearer pub-key");
  assert.equal(r.headers["x-parkomat-push-secret"], "s3cret");
  assert.deepEqual({ site: r.body.site_id, kind: r.body.kind }, { site: s.id, kind: "fault" });
});

test("חסר סוד — אין בקשה, והסיבה נרשמת ב-alert_last_error", { skip }, async () => {
  await pushMigration();
  await h.pg.query(`DELETE FROM settings WHERE key = 'push_caller_secret'`);
  const before = (await h.pg.query(`SELECT count(*)::int n FROM net.http_request_queue`)).rows[0].n;
  const s = await agentSite({ status: "ready", history: [] });
  await h.pg.query(`INSERT INTO status_history (site_id, status, started_at) VALUES ($1,'error',$2)`, [s.id, iso(Date.now())]);
  const after = (await h.pg.query(`SELECT count(*)::int n FROM net.http_request_queue`)).rows[0].n;
  const err = (await h.pg.query(`SELECT value FROM settings WHERE key = 'alert_last_error'`)).rows[0]?.value;
  assert.equal(after, before);
  assert.match(err, /push_caller_secret/);
});

test("⚠️ שליחה שזורקת אינה מגלגלת אחורה את רישום התקלה", { skip }, async () => {
  await pushMigration();
  await setSetting("push_anon_key", "pub-key");
  await setSetting("push_caller_secret", "s3cret");
  const s = await agentSite({ status: "ready", history: [] });
  await h.pg.transaction(async (tx) => {
    await tx.query(`ALTER FUNCTION net.http_post(text, jsonb, jsonb, jsonb, integer) RENAME TO http_post_gone`);
    await tx.query(`INSERT INTO status_history (site_id, status, started_at) VALUES ($1,'error',$2)`, [s.id, iso(Date.now())]);
    const n = (await tx.query(`SELECT count(*)::int n FROM status_history WHERE site_id=$1 AND status='error'`, [s.id])).rows[0].n;
    assert.equal(n, 1);
    await tx.rollback();
  });
});

// ================================================================
// ingest_batch — שעון האתר (אותה בדיקה כמו במסלול MQTT)
// ================================================================

test("⚠️ חותמת שעה בעתיד — נדחית ונרשמת, והמצב אינו זז", { skip }, async () => {
  const now = Date.now();
  const s = await agentSite({ status: "ready", history: [["ready", now - 5 * H, null]] });
  await batch([{ kind: "state", status: "error", occurred_at: sec(now + H) }]);
  const drops = (await h.pg.query(`SELECT reason FROM ingest_drops WHERE site_code=$1`, [s.code])).rows.map((r) => r.reason);
  const seen = (await h.pg.query(`SELECT last_seen FROM sites WHERE id=$1`, [s.id])).rows[0].last_seen;
  assert.equal(await statusOf(s.id), "ready");
  assert.ok(drops.includes("timestamp_rejected"), JSON.stringify(drops));
  assert.ok(Date.parse(seen) <= Date.now() + 5000, `last_seen נדחף לעתיד: ${seen}`);
});

test("חותמת דקה בעתיד — מיושרת לעכשיו ומוחלת", { skip }, async () => {
  const now = Date.now();
  const s = await agentSite({ status: "ready", history: [["ready", now - 5 * H, null]] });
  await batch([{ kind: "state", status: "error", occurred_at: sec(now + 60e3) }]);
  const open = (await h.pg.query(
    `SELECT started_at FROM status_history WHERE site_id=$1 AND ended_at IS NULL`, [s.id])).rows[0].started_at;
  assert.equal(await statusOf(s.id), "error");
  assert.ok(Date.parse(open) <= Date.now() + 2000, `המקטע נפתח בעתיד: ${open}`);
});

// ================================================================
// sites.control_system — מערכת ההפעלה (לולק / ביטנקם …)
// ================================================================

const asManager = async (sql, params) => {
  await h.pg.query(
    `INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at)
     VALUES ('m@parkomat.co.il','מנהלת','manager',true,$1,$2) ON CONFLICT (email) DO NOTHING`, [MGR, iso(Date.now())]);
  return h.as("authenticated", MGR, (tx) => tx.query(sql, params));
};
const systemOf = async (code) =>
  (await h.pg.query(`SELECT control_system FROM sites WHERE code = $1`, [code])).rows[0]?.control_system;

test("רישום אתר עם מערכת — נשמרת", { skip }, async () => {
  await asManager(`SELECT * FROM public.register_site(p_code => 'CS1', p_site_name => 'גרוזנברג בדיקה',
    p_plc_type => 'xy', p_control_system => 'ביטנקם')`);
  assert.equal(await systemOf("CS1"), "ביטנקם");
});

test("⚠️ מערכת שאינה ברשימה — נדחית (לא 'Lolek', לא 'לולק ')", { skip }, async () => {
  for (const bad of ["Lolek", "לולק ביטנקם"]) {
    await assert.rejects(
      asManager(`SELECT * FROM public.update_site(p_code => 'CS1', p_control_system => $1)`, [bad]),
      /מערכת לא תקינה/);
  }
  // רווחים בקצוות אינם ערך אחר — הם נחתכים
  await asManager(`SELECT * FROM public.update_site(p_code => 'CS1', p_control_system => ' לולק ')`);
  assert.equal(await systemOf("CS1"), "לולק");
});

test("⚠️ עדכון בלי השדה אינו נוגע במערכת — הדשבורד שכבר חי אינו שולח אותו", { skip }, async () => {
  await asManager(`SELECT * FROM public.update_site(p_code => 'CS1', p_control_system => 'ביטנקם')`);
  // בדיוק הצורה של הדשבורד הישן: שישה פרמטרים, בלי p_control_system
  await asManager(`SELECT * FROM public.update_site(p_code => 'CS1', p_new_code => 'CS1', p_site_name => 'שם חדש',
    p_plc_type => 'xy', p_fixflow_profile => '')`);
  assert.equal(await systemOf("CS1"), "ביטנקם");
});

test("מחרוזת ריקה מנקה את המערכת", { skip }, async () => {
  await asManager(`SELECT * FROM public.update_site(p_code => 'CS1', p_control_system => '')`);
  assert.equal(await systemOf("CS1"), null);
});

test("רישום בצורה הישנה (בלי מערכת) עדיין עובד", { skip }, async () => {
  await asManager(`SELECT * FROM public.register_site(p_code => 'CS2', p_site_name => 'ישן', p_plc_type => 'doli',
    p_tier => 'basic', p_is_new => true, p_fixflow_profile => NULL)`);
  assert.equal(await systemOf("CS2"), null);
});

test("מפעיל אינו רשאי לשנות מערכת", { skip }, async () => {
  await assert.rejects(h.as("authenticated", USER, (tx) =>
    tx.query(`SELECT * FROM public.update_site(p_code => 'CS1', p_control_system => 'לולק')`)));
});

// ================================================================
// תיאור התקלה שמגיע באיחור — במסלול הישיר
// ================================================================
// ⚠️ הבקר כותב את ה-MODE ואת הטקסט בשתי כתובות שונות ולא באותו רגע, ולכן
// רוב התקלות משודרות בלי תיאור והוא נשלח בשידור משלים. עד 22/09/2026
// השידור המשלים הלך ל-MQTT בלבד (Worker.cs), והשרת מילא אותו. השרת כובה,
// ואז נמדד בייצור: תיאור הגיע ב-1 מתוך 51 תקלות מול 135 מתוך 243 לפני.
//
// הסוכן תוקן לשדר אותו גם ישירות, והבדיקות כאן מקבעות את הצד הקולט: אצווה
// שנייה של "תקלה" עם טקסט **אינה** מצב חדש — היא השלמה למקטע הפתוח.
// tests/late-fault-text.test.js בודקת את אותו כלל בשרת, שכבר אינו בשימוש.

const openFaultText = async (id) => (await h.pg.query(
  `SELECT fault_text FROM status_history WHERE site_id = $1 AND ended_at IS NULL`, [id])).rows[0]?.fault_text ?? null;

test("⚠️ תיאור שהגיע אחרי התקלה ממלא את המקטע הפתוח", { skip }, async () => {
  const now = Date.now();
  const s = await agentSite({ history: [["ready", now - 5 * H, null]] });
  await batch([{ kind: "state", status: "error", occurred_at: sec(now - 2 * 60e3) }]);
  assert.equal(await openFaultText(s.id), null, "התקלה נפתחה בלי תיאור — זה המצב הרגיל");

  await batch([{ kind: "state", status: "error", occurred_at: sec(now - 60e3), fault_text: "מעלית - רפיון שרשרת:" }]);
  assert.equal(await statusOf(s.id), "error", "עדיין אותה תקלה, לא מקטע חדש");
  assert.equal(await openFaultText(s.id), "מעלית - רפיון שרשרת:");
});

test("⚠️ תיאור קיים אינו נדרס על ידי השלמה מאוחרת", { skip }, async () => {
  const now = Date.now();
  const s = await agentSite({ history: [["ready", now - 5 * H, null]] });
  await batch([{ kind: "state", status: "error", occurred_at: sec(now - 2 * 60e3), fault_text: "הראשון" }]);
  await batch([{ kind: "state", status: "error", occurred_at: sec(now - 60e3), fault_text: "השני" }]);
  assert.equal(await openFaultText(s.id), "הראשון");
});

test("השלמה אינה פותחת מקטע נוסף", { skip }, async () => {
  const now = Date.now();
  const s = await agentSite({ history: [["ready", now - 5 * H, null]] });
  await batch([{ kind: "state", status: "error", occurred_at: sec(now - 2 * 60e3) }]);
  await batch([{ kind: "state", status: "error", occurred_at: sec(now - 60e3), fault_text: "אחרי" }]);
  const n = (await h.pg.query(
    `SELECT count(*)::int n FROM status_history WHERE site_id = $1 AND status = 'error'`, [s.id])).rows[0].n;
  assert.equal(n, 1);
});

// ================================================================
// קליטת קריאות שירות מאפליקציית הלקוחות
// ================================================================
// ⚠️ הכתובת שנמסור לצוות האפליקציה קבועה לנצח, ולכן הדלת חייבת לקבל הכול
// ולא לדחות דבר — ראה db/service-calls.postgres.sql. הבדיקות כאן מקבעות
// את שני הצדדים: שהקולט יכול **רק** להכניס, ושגוף שאינו JSON נשמר ולא אובד.

const INTAKE = "55555555-5555-5555-5555-555555555555";
const asIntake = (sql, params) => h.as("authenticated", INTAKE, (tx) => tx.query(sql, params));
// `setSetting` כבר מוגדר למעלה (בדיקות ההתראות) ועושה בדיוק את אותו דבר.

const insertCall = (raw, payload) => asIntake(
  `INSERT INTO service_calls (raw, payload) VALUES ($1, $2::jsonb)`, [raw, payload ?? null]);

test("הקולט מכניס קריאה", { skip }, async () => {
  await setSetting("intake_user_id", INTAKE);
  await insertCall('{"a":1}', '{"a":1}');
  const n = (await h.pg.query(`SELECT count(*)::int n FROM service_calls`)).rows[0].n;
  assert.ok(n > 0);
});

test("⚠️ גוף שאינו JSON נשמר ולא נדחה — ממנו לומדים מה באמת נשלח", { skip }, async () => {
  await setSetting("intake_user_id", INTAKE);
  await insertCall("<xml>לא json</xml>", null);
  const row = (await h.pg.query(
    `SELECT raw, payload FROM service_calls ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(row.raw, "<xml>לא json</xml>");
  assert.equal(row.payload, null);
});

test("⚠️ הקולט אינו קורא — גם לא את מה שהכניס", { skip }, async () => {
  await setSetting("intake_user_id", INTAKE);
  await insertCall('{"b":2}', '{"b":2}');
  const rows = (await asIntake(`SELECT * FROM service_calls`)).rows;
  assert.equal(rows.length, 0, "מדיניות SELECT אינה חלה עליו, ולכן הוא רואה אפס שורות");
});

test("⚠️ הקולט אינו מוחק ואינו מעדכן — וזה נדחה בהרשאה, לא במדיניות", { skip }, async () => {
  // ההבדל חשוב: מדיניות חסרה פירושה "הפעולה רצה ואינה מוצאת שורות", כלומר
  // DELETE שמחזיר הצלחה. כאן אין GRANT בכלל, ולכן הניסיון נופל מיד — וזה
  // ההבדל בין "לא מחק כלום הפעם" לבין "אינו יכול למחוק".
  await setSetting("intake_user_id", INTAKE);
  await insertCall('{"c":3}', '{"c":3}');
  const before = (await h.pg.query(`SELECT count(*)::int n FROM service_calls`)).rows[0].n;

  await assert.rejects(asIntake(`DELETE FROM service_calls`), /permission denied/);
  await assert.rejects(asIntake(`UPDATE service_calls SET raw = 'נדרס'`), /permission denied/);

  const after = (await h.pg.query(
    `SELECT count(*)::int n, count(*) FILTER (WHERE raw = 'נדרס')::int hurt FROM service_calls`)).rows[0];
  assert.equal(after.n, before, "שום שורה לא נמחקה");
  assert.equal(after.hurt, 0, "שום שורה לא שונתה");
});

test("⚠️ כיבוי הדגל סוגר את הדלת מיד", { skip }, async () => {
  await setSetting("intake_user_id", INTAKE);
  await setSetting("intake_enabled", "false");
  await assert.rejects(insertCall('{"d":4}', '{"d":4}'));
  await setSetting("intake_enabled", "true");
});

test("⚠️ זהות אחרת אינה מכניסה, גם אם היא משתמש פעיל", { skip }, async () => {
  await setSetting("intake_user_id", INTAKE);
  await assert.rejects(h.as("authenticated", USER,
    (tx) => tx.query(`INSERT INTO service_calls (raw) VALUES ('{"e":5}')`)));
});

test("⚠️ בלי מזהה קולט ב-settings אין כניסה — ברירת המחדל סגורה", { skip }, async () => {
  await h.pg.query(`DELETE FROM settings WHERE key = 'intake_user_id'`);
  await assert.rejects(insertCall('{"f":6}', '{"f":6}'));
  await setSetting("intake_user_id", INTAKE);
});

test("איש צוות קורא את הקריאות", { skip }, async () => {
  await setSetting("intake_user_id", INTAKE);
  await insertCall('{"g":7}', '{"g":7}');
  const rows = (await h.as("authenticated", USER, (tx) => tx.query(`SELECT * FROM service_calls`))).rows;
  assert.ok(rows.length > 0);
});

test("anon אינו נוגע בטבלה בכלל", { skip }, async () => {
  await assert.rejects(h.as("anon", null, (tx) => tx.query(`SELECT * FROM service_calls`)));
  await assert.rejects(h.as("anon", null, (tx) => tx.query(`INSERT INTO service_calls (raw) VALUES ('x')`)));
});

test("גוף ענק נדחה — דלת פתוחה לאינטרנט בלי תקרה ממלאת את המסד", { skip }, async () => {
  await setSetting("intake_user_id", INTAKE);
  await assert.rejects(insertCall("x".repeat(100001), null));
});

test("JSON שאינו אובייקט אינו נשמר כ-payload", { skip }, async () => {
  await setSetting("intake_user_id", INTAKE);
  await assert.rejects(insertCall("[1,2,3]", "[1,2,3]"));
});
