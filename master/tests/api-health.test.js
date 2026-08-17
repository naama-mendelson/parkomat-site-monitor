// tests/api-health.test.js — זיהוי כתובת API שגויה.
//
// ============================================================
// הכשל שזה נועד לתפוס
// ============================================================
// `VITE_API_BASE` נצרב בבנייה. ריק = נתיב יחסי — נכון כשאותו שרת מגיש גם
// קבצים וגם API, ושגוי ברגע שהקבצים עוברים ל-Apache.
//
// ⚠️ ואז זה נכשל ב-**200** ולא ב-404: Apache עושה rewrite של כל נתיב שאינו
// קובץ ל-`index.html`. בדיקת status הייתה עוברת בהצלחה מלאה.
//
// ⚠️ **וב-VITE_SUPABASE_DIRECT=true זה גרוע יותר:** הקריאות עובדות (הן
// הולכות ל-Supabase), המסך נראה תקין לחלוטין, ורק הכתיבות שבורות —
// רישום אתר, תחזוקה, ניהול משתמשים, העוזר. מישהו יגלה את זה כשינסה
// להכניס אתר לתחזוקה באמצע תקלה.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODULE = pathToFileURL(
  path.join(__dirname, "..", "..", "dashboard", "src", "services", "apiHealth.js")
).href;

/** מחליף את fetch הגלובלי בתשובה נתונה. */
function stubFetch(reply) {
  globalThis.window = { location: { origin: "http://x" } };
  globalThis.fetch = async () => {
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? reply.type : null) },
      json: async () => {
        if (reply.bad) throw new SyntaxError("Unexpected token <");
        return reply.body;
      },
    };
  };
}

const fresh = () => import(`${MODULE}?v=${Math.random()}`);

test("API תקין → healthy", async () => {
  stubFetch({ status: 200, type: "application/json; charset=utf-8",
              body: { status: "ok", db: "ready" } });
  const { probeApi } = await fresh();
  assert.equal((await probeApi()).kind, "ok");
});

// ============================================================
// ⚠️ שלוש שכבות זיהוי, ורק אחת מהן ניתנת לבידוד — נמדד
// ============================================================
// הקוד בודק content-type, ואז שהפרסינג הצליח, ואז שיש שדה `status`.
// **המוטציות הראו שהשתיים הראשונות מכסות זו את זו:** החלפת בדיקת
// ה-content-type בבדיקת status לא הפילה אף בדיקה, כי גוף HTML ממילא
// מפיל את `res.json()`.
//
// זה לא אומר שהשכבות מיותרות — content-type חוסך פרסינג של גוף גדול,
// ונותן את `contentType` שמופיע בהודעה למשתמש. אבל **אין לטעון שהיא
// נבדקת**, וזה מה שהמוטציה לימדה.
//
// מה שכן מבודד: הסרת בדיקת הצורה מפילה בדיקה אחת בדיוק, והסרת שלוש
// השכבות יחד מפילה שלוש.
test("⚠️ Apache מחזיר index.html עם 200 → not-api", async () => {
  // **זה הכשל המרכזי.** status 200, גוף HTML.
  stubFetch({ status: 200, type: "text/html; charset=utf-8" });
  const { probeApi } = await fresh();
  const v = await probeApi();
  assert.equal(v.kind, "not-api");
  assert.equal(v.status, 200, "הסטטוס עצמו תקין — ולכן הוא לא הסימן");
  assert.match(v.detail.contentType, /text\/html/);
});

// ============================================================
// ⚠️ 401 הוא תשובה **חיובית** — וזה תיקון של באג
// ============================================================
// הבדיקה רצה לפני התחברות ואין לה אסימון, ולכן השרת מחזיר
// `401 {"error":"נדרשת התחברות"}`. זו הוכחה שה-API ענה בכתובת הזו.
// מה שמסגיר כתובת שגויה הוא **סוג התוכן**, לא הסטטוס.
test("⚠️ 401 עם JSON → ok, כי ה-API ענה", async () => {
  stubFetch({ status: 401, type: "application/json; charset=utf-8",
              body: { error: "נדרשת התחברות" } });
  const { probeApi } = await fresh();
  assert.equal((await probeApi()).kind, "ok");
});

test("גם 503 עם JSON → ok — הכתובת נכונה, השרת חולה", async () => {
  // בריאות השרת אינה באחריות הבדיקה הזו. היא בודקת **כתובת**.
  stubFetch({ status: 503, type: "application/json", body: { status: "unhealthy" } });
  const { probeApi } = await fresh();
  assert.equal((await probeApi()).kind, "ok");
});

// ============================================================
// ⚠️ הנתיב הנבדק חייב להיות תחת /api — הבאג שהפס נדלק בפיתוח
// ============================================================
// הגרסה הראשונה בדקה `/health`. הוא פתוח ומחזיר JSON, ולכן נראה כבחירה
// הטבעית — **והוא נתיב שהאפליקציה אינה משתמשת בו.** ה-proxy של Vite מכסה
// "/api" בלבד, ולכן נמדד:
//
//     :5173/health     → 200 text/html        ← Vite מחזיר index.html
//     :5173/api/sites  → 401 application/json
//
// כלומר הפס נדלק בסביבת הפיתוח, שבה הכול תקין לגמרי.
test("⚠️ הבדיקה פונה לנתיב תחת /api, ולא ל-/health", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "dashboard", "src", "services", "apiHealth.js"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /PROBE_PATH\s*=\s*"\/api\//,
    "חייב להיות תחת /api — הקידומת שהאפליקציה באמת פונה אליה");
  assert.doesNotMatch(code, /"\/health"/,
    "/health יושב מחוץ ל-proxy של Vite ונדלק בפיתוח");
});

test("fetch שזרק → unreachable", async () => {
  stubFetch(new TypeError("Failed to fetch"));
  const { probeApi } = await fresh();
  assert.equal((await probeApi()).kind, "unreachable");
});

// ============================================================
// ⚠️ הפס אינו חוסם, ואינו נדלק על תשובת JSON
// ============================================================
const fs = require("node:fs");
const BAR = fs.readFileSync(
  path.join(__dirname, "..", "..", "dashboard", "src", "components",
            "ApiHealthBar", "ApiHealthBar.jsx"), "utf8");
const barCode = BAR.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⚠️ הפס אינו חוסם את המסך", () => {
  // ב-DIRECT=true הקריאות עובדות, והמסך מציג נתונים אמיתיים. מסך חוסם
  // היה מוחק תמונה תקינה ומועילה בגלל תקלה חלקית.
  assert.doesNotMatch(barCode, /position:\s*fixed|overlay|createPortal/i);
});

test("⚠️ ואינו נדלק כשהתשובה היא JSON — כולל 401", () => {
  // 401 הוא הוכחה שה-API ענה בכתובת הזו. פס שנדלק עליו היה נדלק בכל
  // טעינה לפני התחברות — כלומר תמיד, ובכל סביבה.
  assert.match(barCode, /kind === "ok"[\s\S]{0,30}return null/);
});

test("⚠️ ומונה מה נשבר בפועל, לא 'שגיאה'", () => {
  // מי שקורא צריך לדעת אם מה שהוא עומד לעשות עובד.
  for (const s of ["רישום אתר", "חלון תחזוקה", "ניהול משתמשים"]) {
    assert.ok(BAR.includes(s), `חסר: ${s}`);
  }
  assert.match(BAR, /VITE_API_BASE/, "נוקב בשם הערך שצריך לתקן");
  // ⚠️ ושתי האפשרויות ל-unreachable: הדפדפן אינו מבדיל בין שרת מכובה
  // לחסימת CORS, ואמירת אחת בביטחון שולחת לחפש במקום הלא נכון.
  assert.match(BAR, /DASHBOARD_ORIGIN/, "מזכיר גם CORS, לא רק שרת מכובה");
});
