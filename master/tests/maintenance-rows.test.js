// tests/maintenance-rows.test.js — "תחזוקות פעילות" במסך המפקח: שורה אחת לכל אתר
// (dashboard/src/utils/maintenanceRows.js).
//
// ⚠️ נמדד בייצור (05/10/2026): ל-1311 שני חלונות פעילים, והרשימה הציגה אותו
// פעמיים — עם מפתח React כפול ושני כפתורי "בטל" לפעולה אחת.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { oneRowPerSite } from "../../dashboard/src/utils/maintenanceRows.js";

const w = (code, startedAt, expiresAt, over = {}) => ({
  siteCode: code, siteName: `אתר ${code}`, setBy: "a@parkomat.co.il", reason: null,
  startedAt, expiresAt, ...over,
});

// הנתונים מהייצור, כפי ש-supervisorDirect מחזיר אותם (ממוינים לפי expires_at).
const PROD_1311 = [
  w("1311", "2026-09-16T06:51:38.664Z", "2026-10-15T10:51:38.664Z", { reason: "שני" }),
  w("1311", "2026-09-16T06:51:13.546Z", "2026-10-16T06:51:13.546Z", { reason: "ראשון" }),
];

test("שני חלונות לאותו אתר → שורה אחת", () => {
  const rows = oneRowPerSite(PROD_1311);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].windows, 2);
});

test("התפוגה היא המאוחרת — הרגע שבו האתר באמת יוצא מתחזוקה", () => {
  // ⚠️ מוטציה שלוקחת את הראשון ברשימה הייתה מחזירה 15/10 — יום מוקדם מדי.
  assert.equal(oneRowPerSite(PROD_1311)[0].expiresAt, "2026-10-16T06:51:13.546Z");
  // ובסדר ההפוך — כדי שהכלל לא יעבור רק בזכות סדר הקלט
  assert.equal(oneRowPerSite([...PROD_1311].reverse())[0].expiresAt, "2026-10-16T06:51:13.546Z");
});

test("הפתיחה היא המוקדמת, והסיבה ומי הפעיל — מהחלון שפג אחרון", () => {
  const [r] = oneRowPerSite(PROD_1311);
  assert.equal(r.startedAt, "2026-09-16T06:51:13.546Z");
  assert.equal(r.reason, "ראשון");
});

test("הארכה: החלון שפג אחרון נפתח מאוחר יותר — הפתיחה עדיין המוקדמת", () => {
  // ⚠️ ב-1311 החלון שפג אחרון הוא גם זה שנפתח ראשון, ולכן "הפתיחה של החלון
  // המאוחר" עברה שם בירוק במוטציה. כאן שני הכללים נפרדים.
  const [r] = oneRowPerSite([
    w("1311", "2026-10-01T00:00:00.000Z", "2026-10-05T00:00:00.000Z", { reason: "מקורי" }),
    w("1311", "2026-10-03T00:00:00.000Z", "2026-10-10T00:00:00.000Z", { reason: "הארכה" }),
  ]);
  assert.equal(r.startedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(r.expiresAt, "2026-10-10T00:00:00.000Z");
  assert.equal(r.reason, "הארכה");
});

test("שלושה חלונות נספרים כשלושה", () => {
  const three = [...PROD_1311, w("1311", "2026-09-17T00:00:00.000Z", "2026-10-01T00:00:00.000Z")];
  const [r] = oneRowPerSite(three);
  assert.equal(r.windows, 3);
  assert.equal(r.expiresAt, "2026-10-16T06:51:13.546Z");
  assert.equal(r.startedAt, "2026-09-16T06:51:13.546Z");
});

test("אתרים שונים אינם מתאחדים, והסדר — הקרוב לפוג ראשון", () => {
  const rows = oneRowPerSite([
    ...PROD_1311,
    w("2438", "2026-10-05T08:00:00.000Z", "2026-10-05T12:00:00.000Z"),
  ]);
  assert.deepEqual(rows.map((r) => r.siteCode), ["2438", "1311"]);
  assert.deepEqual(rows.map((r) => r.windows), [1, 2]);
});

test("אתר עם חלון אחד — ללא שינוי מלבד windows=1", () => {
  const one = w("2438", "2026-10-05T08:00:00.000Z", "2026-10-05T12:00:00.000Z");
  assert.deepEqual(oneRowPerSite([one]), [{ ...one, windows: 1 }]);
});

test("ריק / null — רשימה ריקה, לא קריסה", () => {
  assert.deepEqual(oneRowPerSite([]), []);
  assert.deepEqual(oneRowPerSite(null), []);
  assert.deepEqual(oneRowPerSite(undefined), []);
});

test("שני חלונות בלי קוד אתר (אתר שנמחק) אינם מתאחדים זה לזה", () => {
  const rows = oneRowPerSite([
    w(null, "2026-10-01T00:00:00.000Z", "2026-10-10T00:00:00.000Z"),
    w(null, "2026-10-02T00:00:00.000Z", "2026-10-11T00:00:00.000Z"),
  ]);
  assert.equal(rows.length, 2);
});

test("המסך משתמש באיחוד — ולא ב-data.activeMaintenances ישירות", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, "..", "..", "dashboard", "src", "views", "SupervisorView", "SupervisorView.jsx"), "utf8");
  assert.match(src, /oneRowPerSite\(data\?\.activeMaintenances\)/);
  assert.doesNotMatch(src, /data\.activeMaintenances\.map/);
  assert.doesNotMatch(src, /data\.activeMaintenances\.length/);
});
