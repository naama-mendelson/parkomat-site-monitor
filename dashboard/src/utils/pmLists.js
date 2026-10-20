// utils/pmLists.js — רשימות תחזוקה לפי סוג האתר: קטגוריות, מפתחות סוג, קיבוץ והסבר המקור (15/10/2026).
//
// בעלת המוצר: "אני רוצה שתסווג לפי מה שמסומן הסוג של האתר… תסדר את זה לפי סוגים — XY, X או Y, מעלית כזו, מעלית
// כזו — ואפשר יהיה לעשות בחירה מרובה. אבל מלכתחילה תשים לכל אתר את מה שמתאים לו, ואפשר יהיה להוסיף ולשנות".
//
// ⚠️ ההחלטה מי מקבל מה היא ב-SQL (app.pm_auto_template_ids / app.pm_site_template_ids). כאן רק סידור לתצוגה:
// הקטגוריות והמפתחות הם אותם ערכים ש-pm_template_meta_set מקבל, והתוויות באות מ-shared/*.mjs — מקום אחד לכל רשימה.
import { LIFT_TYPES, LIFT_CONSOLES } from "../../../shared/lift-types.mjs";
import { SITE_TYPE_GROUPS } from "../../../shared/site-types.mjs";
import { CONTROL_SYSTEMS } from "../../../shared/control-systems.mjs";

/** הקטגוריות של רשימה, בסדר שבו הן מוצגות. המפתחות — כמו pm_templates.category. */
export const PM_CATEGORIES = [
  { key: "base", label: "בסיס" },
  { key: "lift", label: "מעליות" },
  { key: "floor", label: "רצפה ומרתף" },
  { key: "other", label: "אחר" },
];
const CAT_INDEX = Object.fromEntries(PM_CATEGORIES.map((c, i) => [c.key, i]));
export const categoryLabel = (key) => PM_CATEGORIES.find((c) => c.key === key)?.label ?? PM_CATEGORIES[3].label;

/** הקטגוריה של רשימה לתצוגה: ברירת המחדל היא תמיד הבסיס; רשימה ישנה בלי קטגוריה — "אחר" */
export function templateCategory(t) {
  if (t?.is_default) return "base";
  return CAT_INDEX[t?.category] != null ? t.category : "other";
}

/** הרשימות מקובצות לפי קטגוריה, בסדר הקטגוריות ואז לפי seq — קבוצות ריקות מושמטות */
export function groupTemplates(templates) {
  const by = new Map();
  for (const t of templates ?? []) {
    const k = templateCategory(t);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  return PM_CATEGORIES.filter((c) => by.has(c.key))
    .map((c) => ({ ...c, templates: by.get(c.key).slice().sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || (a.seq ?? 0) - (b.seq ?? 0) || a.id - b.id) }));
}

/**
 * כל מפתחות הסוג שאפשר לסווג אליהם: lift:<סוג מעלית>, floor:<סוג מתקן>, ומ-19/10/2026 גם system:<מערכת הפעלה> ו-
 * console:<קונזול> (בעלת המוצר, על התג "XY · ביטנקם · הידראולית בוכנה 1 · קונזול אורכי": "צריך בתחזוקה לראות שיש מענה
 * גם ל…"). ⚠️ אותן צורות ש-pm_template_meta_set מקבל; system: הוא השם העברי עצמו, כמו sites.control_system.
 */
export function typeKeyOptions() {
  const lifts = LIFT_TYPES.map((t) => ({ value: `lift:${t.key}`, label: t.label, group: "lift", groupLabel: "מעלית" }));
  const floors = SITE_TYPE_GROUPS.flatMap((g) => g.types.map((t) => ({ value: `floor:${t.key}`, label: t.label, group: "floor", groupLabel: "מתקן" })));
  const systems = CONTROL_SYSTEMS.map((s) => ({ value: `system:${s.key}`, label: s.label, group: "system", groupLabel: "מערכת" }));
  // התווית של קונזול כבר אומרת "קונזול אורכי" — בלי קידומת, אחרת "קונזול: קונזול אורכי"
  const consoles = LIFT_CONSOLES.map((c) => ({ value: `console:${c.key}`, label: c.label, group: "console", groupLabel: null }));
  return [...lifts, ...floors, ...systems, ...consoles];
}
const KEY_LABELS = Object.fromEntries(typeKeyOptions().map((o) => [o.value, o]));
/** "מעלית: הידראולית בוכנה 1" / "מתקן: דולי" / "מערכת: ביטנקם" / "קונזול אורכי"; מפתח לא מוכר — כמו שהוא */
export function typeKeyLabel(key) {
  const o = KEY_LABELS[key];
  if (!o) return String(key ?? "");
  return o.groupLabel ? `${o.groupLabel}: ${o.label}` : o.label;
}

/**
 * הכיסוי לפי סוג, שורה לכל מאפיין של האתר (pm_site.type_coverage, בסדר התג, בלי כפולים) — 19/10/2026.
 * state: "covered" — לפחות רשימה אחת מסווגת למאפיין והאתר מקבל אותה; "general" — אין רשימה נפרדת למאפיין, והוא מכוסה
 * ברשימות הכלליות (בעלת המוצר: "אין צורך בתחזוקה נפרדת"); "unassigned" — יש רשימה, אבל בחירה ידנית או פרופיל הוציאו
 * אותה מהאתר. ⚠️ ההחלטה מה מכסה מה היא במסד; כאן רק תרגום. מסד ישן בלי השדה — מערך ריק, ואין שורות.
 */
export function coverageRows(typeCoverage) {
  return (Array.isArray(typeCoverage) ? typeCoverage : []).map((c) => {
    const lists = Array.isArray(c?.lists) ? c.lists : [];
    const assigned = lists.filter((l) => l.assigned).map((l) => l.name);
    const unassigned = lists.filter((l) => !l.assigned).map((l) => l.name);
    const state = assigned.length ? "covered" : unassigned.length ? "unassigned" : "general";
    return { key: c.key, label: typeKeyLabel(c.key), assigned, unassigned, state };
  });
}

/**
 * כמה אתרים חולקים רשימה (pm_templates_list.site_count — האתרים שמקבלים אותה בפועל) — לכותרת שלה בעורך (19/10/2026).
 * הרשימות משותפות לכל האתרים מאותו סוג, ושינוי בהן חל על כולם; מי שעורך מאתר אחד צריך לדעת את זה לפני שהוא שומר.
 */
export function sharedLabel(t) {
  const n = Number(t?.site_count);
  if (!Number.isFinite(n) || n < 0 || t?.site_count == null) return "";
  if (n <= 1) return "רק באתר הזה";
  return `משותפת ל-${n} אתרים — שינוי כאן חל על כולם`;
}

/** מאיפה הרשימות של האתר (pm_site.templates_source) — במילים */
export function sourceLabel(source) {
  switch (source) {
    case "explicit": return "נבחרו ידנית";
    case "auto": return "אוטומטי לפי סוג האתר";
    case "profile": return "מפרופיל התחזוקה";
    default: return "ברירת המחדל";
  }
}

/**
 * מה לסמן כשפותחים את הבחירה: הרשימות שהאתר מקבל עכשיו. ⚠️ לא רק האוטומטי — מי שפותח "שינוי" רוצה להוסיף או
 * להוריד ממה שיש, לא להתחיל מאפס.
 */
export function initialSelection(templates) { return new Set((templates ?? []).map((t) => t.id)); }

/** הבסיס (ברירת המחדל) נבחר תמיד — בלי בסיס אין לובי וחשמל, ואף ביקור לא יהיה שלם */
export function lockedIds(allTemplates) { return new Set((allTemplates ?? []).filter((t) => t.is_default).map((t) => t.id)); }
