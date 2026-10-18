// hooks/useShowMultipliers.js — המתג "מכפילים מוצגים / מוסתרים" שבכותרת, נזכר מהפעם הקודמת (18/10/2026).
// בעלת המוצר: "כפתור סינון נוסף האם המכפילים מופיעים או לא מופיעים"; ברירת המחדל — מוסתרים ("הפוך בברירת מחדל הם
// מוסתרים"). ⚠️ מסנן תצוגה בלוח בלבד: טבלת מנהל הבקרה וההנהלה ממילא אינן מציגות אתרים בלי בקר (toSupervisorShape).
// הכללים (מפתח לכל משתמש, נכתב רק בבחירה) — ב-useDeviceChoice.
import { sanitizeShowMultipliers, DEFAULT_SHOW_MULTIPLIERS } from "../utils/multipliers";
import { useDeviceChoice } from "./useDeviceChoice";

export const useShowMultipliers = (userId) =>
  useDeviceChoice("showMultipliers", userId, DEFAULT_SHOW_MULTIPLIERS, sanitizeShowMultipliers);
