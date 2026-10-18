// hooks/useTasksView.js — "משימות" בסינון שבכותרת, נזכר מהפעם הקודמת (18/10/2026).
//
// אותו דפוס כמו useShowMultipliers / useComplianceView: localStorage, לכל מכשיר, במפתח שכולל את מזהה המשתמש (מסך משותף
// במשרד), נכתב רק בבחירה ולא ב-effect (effect היה שומר את ברירת המחדל לפני שהבחירה השמורה נקראה, ומוחק אותה), ו-localStorage
// שזורק פשוט לא נזכר. ברירת המחדל — "בלי משימות" (בעלת המוצר: "מלכתחילה שלא יוצגו").
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_TASKS_VIEW, sanitizeTasksView } from "../utils/tasks";

const keyFor = (userId) => `parkomat.tasksView:${userId}`;

function read(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    return raw == null ? DEFAULT_TASKS_VIEW : sanitizeTasksView(JSON.parse(raw));
  } catch {
    return DEFAULT_TASKS_VIEW;
  }
}

function write(userId, view) {
  try { localStorage.setItem(keyFor(userId), JSON.stringify(view)); } catch { /* אין לאן לשמור */ }
}

export function useTasksView(userId) {
  const [view, setView] = useState(DEFAULT_TASKS_VIEW);
  const owner = useRef(null);

  useEffect(() => {
    owner.current = userId ?? null;
    setView(userId ? read(userId) : DEFAULT_TASKS_VIEW);
  }, [userId]);

  const update = useCallback((next) => {
    const v = sanitizeTasksView(next);
    setView(v);
    if (owner.current) write(owner.current, v);
  }, []);

  return [view, update];
}
