// auth/providers/selfhosted.js — המצב הרדום.
//
// ============================================================
// למה הוא קיים כשהוא לא בשימוש
// ============================================================
// קוד רדום שאינו נבדק נרקב בשקט ונכשל בדיוק ביום שבו הוא נדרש. הספק הזה
// מאמת אסימונים שאנחנו חתמנו, ונבדק באותה סוויטת חוזה כמו ספק Supabase —
// אותם מקרים, אותה צורת החזרה. כך "אפשר לעזוב את Supabase" הוא קובץ
// שנבדק ולא הצהרה בתכנון.
//
// ============================================================
// מה מכוון להיות חסר כאן
// ============================================================
// אין טבלת משתמשים, אין גיבוב סיסמאות ואין נקודת התחברות — **בכוונה**.
// היום אין במערכת משתמשים בכלל (התפקיד בדשבורד הוא useState בדפדפן), ולכן
// מודל משתמשים שייכתב עכשיו ייכתב מול ניחוש, וגרוע מזה — הבדיקות ינעלו את
// הניחוש. זה נשאר לשלב שאחרי שיהיו משתמשים אמיתיים.
//
// מה שכן קיים עכשיו הוא ה-seam: אימות אסימון בחוזה זהה. זה החלק שאם לא
// יונח מראש, כל מדיניות וכל נתיב יצטרכו שכתוב ביום המעבר.
//
// AUTH_JWT_SECRET — הסוד שבו אנחנו חותמים. בלעדיו הספק אינו מוגדר ואימות
// מחזיר null. נכשל סגור, כמו ספק Supabase.

const { verify, sign } = require("../jwt");

const SECRET = process.env.AUTH_JWT_SECRET || "";
const ISSUER = process.env.AUTH_JWT_ISSUER || "parkomat";

function isConfigured() {
  return SECRET.length > 0;
}

/**
 * אותה צורת החזרה בדיוק כמו ספק Supabase. זו כל הנקודה — הקורא אינו יודע
 * מי אימת.
 *
 * @returns {Promise<{userId: string, email: string|null, role: string}|null>}
 *
 * **אסינכרוני** אף שהאימות כאן סינכרוני לגמרי: החוזה חייב להיות זהה לספק
 * Supabase, שם המפתח הציבורי נמשך מהרשת. ממשק שמשתנה בין המצבים אינו seam.
 */
async function verifyToken(token) {
  if (!isConfigured()) return null;

  const claims = verify(token, SECRET, { issuer: ISSUER });
  if (!claims || typeof claims.sub !== "string" || claims.sub.length === 0) return null;

  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    role: typeof claims.parkomat_role === "string" && claims.parkomat_role
      ? claims.parkomat_role
      : "operator",
  };
}

/**
 * הנפקת אסימון. קיימת רק במצב הזה: ב-Supabase ההנפקה נעשית ע"י GoTrue
 * בדפדפן, והשרת לעולם לא רואה סיסמה. זו האסימטריה שמתועדת ב-provider.js.
 *
 * אינה בשימוש בזרימה חיה — היא הכלי שמאפשר לבדוק את מסלול האימות מקצה
 * לקצה בלי רשת, וגם הבסיס לנקודת ההתחברות כשהיא תיכתב.
 */
function issueToken({ userId, email = null, role = "operator", expiresInSeconds = 3600 }) {
  if (!isConfigured()) throw new Error("auth: AUTH_JWT_SECRET לא מוגדר");
  return sign(
    { sub: userId, email, parkomat_role: role, iss: ISSUER },
    SECRET,
    { expiresInSeconds }
  );
}

module.exports = { name: "selfhosted", isConfigured, verifyToken, issueToken };
