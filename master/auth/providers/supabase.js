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
// אסימון** — הפעולה שכן נדרשת בשרת בשני המצבים, עבור נתיב ה-AI וכל כתיבה
// שתישאר.
//
// SUPABASE_JWT_SECRET הוא הסוד שבו GoTrue חותם (Project Settings → API →
// JWT Secret). בלעדיו הספק אינו מוגדר, ואימות מחזיר null — כלומר "אין
// זהות", ולא "כל אחד מאומת". נכשל סגור.

const { verify } = require("../jwt");

const SECRET = process.env.SUPABASE_JWT_SECRET || "";

// המנפיק של Supabase. אם הוגדר — נאכף, כדי שאסימון תקין של פרויקט *אחר*
// לא ייחשב שלנו. אופציונלי כי הוא נגזר מכתובת הפרויקט ולא כולם מגדירים.
const ISSUER = process.env.SUPABASE_JWT_ISSUER || null;

function isConfigured() {
  return SECRET.length > 0;
}

/**
 * @returns {{userId: string, email: string|null, role: string}|null}
 *
 * התפקיד היישומי נקרא מ-parkomat_role ולא מ-role: ב-Supabase התביעה 'role'
 * מחזיקה את תפקיד ה-Postgres ('authenticated'), וזו שאלה אחרת לגמרי —
 * "האם התחברת" ולא "מה מותר לך". אותה הבחנה בדיוק קיימת ב-app.current_role()
 * בצד ה-SQL, וההתאמה ביניהם אינה מקרית.
 */
function verifyToken(token) {
  if (!isConfigured()) return null;

  const claims = verify(token, SECRET, { issuer: ISSUER });
  if (!claims || typeof claims.sub !== "string" || claims.sub.length === 0) return null;

  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    role: typeof claims.parkomat_role === "string" && claims.parkomat_role
      ? claims.parkomat_role
      : "operator",   // ברירת מחדל שמרנית: הרשאות הצפייה בלבד
  };
}

module.exports = { name: "supabase", isConfigured, verifyToken };
