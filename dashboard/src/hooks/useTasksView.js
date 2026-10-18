// hooks/useTasksView.js — "משימות" בסינון שבכותרת, נזכר מהפעם הקודמת (18/10/2026). ברירת המחדל — "בלי משימות"
// (בעלת המוצר: "מלכתחילה שלא יוצגו"). הכללים (מפתח לכל משתמש, נכתב רק בבחירה) — ב-useDeviceChoice.
import { DEFAULT_TASKS_VIEW, sanitizeTasksView } from "../utils/tasks";
import { useDeviceChoice } from "./useDeviceChoice";

export const useTasksView = (userId) => useDeviceChoice("tasksView", userId, DEFAULT_TASKS_VIEW, sanitizeTasksView);
