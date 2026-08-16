// auth/deactivation.js — מי מותר להשבית, ומתי.
//
// ============================================================
// למה מודול נפרד ולא תנאי בתוך הנתיב
// ============================================================
// ⚠️ **הכלל היה בתוך ה-handler, ומוטציה ששברה אותו שרדה את הבדיקות.**
// הבדיקה חיפשה את שם המשתנה `activeManagers` בקוד — והוא נשאר שם גם
// כשהתנאי כובה ל-`if (false)`. כלומר נבדקה **נוכחות** ולא **התנהגות**.
//
// כפונקציה טהורה אפשר לבדוק את הכלל עצמו: קלט של משתמשים, פלט של
// החלטה. אותו דפוס בדיוק כמו SiteIdRule בסוכן ו-fault-text בקליטה.
//
// ============================================================
// שני הכללים, ולמה כל אחד מהם
// ============================================================
// ⚠️ **מנהל אינו משבית את עצמו** — לא נימוס אלא מניעת נעילה: אם הוא
// המנהל האחרון, אין מי שיחזיר אותו.
//
// ⚠️ **המנהל הפעיל האחרון אינו ניתן להשבתה** — בלי זה אפשר להגיע למצב
// שאין אף מנהל, ואז אי אפשר להזמין, להחזיר או לתקן כלום מהמסך. השחזור
// היחיד הוא ידני במסד.

/**
 * @param {Array<{id:number, role:string, is_active:boolean}>} users כל המשתמשים
 * @param {number} targetId  את מי משביתים
 * @param {number} actorId   מי מבצע
 * @returns {{allowed: boolean, reason?: string}}
 */
function canDeactivate(users, targetId, actorId) {
  const target = (users || []).find((u) => u.id === targetId);
  if (!target) return { allowed: false, reason: "משתמש לא נמצא" };

  if (targetId === actorId) {
    return { allowed: false, reason: "אי אפשר להשבית את עצמך" };
  }

  if (target.role === "manager") {
    const activeManagers = users.filter((u) => u.role === "manager" && u.is_active).length;
    if (activeManagers <= 1) {
      return { allowed: false, reason: "לא ניתן להשבית את המנהל הפעיל האחרון" };
    }
  }

  return { allowed: true };
}


/**
 * האם מותר לשנות תפקיד.
 *
 * ⚠️ **הורדת מנהל לבקר היא בדיוק אותה סכנה כמו השבתתו** — שתיהן מסירות
 * את יכולת הניהול. כלל שמגן רק על ההשבתה משאיר דלת פתוחה: מורידים את
 * המנהל האחרון לבקר, והמערכת נשארת בלי אף אחד שיכול להחזיר.
 *
 * ⚠️ והורדה **עצמית** חסומה מאותה סיבה שהשבתה עצמית חסומה: אין מי
 * שיחזיר.
 *
 * העלאה לתפקיד מנהל תמיד מותרת — היא אינה מפחיתה הרשאות מאיש.
 */
function canChangeRole(users, targetId, actorId, nextRole) {
  const target = (users || []).find((u) => u.id === targetId);
  if (!target) return { allowed: false, reason: "משתמש לא נמצא" };

  if (nextRole !== "operator" && nextRole !== "manager") {
    return { allowed: false, reason: "תפקיד לא תקין" };
  }
  if (target.role === nextRole) {
    return { allowed: false, reason: "זה כבר התפקיד שלו" };
  }

  // העלאה — תמיד מותרת.
  if (nextRole === "manager") return { allowed: true };

  // מכאן: הורדה ממנהל לבקר.
  if (targetId === actorId) {
    return { allowed: false, reason: "אי אפשר להוריד את עצמך מתפקיד מנהל" };
  }

  const activeManagers = users.filter((u) => u.role === "manager" && u.is_active).length;
  if (activeManagers <= 1) {
    return { allowed: false, reason: "לא ניתן להוריד את המנהל הפעיל האחרון" };
  }

  return { allowed: true };
}
/**
 * האם מותר **למחוק** משתמש לגמרי.
 *
 * ============================================================
 * ⚠️ מחיקה אינה השבתה חזקה יותר — היא פעולה אחרת
 * ============================================================
 * השבתה מנתקת גישה ומשאירה את השורה: מי היה, מתי צורף, ומי השבית אותו.
 * מחיקה מסירה את השורה **ואת המשתמש ב-Supabase**, ולכן:
 *
 *   • אי אפשר להחזיר אותו — רק להזמין מחדש, כמשתמש חדש לגמרי.
 *   • כל מה שנשאר ממנו הוא ה**צילומים**: `audit_log.actor_name` ו-
 *     `maintenance_windows.set_by_name` הם טקסט בלי FK, ולכן שורדים.
 *     זה לא מקרי — ככה הן תוכננו.
 *
 * ⚠️ **ולכן אותם שני מגני הנעילה חלים כאן במלואם, ואף ביתר שאת:** מנהל
 * שהשבית את עצמו בטעות ניתן להחזרה בידי מנהל אחר; מנהל שמחק את עצמו
 * ואין אחר — אין דרך חזרה מהמסך בכלל.
 */
function canDelete(users, targetId, actorId) {
  const target = (users || []).find((u) => u.id === targetId);
  if (!target) return { allowed: false, reason: "משתמש לא נמצא" };

  if (targetId === actorId) {
    return { allowed: false, reason: "אי אפשר למחוק את עצמך" };
  }

  // ⚠️ נספרים מנהלים **פעילים**, כמו בשאר הכללים — מנהל מושבת אינו מי
  // שיציל את המערכת. מחיקת המנהל הפעיל היחיד משאירה מערכת בלי ניהול.
  if (target.role === "manager") {
    const activeManagers = users.filter((u) => u.role === "manager" && u.is_active).length;
    if (activeManagers <= 1) {
      return { allowed: false, reason: "לא ניתן למחוק את המנהל הפעיל האחרון" };
    }
  }

  return { allowed: true };
}

module.exports = { canDeactivate, canChangeRole, canDelete };
