// utils/siteInactive.js — "לא פעיל" (22/10/2026): אתר שלא פעיל כרגע יורד לסוף הלוח, תחת הכותרת "לא פעיל".
// פונקציות טהורות; נבדקות ב-master/tests/site-inactive-ui.test.js.
//
// בקשה מהשטח שהבעלת העבירה: "אתרים שלא פעילים ומופיעים כ'תקלה' או 'תחזוקה' — להוריד לתחתית הרשימה תחת הכותרת 'לא פעיל'".
// ⚠️ בחירת הבעלת: **רק המיקום בלוח.** המצב, האריחים בכותרת, הצלצול בתקלה והסטטיסטיקה — כרגיל. המסד מחליט מי מסמן
// (public.site_inactive_set: עורך או מנהל); כאן רק הקריאה.

/** האם האתר מסומן "לא פעיל". */
export const isInactive = (site) => Boolean(site?.inactive_at);

/** מחלק רשימה ממוינת לשתיים, בלי לשנות את הסדר בתוך כל חלק: הפעילים, ואחריהם "לא פעיל". */
export function splitInactive(sites) {
  const active = [];
  const inactive = [];
  for (const s of sites || []) (isInactive(s) ? inactive : active).push(s);
  return { active, inactive };
}

const IL_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit" });

/** "מ-22/10" — היום בישראל שבו סומן. בלי תאריך תקין — "". */
export function inactiveSince(site) {
  const t = Date.parse(site?.inactive_at ?? "");
  return Number.isFinite(t) ? `מ-${IL_DAY.format(new Date(t))}` : "";
}

/** שורת ההסבר בכרטיס: "לא פעיל מ-22/10 ע״י דנה · בשיפוץ". השם — המאומת, בלי הדומיין. */
export function inactiveLine(site) {
  if (!isInactive(site)) return "";
  const by = String(site.inactive_by ?? "").replace(/@parkomat\.co\.il$/i, "").trim();
  const parts = [["לא פעיל", inactiveSince(site), by ? `ע״י ${by}` : ""].filter(Boolean).join(" ")];
  if (site.inactive_reason) parts.push(String(site.inactive_reason));
  return parts.join(" · ");
}
