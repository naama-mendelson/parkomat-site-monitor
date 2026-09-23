// tests/ingest-drops-once.test.js — הודעה שנדחתה נרשמת **פעם אחת**.
//
// ⚠️ נמדד בייצור 23/09/2026: `state_backfill` = 590 ו-
// `state_late_vs_open_segment` = 590 באותו יום, לאותן הודעות בדיוק. שתי
// שכבות רשמו את אותה דחייה — הפנימית (`app.ingest_state`) בשם המפורט,
// והחיצונית (`ingest_batch`) בשם התוצאה. הנתונים לא אבדו, אבל כל מי שסופר
// דחיות קיבל מספר כפול מהאמת, וזו בדיוק התקלה ש-`state_no_change` נבנה
// כדי למנוע: תופעה אחת שנספרת תחת שני שמות.
//
// הפתרון הוא דגל `recorded` ולא רשימת outcomes — רשימה הייתה צריכה
// להתעדכן בכל תוצאה חדשה, והתוצאה שתישכח היא זו שתיספר פעמיים בשקט.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
let h;
before(async () => { if (!skip) h = await local.boot(); });
after(async () => { if (h) await h.close(); });

const AGENT = "88888888-8888-8888-8888-888888888888";
const iso = (t = Date.now()) => new Date(Math.floor(t / 1000) * 1000).toISOString();

let seq = 0;
async function site() {
  const code = `D${++seq}`;
  const id = (await h.pg.query(
    `INSERT INTO sites (code, site_name, status, registered_at, last_seen)
     VALUES ($1,$1,'ready',$2,$2) RETURNING id`, [code, iso(Date.now() - 3600e3)])).rows[0].id;
  await h.pg.query(`DELETE FROM app_users WHERE supabase_uid = $1`, [AGENT]);
  await h.pg.query(
    `INSERT INTO app_users (email, role, is_active, supabase_uid, site_id, created_at)
     VALUES ($1,'agent',true,$2,$3,$4)`, [`site-${code}@parkomat.co.il`, AGENT, id, iso()]);
  return { id, code };
}
const drops = async (code) => (await h.pg.query(
  `SELECT reason, count(*)::int n FROM ingest_drops WHERE site_code = $1 GROUP BY reason ORDER BY reason`,
  [code])).rows;
const batch = (msgs) => h.as("authenticated", AGENT,
  (tx) => tx.query(`SELECT * FROM public.ingest_batch($1::jsonb, '1.0.99')`, [JSON.stringify(msgs)]));

test("⚠️ הודעה מאוחרת נרשמת פעם אחת — בשם המפורט", { skip }, async () => {
  const s = await site();
  const now = Date.now();
  // מקטע פתוח שמתחיל עכשיו, ואז הודעה שקדמה לו — זה בדיוק backfill
  await h.pg.query(
    `INSERT INTO status_history (site_id, status, started_at, ended_at) VALUES ($1,'operating',$2,NULL)`,
    [s.id, iso(now)]);
  await batch([{ kind: "state", status: "ready", occurred_at: iso(now - 600e3) }]);

  const rows = await drops(s.code);
  const total = rows.reduce((a, r) => a + r.n, 0);
  assert.equal(total, 1, `נרשמה יותר משורה אחת: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].reason, "state_late_vs_open_segment", "השם המפורט הוא שנשמר");
});

test("דחייה שרק השכבה החיצונית מכירה — עדיין נרשמת", { skip }, async () => {
  // 'ללא שינוי' אינו נרשם בפנים, ולכן הדגל לא אמור לבלוע אותו.
  const s = await site();
  await batch([{ kind: "state", status: "ready", occurred_at: iso() }]);
  const rows = await drops(s.code);
  assert.deepEqual(rows.map((r) => r.reason), ["state_no_change"], JSON.stringify(rows));
  assert.equal(rows[0].n, 1);
});

test("הודעה תקינה אינה נרשמת כדחייה", { skip }, async () => {
  const s = await site();
  await batch([{ kind: "state", status: "error", occurred_at: iso() }]);
  assert.deepEqual(await drops(s.code), []);
});
