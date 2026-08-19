// services/usersInviteDirect.js — הזמנת משתמש דרך Edge Function.
//
// ⚠️ **זו הייתה הפעולה האחרונה שחייבה את השרת.** היא דורשת את ה-Secret
// key, ולכן לא יכולה לרוץ בדפדפן — אבל מרגע שהדשבורד עבר ל-Cloudflare,
// ה-master אינו נגיש ממנו (מאחורי NAT, בלי כתובת ציבורית). התוצאה על
// המסך הייתה "הזמנת המשתמש נכשלה", בלי רמז לסיבה.
//
// ⚠️ והכלל "מנהלים בלבד" אינו כאן אלא בפונקציה: היא בודקת my_role() מול
// המסד. בדיקה בקוד הזה הייתה נעקפת בפתיחת DevTools.
import { supabase, isSupabaseConfigured } from "./supabase";

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

export async function inviteUserDirect(email, role = "operator") {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  // ⚠️ האסימון של המשתמש, לא המפתח הציבורי: הפונקציה מזהה לפיו מי קורא,
  // ובלעדיו היא מחזירה 401. שליחת ה-anon לבדו הייתה נראית כמו באג הרשאות.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("נדרשת התחברות מחדש");

  const res = await fetch(`${FUNCTIONS_URL}/invite-user`, {
    method: "POST",
    headers: {
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, role }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "הזמנת המשתמש נכשלה");
  return body;
}

/**
 * מחיקת משתמש — **RPC אחד, בלי Edge Function ובלי שרת.**
 *
 * ⚠️ הגרסה הקודמת עברה ב-Edge Function, וזה הוסיף שלב פריסה שאינו עובר
 * ב-git — כלומר תיקון שנדחף ל-main ולא הגיע לייצור עד שמישהו הריץ פקודה.
 * RPC מוחל ברגע שהוא נוצר במסד, ואין מה לפרוס.
 *
 * ⚠️ **ויתרון אמיתי מעבר לנוחות: הכול בטרנזקציה אחת.** הגרסה הקודמת מחקה
 * ב-Supabase ואז אצלנו בשתי קריאות נפרדות — וכשל בין השתיים היה משאיר
 * משתמש שיכול להתחבר בלי שורת זהות. כאן שתי המחיקות מתחייבות יחד או
 * נכשלות יחד.
 *
 * ⚠️ והכללים — מנהל בלבד, לא את עצמך, לא את המנהל הפעיל האחרון — יושבים
 * בגוף הפונקציה ב-SQL. גם קריאה ישירה שעוקפת את המסך תיתקל בהם.
 */
export async function deleteUserDirect(id) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const { data, error } = await supabase.rpc("delete_user", { p_id: Number(id) });
  if (error) throw new Error(error.message || "מחיקת המשתמש נכשלה");

  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, id: row?.id ?? id, email: row?.email ?? null };
}
