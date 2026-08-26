// tests/downtime-agreement.test.js — 'זמן השבתה' מול 'שעות תקלה'.
//
// ============================================================
// ⚠️ אותו מסך, שני מספרים לאותו דבר
// ============================================================
// לוח התובנות מציג downtime.totalHours; פס הזמינות שלידו מציג את
// errorHours של uptimeFromData. הם אמורים להיות אותו מספר, והם לא היו —
// משלוש סיבות עצמאיות שכולן פעלו בו-זמנית ובכיוונים מנוגדים, ולכן
// ביטלו זו את זו בחלק מהאתרים ונראו כמו רעש:
//
//   1. **קיפול ריצוד מחק זמן.** collapseNoCommFlicker מפילה המשכים
//      (`error → no_comm → error` הוא אירוע אחד), והסכומים רצו על הרשימה
//      המקוצצת — כלומר כל דקה של כל מקטע המשך נמחקה מהמדד.
//   2. **מקטע שסומן כניסוי** נספר בתובנות ולא נספר בזמינות.
//   3. **חלון תחזוקה ידני** מכסה זמן בזמינות ולא כיסה דבר בתובנות.
//
// נמדד בייצור לפני התיקון: ז'בוטינסקי 35.01 מול 29.84, אוסישקין 12.25
// מול 10.00, נמל דולי 8.18 מול 7.00. שני מספרים סבירים שסותרים זה את
// זה — וזה גרוע ממספר שגוי אחד, כי אין דרך לדעת במי להאמין.
//
// ⚠️ הספירה **לא** השתנתה: המשך אינו אירוע חדש, וזה נכון. הוא נספר בזמן
// בלבד. הבדיקה מוודאת את שני הצדדים — שהשעות התיישרו ושהמונה לא זז.
const test = require("node:test");
const assert = require("node:assert/strict");

const { computeInsights } = require("../../shared/insights.mjs");
const { uptimeFromData } = require("../../shared/executive.mjs");

const SITE = 7;
const T = (h, m = 0) => new Date(Date.UTC(2026, 0, 10, h, m, 0)).toISOString();
const FROM = T(0);
const TO = T(23);

// ⚠️ שני צדדים לאותם נתונים, בדיוק כמו במערכת: המדדים מקבלים מפות לפי
// אתר, והתובנות מקבלות רשימות שטוחות. אותן שורות בדיוק.
const build = ({ segments, windows }) => ({
  forUptime: { segments: new Map([[SITE, segments]]), windows: new Map([[SITE, windows]]) },
  forInsights: (opts = {}) => {
    const { collapseSegmentsBySite } = require("../../shared/insights.mjs");
    const counted = collapseSegmentsBySite(segments.filter((s) => !s.excluded_at));
    return computeInsights({
      ops: [],
      errorRows: counted.filter((s) => s.status === "error"),
      maintRows: counted.filter((s) => s.status === "maintenance"),
      allRows: segments,
      windows: windows.map((w) => ({
        ...w,
        duration_hours: (Date.parse(w.expires_at) - Date.parse(w.started_at)) / 3600000,
      })),
      from: FROM, to: TO,
      ...opts,
    });
  },
});

const seg = (status, a, b, extra = {}) =>
  ({ site_id: SITE, status, started_at: a, ended_at: b, reclassified_to: null, excluded_at: null, ...extra });


test("⚠️ ריצוד תקשורת: האירוע אחד, הזמן מלא", () => {
  // תקלה 2 שעות → נתק 10 דקות → אותה תקלה עוד 2 שעות.
  // הקיפול מפיל את המקטע השלישי, ולכן הגרסה הקודמת ספרה **שעתיים בלבד**.
  const { forUptime, forInsights } = build({
    segments: [
      seg("ready", T(0), T(4)),
      seg("error", T(4), T(6)),
      seg("no_comm", T(6), T(6, 10)),
      seg("error", T(6, 10), T(8, 10)),
      seg("ready", T(8, 10), null),
    ],
    windows: [],
  });

  const ins = forInsights();
  const up = uptimeFromData(forUptime, SITE, { from: FROM, to: TO });

  assert.equal(ins.downtime.totalHours, up.errorHours, "השעות אינן מסכימות");
  assert.equal(ins.downtime.totalHours, 4, "ארבע שעות תקלה — לא שתיים");

  // ⚠️ והמונה **לא** זז: זו השבתה אחת שנקטעה, לא שתיים.
  assert.equal(ins.downtime.incidents, 1, "ההמשך נספר כאירוע נפרד");

  // וגם 'הארוכה ביותר' היא של האירוע כולו, לא של המקטע הראשון.
  assert.equal(ins.downtime.longestHours, 4);
});


test("⚠️ מקטע שסומן כניסוי אינו נספר בשני הצדדים", () => {
  const { forUptime, forInsights } = build({
    segments: [
      seg("ready", T(0), T(4)),
      seg("error", T(4), T(6)),
      seg("ready", T(6), T(9)),
      seg("error", T(9), T(11), { excluded_at: T(12) }),
      seg("ready", T(11), null),
    ],
    windows: [],
  });

  const ins = forInsights();
  const up = uptimeFromData(forUptime, SITE, { from: FROM, to: TO });

  assert.equal(ins.downtime.totalHours, up.errorHours);
  assert.equal(ins.downtime.totalHours, 2, "המקטע שהוצא נספר בכל זאת");
  assert.equal(ins.downtime.incidents, 1);
});


test("⚠️ חלון תחזוקה ידני מכסה — הזמן הוא תחזוקה, לא השבתה", () => {
  // תקלה 09:00–11:00, וחלון ידני 10:00–12:00 מכסה את מחציתה.
  const { forUptime, forInsights } = build({
    segments: [
      seg("ready", T(0), T(9)),
      seg("error", T(9), T(11)),
      seg("ready", T(11), null),
    ],
    windows: [{ site_id: SITE, started_at: T(10), expires_at: T(12), cancelled_at: null, excluded_at: null }],
  });

  const ins = forInsights();
  const up = uptimeFromData(forUptime, SITE, { from: FROM, to: TO });

  assert.equal(ins.downtime.totalHours, up.errorHours);
  assert.equal(ins.downtime.totalHours, 1, "השעה שבתוך החלון נספרה כהשבתה");
});


test("⚠️ חלון שסומן כניסוי אינו מכסה דבר", () => {
  // אותו תרחיש, אלא שהחלון סומן כניסוי — ולכן התקלה חוזרת במלואה.
  const { forUptime, forInsights } = build({
    segments: [
      seg("ready", T(0), T(9)),
      seg("error", T(9), T(11)),
      seg("ready", T(11), null),
    ],
    windows: [{ site_id: SITE, started_at: T(10), expires_at: T(12), cancelled_at: null, excluded_at: T(13) }],
  });

  const ins = forInsights();
  const up = uptimeFromData(forUptime, SITE, { from: FROM, to: TO });

  assert.equal(ins.downtime.totalHours, up.errorHours);
  assert.equal(ins.downtime.totalHours, 2, "החלון בוטל לחצאין — כיסה למרות הסימון");
});


test("⚠️ שלוש הסיבות יחד — הן ביטלו זו את זו וכך שרדו", () => {
  const { forUptime, forInsights } = build({
    segments: [
      seg("ready", T(0), T(3)),
      seg("error", T(3), T(4)),                       // 1ש — נספרת
      seg("no_comm", T(4), T(4, 30)),
      seg("error", T(4, 30), T(5, 30)),               // המשך, 1ש — נמחקה בעבר
      seg("ready", T(5, 30), T(8)),
      seg("error", T(8), T(10), { excluded_at: T(14) }),   // ניסוי — לא נספרת
      seg("ready", T(10), T(15)),
      seg("error", T(15), T(17)),                     // מחציתה בחלון ידני
      seg("ready", T(17), null),
    ],
    windows: [{ site_id: SITE, started_at: T(16), expires_at: T(18), cancelled_at: null, excluded_at: null }],
  });

  const ins = forInsights();
  const up = uptimeFromData(forUptime, SITE, { from: FROM, to: TO });

  assert.equal(ins.downtime.totalHours, up.errorHours, "שני מספרים לאותו דבר");
  assert.equal(ins.downtime.totalHours, 3, "1 + 1 (המשך) + 0 (ניסוי) + 1 (חצי מכוסה)");
  assert.equal(ins.downtime.incidents, 2, "שתי השבתות — הריצוד אינו שלישית");
});
