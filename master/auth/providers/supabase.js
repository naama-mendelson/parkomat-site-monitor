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
 * ============================================================
 * התפקיד יושב ב-app_metadata, ולא כתביעה עליונה
 * ============================================================
 * הגרסה הראשונה קראה claims.parkomat_role. בדיקה מול אסימון אמיתי הראתה
 * שהוא **לא שם**: Supabase מקנן את app_metadata כאובייקט בתוך האסימון ואינו
 * משטח אותו לתביעות עליונות. התוצאה הייתה שמשתמש שהוגדר executive קיבל
 * בשקט operator — כלומר הורדת הרשאות שקטה, מהסוג שלא מייצר שגיאה ולכן לא
 * מתגלה עד שמישהו מתלונן שחסר לו כפתור.
 *
 * הסדר: app_metadata קודם (מה ש-Supabase באמת מייצר), ואז תביעה עליונה
 * כמסלול גיבוי — עבור Custom Access Token Hook שמשטח את התפקיד.
 *
 * ⚠️ **הסדר הזה חייב להיות זהה ל-app.current_role() בצד ה-SQL.** אם הם
 * ייבדלו, אותו אסימון ייתן תפקיד אחד ב-JS ותפקיד אחר במדיניות ה-RLS —
 * ואי-התאמה כזו מתגלה רק כשמישהו רואה מסך שאינו אמור לראות. יש בדיקה
 * שמקבעת את הסדר בדיוק מהסיבה הזו.
 *
 * **user_metadata אינו נבדק, וזה מכוון**: המשתמש עצמו יכול לערוך אותו דרך
 * updateUser. תפקיד שנקרא משם היה מאפשר לכל אחד להעלות את עצמו למנהל.
 * app_metadata ניתן לשינוי רק דרך ה-Admin API, כלומר עם מפתח ה-Secret.
 *
 * התפקיד היישומי נקרא מ-parkomat_role ולא מ-role: ב-Supabase התביעה 'role'
 * מחזיקה את תפקיד ה-Postgres ('authenticated'), וזו שאלה אחרת לגמרי —
 * "האם התחברת" ולא "מה מותר לך". אותה הבחנה קיימת ב-app.current_role()
 * בצד ה-SQL, וההתאמה ביניהם אינה מקרית.
 */
function readRole(claims) {
  const fromAppMetadata = claims.app_metadata && claims.app_metadata.parkomat_role;
  if (typeof fromAppMetadata === "string" && fromAppMetadata) return fromAppMetadata;
  if (typeof claims.parkomat_role === "string" && claims.parkomat_role) return claims.parkomat_role;
  return "operator";   // ברירת מחדל שמרנית: הרשאות הצפייה בלבד
}

async function verifyToken(token) {
  if (!isConfigured()) return null;

  const claims = await verifyEs256(token, (kid) => jwks.getKey(kid), {
    issuer: expectedIssuer(),
  });
  if (!claims || typeof claims.sub !== "string" || claims.sub.length === 0) return null;

  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    role: readRole(claims),
  };
}

module.exports = { name: "supabase", isConfigured, verifyToken, expectedIssuer };
