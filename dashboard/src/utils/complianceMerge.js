// utils/complianceMerge.js — מיזוג רמזורי הבודק/התחזוקה בין שליפות של רשימת האתרים.
//
// קובץ טהור (בלי React ובלי שירותים) — useSites משתמש בו, והבדיקות מריצות אותו ב-node.

// ============================================================
// ⚠️ רמזורי בודק/תחזוקה: מצב אחרון ידוע, ולא "?" על כל כשל רגעי
// ============================================================
// `site_compliance` היא קריאה לא-קטלנית בתוך שליפת הרשימה (sitesDirect). כשהיא
// נכשלת, כל אתר מגיע עם `{unknown:true, error}`. החלפה עיוורת הייתה הופכת כל
// הבהוב רשת לשורה של "?" על כל הכרטיסים — ולכן אתר שהיה לו מצב ידוע שומר
// אותו, עם `stale:true` (מסגרת מקווקוות במנורה). אתר שלא היה לו מצב מעולם
// מקבל "?" — לא יודעים, וזה מה שהמסך אומר (D19).
//
// ⚠️ לפי `id` ולא לפי `code`: קוד אתר ניתן לשינוי (update_site), ואתר ששונה לו
// הקוד היה מאבד את המצב הידוע ומציג "?" עד הסבב הבא.
//
// ⚠️ ושליפה מלאה **אינה דורסת** עדכון חדש ממנה: שורה שהוחלפה ב-patchSite
// (אחרי "בוצע", או אירוע) אחרי שהשליפה יצאה לדרך — חדשה ממה שהשליפה ראתה.
// בלי זה, שליפה איטית שהתחילה רגע לפני הכתיבה הייתה מחזירה ליקוי שנסגר
// כ"פתוח" לחמש דקות (עד הסבב הבא של הרמזורים).
//
// מחזיר גם `missing`: אתר שאין לו מצב קודם בסבב שלא נשלפו בו רמזורים (אתר
// חדש) — סימן לשלוף אותם כבר בסבב הבא.
export function mergeCompliance(prev, next, startedAt = 0, patchedAt = {}) {
  const before = new Map(prev.map((s) => [s.id, s.compliance]));
  let missing = false;
  const list = next.map((s) => {
    const c = s.compliance;
    const last = before.get(s.id);
    // עדכון ממוקד שנעשה אחרי שהשליפה הזו יצאה — הוא החדש
    if (c !== undefined && last && !last.unknown && (patchedAt[s.id] ?? 0) > startedAt) {
      return { ...s, compliance: last };
    }
    // null = לא נשלף בסבב הזה (ראה COMPLIANCE_EVERY_MS) — ממשיכים עם מה שהיה
    if (c === null) {
      if (last === undefined) missing = true;
      return { ...s, compliance: last ?? { unknown: true } };
    }
    if (!c || !c.unknown || !c.error) return s;
    if (!last || last.unknown) return s;
    return { ...s, compliance: { ...last, stale: true, error: c.error } };
  });
  return { list, missing };
}
// ============================================================
// ⚠️ רענון הנורות בלי טעינה חיה (19/10/2026)
// ============================================================
// עד אז הנורות נטענו עם הטעינה החיה של כל 5 דקות, שבוטלה (בעלת המוצר: "למה הוא מריץ את המצב החי? אני לא
// רוצה!"). שינוי שמישהו עושה מגיע באירוע (compliance) ומרענן נורה אחת. מה שאירוע לא מביא:
//   • **החלפת התאריך** — הנורה צבועה לפי היום (30 יום לפני פקיעה, מועד תיקון שעבר); מסך קיר פתוח ימים היה
//     נשאר בצבעים של אתמול. ⚠️ לפי היום בישראל, כמו app.compliance_today — לא חצות UTC.
//   • **התאוששות מכשל** — נורה מקווקוות ("לא התעדכן") מנסה שוב כעבור 5 דקות, לא נשארת כך עד רענון.
// הבדיקה של כל דקה (App) שואלת כאן; התשובה "כן" מריצה site_compliance בלבד, לא את הטעינה החיה.
export const COMPLIANCE_RETRY_MS = 5 * 60_000;
const IL_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" });
export const israelDay = (t) => IL_DAY.format(new Date(t));
/**
 * @param {number} lastOkAt   מתי נטענו הנורות בהצלחה לאחרונה (0 — עוד לא)
 * @param {number} lastFailAt מתי נכשלה טעינתן לאחרונה (0 — לא נכשלה)
 */
export function complianceRefreshDue(lastOkAt, lastFailAt, now = Date.now()) {
  if (lastFailAt > lastOkAt) return now - lastFailAt >= COMPLIANCE_RETRY_MS;
  if (!lastOkAt) return false;
  return israelDay(lastOkAt) !== israelDay(now);
}

export const complianceFailed = (list) => list.length > 0 && list.every((s) => s.compliance?.unknown && s.compliance?.error);
export const complianceFetched = (list) => list.some((s) => s.compliance !== null && s.compliance !== undefined);
