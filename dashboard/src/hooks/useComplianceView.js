// hooks/useComplianceView.js — הבחירה בבורר "בודק מוסמך" שבכותרת, נזכרת מהפעם הקודמת.
//
// בעלת המוצר (08/10/2026): "אני רוצה שבודק מוסמך יהיה לפי הבחירה האחרונה של הבן אדם מהפעם
// הקודמת" — ובחרה "בכל מכשיר בנפרד". לכן localStorage, ולא המסד.
//
// ⚠️ המפתח כולל את מזהה המשתמש: על מחשב משותף (מסך במשרד) שני אנשים לא יקבלו כל אחד את הבחירה
// של השני. ⚠️ ונכתב רק בבחירה — לא ב-effect: effect שכותב את המצב היה שומר את ברירת המחדל
// ("בלי") ברינדור הראשון, לפני שהבחירה השמורה נקראה, ומוחק אותה.
// ⚠️ localStorage עלול לזרוק (חלון פרטי, אחסון חסום) — אז פשוט לא נזכרים, והבורר עובד כרגיל.
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_COMPLIANCE_VIEW, sanitizeComplianceView } from "../utils/compliance";

const keyFor = (userId) => `parkomat.complianceView:${userId}`;

function read(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    return raw ? sanitizeComplianceView(JSON.parse(raw)) : DEFAULT_COMPLIANCE_VIEW;
  } catch {
    return DEFAULT_COMPLIANCE_VIEW;
  }
}

function write(userId, view) {
  try { localStorage.setItem(keyFor(userId), JSON.stringify(view)); } catch { /* אין לאן לשמור */ }
}

export function useComplianceView(userId) {
  const [view, setView] = useState(DEFAULT_COMPLIANCE_VIEW);
  const owner = useRef(null);

  // משתמש התחבר (או התחלף) → הבחירה שלו מהפעם הקודמת
  useEffect(() => {
    owner.current = userId ?? null;
    setView(userId ? read(userId) : DEFAULT_COMPLIANCE_VIEW);
  }, [userId]);

  const update = useCallback((next) => {
    setView(next);
    if (owner.current) write(owner.current, next);
  }, []);

  return [view, update];
}
