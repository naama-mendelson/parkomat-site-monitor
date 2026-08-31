// tests/exec-series-sparse.test.js — הקישור בין השמטת השורות ל-fold.
//
// ============================================================
// ⚠️ למה בדיקה מבנית ולא התנהגותית
// ============================================================
// `executive_series_json` משמיטה שורה שכל השדות התורמים בה אפס — 91%
// מהשורות בשנה יומית, 922KB מול ~85KB. ההשמטה בטוחה **רק** כל עוד
// foldSeries קוראת בדיוק את השדות שהמסנן בודק.
//
// ⚠️ והבדיקה ההתנהגותית עיוורת לזה כאן: המקרה המסוכן הוא דלי שכולו
// תחזוקה (measured_hours=0, maintenance_hours>0), ובייצור יש **אפס**
// דליים כאלה. מסנן שגוי היה עובר את השוואת הייצור במלואה, ואז שעות
// תחזוקה אמיתיות היו נעלמות מהמסך ביום שבו אתר כלשהו יבלה יממה בתחזוקה.
//
// לכן: הרשימה ננעלת מבנית. שדה שביעי ב-fold מפיל את הבדיקה, ומי שמוסיף
// אותו נאלץ לגעת גם ב-SQL.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SHARED = fs.readFileSync(path.join(__dirname, "..", "..", "shared", "executive.mjs"), "utf8");
const SQL = fs.readFileSync(path.join(__dirname, "..", "db", "functions.postgres.sql"), "utf8");

// גוף fold בתוך foldSeries — לא כל הקובץ. שמות שדות מופיעים גם במקומות
// אחרים, וסריקה רחבה הייתה מדווחת "עבר" על סמך קוד שאינו רלוונטי.
const FOLD = (SHARED.match(/const fold = \(rows\) => \{[\s\S]*?\n  \};/) || [""])[0];

// המסנן ב-executive_series_json.
const FILTER = (SQL.match(/FROM public\.executive_series\(p_site_ids[\s\S]*?;/) || [""])[0];

test("⚠️ fold נקרא — אחרת הבדיקה בודקת מחרוזת ריקה", () => {
  assert.ok(FOLD.length > 100, "לא נמצא גוף fold ב-shared/executive.mjs");
  assert.ok(FILTER.includes("WHERE"), "לא נמצא המסנן ב-executive_series_json");
});

test("⚠️ כל שדה ש-fold קוראת מופיע במסנן ה-SQL", () => {
  // r.<field> בתוך fold — אלה השדות שקובעים אם לשורה יש השפעה.
  const read = [...new Set([...FOLD.matchAll(/\br\.([a-z_]+)\b/g)].map((m) => m[1]))].sort();
  assert.ok(read.length >= 6, `fold קוראת ${read.length} שדות בלבד — חשד לחילוץ שגוי`);

  const missing = read.filter((f) => !FILTER.includes(f));
  assert.deepEqual(missing, [],
    `fold קוראת שדות שהמסנן אינו בודק: ${missing.join(", ")} — שורה שנושאת רק אותם תושמט בשקט`);
});

test("⚠️ maintenance_hours נבדק במפורש — הוא המקרה שאין לו כיסוי בייצור", () => {
  // דלי שכולו תחזוקה: measured_hours=0 ו-maintenance_hours>0. אפס כאלה
  // בייצור, ולכן רק השורה הזו עומדת בינו לבין היעלמות שקטה.
  assert.match(FILTER, /maintenance_hours/,
    "המסנן אינו בודק maintenance_hours — דלי שכולו תחזוקה יושמט");
  assert.match(FILTER, /measured_hours/,
    "המסנן אינו בודק measured_hours — אתר שנמדד בלי פעולות ייעלם מממוצע הזמינות");
});

test("⚠️ opsOf גם היא נשענת על ההשמטה", () => {
  // מפת החום קוראת operations דרך opsOf, ושורה חסרה שם מחזירה 0 —
  // נכון רק משום ש-operations נמצא במסנן.
  const OPS_OF = (SHARED.match(/opsOf: \([\s\S]*?\},/) || [""])[0];
  assert.match(OPS_OF, /operations/, "opsOf השתנתה — ודאו שהשדה עדיין במסנן");
  assert.match(FILTER, /operations/, "operations אינו במסנן — מפת החום תאבד נתונים");
});
