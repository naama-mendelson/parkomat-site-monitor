// components/Tasks/TasksContext.js — מספרי המשימות הפתוחות לכל אתר, ופתיחת הטבלה של אתר.
// ⚠️ null = אין משימות במצב הזה (מצב שרת, או שהמספרים עוד לא נטענו) — הכפתור בכרטיס
// לא מצויר. קונטקסט ולא prop: הכרטיס יושב כמה רמות מתחת ל-App, ולא כל רמה צריכה לדעת.
import { createContext, useContext } from "react";

export const TasksContext = createContext(null);
export const useTasks = () => useContext(TasksContext);
