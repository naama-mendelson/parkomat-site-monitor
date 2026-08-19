// services/adminCodeDirect.js — קוד המנהל, מול Supabase.
//
// ============================================================
// ⚠️ מה זה כן, ומה זה לא
// ============================================================
// **זו אינה הגנה.** ההגנה האמיתית היא `app.require_manager()` בתוך פונקציות
// ה-SQL: בקר שינסה לרשום או למחוק אתר יקבל 403 מהמסד, בין אם הקוד בידיו
// ובין אם לא. נבדק חי.
//
// מה שזה כן: **צעד אישור לפני פעולה בלתי-הפיכה.** מחיקת אתר מוחקת היסטוריה,
// ושינוי `code` מפנה מחדש את הודעות ה-MQTT — שתיהן פעולות שאין להן ביטול,
// ולחיצה מקרית עליהן יקרה.
//
// ⚠️ **והגיבוב לעולם אינו מגיע לדפדפן.** ההשוואה נעשית בתוך הפונקציה
// ב-SQL; מה שנשלח הוא הקוד, ומה שחוזר הוא true/false. `settings` היא
// הטבלה היחידה בלי מדיניות RLS בדיוק מהסיבה הזו.
import { supabase } from "./supabase";

const KEY = "parkomat-admin-unlocked";

/** אימות הקוד מול המסד. מחזיר true/false, זורק רק על תקלה אמיתית. */
export async function verifyAdminCodeDirect(code) {
  const { data, error } = await supabase.rpc("verify_admin_code", { p_code: String(code ?? "") });
  if (error) throw new Error(error.message || "אימות הקוד נכשל");
  return data === true;
}

/** החלפת הקוד. מנהל בלבד, ונדרש הקוד הנוכחי. */
export async function setAdminCodeDirect(current, next) {
  const { error } = await supabase.rpc("set_admin_code", {
    p_current: String(current ?? ""), p_new: String(next ?? ""),
  });
  if (error) throw new Error(error.message || "שינוי הקוד נכשל");
  return true;
}

// ============================================================
// ⚠️ הנעילה נשמרת ל**מושב הזה בלבד**
// ============================================================
// sessionStorage ולא localStorage, וזה מה שמממש את מה שהתבקש: סגירת
// הלשונית נועלת מחדש. localStorage היה משאיר את הפאנל פתוח לנצח, וכל
// כניסה הבאה הייתה מדלגת על צעד האישור — כלומר הנעילה קיימת בשם בלבד.
//
// ⚠️ ו**הקוד עצמו אינו נשמר**, רק העובדה שהוא אומת. קוד שנשמר בדפדפן הוא
// קוד משותף שדלף, וזה בדיוק מה שהמנגנון הזה בא למנוע.
export const isUnlocked = () => {
  try { return sessionStorage.getItem(KEY) === "1"; } catch { return false; }
};
export const markUnlocked = () => {
  try { sessionStorage.setItem(KEY, "1"); } catch { /* מצב פרטי */ }
};
export const lockAgain = () => {
  try { sessionStorage.removeItem(KEY); } catch { /* מצב פרטי */ }
};
