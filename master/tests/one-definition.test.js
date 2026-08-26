// tests/one-definition.test.js — הגדרה אחת ל"כמה תקלות", ולא שלוש.
//
// ============================================================
// ⚠️ הכרטיס ומסך האתר סתרו זה את זה, זה ליד זה
// ============================================================
// `getSiteStats` היה **מימוש שלישי** של אותו מדד, עם שאילתות משלו — ובלי
// שניים מהכללים שכל שאר המערכת מחילה:
//
//   • **קיפול ריצוד** — `error → no_comm → error` נספר כשתי תקלות
//   • **excluded_at** — מקטע שמנהל סימן כניסוי נספר בכל זאת
//
// והוא מאכלס בדיוק את המסכים הצמודים: הכרטיס ברשימה מגיע מ-`site_stats`
// (SQL, מאומת ב-parity), ומסך האתר הגיע מכאן. נמדד בייצור על שבוע אחד —
// **חמישה אתרים מתוך חמישה-עשר** סתרו את עצמם:
//
//     אוסישקין 58   כרטיס 10   מסך האתר 11
//     סוקולוב 10    כרטיס  4   מסך האתר  5
//     הנוטרים 7     כרטיס  0   מסך האתר  1
//
// ⚠️ **וגם הבוט ענה מכאן.** על "כמה תקלות היו באוסישקין החודש" הוא החזיר
// 22 בזמן שהמסך הראה 18 — מספר סמכותי שסותר את המסך שלידו.
//
// ⚠️ ושער ה-parity לא יכול היה לתפוס: הוא משווה site_stats מול
// statsFromData, ושניהם עשו את זה נכון. הפונקציה פשוט לא הייתה בשער.
// לכן הבדיקה הזו על **המקור** — היא שומרת שלא ייווצר מימוש רביעי.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "db", "queries.js"), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const bodyOf = (name) => {
  const code = strip(SRC);
  const re = new RegExp("^async function " + name + "\\([\\s\\S]*?^}", "m");
  const m = code.match(re);
  assert.ok(m, name + " לא נמצאה");
  return m[0];
};


test("⚠️ getSiteStats עוטף את ההגדרה המשותפת ואינו סופר בעצמו", () => {
  const fn = bodyOf("getSiteStats");

  assert.match(fn, /statsFromData\(/, "אינו משתמש בהגדרה המשותפת");
  assert.match(fn, /loadRangeData\(/, "אינו טוען דרך המסלול המשותף");

  // ⚠️ הסימנים של מימוש עצמאי: ספירה ידנית וסיווג תחזוקה משלו.
  assert.doesNotMatch(fn, /errors\+\+/, "סופר תקלות בעצמו");
  assert.doesNotMatch(fn, /wasInMaintenanceMem/, "מסווג תחזוקה בעצמו");
  assert.doesNotMatch(fn, /FROM status_history/, "שולף מקטעים בעצמו");
});


test("⚠️ getUptimeBreakdown נשאר עוטף — התקדים שממנו נגזר התיקון", () => {
  const fn = bodyOf("getUptimeBreakdown");
  assert.match(fn, /uptimeFromData\(/);
  assert.doesNotMatch(fn, /FROM status_history/);
});


// ⚠️ שלוש הפונקציות האלה נוגעות במקטעי תקלה **ואינן סופרות מדד**, ולכן
// הן אינן מימוש נוסף. הרשימה מפורשת ולא דפוס, כדי שהוספה שקטה של פונקציה
// סופרת רביעית תיפול כאן.
const NOT_A_METRIC = new Set([
  "fillFaultTextIfMissing",   // ממלאת תיאור, לא סופרת
  "getLastFaultAt",           // מחזירה חותם, לא כמות
  "getCardFaultCorrelation",  // מתאם כרטיס↔תקלה — מדד אחר לגמרי, ובכוונה
  "getAllSitesGlobals",       // מחזירה חותם התקלה האחרונה, לא כמות
]);

test("⚠️ אין מימוש רביעי — הספירה חיה במקום אחד", () => {
  const code = strip(SRC);

  // ⚠️ `statsFromData` הוא היחיד שמותר לו לספור. כל פונקציה אחרת
  // ב-queries.js שסופרת תקלות בעצמה היא מימוש נוסף שייפרד בשקט.
  const selfCounting = [...code.matchAll(/^async function (\w+)\([\s\S]*?^}/gm)]
    .filter(([body, name]) =>
      name !== "loadRangeData" &&
      !NOT_A_METRIC.has(name) &&
      /COALESCE\(reclassified_to, status\) = 'error'/.test(body) &&
      !/statsFromData|site_stats|site_segments_collapsed/.test(body))
    .map(([, name]) => name);

  assert.deepEqual(selfCounting, [],
    `פונקציות שסופרות תקלות לבדן: ${selfCounting.join(", ")}`);
});
