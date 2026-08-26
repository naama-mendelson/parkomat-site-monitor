// tests/excluded-not-counted.test.js — מה שסומן כניסוי אינו נספר, בשום צ'יפ.
//
// ============================================================
// ⚠️ מונה שסופר בדיוק את מה שהמדד שלידו מחריג
// ============================================================
// `excluded_at` הוא הצהרה של אדם: "הקפצנו את הדלת כדי לבדוק". כל המדדים
// מדלגים עליו — statsFromData, uptimeFromData, opsOf — והצ'יפים ביומן לא.
//
// נמדד על שבוע אמיתי: הכרטיסים סיכמו **44** תקלות והצ'יפ הראה **47**,
// וההפרש היה בדיוק שלוש שורות שמישהו סימן כניסוי (הנוטרים 7, סוקולוב 10,
// אוסישקין 58). אחרי התיקון: 44 מול 44, ו-715 מול 715 בפעולות.
//
// ⚠️ וזה **אותו באג** שתוקן לתקלה-בזמן-תחזוקה, על שדה אחר. תוקן שם ונשאר
// כאן — שני שדות, אותה מחלקה, ורק אחד מהם טופל.
//
// ⚠️ הן עדיין נראות: ב"הכל" ובמסנן 'ניסויים', שהוא הדרך היחידה לבדוק את
// עצמנו. בלעדיו אין מסך שמראה מה הוצא מהסטטיסטיקה, וסימון שגוי נשאר
// בלתי נראה לנצח. "לא נספרת" ו"לא קרתה" הם שני דברים שונים.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildActivityLog } = require("../../shared/timeline.mjs");

const T = (h, m = 0) => new Date(Date.UTC(2026, 7, 20, h, m, 0)).toISOString();
const seg = (status, h, m, extra = {}) => ({
  id: h * 100 + m, site_id: 1, status, started_at: T(h, m), ended_at: T(h, m + 5),
  reclassified_to: null, excluded_at: null, fault_text: null, ...extra,
});
const op = (h, m, extra = {}) => ({
  id: 9000 + h * 100 + m, site_id: 1, occurred_at: T(h, m), start_end: "end",
  entry_exit: "entry", card_number: "4", is_anomaly: 0, superseded_by: null,
  state: "operating", excluded_at: null, ...extra,
});

const countOf = (filter, args) =>
  buildActivityLog({ ops: [], states: [], maint: [], suppressed: [], limit: 200, filter, ...args }).total;


test("⚠️ תקלה שסומנה כניסוי אינה נספרת בצ'יפ 'תקלות'", () => {
  const states = [seg("error", 9, 0), seg("error", 10, 0, { excluded_at: T(12) })];
  assert.equal(countOf("error", { states }), 1, "הניסוי נספר ככשל");

  // ⚠️ אבל היא נמצאת — אחרת סימון שגוי בלתי נראה לנצח.
  assert.equal(countOf("test", { states }), 1);
  const all = buildActivityLog({ ops: [], states, maint: [], suppressed: [], limit: 200, filter: "all" });
  assert.equal(all.entries.filter((e) => e.status === "error").length, 2, "הניסוי נעלם מ'הכל'");
});


test("⚠️ פעולה שסומנה כניסוי אינה נספרת בצ'יפ 'פעולות'", () => {
  const ops = [op(9, 0), op(10, 0, { excluded_at: T(12) })];
  assert.equal(countOf("operation", { ops }), 1, "הניסוי נספר כפעולה");
  assert.equal(countOf("test", { ops }), 1);
});


test("⚠️ ותחזוקה שסומנה כניסוי — גם היא", () => {
  const states = [seg("maintenance", 9, 0), seg("maintenance", 10, 0, { excluded_at: T(12) })];
  assert.equal(countOf("maintenance", { states }), 1, "הניסוי נספר כתחזוקה");
});


test("בלי סימון — שום דבר לא השתנה", () => {
  // ⚠️ התיקון לא אמור להוריד ולו שורה אחת ממי שלא סומן. רוב מוחלט של
  // הנתונים אינו מסומן, ורגרסיה כאן הייתה שקטה לגמרי.
  const states = [seg("error", 9, 0), seg("error", 10, 0), seg("maintenance", 11, 0)];
  const ops = [op(8, 0), op(8, 30)];
  assert.equal(countOf("error", { states, ops }), 2);
  assert.equal(countOf("operation", { states, ops }), 2);
  assert.equal(countOf("maintenance", { states, ops }), 1);
  assert.equal(countOf("test", { states, ops }), 0);
});
