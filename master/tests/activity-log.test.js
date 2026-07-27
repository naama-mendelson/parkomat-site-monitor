// tests/activity-log.test.js — מה מוצג בלוג, באיזה סדר, וכמה נספר.
//
// שלוש תקלות אמיתיות נעולות כאן, כולן מאותה משפחה — "אירוע אחד, שתי שורות":
//
//   1. **סדר בלתי אפשרי.** הרשימה יורדת (מהחדש לישן), ולכן מי שמופיע מעל
//      קרה מאוחר יותר. הצבת "הפעולה הסתיימה" מעל "מוכן" אמרה שהאתר חזר
//      להיות מוכן בזמן שהפעולה עוד פתוחה.
//   2. **מקטע 'בפעולה' יתום נעלם.** הסינון הגורף של 'בפעולה' הניח שלכל אחד
//      יש פעולה. resync של הסוכן מייצר state לבדו, ואז ההסתרה מוחקת את
//      האירוע היחיד — הכרטיס הראה "בפעולה" והלוג "מוכן" מלפני שעות (1348).
//   3. **'מוכן' הוסתר יחד איתו.** הוא נושא את משך ההמתנה עד הפעולה הבאה,
//      ובלעדיו פעולות נראו צמודות כאילו האתר לא עמד ריק ביניהן.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// queries.js טוען את db.js בראשו, ו-db.js דורש DATABASE_URL. buildActivityLog
// עצמה טהורה ואינה נוגעת ב-DB, ולכן מזריקים stub דרך require.cache — אותה
// תבנית כמו dispatcher.test.js, בלי תלות חדשה ובלי מסד נתונים.
const DB = require.resolve("../db/db");
require.cache[DB] = {
  id: DB, filename: DB, path: path.dirname(DB), loaded: true, children: [], paths: [],
  exports: { prepare: () => ({ get: async () => ({}), all: async () => [], run: async () => ({}) }) },
};

const { buildActivityLog, OP_PAIR_TOLERANCE_SECONDS } = require("../db/queries");

const iso = (s) => new Date(`2026-07-26T${s}Z`).toISOString();

const op = (at, startEnd, entryExit = "entry", siteId) => ({
  site_id: siteId, start_end: startEnd, entry_exit: entryExit,
  card_number: "7", is_anomaly: 0, state: "operating", occurred_at: iso(at),
});

const st = (at, status, endedAt = null, siteId) => ({
  site_id: siteId, status, started_at: iso(at),
  ended_at: endedAt ? iso(endedAt) : null,
});

const build = (ops, states, maint = []) =>
  buildActivityLog({
    ops, states, maint, limit: 300,
    counts: { cOperations: ops.length, cStatus: 0, cStatusAll: 0,
              cMaintWindows: 0, cMaintStatus: 0, cOrphanOperating: 0 },
  });

/** תיאור קצר לכל שורה, לפי סדר התצוגה — כך הבדיקה קוראת כמו המסך. */
const shown = (log) =>
  log.entries
    .filter((e) => !e.explainedByOp)
    .map((e) => e.kind === "operation"
      ? `${e.startEnd}/${e.entryExit}`
      : e.kind === "status" ? `state:${e.status}` : "maint");

// ============================================================
// סדר
// ============================================================

test("באותה שנייה: הפעולה נסגרת, ורק אז האתר מוכן", () => {
  const log = build(
    [op("12:00:00", "end")],
    [st("12:00:00", "ready", "14:00:00")]
  );

  // מהחדש לישן: 'מוכן' מעל הסיום. קריאה מלמטה למעלה = סיום ואז מוכן.
  // ההיפוך אומר שהמוכן קדם לסיום, וזה מצב שלא יכול לקרות.
  assert.deepEqual(shown(log), ["state:ready", "end/entry"]);
});

test("באותה שנייה: המצב נכנס ל'בפעולה' ורק אז הפעולה נפתחת", () => {
  const log = build(
    [op("12:00:00", "start")],
    [st("12:00:00", "operating", "12:05:00")]
  );

  // 'בפעולה' מוסבר ומוסתר, אבל הדירוג עצמו חייב להישאר נכון — הוא המוקדם.
  const order = log.entries.map((e) => e.kind === "operation" ? "op" : e.status);
  assert.deepEqual(order, ["op", "operating"]);
});

test("מחזור שלם נקרא נכון מלמטה למעלה", () => {
  const log = build(
    [op("12:00:00", "start"), op("12:05:00", "end")],
    [st("12:00:00", "operating", "12:05:00"), st("12:05:00", "ready", "15:00:00")]
  );

  assert.deepEqual(shown(log), ["state:ready", "end/entry", "start/entry"]);
});

// ============================================================
// מה מוסתר ומה לא
// ============================================================

test("'בפעולה' עם פעולה תואמת — מוסתר (הוא לא מוסיף כלום)", () => {
  const log = build([op("12:00:00", "start")], [st("12:00:00", "operating")]);
  assert.equal(log.entries.find((e) => e.kind === "status").explainedByOp, true);
});

test("'בפעולה' בלי פעולה — יתום, ולעולם לא מוסתר", () => {
  // זה 1348: resync בשעה 23:30 בלי פעולה, ואז שקט. אם הוא נעלם, הלוג סותר
  // את הכרטיס ואין שום רמז לתקלה.
  const log = build([], [st("23:30:58", "operating")]);
  assert.equal(log.entries[0].explainedByOp, false);
  assert.deepEqual(shown(log), ["state:operating"]);
});

test("'מוכן' לעולם אינו מוסתר — הוא נושא את זמן ההמתנה", () => {
  const log = build([op("12:00:00", "end")], [st("12:00:00", "ready", "14:37:00")]);
  const ready = log.entries.find((e) => e.kind === "status");

  assert.equal(ready.explainedByOp, false);
  assert.equal(ready.durationSeconds, 2 * 3600 + 37 * 60);
});

test("תקלה/תחזוקה/נתק אינם מוסתרים גם אם חלקו שנייה עם פעולה", () => {
  const log = build(
    [op("12:00:00", "start")],
    [st("12:00:00", "error"), st("12:00:00", "no_comm"), st("12:00:00", "maintenance")]
  );

  for (const e of log.entries.filter((x) => x.kind === "status")) {
    assert.equal(e.explainedByOp, false, `${e.status} הוסתר בטעות`);
  }
});

// ============================================================
// חלון ההצמדה
// ============================================================

test("פער בתוך חלון הסבילות עדיין מצמיד", () => {
  // בשטח ה-state והפעולה אינם באותה מילישנייה (2439: פער של שנייה).
  const log = build([op("12:00:02", "start")], [st("12:00:00", "operating")]);
  assert.equal(log.entries.find((e) => e.kind === "status").explainedByOp, true);
});

test("פער מעבר לחלון — לא מצמיד, והמצב נשאר יתום", () => {
  const late = `12:00:${String(OP_PAIR_TOLERANCE_SECONDS + 1).padStart(2, "0")}`;
  const log = build([op(late, "start")], [st("12:00:00", "operating")]);
  assert.equal(log.entries.find((e) => e.kind === "status").explainedByOp, false);
});

test("רק 'start' מסביר 'בפעולה' — 'end' באותה שנייה אינו מספיק", () => {
  const log = build([op("12:00:00", "end")], [st("12:00:00", "operating")]);
  assert.equal(log.entries.find((e) => e.kind === "status").explainedByOp, false);
});

// ============================================================
// מצרף כלל-אתרי
// ============================================================

test("ההצמדה היא לפי אתר — פעולה באתר אחר לא מסבירה מצב", () => {
  // במסך "כל האתרים" שני אתרים בהחלט מדווחים באותה שנייה. בלי הפרדה, פעולה
  // של אתר א' הייתה מוחקת את שורת המצב של אתר ב'.
  const log = build(
    [op("12:00:00", "start", "entry", 1)],
    [st("12:00:00", "operating", null, 2)]
  );

  assert.equal(log.entries.find((e) => e.kind === "status").explainedByOp, false);
});

test("אתר בודד (בלי site_id) עדיין מצמיד", () => {
  const log = build([op("12:00:00", "start")], [st("12:00:00", "operating")]);
  assert.equal(log.entries.find((e) => e.kind === "status").explainedByOp, true);
});

// ============================================================
// מונים
// ============================================================

test("המונה של 'הכל' כולל את היתומים, אחרת הצ'יפ לא תואם לשורות", () => {
  const log = buildActivityLog({
    ops: [], states: [], maint: [], limit: 300,
    counts: { cOperations: 8, cStatus: 5, cStatusAll: 11,
              cMaintWindows: 0, cMaintStatus: 0, cOrphanOperating: 1 },
  });

  // 8 פעולות + 5 מצבים + 0 תחזוקה + 1 יתום = 14 שורות ב"הכל".
  assert.equal(log.counts.operations + log.counts.status +
               log.counts.maintenance + log.counts.orphanOperating, 14);
});

test("שרת בלי המונה החדש — נופל ל-0 ולא ל-undefined", () => {
  const log = buildActivityLog({
    ops: [], states: [], maint: [], limit: 300,
    counts: { cOperations: 0, cStatus: 0, cStatusAll: 0,
              cMaintWindows: 0, cMaintStatus: 0 },
  });

  assert.equal(log.counts.orphanOperating, 0);
});
