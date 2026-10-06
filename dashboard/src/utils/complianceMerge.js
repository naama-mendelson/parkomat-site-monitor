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
export const complianceFailed = (list) => list.length > 0 && list.every((s) => s.compliance?.unknown && s.compliance?.error);
export const complianceFetched = (list) => list.some((s) => s.compliance !== null && s.compliance !== undefined);
