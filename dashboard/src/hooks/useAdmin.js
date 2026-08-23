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
// ⚠️ למה לא להשאיר את הקוד גם במצב ישיר, "ליתר ביטחון"
// ============================================================
// כי הוא לא מוסיף ביטחון אלא מוריד אותו, בשתי דרכים ממשיות:
//
//   1. **הוא חוסם מנהל אמיתי.** ערך ברירת המחדל `admin123` מופיע בקוד
//      הפתוח. ביום שיוחלף, כל המנהלים ננעלים מחוץ למסך שהם כן רשאים לו —
//      ואף אחד לא יזכור שהמסד כבר לא מסתכל על הקוד הזה.
//
//   2. **הוא מבטיח הרשאה שאין לו.** בקר שמכיר את `admin123` היה נכנס
//      למסך, לוחץ "מחק אתר", ומקבל 403 מהמסד. זה בטוח — אבל זה מסך
//      שמבטיח פעולות שהוא אינו יכול לבצע, וזו הדרך הבטוחה לגרום למישהו
//      לחשוב שהמערכת שבורה.
//
// ⚠️ ובשני המצבים זו **אינה** האכיפה. ההכרעה במסד (או בשרת), והמסך רק
// מציג. הסתרת כפתור אינה אבטחה — ולכן `roleGated` חוזר החוצה, כדי שהמסך
// יאמר "מותר למנהלים בלבד" במקום להציג טופס שלא יעזור.
import { useState, useCallback } from "react";
// ⚠️ מ-Supabase ולא מהשרת: בענן אין שרת, והנעילה פשוט נכשלה שם.
// הגיבוב מושווה בתוך הפונקציה ב-SQL ולעולם אינו מגיע לדפדפן.
import { verifyAdminCode } from "../services/dataSource";
import { isUnlocked as getAdminCode, markUnlocked as storeAdminCode, lockAgain,
         reauthenticate, isDirectLocked, setDirectLocked } from "../services/adminCodeDirect";
import { useDirect } from "../services/dataSource";
import { useAuth } from "./useAuth";

export function useAdmin() {
  const { user, loading } = useAuth();

  const [codeUnlocked, setCodeUnlocked] = useState(() => Boolean(getAdminCode()));
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  // ⚠️ "נעל" הוא הסתרה ולא הסרת הרשאה. במצב ישיר ההרשאה נגזרת מהתפקיד,
  // ולכן בלי המשתנה הזה הכפתור לא היה עושה כלום למנהל — הוא היה נפתח שוב
  // מיד. זה נשאר מנגנון נגד לחיצה מקרית, וזה כל מה שהוא היה תמיד.
  // ⚠️ נקרא מ-sessionStorage ולא מאותחל ל-false: הערך חייב לשרוד פתיחה
  // וסגירה של הפאנל, וזה בדיוק מה שהיה שבור.
  const [directLocked, setDirectLockedState] = useState(() => isDirectLocked());

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

  // ⚠️ הנעילה של הזרוע הישירה **נכתבת ל-sessionStorage**, ולא ל-state בלבד.
  // זה כל התיקון: `onClose()` מפרק את AdminPanel מיד אחרי הלחיצה, ו-state
  // מת יחד איתו — ולכן הכפתור לא עשה כלום.
  const lockDirect = useCallback(() => {
    setDirectLocked(true);
    setDirectLockedState(true);
  }, []);

  // ============================================================
  // ⚠️ פתיחה מחדש בזרוע הישירה — בסיסמה של החשבון
  // ============================================================
  // אין כאן קוד מנהל, וזה מכוון (ראה CLAUDE.md): ערך ברירת המחדל שלו נמצא
  // בקוד הפתוח. הסיסמה קשורה ל**אדם**, ולכן היא מה שמוכיח שמי שחזר לעמדה
  // הוא מי שנעל אותה.
  const unlockByPassword = useCallback(async (password) => {
    setChecking(true);
    setError(null);
    try {
      const ok = await reauthenticate(password);
      if (!ok) { setError("סיסמה שגויה"); return false; }
      setDirectLocked(false);
      setDirectLockedState(false);
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
      // ============================================================
      // ⚠️ הנעילה חייבת לשרוד את פירוק הרכיב
      // ============================================================
      // כאן היה `!dismissed` — useState רגיל — ולכן **"נעל" לא עשה כלום**:
      // הוא סימן, ומיד אחריו `onClose()` פירק את AdminPanel
      // (`{adminOpen && <AdminPanel/>}` ב-App.jsx), וה-state מת יחד איתו.
      // הפתיחה הבאה בנתה רכיב חדש עם dismissed=false — כלומר פתוח.
      //
      // `directLocked` נשען על sessionStorage, ולכן הוא שורד פתיחה וסגירה.
      // ⚠️ **ולא localStorage**: סגירת הלשונית נועלת מחדש — אותה החלטה
      // שכבר תועדה בזרוע השנייה.
      //
      // ⚠️ ומפתח **נפרד** מזה של הזרוע ההיא: שם המשמעות היא "נפתח" (ברירת
      // מחדל נעול), וכאן "ננעל" (ברירת מחדל פתוח למנהל). שימוש חוזר באותו
      // מפתח היה נועל את המסך לכל מנהל בכל כניסה.
      //
      // ⚠️ ברירת המחדל נשמרה: מי שלא נעל מעולם נכנס בלי סיסמה, כמו היום.
      // הסיסמה נדרשת **רק** אחרי נעילה מפורשת.
      unlocked: isManager && !directLocked,
      unlock: unlockByPassword,
      lock: lockDirect,
      checking: checking || loading,
      error,
      // ============================================================
      // ⚠️ roleGated רק כשבאמת אין תפקיד — וזה היה הבאג השני
      // ============================================================
      // כאן היה `true` קבוע, ולכן מנהל שנעל היה מקבל את מסך התפקיד:
      // "התפקיד שלך: מנהל · לשינוי התפקיד יש לפנות למנהל אחר" — משפט חסר
      // פשר במצב הזה, **ובלי שום דרך לפתוח בחזרה**. דלת שננעלה בלי מפתח.
      //
      // מנהל שנעל אינו חסום בגלל תפקידו אלא משום שביקש; הוא מגיע לטופס
      // הסיסמה. בקר, שאין לו הרשאה בשום מצב, נשאר עם מסך התפקיד — שהוא
      // התשובה הנכונה עבורו.
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
