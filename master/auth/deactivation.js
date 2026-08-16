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

module.exports = { canDeactivate };
