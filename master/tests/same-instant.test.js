// tests/same-instant.test.js — מעבר MODE אחד = רגע אחד, בשתי הטבלאות.
//
// הרגרסיה: מעבר MODE אחד מייצר שתי הודעות עם אותו חותם בדיוק (state ו-
// operation). השרת עיבד אותן בזו אחר זו ויישר כל אחת מול ה"עכשיו" שלה, ולכן
// הן קיבלו שתי שניות שונות. בלוג זה נראה כך:
//
//     12:54:37   כניסת רכב הושלמה
//     12:54:36   המצב השתנה ל: מוכן     ← שנייה *לפני* הסיום
//
// כלומר האתר חזר להיות מוכן בזמן שהפעולה עוד פתוחה. נמצא ב-19 זוגות אמיתיים.
//
// שלוש שכבות הגנה, כל אחת נבדקת כאן:
//   1. רצפה בכיוון העתיד — סטייה של שנייה-שתיים כלל לא מיושרת.
//   2. זיכרון החלטות — אותו (אתר, חותם מדווח) מקבל תמיד אותו חותם אפקטיבי.
//   3. אימוץ חותם בתצוגה — מנקה גם את מה שנכתב לפני התיקון.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { classifyTimestamp, FUTURE_CLAMP_MIN_SECONDS } = require("../ingestion/plausibility");
const { rememberClamp, recallClamp, resetClampMemo } = require("../ingestion/clamp-memo");

const DB = require.resolve("../db/db");
require.cache[DB] = {
  id: DB, filename: DB, path: path.dirname(DB), loaded: true, children: [], paths: [],
  exports: { prepare: () => ({ get: async () => ({}), all: async () => [], run: async () => ({}) }) },
};
const { buildTimeline } = require("../db/queries");

const NOW = Date.UTC(2026, 6, 26, 9, 54, 37) ;   // 12:54:37 שעון ישראל
const sec = (ms) => Math.floor(ms / 1000);

// ============================================================
// שכבה 1: רצפה בכיוון העתיד
// ============================================================

test("סטייה של שנייה אחת לעתיד — לא מיושרת (זה רעש, לא סחיפה)", () => {
  const v = classifyTimestamp(sec(NOW) + 1, NOW);
  assert.equal(v.action, "accept");
  assert.equal(v.effectiveSec, sec(NOW) + 1, "החותם המקורי נשמר");
});

test("בדיוק על הרצפה — עדיין לא מיושר", () => {
  const v = classifyTimestamp(sec(NOW) + FUTURE_CLAMP_MIN_SECONDS, NOW);
  assert.equal(v.action, "accept");
});

test("שנייה מעל הרצפה — כן מיושר (זו כבר סחיפה)", () => {
  const v = classifyTimestamp(sec(NOW) + FUTURE_CLAMP_MIN_SECONDS + 1, NOW);
  assert.equal(v.action, "clamp");
  assert.equal(v.effectiveSec, sec(NOW));
});

test("סחיפה אמיתית לעתיד (46s) — מיושרת כמו קודם", () => {
  const v = classifyTimestamp(sec(NOW) + 46, NOW);
  assert.equal(v.action, "clamp");
  assert.equal(v.classification, "drift_future");
});

test("חותם רחוק בעתיד — עדיין נדחה (הרצפה לא פתחה דלת)", () => {
  assert.equal(classifyTimestamp(sec(NOW) + 3600, NOW).action, "reject");
});

// ============================================================
// שכבה 2: זיכרון ההחלטות — שתי ההודעות מקבלות אותו חותם
// ============================================================

test("שתי הודעות של אותו מעבר מקבלות אותו חותם אפקטיבי", () => {
  resetClampMemo();
  const reported = sec(NOW) + 46;          // האתר מקדים ב-46 שניות

  // הודעת ה-state מעובדת ראשונה, כשהשרת על T.
  const first = classifyTimestamp(reported, NOW);
  assert.equal(first.action, "clamp");
  const stateTs = rememberClamp(7, reported, first.effectiveSec, NOW);

  // הודעת ה-operation מעובדת שנייה אחר כך — "עכשיו" של השרת התקדם.
  const later = NOW + 1000;
  const second = classifyTimestamp(reported, later);
  assert.equal(second.effectiveSec, sec(later),
    "בלי הזיכרון היא הייתה מקבלת שנייה אחרת — זה בדיוק הבאג");

  const opTs = recallClamp(7, reported, later);
  assert.equal(opTs, stateTs, "הזיכרון החזיר את אותו חותם");
});

test("הזיכרון מופרד לפי אתר", () => {
  resetClampMemo();
  rememberClamp(1, 1000, 111, NOW);
  assert.equal(recallClamp(2, 1000, NOW), null, "אתר אחר לא ירש את ההחלטה");
});

test("הזיכרון מופרד לפי חותם מדווח", () => {
  resetClampMemo();
  rememberClamp(1, 1000, 111, NOW);
  assert.equal(recallClamp(1, 1001, NOW), null);
});

test("החלטה שפג תוקפה נשכחת", () => {
  resetClampMemo();
  rememberClamp(1, 1000, 111, NOW);
  assert.equal(recallClamp(1, 1000, NOW + 6 * 60 * 1000), null);
});

test("גם החלטת accept נזכרת — אחרת השנייה עלולה לחצות את הרצפה ולהיושר", () => {
  resetClampMemo();
  const reported = sec(NOW) + 4;                    // מתחת לרצפה → accept
  const v = classifyTimestamp(reported, NOW);
  assert.equal(v.action, "accept");
  rememberClamp(9, reported, v.effectiveSec, NOW);

  // חמש שניות אחר כך אותו חותם היה נראה *מהעבר*, ובשגרה היה מועמד ליישור.
  assert.equal(recallClamp(9, reported, NOW + 5000), reported);
});

// ============================================================
// שכבה 3: אימוץ חותם בתצוגה — מנקה את ההיסטוריה
// ============================================================

const iso = (s) => new Date(`2026-07-26T${s}Z`).toISOString();
const op = (at, startEnd, entryExit = "entry") => ({
  site_id: undefined, start_end: startEnd, entry_exit: entryExit,
  card_number: "7", is_anomaly: 0, state: "operating", occurred_at: iso(at),
});
const st = (at, status, endedAt = null) => ({
  site_id: undefined, status, started_at: iso(at), ended_at: endedAt ? iso(endedAt) : null,
});
// הציר ה**גולמי**, לא העמוד המסונן: buildActivityLog מסנן (ברירת מחדל "הכל")
// ומסתיר בדיוק את שורות ה-'בפעולה' שהבדיקות כאן באות לאמת — שהחותם אומץ,
// ושהדגל explainedByOp נקבע נכון. ראה buildTimeline ב-db/queries.js.
const build = (ops, states) => ({ entries: buildTimeline({ ops, states, maint: [] }) });

test("הזוג הפגום מ-2438: 'מוכן' ב-36 ו-'הסתיימה' ב-37 — הסדר נהיה אפשרי", () => {
  // בדיוק הנתונים שנמצאו ב-DB.
  const log = build([op("09:54:37", "end")], [st("09:54:36", "ready", "10:29:00")]);

  const ready = log.entries.find((e) => e.kind === "status");
  assert.equal(ready.at, iso("09:54:37"), "שורת המצב אימצה את חותם הפעולה");

  // ומכאן המיון (מהחדש לישן, ואז phaseRank) מציב את 'מוכן' מעל הסיום —
  // קריאה מלמטה למעלה: הפעולה נסגרה, ואז האתר מוכן.
  assert.deepEqual(
    log.entries.map((e) => e.kind === "status" ? `state:${e.status}` : e.startEnd),
    ["state:ready", "end"]);
});

test("פער של שתי שניות (אתרים 1343/2439) — גם הוא מיושר", () => {
  const log = build([op("09:54:39", "end")], [st("09:54:37", "ready")]);
  assert.equal(log.entries.find((e) => e.kind === "status").at, iso("09:54:39"));
});

test("המשך המצב נשאר כפי שהוא — אימצנו זמן, לא שינינו מדידה", () => {
  const log = build([op("09:54:37", "end")], [st("09:54:36", "ready", "10:29:36")]);
  const ready = log.entries.find((e) => e.kind === "status");
  assert.equal(ready.durationSeconds, 35 * 60, "35 דקות מהמקטע הגולמי");
});

test("'בפעולה' מאמץ את חותם ה-start, ונשאר מוסתר", () => {
  const log = build([op("09:50:43", "start")], [st("09:50:42", "operating", "09:54:36")]);
  const s = log.entries.find((e) => e.kind === "status");
  assert.equal(s.at, iso("09:50:43"));
  assert.equal(s.explainedByOp, true);
});

test("מצב בלי פעולה תואמת — החותם שלו לא נוגע", () => {
  const log = build([], [st("20:30:58", "operating")]);
  assert.equal(log.entries[0].at, iso("20:30:58"));
  assert.equal(log.entries[0].explainedByOp, false);
});

test("תקלה לא מאמצת חותם של פעולה שבמקרה חלקה שנייה", () => {
  const log = build([op("09:54:37", "end")], [st("09:54:36", "error")]);
  const e = log.entries.find((x) => x.kind === "status");
  assert.equal(e.at, iso("09:54:36"), "תקלה אינה נובעת ממעבר פעולה");
  assert.equal(e.explainedByOp, false);
});

test("מחזור שלם עם שני הפערים — הסיפור נקרא נכון מלמטה למעלה", () => {
  const log = build(
    [op("09:50:43", "start"), op("09:54:37", "end")],
    [st("09:50:42", "operating", "09:54:36"), st("09:54:36", "ready", "10:29:36")]);

  assert.deepEqual(
    log.entries.filter((e) => !e.explainedByOp)
      .map((e) => e.kind === "status" ? `state:${e.status}` : e.startEnd),
    ["state:ready", "end", "start"]);
});
