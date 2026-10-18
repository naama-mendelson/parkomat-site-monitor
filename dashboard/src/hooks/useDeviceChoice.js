// hooks/useDeviceChoice.js — בחירה בכותרת שנזכרת מהפעם הקודמת, לכל מכשיר ולכל משתמש (18/10/2026).
//
// משותף ל"מכפילים", "משימות" ו"קריאות פתוחות" (useComplianceView נשאר נפרד — המבנה שלו שונה). שלושה עותקים של אותו
// הוק היו נפרדים בשקט בתיקון הבא. הכללים:
//   - localStorage במפתח `parkomat.<name>:<user id>` — מסך משותף במשרד: לכל אחד הבחירה שלו;
//   - נכתב **רק בבחירה**, לא ב-effect: effect היה שומר את ברירת המחדל בעיבוד הראשון, לפני שהבחירה השמורה נקראה, ומוחק אותה;
//   - מה שנקרא עובר sanitize: ערך שבור או ישן לא יכול להשאיר את הלוח ריק בלי הסבר;
//   - localStorage שזורק (גלישה פרטית) — פשוט לא נזכר.
import { useCallback, useEffect, useRef, useState } from "react";

export function useDeviceChoice(name, userId, fallback, sanitize) {
  const keyFor = (uid) => `parkomat.${name}:${uid}`;
  const read = (uid) => {
    try {
      const raw = localStorage.getItem(keyFor(uid));
      return raw == null ? fallback : sanitize(JSON.parse(raw));
    } catch {
      return fallback;
    }
  };
  const [value, setValue] = useState(fallback);
  const owner = useRef(null);

  useEffect(() => {
    owner.current = userId ?? null;
    setValue(userId ? read(userId) : fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- name/fallback/sanitize קבועים לכל קורא
  }, [userId]);

  const update = useCallback((next) => {
    const v = sanitize(next);
    setValue(v);
    if (owner.current) {
      try { localStorage.setItem(keyFor(owner.current), JSON.stringify(v)); } catch { /* אין לאן לשמור */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [value, update];
}
