// utils/repeatFaults.js — אריח "תקלות חוזרות" בכותרת (19/10/2026).
//
// בעלת המוצר: "אני רוצה סינון של כאלו שהתקלות שיש להם את הסימון הזה של תקלות חוזרות" — הסימון ↻ N שבכרטיס (אותו טקסט
// תקלה יותר מ-3 פעמים ב-30 יום, בלי דלתות פתוחות וחירום; נקבע במסד, site_card_metrics.repeat_faults). כמו "קריאות
// פתוחות": מתג; לחוץ — רק אתרים שיש להם הסימון; לא לחוץ (ברירת המחדל) — הכול. נזכר לכל מכשיר (hooks/useShowRepeat.js).
// קובץ טהור — הבדיקות מריצות אותו ב-node.

/** האם לאתר יש הסימון — אותו תנאי כמו התג בכרטיס (SiteCard: מערך לא ריק) */
export const hasRepeatFaults = (site) => Array.isArray(site?.repeatFaults) && site.repeatFaults.length > 0;
export const DEFAULT_SHOW_REPEAT = false;
/** מה שנקרא מהאחסון: רק true מסנן */
export const sanitizeShowRepeat = (raw) => raw === true || raw === "true";
/** לא לחוץ — הכול עובר; לחוץ — רק עם הסימון */
export const matchesRepeatView = (site, shown) => shown !== true || hasRepeatFaults(site);
/** המספר הגדול על האריח — כמה אתרים בלוח יש להם הסימון */
export const countRepeatSites = (sites) => (sites ?? []).filter(hasRepeatFaults).length;

/** המספר שעל הסימון ↻ — הפעמים של התקלה החוזרת הגבוהה באתר; 0 בלי סימון. ⚠️ מקסימום ולא [0]: לא סומכים על הסדר שהגיע. */
export const repeatTop = (site) => (hasRepeatFaults(site) ? Math.max(0, ...site.repeatFaults.map((r) => Number(r?.n) || 0)) : 0);

/**
 * "תקלות חוזרות" לחוץ — הגבוה ביותר קודם (בעלת המוצר, 19/10/2026: "תקלות חוזרות — מיין לפי המתקן עם המספר תקלות חוזרות
 * הגבוה ביותר"). תיקו — הסדר הרגיל של הלוח (then), כך ששני אתרים עם ↻ 6 נשארים בסדר שהיו בו.
 */
export const compareByRepeat = (then) => (a, b) => (repeatTop(b) - repeatTop(a)) || then(a, b);
