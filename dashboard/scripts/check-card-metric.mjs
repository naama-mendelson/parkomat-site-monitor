// scripts/check-card-metric.mjs — הכרטיס מציג זמינות, וממוין לפי אחוז כשל.
//
// ============================================================
// ⚠️ למה זה קיים: שני מדדים הפוכים על אותו מקום במסך
// ============================================================
// עד 09/09/2026 הכרטיס הציג **אחוז כשל**. הבקשה הייתה להציג **זמינות**
// ולהשאיר את הסדר לפי אחוז הכשל — ושני המדדים באמת נפרדים: נמדד על
// הצי, אתר 1376 עומד על 16.13% כשל אבל 96.98% זמינות, בעוד 3452 עומד
// על 6.25% כשל ו-99.36% זמינות.
//
// ⚠️ **וזו החלפה שבה קל להפוך שני דברים, ושניהם שקטים:**
//
//   1. **הצבע.** בכשל נמוך=טוב, בזמינות גבוה=טוב. סף שנשאר כמו שהיה
//      היה צובע אתר עם 100% זמינות באדום — ואף בדיקה לא הייתה נופלת.
//   2. **סימן המגמה.** הוא מחושב על אחוז הכשל. ▼ ליד 99.8% זמינות
//      נקרא "הזמינות ירדה", בזמן שהמשמעות היא "הכשלים ירדו" — כלומר
//      ההפך הגמור, על הכרטיס שכל תפקידו סריקה מהירה.
//
//   npm run check:card-metric
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(HERE, p), "utf8");

const jsx = read("../src/components/SiteCard/SiteCard.jsx");
const sort = read("../src/utils/sortSites.js");

const problems = [];
const ok = [];

// ⚠️ שורות הערה מוסרות. ההערות בקובץ הזה מסבירות את המנגנון במילים
// כמעט זהות לקוד, והיו צובעות כל בדיקה כאן ירוקה בלי שהקוד קיים —
// טעות שכבר נעשתה שלוש פעמים בשערים אחרים בפרויקט.
const code = jsx
  .split("\n")
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

// ============================================================
// 1. הכרטיס מציג זמינות — ולא אחוז כשל
// ============================================================
if (/זמינות/.test(code)) ok.push("הכרטיס מציג תווית 'זמינות'");
else problems.push("לא נמצאה תווית 'זמינות' בכרטיס");

if (/אחוז כשל/.test(code))
  problems.push("התווית 'אחוז כשל' עדיין מוצגת על הכרטיס");
else ok.push("התווית 'אחוז כשל' ירדה מהכרטיס");

// ⚠️ **הערך, לא רק התווית.** תווית שהוחלפה מעל מספר שלא הוחלף היא
// הגרסה הגרועה מכולן: היא אומרת "זמינות" ומראה אחוז כשל.
if (/site\.uptime/.test(code)) ok.push("הערך נלקח מ-site.uptime");
else problems.push("site.uptime אינו נקרא בכרטיס — התווית התחלפה אך לא המספר");

if (/site\.failureRate/.test(code))
  problems.push("site.failureRate עדיין נקרא בכרטיס");
else ok.push("site.failureRate אינו נקרא עוד בכרטיס");

// ============================================================
// 2. ⚠️ הצבע הפוך — גבוה = ירוק
// ============================================================
// זו הטענה שאין שום דרך אחרת לתפוס: קוד שמשאיר את הסף הישן עובר
// קומפילציה, נראה תקין, וצובע את האתרים הכי טובים באדום.
const fn = code.match(/function availabilityColor\([\s\S]*?\n}/);
if (!fn) {
  problems.push("availabilityColor לא נמצאה — הצבע כנראה עדיין של אחוז הכשל");
} else {
  const body = fn[0];
  const green = body.match(/(>=\s*[\d.]+)[^\n]*ready\.dot/);
  const red = /return STATUS_COLORS\.error\.dot/.test(body);
  const lastLine = body.trim().split("\n").slice(-2).join("\n");

  if (green) ok.push(`ירוק מותנה בסף גבוה (${green[1].trim()})`);
  else problems.push("לא נמצא סף שמחזיר ירוק לערך גבוה — הכיוון כנראה הפוך");

  if (red && /error\.dot/.test(lastLine))
    ok.push("ברירת המחדל (הנמוכה ביותר) היא אדום");
  else problems.push("הערך הנמוך ביותר אינו מקבל אדום — הכיוון הפוך");

  // ⚠️ null אינו אפס: אתר בלי שעות נמדדות אינו 'מושבת לגמרי'.
  if (/pct == null/.test(body)) ok.push("null מקבל צבע ניטרלי ולא אדום");
  else problems.push("null אינו מטופל — אתר בלי נתון ייצבע כאילו הוא מושבת");
}

// ============================================================
// 3. ⚠️ סימן המגמה התהפך יחד עם המספר
// ============================================================
// המגמה מחושבת על אחוז הכשל. 'משתפר' = פחות כשלים = זמינות גבוהה,
// ולכן הסימן חייב להיות ▲. ▼ שם היה קורא "הזמינות ירדה".
const mark = code.match(/const TREND_MARK = {[\s\S]*?};/);
if (!mark) {
  problems.push("TREND_MARK לא נמצא");
} else {
  const improving = mark[0].match(/improving:\s*{\s*glyph:\s*"([^"]+)"/);
  const worsening = mark[0].match(/worsening:\s*{\s*glyph:\s*"([^"]+)"/);

  if (improving?.[1] === "▲") ok.push("'משתפר' מסומן ▲ — כיוון הזמינות");
  else problems.push(`'משתפר' מסומן ${improving?.[1] ?? "?"} — ליד זמינות זה נקרא "ירדה"`);

  if (worsening?.[1] === "▼") ok.push("'מחמיר' מסומן ▼");
  else problems.push(`'מחמיר' מסומן ${worsening?.[1] ?? "?"} — ליד זמינות זה נקרא "עלתה"`);
}

// ============================================================
// 4. ⚠️ והסדר נשאר לפי אחוז הכשל — זו מחצית הבקשה
// ============================================================
// הקומפרטור משותף גם לטבלת מנהל הבקרה, ולכן שינוי כאן היה משנה מסך
// שלא ביקשו לגעת בו.
//
// ⚠️ **בלי הערות, ועל הביטוי עצמו.** גרסה ראשונה בדקה `/failureRate/`
// על הקובץ כולו — והמילה מופיעה בהערת הפתיחה שלו. מוטציה שהחליפה את
// ההשוואה ל-`uptime` **עברה ירוקה**. זו הפעם הרביעית בפרויקט הזה שעוגן
// תופס טקסט מסביר במקום את הקוד שהוא מתאר.
const sortCode = sort
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");

if (/\(b\.failureRate \?\? 0\) - \(a\.failureRate \?\? 0\)/.test(sortCode))
  ok.push("הסדר ברשת עדיין נקבע לפי אחוז הכשל, גבוה קודם");
else problems.push("compareSitesByPriority אינו ממיין עוד לפי אחוז כשל");

if (/uptime/.test(sortCode))
  problems.push("הקומפרטור מזכיר uptime — הסדר היה אמור להישאר לפי אחוז הכשל");
else ok.push("הזמינות אינה משתתפת בסדר");

// ------------------------------------------------------------
for (const line of ok) console.log("  OK  " + line);
for (const line of problems) console.log("  XX  " + line);
console.log("");
console.log(problems.length === 0
  ? `עבר — ${ok.length} בדיקות`
  : `נכשל — ${problems.length} בעיות`);
process.exit(problems.length === 0 ? 0 : 1);
