// utils/serviceMerge.js — כשהקריאה לשעות השירות נכשלת: הערך האחרון הידוע, לא ברירת המחדל.
//
// ============================================================
// ⚠️ למה זה קיים — נמדד בייצור, 05/10/2026
// ============================================================
// `site_uptime_service` לקחה מהדשבורד 3–12 שניות, ופעם בכמה דקות חצתה את
// תקרת 8 השניות של המסד (57014, statement timeout). הכשל אינו מפיל את הרשימה
// (sitesDirect), אבל לאותה דקה כל השדות שמקורם בה נפלו לברירת המחדל:
//   • הדרגה → `sites.tier` ("בסיסי" אצל כמעט כולם). ויצמן, VIP, הוצג "בסיסי".
//   • הזמינות ואחוז הכשל → חישוב 24/7, במקום שעות השירות.
// כלומר מספר וצבע על המסך שקפצו הלוך וחזור בלי שדבר באתר השתנה.
//
// הכלל: כשהקריאה נכשלה, השדות האלה נלקחים מהשליפה הקודמת שהצליחה. אם אין
// כזו (טעינה ראשונה שנכשלה, או אתר חדש) — ברירת המחדל נשארת, כמו קודם.
// ⚠️ ולאורך כשלים רצופים: ערך שהועבר נשמר שוב — לא חוזרים לברירת המחדל
// בכשל השני.

// כל השדות ש-sitesDirect גוזר מ-`site_uptime_service`. שדה שיתווסף שם ולא כאן
// יקפוץ שוב לברירת המחדל בכל כשל — ולכן הרשימה נבדקת ב-tests/service-merge.test.js.
export const SERVICE_FIELDS = [
  "tier",
  "uptime",
  "failureRate",
  "serviceAgreement",
  "servicePlan",
  "serviceHours",
  "serviceOperations",
  "serviceErrors",
];

/**
 * @param {Array|null} prev  הרשימה שעל המסך
 * @param {Array} next       השליפה החדשה (אתר עם `serviceStale: true` = הקריאה נכשלה)
 * @returns {Array} next, ובאתרים שנכשלו — השדות מהשליפה הקודמת שהצליחה
 */
export function keepLastService(prev, next) {
  if (!Array.isArray(next) || !next.some((s) => s && s.serviceStale)) return next;
  const byCode = new Map((Array.isArray(prev) ? prev : []).map((s) => [s.code, s]));
  return next.map((s) => {
    if (!s || !s.serviceStale) return s;
    const old = byCode.get(s.code);
    // ערך "טוב" = מהשליפה שהצליחה, או כזה שכבר הועבר ממנה
    if (!old || (old.serviceStale && !old.serviceKept)) return s;
    const kept = {};
    for (const f of SERVICE_FIELDS) kept[f] = old[f];
    return { ...s, ...kept, serviceKept: true };
  });
}
