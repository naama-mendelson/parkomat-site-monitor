// scripts/check-bundle.mjs — האם המסכים שנבנו באמת נמצאים בקובץ שנשלח לדפדפן.
//
//   npm run build && npm run check:bundle
//
// ============================================================
// ⚠️ הכשל שזה בא לתפוס, וקרה
// ============================================================
// ב-22/09/2026 השורה `export default function TrafficLight` נחתכה באמצע
// בעריכה אוטומטית. נשאר `export default f` יתום, והפונקציה הפכה להצהרה
// רגילה בלי יצוא.
//
// ⚠️ **והבנייה עברה בהצלחה.** מודול בלי יצוא ברירת מחדל מחזיר undefined,
// כל מה שבתוכו אינו מוזכר עוד, והמאגד מוחק אותו כקוד מת. הלוח כולו —
// טבלה, עמודות, הדבקה מ-Excel — נעלם מה-bundle בלי שגיאה אחת, ומה שנראה
// על המסך היה "לא רואה כלום".
//
// שלוש בדיקות ירוקות פספסו את זה: הבנייה (עברה), ה-lint (הקוד תקין),
// ושער המתג (קורא את המקור). כולן מסתכלות על **הקוד**; אף אחת לא שאלה
// מה יצא בצד השני.
//
// ⚠️ ולכן הבדיקה כאן היא על הפלט בלבד. היא אינה מכירה את המקור, ואי אפשר
// לספק אותה בכך שכותבים את המחרוזת איפשהו — היא חייבת לשרוד את המאגד.
//
// ⚠️ **מה שנבדק הוא מחרוזות שאין להן קיום אלא ברכיב עצמו** — שם מחלקה או
// טקסט שמוצג למשתמש. לא שם הפונקציה: מאגד רשאי לשנות אותו, ובדיקה
// שנשענת עליו תידלק על מיניפיקציה תקינה.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");

// מסך → מחרוזת שקיימת בו בלבד.
const SCREENS = [
  ["לוח הרמזור",        "tl-table"],
  ["תצוגת הפסים",       "tl-bands"],
  ["ניהול אתרים",       "adm-list"],
  ["באנר נתונים ישנים", "stale-banner"],
  ["זהויות אתרים",      "si-table"],
  ["סינון סוג ומערכת",  "sft-select"],
  ["כרטיס אתר",         "site-card"],
  // ⚠️ המחרוזת נלקחה **מהמקור**, ולא מהזיכרון: שני ניסיונות קודמים כאן
  // (`ff-link`, `ffl-open`) היו שמות שאינם קיימים — כלומר שער שצועק על
  // קוד תקין, וזו הדרך הבטוחה לגרום למישהו לכבות אותו.
  ["תקלות ופתרונות",    "ffl-text"],
  ["ספריית התקלות במסגרת", "fff-back"],
];

let files;
try {
  files = readdirSync(DIST).filter((f) => f.endsWith(".js"));
} catch {
  console.error("⛔ אין תיקיית dist. יש להריץ `npm run build` קודם.");
  process.exit(2);
}
if (files.length === 0) { console.error("⛔ לא נמצא קובץ JS ב-dist."); process.exit(2); }

// ⚠️ מאוחדים לטקסט אחד: חלוקה לקטעים היא החלטה של המאגד, ובדיקה שמניחה
// קובץ יחיד תישבר ביום שהוא יחליט לפצל — ותיראה כמו תקלה אמיתית.
const bundle = files.map((f) => readFileSync(join(DIST, f), "utf8")).join("\n");
const bytes = files.reduce((n, f) => n + statSync(join(DIST, f)).size, 0);

let missing = 0;
for (const [screen, needle] of SCREENS) {
  const ok = bundle.includes(needle);
  if (!ok) missing++;
  console.log(`  ${ok ? "✅" : "❌"} ${screen.padEnd(20)} ${needle}`);
}

console.log(`\n${files.length} קבצים · ${(bytes / 1024).toFixed(0)}KB`);
if (missing) {
  console.error(`\n⛔ ${missing} מסכים אינם בקובץ שנבנה.`);
  console.error("   הסיבה השכיחה: הרכיב איבד את `export default`, ולכן נמחק כקוד מת.");
  process.exit(1);
}
console.log("✅ כל המסכים נמצאים בקובץ שנבנה.");
