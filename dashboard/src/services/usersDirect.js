// services/usersDirect.js — רשימת המשתמשים, השבתה ושינוי תפקיד, ישירות ל-Supabase.
//
// ============================================================
// ⚠️ שלוש פעולות מתוך חמש — והשתיים האחרות עזבו גם הן, בדרכים שונות
// ============================================================
// ⚠️ **כאן היה כתוב ש`inviteUser` ו-`deleteUser` נשארים בשרת. זה כבר לא
// נכון**, ו-`api/routes.js` מגיש היום שני מסלולים בסך הכול (`/api/chat`
// ו-`/health`). הנימוק המקורי נשמר כאן כי הוא עדיין מסביר את ההבדל
// **ביניהן**:
//
//   `inviteUser` → Edge Function `invite-user`. יצירת משתמש ב-GoTrue
//     עוברת ב-Admin API, כלומר דורשת את מפתח ה-Secret. המפתח עוקף RLS
//     לחלוטין ואסור לו להגיע לדפדפן (כלל 7), ולכן זו הפעולה היחידה
//     שבאמת חייבת רכיב שמחזיק סוד.
//
//   `deleteUser` → RPC `delete_user`, ב-`usersInviteDirect.js`. היא
//     **לא** צריכה את ה-Secret: `SECURITY DEFINER` בתוך המסד מוחק את שתי
//     השורות באותה טרנזקציה. הגרסה שעברה ב-Edge Function עשתה זאת בשתי
//     קריאות, וכשל ביניהן השאיר משתמש שיכול להתחבר בלי שורת זהות.
//
// ⚠️ **וזו התשובה המלאה ל"למה ניהול המשתמשים לא ישר ב-Supabase":** ארבע
// מתוך חמש כן, בתוך המסד. אחת — ההזמנה — לא, ורק בגלל הסוד.
//
// ============================================================
// ⚠️ ומה שאִפשר את שינוי התפקיד לעבור בכלל
// ============================================================
// קודם, שינוי תפקיד היה חייב לעדכן **שניים** — `app_users` ו-
// `app_metadata` שבאסימון — כי הדשבורד קרא את התפקיד מהתביעה. הסנכרון
// השני דורש את ה-Admin API, ולכן כל המסלול היה תקוע בשרת.
//
// מרגע שהדשבורד קורא `public.my_role()` (ראה `services/auth.js`),
// `app_users` הוא צד אחד של אמת. המחיר, במפורש: `app_metadata` בלוח הבקרה
// של Supabase יישאר עם התפקיד הישן — נתון שאינו הסמכות, ומי שיסתכל שם
// יראה משהו אחר ממה שהמערכת אוכפת.
import { supabase, isSupabaseConfigured } from "./supabase";

function messageFor(error, fallback) {
  if (!error) return fallback;
  // "permission denied for function" — ההודעה של Postgres, לא שלנו.
  if (error.code === "42501") return "הפעולה מותרת למנהלים בלבד";
  return error.message || fallback;
}

function assertConfigured() {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
}

/**
 * רשימת המשתמשים.
 *
 * ⚠️ המבנה חייב להיות זהה לתשובת השרת — `{ users: [{ id, email, fullName,
 * role, is_active, createdAt, disabledAt, lastSignInAt }] }`. `UsersPanel`
 * קורא בדיוק את השמות האלה, ושם שדה שונה היה מציג עמודה ריקה בלי שגיאה.
 *
 * ⚠️ ושמות הפלט ב-SQL מתחילים ב-`out_` בכוונה (ראה `db/writes.postgres.sql`),
 * ולכן המיפוי כאן אינו קוסמטי אלא חלק מהחוזה.
 */
export async function fetchUsersDirect() {
  assertConfigured();

  const { data, error } = await supabase.rpc("list_users");
  if (error) throw new Error(messageFor(error, "שגיאה בטעינת המשתמשים"));

  return {
    users: (data || []).map((u) => ({
      id: u.out_id,
      email: u.out_email,
      fullName: u.out_full_name,
      role: u.out_role,
      is_active: u.out_is_active,
      createdAt: u.out_created_at,
      disabledAt: u.out_disabled_at,
      lastSignInAt: u.out_last_sign_in_at,
    })),
  };
}

/**
 * השבתה או החזרה לפעילות.
 *
 * ⚠️ שני מגני הנעילה חיים ב-SQL (`set_user_active`) ולא כאן: אין להשבית
 * את עצמך, ואין להשבית את המנהל הפעיל האחרון. בדיקה בקוד הזה הייתה
 * נעקפת בפתיחת DevTools.
 */
export async function setUserActiveDirect(id, isActive) {
  assertConfigured();

  const { data, error } = await supabase.rpc("set_user_active", {
    p_user_id: Number(id),
    p_active: Boolean(isActive),
  });
  if (error) throw new Error(messageFor(error, "עדכון המשתמש נכשל"));

  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, id: row?.out_id ?? Number(id), is_active: row?.out_is_active ?? isActive };
}

/** שינוי תפקיד. העלאה תמיד מותרת; הורדה כפופה לאותם שני מגנים. */
export async function setUserRoleDirect(id, role) {
  assertConfigured();

  const { data, error } = await supabase.rpc("set_user_role", {
    p_user_id: Number(id),
    p_role: String(role),
  });
  if (error) throw new Error(messageFor(error, "שינוי התפקיד נכשל"));

  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, id: row?.out_id ?? Number(id), role: row?.out_role ?? role };
}
