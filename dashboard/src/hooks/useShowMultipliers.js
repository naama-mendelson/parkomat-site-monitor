// hooks/useShowMultipliers.js — המתג "מכפילים מוצגים / מוסתרים" שבכותרת, נזכר מהפעם הקודמת (18/10/2026).
//
// בעלת המוצר: "כפתור סינון נוסף האם המכפילים מופיעים או לא מופיעים". אותו דפוס כמו useComplianceView: localStorage,
// לכל מכשיר, במפתח שכולל את מזהה המשתמש (מסך משותף במשרד), נכתב רק בבחירה ולא ב-effect, ו-localStorage שזורק
// פשוט לא נזכר. ברירת המחדל — מוסתרים (בעלת המוצר: "הפוך בברירת מחדל הם מוסתרים"). ⚠️ זה מסנן תצוגה בלוח בלבד: טבלת מנהל הבקרה וההנהלה
// ממילא אינן מציגות אתרים בלי בקר (toSupervisorShape).
import { useCallback, useEffect, useRef, useState } from "react";
import { sanitizeShowMultipliers, DEFAULT_SHOW_MULTIPLIERS } from "../utils/multipliers";

const keyFor = (userId) => `parkomat.showMultipliers:${userId}`;

function read(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    return raw == null ? DEFAULT_SHOW_MULTIPLIERS : sanitizeShowMultipliers(JSON.parse(raw));
  } catch {
    return DEFAULT_SHOW_MULTIPLIERS;
  }
}

function write(userId, shown) {
  try { localStorage.setItem(keyFor(userId), JSON.stringify(shown === true)); } catch { /* אין לאן לשמור */ }
}

export function useShowMultipliers(userId) {
  const [shown, setShown] = useState(DEFAULT_SHOW_MULTIPLIERS);
  const owner = useRef(null);

  useEffect(() => {
    owner.current = userId ?? null;
    setShown(userId ? read(userId) : DEFAULT_SHOW_MULTIPLIERS);
  }, [userId]);

  const update = useCallback((next) => {
    const v = next === true;
    setShown(v);
    if (owner.current) write(owner.current, v);
  }, []);

  return [shown, update];
}
