// auth/providers/supabase.js — המצב הפעיל.
//
// ============================================================
// מה הספק הזה עושה, ומה הוא במפורש *לא* עושה
// ============================================================
// הוא **מאמת** אסימון שנחתם ע"י Supabase Auth (GoTrue). הוא אינו מבצע
// התחברות, הרשמה, איפוס סיסמה או אישור אימייל — כל אלה קורים **בדפדפן**
// מול GoTrue, והשרת לעולם לא רואה סיסמה.
//
// זו האסימטריה שקובעת איפה נמצא ה-seam: התחברות אינה סימטרית בין המצבים
// (במצב עצמי היא חייבת להיות נקודת קצה בשרת), ולכן ה-seam הוא **אימות
// אסימון** — הפעולה שכן נדרשת בשרת בשני המצבים.
//
// ============================================================
// ES256 ולא HS256 — וזה לא בחירה, זה מה שהפרויקט חותם
// ============================================================
// הקובץ הזה אימת קודם HS256 מול SUPABASE_JWT_SECRET. בדיקה מול הפרויקט
// האמיתי הראתה שהוא חותם ב-**ES256** ומפרסם מפתח ציבורי ב-JWKS:
//
//     GET <SUPABASE_URL>/auth/v1/.well-known/jwks.json
//     → { keys: [{ alg: "ES256", kty: "EC", crv: "P-256", kid: … }] }
//
// כלומר הגרסה הקודמת לא הייתה מאמתת שום אסימון אמיתי, אף פעם — היא הייתה
// "עוברת בדיקות" מול אסימונים שהבדיקה עצמה חתמה, וזה בדיוק סוג הכשל
// שבדיקות חוזה נועדו למנוע וכאן דווקא הסתירו.
//
// תוצאת משנה חשובה: **אין סוד לאחסן.** אימות אסימטרי משתמש במפתח ציבורי,
// ולכן SUPABASE_JWT_SECRET אינו נדרש — וגם לא מפתח ה-Secret של הפרויקט.
// ההגדרה היחידה הנחוצה היא SUPABASE_URL.

const { verifyEs256 } = require("../jwt");
const jwks = require("../jwks");

// המנפיק של Supabase נגזר מכתובת הפרויקט: <url>/auth/v1. נאכף כשאפשר, כדי
// שאסימון תקין של פרויקט *אחר* לא ייחשב שלנו.
function expectedIssuer() {
  const base = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  return base ? `${base}/auth/v1` : null;
}

function isConfigured() {
  return jwks.isConfigured();
}

/**
 * @returns {Promise<{userId: string, email: string|null, role: string}|null>}
 *
 * **אסינכרוני**, בשונה מהגרסה הקודמת: אימות אסימטרי מחייב את המפתח
 * הציבורי, והוא נמשך מהרשת (וממוטמן). הקוראים חייבים await.
 *
 * התפקיד היישומי נקרא מ-parkomat_role ולא מ-role: ב-Supabase התביעה 'role'
 * מחזיקה את תפקיד ה-Postgres ('authenticated'), וזו שאלה אחרת לגמרי —
 * "האם התחברת" ולא "מה מותר לך". אותה הבחנה קיימת ב-app.current_role()
 * בצד ה-SQL, וההתאמה ביניהם אינה מקרית.
 */
async function verifyToken(token) {
  if (!isConfigured()) return null;

  const claims = await verifyEs256(token, (kid) => jwks.getKey(kid), {
    issuer: expectedIssuer(),
  });
  if (!claims || typeof claims.sub !== "string" || claims.sub.length === 0) return null;

  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    role: typeof claims.parkomat_role === "string" && claims.parkomat_role
      ? claims.parkomat_role
      : "operator",   // ברירת מחדל שמרנית: הרשאות הצפייה בלבד
  };
}

module.exports = { name: "supabase", isConfigured, verifyToken, expectedIssuer };
