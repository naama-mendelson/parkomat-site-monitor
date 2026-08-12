// tests/read-auth.test.js — כל נתיבי הקריאה דורשים אימות.
//
// ============================================================
// למה זה נבדק כרשימה ולא כהתנהגות
// ============================================================
// ⚠️ נתיב חדש שנוסף בלי `requireAuth` **לא ייכשל בשום בדיקה אחרת** — הוא
// יעבוד מצוין, יחזיר נתונים, וייראה תקין לחלוטין. זה הכשל היחיד כאן שאין
// לו שום סימפטום.
//
// לכן הבדיקה קוראת את קובץ הנתיבים עצמו ומוודאת שכל `app.get("/api/...")`
// נושא שומר. היא מכוונת לתפוס **את הנתיב הבא שמישהו יוסיף**, לא את אלה
// שכבר קיימים.
//
// ============================================================
// מה זה מגן עליו
// ============================================================
// המסלול הישיר ל-Supabase מוגן ב-RLS. השרת מתחבר כ-postgres עם
// rolbypassrls — כלומר **הוא עוקף את RLS לגמרי**. נתיב פתוח בשרת נותן את
// כל הנתונים של כל האתרים לכל מי שיודע את הכתובת, בלי קשר למדיניות.
//
// זה היה מקובל כשהכל רץ ברשת פנימית מאותו origin. הפיצול לשני קונטיינרים
// והמעבר של הקבצים לאחסון חיצוני שוברים את שתי ההנחות.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROUTES = fs.readFileSync(path.join(__dirname, "..", "api", "routes.js"), "utf8");

/** כל שורות `app.get("/api/...")` עם רשימת ה-middleware שאחריהן. */
function readRoutes() {
  const out = [];
  for (const line of ROUTES.split(/\r?\n/)) {
    const m = line.match(/^app\.get\("(\/api\/[^"]*)",(.*)$/);
    if (m) out.push({ route: m[1], rest: m[2] });
  }
  return out;
}

test("יש נתיבי קריאה לבדוק (הבדיקה עצמה לא ריקה)", () => {
  // ⚠️ בלי זה, שינוי בפורמט של routes.js היה הופך את כל הקובץ הזה לבדיקה
  // שעוברת על אפס נתיבים — ירוקה, וחסרת ערך לחלוטין.
  assert.ok(readRoutes().length >= 15, `נמצאו ${readRoutes().length} נתיבים`);
});

test("⚠️ כל נתיב קריאה נושא שומר אימות", () => {
  const unguarded = readRoutes().filter(
    (r) => !/requireAuth\b|requireAuthSse\b|requireAdmin\b/.test(r.rest),
  );
  assert.deepEqual(unguarded.map((r) => r.route), [],
    "נתיבים ללא שומר — הם מחזירים את כל הנתונים לכל מי שיודע את הכתובת");
});

test("⚠️ האימות קודם למטמון", () => {
  // מטמון לפני אימות פירושו שבקשה **לא מאומתת** מקבלת תשובה שמורה ולעולם
  // אינה מגיעה לבדיקה. הנתיב נראה מוגן, והוא דולף בדיוק כמו קודם.
  const wrong = readRoutes().filter((r) => {
    const cache = r.rest.indexOf("cache(");
    const auth = r.rest.indexOf("requireAuth");
    return cache !== -1 && auth !== -1 && cache < auth;
  });
  assert.deepEqual(wrong.map((r) => r.route), [], "cache() לפני requireAuth");
});

test("נתיב ה-SSE מקבל את השומר שיודע לקרוא אסימון משאילתה", () => {
  // ⚠️ EventSource אינו יכול לשלוח כותרות — מגבלת דפדפן, לא בחירה. לכן
  // דווקא הנתיב הזה **לא** יכול להשתמש ב-requireAuth הרגיל, ושומר שגוי
  // עליו היה מנתק את כל העדכונים החיים.
  const sse = readRoutes().find((r) => r.route === "/api/stream");
  assert.ok(sse, "נתיב /api/stream קיים");
  assert.match(sse.rest, /requireAuthSse/);
});

test("⚠️ האסימון מנוקה מכתובות שנכתבות ללוג", () => {
  // הלוג מדפיס originalUrl, ולכן בלי הניקוי כל בקשת SSE איטית הייתה כותבת
  // אסימון תקף לקובץ. זו בדיוק הסיבה שאסימון ב-URL נחות מכותרת: הוא דולף
  // למקומות שאיש לא חשב עליהם.
  const m = ROUTES.match(/function redactUrl[\s\S]*?\n}/);
  assert.ok(m, "redactUrl קיימת");

  const redactUrl = new Function(`${m[0]}; return redactUrl;`)();

  assert.equal(redactUrl("/api/stream?access_token=eyJ.SECRET"), "/api/stream?access_token=***");
  assert.equal(redactUrl("/api/x?a=1&token=abc&b=2"), "/api/x?a=1&token=***&b=2");
  // ⚠️ מוחלף ולא נמחק: URL קטוע נראה כמו בקשה שגויה ומטעה מי שמנתח לוג.
  assert.match(redactUrl("/api/stream?access_token=X"), /access_token=/);
  // כתובת בלי סוד עוברת כמות שהיא.
  assert.equal(redactUrl("/api/sites"), "/api/sites");
});

test("⚠️ הגשת הקבצים הסטטיים נשארת פתוחה", () => {
  // מסך ההתחברות עצמו הוא קובץ סטטי. אילו express.static היה מוגן, המשתמש
  // היה צריך להיות מחובר כדי לקבל את הדף שבו מתחברים — נעילה מושלמת.
  const m = ROUTES.match(/app\.use\(express\.static\(([^)]*)\)/);
  assert.ok(m, "express.static קיים");
  assert.doesNotMatch(m[0], /requireAuth/);
});

// ============================================================
// צד הלקוח: דלת החירום חייבת לשלוח אסימון
// ============================================================
// ⚠️ **זה הבאג שנוצר מההגנה עצמה.** נתיבי הקריאה בשרת הוגנו, אבל
// `getJSON` — שדרכו עוברות כל 11 קריאות מסלול-השרת — שלח `fetch(url)`
// בלי כותרות. כלומר ההגנה לא אבטחה את דלת החירום, היא **סגרה** אותה.
//
// ⚠️ ולמה זה לא היה מתגלה: המסלול הזה רץ רק כש-VITE_SUPABASE_DIRECT=false,
// והוא כבוי היום. הכשל היה מחכה בדיוק ליום שבו מישהו הופך את המתג — כלומר
// כשמשהו כבר לא עובד ולוחצים.
const API_SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "dashboard", "src", "services", "api.js"), "utf8");

test("⚠️ getJSON שולח אסימון — אחרת מסלול השרת מחזיר 401", () => {
  const m = API_SRC.match(/function getJSON[\s\S]*?\n}/);
  assert.ok(m, "getJSON קיימת");
  assert.match(m[0], /authHeaders\(\)/,
    "getJSON חייבת לצרף כותרות אימות, אחרת כל נתיבי הקריאה מחזירים 401");
});

test("כתובת ה-API ניתנת להגדרה — אחרת הפיצול שובר את הקריאות", () => {
  // ⚠️ נתיב יחסי ("/api") מפנה לשרת שממנו הגיעו הקבצים. בפיצול לשני
  // קונטיינרים זה Apache, שאין בו API — והכשל שקט לגמרי.
  assert.match(API_SRC, /VITE_API_BASE/);
  assert.match(API_SRC, /export const API_ROOT/);
});

test("⚠️ CORS מתיר את כותרת ה-Authorization", () => {
  // בלי זה כל קריאה חוצת-origin נופלת ב-preflight, לפני שהיא מגיעה לשרת
  // בכלל — והשגיאה נראית כמו תקלת אימות ולא כמו CORS.
  const m = ROUTES.match(/Access-Control-Allow-Headers",\s*"([^"]*)"/);
  assert.ok(m, "הכותרת מוגדרת");
  assert.match(m[1], /Authorization/i);
});
