// tests/site-inactive.test.js — "לא פעיל" (22/10/2026): public.site_inactive_set ואיך הלוח מסדר.
//
// בקשה מהשטח שהבעלת העבירה: אתרים שלא פעילים ומופיעים כ"תקלה" או "תחזוקה" — לסוף הרשימה, תחת הכותרת "לא פעיל".
// בחירות הבעלת: רק המיקום בלוח (המצב, האריחים, הצלצול והסטטיסטיקה — כרגיל); עורך או מנהל, מהכרטיס.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
const MGR = "e7000000-0000-0000-0000-000000000001";
const ED = "e7000000-0000-0000-0000-000000000002";
const RO = "e7000000-0000-0000-0000-000000000003";

let h;
const sup = async (sql, params = []) => (await h.pg.query(sql, params)).rows;
const one = async (uid, sql, params = []) => (await h.as("authenticated", uid, (tx) => tx.query(sql, params))).rows[0];
const set = (uid, code, inactive, reason = null) =>
  one(uid, `SELECT public.site_inactive_set($1, $2, $3) r`, [code, inactive, reason]).then((x) => x.r);
const row = async (code) => (await sup(`SELECT status, inactive_at, inactive_by, inactive_reason FROM sites WHERE code = $1`, [code]))[0];
const audits = async (code) => (await sup(`SELECT action, details FROM audit_log WHERE action = 'site.inactive' AND target_id = $1 ORDER BY id`, [code]))
  .map((x) => [x.action, x.details?.inactive]);
const events = async (code) => (await sup(`SELECT type, payload FROM events WHERE site_code = $1 AND type = 'site_inactive' ORDER BY id`, [code]))
  .map((x) => x.payload);
async function fails(p, code, re) {
  await assert.rejects(p, (e) => {
    if (code) assert.equal(e.code, code, `ציפיתי ל-${code}, התקבל ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
}

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
      ('ia-mgr@parkomat.co.il','מנהלת','manager',true,$1,$4),
      ('ia-ed@parkomat.co.il','דנה עורכת','editor',true,$2,$4),
      ('ia-ro@parkomat.co.il','בקר','operator',true,$3,$4)`, [MGR, ED, RO, now]);
  await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES
      ('IA1','ברנדייס 13, ת"א','maintenance',$1), ('IA2','הזורע 2, רמת השרון','error',$1), ('IA3','אחר','ready',$1)`, [now]);
});
after(async () => { if (h) await h.close(); });

test("סימון: עורך מסמן עם סיבה — מתי, מי (השם המאומת) ולמה; המצב לא משתנה; audit ואירוע", { skip }, async () => {
  const r = await set(ED, " IA1 ", true, "  בשיפוץ \n עד   סוף החודש ");
  assert.deepEqual(r, { changed: true, inactive: true });
  const s = await row("IA1");
  assert.equal(s.status, "maintenance", "המצב לא משתנה — רק המיקום בלוח");
  assert.ok(Math.abs(Date.parse(s.inactive_at) - Date.now()) < 60_000 && /T\d\d:\d\d:\d\d\.\d{3}Z$/.test(s.inactive_at), s.inactive_at);
  assert.equal(s.inactive_reason, "בשיפוץ עד סוף החודש", "רווחים ושורות מתכווצים");
  assert.equal(s.inactive_by, "דנה עורכת", "השם מהזהות, לא מהבקשה");
  assert.deepEqual(await audits("IA1"), [["site.inactive", true]]);
  const ev = await events("IA1");
  assert.deepEqual(ev, [{ type: "site_inactive", code: "IA1", inactive: true }], "הסוג והקוד בתוך ה-payload — זה מה שהדשבורד מקבל");
  const audit = (await sup(`SELECT details FROM audit_log WHERE action = 'site.inactive' AND target_id = 'IA1'`))[0].details;
  assert.ok(!JSON.stringify(audit).includes("שיפוץ"), "ב-audit בלי הסיבה (טקסט חופשי)");
});

test("עדכון: אותו מצב ואותה סיבה — כלום; סיבה אחרת — רק הסיבה (מתי ומי נשארים); החזרה — הכול מתנקה; החזרה שוב — כלום", { skip }, async () => {
  const before = await row("IA1");
  assert.deepEqual(await set(MGR, "IA1", true, "בשיפוץ עד סוף החודש"), { changed: false, inactive: true });
  assert.equal((await audits("IA1")).length, 1, "בלי audit על כלום");
  assert.deepEqual(await set(MGR, "IA1", true, "מושבת עד הודעה חדשה"), { changed: true, inactive: true });
  const s = await row("IA1");
  assert.deepEqual([s.inactive_reason, s.inactive_at, s.inactive_by], ["מושבת עד הודעה חדשה", before.inactive_at, before.inactive_by]);
  assert.deepEqual(await set(MGR, "IA1", true, "   "), { changed: true, inactive: true }, "סיבה ריקה — מוחקת את הסיבה");
  assert.equal((await row("IA1")).inactive_reason, null);
  assert.deepEqual(await set(ED, "IA1", false, "מתעלם מהסיבה"), { changed: true, inactive: false });
  assert.deepEqual(await row("IA1"), { status: "maintenance", inactive_at: null, inactive_by: null, inactive_reason: null });
  assert.deepEqual(await set(ED, "IA1", false), { changed: false, inactive: false });
  assert.deepEqual((await audits("IA1")).map((x) => x[1]), [true, true, true, false]);
  assert.deepEqual((await events("IA1")).map((x) => x.inactive), [true, true, true, false]);
  // בלי סיבה בכלל
  assert.deepEqual(await set(ED, "IA2", true), { changed: true, inactive: true });
  assert.equal((await row("IA2")).inactive_reason, null);
  // 200 תווים לכל היותר
  await set(ED, "IA3", true, "א".repeat(260));
  assert.equal((await row("IA3")).inactive_reason.length, 200);
  await set(ED, "IA3", false);
});

test("הרשאות: בקר — לא; אנונימי — לא; אתר שלא קיים — PT404; בלי הבחירה — 22023", { skip }, async () => {
  await fails(set(RO, "IA3", true), "42501", /בקר יכול רק לצפות/);
  assert.equal((await row("IA3")).inactive_at, null);
  await fails(h.as("anon", null, (tx) => tx.query(`SELECT public.site_inactive_set('IA3', true, NULL)`)), "42501");
  await fails(set(ED, "NOPE", true), "PT404");
  await fails(set(ED, "IA3", null), "22023");
});

test("החלה חוזרת של הקבצים לא מוחקת סימון קיים", { skip }, async () => {
  await set(ED, "IA3", true, "שיפוץ");
  for (const f of ["schema.postgres.sql", "writes.postgres.sql"]) {
    await h.pg.exec(fs.readFileSync(path.join(__dirname, "..", "db", f), "utf8"));
  }
  const s = await row("IA3");
  assert.equal(s.inactive_reason, "שיפוץ");
  assert.ok(s.inactive_at);
  await set(ED, "IA3", false);
});
