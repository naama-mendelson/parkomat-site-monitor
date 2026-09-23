// tests/report-consistency.test.js — שלוש פונקציות הדוח מסכימות זו עם זו.
//
// ============================================================
// מה נמצא בסקירה (23/09/2026)
// ============================================================
// report_monthly, report_by_site ו-report_site_months מוצגות **באותו מסך**,
// וההערה ב-MonthlyReport.jsx מבטיחה שהן מסתכמות זו לזו. הן לא הסתכמו:
//
//   • אף אחת לא סיננה `excluded_at` — פעולה או תקלה שסומנו "ניסוי" נעלמו
//     מהדשבורד ונשארו בדוח (וב-CSV). כל מדד אחר בקובץ מסנן אותן.
//   • רק report_by_site החריגה פעולות בתוך חלון תחזוקה ידני (app.op_served).
//   • report_by_site ספרה תקלה שחופפת לטווח; השתיים האחרות — תקלה שהתחילה
//     בו. תקלה מ-31.8 נספרה פעם אחת בטבלה לפי אתר ואפס פעמים בחודשית.
//   • החודש נחתך לפי UTC (`substr(occurred_at,1,7)`), בעוד הדשבורד שולח
//     גבולות של חצות **בישראל**: פעולה ב-01:30 ב-1.9 נספרה באוגוסט, ודוח
//     מ-1.1 קיבל שורת דצמבר מזויפת על שעתיים ראשונות.
//
// רץ מול PGlite עם db.init האמיתי — לא מול הייצור.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
let h, A, B;

// גבולות כמו שהדשבורד שולח: חצות בישראל (UTC+3 בקיץ) = 21:00Z יום קודם.
const FROM = "2026-08-31T21:00:00.000Z";   // 1.9 00:00 שעון ישראל
const TO   = "2026-09-30T21:00:00.000Z";   // 1.10 00:00 שעון ישראל

async function site(code) {
  const { rows } = await h.pg.query(
    `INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready','2026-01-01T00:00:00.000Z') RETURNING id`, [code]);
  return rows[0].id;
}
const op = (id, at, excluded = null) => h.pg.query(
  `INSERT INTO operations (site_id, start_end, entry_exit, state, occurred_at, received_at, excluded_at)
   VALUES ($1,'end','entry','ready',$2,$2,$3)`, [id, at, excluded]);
const hist = (id, st, s, e, excluded = null) => h.pg.query(
  `INSERT INTO status_history (site_id, status, started_at, ended_at, excluded_at) VALUES ($1,$2,$3,$4,$5)`,
  [id, st, s, e, excluded]);
const win = (id, s, hours, excluded = null) => h.pg.query(
  `INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at, excluded_at)
   VALUES ($1,'בדיקה',$2,$3,$4,$5)`,
  [id, s, hours, new Date(Date.parse(s) + hours * 3600e3).toISOString(), excluded]);

const q = async (fn) => (await h.pg.query(`SELECT * FROM public.${fn}(NULL, $1, $2)`, [FROM, TO])).rows;

before(async () => {
  if (skip) return;
  h = await local.boot();
  A = await site("9001");
  B = await site("9002");

  // A — פעולות רגילות
  await op(A, "2026-09-05T10:00:00.000Z");
  await op(A, "2026-09-06T10:00:00.000Z");
  // ⚠️ 01:30 ב-1.9 בשעון ישראל = 22:30Z ב-31.8. שייכת לספטמבר.
  await op(A, "2026-08-31T22:30:00.000Z");
  // פעולה שסומנה ניסוי — לא נספרת בשום טבלה
  await op(A, "2026-09-07T10:00:00.000Z", "2026-09-07T11:00:00.000Z");
  // פעולה בתוך חלון תחזוקה ידני — לא נספרת בשום טבלה
  await win(A, "2026-09-10T08:00:00.000Z", 4);
  await op(A, "2026-09-10T09:00:00.000Z");

  // B — תקלות
  await hist(B, "error", "2026-09-12T08:00:00.000Z", "2026-09-12T10:00:00.000Z");            // נספרת
  await hist(B, "error", "2026-09-13T08:00:00.000Z", "2026-09-13T09:00:00.000Z",
             "2026-09-13T12:00:00.000Z");                                                     // ניסוי
  // ⚠️ התחילה לפני הטווח ונמשכת לתוכו: לא נספרת כתקלה, אבל שעותיה בטווח כן.
  await hist(B, "error", "2026-08-31T19:00:00.000Z", "2026-08-31T23:00:00.000Z");
  // ⚠️ חלון תחזוקה שסומן ניסוי אינו "תחזוקה גוברת" — התקלה תחתיו נספרת.
  await win(B, "2026-09-20T08:00:00.000Z", 4, "2026-09-20T13:00:00.000Z");
  await hist(B, "error", "2026-09-20T09:00:00.000Z", "2026-09-20T09:30:00.000Z");
  await op(B, "2026-09-20T10:00:00.000Z");
});

after(async () => { if (h) await h.close?.(); });

test("החודש נחתך לפי שעון ישראל — אין שורת אוגוסט בדוח שמתחיל ב-1.9", { skip }, async () => {
  const months = (await q("report_monthly")).map((r) => r.year_month);
  assert.deepEqual(months, ["2026-09"]);
  const sm = (await q("report_site_months")).map((r) => r.year_month);
  assert.ok(sm.every((m) => m === "2026-09"), JSON.stringify(sm));
});

test("⚠️ פעולות: ניסוי וחלון ידני מוחרגים, בשלוש הטבלאות", { skip }, async () => {
  const bySite = await q("report_by_site");
  const a = bySite.find((r) => r.code === "9001");
  assert.equal(a.operations, 3);
  const sm = (await q("report_site_months")).filter((r) => r.code === "9001");
  assert.equal(sm.reduce((t, r) => t + r.operations, 0), 3);
});

test("⚠️ תקלות: ניסוי מוחרג, תקלה מלפני הטווח לא נספרת אבל שעותיה כן", { skip }, async () => {
  const b = (await q("report_by_site")).find((r) => r.code === "9002");
  assert.equal(b.errors, 2, "12.9 + 20.9 (החלון שמעליה סומן ניסוי)");
  // 2 (12.9) + 0.5 (20.9) + 2 (21:00Z–23:00Z של 31.8, בתוך הטווח)
  assert.equal(b.error_hours, 4.5);
  const kinds = b.fault_types.reduce((t, k) => t + k.count, 0);
  assert.equal(kinds, b.errors, "הפילוח לפי סוג מסתכם למספר התקלות");
});

test("⚠️ הטבלאות מסתכמות זו לזו", { skip }, async () => {
  const monthly = await q("report_monthly");
  const bySite = await q("report_by_site");
  const sm = await q("report_site_months");
  const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
  assert.equal(sum(monthly, "operations"), sum(bySite, "operations"));
  assert.equal(sum(monthly, "errors"), sum(bySite, "errors"));
  assert.equal(sum(sm, "operations"), sum(bySite, "operations"));
  assert.equal(sum(sm, "errors"), sum(bySite, "errors"));
});
