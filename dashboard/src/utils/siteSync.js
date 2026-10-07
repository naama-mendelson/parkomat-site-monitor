// utils/siteSync.js — האם המסך עדיין תואם את המסד, בבדיקה זולה.
//
// ============================================================
// ⚠️ למה: 07/10/2026 — השרת קרס, והעומס העיקרי היה המסכים
// ============================================================
// כל מסך פתוח — גם מוסתר, גם מסך קיר שאיש אינו מסתכל בו — חישב מחדש את
// הסטטיסטיקות של כל האתרים (6 שאילתות כבדות, ~2 שניות במסד) **בכל דקה**, ושוב
// אחרי כל פעולה, תקלה או ניתוק באחד מ-62 האתרים. כמה מסכים פתוחים לבדם דרשו
// יותר ממה ששרת Nano מחזיק, והקרדיטים של המעבד נגמרו.
//
// מאז:
//   • הסטטיסטיקות (פעולות, זמינות, מגמה — site_stats ×2, site_uptime,
//     site_uptime_service; ~12 שניות במסד לטעינה) — **רק בכניסה לדף**: פתיחת
//     הדשבורד, מעבר בין דפים, וחזרה ללשונית שהייתה מוסתרת (לכל היותר פעם ב-5 דקות).
//     בעלת המוצר, 07/10/2026: "אין צורך לחשב את הסטטיסטיקות כל דקה. אין צורך אלא
//     בשעה שעוברים לדף הזה". המחיר ידוע: מסך קיר שנשאר פתוח מציג את המספרים מרגע
//     הכניסה.
//   • הטעינה החיה (`sites`, site_globals — מצב, תקלה, תחזוקה) — פעם ב-5 דקות.
//     שדות הסטטיסטיקה נשמרים בה מהטעינה הקודמת (keepLastStats).
//   • בכל דקה — רק בדיקה זולה של מצבי האתרים (שאילתה אחת על `sites`, אלפיות
//     שנייה). רק אם היא מוצאת אי-התאמה — טעינה חיה מיד. כך רשת הביטחון של דקה
//     נשמרת לסטטוס (ערוץ חי שמת בשקט — ראו App.jsx), בלי המחיר.
//   • מסך מוסתר — כלום. כשהוא חוזר להיות גלוי, אותה בדיקה רצה מיד.
//
// קובץ טהור (בלי React ובלי ייבוא) — כדי שאפשר יהיה לבדוק אותו ב-node.

/** הטעינה החיה (בלי הסטטיסטיקות) — לכל היותר פעם בזמן הזה, מכל סיבה רגילה. */
export const FULL_RELOAD_EVERY_MS = 5 * 60_000;

/** חזרה ללשונית מחשבת את הסטטיסטיקות מחדש רק אם החישוב הקודם ישן לפחות כך. */
export const STATS_ON_RETURN_MIN_MS = 5 * 60_000;

/**
 * חזרה ללשונית — האם לחשב את הסטטיסטיקות מחדש?
 * ⚠️ עם רצפה: מי שעובר בין לשוניות כל חצי דקה היה מריץ ~12 שניות של מסד בכל חזרה.
 */
export function statsDueOnReturn(lastStatsAt, now = Date.now()) {
  return now - lastStatsAt >= STATS_ON_RETURN_MIN_MS;
}

// ============================================================
// השדות שמקורם בסטטיסטיקות — נשמרים בטעינה החיה
// ============================================================
// כל שדה ש-sitesDirect גוזר מ-site_stats / site_uptime / site_uptime_service.
// טעינה חיה אינה שולפת אותן, ובלי העתקה כל השדות האלה היו נופלים לברירת המחדל
// כל 5 דקות: "0 פעולות", זמינות "—", ומסלול "בסיסי" לאתר VIP.
// ⚠️ שדה שיתווסף שם ולא כאן יקפוץ לברירת המחדל — tests/site-sync.test.js בודק את
// הרשימה מול sitesDirect.
export const STATS_FIELDS = [
  "statsAt",
  "tier",
  "failureRate",
  "serviceOperations",
  "serviceErrors",
  "operations",
  "errors",
  "avgRepairMinutes",
  "medianRepairMinutes",
  "longRepairCount",
  "longRepairPercent",
  "quickRepairCount",
  "mediumRepairCount",
  "repairSeries",
  "uptime",
  "serviceAgreement",
  "servicePlan",
  "serviceHours",
  "serviceStale",
  "serviceKept",
  "trend",
];

/**
 * @param {Array|null} prev  הרשימה שעל המסך
 * @param {Array} next       השליפה החדשה (אתר עם `statsSkipped: true` = טעינה חיה)
 * @returns {Array} next, ובטעינה חיה — שדות הסטטיסטיקה מהרשימה שעל המסך
 */
export function keepLastStats(prev, next) {
  if (!Array.isArray(next) || !next.some((s) => s && s.statsSkipped)) return next;
  const byId = new Map((Array.isArray(prev) ? prev : []).map((s) => [s.id, s]));
  return next.map((s) => {
    if (!s || !s.statsSkipped) return s;
    const old = byId.get(s.id);
    // אתר בלי סטטיסטיקה קודמת (חדש) — נשאר עם ברירת המחדל; useSites מבקש טעינה
    // עם סטטיסטיקות מיד (statsMissing)
    if (!old || old.statsAt == null) return s;
    const kept = {};
    for (const f of STATS_FIELDS) kept[f] = old[f];
    return { ...s, ...kept };
  });
}

/**
 * טעינה חיה — האם יש באתר ברשימה שעוד לא חושבה לו סטטיסטיקה אף פעם?
 * @param {Array} next           השליפה החדשה
 * @param {Set<number>} knownIds אתרים שכבר הגיעו בטעינה עם סטטיסטיקות
 */
export function statsMissing(next, knownIds) {
  return Array.isArray(next) && next.some((s) => s && !knownIds.has(s.id));
}

/** הבדיקה הזולה של מצבי האתרים. */
export const STATUS_CHECK_EVERY_MS = 60_000;

/**
 * האם הגיע זמן הטעינה המלאה?
 * ⚠️ עם מרווח של חצי בדיקה: הבדיקה רצה כל דקה, והטעינה הקודמת התחילה כמה אלפיות
 * שנייה אחרי הבדיקה שהפעילה אותה — בלי המרווח "5 דקות" יוצאות 6 (נמדד בדפדפן).
 */
export function fullReloadDue(lastFullAt, now = Date.now()) {
  return now - lastFullAt >= FULL_RELOAD_EVERY_MS - STATUS_CHECK_EVERY_MS / 2;
}

/**
 * האם רשימת האתרים שעל המסך עדיין תואמת את מצבי האתרים במסד?
 *
 * @param {Array} sites — הרשימה שעל המסך
 * @param {Array|null} fresh — [{id, code, status}] מטבלת `sites`, או null כשאין בדיקה זולה
 * @returns {boolean} false → צריך טעינה מלאה: אתר נוסף/נמחק/שינה קוד, או שמצבו שונה
 */
export function statusesMatch(sites, fresh) {
  if (!Array.isArray(fresh)) return true;   // אין בדיקה זולה (מצב שרת) — הטעינה המלאה תכריע
  if (!Array.isArray(sites) || fresh.length !== sites.length) return false;
  const byId = new Map(sites.map((s) => [s.id, s]));
  for (const f of fresh) {
    const s = byId.get(f.id);
    if (!s || s.code !== f.code) return false;
    // ⚠️ אתר בחלון תחזוקה מוצג "בתחזוקה" בלי קשר למה שבטבלה — לא משווים אותו.
    // סוף החלון נתפס בטעינה המלאה של כל 5 דקות.
    if (!s.inMaintenance && s.status !== f.status) return false;
  }
  return true;
}
