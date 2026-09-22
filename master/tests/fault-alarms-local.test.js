// tests/fault-alarms-local.test.js — אישור התראות תקלה, על Postgres 17 מקומי.
//
// db/fault-alarms.postgres.sql: טריגר על `events` שפותח התראה על כל מעבר
// אל תקלה, ו-`ack_fault_alarms` שמאשר עם זהות ושם. רץ מקומית (PGlite) ולא
// מול הייצור — ראה tests/helpers/local-pg.js.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
let h;
before(async () => { if (!skip) h = await local.boot(); });
after(async () => { if (h) await h.close(); });

const OPER = "55555555-5555-5555-5555-555555555555";
const AGENT = "66666666-6666-6666-6666-666666666666";
const OFF = "77777777-7777-7777-7777-777777777777";
const iso = () => new Date().toISOString();

let seq = 0;
async function site() {
  const code = `FA${++seq}`;
  const id = (await h.pg.query(
    `INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready',$2) RETURNING id`,
    [code, iso()])).rows[0].id;
  return { id, code };
}
// אירוע מצב — באותו מבנה ש-`ingest_state` ו-`bus.publish` כותבים.
async function state(s, oldStatus, newStatus, faultText = null) {
  return (await h.pg.query(
    `INSERT INTO events (site_id, site_code, type, payload, created_at)
     VALUES ($1, $2, 'state', $3::jsonb, $4) RETURNING id`,
    [s.id, s.code, JSON.stringify({ type: "state", code: s.code, oldStatus, newStatus,
      occurredAt: iso(), faultText }), iso()])).rows[0].id;
}
const alarms = async (s) => (await h.pg.query(
  `SELECT * FROM fault_alarms WHERE site_code = $1 ORDER BY id`, [s.code])).rows;
const ack = (sub, ids, name) => h.as("authenticated", sub,
  (tx) => tx.query(`SELECT * FROM public.ack_fault_alarms($1::bigint[], $2)`, [ids, name]));

async function users() {
  await h.pg.query(`DELETE FROM app_users WHERE supabase_uid IN ($1,$2,$3)`, [OPER, AGENT, OFF]);
  await h.pg.query(
    `INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
       ('oper@parkomat.co.il', 'חדר בקרה', 'operator', true,  $1, $4),
       ('site-x@parkomat.co.il', NULL,     'agent',    true,  $2, $4),
       ('off@parkomat.co.il',  'מושבת',    'operator', false, $3, $4)`,
    [OPER, AGENT, OFF, iso()]);
}

// ================================================================
// הטריגר — מתי נפתחת התראה
// ================================================================
test("מעבר אל תקלה פותח התראה אחת, עם הזמן והתיאור", { skip }, async () => {
  const s = await site();
  const ev = await state(s, "ready", "error", "חיישן דלת");
  const a = await alarms(s);
  assert.equal(a.length, 1);
  assert.equal(String(a[0].event_id), String(ev));
  assert.equal(a[0].fault_text, "חיישן דלת");
  assert.equal(a[0].acked_at, null);
  assert.ok(a[0].occurred_at && a[0].raised_at);
});

test("⚠️ 'error' חוזר על אתר שכבר בתקלה — אינו פותח התראה נוספת", { skip }, async () => {
  const s = await site();
  await state(s, "ready", "error");
  await state(s, "error", "error");   // ingest_state כותב כך הודעה ללא שינוי
  await state(s, "error", "error");
  assert.equal((await alarms(s)).length, 1);
});

test("יציאה מתקלה, מעבר לתחזוקה או לאין-תקשורת — אינם התראה", { skip }, async () => {
  const s = await site();
  await state(s, "ready", "maintenance");
  await state(s, "maintenance", "ready");
  await state(s, "ready", "no_comm");
  assert.equal((await alarms(s)).length, 0);
});

test("תקלה, חזרה, תקלה שוב — שתי התראות נפרדות", { skip }, async () => {
  const s = await site();
  await state(s, "ready", "error");
  await state(s, "error", "ready");
  await state(s, "ready", "error");
  assert.equal((await alarms(s)).length, 2);
});

test("אירוע שאינו state — לא נוגע בהתראות", { skip }, async () => {
  const s = await site();
  await h.pg.query(
    `INSERT INTO events (site_id, site_code, type, payload, created_at) VALUES ($1,$2,'operation',$3::jsonb,$4)`,
    [s.id, s.code, JSON.stringify({ type: "operation", newStatus: "error" }), iso()]);
  assert.equal((await alarms(s)).length, 0);
});

test("⚠️ כשל ברישום ההתראה אינו מפיל את כתיבת האירוע (כלומר את הקליטה)", { skip }, async () => {
  const s = await site();
  await h.pg.query(`ALTER TABLE fault_alarms RENAME TO fault_alarms_gone`);
  try {
    const ev = await state(s, "ready", "error");
    assert.ok(ev, "האירוע נכתב למרות שטבלת ההתראות חסרה");
    const n = (await h.pg.query(`SELECT count(*)::int n FROM events WHERE id = $1`, [ev])).rows[0].n;
    assert.equal(n, 1);
  } finally {
    await h.pg.query(`ALTER TABLE fault_alarms_gone RENAME TO fault_alarms`);
  }
});

// ================================================================
// האישור
// ================================================================
test("אישור עם שם — נרשם מי, מאיזה חשבון ומתי; ושורת תיעוד", { skip }, async () => {
  await users();
  const s = await site();
  await state(s, "ready", "error");
  const [a] = await alarms(s);
  const r = await ack(OPER, [a.id], "  משה כהן  ");
  assert.equal(r.rows[0].acked, 1);
  const [b] = await alarms(s);
  assert.ok(b.acked_at);
  assert.equal(b.acked_by, "משה כהן");
  assert.equal(b.acked_by_name, "חדר בקרה");
  assert.equal(b.acked_by_role, "operator");
  const audit = (await h.pg.query(
    `SELECT count(*)::int n FROM audit_log WHERE action = 'fault.ack' AND target_id LIKE $1`, [`%${s.code}%`])).rows[0].n;
  assert.equal(audit, 1);
});

test("⚠️ אישור שני של אותה התראה — 0, לא שגיאה, ולא דורס את המאשר הראשון", { skip }, async () => {
  await users();
  const s = await site();
  await state(s, "ready", "error");
  const [a] = await alarms(s);
  await ack(OPER, [a.id], "משה כהן");
  const r = await ack(OPER, [a.id], "מישהו אחר");
  assert.equal(r.rows[0].acked, 0);
  assert.equal((await alarms(s))[0].acked_by, "משה כהן");
});

test("בלי שם, או שם של תו אחד — נדחה", { skip }, async () => {
  await users();
  const s = await site();
  await state(s, "ready", "error");
  const [a] = await alarms(s);
  await assert.rejects(ack(OPER, [a.id], ""), /חובה לציין מי מאשר/);
  await assert.rejects(ack(OPER, [a.id], " x "), /חובה לציין מי מאשר/);
  assert.equal((await alarms(s))[0].acked_at, null);
});

test("⚠️ סוכן אתר, משתמש מושבת ואנונימי — אינם מאשרים", { skip }, async () => {
  await users();
  const s = await site();
  await state(s, "ready", "error");
  const [a] = await alarms(s);
  await assert.rejects(ack(AGENT, [a.id], "סוכן"), /סוכן אתר אינו מאשר/);
  await assert.rejects(ack(OFF, [a.id], "מושבת"), /נדרשת הזדהות/);
  await assert.rejects(ack(null, [a.id], "אנונימי"), /נדרשת הזדהות/);
  assert.equal((await alarms(s))[0].acked_at, null);
});

test("⚠️ אין כתיבה ישירה לטבלה מהדפדפן — רק קריאה", { skip }, async () => {
  await users();
  const s = await site();
  await state(s, "ready", "error");
  const [a] = await alarms(s);
  await assert.rejects(h.as("authenticated", OPER,
    (tx) => tx.query(`UPDATE fault_alarms SET acked_at = 'x', acked_by = 'זייף' WHERE id = $1`, [a.id])),
  /permission denied/);
  const seen = await h.as("authenticated", OPER,
    (tx) => tx.query(`SELECT id FROM fault_alarms WHERE id = $1`, [a.id]));
  assert.equal(seen.rows.length, 1, "משתמש פעיל רואה את ההתראה");
  const hidden = await h.as("authenticated", OFF,
    (tx) => tx.query(`SELECT id FROM fault_alarms WHERE id = $1`, [a.id]));
  assert.equal(hidden.rows.length, 0, "משתמש מושבת אינו רואה");
});

test("הקובץ אידמפוטנטי — החלה שנייה עוברת ואינה מכפילה", { skip }, async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const sql = fs.readFileSync(path.join(h.MASTER, "db", "fault-alarms.postgres.sql"), "utf8");
  await h.pg.exec(sql);
  const trg = (await h.pg.query(
    `SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'events_raise_fault_alarm'`)).rows[0].n;
  assert.equal(trg, 1);
  const s = await site();
  await state(s, "ready", "error");
  assert.equal((await alarms(s)).length, 1, "טריגר אחד — התראה אחת");
});
