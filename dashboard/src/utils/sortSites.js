// utils/sortSites.js — סדר הצגת אתרים לפי דחיפות (משותף לתצוגת הכרטיסים ולטבלה).
//
// ==========================================================
// מה שדורש תשומת לב צף למעלה, בשלוש רמות:
//   1. מצב:  תקלה → תחזוקה → אין תקשורת → יציאה → כניסה → מוכן
//            ("בפעולה" מתפצל ליציאה/כניסה לפי כיוון הפעולה הנוכחית).
//   2. דרגה: VIP → מורחב → בסיסי  (הכי חשוב קודם, בתוך אותו מצב).
//   3. אחוז כשל: גבוה → נמוך       (הכי בעייתי קודם, בתוך אותה דרגה).
//
// שני הצדדים (כרטיס/שורת-טבלה) חולקים את אותם שמות שדות — status, tier,
// lastOperation.entry_exit, failureRate — ולכן אותו קומפרטור משרת את שניהם.
// ==========================================================

function statusRank(site) {
  switch (site.status) {
    case "error":       return 0;
    case "maintenance": return 1;
    case "no_comm":     return 2;
    case "operating":   // יציאה לפני כניסה; פעולה בלי כיוון ידוע נחשבת כניסה
      return site.lastOperation?.entry_exit === "exit" ? 3 : 4;
    case "ready":       return 5;
    default:            return 6;
  }
}

const TIER_RANK = { vip: 0, extended: 1, basic: 2 };
const tierRank = (site) => TIER_RANK[site.tier] ?? TIER_RANK.basic;

export function compareSitesByPriority(a, b) {
  const byStatus = statusRank(a) - statusRank(b);
  if (byStatus !== 0) return byStatus;
  const byTier = tierRank(a) - tierRank(b);
  if (byTier !== 0) return byTier;
  return (b.failureRate ?? 0) - (a.failureRate ?? 0);   // אחוז כשל גבוה קודם
}
