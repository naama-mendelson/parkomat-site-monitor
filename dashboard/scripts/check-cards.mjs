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

// 2. רצפה לשם — כדי שהוא לא יתכווץ עד שייעלם.
//
// ⚠️ **הרצפה עברה מקום, וזה לא ניקיון.** קודם היא הייתה `min-width: 6ch`
// ב-CSS: בגישת ה-ellipsis הרוחב היה מה שהתכווץ, אז רצפת רוחב הגנה על
// השם. עכשיו **הפונט** הוא מה שמתכווץ והרוחב חייב להיות גמיש
// (`min-width: 0`), אחרת flex לא יקצה לשם את מה שנשאר והמדידה חסרת
// משמעות. אותה בדיקה בדיוק שהגנה קודם הפכה לחוסמת.
//
// הרצפה החדשה היא `minScale` ב-useFitName — כמה מותר להקטין לכל היותר.
const m = css.match(/\.card-name-text\s*{[^}]*}/);
if (!m) problems.push("לא נמצא .card-name-text ב-CSS");

const hookSrcForFloor = (() => {
  try { return readFileSync(resolve(HERE, "../src/hooks/useFitName.js"), "utf8"); }
  catch { return ""; }
})();
const floor = hookSrcForFloor.match(/minScale\s*=\s*(0?\.\d+)/);
if (!floor) problems.push("ל-useFitName אין minScale — השם יכול להתכווץ עד שייעלם");
else if (Number(floor[1]) < 0.4)
  problems.push(`‏minScale = ${floor[1]} — הקטנה כזו הופכת את השם לבלתי קריא`);
else ok.push(`לשם יש רצפת הקטנה (minScale = ${floor[1]})`);

// ⚠️ 2ב. **השם מוצג במלואו, על שורה אחת — הפונט מתכווץ, לא הטקסט**
//
// רצפת הרוחב לבדה לא הספיקה: שם ארוך קיבל ellipsis, והמשכו היה זמין רק
// ב-tooltip. כרטיס נסרק בעין ולא מרחפים מעליו, ושני אתרים באותו רחוב
// ("עמנואל הרומי 10" ו-"עמנואל הרומי 4") נראים זהים כשהם חתוכים — כלומר
// הקיצור לא רק מסתיר מידע, הוא מייצר **זהות שגויה**.
//
// ⚠️ גרסת ביניים נתנה לשם לעטוף לשורה שנייה. היא הוחלפה בבקשת המוצר:
// הכול על שורה אחת. הפתרון הוא שגודל הפונט נגזר מאורך השם ומרוחב
// הכותרת, ולא שהטקסט נחתך.
//
// ארבע טענות, וכל אחת מכסה מה שהאחרות לא:
if (m) {
  const rule = m[0];

  if (/text-overflow:\s*ellipsis/.test(rule))
    problems.push("‎.card-name-text עם text-overflow: ellipsis — השם ייחתך ב-\"...\"");
  else ok.push("אין ellipsis על שם האתר");

  // שורה אחת — זו הבקשה המפורשת.
  if (/white-space:\s*nowrap/.test(rule)) ok.push("השם נשאר על שורה אחת");
  else problems.push("‎.card-name-text בלי white-space: nowrap — השם יתפרס על כמה שורות");

  // ⚠️ `flex: 1` + `min-width: 0` הם מה שגורם ל-flex להקצות לשם את כל
  // מה שנשאר — ולכן `clientWidth` שלו הוא הרוחב האמיתי שיש לו.
  // בלעדיהם האלמנט מתרחב לפי התוכן, `clientWidth === scrollWidth`,
  // והמדידה ב-useFitName אף פעם לא תמצא שצריך להקטין.
  if (/flex:\s*1/.test(rule) && /min-width:\s*0/.test(rule))
    ok.push("‏flex מקצה לשם את הרוחב שנשאר — המדידה משמעותית");
  else problems.push("‎.card-name-text בלי flex:1 + min-width:0 — המדידה תמיד תראה שהכול נכנס");
}

// ============================================================
// 2ג. ההתאמה נמדדת, ולא מחושבת מנוסחה
// ============================================================
// ⚠️ **גרסה קודמת חישבה את גודל הפונט ב-CSS** מאורך השם ומרוחב הכותרת,
// ונכשלה על המסך: היא הניחה שרק קוד האתר יושב לצד השם, בזמן שב-normal
// יש שם גם תג סוג ותג דרגה שרוחבם משתנה עם הטקסט שבתוכם. אין קבוע נכון,
// ולכן חייבים למדוד.
const hookPath = resolve(HERE, "../src/hooks/useFitName.js");
let hook = "";
try { hook = readFileSync(hookPath, "utf8"); }
catch { problems.push("useFitName.js חסר — אין מי שיתאים את גודל השם"); }

if (/useFitName\s*\(/.test(jsx.replace(/\/\*[\s\S]*?\*\//g, "")))
  ok.push("הכרטיס קורא ל-useFitName על שם האתר");
else problems.push("הכרטיס אינו קורא ל-useFitName — השם ייחתך");

if (hook) {
  // הקוד בלבד, בלי הערות — ראה הנימוק אצל useLayoutEffect למטה.
  //
  // ⚠️ **מוגדר בראש הבלוק, וזה לא סגנון.** בדיקה שנוספה מעל ההגדרה
  // הפילה את השער כולו ב-ReferenceError (‏const ב-TDZ), והפלט נראה כמו
  // קריסה אקראית ולא כמו בדיקה שנכשלה — כלומר שער שקוף במקום אדום.
  const hookCode = hook
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");

  // ⚠️ **הבאג שהורג את התכונה בשקט:** בלי איפוס לפני המדידה, כל ריצה
  // מודדת פונט שכבר הוקטן ומקטינה שוב — עד שהשם נעלם. זו הטענה
  // החשובה ביותר כאן, כי התוצאה שלה נראית כמו "עיצוב", לא כמו תקלה.
  if (/style\.fontSize\s*=\s*""/.test(hook))
    ok.push("הגודל מאופס לפני כל מדידה — אין הקטנה מצטברת");
  else problems.push("useFitName אינו מאפס לפני מדידה — השם יתכווץ בכל ריצה עד שייעלם");

  // ⚠️ **ורוחב הטקסט נמדד ב-Range, לא ב-scrollWidth.** בעברית
  // הגלישה יוצאת לכיוון ההפוך, ויש דפדפנים שמדווחים אז
  // `scrollWidth === clientWidth` גם כשהטקסט חורג — כלומר ה-hook
  // היה מסיק "הכול נכנס" ולא מקטין כלום. הכשל נראה
  // זהה לבאג המקורי, וזו הסיבה שהוא נעול כאן.
  if (/measureText/.test(hookCode))
    ok.push("רוחב הטקסט נמדד בקנבס — אפשר למדוד מועמד בלי להציג אותו");
  else problems.push("useFitName אינו מודד בקנבס — אי אפשר לבדוק קיצור לפני שמציגים אותו");

  // ⚠️ **ומדידה מחדש אחרי שהפונט נטען.** המדידה הראשונה נעשית
  // על פונט הנפילה-לאחור, וכשהפונט האמיתי מגיע הטקסט מתרחב —
  // ו-ResizeObserver אינו נורה, כי רוחב הכרטיס לא זז. התוצאה היא
  // בדיוק הבאג המקורי, ודווקא בטעינה הראשונה.
  if (/fonts\?*\.?ready/.test(hookCode))
    ok.push("נמדד מחדש אחרי שהפונט נטען");
  else problems.push("useFitName אינו מודד מחדש אחרי טעינת הפונט — השם ייחתך בטעינה הראשונה");

  // ⚠️ הכרטיס משנה רוחב בלי שהשם משתנה: שינוי חלון, מעבר רמת צפיפות,
  // פתיחת הכרטיס. בלי מעקב, הגודל נשאר זה שחושב לרוחב אחר.
  if (/ResizeObserver/.test(hook))
    ok.push("הגודל נמדד מחדש כשהכרטיס משנה רוחב");
  else problems.push("useFitName בלי ResizeObserver — הגודל לא יתעדכן בשינוי רוחב");

  // ⚠️ useEffect במקום useLayoutEffect מייצר הבהוב: השם מצויר בגודל מלא
  // ואז קופץ לגודל המוקטן.
  //
  // ⚠️ **נדרשת הקריאה, לא האזכור.** הגרסה הראשונה חיפשה את המילה בקובץ,
  // ומוטציה שהחליפה את הקריאה ל-useEffect עברה בשקט — כי השם נשאר
  // ב-import ובהערה שמסבירה אותו. זו הפעם השנייה באותו קובץ שהשער
  // אישר תיעוד במקום קוד, ולכן `hookCode` (בראש הבלוק) חותך הערות.
  if (/useLayoutEffect\s*\(/.test(hookCode))
    ok.push("המדידה לפני הציור — בלי הבהוב");
  else problems.push("useFitName אינו קורא ל-useLayoutEffect — יהיה הבהוב בכל טעינה");
}

// 3. title על השם — ב-compact הוא מקוצר, וזו הדרך היחידה לראות אותו מלא
//    בלי לפתוח את הכרטיס.
// ⚠️ רג'קס רחב יותר מקודם: הוא דרש ש-title יבוא בדיוק אחרי
// ה-className באותה שורה, ולכן הוספת style ביניהם הפילה אותו על קוד
// תקין לגמרי. שער שנשבר מעיצוב שורות הוא שער שמלמדים להתעלם ממנו.
const nameTag = jsx.match(/<span[^>]*className="card-name-text"[\s\S]{0,220}?>/);
if (nameTag && /title=/.test(nameTag[0])) ok.push("‏title על שם האתר");
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
