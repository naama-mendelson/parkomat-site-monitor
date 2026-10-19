// hooks/useAuth.js — מצב ההתחברות, מאחורי ה-seam של services/auth.js.
//
// מחזיר { user, loading }. loading הוא השלב שבו עדיין לא יודעים אם קיים
// session שמור — והוא נדרש: בלעדיו המסך היה מבליח את טופס ההתחברות בכל
// רענון, גם למי שמחובר, כי בדיקת ה-session היא אסינכרונית.
//
// ⚠️ 19/10/2026 (הסקירה של שלושת התפקידים): רכיב שנטען אחרי שהמשתמש כבר ידוע מתחיל ממנו, ולא מ-null. עד אז כל
// חלון שנפתח (משימות, קריאות) התחיל בלי משתמש — כלומר "בקר" — ורק אחרי סיבוב רשת עבר לתפקיד האמיתי: עורך ראה לרגע
// "בקר יכול רק לצפות", ו-useCallback עם [] בחלון הקריאות נתקע על הערך הראשון. lastUser משותף לכל המופעים
// (undefined = עוד לא ידוע; null = לא מחובר).
import { useEffect, useState } from "react";
import { currentUser, onAuthChange } from "../services/auth";

let lastUser;

export function useAuth() {
  const [user, setUser] = useState(lastUser ?? null);
  const [loading, setLoading] = useState(lastUser === undefined);

  useEffect(() => {
    let alive = true;
    const put = (u) => { lastUser = u; if (alive) setUser(u); };

    // 1. session שמור מריצה קודמת (localStorage). זה מה שמונע התחברות
    //    מחדש בכל רענון — קריטי במסך קיר שאיש לא נוגע בו.
    // ⚠️ רכיב שכבר נסגר אינו כותב ל-lastUser (הסקירה של 19/10): בדיקה שהתחילה לפני יציאה וחזרה אחריה הייתה מחזירה
    // את המשתמש שיצא, והרכיב הבא שעולה היה מתחיל ממנו.
    currentUser().then((u) => {
      if (!alive) return;
      put(u);
      setLoading(false);
    });

    // 2. שינויים אחרי כן: חידוש אסימון, יציאה, ופקיעה. במסך שפתוח יומיים
    //    זה מה שמבדיל בין "המסך התרוקן בשקט" לבין חזרה לטופס התחברות.
    const stop = onAuthChange(put);

    return () => { alive = false; stop(); };
  }, []);

  return { user, loading };
}
