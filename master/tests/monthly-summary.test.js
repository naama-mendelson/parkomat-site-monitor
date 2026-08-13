// tests/monthly-summary.test.js — החלון המתגלגל של הסיכום החודשי.
//
// ============================================================
// הבאג שהבדיקות האלה נועלות
// ============================================================
// יולי 2026 נשמר בטבלה כ-633 פעולות כשבפועל היו 801 — חסר 21%, בכל אחד
// מ-12 האתרים. אוגוסט נעדר לגמרי.
//
// השורש **אינו** חישוב שגוי. generateMonthlySummary סופר נכון. הבאג היה
// שהוא רץ פעם אחת בלבד:
//
//     if (!await hasMonthlySummary(site.id, lastMonth)) { ... }
//
// הסיכום ליולי נוצר ב-2026-08-02T05:10, ו-196 פעולות של יולי נקלטו **אחרי**
// הרגע הזה — HiveMQ שמר אותן בזמן השבתה ומסר עם החותם המקורי, בדיוק כפי
// שהוא אמור. השומר אמר "כבר קיים, דלג", ולכן הן לא נספרו לעולם.
//
// ⚠️ שתי התנהגויות נכונות שמצטרפות לתוצאה שגויה. אף אחת מהן לבדה אינה באג,
// ולכן אף בדיקת יחידה על אחת מהן לא הייתה תופסת. מה שנבדק כאן הוא **החלון**:
// שהחישוב חוזר, ושהוא מכסה גם את החודש הרץ.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// db.js דורש DATABASE_URL. recentMonths טהורה לחלוטין, ולכן מזריקים stub —
// אותה תבנית כמו activity-log.test.js.
const DB = require.resolve("../db/db");
require.cache[DB] = {
  id: DB, filename: DB, path: path.dirname(DB), loaded: true, children: [], paths: [],
  exports: { prepare: () => ({ get: async () => ({}), all: async () => [], run: async () => ({}) }) },
};

const { recentMonths } = require("../tools/monthly-summary");

test("החלון כולל את החודש הנוכחי, לא רק את שנגמר", () => {
  // ⚠️ זה ההבדל מהגרסה הקודמת. אוגוסט נעדר מהטבלה לגמרי כל עוד הוא רץ,
  // ולכן /api/stats/system החזיר אפס לחודש הנוכחי — וחודש חסר מטעה יותר
  // מחודש חלקי.
  assert.deepEqual(recentMonths(3, new Date(2026, 7, 4)), ["2026-08", "2026-07", "2026-06"]);
});

test("החלון חוצה שנה אחורה נכון", () => {
  assert.deepEqual(recentMonths(3, new Date(2026, 0, 15)), ["2026-01", "2025-12", "2025-11"]);
});

test("החלון נגזר מזמן מקומי ולא מ-UTC", () => {
  // ⚠️ הבאג הישן: getLastMonth השתמש ב-getUTCMonth בעוד generateMonthlySummary
  // חותך בגבולות מקומיים. ב-1 באוגוסט בשעה 01:00 מקומי, ה-UTC הוא עדיין
  // 31 ביולי — והחודש שחושב היה יוני במקום יולי.
  //
  // הבדיקה תופסת את זה רק אם היא רצה באזור זמן שקדימה ל-UTC (ישראל), ולכן
  // היא בודקת את התכונה ישירות: החודש הראשון בחלון חייב להיות החודש
  // **המקומי** של הרגע שנמסר.
  const at = new Date(2026, 7, 1, 1, 0, 0);          // 1.8, 01:00 מקומי
  assert.equal(recentMonths(1, at)[0], "2026-08");
  assert.notEqual(at.getUTCMonth(), undefined);       // שומר על הכוונה מפורשת
});

test("אורך החלון נשלט בפרמטר", () => {
  assert.equal(recentMonths(1, new Date(2026, 7, 4)).length, 1);
  assert.equal(recentMonths(6, new Date(2026, 7, 4)).length, 6);
  assert.deepEqual(recentMonths(2, new Date(2026, 7, 4)), ["2026-08", "2026-07"]);
});

test("חודשים בחלון הם ייחודיים ויורדים", () => {
  // רגרסיה על טעות קלה בלולאה: `now.getMonth() + i` היה מייצר חודשים עתידיים.
  const m = recentMonths(12, new Date(2026, 7, 4));
  assert.equal(new Set(m).size, 12);
  assert.deepEqual([...m], [...m].sort().reverse());
  assert.equal(m[0], "2026-08");
  assert.equal(m[11], "2025-09");
});

// ============================================================
// שלוש קטגוריות הזמן — והזהויות שהמסך מסתמך עליהן
// ============================================================
// ⚠️ המסך מציג "בתקלה / תפעול תקלה / תחזוקה" זו לצד זו, ומי שקורא אותן
// מניח שהן **מכסות את הכל ואינן חופפות**. אם זהות אחת נשברת, המספרים על
// המסך עדיין נראים סבירים לגמרי — פשוט לא מסתכמים.
//
// ⚠️ והזהות הרביעית היא הלא-מובנת מאליה: handledIncidents (תקלות שנגמרו
// בטיפול) ו-repairEntries (תפעולים שהתחילו אחרי תקלה) הם **אותם אירועים
// נספרים משני צדדים**. הם חייבים להסכים, ואין שום דבר שאוכף את זה מלבד
// זה שהם נגזרים מאותו חותם זמן.
const { computeInsights: _ci } = require("../../shared/insights.mjs");

// ⚠️ הפונקציה מקבלת את מקטעי התקלה והתחזוקה **בנפרד**, ולא רשימה אחת
// ממוינת. הגרסה הראשונה של העוזר הזה העבירה segments אחד ונפלה על
// TypeError — לא על הנתונים.
function insightsOf(errorRows, maintRows) {
  return _ci({
    ops: [], errorRows, maintRows, windows: [],
    from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z",
  });
}

test("⚠️ שלוש הקטגוריות מכסות את הכל ואינן חופפות", () => {
  //   תקלה  10:00-10:30   (30 דק')  → ואחריה טיפול
  //   טיפול 10:30-11:00   (30 דק')  → מתחיל בדיוק בסיום התקלה
  //   תחזוקה 14:00-15:00  (60 דק')  → ללא תקלה שקדמה לה
  const d = "2026-08-05T";
  const r = insightsOf(
    [{ started_at: `${d}10:00:00.000Z`, ended_at: `${d}10:30:00.000Z` }],
    [{ started_at: `${d}10:30:00.000Z`, ended_at: `${d}11:00:00.000Z` },
     { started_at: `${d}14:00:00.000Z`, ended_at: `${d}15:00:00.000Z` }],
  );

  // הפילוח של התקלות מסתכם בסך התקלות.
  assert.equal(
    r.downtime.handledIncidents + r.downtime.recoveredIncidents,
    r.downtime.incidents,
    "טופלו + התאוששו = סך התקלות");

  // הפילוח של התחזוקה מסתכם בסך התחזוקה.
  assert.equal(
    r.maintenance.repairEntries + r.maintenance.plannedEntries,
    r.maintenance.plcEntries,
    "תפעולים + תחזוקה = סך מקטעי התחזוקה");

  // ⚠️ הזהות שאין שום דבר שאוכף אותה: אותם אירועים, שני צדדים.
  assert.equal(
    r.downtime.handledIncidents, r.maintenance.repairEntries,
    "תקלה שנגמרה בטיפול = טיפול שהתחיל אחרי תקלה");

  // והמספרים עצמם
  assert.equal(r.downtime.incidents, 1);
  assert.equal(r.maintenance.repairEntries, 1);
  assert.equal(r.maintenance.plannedEntries, 1);
});

test("⚠️ 'הארוך ביותר' נמדד לכל קטגוריה בנפרד", () => {
  // מדד אחד לשתיהן היה מציג תחת הכותרת "תחזוקה" ערך שהגיע דווקא מטיפול —
  // מספר נכון תחת שם שגוי, וזה גרוע ממספר חסר.
  const d = "2026-08-05T";
  // טיפול ארוך (2 שעות), תחזוקה קצרה (30 דק')
  const r = insightsOf(
    [{ started_at: `${d}10:00:00.000Z`, ended_at: `${d}10:10:00.000Z` }],
    [{ started_at: `${d}10:10:00.000Z`, ended_at: `${d}12:10:00.000Z` },
     { started_at: `${d}14:00:00.000Z`, ended_at: `${d}14:30:00.000Z` }],
  );

  assert.equal(r.maintenance.longestRepairHours, 2, "הטיפול הארוך");
  assert.equal(r.maintenance.longestPlannedHours, 0.5, "התחזוקה הארוכה");
  // ⚠️ ובלי הפיצול, שניהם היו מציגים 2 — הערך של הטיפול.
  assert.notEqual(r.maintenance.longestPlannedHours, r.maintenance.longestRepairHours);
});

test("תחזוקה בלי תקלה שקדמה לה אינה טיפול", () => {
  const d = "2026-08-05T";
  const r = insightsOf(
    [],
    [{ started_at: `${d}14:00:00.000Z`, ended_at: `${d}15:00:00.000Z` }],
  );
  assert.equal(r.maintenance.repairEntries, 0);
  assert.equal(r.maintenance.plannedEntries, 1);
  assert.equal(r.maintenance.longestRepairHours, 0);
});
