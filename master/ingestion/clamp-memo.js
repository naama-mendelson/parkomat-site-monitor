// ingestion/clamp-memo.js — החלטת יישור אחת לכל (אתר, חותם מדווח).
//
// ============================================================
// למה זה נחוץ, ולמה רצפה לבדה לא מספיקה
// ============================================================
// מעבר MODE אחד בבקר מייצר **שתי** הודעות שנושאות את אותו חותם זמן בדיוק:
// `state` ו-`operation` (OperationDetector.Process לוקח now פעם אחת ומחתים בו
// את שתיהן). הן מגיעות לשרת בזו אחר זו ומעובדות טורית — ולכן ה"עכשיו" של
// השרת שונה ביניהן, בדרך כלל בשנייה.
//
// היישור מחשב את החותם החדש מול "עכשיו". כלומר שתי הודעות שיצאו מאותו רגע
// פיזי מקבלות **שני חותמים שונים**. וזה מה שנצפה בשטח, בשורה אחת מהלוג:
//
//     אתר 1343: שעון מקדים ב-46s — החותם יושר לזמן השרת (1785134028)   ← state
//     אתר 1343: שעון מקדים ב-45s — החותם יושר לזמן השרת (1785134029)   ← operation
//
// שנייה הפרש, ובכיוון ההרסני: המצב 'מוכן' נרשם *לפני* "הפעולה הסתיימה". בלוג
// זה נקרא כאילו האתר חזר להיות מוכן בזמן שהפעולה עוד פתוחה — סדר שלא יכול
// לקרות, והמשתמש צדק כשאמר שזה שטויות.
//
// FUTURE_CLAMP_MIN_SECONDS (plausibility.js) מטפל במקרה הקטן — סטייה של
// שנייה-שתיים שכלל לא צריכה יישור. אבל באתר עם סחיפה אמיתית (1343 ב-45s,
// 2439 ב-72s) **שתי** ההודעות עוברות את הרצפה ושתיהן מיושרות — כל אחת ל-now
// אחר. לכן צריך גם את זה: ההחלטה נזכרת, והשנייה מקבלת בדיוק אותו ערך.
//
// המפתח הוא החותם ה**מדווח** (לפני היישור) ולא המיושר — הוא מה שמשותף לשתי
// ההודעות, והוא אינו משתנה לעולם (זהו גם מפתח ה-dedup, ראה plausibility.js).

/**
 * כמה זמן לזכור החלטה. שתי ההודעות של מעבר אחד מגיעות בתוך שניות, ולכן גם
 * ערך קטן היה מספיק. חמש דקות נותנות מרווח נדיב למסירה חוזרת של QoS-1
 * שמתעכבת, ועדיין קצרות מדי מכדי לצבור זיכרון.
 */
const TTL_MS = 5 * 60 * 1000;

/**
 * תקרת גודל. 200 אתרים × מעבר או שניים בדקה נמצאים רחוק מתחת לזה; התקרה היא
 * גדר בטיחות מפני דליפה, לא מדיניות.
 */
const MAX_ENTRIES = 5000;

const memo = new Map();   // "siteId|reportedSec" → { effectiveSec, at }

const keyOf = (siteId, reportedSec) => `${siteId}|${reportedSec}`;

/** מפנה רשומות שפג תוקפן, ואם עדיין צפוף — את הישנות ביותר (Map שומר סדר הכנסה). */
function prune(nowMs) {
  for (const [k, v] of memo) {
    if (nowMs - v.at > TTL_MS) memo.delete(k);
  }
  while (memo.size > MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
}

/**
 * זוכר את החותם האפקטיבי שנבחר עבור (אתר, חותם מדווח).
 * נקרא גם כשההודעה **לא** יושרה — כדי שהודעה שנייה עם אותו חותם מדווח לא
 * תיושר בדיעבד ותיפרד מהראשונה.
 */
function rememberClamp(siteId, reportedSec, effectiveSec, nowMs = Date.now()) {
  prune(nowMs);
  memo.set(keyOf(siteId, reportedSec), { effectiveSec, at: nowMs });
  return effectiveSec;
}

/**
 * מחזיר את החותם האפקטיבי שנקבע קודם לאותו (אתר, חותם מדווח), או null אם אין.
 */
function recallClamp(siteId, reportedSec, nowMs = Date.now()) {
  const hit = memo.get(keyOf(siteId, reportedSec));
  if (!hit) return null;
  if (nowMs - hit.at > TTL_MS) { memo.delete(keyOf(siteId, reportedSec)); return null; }
  return hit.effectiveSec;
}

/** לבדיקות בלבד — מאפס את הזיכרון בין מקרי בדיקה. */
function resetClampMemo() {
  memo.clear();
}

/** לבדיקות/אבחון: כמה החלטות נזכרות כרגע. */
const clampMemoSize = () => memo.size;

module.exports = {
  rememberClamp, recallClamp, resetClampMemo, clampMemoSize,
  TTL_MS, MAX_ENTRIES,
};
