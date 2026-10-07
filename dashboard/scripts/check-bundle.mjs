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

// ⚠️ ארגומנט אופציונלי — תיקיית בנייה אחרת (בנייה לתיקייה זמנית בזמן שמישהו
// אחר בונה ל-dist). בלעדיו: dashboard/dist, כמו תמיד.
const DIST = process.argv[2]
  ? join(process.argv[2], "assets")
  : join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");

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
  // ⚠️ בודק מוסמך ותחזוקה מונעת: מחלקות שקיימות **רק** ברכיב, לא התוויות
  // העבריות — "בודק מוסמך" מופיע גם בשמות הלשוניות שבקובץ הראשי, ולכן היה
  // עובר גם כשהלשונית עצמה נשמטה מהבנייה.
  ["רמזורי בודק/תחזוקה בכרטיס", "cl-lamp"],
  ["לשונית בודק מוסמך",  "it-donelist"],
  ["עמוד בודק מוסמך",    "ip-back"],
  ["לשונית תחזוקה מונעת", "pm-error-text"],
  ["משימות (חלון)",      "tk-dialog"],
  ["משימות (כפתורים בכרטיס)", "tk-site-btns"],
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

// ============================================================
// pdfjs — legacy, עצל, ועם קבצי העזר שלו
// ============================================================
// ⚠️ build/ (לא legacy) קורא ל-API של JS בלי polyfill, ונכשל בטלפונים שלא
// עודכנו כ"קובץ פגום". legacy/ נושא core-js — זה הסימן שנבדק בעובד שנבנה.
// ⚠️ ובלי dist/pdfjs/wasm/ סריקות JBIG2/JPEG2000 מצוירות כעמוד לבן בלי שגיאה.
const ROOT = join(DIST, "..");
const exists = (p) => { try { statSync(join(ROOT, p)); return true; } catch { return false; } };
const PDF_ASSETS = ["pdfjs/wasm/jbig2.wasm", "pdfjs/wasm/openjpeg.wasm", "pdfjs/standard_fonts/FoxitSerif.pfb", "pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap"];
for (const p of PDF_ASSETS) {
  const ok = exists(p);
  if (!ok) missing++;
  console.log(`  ${ok ? "✅" : "❌"} קובץ עזר של pdfjs  ${p}`);
}
const assetsAll = readdirSync(DIST);
const worker = assetsAll.find((f) => /^pdf\.worker.*\.m?js$/.test(f));
if (worker) {
  const legacy = readFileSync(join(DIST, worker), "utf8").includes("core-js");
  if (!legacy) missing++;
  console.log(`  ${legacy ? "✅" : "❌"} עובד pdfjs הוא legacy  ${worker}`);
} else {
  console.log("  ⏭  עובד pdfjs עוד לא בבנייה (pdfText אינו מחובר למסך) — בדיקת legacy תופעל כשיחובר");
}
// הספרייה עצמה לעולם לא ב-bundle הראשי (index-*.js) — רק בקטע שנטען עצלות.
const entry = files.find((f) => /^index-.*\.js$/.test(f));
if (entry) {
  const inMain = readFileSync(join(DIST, entry), "utf8").includes("must include trailing slash");
  if (inMain) missing++;
  console.log(`  ${inMain ? "❌" : "✅"} pdfjs אינו ב-bundle הראשי  ${entry}`);
}

if (missing) {
  console.error(`\n⛔ ${missing} מסכים אינם בקובץ שנבנה.`);
  console.error("   הסיבה השכיחה: הרכיב איבד את `export default`, ולכן נמחק כקוד מת.");
  process.exit(1);
}
console.log("✅ כל המסכים נמצאים בקובץ שנבנה.");
