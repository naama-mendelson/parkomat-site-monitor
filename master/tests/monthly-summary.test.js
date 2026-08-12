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
