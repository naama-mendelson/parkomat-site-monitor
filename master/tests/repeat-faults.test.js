// tests/repeat-faults.test.js — תקלה חוזרת (18/10/2026), על Postgres מקומי (PGlite).
//
// בעלת המוצר: "אם ישנה שורת תקלה שחוזרת מעל 3 פעמים באותו אתר (בחודש נניח) — שיתריע לנו… אם אפשר להחריג למשל
// דלתות פתוחות או חירום". נבדק: אותו טקסט בנוסחים שונים הוא אותה תקלה; 3 אינו "מעל 3"; ההחרגות; בלי טקסט; תקלה
// בזמן תחזוקה; גבול 30 הימים; הסדר; ושה-cron שומר בדיוק את מה ש-app.repeat_faults מחזירה.
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
const DAY = 86400e3, HOUR = 3600e3;
const iso = (t) => new Date(t).toISOString();

const S = {};
async function site(code) {
  S[code] = (await q(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready',$2) RETURNING id`,
    [code, iso(Date.now() - 90 * DAY)]))[0].id;
}
// מקטע תקלה של 10 דקות ואחריו שעתיים "מוכן" — כך שאין קיפול ריצוד בין שתי תקלות
let slot = 0;
async function fault(code, text, { daysAgo = null } = {}) {
  const at = daysAgo != null ? Date.now() - daysAgo * DAY : Date.now() - 20 * DAY + (slot++) * 3 * HOUR;
  await q(`INSERT INTO status_history (site_id, status, started_at, ended_at, fault_text) VALUES ($1,'error',$2,$3,$4)`,
    [S[code], iso(at), iso(at + 10 * 60e3), text]);
  await q(`INSERT INTO status_history (site_id, status, started_at, ended_at) VALUES ($1,'ready',$2,$3)`,
    [S[code], iso(at + 10 * 60e3), iso(at + 2 * HOUR)]);
  return at;
}
const window30 = () => [iso(Date.now() - 30 * DAY), iso(Date.now())];
const rf = async (code) => {
  const [from, to] = window30();
  return (await q(`SELECT faults FROM app.repeat_faults($1, $2) WHERE site_id = $3`, [from, to, S[code]]))[0]?.faults ?? null;
};

test("המפתח: רווחים, שורה חדשה ונקודתיים בסוף — אותה תקלה; ריק — אין מפתח", { skip }, async () => {
  const key = async (t) => (await q(`SELECT app.fault_text_key($1) AS k`, [t]))[0].k;
  assert.equal(await key("מעלית - זמן מקסימלי להרמת גג:"), "מעלית - זמן מקסימלי להרמת גג");
  assert.equal(await key("  מעלית -  זמן מקסימלי\tלהרמת גג \n"), "מעלית - זמן מקסימלי להרמת גג");
  assert.equal(await key("מעלית - זמן מקסימלי להרמת גג : "), "מעלית - זמן מקסימלי להרמת גג");
  assert.equal(await key(""), null);
  assert.equal(await key("  \n "), null);
  assert.equal(await key(null), null);
  const ex = async (t) => (await q(`SELECT app.repeat_fault_excluded(app.fault_text_key($1)) AS x`, [t]))[0].x;
  for (const t of ["מנהל חניון - דלתות חניון פתוחות:", "מנהל דולים - דלתות חניון פתוחות:", "- דלתות חניון פתוחות:",
                   "- חירום נלחץ בהמתנה:", "- חירום נלחץ:", null, ""]) assert.equal(await ex(t), true, String(t));
  for (const t of ["מעלית - זמן מקסימלי להרמת גג", "שאטל - לא זוהתה תזוזה", "אין תקשורת עם הבקר"]) assert.equal(await ex(t), false, t);
});

test("מעל 3 באותו אתר — מסומן; 3 — לא; החרגות ובלי טקסט — לא נספרים", { skip }, async () => {
  await site("RFA");
  // אותה תקלה בארבעה נוסחים → 4
  await fault("RFA", "מעלית - זמן מקסימלי להרמת גג:");
  await fault("RFA", "מעלית - זמן מקסימלי להרמת גג:");
  await fault("RFA", "מעלית - זמן מקסימלי להרמת גג");
  await fault("RFA", "מעלית -  זמן מקסימלי להרמת גג\n");
  for (let i = 0; i < 3; i++) await fault("RFA", "שאטל - לא זוהתה תזוזה");               // 3 — אינו "מעל 3"
  for (let i = 0; i < 5; i++) await fault("RFA", "מנהל חניון - דלתות חניון פתוחות:");     // מוחרג
  for (let i = 0; i < 5; i++) await fault("RFA", "- חירום נלחץ בהמתנה:");                // מוחרג
  for (let i = 0; i < 6; i++) await fault("RFA", null);                                  // בלי טקסט
  const f = await rf("RFA");
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].text, "מעלית - זמן מקסימלי להרמת גג");
  assert.equal(f[0].n, 4);
  assert.ok(f[0].last_at > iso(Date.now() - 30 * DAY));
});

test("רק 30 הימים האחרונים, ובלי תקלות בזמן תחזוקה", { skip }, async () => {
  await site("RFB");
  // ארבע, אחת מהן לפני 40 יום → 3 בחלון
  await fault("RFB", "דולי - X", { daysAgo: 40 });
  for (let i = 0; i < 3; i++) await fault("RFB", "דולי - X");
  // ארבע, אחת מהן בתוך חלון תחזוקה → 3 נספרות
  const at = await fault("RFB", "דולי - Y");
  await q(`INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at) VALUES ($1,'t',$2,1,$3)`,
    [S.RFB, iso(at - 60e3), iso(at + HOUR)]);
  for (let i = 0; i < 3; i++) await fault("RFB", "דולי - Y");
  assert.equal(await rf("RFB"), null);
  // ועוד אחת מכל אחת — עכשיו 4 בחלון ובלי תחזוקה
  await fault("RFB", "דולי - X");
  await fault("RFB", "דולי - Y");
  const f = await rf("RFB");
  assert.deepEqual(f.map((x) => [x.text, x.n]).sort(), [["דולי - X", 4], ["דולי - Y", 4]]);
});

test("כמה תקלות חוזרות באתר — הגבוהה ראשונה; אתר אחר אינו מתערבב", { skip }, async () => {
  await site("RFC");
  for (let i = 0; i < 4; i++) await fault("RFC", "מיטה - W");
  for (let i = 0; i < 6; i++) await fault("RFC", "מיטה - Z");
  await site("RFD");
  for (let i = 0; i < 2; i++) await fault("RFD", "מיטה - Z");   // 2 באתר אחר — לא מצטרפות ל-RFC
  const f = await rf("RFC");
  assert.deepEqual(f.map((x) => [x.text, x.n]), [["מיטה - Z", 6], ["מיטה - W", 4]]);
  assert.equal(await rf("RFD"), null);
});

test("⚠️ שני אתרים עם תקלה באותה שנייה בדיוק — כל אחד מקבל את הטקסט שלו", { skip }, async () => {
  // הטקסט נשלף משורת ההיסטוריה שבה המקטע מתחיל. בלי `h.site_id = es.site_id` השליפה לוקחת את השורה הראשונה באותה שנייה
  // מכל אתר שהוא. 84 אתרים וחותמות זמן בשניות — זה קורה. (מוטציה שהסירה את התנאי שרדה, 19/10/2026)
  await site("RFS1");
  await site("RFS2");
  for (let i = 0; i < 4; i++) {
    const at = Date.now() - 10 * DAY + i * 3 * HOUR;
    for (const [code, text] of [["RFS1", "מעלית - A"], ["RFS2", "שאטל - B"]]) {
      await q(`INSERT INTO status_history (site_id, status, started_at, ended_at, fault_text) VALUES ($1,'error',$2,$3,$4)`,
        [S[code], iso(at), iso(at + 10 * 60e3), text]);
      await q(`INSERT INTO status_history (site_id, status, started_at, ended_at) VALUES ($1,'ready',$2,$3)`,
        [S[code], iso(at + 10 * 60e3), iso(at + 2 * HOUR)]);
    }
  }
  assert.deepEqual((await rf("RFS1")).map((x) => [x.text, x.n]), [["מעלית - A", 4]]);
  assert.deepEqual((await rf("RFS2")).map((x) => [x.text, x.n]), [["שאטל - B", 4]]);
});

test("⚠️ ה-cron שומר בדיוק את מה ש-app.repeat_faults מחזירה; אתר בלי — NULL", { skip }, async () => {
  // RFE: שלוש תקלות בחלון ורביעית בגיל 35 יום — מחוץ ל-30, בתוך 40. בודק את החלון של ה-cron עצמו (rf_from), שהבדיקות
  // האחרות עוקפות כשהן קוראות ל-app.repeat_faults ישירות. התקלה של RFB בגיל 40 יום בדיוק לא הבחינה בין 30 ל-40.
  await site("RFE");
  await fault("RFE", "מיטה - Q", { daysAgo: 35 });
  for (let i = 0; i < 3; i++) await fault("RFE", "מיטה - Q");
  assert.equal(await rf("RFE"), null);
  await q(`SELECT app.refresh_site_card_metrics()`);
  for (const code of ["RFA", "RFB", "RFC", "RFD", "RFE", "RFS1", "RFS2"]) {
    const [row] = await q(`SELECT repeat_faults::text AS j FROM site_card_metrics WHERE site_id = $1`, [S[code]]);
    const want = await rf(code);
    if (want == null) assert.equal(row.j, null, code);
    else assert.deepEqual(JSON.parse(row.j).map((x) => [x.text, x.n]), want.map((x) => [x.text, x.n]), code);
  }
});

test("החלה חוזרת של הקובץ — בלי שגיאה, והעמודה נשארת", { skip }, async () => {
  await h.pg.exec(fs.readFileSync(path.join(__dirname, "../db/card-metrics.postgres.sql"), "utf8"));
  const [c] = await q(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'site_card_metrics' AND column_name = 'repeat_faults'`);
  assert.equal(c.n, 1);
});
