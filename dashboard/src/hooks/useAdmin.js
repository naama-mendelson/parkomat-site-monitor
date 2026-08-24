// hooks/useAdmin.js — מי רשאי לנהל אתרים.
//
// ============================================================
// ⚠️ שני מנגנונים שונים, לפי המתג — וזה לא כפילות
// ============================================================
// **במצב ישיר** (ברירת המחדל היום) ההרשאה היא **תפקיד מאומת**. הכתיבות
// עוברות ל-`register_site` / `update_site` / `delete_site` ב-Postgres, שכולן
// קוראות ל-`app.require_manager()` — קריאה מ-`app_users`, לא מהאסימון.
//
// **במצב שרת** ההרשאה היא **קוד משותף** (`x-admin-code`). זה מה שהיה קיים
// לפני שהיו משתמשים בכלל, וזה מה שנשאר בנתיבי השרת — שהם דלת החירום.
//
// ============================================================
// ⚠️ הקוד המשותף חזר למצב הישיר — החלטת מוצר, ולא נסיגה
// ============================================================
// כאן היה מתועד למה **לא** להשתמש ב-`admin123` במצב ישיר, ושני הנימוקים
// עדיין נכונים כשלעצמם: הערך נמצא בקוד הפתוח, והוא מבטיח הרשאה שאין לו.
// ההכרעה החדשה מקבלת אותם ובוחרת אחרת, כי המטרה שונה:
//
// ⚠️ **זה אינו מנעול אלא צעד אישור.** ההגנה לא זזה מילימטר — היא
// `app.require_manager()` בתוך register_site / update_site / delete_site,
// ונאכפת ב-Postgres בין אם הוקלד קוד ובין אם לא. בקר שיקליד `admin123`
// ייכנס למסך ויקבל 403 מהמסד על כל פעולה.
//
// מה שהקוד כן קונה: **הגנה מפני לחיצה בטעות** על "מחק אתר" — פעולה
// שמוחקת היסטוריה ואין ממנה דרך חזרה.
//
// ⚠️ ולכן המסך **נעול בכל פתיחה**, ואין כפתור "נעל": אין מה לנעול, הוא
// ננעל מעצמו בסגירה.
import { useState, useCallback } from "react";
// ⚠️ מ-Supabase ולא מהשרת: בענן אין שרת, והנעילה פשוט נכשלה שם.
// הגיבוב מושווה בתוך הפונקציה ב-SQL ולעולם אינו מגיע לדפדפן.
import { verifyAdminCode } from "../services/dataSource";
import { isUnlocked as getAdminCode, markUnlocked as storeAdminCode, lockAgain } from "../services/adminCodeDirect";
import { useDirect } from "../services/dataSource";
import { useAuth } from "./useAuth";

export function useAdmin() {
  const { user, loading } = useAuth();

  const [codeUnlocked, setCodeUnlocked] = useState(() => Boolean(getAdminCode()));
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  const isManager = user?.role === "manager";

  const unlockByCode = useCallback(async (code) => {
    setChecking(true);
    setError(null);
    try {
      // ⚠️ הפונקציה מחזירה false על קוד שגוי ואינה זורקת — זריקה שמורה
      // לתקלה אמיתית. בלי ההבחנה "קוד שגוי" היה נראה כמו נפילת רשת.
      const ok = await verifyAdminCode(code);
      if (!ok) { setError("קוד מנהל שגוי"); return false; }
      storeAdminCode();
      setCodeUnlocked(true);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setChecking(false);
    }
  }, []);

  // ⚠️ "נעל" חייב **למחוק** את הסימון ולא לכתוב null: storeAdminCode(null)
  // בגרסה הקודמת שמר את המחרוזת "null" ב-localStorage, וההרשאה נשארה
  // פתוחה — הכפתור אמר "נעול" ולא נעל. עכשיו lockAgain מסיר את המפתח.
  const lock = useCallback(() => {
    lockAgain();
    setCodeUnlocked(false);
  }, []);

  // ============================================================
  // ⚠️ נעול בכל פתיחה — החלטת מוצר, והיא הפוכה למה שהיה כאן
  // ============================================================
  // עד עכשיו מנהל נכנס ישר, ו"נעל" היה פעולה יזומה. ההחלטה החדשה:
  // **המסך נעול תמיד, וכל פתיחה דורשת את קוד המנהל.** אין כפתור נעילה,
  // כי אין מה לנעול — הוא ננעל מעצמו ברגע שנסגר.
  //
  // ⚠️ **וזה אינו מנעול, אלא צעד אישור.** ערך ברירת המחדל `admin123`
  // נמצא בקוד הפתוח, ולכן מי שרוצה לעקוף אותו יכול. ההגנה האמיתית לא
  // זזה מילימטר: `app.require_manager()` בתוך register_site /
  // update_site / delete_site נאכפת ב-Postgres בין אם הוקלד קוד ובין אם
  // לא. מה שהקוד קונה הוא הגנה מפני **לחיצה בטעות** על "מחק אתר",
  // ופעולה שאין ממנה דרך חזרה.
  //
  // ⚠️ ולכן `useState(false)` ולא אחסון: AdminPanel מתפרק בכל סגירה
  // (`{adminOpen && <AdminPanel/>}` ב-App), וה-state מת איתו. בדיוק
  // ההתנהגות שהייתה באג כשניסינו **לנעול**, והיא הנכונה כשרוצים
  // **להיות נעולים**.
  const [codeOkThisOpen, setCodeOkThisOpen] = useState(false);

  const unlockDirectByCode = useCallback(async (code) => {
    setChecking(true);
    setError(null);
    try {
      const ok = await verifyAdminCode(code);
      if (!ok) { setError("קוד מנהל שגוי"); return false; }
      setCodeOkThisOpen(true);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setChecking(false);
    }
  }, []);

  if (useDirect) {
    return {
      unlocked: isManager && codeOkThisOpen,
      unlock: unlockDirectByCode,
      // ⚠️ פונקציה ריקה ולא הסרה: AdminPanel עדיין מקבל `lock` מה-hook,
      // והמסך פשוט אינו מציג עוד כפתור. אין מה לנעול — סגירה נועלת.
      lock: () => {},
      checking: checking || loading,
      error,
      // ============================================================
      // ⚠️ roleGated רק כשבאמת אין תפקיד — וזה היה הבאג השני
      // ============================================================
      // כאן היה `true` קבוע, ואז **מנהל לא היה מגיע לטופס הקוד לעולם** —
      // הוא היה נתקע במסך "התפקיד שלך: מנהל", בלי שדה ובלי דרך להמשיך.
      //
      // מנהל חסום משום שהמסך נעול, לא בגלל תפקידו, ולכן הוא מקבל את הטופס.
      // בקר — שאין לו הרשאה בשום מצב — נשאר עם מסך התפקיד, שהוא התשובה
      // הנכונה עבורו: טופס שייתן לו להיכנס ואז 403 על כל לחיצה גרוע יותר.
      roleGated: !isManager,
      role: user?.role ?? null,
    };
  }

  return {
    unlocked: codeUnlocked,
    unlock: unlockByCode,
    lock,
    checking,
    error,
    roleGated: false,
    role: user?.role ?? null,
  };
}
