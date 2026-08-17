// services/apiHealth.js — האם כתובת ה-API שהוטמעה בבנייה נכונה.
//
// ============================================================
// הכשל שזה נועד לתפוס, ולמה הוא שקט במיוחד
// ============================================================
// `VITE_API_BASE` נצרב בזמן הבנייה. ריק פירושו **נתיב יחסי** — נכון כשאותו
// שרת מגיש גם את הקבצים וגם את ה-API (המצב היום), ושגוי ברגע שהקבצים
// עוברים ל-Apache או לאחסון חיצוני.
//
// ⚠️ ואז זה לא נכשל ב-404 אלא ב-**200**: Apache עושה rewrite של כל נתיב
// שאינו קובץ ל-`index.html`, ולכן `fetch("/api/sites")` מחזיר את דף
// ה-HTML עם status 200. הקוד מנסה `res.json()` ומקבל "Unexpected token <".
//
// ⚠️ **וב-VITE_SUPABASE_DIRECT=true זה גרוע יותר, לא פחות:** הקריאות
// עובדות (הן הולכות ל-Supabase), ולכן המסך נראה **תקין לחלוטין** —
// כרטיסים, גרפים, הכול. רק הכתיבות נכשלות: רישום אתר, חלון תחזוקה,
// ניהול משתמשים, והעוזר. מישהו יגלה את זה כשינסה להכניס אתר לתחזוקה
// באמצע תקלה.
//
// ============================================================
// ⚠️ למה בודקים content-type ולא status
// ============================================================
// זו כל הנקודה. תשובת ה-rewrite היא `200 text/html` — בדיקת status הייתה
// עוברת בהצלחה. מה שמסגיר אותה הוא שהיא **אינה JSON**.
//
// ⚠️ ולמה `/health` ולא נתיב מוגן: הבדיקה חייבת לרוץ **לפני** התחברות,
// ונתיב מוגן היה מחזיר 401 — שאינו ניתן להבחנה מהגדרה שגויה. `/health`
// פתוח בכוונה (api/routes.js) ומחזיר JSON תמיד.
//
// ============================================================
// ⚠️ **המודול הזה אינו מייבא כלום, וזה מכוון**
// ============================================================
// `apiRoot` מגיע כארגומנט ולא מ-`import { API_ROOT } from "./api"`. שני
// טעמים, ושניהם נמדדו כאן:
//
//   • ייבוא מ-api.js היה גורר את supabase.js ואת supabase-js כולו, ולכן
//     בדיקה בלי דפדפן לא הייתה יכולה לטעון את המודול בכלל.
//   • ובדיקה שאינה יכולה לייבא את הקוד נאלצת להחזיק **עותק** שלו — וכך
//     היא בודקת את העותק ולא את מה שרץ.
//
// אותו שיקול בדיוק הוציא את extractFaultText מ-state-handler בשרת.

const TIMEOUT_MS = 8000;

/**
 * @returns {Promise<{kind:string, status?:number, detail?:object}>}
 *   'healthy'     — ה-API שם ועונה תקין
 *   'unhealthy'   — ה-API שם, אבל מדווח על בעיה (DB/MQTT). **לא** תקלת הגדרה.
 *   'not-api'     — משהו ענה, אבל זה לא ה-API. כמעט תמיד VITE_API_BASE שגוי.
 *   'unreachable' — לא הגיעה תשובה בכלל.
 */
export async function probeApi(apiRoot = "") {
  const url = `${apiRoot}/health`;

  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // ⚠️ **חסימת CORS זורקת בדיוק כמו שרת מכובה** — הדפדפן אינו חושף את
    // ההבדל ל-JS. לכן ההודעה למשתמש מונה את שתי האפשרויות ואינה מתחזה
    // לדעת. ניחוש כאן היה שולח לחפש במקום הלא נכון.
    return { kind: "unreachable", detail: { message: err?.message ?? String(err) } };
  }

  // ⚠️ הבדיקה המכריעה. `includes` ולא השוואה: הכותרת מגיעה כ-
  // "application/json; charset=utf-8".
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) {
    return { kind: "not-api", status: res.status, detail: { contentType: type } };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    // JSON שהוכרז ולא נפרס — שרת אחר לגמרי, לא שלנו.
    return { kind: "not-api", status: res.status, detail: { contentType: type } };
  }

  // ⚠️ בדיקת **צורה** ולא רק פרסינג: כל שרת יכול להחזיר JSON. `status`
  // הוא השדה ש-/health שלנו מחזיר תמיד, והיעדרו אומר שזה לא אנחנו.
  if (typeof body?.status !== "string") {
    return { kind: "not-api", status: res.status, detail: { contentType: type } };
  }

  // ⚠️ **503 עם JSON תקין הוא 'unhealthy' ולא 'not-api'.** ה-API שם ועונה;
  // מה שחולה הוא המסד או ה-MQTT. מיזוג השניים היה שולח לתקן את כתובת
  // ה-API בזמן שהבעיה היא לגמרי אחרת.
  return { kind: res.ok ? "healthy" : "unhealthy", status: res.status, detail: body };
}

/** האם הכתובת היא נתיב יחסי. לשימוש בהודעה בלבד. */
export const isRelative = (apiRoot) => !apiRoot;
