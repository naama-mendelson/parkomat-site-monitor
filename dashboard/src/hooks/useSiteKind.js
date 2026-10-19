// hooks/useSiteKind.js — "רובוטיים" / "מכפילים" בכותרת, נזכר מהפעם הקודמת (19/10/2026; הכללים ב-utils/multipliers.js).
// ⚠️ מפתח חדש (siteKind) ולא showMultipliers של המתג הישן: שם true פירושו "המכפילים לצד הרובוטיים", וקריאה שלו כאן הייתה
// פותחת את מי שבחר אז במסך של מכפילים בלבד. ⚠️ מסנן תצוגה בלוח בלבד: מנהל הבקרה וההנהלה ממילא בלי אתרים ללא בקר.
import { sanitizeSiteKind, DEFAULT_SITE_KIND } from "../utils/multipliers";
import { useDeviceChoice } from "./useDeviceChoice";

export const useSiteKind = (userId) => useDeviceChoice("siteKind", userId, DEFAULT_SITE_KIND, sanitizeSiteKind);
