// shared/lift-types.mjs — סוג המעלית באתר, והקונזול (11/10/2026).
//
// בעלת המוצר: "כשמוסיפים אתר צריך 'סוג מעלית' שיהיה SELECT … 1, 2, 6 — אם בוחרים באופציות
// האלו תיפתח השאלה קונזול אורכי או קונזול רוחבי". והחלטות שלה באותו יום:
//   • **חובה** ברישום אתר — סוג מעלית, ובסוגים שיש להם קונזול גם הקונזול.
//   • **גם בעריכת אתר קיים**, כדי להשלים את האתרים שכבר רשומים (אצלם עד אז NULL).
//
// ⚠️ שדה נפרד מ"סוג המתקן" (plc_type — XY/דולי/מצבט, shared/site-types.mjs) ומ"מערכת"
// (control_system): המעלית היא רכיב אחר, ושלושתם צירים שונים.
//
// ⚠️ **המסד אוכף את אותה רשימה** — app.check_lift_type / app.check_lift_console
// (writes.postgres.sql) וה-CHECK sites_lift_shape (schema.postgres.sql). הבדיקה
// tests/lift-types.test.js משווה בין שלושתם, כך ששינוי באחד בלי האחרים נכשל.
//
// המפתח באנגלית (כמו site-types): הוא נשמר ומושווה. התווית עברית — והיא היחידה שמותר
// לשנות בלי לגעת בנתונים.

export const LIFT_TYPES = [
  { key: "hydraulic-piston-1", label: "הידראולית בוכנה 1", console: true },
  { key: "hydraulic-piston-2", label: "הידראולית בוכנה 2", console: true },
  { key: "four-post-18kw", label: "4 עמודים 18 KW", console: false },
  { key: "four-post-11kw", label: "4 עמודים 11 KW", console: false },
  { key: "serapid", label: "סרפיד", console: false },
  { key: "electric", label: "חשמלי", console: true },
];

export const LIFT_CONSOLES = [
  { key: "longitudinal", label: "קונזול אורכי" },
  { key: "transverse", label: "קונזול רוחבי" },
];

export const LIFT_TYPE_KEYS = LIFT_TYPES.map((t) => t.key);
export const LIFT_CONSOLE_KEYS = LIFT_CONSOLES.map((c) => c.key);

/** האם הסוג הזה פותח את שאלת הקונזול (1, 2, 6). */
export function liftNeedsConsole(type) {
  return LIFT_TYPES.some((t) => t.key === type && t.console);
}

/** "הידראולית בוכנה 1 · קונזול אורכי" / "סרפיד" / "לא הוגדר" — לשורת הפרטים של האתר. */
export function liftLabel(type, console) {
  const t = LIFT_TYPES.find((x) => x.key === type);
  if (!t) return type ? String(type) : "לא הוגדר";
  const c = t.console ? LIFT_CONSOLES.find((x) => x.key === console) : null;
  return c ? `${t.label} · ${c.label}` : t.label;
}

/**
 * מה חסר כדי לשמור — אותו כלל כמו השרת. null = תקין.
 * @param {{ required?: boolean }} opts — ברישום חובה; בעריכה של אתר שעוד אין לו סוג — אפשר להשאיר ריק.
 */
export function liftProblem(type, console, { required = true } = {}) {
  if (!type) return required ? "יש לבחור סוג מעלית" : null;
  if (!LIFT_TYPE_KEYS.includes(type)) return "סוג מעלית לא תקין";
  if (liftNeedsConsole(type) && !LIFT_CONSOLE_KEYS.includes(console)) return "יש לבחור קונזול אורכי או קונזול רוחבי";
  return null;
}
