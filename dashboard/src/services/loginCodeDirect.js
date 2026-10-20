// services/loginCodeDirect.js — קוד הכניסה במייל (20/10/2026), מאחורי ה-seam.
//
// ⚠️ האכיפה אינה כאן: התחברות שלא הקלידה קוד אינה קוראת ואינה כותבת דבר במסד (app.session_ok,
// security.postgres.sql). המסך רק מבקש את הקוד לפני שהדשבורד יטען — כדי שהמשתמש לא יראה מסך ריק של שגיאות הרשאה.
//
// ⚠️ הפונקציות מחזירות שגיאה כערך ולא זורקות, כמו signIn: מסך שנופל על חריגה בזמן התחברות משאיר את המשתמש בלי
// דרך פנימה ובלי הסבר.
import { supabase, isSupabaseConfigured } from "./supabase";

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

/** { required, verified, email } — או { error } כשהבדיקה עצמה נכשלה. */
export async function loginCodeStatus() {
  if (!isSupabaseConfigured) return { required: false, verified: true, email: null };
  const { data, error } = await supabase.rpc("login_code_status");
  if (error) {
    // ⚠️ מסד שעוד לא קיבל את ה-SQL: אין קוד, כמו קודם. כל כשל אחר — לא מנחשים.
    if (error.code === "PGRST202" || /could not find the function/i.test(error.message || "")) {
      return { required: false, verified: true, email: null };
    }
    return { error: error.message || "הבדיקה נכשלה" };
  }
  return { required: !!data?.required, verified: !!data?.verified, email: data?.email || null };
}

/**
 * מבקש קוד במייל. { status, email, resend_in } — status: sent / pending / wait / verified / not_required;
 * או { error, status?, per? } (429 = תקרה).
 */
export async function sendLoginCode({ resend = false } = {}) {
  if (!isSupabaseConfigured) return { error: "Supabase אינו מוגדר בדשבורד" };
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: "נדרשת התחברות מחדש" };
  try {
    const res = await fetch(`${FUNCTIONS_URL}/send-login-code`, {
      method: "POST",
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resend }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body.error || "שליחת הקוד נכשלה", status: body.status, per: body.per };
    return body;
  } catch {
    return { error: "אין חיבור — נסו שוב" };
  }
}

/** { ok } או { ok: false, error: wrong / locked / expired / none / format / no_session / network, left? } */
export async function verifyLoginCode(code) {
  if (!isSupabaseConfigured) return { ok: false, error: "network" };
  const { data, error } = await supabase.rpc("login_code_verify", { p_code: String(code ?? "") });
  if (error) return { ok: false, error: "network" };
  return data && typeof data === "object" ? data : { ok: false, error: "none" };
}
