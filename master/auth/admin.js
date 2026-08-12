// auth/admin.js — ניהול משתמשים דרך ה-Admin API של Supabase.
//
// ============================================================
// למה זה בשרת ולא בדשבורד
// ============================================================
// יצירת משתמש מחייבת את מפתח ה-Secret, והוא עוקף RLS לחלוטין. מפתח כזה
// בדפדפן היה נותן לכל מי שפותח את ה-DevTools גישה מלאה לכל הנתונים —
// וגם היה מסתיר באגי מדיניות, כי שום מדיניות אינה חלה עליו.
//
// לכן ההזמנה עוברת דרך נתיב בשרת: הדשבורד מבקש, השרת מבצע. זה גם המקום
// היחיד בפרויקט שנוגע במפתח הזה.
//
// ============================================================
// למה יצירה עם סיסמה זמנית ולא הזמנה במייל
// ============================================================
// ל-Supabase יש /auth/v1/invite ששולח מייל. הוא תלוי ב-SMTP, ובברירת
// המחדל של Supabase המגבלה היא בודדים לשעה ולעיתים רק לחברי הצוות —
// כלומר הזמנה שנשלחת ולא מגיעה, בלי שגיאה. זה בדיוק סוג הכשל שאין לו
// סימן: המזמין חושב שהזמין, והמוזמן לא קיבל כלום.
//
// לכן המשתמש נוצר ישירות עם סיסמה זמנית שמוחזרת למזמין, והוא מעביר אותה.
// הפשרה גלויה: הסיסמה עוברת דרך אדם ולא דרך מייל. בתמורה — הזמנה שעובדת
// תמיד, ואפשר להחליף לזרימת מייל ברגע ש-SMTP יוגדר.

const URL_BASE = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SECRET = () => process.env.SUPABASE_SECRET_KEY || "";

function isConfigured() {
  return Boolean(URL_BASE() && SECRET());
}

async function adminFetch(path, init = {}) {
  const key = SECRET();
  const res = await fetch(`${URL_BASE()}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** סיסמה זמנית. base64url כדי שלא יהיו תווים שנאבדים בהעתקה או בוואטסאפ. */
function tempPassword() {
  return require("crypto").randomBytes(12).toString("base64url");
}

/**
 * יוצר משתמש חדש.
 *
 * ============================================================
 * התפקיד תמיד operator — וזו הגנה, לא ברירת מחדל
 * ============================================================
 * ההזמנה פתוחה לכל משתמש מחובר (החלטת מוצר). אם המזמין היה יכול לקבוע
 * תפקיד, כל בקר היה יכול ליצור לעצמו חשבון שני בתפקיד מנהל ולעלות בדרגה
 * — הסלמת הרשאות בלחיצה אחת. קביעת תפקיד נשארת ב-Admin API של Supabase,
 * כלומר דורשת את המפתח ידנית.
 *
 * @returns {{ok: true, user, tempPassword} | {ok: false, error, status}}
 */
async function createUser(email) {
  if (!isConfigured()) {
    return { ok: false, status: 503, error: "ניהול משתמשים אינו מוגדר בשרת" };
  }

  const clean = String(email || "").trim().toLowerCase();
  // בדיקה שטחית בכוונה: Supabase מאמת את הכתובת לעומק (כולל דחיית דומיינים
  // שאינם קיימים), ואין טעם לשכפל את הכלל שלו ולהתיישן מולו.
  if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    return { ok: false, status: 400, error: "כתובת אימייל לא תקינה" };
  }

  const password = tempPassword();
  const { ok, status, body } = await adminFetch("/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: clean,
      password,
      email_confirm: true,          // אין SMTP אמין — ראה ההסבר בראש הקובץ
      app_metadata: { parkomat_role: "operator" },
    }),
  });

  if (!ok) {
    // כתובת שכבר קיימת היא המקרה השכיח, וראוי לה הודעה משלה: "שגיאת שרת"
    // על משתמש שכבר הוזמן שולח את המזמין לחפש תקלה שאינה קיימת.
    // ⚠️ body.message הוא השדה ש-GoTrue מחזיר כששגיאת Postgres עולה דרכו
    // ({"code":"23514","message":"…"}), והוא **לא** היה ברשימה כאן. התוצאה
    // הייתה שכל דחייה של הטריגר הגיעה למסך כ-502 "יצירת המשתמש נכשלה", עם
    // ההודעה האמיתית בהישג יד ונזרקת.
    const msg = String(
      body?.msg || body?.error_description || body?.error || body?.message || ""
    );
    if (status === 422 || /already been registered|already exists/i.test(msg)) {
      return { ok: false, status: 409, error: "כבר קיים משתמש עם האימייל הזה" };
    }
    // ============================================================
    // דחייה בגלל חוק הדומיין — מדווחים, לא אוכפים
    // ============================================================
    // אכיפת הדומיין נמצאת **אך ורק ב-Supabase** (טריגר על auth.users), וכך
    // זה חייב להישאר: הכלל חוסם גם **הרשמה עצמית** ב-/auth/v1/signup, שאינה
    // עוברת כאן בכלל ופתוחה לכל אדם באינטרנט (disable_signup הוא false).
    // שכפול הבדיקה לכאן היה יוצר מקור אמת שני שיתיישן.
    //
    // מה שכן נעשה כאן הוא **העברת ההודעה של בסיס הנתונים**. בלי זה הטריגר
    // מחזיר 500 גנרי, המזמין רואה "שגיאת שרת" על כתובת פרטית שהקליד, והולך
    // לחפש תקלה שאינה קיימת. אנחנו לא מחליטים כלום — רק מפסיקים לבלוע את
    // הסיבה.
    //
    // הזיהוי הוא לפי **קוד השגיאה של Postgres** ולא לפי טקסט: 23514 הוא
    // check_violation, בדיוק ה-ERRCODE שהטריגר מנפיק. התאמת מחרוזת בעברית
    // הייתה נשברת בשקט ברגע שמישהו ינסח את ההודעה מחדש.
    if (body?.code === "23514") {
      return { ok: false, status: 400, error: msg };
    }
    // אותו מצב, כשהשכבה שמעל בלעה את ההודעה והשאירה רק "Database error".
    if (/database error creating new user/i.test(msg)) {
      return {
        ok: false,
        status: 400,
        error: "בסיס הנתונים דחה את הכתובת — ככל הנראה אינה מדומיין החברה",
      };
    }
    return { ok: false, status: status === 400 ? 400 : 502, error: msg || "יצירת המשתמש נכשלה" };
  }

  return {
    ok: true,
    user: { id: body.id, email: body.email, role: "operator" },
    tempPassword: password,
  };
}

/** רשימת המשתמשים — לתצוגה בדשבורד. בלי סודות ובלי מטא-דאטה מיותר. */
async function listUsers() {
  if (!isConfigured()) {
    return { ok: false, status: 503, error: "ניהול משתמשים אינו מוגדר בשרת" };
  }

  const { ok, body } = await adminFetch("/admin/users?per_page=200");
  if (!ok) return { ok: false, status: 502, error: "שליפת המשתמשים נכשלה" };

  const users = (body.users || []).map((u) => ({
    id: u.id,
    email: u.email,
    role: u.app_metadata?.parkomat_role || "operator",
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at || null,
  }));
  return { ok: true, users };
}

module.exports = { isConfigured, createUser, listUsers };
