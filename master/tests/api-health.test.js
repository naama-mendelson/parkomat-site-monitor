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
  assert.equal((await probeApi()).kind, "healthy");
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

test("⚠️ 503 עם JSON תקין → unhealthy, ולא not-api", async () => {
  // ה-API שם ועונה; חולה המסד או ה-MQTT. מיזוג השניים היה שולח לתקן את
  // כתובת ה-API בזמן שהיא נכונה לגמרי.
  stubFetch({ status: 503, type: "application/json",
              body: { status: "unhealthy", db: "not_ready" } });
  const { probeApi } = await fresh();
  const v = await probeApi();
  assert.equal(v.kind, "unhealthy");
  assert.equal(v.detail.db, "not_ready", "הפירוט נשמר כדי שיהיה מה לתקן");
});

test("⚠️ JSON שהוכרז ולא נפרס → not-api", async () => {
  // שרת אחר שמכריז JSON. פרסינג שנכשל הוא סימן חזק יותר מהכותרת.
  stubFetch({ status: 200, type: "application/json", bad: true });
  const { probeApi } = await fresh();
  assert.equal((await probeApi()).kind, "not-api");
});

test("⚠️ JSON תקין בלי השדה status → not-api", async () => {
  // כל שרת יכול להחזיר JSON. `status` הוא מה ש-/health שלנו מחזיר תמיד.
  stubFetch({ status: 200, type: "application/json", body: { hello: "world" } });
  const { probeApi } = await fresh();
  assert.equal((await probeApi()).kind, "not-api");
});

test("fetch שזרק → unreachable", async () => {
  stubFetch(new TypeError("Failed to fetch"));
  const { probeApi } = await fresh();
  assert.equal((await probeApi()).kind, "unreachable");
});

// ============================================================
// ⚠️ הפס אינו חוסם, ואינו מדווח על unhealthy
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

test("⚠️ ואינו מתריע על unhealthy — זו אינה תקלת הגדרה", () => {
  // הכרזת "כתובת שגויה" כשהכתובת נכונה לגמרי הייתה שולחת לתקן את הדבר
  // הלא נכון.
  assert.match(barCode, /kind === "unhealthy"[\s\S]{0,40}return null/);
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
