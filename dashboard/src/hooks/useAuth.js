// hooks/useAuth.js — מצב ההתחברות, מאחורי ה-seam של services/auth.js.
//
// מחזיר { user, loading }. loading הוא השלב שבו עדיין לא יודעים אם קיים
// session שמור — והוא נדרש: בלעדיו המסך היה מבליח את טופס ההתחברות בכל
// רענון, גם למי שמחובר, כי בדיקת ה-session היא אסינכרונית.
import { useEffect, useState } from "react";
import { currentUser, onAuthChange } from "../services/auth";

export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    // 1. session שמור מריצה קודמת (localStorage). זה מה שמונע התחברות
    //    מחדש בכל רענון — קריטי במסך קיר שאיש לא נוגע בו.
    currentUser().then((u) => {
      if (!alive) return;
      setUser(u);
      setLoading(false);
    });

    // 2. שינויים אחרי כן: חידוש אסימון, יציאה, ופקיעה. במסך שפתוח יומיים
    //    זה מה שמבדיל בין "המסך התרוקן בשקט" לבין חזרה לטופס התחברות.
    const stop = onAuthChange((u) => {
      if (alive) setUser(u);
    });

    return () => { alive = false; stop(); };
  }, []);

  return { user, loading };
}
