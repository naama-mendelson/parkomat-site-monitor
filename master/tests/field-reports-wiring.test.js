// tests/field-reports-wiring.test.js — החיווט של מסך הדיווחים.
//
// ============================================================
// בדיקה מבנית, לא התנהגותית — ולמה זה מספיק כאן
// ============================================================
// אין DOM בסביבה הזו, ולכן אי אפשר לבדוק רינדור. מה שכן אפשר לבדוק הוא
// **מה שאסור להיות בקוד**, וזה בדיוק המקום שבו הכללים של הפרויקט נשברים
// בשקט: ייבוא supabase-js לתוך רכיב, תנאי הרשאה בדפדפן, או שליחה בלי
// דחיסה. אותה תבנית כמו admin-gate.test.js.
//
// ⚠️ ההתנהגות עצמה מכוסה ב-`check-reports` — שער חי מול PostgREST, שהוא
// המקום היחיד שבו ההרשאות באמת נאכפות.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "dashboard", "src");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");

const SERVICE = read("services", "fieldReportsDirect.js");
const COMPONENT = read("components", "FieldReports", "FieldReports.jsx");
const HEADER = read("components", "Header", "Header.jsx");

// ההערות בעברית מזכירות את מה שנבדק כאן — הן מוסרות לפני הבדיקה.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");


test("⚠️ הרכיב אינו מייבא supabase-js — כלל 5", () => {
  // ⚠️ הכלל קיים כדי שהחלפת ספק לא תדרוש לעבור על כל רכיב במערכת. ברגע
  // שרכיב אחד מייבא ישירות, ה-seam כבר לא קיים — הוא רק נראה קיים.
  const code = strip(COMPONENT);
  assert.doesNotMatch(code, /from\s+["'].*supabase["']/,
    "הרכיב מייבא את הלקוח ישירות במקום לעבור דרך services/");
  assert.match(code, /from\s+["']\.\.\/\.\.\/services\/fieldReportsDirect["']/);
});


test("⚠️ אין תנאי הרשאה בשליפה — RLS היא הסינון", () => {
  const code = strip(SERVICE);

  // השליפה מחזירה מה שהמסד נתן. ⚠️ תנאי כאן היה **נראה** כמו הגנה,
  // ואפשר לעקוף אותו בשורת fetch אחת — כלומר הוא מסתיר את העובדה שההגנה
  // האמיתית חייבת להיות במדיניות.
  const fetchFn = (code.match(/export async function fetchFieldReports[\s\S]*?\n}/) || [""])[0];
  assert.ok(fetchFn, "fetchFieldReports לא נמצאה");
  assert.doesNotMatch(fetchFn, /role\s*===|isManager|manager/,
    "יש סינון לפי תפקיד בקוד הלקוח — ההגנה חייבת לשבת ב-RLS");
});


test("⚠️ התמונות נדחסות לפני השליחה", () => {
  const code = strip(SERVICE);
  const submit = (code.match(/export async function submitFieldReport[\s\S]*?\n}/) || [""])[0];
  assert.ok(submit, "submitFieldReport לא נמצאה");

  // בלי דחיסה רוב הצילומים מהטלפון (2–5MB) פשוט נדחים ב-RPC, והמשתמש
  // מקבל שגיאה על פעולה סבירה לגמרי.
  assert.match(submit, /compressImage\(/, "השליחה אינה עוברת דרך הדחיסה");

  // ⚠️ בטור ולא במקביל: ארבע תמונות ב-Promise.all על טלפון ישן מקפיאות
  // את הממשק לכמה שניות, והמשתמש לוחץ שוב.
  assert.doesNotMatch(submit, /Promise\.all/,
    "הדחיסה במקביל — תקפיא את הממשק בטלפון");
});


test("⚠️ ה-base64 אינו נשלף ברשימה", () => {
  const code = strip(SERVICE);
  const listFn = (code.match(/export async function fetchFieldReports[\s\S]*?\n}/) || [""])[0];

  // ארבע תמונות של 150KB הן 600KB לכל דיווח. חמישים דיווחים = 30MB
  // בפתיחה, על טלפון, לפני שמישהו הסתכל על משהו.
  assert.doesNotMatch(listFn, /data_b64/,
    "הרשימה מושכת את התמונות עצמן ולא רק את המזהים");

  const oneFn = (code.match(/export async function fetchReportImage[\s\S]*?\n}/) || [""])[0];
  assert.match(oneFn, /data_b64/, "שליפת תמונה בודדת אינה מביאה את התוכן");
});


test("הכפתור מחווט לכותרת, והחלונית מקבלת את רשימת האתרים", () => {
  const code = strip(HEADER);
  assert.match(code, /import FieldReports from/);
  assert.match(code, /setReportsOpen\(true\)/, "אין כפתור שפותח את המסך");
  assert.match(code, /<FieldReports\s+sites=\{sites\}/,
    "החלונית אינה מקבלת אתרים — בורר האתר יהיה ריק");
});


test("⚠️ המדווח אינו רואה כפתור שייתן לו 403", () => {
  const code = strip(COMPONENT);
  // ⚠️ ההגבלה עצמה ב-SQL, וזו רק התצוגה. מסך שמציע פעולה שאינה אפשרית
  // הוא הדרך האמינה לגרום למישהו להסיק שהמערכת שבורה.
  assert.match(code, /isManager \?/, "כפתור 'סמן כטופל' מוצג לכולם");
  assert.match(code, /ממתין לטיפול/, "למדווח לא נאמר מה מצב הדיווח");
});
