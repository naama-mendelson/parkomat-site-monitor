// scripts/make-synthetic-pdf.mjs — תסקיר בודק מוסמך *מומצא*, כקובץ PDF אמיתי.
//
// ============================================================
// למה PDF אמיתי ולא עוד פריטים מוקלדים ביד
// ============================================================
// הבדיקות הסינתטיות ב-parse-inspection.test.js בונות פריטים בצורה ש*אנחנו*
// חושבים ש-pdfjs מחזיר. שני התסקירים האמיתיים מכסים רק שני יצרני PDF.
// כאן Chromium מדפיס דף עברי RTL, ו-pdfjs מחלץ ממנו — כלומר הקלט הוא מה
// שהדפדפן באמת יקבל, כולל סדר הריצות, תאריכי ISO בתוך שורה עברית ו"ל-".
//
// ⚠️ **אין כאן פרטים אישיים, ואסור שיהיו:** שמות, כתובת, מספרי תסקיר
// ורשיון — כולם מומצאים. הקובץ נכנס לריפו (שני ה-PDF האמיתיים לא).
//
// מה הקובץ מכיל, ולמה כל פרט:
//   עמודים 1–2  תסקיר תקופתי, מתקן 111: "אין" = נקי, נגמר בכותרת ממוספרת
//               "5. הערות", וממשיך לעמוד 2 (מסקנות + הצהרה) בלי כותרת חדשה —
//               כלומר עמוד 2 שייך לאותו בלוק. בעמוד 1 שורת נוסח "לצורך בדיקה
//               חוזרת" — שאסור שתסמן את התסקיר כבדיקה חוזרת.
//   עמוד 3      "בדיקה חוזרת", מתקן 222: שני ליקויים, תאריך בחינה ISO
//               (2026-04-12), "בתוקף עד ל-12/04/2027", והמקטע נגמר ב"מסקנות"
//               (סוף רך) — בלי כותרת "הערות".
//
//   cd dashboard && node scripts/make-synthetic-pdf.mjs
//   node scripts/dump-pdf-items.mjs ../master/tests/fixtures/inspection/synthetic.pdf \
//        ../master/tests/fixtures/inspection/synthetic.items.json
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

const OUT = fileURLToPath(new URL("../../master/tests/fixtures/inspection/synthetic.pdf", import.meta.url));

const P = (s, cls = "") => `<p${cls ? ` class="${cls}"` : ""}>${s}</p>`;

const reportA = [
  P("תסקיר בדיקת מתקן חניה", "title"),
  P("מספר תסקיר: 500101/900"),
  P("מספר מתקן: 111"),
  P("תאריך הבחינה: 05/03/2026"),
  P("בתוקף עד: 05/03/2027"),
  P("מקום הבדיקה: רחוב הדוגמה 1, קריית ניסוי"),
  P("4. תיאור הליקויים שהתגלו בבדיקה (תוך 45 יום אם לא צויין אחרת):", "head"),
  P("אין"),
  P("5. הערות", "head"),
  P("* הפעלת המתקן על ידי אדם מורשה בלבד."),
  P("* על כל פגם יש לדווח מיידית לבודק לצורך בדיקה חוזרת."),
].join("\n");

const reportA2 = [
  P("6. מסקנות: אין התנגדות להפעלת המתקן", "head"),
  P("אני: מהנדס בודק מוסמך ישראל דוגמה, מספר רשיון הבודק 999"),
  P("מאשר כי ביום 05/03/2026 בדקתי את המתקן בהתאם לתקנות."),
  P("חתימת הבודק המוסמך"),
].join("\n");

const reportB = [
  P("תסקיר בדיקת מתקן חניה — בדיקה חוזרת", "title"),
  P("מספר תסקיר: 500102/900"),
  P("מספר מתקן: 222"),
  P("תאריך הבחינה: 2026-04-12"),
  P("בתוקף עד ל-12/04/2027"),
  P("מקום הבדיקה: רחוב הדוגמה 1, קריית ניסוי"),
  P("4. תיאור הליקויים שהתגלו בבדיקה (תוך 30 יום אם לא צויין אחרת):", "head"),
  P("1. להחליף את חיישן הנפח בכניסה לפיר - לטיפול מיידי"),
  P("2. לצבוע מחדש את קו העצירה הצהוב"),
  P("בקומת הכניסה."),
  P("מסקנות: אין התנגדות להפעלת המתקן לאחר התיקון", "head"),
  P("אני מהנדס ישראל דוגמה מספר רשיון הבודק 999"),
  P("מאשר כי ביום 2026-04-12 בדקתי את המתקן בהתאם לתקנות."),
  P("חתימת הבודק המוסמך"),
].join("\n");

// ⚠️ Arial ולא גופן רשת: הקובץ נבנה במחשב הפיתוח (Windows), ו-Arial כולל
// עברית. גופן שחסר בו גליף היה יוצא כריבועים — ו-pdfjs היה מחלץ ריק.
const html = `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: Arial, sans-serif; font-size: 11pt; margin: 0; }
  p { margin: 0 0 7pt; }
  .title { font-size: 15pt; font-weight: bold; margin-bottom: 12pt; }
  .head { font-weight: bold; margin-top: 10pt; }
  section { break-after: page; }
  section:last-child { break-after: auto; }
</style></head><body>
<section>${reportA}</section>
<section>${reportA2}</section>
<section>${reportB}</section>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.pdf({ path: OUT, format: "A4", printBackground: false, tagged: false, outline: false });
} finally {
  await browser.close();
}
console.log(`${OUT}  ${(statSync(OUT).size / 1024).toFixed(1)} KB`);
