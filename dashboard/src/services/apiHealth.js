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
// ניהול משתמשים, והעוזר.
//
// ============================================================
// ⚠️ בודקים נתיב **תחת /api**, ולא /health — וזה תיקון של באג
// ============================================================
// הגרסה הראשונה בדקה `/health`. הוא פתוח בלי אימות ומחזיר JSON, ולכן הוא
// נראה כמו הבחירה הטבעית. **והוא היה שגוי**, כי הוא נתיב שהאפליקציה אינה
// משתמשת בו:
//
//     ה-proxy של Vite מכסה "/api" בלבד (dashboard/vite.config.js).
//     :5173/health     → 200 text/html   ← Vite מחזיר index.html
//     :5173/api/sites  → 401 application/json
//
// כלומר הפס נדלק **בסביבת הפיתוח**, שבה הכול תקין לגמרי. מה שצריך להיבדק
// הוא הקידומת שהאפליקציה באמת פונה אליה, ולא נתיב שנוח לבדוק.
//
// ⚠️ **ו-401 הוא תשובה חיובית כאן.** `{"error":"נדרשת התחברות"}` ב-JSON הוא
// הוכחה שה-API ענה — הבדיקה רצה לפני התחברות, ואין לה אסימון. מה שמסגיר
// כתובת שגויה הוא **סוג התוכן**, לא הסטטוס.

const TIMEOUT_MS = 8000;

// נתיב תחת /api שאינו עושה עבודה: requireAuth עוצר אותו לפני כל שאילתה,
// ולכן הבדיקה עולה 401 מיד ולא נוגעת במסד.
const PROBE_PATH = "/api/sites";

/**
 * @returns {Promise<{kind:string, status?:number, detail?:object}>}
 *   'ok'          — הגיעה תשובת JSON. ה-API נמצא בכתובת הזו (גם 401 נחשב).
 *   'not-api'     — משהו ענה, אבל לא ב-JSON. כמעט תמיד VITE_API_BASE שגוי.
 *   'unreachable' — לא הגיעה תשובה בכלל.
 */
export async function probeApi(apiRoot = "") {
  const url = `${apiRoot}${PROBE_PATH}`;

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

  // ⚠️ הבדיקה המכריעה, ואינה נוגעת בסטטוס. `includes` ולא השוואה: הכותרת
  // מגיעה כ-"application/json; charset=utf-8".
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) {
    return { kind: "not-api", status: res.status, detail: { contentType: type } };
  }

  return { kind: "ok", status: res.status };
}

/** האם הכתובת היא נתיב יחסי. לשימוש בהודעה בלבד. */
export const isRelative = (apiRoot) => !apiRoot;
