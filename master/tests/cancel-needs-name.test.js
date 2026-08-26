// tests/cancel-needs-name.test.js — שם חובה גם להוצאה מתחזוקה.
//
// ============================================================
// ⚠️ הכלל התקיים בזרוע אחת בלבד
// ============================================================
// הזרוע הישירה אוכפת שם ב-SQL: `cancel_maintenance` דוחה שם קצר משני תווים
// ב-check_violation. הזרוע דרך השרת לא אכפה כלום — **ו-api.js אפילו לא שלח
// את השם**: `dataSource` קורא `cancelMaintenance(code, name)` והחתימה קיבלה
// ארגומנט אחד, כך שהוא נזרק בשקט לפני היציאה לרשת.
//
// ⚠️ וזו בדיוק הדרך שבה נתיב רדום מרקיב. VITE_SUPABASE_DIRECT=false הוא דלת
// היציאה; מי שיעבור אליה היה מגלה שהדרישה נעלמה — בלי שום שגיאה, רק חלונות
// שנסגרים בלי שנדע מי סגר אותם. ביטול מחזיר את האתר לספירת התקלות ולמכנה
// הזמינות, כלומר הוא משנה מספרים בדוחות בדיוק כמו ההפעלה.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const QUERIES = strip(read("db", "queries.js"));
const ROUTES = strip(read("api", "routes.js"));
const API = strip(read("..", "dashboard", "src", "services", "api.js"));


test("⚠️ api.js שולח את השם — החתימה מקבלת אותו והוא נכנס לגוף", () => {
  const fn = (API.match(/export async function cancelMaintenance\([\s\S]*?^}/m) || [""])[0];
  assert.ok(fn, "cancelMaintenance לא נמצאה ב-api.js");

  assert.match(fn, /cancelMaintenance\(code,\s*name\)/,
    "החתימה מקבלת רק code — השם נזרק לפני היציאה לרשת");
  assert.match(fn, /body:\s*JSON\.stringify\(\{\s*name/,
    "השם אינו נשלח בגוף הבקשה");
});


test("⚠️ המסלול דוחה בקשה בלי שם — 400, ולא ביטול שקט", () => {
  const start = ROUTES.indexOf('app.delete("/api/sites/:code/maintenance"');
  assert.ok(start !== -1, "מסלול DELETE לא נמצא");
  const handler = ROUTES.slice(start, ROUTES.indexOf("app.", start + 10));

  assert.match(handler, /performedBy/, "אין קריאה של השם כלל");
  assert.match(handler, /status\(400\)/, "אין דחייה מפורשת בלי שם");
  assert.match(handler, /length\s*<\s*2/, "אין סף אורך — רווח בודד עובר כשם");

  // ⚠️ והשם עובר הלאה לשאילתה, ולא רק נבדק ונזרק.
  assert.match(handler, /cancelMaintenance\(site\.id,\s*performedBy\)/,
    "השם נבדק אבל לא נשמר");
});


test("⚠️ העדפה לזהות מאומתת — אותו כלל כמו set_by_name", () => {
  const start = ROUTES.indexOf('app.delete("/api/sites/:code/maintenance"');
  const handler = ROUTES.slice(start, ROUTES.indexOf("app.", start + 10));

  // אסימון גובר על הגוף; השם המוקלד משמש רק כשאין אסימון.
  assert.match(handler, /trust\s*===\s*"token"/,
    "השם מהגוף מתקבל גם כשיש זהות מאומתת");
});


test("⚠️ השאילתה עצמה אוכפת ושומרת ב-cancelled_by", () => {
  const fn = (QUERIES.match(/async function cancelMaintenance\([\s\S]*?^}/m) || [""])[0];
  assert.ok(fn, "cancelMaintenance לא נמצאה ב-queries.js");

  assert.match(fn, /cancelMaintenance\(siteId,\s*performedBy\)/);
  assert.match(fn, /length\s*<\s*2/,
    "השאילתה מקבלת שם ריק — ההגנה קיימת רק במסלול, ולכל קורא אחר אין אותה");
  assert.match(fn, /cancelled_by\s*=\s*\?/,
    "השם לא נכתב ל-cancelled_by — אותה עמודה שהזרוע הישירה ממלאת");
});
