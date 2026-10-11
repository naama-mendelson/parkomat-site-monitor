// tests/inspection-previous.test.js — "התסקיר הקודם" בעמוד הבודק: הניסוח בלבד (11/10/2026).
//
// בעלת המוצר: "כאשר מעלים דוח חדש, גם אם התקלות הקודמות לא טופלו — יש להתעלם מהתקלות הקודמות
// ולהתמקד רק במסמך החדש, אך יראו מה היה המצב של המסמך הקודם: שהתקלות לא טופלו או טופלו אחרי
// הזמן. וכן האם הדוח החדש עלה באיחור". הספירות עצמן מה-SQL (compliance.test.js, בדיקה 50);
// כאן — שהמסך אומר אותן נכון: יחיד/רבים, מה נצבע, ו"ביום המועד" = בזמן.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../dashboard/src/components/Compliance/InspectionUtils.js");

// InspectionUtils מייבא בלי סיומת (Vite) — Node צריך כתובת מלאה
async function load() {
  const abs = (rel) => pathToFileURL(path.resolve(path.dirname(SRC), rel)).href;
  const src = fs.readFileSync(SRC, "utf8")
    .replace(`from "../../utils/compliance";`, `from ${JSON.stringify(abs("../../utils/compliance.js"))};`);
  assert.doesNotMatch(src, /from "\.{1,2}\//, "נשאר ייבוא יחסי — InspectionUtils קיבל ייבוא חדש");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "insp-utils-")), "InspectionUtils.mjs");
  fs.writeFileSync(tmp, src);
  return import(pathToFileURL(tmp).href);
}

test("outcomeParts — יחיד/רבים, הסדר, ומה נצבע", async () => {
  const { outcomeParts } = await load();
  assert.deepEqual(outcomeParts(null), []);
  assert.deepEqual(outcomeParts({ total: 0, not_handled: 0, open: 0, done_late: 0, done_on_time: 0 }),
    [{ text: "ללא ליקויים" }]);
  assert.deepEqual(outcomeParts({ total: 4, not_handled: 1, open: 0, done_late: 1, done_on_time: 2 }), [
    { late: true, text: "ליקוי אחד לא טופל" },
    { late: true, text: "ליקוי אחד טופל אחרי המועד" },
    { text: "2 ליקויים טופלו בזמן" },
  ]);
  assert.deepEqual(outcomeParts({ total: 5, not_handled: 3, open: 0, done_late: 2, done_on_time: 0 }).map((p) => p.text),
    ["3 ליקויים לא טופלו", "2 ליקויים טופלו אחרי המועד"]);
  // מחזור שלא הוחלף (מתקן אחר באתר) — "עדיין פתוח", לא "לא טופל", ולא נצבע
  assert.deepEqual(outcomeParts({ total: 1, not_handled: 0, open: 1, done_late: 0, done_on_time: 0 }),
    [{ text: "ליקוי אחד עדיין פתוח" }]);
});

test("gapPart — אחרי שפג נצבע; בתאריך התוקף ולפניו — 'לפני שפג'", async () => {
  const { gapPart } = await load();
  assert.equal(gapPart(null), null);
  assert.equal(gapPart(undefined), null);
  assert.deepEqual(gapPart(0), { late: false, text: "לפני שהתסקיר הקודם פג" });
  assert.deepEqual(gapPart(-15), { late: false, text: "לפני שהתסקיר הקודם פג" });
  assert.deepEqual(gapPart(1), { late: true, text: "יום אחד אחרי שהתסקיר הקודם פג" });
  assert.deepEqual(gapPart(15), { late: true, text: "15 ימים אחרי שהתסקיר הקודם פג" });
});

test("previousOf — הסיכום נלקח מהתסקיר הקודם עצמו, לא מהנוכחי", async () => {
  const { previousOf } = await load();
  const prevReport = { id: 7, outcome: { total: 2, not_handled: 1, open: 0, done_late: 0, done_on_time: 1 } };
  const current = { id: 9, outcome: { total: 0 }, prev: { id: 7, inspected_on: "2025-03-12", valid_until: "2026-03-12", gap_days: 20 } };
  const byId = new Map([[7, prevReport], [9, current]]);
  assert.deepEqual(previousOf(current, byId), {
    inspectedOn: "2025-03-12", outcome: prevReport.outcome, gap: { late: true, text: "20 ימים אחרי שהתסקיר הקודם פג" },
  });
  assert.equal(previousOf({ id: 1, prev: null }, byId), null, "תסקיר ראשון — אין שורה");
  assert.equal(previousOf(null, byId), null);
  // הקודם נמחק / אינו בתשובה — עדיין אומרים מתי, בלי לנחש מה היה בו
  assert.equal(previousOf({ prev: { id: 99, inspected_on: "2025-01-01", gap_days: -3 } }, byId).outcome, null);
});

test("lateText — אחרי המועד בלבד; ביום המועד עצמו אין טקסט", async () => {
  const { lateText } = await load();
  assert.equal(lateText(null), null);
  assert.equal(lateText(0), null);
  assert.equal(lateText(1), "יום אחד אחרי המועד");
  assert.equal(lateText(370), "370 ימים אחרי המועד");
});
