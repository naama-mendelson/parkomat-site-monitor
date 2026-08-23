// tools/check-effective-status.js — כל קורא של status_history חייב לקרוא את
// הסטטוס ה**אפקטיבי**.
//
// ============================================================
// ⚠️ למה השער הזה נכתב: באג אמיתי, ולא חשש תיאורטי
// ============================================================
// כשנוסף הסיווג מחדש (`reclassified_to`), הוחל `COALESCE` בשתי פונקציות —
// `site_uptime` ו-`site_segments_collapsed` — ונשכח ב-**אחת-עשרה** שאילתות
// אחרות. התוצאה שנמדדה: הזמינות ואחוז הכשל זזו כשמסווגים תקלה כתחזוקה,
// אבל כרטיס האתר המשיך להציג אותה כ"התקלה האחרונה", והדוחות ספרו אותה
// כתקלה — ולא כתחזוקה. **שני מספרים לאותו אירוע**, שזה הכשל שהכי קשה לאתר.
//
// ============================================================
// ⚠️ ולמה parity לא יכול לתפוס את זה
// ============================================================
// שער ה-parity משווה את זרוע ה-JS מול זרוע ה-SQL. הבאג היה **בשתי
// הזרועות** — שתיהן קראו `status` גולמי — ולכן הן הסכימו זו עם זו לחלוטין
// והשער היה ירוק. זה בדיוק מה ש-CLAUDE.md מזהיר עליו: השוואה מוכיחה
// שקיימות שתי מימושים תואמים, לא שההגדרה נכונה.
//
// לכן שער סטטי, שקורא את הטקסט ולא את המספרים.
const fs = require("node:fs");
const path = require("node:path");

const FILES = [
  "db/functions.postgres.sql",
  "db/queries.js",
];

// ⚠️ **רשימת היתר מפורשת, לא ניחוש.** שני הכינויים האלה אינם עמודות של
// status_history אלא פלט של CTE/פונקציה שכבר החילו את COALESCE:
//   v — ה-CTE הפנימי של site_uptime, שנבנה מהבסיס המקואלס
//   c — הפלט של site_segments_collapsed, שאין בו בכלל reclassified_to
// הוספת כינוי לכאן היא החלטה שצריך לנמק, וזו בדיוק הכוונה.
const ALLOWED_ALIASES = new Set(["v", "c"]);

const PATTERN = /(?:(\w+)\.)?status\s*=\s*'(error|maintenance)'/g;

const problems = [];
let scanned = 0;

for (const rel of FILES) {
  const file = path.resolve(__dirname, "..", rel);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

  lines.forEach((line, i) => {
    // שורת הערה אינה קוד. ב-SQL '--' וב-JS '//'.
    const t = line.trim();
    if (t.startsWith("--") || t.startsWith("//") || t.startsWith("*")) return;

    for (const m of line.matchAll(PATTERN)) {
      scanned++;
      const alias = m[1] || null;
      if (alias && ALLOWED_ALIASES.has(alias)) continue;

      // ⚠️ הבדיקה היא על מה שקדם להתאמה **באותה שורה**: הצורה התקינה היא
      // `COALESCE(x.reclassified_to, x.status) = '...'`, ולכן המילה
      // reclassified_to חייבת להופיע ממש לפני.
      const before = line.slice(0, m.index);
      if (/COALESCE\(\s*(\w+\.)?reclassified_to,\s*$/.test(before.replace(/\(?\s*$/, "") + "")
          || /reclassified_to,\s*(\w+\.)?$/.test(before)) continue;

      problems.push({ rel, line: i + 1, text: t.slice(0, 110) });
    }
  });
}

// ============================================================
// ⚠️ סופרים גם את הצורה **התקינה**, ולא רק את החריגות
// ============================================================
// הצורה הנכונה — `COALESCE(x.reclassified_to, x.status) = '...'` — אינה
// תואמת לתבנית החיפוש כלל, ולכן שער שסופר רק התאמות היה מדפיס "נסרקו 5,
// נקי" גם אם מישהו היה מוחק את שני הקבצים. מונה הצורות התקינות הוא מה
// שהופך "עבר" לטענה על קוד שנקרא באמת.
const correct = FILES.reduce((n, rel) => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
  return n + (src.match(/COALESCE\(\s*(?:\w+\.)?reclassified_to,/g) || []).length;
}, 0);

console.log("=".repeat(60));
console.log(`נסרקו ${scanned} תנאי status · נמצאו ${correct} קריאות מקואלסות`);

// ⚠️ אפס קריאות מקואלסות פירושו שהתיקון כולו נעלם — לא שהכול תקין.
if (correct < 20) {
  console.log("=".repeat(60));
  console.log(`❌ רק ${correct} קריאות מקואלסות — צפויות 20 ומעלה. התיקון הוסר?`);
  process.exit(1);
}

if (problems.length === 0) {
  console.log("=".repeat(60));
  console.log("✅ כל קורא של status_history קורא את הסטטוס האפקטיבי");
  process.exit(0);
}

for (const p of problems) {
  console.log(`  ❌ ${p.rel}:${p.line}`);
  console.log(`     ${p.text}`);
}
console.log("=".repeat(60));
console.log(`❌ ${problems.length} שאילתות קוראות status גולמי`);
console.log("   התיקון: COALESCE(<כינוי>.reclassified_to, <כינוי>.status) = '...'");
process.exit(1);
