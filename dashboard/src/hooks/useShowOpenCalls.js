// hooks/useShowOpenCalls.js — "קריאות פתוחות" בכותרת, נזכר מהפעם הקודמת (18/10/2026). ברירת המחדל — לא לחוץ (בעלת
// המוצר: "כשלא לחוץ לא רואים כברירת מחדל"). הכללים (מפתח לכל משתמש, נכתב רק בבחירה) — ב-useDeviceChoice.
import { DEFAULT_SHOW_OPEN_CALLS, sanitizeShowOpenCalls } from "../utils/serviceCalls";
import { useDeviceChoice } from "./useDeviceChoice";

export const useShowOpenCalls = (userId) =>
  useDeviceChoice("showOpenCalls", userId, DEFAULT_SHOW_OPEN_CALLS, sanitizeShowOpenCalls);
