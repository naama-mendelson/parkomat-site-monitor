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
