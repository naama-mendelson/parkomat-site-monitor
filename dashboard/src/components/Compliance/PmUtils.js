// components/Compliance/PmUtils.js — עזרים קטנים ללשונית "תחזוקה מונעת" (בלי React).
//
// ⚠️ כל קבוע כאן הוא **שיקוף** של כלל שנאכף ב-SQL (compliance.postgres.sql,
// סעיף 2.2), ולא הכלל עצמו. הוא קיים כדי שהמסך יסביר *לפני* הלחיצה למה
// משהו לא יעבור — ולא כדי להחליט. השרת הוא הסמכות; אם השיקוף יתיישן,
// המשתמש יקבל את ההודעה העברית של השרת במקום ההסבר של המסך, ולא יותר מזה.
import { todayIL, addDaysISO } from "../../utils/compliance.js";
import { parseDate } from "../../../../shared/parse-inspection.mjs";

export const DISCARD_IDLE_MS = 48 * 60 * 60 * 1000;   // app.pm_may_discard — 48 שעות שקט
export const SUBMIT_MAX_AGE_DAYS = 7;                 // pm_visit_submit — "נפתח לפני יותר משבוע"
export const MAX_PHOTOS_PER_ITEM = 6;                 // pm_visit_photo_add
export const MAX_PHOTOS_PER_VISIT = 40;               // pm_visit_photo_add + pm_template_save
export const VISIT_PHOTO_MAX_BYTES = 15 * 1024 * 1024; // pm_visit_photo_add — "נפח התמונות בביקור עבר 15MB"
// מעל זה כדאי להזהיר: תמונה דחוסה היא ~350–950KB, כלומר 15MB נגמרים
// אחרי 16 עד 40 תמונות — לפי הצילום, ולא לפי מה שהמנהל רואה ברשימה.
export const PHOTO_TOTAL_WARN = 16;
export const ITEM_NOTE_MAX = 1000;                    // pm_visit_items.note
export const VISIT_NOTE_MAX = 2000;                   // pm_visits.note
export const NAME_MAX = 100;                          // שם המבצע / הספק
export const REASON_MAX = 500;                        // app.compliance_reason
export const TEMPLATE_MAX_ITEMS = 100;                // pm_template_save
export const LABEL_MIN = 2;
export const LABEL_MAX = 300;
export const HINT_MAX = 500;

// אותו מפתח כמו בדיאלוג סגירת הליקוי — טכנאי שמילא את שמו שם לא ממלא שוב כאן.
export const NAME_KEY = "compliance.performerName";

export const KIND_LABEL = {
  check: "סימון",
  photo: "צילום",
  check_photo: "סימון + צילום",
};

// ============================================================
// אחסון — כל גישה עטופה
// ============================================================
// ⚠️ localStorage/sessionStorage זורקים בגלישה פרטית ובחסימת אתר. שם שלא
// נזכר או טופס שלא נפתח מחדש אחרי רענון אינם סיבה למסך שבור.
export function readStore(kind, key) {
  try {
    return window[kind].getItem(key);
  } catch {
    return null;
  }
}

export function writeStore(kind, key, value) {
  try {
    if (value == null || value === "") window[kind].removeItem(key);
    else window[kind].setItem(key, String(value));
  } catch { /* אין לאן לשמור — ממשיכים */ }
}

// ============================================================
// זמן ותאריכים
// ============================================================
/** כמה מילישניות עברו מחותמת ISO. חותמת לא קריאה = 0 (לא "ישן"). */
export function idleMs(isoStamp, now = Date.now()) {
  const t = Date.parse(isoStamp || "");
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

/** "YYYY-MM-DD" בשעון ישראל של חותמת ISO-UTC. */
export function dateILOf(isoStamp) {
  const t = Date.parse(isoStamp || "");
  return Number.isFinite(t) ? todayIL(new Date(t)) : null;
}

/** "לפני 3 שעות" / "לפני 2 ימים" — לכרטיס הטיוטה. */
export function agoText(isoStamp, now = Date.now()) {
  const ms = idleMs(isoStamp, now);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "ממש עכשיו";
  if (min < 60) return `לפני ${min} דק׳`;
  const h = Math.floor(min / 60);
  if (h < 48) return h === 1 ? "לפני שעה" : `לפני ${h} שעות`;
  return `לפני ${Math.floor(h / 24)} ימים`;
}

/**
 * טווח תאריך הביצוע שהשרת יקבל בהגשה.
 *
 * ⚠️ לא רק "בין פתיחת הביקור להיום": pm_visit_submit דוחה גם תאריך שרחוק
 * יותר משבוע מיום הפתיחה ("הביקור נפתח לפני יותר משבוע — יש להתחיל מחדש").
 * כלומר הטווח האמיתי הוא [פתיחה, min(היום, פתיחה+7)]. בלי הגבול העליון
 * הזה, טיוטה שנשכחה עשרה ימים הייתה מציעה את "היום" כברירת מחדל — וכל
 * הגשה הייתה נדחית בלי שהטופס הסביר מראש.
 */
export function submitDateRange(startedAt, today = todayIL()) {
  const started = dateILOf(startedAt) || today;
  const min = started > today ? today : started;   // שעון מכשיר שמקדים — לא חוסמים לגמרי
  const cap = addDaysISO(min, SUBMIT_MAX_AGE_DAYS);
  const max = cap < today ? cap : today;
  return { min, max, tooOld: cap < today };
}

// ============================================================
// שמות — "עודכן ע״י X"
// ============================================================
const norm = (s) => String(s || "").trim().toLowerCase();
export const sameName = (a, b) => !!norm(a) && norm(a) === norm(b);

const ME_KEY = (uid) => `compliance.me.${uid}`;

/**
 * שם התצוגה של המשתמש הנוכחי כפי שהשרת כותב אותו (updated_by / started_by).
 * ⚠️ הדפדפן אינו מכיר את full_name — רק את המייל והמזהה. השם נלמד מכתיבה
 * שבוודאות שלנו (פתיחת ביקור שנוצר עכשיו, הגשה שלנו) ונשמר למכשיר.
 */
export function readMe(uid) {
  return uid ? readStore("localStorage", ME_KEY(uid)) : null;
}

export function writeMe(uid, name) {
  if (uid && name) writeStore("localStorage", ME_KEY(uid), name);
}

/**
 * כמה תמונות **חייב** כל ביקור לפי הרשימה: סכום min_photos של פריטי החובה.
 * ⚠️ מעל MAX_PHOTOS_PER_VISIT אף ביקור לא יוכל להיות מוגש — התמונה ה-41
 * נדחית בשרת, וההגשה ממשיכה לחכות לפריטים שחסרה להם תמונה. pm_template_save
 * אוכף את אותו כלל; כאן הוא מוסבר לפני השמירה.
 */
export function templatePhotoTotal(rows) {
  return (rows || []).reduce((n, r) => n + (r?.required && r.kind !== "check" ? Number(r.min_photos) || 0 : 0), 0);
}

/**
 * מפתח ה-requestId של הגשה, לכל ביקור. ⚠️ ב-sessionStorage ולא ב-state של
 * הטופס: "חזרה לסקירה" → "המשך", או רענון, יוצרים טופס חדש — ומזהה חדש היה
 * הופך ניסיון חוזר אחרי תשובה שאבדה ל-PT409 "הביקור כבר הוגש" במקום replay.
 */
export const submitReqKey = (visitId) => `pm.submitReq.${visitId}`;

/** "שינוי אחד" / "3 שינויים" — "1 שינויים ממתינים" נקרא כתקלה בטקסט. */
export function countText(n, one, many) {
  return n === 1 ? one : `${n} ${many}`;
}

// ============================================================
// קבצים
// ============================================================
export function bytesText(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export const isPdfFile = (f) => !!f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""));

// מחפש מועמדים לתאריך בטקסט. ⚠️ parseDate עצמו (המשותף עם המפענח של
// הבודק, שתוקן אחרי שקרא 2-ספרות שנה לא נכון) הוא מי שמכריע אם זה תאריך;
// הביטוי כאן רק מוצא מחרוזות שנראות כמו תאריך.
// ⚠️ ISO קודם, ושני הצדדים חסומים בספרה: בלי זה "2026-11-11" נחתך ל-"26-11-11"
// ונקרא 26/11/2011. ובלי lookbehind — ספארי לפני 16.4 לא טוען מודול שמכיל אחד.
const DATE_CANDIDATE = /(?:^|\D)(\d{4}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{1,2}|\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4})(?!\d)/g;

/**
 * הצעת תאריך ביצוע מתוך הטקסט של דוח סרוק: התאריך המאוחר ביותר שאינו
 * בעתיד. ⚠️ "בעתיד" נפסל בכוונה — בדוחות תחזוקה מופיע גם "הביקור הבא",
 * ותאריך עתידי היה נדחה בשרת ממילא. זו **הצעה** בלבד; המנהל רואה אותה מסומנת.
 * @param {Array<{items:Array<{str?:string}>}>} pages — פלט extractPages
 * @returns {string|null} "YYYY-MM-DD"
 */
export function suggestDocDate(pages, today = todayIL()) {
  let best = null;
  for (const page of pages || []) {
    const text = (page.items || []).map((it) => it.str || "").join(" ");
    for (const m of text.matchAll(DATE_CANDIDATE)) {
      const iso = parseDate(m[1]);
      if (!iso || iso > today || iso < "2000-01-01") continue;
      if (!best || iso > best) best = iso;
    }
  }
  return best;
}
