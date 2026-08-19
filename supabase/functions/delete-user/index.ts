// supabase/functions/delete-user — מחיקת משתמש, בלי השרת.
//
// ============================================================
// ⚠️ הכללים ב-SQL, לא כאן — ולמה זה לא בחירת סגנון
// ============================================================
// הגרסה הראשונה עשתה את הכול דרך לקוח service_role: שולפת מ-app_users,
// בודקת את המנעולים ב-TypeScript, ומוחקת. **נמדד: היא נכשלה ב-
// "permission denied for table app_users"** — הלקוח בפונקציה אינו עוקף
// RLS כפי שהנחתי.
//
// התיקון אינו למצוא מפתח חזק יותר אלא ללכת בתבנית שכבר עובדת בכל
// הפרויקט: `SECURITY DEFINER` שרץ בהרשאות הבעלים, עם בדיקת הזהות **בתוך
// גוף הפונקציה**. אותה תבנית בדיוק כמו start_maintenance ו-register_site.
//
// ⚠️ ויתרון נוסף, חשוב יותר: שני המנעולים — אי אפשר למחוק את עצמך, ואי
// אפשר למחוק את המנהל הפעיל האחרון — חיים עכשיו **במסד**. גם קריאה ישירה
// שעוקפת את הפונקציה הזו תיתקל בהם.
//
// ============================================================
// הסדר: בדיקה → מחיקה ב-Supabase → מחיקה אצלנו
// ============================================================
// ⚠️ הסדר ההפוך משאיר, בכשל, משתמש שעדיין יכול להתחבר בלי שורת app_users
// — מאומת, בלי זהות, ו-provision_app_user לא ייצור לו שורה חדשה כי אין
// INSERT נוסף. לכן הבדיקה והמחיקה מופרדות לשתי קריאות.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

// ⚠️ קודי SQLSTATE מכוונים → סטטוס HTTP. בלי המיפוי כל דחייה נראית כמו
// תקלת שרת, ו"אי אפשר למחוק את עצמך" היה מוצג כ-500.
function statusFor(err: { code?: string; message?: string }) {
  const m = String(err?.message ?? "");
  if (m.includes("מנהלים בלבד")) return 403;
  if (m.includes("לא נמצא")) return 404;
  if (m.includes("עצמך") || m.includes("האחרון")) return 400;
  return 500;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "נדרשת הזדהות" }, 401);

  const id = Number((await req.json().catch(() => ({})))?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "מזהה משתמש לא תקין" }, 400);

  // ⚠️ בזהות **הקורא**: הפונקציות ב-SQL בודקות app.current_actor(), ולקוח
  // service_role היה מגיע בלי זהות ונדחה — או גרוע, עוקף את הבדיקה.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  // שלב 1 — כל הכללים נאכפים כאן, ומחזירים את מה שצריך למחיקה ב-Supabase.
  const { data: rows, error: checkErr } = await asCaller.rpc("delete_user_check", { p_id: id });
  if (checkErr) return json({ error: checkErr.message }, statusFor(checkErr));

  const target = Array.isArray(rows) ? rows[0] : rows;
  if (!target) return json({ error: "משתמש לא נמצא" }, 404);

  // שלב 2 — Supabase קודם. ⚠️ ה-Admin API הוא הדבר היחיד שבאמת מחייב את
  // ה-Secret, והוא עובד (נמדד: ההזמנה מצליחה דרכו).
  if (target.uid) {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { error } = await admin.auth.admin.deleteUser(target.uid);
    // 404 = כבר לא קיים שם. הצלחה, לא כשל.
    if (error && !String(error.message).toLowerCase().includes("not found")) {
      return json({ error: "המחיקה ב-Supabase נכשלה — המשתמש לא נמחק" }, 502);
    }
  }

  // שלב 3 — השורה אצלנו, ושורת הביקורת. ⚠️ הביקורת נכתבת בתוך אותה
  // פונקציה, כלומר היא נרשמת רק אם המחיקה באמת קרתה.
  const { error: delErr } = await asCaller.rpc("delete_user_finish", { p_id: id });
  if (delErr) return json({ error: delErr.message }, statusFor(delErr));

  return json({ ok: true, id, email: target.email });
});
