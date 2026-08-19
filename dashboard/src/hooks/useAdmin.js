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
import { isUnlocked as getAdminCode, markUnlocked as storeAdminCode, lockAgain } from "../services/adminCodeDirect";
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
  const [dismissed, setDismissed] = useState(false);

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
    setDismissed(true);
  }, []);

  if (useDirect) {
    return {
      unlocked: isManager && !dismissed,
      // ⚠️ מחזיר false ולא זורק: המסך אינו אמור להציע להקליד קוד כאן
      // בכלל (`roleGated` אומר לו את זה), וקריאה שכן תגיע חייבת להסביר
      // למה היא לא עוזרת — ולא להיכשל בשקט.
      unlock: async () => {
        setError("הפעולה מותרת למנהלים בלבד. קוד המנהל אינו רלוונטי יותר — הרשאות נקבעות לפי המשתמש.");
        return false;
      },
      lock: () => setDismissed(true),
      // בזמן טעינת הזהות עדיין לא ידוע אם מנהל. `checking` הוא מה שהמסך
      // מציג כ"בודק…", ובלעדיו הוא היה מהבהב "אין הרשאה" לכל מנהל.
      checking: loading,
      error,
      roleGated: true,
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
