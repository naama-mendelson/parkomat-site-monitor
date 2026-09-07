// scripts/check-cards.mjs — שם האתר חייב להישאר קריא בכרטיס.
//
// ============================================================
// ⚠️ למה זה קיים: באג שנראה על המסך, לא בקוד
// ============================================================
// ב-06/09/2026 עברנו מ-19 ל-21 אתרים, וזה חצה את סף ה-`compact`
// (מעל 20). הכרטיס ירד ל-190px, והכותרת המשיכה להחזיק שם + תג סוג +
// תג דרגה + קוד. ה-CSS קבע שה**שם** הוא זה שמתכווץ.
//
// התוצאה שנמדדה: 19 מתוך 21 כרטיסים הציגו שתיים־שלוש אותיות —
// "הר...", "אוס...", "נ." — כלומר רשת שלמה שאי אפשר לקרוא. ושני
// היוצאים מן הכלל היו בדיוק האתרים שאין להם `plc_type`, כלומר שבהם
// התג לא נוצר. זה מה שהצביע על הסיבה.
//
// ⚠️ ותג הדרגה אמר "בסיסי" ב**כל** 21 הכרטיסים: אפס מידע מבחין, על
// חשבון הדבר היחיד שכן מבחין ביניהם.
//
//   npm run check:cards
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const jsx = readFileSync(resolve(HERE, "../src/components/SiteCard/SiteCard.jsx"), "utf8");
const css = readFileSync(resolve(HERE, "../src/components/SiteCard/SiteCard.css"), "utf8");

const problems = [];
const ok = [];

// 1. התגים בכותרת **המצומצמת** מופיעים רק ב-normal. `!isMini` מחזיר
//    אותם ל-compact, שם הם אוכלים את השם — וזה בדיוק המצב שהיה.
//
// ⚠️ **רק הכותרת, לא כל הקובץ.** אותם תגים מופיעים גם בכרטיס המורחב
// (`exp-name`), ושם הם רצויים: יש מקום בשפע. גרסה ראשונה של הבדיקה
// בחנה את ההופעה הראשונה בקובץ, נפלה על הכרטיס המורחב, ודיווחה על
// באג בקוד תקין — בדיוק סוג הבדיקה שמלמדים להתעלם ממנה.
const headStart = jsx.indexOf('<div className="card-header">');
const headEnd = jsx.indexOf('card-code', headStart);
if (headStart < 0 || headEnd < 0) {
  problems.push("לא נמצאה הכותרת המצומצמת (card-header)");
} else {
  const header = jsx.slice(headStart, headEnd);
  for (const badge of ["TypeBadge", "TierBadge"]) {
    const line = header.split("\n").find((l) => l.includes(`<${badge} `));
    if (!line) { ok.push(`${badge} אינו בכותרת המצומצמת כלל`); continue; }
    if (/isNormal &&/.test(line)) ok.push(`${badge} בכותרת מוצג רק ב-normal`);
    else problems.push(`${badge} מוצג בכותרת גם ב-compact — הוא יאכל את שם האתר: ${line.trim()}`);
  }
}

// 2. רצפת רוחב לשם. הרשת השנייה: גם אם יתווסף אלמנט לכותרת, השם לא
//    ייעלם בשקט אלא ידחוף את מה שלידו.
const m = css.match(/\.card-name-text\s*{[^}]*}/);
if (!m) problems.push("לא נמצא .card-name-text ב-CSS");
else if (/min-width:\s*0\b/.test(m[0]))
  problems.push("‎.card-name-text עם min-width: 0 — השם יכול להתכווץ לאפס");
else if (/min-width:\s*\d+ch/.test(m[0]))
  ok.push("לשם יש רצפת רוחב במידת תווים");
else problems.push("‎.card-name-text בלי רצפת רוחב");

// 3. title על השם — ב-compact הוא מקוצר, וזו הדרך היחידה לראות אותו מלא
//    בלי לפתוח את הכרטיס.
if (/className="card-name-text" title=/.test(jsx)) ok.push("‏title על שם האתר");
else problems.push("אין title על שם האתר — שם מקוצר אינו ניתן לקריאה בכלל");

// 4. הצפיפות נגזרת מהמקום שיש, לא ממספר האתרים בלבד.
//
// ⚠️ הכלל הישן ("מעל 20 → compact") התעלם מהמסך: 21 אתרים על מסך רחב
// קיבלו כרטיסים מצומצמים בזמן שרוב המסך היה ריק. חזרה אליו היא חזרה
// לאותה תצוגה, ולכן היא נאסרת כאן ולא רק מתוקנת פעם אחת.
const grid = readFileSync(resolve(HERE, "../src/components/SiteGrid/SiteGrid.jsx"), "utf8");
if (/resolveDensity\s*\(\s*sites\.length\s*\)/.test(grid))
  problems.push("הצפיפות נקבעת ממספר האתרים בלבד — כרטיסים יתכווצו גם כשיש מקום");
else if (/densityFor\(sites\.length,\s*box\.w,\s*box\.h\)/.test(grid))
  ok.push("הצפיפות נגזרת מהרוחב והגובה שנמדדו");
else problems.push("לא נמצאה קריאה ל-densityFor עם המידות שנמדדו");

// ⚠️ ומדידת הגובה חייבת להאזין ל-resize של החלון: ResizeObserver על
// הרשת אינו נורה כששינוי הגובה אינו משנה את הרוחב.
if (/window\.addEventListener\("resize"/.test(grid)) ok.push("שינוי גובה החלון מודד מחדש");
else problems.push("אין האזנה ל-resize — שינוי גובה החלון לא ישנה צפיפות");

// 5. "טיפול בתקלה" והגרף אינם על הכרטיס — הם עברו לפירוט המלא.
//
// ⚠️ החלטת מוצר, ולא עניין של מקום: הכרטיס עונה על "מי דורש טיפול
// עכשיו", וזמן טיפול ממוצע הוא שאלת ניתוח. והצירוף שם היה יקר במיוחד:
// הממוצע לבדו מטעה (10% התקלות הארוכות הן 68% מזמן התקלה), ולכן הוא
// חייב את הגרף לצדו — שני אלמנטים לשאלה שאיש אינו שואל בזמן סריקה.
for (const forbidden of ["RepairChart", "avgRepairMinutes", "medianRepairMinutes"]) {
  if (jsx.includes(forbidden))
    problems.push(`${forbidden} חזר לכרטיס — מקומו בפירוט המלא`);
}
if (!problems.some((p) => p.includes("חזר לכרטיס")))
  ok.push("זמן הטיפול והגרף אינם על הכרטיס");

// ...ובאמת נמצאים בפירוט המלא. בלי זה "הוסר מהכרטיס" יכול להיות גם
// "נמחק מהמערכת", ואלה שתי תוצאות שונות מאוד.
const modal = readFileSync(
  resolve(HERE, "../src/components/InsightsModal/InsightsModal.jsx"), "utf8");
if (modal.includes("<RepairChart") && modal.includes("avgRepairMinutes"))
  ok.push("זמן הטיפול והגרף נמצאים בפירוט המלא");
else problems.push("זמן הטיפול/הגרף אינם בפירוט המלא — הם נמחקו ולא הועברו");

console.log("=".repeat(58));
for (const o of ok) console.log("  ✅ " + o);
for (const p of problems) console.log("  ❌ " + p);
console.log("=".repeat(58));
if (problems.length) {
  console.log(`❌ ${problems.length} בעיות בקריאוּת הכרטיס`);
  process.exit(1);
}
console.log("✅ שם האתר נשאר קריא בכל רמות הצפיפות");
