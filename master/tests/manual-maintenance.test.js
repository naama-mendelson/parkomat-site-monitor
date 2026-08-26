// tests/manual-maintenance.test.js — חלון תחזוקה ידני מתנהג כמו תחזוקה מהבקר.
//
// ============================================================
// ⚠️ שני מסכים, שני סיפורים
// ============================================================
// הכרטיס כבר הראה "בתחזוקה" לאורך כל החלון — applyMaintenanceStatus בשרת
// ואותו כלל ב-sitesDirect גוברים על מה שה-PLC דיווח. אבל **הציר** הראה את
// האמת הגולמית, ולכן אותו אתר סיפר שני דברים שונים על אותה שעה.
//
// נמדד בז'בוטינסקי, בתוך חלון ידני יחיד בן שעה (25.08, 12:46→13:46):
//
//     13:13  בתחזוקה
//     13:19  מוכן        <- בתוך החלון
//     13:20  בתחזוקה
//     13:21  מוכן        <- בתוך החלון
//
// תחת תחזוקה **מהבקר** זה לא קורה: הבקר משדר maintenance ברציפות ולכן יש
// מקטע אחד ארוך. הדרישה היא שחלון ידני ייראה אותו דבר — וזו כבר ההתנהגות
// של המדדים: coveredMs הופך את כל הזמן שבתוך החלון לתחזוקה.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTimeline, buildActivityLog } = require("../../shared/timeline.mjs");

const T = (h, m) => new Date(Date.UTC(2026, 7, 25, h, m, 0)).toISOString();
const st = (status, h, m, end = null) =>
  ({ site_id: 1, status, started_at: T(h, m), ended_at: end, reclassified_to: null, excluded_at: null });

const WINDOW = {
  id: 2432, site_id: 1,
  started_at: T(12, 46), expires_at: T(13, 46), cancelled_at: null, excluded_at: null,
  set_by_name: "sherut@parkomat.co.il", duration_hours: 1,
};

const statuses = (tl) => tl.filter((e) => e.kind === "status").map((e) => `${e.at} ${e.status}`);


test("⚠️ שינויי מצב בתוך חלון ידני אינם מוצגים בציר", () => {
  const tl = buildTimeline({
    ops: [],
    states: [
      st("ready", 12, 0, T(13, 13)),
      st("maintenance", 13, 13, T(13, 19)),
      st("ready", 13, 19, T(13, 20)),          // בתוך החלון
      st("maintenance", 13, 20, T(13, 21)),    // בתוך החלון
      st("ready", 13, 21, null),               // בתוך החלון
    ],
    maint: [WINDOW],
  });

  // רק המקטע שנפתח **לפני** החלון שורד.
  assert.deepEqual(statuses(tl), [`${T(12, 0)} ready`]);

  // ⚠️ והחלון עצמו כן מופיע — אחרת פשוט אין שום שורה שמסבירה את השעה הזו.
  assert.equal(tl.filter((e) => e.kind === "maintenance").length, 1);
});


test("⚠️ שינוי מצב **ברגע שהחלון נגמר** חייב להופיע", () => {
  // הגבול חצי-פתוח. בלעדיו האתר נראה כאילו נשאר בתחזוקה עד השינוי הבא —
  // שעלול לא להגיע כלל, כי הסוכן משדר מצב רק כשהוא משתנה.
  const tl = buildTimeline({
    ops: [],
    states: [
      st("ready", 13, 30, T(13, 46)),   // בתוך החלון — מוסתר
      st("ready", 13, 46, null),        // בדיוק בסיום — מוצג
      st("operating", 14, 10, null),    // אחרי — מוצג
    ],
    maint: [WINDOW],
  });

  assert.deepEqual(statuses(tl), [`${T(14, 10)} operating`, `${T(13, 46)} ready`]);
});


test("⚠️ ההתאוששות ממקטע תחזוקה של הבקר לא נעלמה", () => {
  // מפה נפרדת ולא שימוש חוזר ב-maintBySite: שם הגבול **כולל** את הקצה
  // (m.end >= ts), ולכן 'מוכן' שנפתח בדיוק כשמקטע התחזוקה נסגר היה נמחק —
  // וזו בדיוק שורת ההתאוששות שהמשתמשת מחפשת.
  const tl = buildTimeline({
    ops: [],
    states: [
      st("maintenance", 9, 0, T(9, 30)),
      st("ready", 9, 30, null),        // בדיוק בקצה מקטע ה-PLC
    ],
    maint: [],                          // אין חלון ידני כלל
  });

  assert.deepEqual(statuses(tl), [`${T(9, 30)} ready`, `${T(9, 0)} maintenance`]);
});


test("⚠️ חלון שסומן כניסוי אינו מסתיר דבר", () => {
  const tl = buildTimeline({
    ops: [],
    states: [st("ready", 13, 19, null)],
    maint: [{ ...WINDOW, excluded_at: T(14, 0) }],
  });

  assert.deepEqual(statuses(tl), [`${T(13, 19)} ready`],
    "החלון בוטל לחצאין — הוא עדיין הסתיר שורות");
});


test("חלון שבוטל מסתיר רק עד רגע הביטול", () => {
  const tl = buildTimeline({
    ops: [],
    states: [
      st("ready", 13, 0, T(13, 10)),    // בתוך — מוסתר
      st("error", 13, 20, null),        // אחרי הביטול — מוצג
    ],
    maint: [{ ...WINDOW, cancelled_at: T(13, 15) }],
  });

  assert.deepEqual(statuses(tl), [`${T(13, 20)} error`]);
});


test("פעולות **אינן** מוסתרות — הן תנועת רכב אמיתית", () => {
  // הסתרתן הייתה יוצרת סתירה חדשה בין הציר למונה הפעולות (statsFromData).
  const tl = buildTimeline({
    ops: [{
      site_id: 1, occurred_at: T(13, 5), start_end: "start", entry_exit: "entry",
      card_number: "4", is_anomaly: 0, superseded_by: null, state: "operating",
    }],
    states: [],
    maint: [WINDOW],
  });

  assert.equal(tl.filter((e) => e.kind === "operation").length, 1);
});


// ============================================================
// ⚠️ הצ'יפ חייב לרדת יחד עם השורות
// ============================================================
// זו הסכנה של כל הסתרה: הרשימה מתקצרת והמונה נשאר. הצ'יפ נראה סמכותי
// ואינו קשור למה שנפתח — בדיוק הכשל שהופרדות המונים ל-SQL יצרה פעם,
// והמעבר לספירה מהציר עצמו בא לתקן. הבדיקה מקבעת שזה עדיין נכון.
test("⚠️ מונה שינויי המצב יורד יחד עם השורות שהוסתרו", () => {
  const states = [
    st("ready", 12, 0, T(13, 13)),
    st("maintenance", 13, 13, T(13, 19)),   // בתוך החלון
    st("ready", 13, 19, T(13, 20)),         // בתוך החלון
    st("maintenance", 13, 20, T(13, 21)),   // בתוך החלון
    st("ready", 13, 21, T(13, 46)),         // בתוך החלון
    st("ready", 13, 46, null),              // בסיום — מוצג
  ];

  const log = buildActivityLog({
    ops: [], states, maint: [WINDOW], suppressed: [], limit: 100, filter: "status",
  });

  assert.equal(log.total, log.entries.length, "המונה אינו שווה למספר השורות");
  assert.equal(log.total, 2, "נספרו גם השורות שבתוך החלון");
  assert.deepEqual(
    log.entries.map((e) => e.at),
    [T(13, 46), T(12, 0)],
  );
});
