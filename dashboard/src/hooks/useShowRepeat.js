// hooks/useShowRepeat.js — אריח "תקלות חוזרות" בכותרת, נזכר מהפעם הקודמת (19/10/2026; הכללים ב-utils/repeatFaults.js).
import { sanitizeShowRepeat, DEFAULT_SHOW_REPEAT } from "../utils/repeatFaults";
import { useDeviceChoice } from "./useDeviceChoice";

export const useShowRepeat = (userId) => useDeviceChoice("showRepeatFaults", userId, DEFAULT_SHOW_REPEAT, sanitizeShowRepeat);
