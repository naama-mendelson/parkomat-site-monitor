// services/maintenanceDirect.js — פתיחה וביטול של חלון תחזוקה, ישירות ל-Supabase.
//
// ============================================================
// הכתיבה הראשונה שאינה עוברת בשרת
// ============================================================
// עד כה כל כתיבה עברה ב-Node, שמתחבר כ-`postgres` ועוקף RLS. כאן הדפדפן
// קורא ל-RPC ב-Postgres ישירות דרך PostgREST, והשרת אינו מתערב בכלל.
//
// ⚠️ **וזו הפעולה שנבחרה ראשונה לא במקרה:** אנשי שירות פותחים חלונות
// בשטח, מחוץ לרשת המשרד — ובדיוק שם עדיף שהיא לא תלויה בשרת שעלול להיות
// למטה. היא גם הפשוטה ביותר: טבלה אחת, בלי מגני נעילה.
//
// ============================================================
// ⚠️ מה **לא** עובר כאן, וזה מכוון
// ============================================================
// הכללים אינם בקוד הזה אלא ב-`db/writes.postgres.sql`:
//
//   • תקרת 720 שעות
//   • חישוב `expires_at` — הלקוח **אינו** שולח אותו
//   • `set_by_name` — נגזר מהזהות המאומתת ומתעלם ממה שנשלח
//   • שורת ביקורת ורישום אירוע
//
// ⚠️ **הקובץ הזה הוא מתאם, לא לוגיקה.** כל אימות שיישב כאן היה עוקף
// בפתיחת DevTools. הפונקציה ב-SQL היא הגבול.
//
// ⚠️ ולכן גם `name` **אינו** נשלח: השרת דרש אותו בגוף הבקשה, וכאן הוא
// נקבע במסד. השארת הפרמטר הייתה נראית כאילו הוא משנה משהו.
import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * ממיר שגיאת PostgREST להודעה בעברית.
 *
 * ⚠️ הפונקציה ב-SQL מנפיקה **קודי SQLSTATE מכוונים**, ולכן ההודעה שלה
 * ניתנת להצגה כמות שהיא. מה שכן צריך תרגום הוא `42501` — "permission
 * denied for function" — שהוא ההודעה של Postgres ולא שלנו, ומי שיראה
 * אותה לא יבין שהמשמעות היא "אינך מחובר, או שהחשבון הושבת".
 */
function messageFor(error) {
  if (!error) return "שגיאה לא ידועה";
  if (error.code === "42501") {
    return "אין הרשאה — יש להתחבר מחדש, או שהחשבון הושבת";
  }
  return error.message || "הפעולה נכשלה";
}

/** פתיחת חלון תחזוקה. זורק Error עם הודעה בעברית. */
export async function startMaintenanceDirect(code, durationHours, reason = "") {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const { data, error } = await supabase.rpc("start_maintenance", {
    p_site_code: String(code),
    p_duration_hours: Number(durationHours),
    p_reason: reason ? String(reason) : null,
  });

  if (error) throw new Error(messageFor(error));

  // ⚠️ RETURNS TABLE מגיע כמערך גם כשיש שורה אחת. שכבת ה-UI מצפה לאובייקט,
  // ובלי הפירוק הזה היא הייתה מקבלת מערך ומציגה undefined בשקט.
  const row = Array.isArray(data) ? data[0] : data;
  return {
    id: row?.id ?? null,
    startedAt: row?.started_at ?? null,
    expiresAt: row?.expires_at ?? null,
    setByName: row?.set_by_name ?? null,
  };
}

/** ביטול החלון הפעיל. מחזיר כמה שורות בוטלו — 0 הוא תשובה תקינה. */
export async function cancelMaintenanceDirect(code) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const { data, error } = await supabase.rpc("cancel_maintenance", {
    p_site_code: String(code),
  });

  if (error) throw new Error(messageFor(error));

  const row = Array.isArray(data) ? data[0] : data;
  // ⚠️ 0 אינו כשל: אפשר לגמרי ששני אנשים לחצו יחד, או שהחלון פג בדיוק
  // בינתיים. זריקת שגיאה כאן הייתה הופכת מקרה תקין לתקלה על המסך.
  return { cancelled: Number(row?.cancelled ?? 0) };
}
