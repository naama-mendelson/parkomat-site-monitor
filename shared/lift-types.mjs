// shared/lift-types.mjs — סוג המעלית באתר, והקונזול (11/10/2026).
//
// בעלת המוצר: "כשמוסיפים אתר צריך 'סוג מעלית' שיהיה SELECT … 1, 2, 6 — אם בוחרים באופציות
// האלו תיפתח השאלה קונזול אורכי או קונזול רוחבי". והחלטות שלה באותו יום:
//   • **חובה** ברישום אתר — סוג מעלית, ובסוגים שיש להם קונזול גם הקונזול.
//     ⚠️ **בוטל ב-12/10/2026 בערב:** "תעשה שלא יהיה חייבים לבחור מה סוג המעלית". הסוג רשות — ברישום
//     ובעריכה, ואפשר גם לחזור ל"לא הוגדר". הקונזול נשאר חובה כשנבחר סוג שפותח אותו.
//   • **גם בעריכת אתר קיים**, כדי להשלים את האתרים שכבר רשומים (אצלם עד אז NULL).
//
// ⚠️ שדה נפרד מ"סוג המתקן" (plc_type — XY/דולי/מצבט, shared/site-types.mjs) ומ"מערכת"
// (control_system): המעלית היא רכיב אחר, ושלושתם צירים שונים.
//
// ⚠️ **המסד אוכף את אותה רשימה** — app.check_lift_type / app.check_lift_console
// (writes.postgres.sql) ושני ה-CHECK, sites_lift_shape ו-sites_lift2_shape (schema.postgres.sql).
// הבדיקה tests/lift-types.test.js משווה בין כולם, כך ששינוי באחד בלי האחרים נכשל.
//
// המפתח באנגלית (כמו site-types): הוא נשמר ומושווה. התווית עברית — והיא היחידה שמותר
// לשנות בלי לגעת בנתונים.
//
// ⚠️ **עד שתי מעליות לאתר** (12/10/2026: "אני רוצה שתהיה אופציה להוסיף עוד מעלית. יש אתרים שיש
// בהם שתי מעליות", ובחרה "עד שתיים"). השנייה — sites.lift2_type / lift2_console, לא חובה, ורק
// כשיש ראשונה. ובאותה הודעה סוג חדש: "מספריים הידראולית", בלי קונזול (בחרה "בלי קונזול").

export const LIFT_TYPES = [
  { key: "hydraulic-piston-1", label: "הידראולית בוכנה 1", console: true },
  { key: "hydraulic-piston-2", label: "הידראולית בוכנה 2", console: true },
  { key: "four-post-18kw", label: "4 עמודים 18 KW", console: false },
  { key: "four-post-11kw", label: "4 עמודים 11 KW", console: false },
  { key: "serapid", label: "סרפיד", console: false },
  { key: "electric", label: "חשמלי", console: true },
  // 12/10/2026. היא כתבה "הידרואלית" — כמו ב"הידראולית בוכנה", הכתיב התקין
  { key: "hydraulic-scissors", label: "מספריים הידראולית", console: false },
];

/** כמה מעליות אפשר לרשום לאתר (12/10/2026: "עד שתיים"). */
export const MAX_LIFTS = 2;

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
 * @param {{ required?: boolean }} opts — ברירת המחדל "חובה", אבל מאז 12/10/2026 בערב שני הטפסים מעבירים
 *   required: false — הסוג רשות. נשאר פרמטר כדי שהחלטה הפוכה תהיה שינוי של מילה.
 */
export function liftProblem(type, console, { required = true } = {}) {
  if (!type) return required ? "יש לבחור סוג מעלית" : null;
  if (!LIFT_TYPE_KEYS.includes(type)) return "סוג מעלית לא תקין";
  if (liftNeedsConsole(type) && !LIFT_CONSOLE_KEYS.includes(console)) return "יש לבחור קונזול אורכי או קונזול רוחבי";
  return null;
}

/**
 * המעליות של אתר, מהעמודות: `[{ type, console }]` — אחת, שתיים, או אף אחת (אתר מלפני 11/10).
 * ⚠️ שנייה בלי ראשונה אינה אפשרית במסד (CHECK sites_lift2_shape), ולכן הסדר כאן הוא הסדר שם.
 */
export function siteLifts(site) {
  const out = [];
  if (site?.lift_type) out.push({ type: site.lift_type, console: site.lift_console ?? null });
  if (site?.lift2_type) out.push({ type: site.lift2_type, console: site.lift2_console ?? null });
  return out;
}

/** "סרפיד" / "הידראולית בוכנה 1 · קונזול אורכי + סרפיד" / "לא הוגדר" — לתגית בכרטיס ולשורת הניהול. */
export function liftsLabel(lifts) {
  const list = (lifts ?? []).filter((l) => l?.type);
  if (!list.length) return "לא הוגדר";
  return list.map((l) => liftLabel(l.type, l.console)).join(" + ");
}

/**
 * מה חסר בטופס של עד שתי מעליות — אותם כללים כמו השרת. null = תקין.
 * הראשונה — כמו liftProblem (`required` חל עליה בלבד); השנייה, אם נוספה, חייבת סוג (ומי שלא רוצה
 * אותה מסיר אותה), ואינה יכולה לבוא בלי ראשונה.
 * @param {{type?: string, console?: string}[]} lifts
 */
export function liftsProblem(lifts, { required = true } = {}) {
  const list = lifts ?? [];
  if (list.length > MAX_LIFTS) return `אפשר לרשום עד ${MAX_LIFTS} מעליות`;
  const [a, b] = list;
  const p1 = liftProblem(a?.type, a?.console, { required });
  if (p1) return list.length > 1 ? `מעלית 1: ${p1}` : p1;
  if (b) {
    if (!a?.type) return "יש לבחור קודם את המעלית הראשונה";
    if (!b.type) return "יש לבחור סוג למעלית השנייה, או להסיר אותה";
    const p2 = liftProblem(b.type, b.console);
    if (p2) return `מעלית 2: ${p2}`;
  }
  return null;
}
