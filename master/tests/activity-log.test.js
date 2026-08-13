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

const { buildActivityLog, buildTimeline, LOG_FILTERS, OP_PAIR_TOLERANCE_SECONDS } =
  require("../db/queries");

const iso = (s) => new Date(`2026-07-26T${s}Z`).toISOString();

const op = (at, startEnd, entryExit = "entry", siteId) => ({
  site_id: siteId, start_end: startEnd, entry_exit: entryExit,
  card_number: "7", is_anomaly: 0, state: "operating", occurred_at: iso(at),
});

const st = (at, status, endedAt = null, siteId) => ({
  site_id: siteId, status, started_at: iso(at),
  ended_at: endedAt ? iso(endedAt) : null,
});

// ============================================================
// הבדיקות אוחזות בציר ה**גולמי**, לא בעמוד המסונן
// ============================================================
// buildActivityLog מסנן (ברירת מחדל "הכל") וחותך לעמוד, ובכך מסתיר בדיוק את
// מה שנבדק כאן: 'בפעולה' מוסתר ב"הכל", ולכן בדיקה שרצה דרכו לא הייתה יכולה
// לאמת שהוא נבנה נכון מלכתחילה — או שהוא נשאר כשהוא יתום.
//
// buildTimeline מחזיר את הציר המלא. זו הסיבה שהוא פונקציה נפרדת.
const build = (ops, states, maint = []) => ({
  entries: buildTimeline({ ops, states, maint }),
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

// ============================================================
// מונים — ההבטחה היחידה: הצ'יפ שווה למספר השורות שנפתחות
// ============================================================
// קודם כל מונה היה COUNT(*) נפרד ב-SQL, כי הציר היה חתוך ל-300 ולא יכול היה
// לספר על התקופה. זה דרש שכל כלל יתקיים פעמיים — ב-SQL וב-JS — ורוב ההערות
// סביב הקוד הזה הן תיקונים למקומות שבהם השניים סטו.
//
// עכשיו המונה הוא אורך הקבוצה המסוננת. הבדיקה הזו היא ההבטחה עצמה, והיא
// עוברת על **כל** מסנן — כולל כאלה שיתווספו בעתיד.

// מערך מגוון: פעולות לשני הכיוונים, כל המצבים, ותחזוקה ידנית.
const SAMPLE_OPS = [
  op("12:00:00", "start", "entry"), op("12:05:00", "end", "entry"),
  op("13:00:00", "start", "exit"),  op("13:04:00", "end", "exit"),
];
const SAMPLE_STATES = [
  st("12:00:00", "operating", "12:05:00"), st("12:05:00", "ready", "13:00:00"),
  st("13:00:00", "operating", "13:04:00"), st("13:04:00", "error", "13:30:00"),
  st("13:30:00", "no_comm", "13:40:00"),   st("13:40:00", "maintenance", "14:00:00"),
];
const SAMPLE_MAINT = [{
  site_id: undefined, set_by_name: "דנה", set_by_role: "operator", reason: null,
  started_at: iso("13:40:00"), duration_hours: 2,
  expires_at: iso("15:40:00"), cancelled_at: null,
}];

test("כל מונה שווה בדיוק למספר השורות שהמסנן שלו פותח", () => {
  const args = { ops: SAMPLE_OPS, states: SAMPLE_STATES, maint: SAMPLE_MAINT };
  const base = buildActivityLog({ ...args, limit: 500 });

  for (const key of Object.keys(LOG_FILTERS)) {
    const page = buildActivityLog({ ...args, limit: 500, filter: key });
    assert.equal(
      page.entries.length, base.counts[key],
      `הצ'יפ "${key}" מראה ${base.counts[key]} אך נפתחות ${page.entries.length} שורות`
    );
  }
});

test("'תקלות' כולל גם את הפעולה שנקטעה, לא רק את מקטע התקלה", () => {
  // 71% מהתקלות קורות תוך כדי פעולה. מסנן שמראה רק את המקטע מספר חצי סיפור:
  // שהמתקן נפל, בלי מי היה בתוכו.
  const log = buildActivityLog({
    ops: [op("13:04:00", "end", "exit")],
    states: [st("13:04:00", "error", "13:30:00")],
    maint: [], limit: 500, filter: "error",
  });

  assert.deepEqual(
    log.entries.map((e) => e.kind).sort(),
    ["operation", "status"]
  );
  assert.equal(log.entries.find((e) => e.kind === "operation").interruptedBy, "error");
});

// ============================================================
// דפדוף — הבאג שבגללו "שבוע" הראה יממה
// ============================================================
// limit שימש גם כמה לשלוף וגם כמה להציג, והסינון רץ בדפדפן על מה שכבר נחתך.
// נמדד: 3,124 שורות ב-7 הימים האחרונים מול תקרה של 300.

test("total הוא גודל הקבוצה המסוננת, לא גודל העמוד", () => {
  const args = { ops: SAMPLE_OPS, states: SAMPLE_STATES, maint: SAMPLE_MAINT };
  const page = buildActivityLog({ ...args, limit: 2 });
  const full = buildActivityLog({ ...args, limit: 500 });

  assert.equal(page.entries.length, 2);
  assert.equal(page.total, full.entries.length);
  assert.ok(page.total > 2, "המדגם קטן מכדי לבדוק דפדוף");
  assert.equal(page.truncated, true);
});

test("עמודים רצופים מכסים את הקבוצה בדיוק — בלי חורים וכפילויות", () => {
  const args = { ops: SAMPLE_OPS, states: SAMPLE_STATES, maint: SAMPLE_MAINT };
  const full = buildActivityLog({ ...args, limit: 500 });

  const paged = [];
  for (let off = 0; off < full.total; off += 2) {
    paged.push(...buildActivityLog({ ...args, limit: 2, offset: off }).entries);
  }

  assert.deepEqual(paged.map((e) => e.at), full.entries.map((e) => e.at));
});

test("העמוד האחרון מסמן שאין עוד", () => {
  const args = { ops: SAMPLE_OPS, states: SAMPLE_STATES, maint: SAMPLE_MAINT };
  const full = buildActivityLog({ ...args, limit: 500 });
  const last = buildActivityLog({ ...args, limit: 2, offset: full.total - 2 });

  assert.equal(last.truncated, false, "'טען עוד' היה ממשיך להופיע בסוף הרשימה");
});

test("מסנן לא מוכר נופל ל'הכל' ולא לרשימה ריקה", () => {
  // הפרמטר מגיע מה-query string. ערך שגוי חייב להתנהג כברירת מחדל, לא להציג
  // מסך ריק שנקרא כמו "לא קרה כלום בתקופה".
  const args = { ops: SAMPLE_OPS, states: SAMPLE_STATES, maint: SAMPLE_MAINT };
  assert.equal(
    buildActivityLog({ ...args, limit: 500, filter: "לא-קיים" }).entries.length,
    buildActivityLog({ ...args, limit: 500 }).entries.length
  );
});

// ============================================================
// איחוד ניסיון חוזר — מעבר פיזי אחד = פעולה אחת
// ============================================================

test("ניסיון שהוחלף אינו מופיע בלוג כלל", () => {
  // ולא "מופיע עם תווית 'אוחדה'": זו בדיוק הכפילות שהאיחוד בא לבטל. הקוראת
  // רואה שתי שורות לאותו מעבר וסופרת שתיים, בלי קשר למה שכתוב בתווית.
  const cut = { ...op("12:05:00", "end", "entry"), superseded_by: 999 };
  const timeline = buildTimeline({
    ops: [op("12:00:00", "start", "entry"), cut, op("12:10:00", "start", "entry")],
    states: [], maint: [],
  });

  assert.equal(timeline.filter((e) => e.kind === "operation").length, 2,
    "הניסיון שנקטע עדיין מופיע בציר");
});

test("ניסיון שהוחלף אינו מוסתר מכל הפעולות — רק הוא", () => {
  // רגרסיה הפוכה: מסנן רחב מדי היה מעלים גם פעולות תקינות.
  const timeline = buildTimeline({ ops: SAMPLE_OPS, states: [], maint: [] });
  assert.equal(timeline.length, SAMPLE_OPS.length);
});

test("נקטעה בתקלה ואז תחזוקה — הרכב הועבר ידנית, לא נשאר תקוע", () => {
  // רכב שנתקע אינו נשאר תקוע: מעבירים ללא-אוטומט ומכניסים אותו ידנית.
  // "נקטעה" לבדה מספרת חצי סיפור, ובדיוק את החצי המדאיג.
  const timeline = buildTimeline({
    ops: [op("13:04:00", "end", "exit")],
    states: [st("13:04:00", "error", "13:20:00"), st("13:20:00", "maintenance", "14:00:00")],
    maint: [],
  });

  const o = timeline.find((e) => e.kind === "operation");
  assert.equal(o.interruptedBy, "error");
  assert.equal(o.resolvedInMaintenance, true);
});

test("נקטעה בתקלה ואז חזרה ל'מוכן' — לא הושלמה בתחזוקה", () => {
  // ההבחנה היא כל העניין: 'מוכן' פירושו שאיש לא טיפל ידנית, ולכן אין בסיס
  // להניח שהרכב עבר. סימון גורף היה הופך כל תקלה ל"הכול בסדר".
  const timeline = buildTimeline({
    ops: [op("13:04:00", "end", "exit")],
    states: [st("13:04:00", "error", "13:20:00"), st("13:20:00", "ready", "14:00:00")],
    maint: [],
  });

  assert.equal(timeline.find((e) => e.kind === "operation").resolvedInMaintenance, false);
});

test("תקלה שעוד לא נגמרה — אין 'אחריה', ולכן לא מסומן", () => {
  const timeline = buildTimeline({
    ops: [op("13:04:00", "end", "exit")],
    states: [st("13:04:00", "error")],           // ended_at = null
    maint: [],
  });

  assert.equal(timeline.find((e) => e.kind === "operation").resolvedInMaintenance, false);
});

// ============================================================
// חיפוש כרטיס
// ============================================================

test("חיפוש כרטיס מחזיר רק פעולות של אותו כרטיס", () => {
  const other = { ...op("14:00:00", "start", "entry"), card_number: "99" };
  const log = buildActivityLog({
    ops: [...SAMPLE_OPS, other], states: SAMPLE_STATES, maint: SAMPLE_MAINT,
    limit: 500, filter: "operation", card: "7",
  });

  // ⚠️ 2 ולא SAMPLE_OPS.length (=4), ובכוונה: SAMPLE_OPS הן ארבע **שורות**
  // שהן שני **מעברים** (כניסה + יציאה, כל אחד התחלה וסיום). מסנן "פעולות"
  // סופר מעברים מאז שהצ'יפ הפסיק לסתור את הדונאט — ראה LOG_FILTERS.
  const passages = SAMPLE_OPS.filter((o) => o.start_end === "end").length;
  assert.equal(passages, 2);
  assert.equal(log.entries.length, passages);
  assert.ok(log.entries.every((e) => e.card === "7"));
});

test("חיפוש ריק אינו מסנן כלום", () => {
  // `card=` ריק הגיע מהטופס כמחרוזת ריקה. אם הוא היה נחשב לחיפוש, כל לחיצה
  // על "חפש" בלי טקסט הייתה מרוקנת את המסך.
  const args = { ops: SAMPLE_OPS, states: SAMPLE_STATES, maint: SAMPLE_MAINT, limit: 500 };
  assert.equal(
    buildActivityLog({ ...args, card: "  " }).entries.length,
    buildActivityLog({ ...args }).entries.length
  );
});

// ============================================================
// התחלה יתומה — הבאג שהמשתמשת מצאה, ושאף בדיקה כאן לא תפסה
// ============================================================
// המסך הראה "יציאת רכב התחילה" בלי שום סיום אחריה. שני מקורות שונים לגמרי
// לאותה צורה, וההפרדה ביניהם היא כל העניין:
//
//   43 מתוך 49 — **האיחוד**. supersedeInterruptedAttempt/supersedeFlicker
//   מסמנות רק את ה-end שנקטע; הפתיחה שאיחדה אותו נשארה מוצגת, ולכן הציר הראה
//   שתי התחלות וסיום אחד. באג תצוגה.
//
//   6 מתוך 49 — **מכונה תקועה**. הסוכן מזהה לפי שינוי ב-MODE, וכשהרגיסטר
//   נתקע לא נשלחת הודעת סיום לעולם. נתון אמיתי שחייב להיראות ככזה.
//
// ⚠️ הבדיקות הקיימות עברו את שתיהן. הן בדקו סדר והצמדה — לא **שלמות זוגות**,
// שהיא בדיוק מה שנשבר.

/** כל התחלה מוצגת שאין אחריה סיום באותו כיוון, לפני ההתחלה הבאה. */
const orphanStarts = (entries) => {
  const open = new Map(), orphans = [];
  for (const e of [...entries].filter((x) => x.kind === "operation")
                              .sort((a, b) => (a.at < b.at ? -1 : 1))) {
    if (e.startEnd === "start") {
      if (open.has(e.entryExit)) orphans.push(open.get(e.entryExit));
      open.set(e.entryExit, e);
    } else open.delete(e.entryExit);
  }
  return [...orphans, ...open.values()];
};

const withId = (o, id, extra = {}) => ({ ...o, id, ...extra });

test("איחוד מסתיר גם את הפתיחה המאחדת — לא רק את הסיום שאוחד", () => {
  // מעבר פיזי אחד: נפתח ב-10:00, ריצוד קטע ב-10:05, נפתח מחדש ב-10:05 ונסגר
  // ב-10:10. הציר חייב להראות זוג אחד — 10:00 ← 10:10.
  const ops = [
    withId(op("10:00:00", "start", "exit"), 1),
    withId(op("10:05:00", "end", "exit"), 2, { superseded_by: 3 }),
    withId(op("10:05:06", "start", "exit"), 3),
    withId(op("10:10:00", "end", "exit"), 4),
  ];
  const entries = buildTimeline({ ops, states: [], maint: [] })
    .filter((e) => e.kind === "operation");

  assert.deepEqual(entries.map((e) => `${e.startEnd}@${e.at.slice(11, 19)}`).sort(),
                   ["end@10:10:00", "start@10:00:00"]);
  assert.equal(orphanStarts(entries).length, 0);
});

test("הפתיחה המאחדת יורדת גם כשהיא של ניסיון חוזר אחרי תקלה", () => {
  // אותו כלל, המקור השני: הפעולה נקטעה בתקלה והכרטיס ניסה שוב כעבור דקות.
  const ops = [
    withId(op("10:00:00", "start", "entry"), 1),
    withId(op("10:02:00", "end", "entry"), 2, { superseded_by: 3 }),
    withId(op("10:09:00", "start", "entry"), 3),
    withId(op("10:12:00", "end", "entry"), 4),
  ];
  const entries = buildTimeline({
    ops, states: [st("10:02:00", "error", "10:08:00")], maint: [],
  }).filter((e) => e.kind === "operation");

  assert.equal(entries.length, 2);
  assert.equal(orphanStarts(entries).length, 0);
});

test("פעולה שנפתחה ולא נסגרה מסומנת unfinished — ולא נמחקת", () => {
  // ⚠️ הסימון ולא ההשמטה הוא העיקר. השורה קרתה, והשמטתה הייתה הופכת מכונה
  // תקועה ל"לא קרה כלום" — בדיוק המסקנה ההפוכה.
  const ops = [
    withId(op("11:09:00", "start", "exit"), 1),      // נתקע, סיום לא הגיע לעולם
    withId(op("14:00:00", "start", "exit"), 2),
    withId(op("14:05:00", "end", "exit"), 3),
  ];
  const entries = buildTimeline({ ops, states: [], maint: [] })
    .filter((e) => e.kind === "operation");

  assert.equal(entries.length, 3);
  const stuck = entries.find((e) => e.at.includes("11:09"));
  assert.equal(stuck.unfinished, true);
  assert.equal(stuck.pending, false);
  // כל השאר תקינות — הסימון אינו נמרח
  assert.equal(entries.filter((e) => e.unfinished).length, 1);
});

test("הפעולה האחרונה בטווח היא pending ולא unfinished", () => {
  // אי-ידיעה אינה כשל: ייתכן שהיא רצה כרגע, וייתכן שהטווח פשוט נגמר. נמדד
  // בשטח — פעולה שנראתה יתומה נסגרה 11 דקות אחר כך.
  const ops = [
    withId(op("10:00:00", "start", "entry"), 1),
    withId(op("10:05:00", "end", "entry"), 2),
    withId(op("10:47:00", "start", "entry"), 3),
  ];
  const last = buildTimeline({ ops, states: [], maint: [] })
    .find((e) => e.kind === "operation" && e.at.includes("10:47"));

  assert.equal(last.pending, true);
  assert.equal(last.unfinished, false);
});

test("שורה בלי id אינה גוררת סימון גורף", () => {
  // ⚠️ הקבוצות מחזיקות אובייקטים ולא id-ים בדיוק בגלל זה: אילו היו id-ים,
  // כמה שורות בלי id היו מתנגשות ב-undefined אחד וכולן היו מסומנות יחד.
  const ops = [
    op("10:00:00", "start", "entry"), op("10:05:00", "end", "entry"),
    op("11:00:00", "start", "exit"),  op("11:05:00", "end", "exit"),
  ];
  const entries = buildTimeline({ ops, states: [], maint: [] })
    .filter((e) => e.kind === "operation");
  assert.equal(entries.filter((e) => e.unfinished || e.pending).length, 0);
});

// ============================================================
// שני הימים העמוסים
// ============================================================
// יום שיא בודד אינו אומר אם הוא חריג או שגרה. מה שנבדק כאן הוא בעיקר
// **יציבות**: שני ימים עם אותו מספר חייבים להיפתר לפי התאריך המוקדם, אחרת
// הם מתחלפים בין ריצות לפי סדר ההגעה של השורות — ומספר שמשתנה בלי שהנתונים
// השתנו הוא בדיוק מה שגורם לאבד אמון במסך.

// ⚠️ ישירות מהמודול המשותף. queries.js מייבא את computeInsights לשימוש
// פנימי אך אינו מייצא אותה — והבדיקה נכשלה על TypeError, לא על הנתונים.
const { computeInsights } = require("../../shared/insights.mjs");

/** end אחד = פעולה אחת שנספרת. */
const cop = (day, hh, dir = "entry") => ({
  site_id: 1, start_end: "end", entry_exit: dir, card_number: "7", is_anomaly: 0,
  superseded_by: null, occurred_at: new Date(`2026-07-${day}T${hh}:00:00Z`).toISOString(),
});

const insightsOf = (ops) => computeInsights({
  ops, errorRows: [], maintRows: [], windows: [],
  from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z",
});

test("busiestDays מחזיר את שני הימים העמוסים, בסדר יורד", () => {
  const ops = [
    ...[..."abc"].map((_, i) => cop("20", String(10 + i).padStart(2, "0"))),   // 3
    ...[..."abcde"].map((_, i) => cop("21", String(10 + i).padStart(2, "0"))), // 5
    ...[..."ab"].map((_, i) => cop("22", String(10 + i).padStart(2, "0"))),    // 2
  ];
  const days = insightsOf(ops).activity.busiestDays;

  assert.equal(days.length, 2);
  assert.equal(days[0].operations, 5);
  assert.equal(days[1].operations, 3);
  assert.ok(days[0].label.includes("21."));
});

test("שוויון נשבר לפי התאריך המוקדם — לא לפי סדר השורות", () => {
  // ⚠️ אותם נתונים בשני סדרי הגעה חייבים להחזיר את אותה תשובה.
  const a = [cop("21", "10"), cop("21", "11"), cop("20", "10"), cop("20", "11")];
  const b = [...a].reverse();

  for (const ops of [a, b]) {
    const days = insightsOf(ops).activity.busiestDays;
    assert.equal(days[0].operations, 2);
    assert.ok(days[0].label.includes("20."), `ציפינו ל-20 בראש, התקבל ${days[0].label}`);
  }
});

test("יום פעילות אחד — רשימה באורך 1, ולא שני עם null", () => {
  const days = insightsOf([cop("20", "10"), cop("20", "11")]).activity.busiestDays;
  assert.equal(days.length, 1);
  assert.equal(days[0].operations, 2);
});

test("בלי פעילות — רשימה ריקה ו-busiestDay נשאר null", () => {
  const a = insightsOf([]).activity;
  assert.deepEqual(a.busiestDays, []);
  assert.equal(a.busiestDay, null);
});

test("busiestDay נשאר תואם ל-busiestDays[0]", () => {
  // תאימות אחורה: זרוע השרת והמטמון עדיין קוראים busiestDay.
  const a = insightsOf([cop("20", "10"), cop("21", "10"), cop("21", "11")]).activity;
  assert.deepEqual(a.busiestDay, a.busiestDays[0]);
});

// ============================================================
// שוויון בשעת השיא — הגרף והכיתוב חייבים לספר אותו דבר
// ============================================================
// ⚠️ נתפס על המסך: שתי עמודות ירוקות (7:00 ו-16:00, 7 פעולות כל אחת) וכיתוב
// שאמר "השעה העמוסה ביותר: 7:00". ההדגשה בגרף נגזרת מה**ערך** ולכן צובעת כל
// שוויון; הכיתוב נגזר מ-indexOf ולכן החזיר את הראשונה בלבד.
//
// זו סתירה בתוך אותו כרטיס, ומי שקורא שואל איזה מהם נכון.

const hop = (day, hh) => ({
  site_id: 1, start_end: "end", entry_exit: "entry", card_number: "7", is_anomaly: 0,
  superseded_by: null, occurred_at: new Date(`2026-07-${day}T${hh}:30:00`).toISOString(),
});

const hoursOf = (ops) => computeInsights({
  ops, errorRows: [], maintRows: [], windows: [],
  from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z",
}).activity;

test("שתי שעות שוות בשיא — שתיהן מוחזרות", () => {
  const ops = [
    hop("20", "07"), hop("21", "07"),          // 7:00 → 2
    hop("20", "16"), hop("21", "16"),          // 16:00 → 2
    hop("20", "09"),                            // 9:00 → 1
  ];
  const a = hoursOf(ops);
  assert.equal(a.busiestHours.length, 2);
  assert.deepEqual(a.busiestHours.map((h) => h.hour), [7, 16]);
  assert.ok(a.busiestHours.every((h) => h.operations === 2));
});

test("שלוש שעות שוות — כולן, בלי קיצוב לשתיים", () => {
  // ⚠️ קיצוב קשיח לשתיים היה מחזיר את אותה סתירה, רק נדירה יותר.
  const ops = [hop("20", "07"), hop("20", "12"), hop("20", "16")];
  assert.equal(hoursOf(ops).busiestHours.length, 3);
});

test("שיא יחיד — רשימה באורך 1", () => {
  const a = hoursOf([hop("20", "07"), hop("21", "07"), hop("20", "16")]);
  assert.equal(a.busiestHours.length, 1);
  assert.equal(a.busiestHours[0].hour, 7);
});

test("השעות מוחזרות בסדר עולה", () => {
  const a = hoursOf([hop("20", "16"), hop("20", "07")]);
  assert.deepEqual(a.busiestHours.map((h) => h.hour), [7, 16]);
});

test("בלי פעילות — רשימה ריקה ו-busiestHour נשאר null", () => {
  const a = hoursOf([]);
  assert.deepEqual(a.busiestHours, []);
  assert.equal(a.busiestHour, null);
});

test("busiestHour נשאר תואם ל-busiestHours[0]", () => {
  const a = hoursOf([hop("20", "07"), hop("20", "16")]);
  assert.deepEqual(a.busiestHour, a.busiestHours[0]);
});

// ============================================================
// הצ'יפ סופר רכבים, לא שורות
// ============================================================
// ⚠️ נתפס על המסך, וזו סתירה של **פי שניים** בין שני כרטיסים באותו מסך:
//
//     לוג:    כניסות 56 · יציאות 49 · פעולות 105
//     דונאט:  כניסות 28 · יציאות 25 · סה"כ    62
//
// כל מעבר פיזי נרשם כשתי שורות — "התחילה" ו"הושלמה". המסנן ספר שורות בעוד
// computeInsights סופר מעברים. **שני המספרים היו נכונים** כל אחד ביחידה שלו,
// ולכן אף בדיקה לא נפלה — ומי שקוראת אותם זה לצד זה רואה סתירה.
//
// ⚠️ והכלל שאסור לשבור בתיקון: **המספר על הצ'יפ שווה למספר השורות שנפתחות.**
// לכן צומצם המסנן עצמו ל-'end', ולא רק המונה.

const opRow = (at, startEnd, dir) => ({
  site_id: 1, start_end: startEnd, entry_exit: dir, card_number: "7",
  is_anomaly: 0, superseded_by: null, state: "operating",
  occurred_at: new Date(`2026-07-20T${at}Z`).toISOString(),
});

test("מעבר אחד = 1 בצ'יפ, למרות שתי שורות בציר", () => {
  const ops = [opRow("10:00:00", "start", "entry"), opRow("10:05:00", "end", "entry")];
  const log = buildActivityLog({ ops, states: [], maint: [], limit: 500 });

  assert.equal(log.counts.entry, 1, "כניסה אחת, לא שתיים");
  assert.equal(log.counts.operation, 1);
});

test("⚠️ המונה שווה בדיוק למספר השורות שנפתחות", () => {
  // זו האינווריאנטה שכל התיקון נשען עליה. מונה 1 ורשימה של 2 היה מחליף
  // סתירה אחת באחרת.
  const ops = [
    opRow("10:00:00", "start", "entry"), opRow("10:05:00", "end", "entry"),
    opRow("11:00:00", "start", "exit"),  opRow("11:04:00", "end", "exit"),
  ];
  const args = { ops, states: [], maint: [], limit: 500 };
  for (const f of ["operation", "entry", "exit"]) {
    const log = buildActivityLog({ ...args, filter: f });
    assert.equal(log.entries.length, log.counts[f], `המסנן ${f}`);
  }
});

test("סכום כניסות ויציאות שווה לפעולות", () => {
  const ops = [
    opRow("10:00:00", "start", "entry"), opRow("10:05:00", "end", "entry"),
    opRow("11:00:00", "start", "exit"),  opRow("11:04:00", "end", "exit"),
    opRow("12:00:00", "start", "exit"),  opRow("12:03:00", "end", "exit"),
  ];
  const c = buildActivityLog({ ops, states: [], maint: [], limit: 500 }).counts;
  assert.equal(c.entry, 1);
  assert.equal(c.exit, 2);
  assert.equal(c.entry + c.exit, c.operation);
});

test("'הכל' עדיין מציג את שורות ההתחלה", () => {
  // ⚠️ ההתחלה לא נעלמה מהמערכת — רק מהמונה. היא נושאת את זמן הפתיחה ואת
  // הסימון "ללא סיום", ובלעדיה מכונה תקועה נעלמת מהלוג לגמרי.
  const ops = [opRow("10:00:00", "start", "entry"), opRow("10:05:00", "end", "entry")];
  const log = buildActivityLog({ ops, states: [], maint: [], limit: 500, filter: "all" });
  assert.equal(log.entries.filter((e) => e.kind === "operation").length, 2);
  assert.equal(log.counts.all, 2);
});

test("פעולה שנקטעה בתקלה עדיין נספרת — יש לה שורת סיום", () => {
  const ops = [opRow("10:00:00", "start", "entry"), opRow("10:05:00", "end", "entry")];
  const states = [{ site_id: 1, status: "error",
                    started_at: new Date("2026-07-20T10:05:00Z").toISOString(), ended_at: null }];
  const c = buildActivityLog({ ops, states, maint: [], limit: 500 }).counts;
  assert.equal(c.entry, 1);
});

// ============================================================
// תיאור התקלה מהבקר
// ============================================================
// עד היום כל התקלות נראו זהות בלוג: "המצב השתנה ל: מושבת · נמשך 4 דק'".
// אין דרך לדעת אם זו תקלת חיישן, כרטיס שלא נקרא או תקלה מכנית — ולכן גם
// אי אפשר לקבץ תקלות לפי סוג ולומר "האתר נפל 6 פעמים, כולן מאותה סיבה".
//
// ⚠️ מה שנבדק כאן הוא בעיקר ההבחנה שקל למחוק: **null אינו ''**.
//   null = לא נקרא (תקלה היסטורית, סוכן ישן, בקר בלי התכונה)
//   ''   = נקרא, והבקר החזיר ריק

test("תיאור התקלה עובר מהשורה לציר", () => {
  const states = [{
    site_id: 1, status: "error",
    started_at: new Date("2026-07-20T10:00:00Z").toISOString(),
    ended_at: null, fault_text: "E-204 CARD READER TIMEOUT",
  }];
  const [row] = buildTimeline({ ops: [], states, maint: [] })
    .filter((e) => e.kind === "status");

  assert.equal(row.faultText, "E-204 CARD READER TIMEOUT");
});

test("⚠️ null נשמר כ-null ואינו הופך למחרוזת ריקה", () => {
  // תקלה שנרשמה לפני התכונה. המסך צריך להיות מסוגל להבדיל בינה לבין
  // תקלה שנשאלה והחזירה ריק.
  const states = [{
    site_id: 1, status: "error",
    started_at: new Date("2026-07-20T10:00:00Z").toISOString(),
    ended_at: null,
  }];
  const [row] = buildTimeline({ ops: [], states, maint: [] })
    .filter((e) => e.kind === "status");

  assert.equal(row.faultText, null);
});

test("מחרוזת ריקה נשמרת כמחרוזת ריקה", () => {
  const states = [{
    site_id: 1, status: "error",
    started_at: new Date("2026-07-20T10:00:00Z").toISOString(),
    ended_at: null, fault_text: "",
  }];
  const [row] = buildTimeline({ ops: [], states, maint: [] })
    .filter((e) => e.kind === "status");

  assert.equal(row.faultText, "");
  assert.notEqual(row.faultText, null);
});

test("תיאור בעברית עובר כמות שהוא", () => {
  // הסוכן מפענח Windows-1255 ומעביר Unicode. הציר אינו נוגע בטקסט.
  const states = [{
    site_id: 1, status: "error",
    started_at: new Date("2026-07-20T10:00:00Z").toISOString(),
    ended_at: null, fault_text: "תקלת חיישן במסלול 2",
  }];
  const [row] = buildTimeline({ ops: [], states, maint: [] })
    .filter((e) => e.kind === "status");

  assert.equal(row.faultText, "תקלת חיישן במסלול 2");
});

// ============================================================
// פיצול התחזוקה לשני מסננים — תחזוקה מול תפעול תקלה
// ============================================================
// ⚠️ הכלל שהפיצול חייב לקיים הוא **חלוקה, לא שני מבטים**: כל שורת תחזוקה
// שייכת לצ'יפ אחד בדיוק. שני מסננים חופפים היו מסתכמים ליותר מסך התחזוקה,
// ואותה שורה הייתה נפתחת בשניהם — בדיוק סוג הסתירה שהמסננים כאן כבר תוקנו
// ממנה פעם אחת (הצ'יפ שסתר את הדונאט).
test("תפעול תקלה ותחזוקה מחלקים את התחזוקה בלי חפיפה", () => {
  const rows = [
    // מקטע תחזוקה שמתחיל בדיוק כשנגמרה התקלה → טיפול
    { kind: "status", status: "maintenance", afterError: true },
    { kind: "status", status: "maintenance", afterError: true },
    // תחזוקה שדווחה מהבקר בלי תקלה שקדמה לה
    { kind: "status", status: "maintenance", afterError: false },
    // ⚠️ שדה חסר לגמרי (שורה היסטורית מלפני התכונה) — חייב להיספר כתחזוקה
    // ולא להיעלם משני הצ'יפים.
    { kind: "status", status: "maintenance" },
    // חלון ידני — תמיד תחזוקה, לעולם לא טיפול: מישהו לחץ על כפתור.
    { kind: "maintenance" },
    // רעש שאסור שייכנס לאף אחד מהם
    { kind: "status", status: "error", afterError: true },
    { kind: "operation", startEnd: "end" },
  ];

  const repair = rows.filter(LOG_FILTERS.repair);
  const planned = rows.filter(LOG_FILTERS.maintenance);

  assert.equal(repair.length, 2, "תפעול תקלה");
  assert.equal(planned.length, 3, "תחזוקה (כולל חלון ידני ושדה חסר)");

  // ⚠️ הבדיקה האמיתית: אין שורה שנופלת בשניהם.
  const both = rows.filter((e) => LOG_FILTERS.repair(e) && LOG_FILTERS.maintenance(e));
  assert.equal(both.length, 0, "אין חפיפה בין הצ'יפים");

  // וכל התחזוקה מכוסה — הסכום שווה למה שהמסנן המאוחד היה מחזיר.
  const allMaint = rows.filter(
    (e) => e.kind === "maintenance" || (e.kind === "status" && e.status === "maintenance"));
  assert.equal(repair.length + planned.length, allMaint.length, "הסכום נשמר");
});

test("⚠️ תקלה עם afterError אינה נספרת כטיפול", () => {
  // afterError מסומן על שורת התחזוקה, לא על התקלה. מסנן שהיה בודק רק את
  // הדגל בלי הסטטוס היה גורר לכאן גם את שורת התקלה עצמה — ומכפיל כל אירוע.
  const errRow = { kind: "status", status: "error", afterError: true };
  assert.equal(LOG_FILTERS.repair(errRow), false);
  assert.equal(LOG_FILTERS.maintenance(errRow), false);
});

// ============================================================
// זהות הכרטיס היא (אתר, מספר) — ולא המספר לבדו
// ============================================================
// ⚠️ **נמדד בייצור:** 33 מספרי כרטיס ייחודיים בסך הכל, 79% מהם מופיעים
// ביותר מאתר אחד, ו-"4" מופיע ב-11 אתרים. אלה מספרים סידוריים לכל אתר.
//
// טבלת "המשתמשים הפעילים ביותר" קיבצה לפי המספר בלבד, ולכן במבט המצרף היא
// מיזגה 11 כרטיסים פיזיים של 11 אנשים לשורה אחת — ודירגה אותה ראשונה, כי
// הסכום שלה הוא סכום של אחת-עשרה.
//
// ⚠️ **וזה שרד 278 בדיקות.** באתר בודד המספרים ייחודיים ואין הבדל, ולכן כל
// הבדיקות הקיימות — שכולן על אתר אחד — עברו בצדק. השבירה קיימת רק במצרפת.
{
  const { computeInsights: ciCards } = require("../../shared/insights.mjs");

  const opFor = (siteId, card, at) => ([
    { site_id: siteId, start_end: "start", entry_exit: "entry", card_number: card,
      is_anomaly: 0, superseded_by: null, occurred_at: at },
    { site_id: siteId, start_end: "end", entry_exit: "entry", card_number: card,
      is_anomaly: 0, superseded_by: null, occurred_at: at },
  ]);

  const run = (ops, siteNames) => ciCards({
    ops, errorRows: [], maintRows: [], windows: [], siteNames,
    from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T00:00:00.000Z",
  });

  test("⚠️ אותו מספר כרטיס בשני אתרים אינו אותו משתמש", () => {
    // כרטיס "4" באתר 1 (פעמיים) ובאתר 2 (פעם אחת).
    const ops = [
      ...opFor(1, "4", "2026-03-01T08:00:00.000Z"),
      ...opFor(1, "4", "2026-03-01T09:00:00.000Z"),
      ...opFor(2, "4", "2026-03-01T10:00:00.000Z"),
    ];
    const r = run(ops, new Map([[1, "אילת 4"], [2, "חולדה 4"]]));

    assert.equal(r.cards.uniqueCards, 2, "שני משתמשים, לא אחד");
    assert.equal(r.cards.top.length, 2);

    // ⚠️ הבדיקה שמפילה את הבאג: לפני התיקון השורה הראשונה הייתה total=3.
    assert.equal(r.cards.top[0].total, 2, "האתר עם השתיים ראשון");
    assert.equal(r.cards.top[1].total, 1);
    assert.notEqual(r.cards.top[0].siteId, r.cards.top[1].siteId);
  });

  test("שם האתר מצורף לכל שורה, כדי שאפשר יהיה להבדיל", () => {
    // בלי השם, שתי השורות מציגות "4" ו-"4" ואין דרך לדעת מי מי — וזה גרוע
    // מהמיזוג שהוא בא להחליף.
    const ops = [...opFor(1, "4", "2026-03-01T08:00:00.000Z"),
                 ...opFor(2, "4", "2026-03-01T10:00:00.000Z")];
    const r = run(ops, new Map([[1, "אילת 4"], [2, "חולדה 4"]]));

    assert.deepEqual(r.cards.top.map((c) => c.siteName).sort(), ["אילת 4", "חולדה 4"]);
  });

  test("בלי מפת שמות — לא קורס, השם null", () => {
    // ⚠️ מצב אתר בודד אינו שולח שמות (כל השורות מאותו אתר). התיקון חייב
    // להישאר אופציונלי, אחרת מסך שעבד נשבר.
    const r = run(opFor(1, "4", "2026-03-01T08:00:00.000Z"), undefined);
    assert.equal(r.cards.top[0].siteName, null);
    assert.equal(r.cards.top[0].card, "4");
  });

  test("באתר בודד ההתנהגות לא השתנתה", () => {
    // הגנה מפני רגרסיה: המסך שעבד נכון חייב להמשיך להחזיר בדיוק אותו דבר.
    const ops = [...opFor(7, "12", "2026-03-01T08:00:00.000Z"),
                 ...opFor(7, "12", "2026-03-01T09:00:00.000Z"),
                 ...opFor(7, "3",  "2026-03-01T10:00:00.000Z")];
    const r = run(ops, undefined);

    assert.equal(r.cards.uniqueCards, 2);
    assert.equal(r.cards.top[0].card, "12");
    assert.equal(r.cards.top[0].total, 2);
  });
}

// ⚠️ המשכים נשמרים במפה **שנייה** (perCard), ובה אותו באג בדיוק. הבדיקות
// שלמעלה לא תפסו אותו כי start ו-end שלהן באותה שנייה — המשך יוצא 0 ומסונן,
// והמפה נשארת ריקה. כלומר שלוש בדיקות ירוקות שאינן נוגעות במחצית הקוד.
//
// כאן יש הפרש זמן אמיתי, ולכן המפה מתמלאת: כרטיס "4" איטי באתר אחד ומהיר
// באחר. מיזוג היה ממצע אותם לערך שאינו נכון לאף אחד מהשניים.
test("⚠️ המשכים אינם מתערבבים בין אתרים בעלי אותו מספר כרטיס", () => {
  const { computeInsights: ci2 } = require("../../shared/insights.mjs");
  const pair = (siteId, card, startAt, endAt) => ([
    { site_id: siteId, start_end: "start", entry_exit: "entry", card_number: card,
      is_anomaly: 0, superseded_by: null, occurred_at: startAt },
    { site_id: siteId, start_end: "end", entry_exit: "entry", card_number: card,
      is_anomaly: 0, superseded_by: null, occurred_at: endAt },
  ]);

  const r = ci2({
    ops: [
      // אתר 1, כרטיס 4 — 100 שניות
      ...pair(1, "4", "2026-03-01T08:00:00.000Z", "2026-03-01T08:01:40.000Z"),
      // אתר 2, כרטיס 4 — 10 שניות
      ...pair(2, "4", "2026-03-01T09:00:00.000Z", "2026-03-01T09:00:10.000Z"),
    ],
    errorRows: [], maintRows: [], windows: [],
    siteNames: new Map([[1, "אילת 4"], [2, "חולדה 4"]]),
    from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T00:00:00.000Z",
  });

  const bySite = Object.fromEntries(r.cards.top.map((c) => [c.siteId, c]));
  assert.equal(bySite[1].durations.entry.averageSeconds, 100, "האיטי נשאר איטי");
  assert.equal(bySite[2].durations.entry.averageSeconds, 10, "והמהיר נשאר מהיר");
});
