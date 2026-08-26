// shared/executive.mjs — מסך ההנהלה. **קוד משותף לשרת ולדשבורד.**
//
// ============================================================
// למה גם זה הלך לדשבורד ולא ל-SQL
// ============================================================
// ההערכה הראשונה הייתה שנדרשת פונקציית SQL חדשה שתחזיר מדדים לכל אתר × לכל
// דלי. הבדיקה הראתה שזה שגוי:
//
// **getBucketRanges תלויה באזור הזמן המקומי ומייצרת תוויות בעברית.** היא
// מיישרת לחצות מקומית, נסוגה ליום ראשון, וקוראת ל-toLocaleDateString("he-IL")
// לשמות חודשים. פורט שלה ל-Postgres היה שכפול שברירי של כל אלה — ותאריך
// שנופל לדלי שכן הוא בדיוק סוג ההבדל שאיש לא מבחין בו עד שמישהו שואל למה
// השבוע לא מסתדר.
//
// והמדדים עצמם — statsFromData ו-uptimeFromData — **כבר מאומתים** מול
// site_stats ו-site_uptime ב-1,338 השוואות. הרצתם בדפדפן אינה הגדרה שנייה
// אלא אותה הגדרה, ו-tools/parity.js הוא מה שמחזיק את זה נכון.
//
// ⚠️ **אל תמחקו את statsFromData ו-uptimeFromData.** הן צד הייחוס של שער
// ה-parity *וגם* המנוע של המסך הזה. מחיקתן שוברת את שניהם בבת אחת.
//
// ============================================================
// למה .mjs
// ============================================================
// הדשבורד ESM והשרת CommonJS. מ-Node 22.12 `require()` טוען ESM סינכרונית.
// מקור אמת אחד, שני זמני ריצה. נבדק על Node v24.18.0.

// ============================================================
// קיפול הריצוד מגיע מ-insights.mjs — ואינו משוכפל לכאן
// ============================================================
// `X → no_comm → X` הוא אירוע אחד ולא שלושה, וזו **הגדרה** ולא תצוגה:
// יש לה פורט ל-SQL (public.site_segments_collapsed) שמאומת ב-parity.
// שני עותקים שלה בשני מודולים משותפים היו נפרדים בשינוי הראשון, ואז
// הזמינות והתובנות היו סופרות תקלות אחרת.
import { collapseNoCommFlicker, mergedWindows, coveredMs } from "./insights.mjs";
// יצוא-מחדש: queries.js מייבא אותן מכאן זה מכבר.
export { mergedWindows, coveredMs };

export const AVAILABLE_STATUSES = ["ready", "operating"];   // זמין לשירות
// ============================================================
// 'נתק' אינו השבתה — והוא גם אינו זמינות
// ============================================================
// ⚠️ **החלטת מוצר, לא שיפור חישוב.** עד כה `no_comm` היה במכנה, כלומר נחשב
// ככשל של המכונה. אבל נתק פירושו שהסוכן, ה-PC או הרשת אינם מדווחים —
// **המחסום עצמו עשוי לעבוד מצוין ולשרת רכבים כל אותו זמן.** אנחנו לא יודעים,
// וזה בדיוק העניין: אי-ידיעה אינה כשל.
//
// לכן הוא יוצא מהמדידה לגמרי, באותו מעמד כמו תחזוקה — לא במונה ולא במכנה.
//
// ⚠️ **וזה מסתיר סיגנל תפעולי אמיתי.** נמדד: אתר 2439 עולה מ-72.8% ל-99.3%,
// כי הוא מנותק כרבע מהזמן. המספר שוב אינו מספר את זה — ולכן הדשבורד **חייב**
// להציג אזהרה כשיש שעות נתק (AvailabilityNote). האזהרה אינה קישוט; היא
// הצד השני של ההחלטה הזו, ובלעדיה המידע נעלם.
//
// ⚠️ תוצאת לוואי מכוונת: אתר שהיה מנותק **כל** התקופה מקבל measuredMs = 0,
// ולכן זמינות null → המסך מציג "—". זה נכון ועקבי עם הכלל הקיים: לא מדדנו
// עליו כלום, ו-0% היה קורא כ"שבור לחלוטין".
export const DOWN_STATUSES = ["error"];                     // השבתה שהיא באמת כשל
// maintenance, no_comm — מחוץ למשוואה, בכוונה.

// ============================================================
// האם האתר משתפר או מחמיר — פסק אחד לכרטיס
// ============================================================
// **המדד הוא אחוז הכשל** (תקלות ÷ פעולות) של השבוע האחרון מול השבוע שלפניו.
// לא הזמינות: מאז שנתק ותחזוקה יצאו מהמדידה היא יושבת אצל כמעט כל האתרים
// סביב 99%, ואינה מבחינה בין אתר בריא לאתר שהתחיל ליפול. אחוז הכשל זז.
//
// ⚠️ **סף מדגם, ולא ניואנס.** אתר עם 4 פעולות ותקלה אחת הוא 25% כשל; בשבוע
// שלפניו 3 פעולות ואפס תקלות הם 0%. זו "החמרה של 25 נקודות" שכולה רעש של
// מספרים קטנים — ובדיוק סוג המספר שגורם לפתוח חקירה על כלום. לכן שני
// השבועות חייבים להגיע ל-MIN_OPERATIONS, אחרת אין פסק בכלל.
//
// ⚠️ **שני מצבים בלבד: עלייה או ירידה.** היה כאן אזור מת של נקודת אחוז,
// שסיווג תנודות קטנות כ"יציב". זו הייתה החלטה שלי, והיא בוטלה: על המסך
// היא יצרה מצב שלישי דהוי שנראה כמו נתון חסר, ומי שסורק רשת של כרטיסים
// רוצה תשובה בינארית — האתר הולך לכיוון טוב או רע.
//
// ⚠️ המחיר מפורש: תזוזה של 0.11 נקודות נקראת עכשיו "מחמיר" בדיוק כמו
// תזוזה של 6 נקודות. **גודל ההפרש נמצא בריחוף** — הסימן אומר כיוון, לא
// עוצמה. מי שרוצה לדעת כמה, מרחף.
//
// ⚠️ סף המדגם **נשאר** — הוא מגן על משהו אחר לגמרי: אתר עם 4 פעולות
// ותקלה אחת הוא 25% כשל, וזה רעש של מספרים קטנים ולא כיוון.
//
// ⚠️ הכיוון הפוך לסימן: אחוז כשל **יורד** = האתר משתפר. זו הנקודה היחידה
// שקל לטעות בה כאן, ולכן היא מוחזרת כמילה ('improving'/'worsening') ולא
// כמספר שהקורא צריך לפרש.
export const SITE_TREND_MIN_OPERATIONS = 5;

/**
 * @param current  { operations, failureRate } — השבוע האחרון
 * @param previous { operations, failureRate } — השבוע שלפניו
 * @returns { direction, deltaPoints, current, previous } או null כשאין מספיק מדגם
 */
export function siteTrend(current, previous) {
  if (!current || !previous) return null;

  const curOps = Number(current.operations) || 0;
  const prevOps = Number(previous.operations) || 0;
  if (curOps < SITE_TREND_MIN_OPERATIONS || prevOps < SITE_TREND_MIN_OPERATIONS) {
    return null;
  }

  const cur = Number(current.failureRate) || 0;
  const prev = Number(previous.failureRate) || 0;
  const deltaPoints = Math.round((cur - prev) * 100) / 100;

  // ⚠️ 'stable' נשאר, אבל **רק על שוויון מדויק**. הוא אינו מצב שלישי אלא
  // מקרה קצה: שני שבועות עם אותו אחוז בדיוק — לרוב 0% מול 0%. חץ במקרה
  // כזה היה טוען על כיוון שלא קיים.
  const direction = deltaPoints === 0
    ? "stable"
    : deltaPoints < 0 ? "improving" : "worsening";

  return { direction, deltaPoints, current: cur, previous: prev };
}


/**
 * מחשב את הזמינות ממפת מילישניות לפי מצב. מקור האמת היחיד.
 * מחזיר { availabilityPercent, measuredMs } — measuredMs הוא המכנה,
 * ו-0 בו פירושו "אין נתון" (ולא "זמינות אפס").
 */

export function getBucketRanges({ from, to, granularity }) {
  // ============================================================
  // ⚠️ טווח ארוך מדי **מגס** את הרזולוציה, ולא נחתך בשקט
  // ============================================================
  // כאן הייתה תקרת דליים (MAX) שפשוט הפסיקה את הלולאה. הגרף נגמר באמצע
  // הטווח, בלי סימן ובלי הודעה — טווח יומי בן שנתיים הציג 400 ימים
  // וה-330 האחרונים נעלמו, כולל **התקלות שבהם**. הכותרת עדיין אמרה את
  // הטווח המלא, ולכן זה נקרא כ"לא קרה כלום" ולא כ"לא הוצג".
  //
  // ⚠️ וזה נעשה נגיש בדיוק עכשיו: עד היום הרזולוציה נגזרה מאורך הטווח
  // ולכן לעולם לא חרגה. משנכבד את בורר הרזולוציה (ראה resolveRange),
  // "יומית" על טווח של שנתיים היא בחירה לגיטימית של המשתמשת.
  //
  // חיתוך הוא איבוד נתונים; היגסה היא אותם נתונים בעמודות רחבות יותר.
  const spanDays = Math.max(1, (Date.parse(to) - Date.parse(from)) / 86400000);

  let effective = granularity;
  if (effective !== "month") {
    if (effective === "week" && spanDays / 7 > 120) effective = "month";
    else if (effective !== "week" && spanDays > 400) {
      effective = spanDays / 7 > 120 ? "month" : "week";
    }
  }

  const byMonth = effective === "month";
  const byWeek = effective === "week";

  const keyOf = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    if (byMonth) return `${y}-${m}`;
    // שבוע: מזוהה לפי תאריך תחילת השבוע (ראשון), כדי ששני ימים באותו
    // שבוע ייפלו לאותו מפתח.
    return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const ranges = [];
  const lastMs = Date.parse(to);
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  if (byMonth) cursor.setDate(1);
  if (byWeek) cursor.setDate(cursor.getDate() - cursor.getDay());   // אחורה עד יום ראשון

  // רשת ביטחון בלבד — אחרי ההגסה למעלה אף טווח סביר אינו מגיע לכאן.
  // חודשי מכסה 100 שנה, ולכן גם הוא אינו נחתך בפועל.
  const MAX = byMonth ? 1200 : byWeek ? 130 : 410;

  while (ranges.length < MAX) {
    const start = new Date(cursor);
    const next = new Date(cursor);
    if (byMonth) next.setMonth(next.getMonth() + 1);
    else if (byWeek) next.setDate(next.getDate() + 7);
    else next.setDate(next.getDate() + 1);

    // הדלי לא נמשך אל מעבר לקצה התקופה
    const end = next.getTime() > lastMs ? new Date(to) : next;
    const clippedStart = start.getTime() < Date.parse(from) ? new Date(from) : start;

    const label = byMonth
      ? start.toLocaleDateString("he-IL", { month: "short" })
      : byWeek
        ? `${start.getDate()}.${start.getMonth() + 1}`
        : `${start.getDate()}.${start.getMonth() + 1}`;

    ranges.push({
      key: keyOf(start),
      label,
      from: clippedStart.toISOString(),
      to: end.toISOString(),
    });

    // עוצרים כשהדלי הבא כבר מעבר לקצה
    if (next.getTime() >= lastMs) break;
    cursor.setTime(next.getTime());
  }

  return ranges;
}


// ============================================================
// עוזרות שהמדדים נשענים עליהן
// ============================================================
// ⚠️ availabilityFrom היא **ההגדרה היחידה של זמינות במערכת**. היא הייתה
// מחושבת בשלוש דרכים שונות בשלושה מקומות, ואותו אתר הראה מספר אחר בכל מסך.
// כל קורא עובר דרכה. אם צריך זמינות במקום חדש — קוראים לה, לא מחשבים מחדש.
//
// ⚠️ ותחזוקה מוחרגת מהמכנה **לגמרי** — היא אינה זמן תקין ואינה השבתה.
// הורדת אתר במכוון אסור שתיראה ככשל, ואסור גם שתתוגמל כזמינות.

// ==========================================================
// איחוד חלונות התחזוקה לקטעים זרים — ולמה זה חובה
// ==========================================================
// שני חלונות חופפים (טכנאי שהאריך תחזוקה, או שניים שהפעילו במקביל) היו
// נספרים פעמיים, וזמן התחזוקה היה גדול מהחלון עצמו. איחוד לקטעים זרים הופך
// את החישוב לחסין לכך.
//
// נחתך מראש לגבולות החלון הנמדד, כך שהספירה בהמשך היא חיתוך פשוט.
// ⚠️ mergedWindows ו-coveredMs עברו ל-insights.mjs ומיובאות משם. הן נחוצות
// **בשני** המודולים, ו-executive כבר מייבא מ-insights — הכיוון ההפוך היה
// יוצר מעגל, והעתקה הייתה יוצרת הגדרה שנייה לאותו כלל.


// האם ברגע ts האתר היה בתחזוקה — גרסת הזיכרון של wasInMaintenance.
//
// הגבול *כולל* בשני הקצוות (<= ... >=) *במכוון*: "מצב תחזוקה גובר על הכלל".
// כשה-PLC עובר מתחזוקה לתקלה, applyStateChange סוגר את מקטע התחזוקה ופותח
// את מקטע התקלה באותו חותם זמן (maintenance.ended_at === error.started_at).
// ה-'>=' גורם לתקלה שמתחילה בדיוק כשהתחזוקה נגמרה להיחשב "בתוך תחזוקה"
// ולכן היא מוחרגת מהספירה — בדיוק ההתנהגות הרצויה: תקלה בזמן/בגבול תחזוקה
// אינה תקלה. (מהיום גם ה-ingestion זורק תקלות כאלה לחלוטין — ראה state-handler;
// כאן זו הגנה על נתונים היסטוריים שכבר נרשמו.)
// ============================================================
// ⚠️ הסיווג מוחל **בכניסה**, ולא בכל קורא בנפרד
// ============================================================
// מנהל יכול לסווג מקטע תקלה מחדש כתחזוקה. `status` המקורי לעולם אינו
// נדרס — `reclassified_to` הוא שכבה מעליו — ולכן **כל** קריאה חייבת
// לעבור דרך COALESCE.
//
// ⚠️ הקובץ הזה לא הכיר את השדה בכלל: שמונה מקומות קראו status גולמי,
// ולכן המנהל הכללי, המפקח והאנליטיקה התעלמו מסיווג מחדש — בזמן
// שפונקציות ה-SQL, הציר והזמינות כבר כיבדו אותו. אותו אירוע, שני
// מספרים, לפי המסך.
//
// ⚠️ **בכניסה ולא בתווית** — אותו כלל בדיוק כמו ב-buildActivityLog:
// כללים במורד הזרם (רצף מקטעים, חפיפת תחזוקה, 'אחרי תקלה') חייבים
// לראות את המצב האפקטיבי, אחרת יוצא מקטע 'תחזוקה' שמסומן 'אחרי תקלה'
// בזמן שאין תקלה בסביבה.
//
// ⚠️ ונקודת גישה אחת ולא תיקון בשני בוני-המפה (loadRangeData בשרת,
// loadRangeShape בדשבורד) — שני מקומות שצריך לסנכרן הם בדיוק הדפוס
// שיצר את הפער הזה מלכתחילה.
export function segmentsOf(data, siteId) {
  // ⚠️ גישה ישירה למפה, ולא segmentsOf — ההחלפה הגורפת שהמירה את כל
  // הקוראים פגעה גם כאן והפכה את הפונקציה לרקורסיה אינסופית. אותה
  // טעות בדיוק כמו ב-clientIp, ובאותו יום.
  const raw = data.segments.get(siteId) || [];
  return raw.map((s) =>
    s.reclassified_to
      ? { ...s, status: s.reclassified_to, original_status: s.status }
      : s);
}

export function wasInMaintenanceMem(data, siteId, ts) {
  for (const w of data.windows.get(siteId) || []) {
    // ⚠️ חלון שסומן כניסוי אינו קיים לצורך המדד. בלי זה תקלה שקרתה בתוכו
    // הייתה עדיין מסווגת כ"תקלה בתחזוקה" — כלומר החלון בוטל לחצאין.
    if (w.excluded_at) continue;
    const end = w.cancelled_at || w.expires_at;
    if (w.started_at <= ts && end >= ts) return true;
  }
  for (const s of segmentsOf(data, siteId)) {
    if (s.status !== "maintenance") continue;
    if (s.started_at <= ts && (s.ended_at === null || s.ended_at >= ts)) return true;
  }
  return false;
}

export function availabilityFrom(ms) {
  const availableMs = AVAILABLE_STATUSES.reduce((sum, s) => sum + (ms[s] || 0), 0);
  const downMs = DOWN_STATUSES.reduce((sum, s) => sum + (ms[s] || 0), 0);
  const measuredMs = availableMs + downMs;

  return {
    measuredMs,
    availabilityPercent: measuredMs > 0
      ? Math.round((availableMs / measuredMs) * 10000) / 100
      : 0,
  };
}

export function statsFromData(data, siteId, { from, to }) {
  let operations = 0;
  for (const o of data.ops.get(siteId) || []) {
    // ⚠️ הוצאה ידנית של מנהל — "הקפצנו את הדלת כדי לבדוק". נבדק כאן ולא
    // מוזג לתוך התנאי שמעליו כדי שיישאר קריא שזו החלטת אדם ולא שיפוט קליטה.
    if (o.excluded_at) continue;
    if (o.is_anomaly === 0 && !o.superseded_by && o.start_end === "end" &&
        o.occurred_at >= from && o.occurred_at < to) operations++;
  }

  let errors = 0;
  let errorsInMaintenance = 0;
  // הקיפול רץ על *כל* המקטעים הטעונים ולא רק על אלה שבטווח, וזה חיוני: תקלה
  // שהתחילה לפני ה-from, נותקה, וחזרה בתוך הטווח — היא המשך, ואסור שתיספר.
  // בלי המקטע הקודם אי אפשר לדעת זאת.
  for (const s of collapseNoCommFlicker(segmentsOf(data, siteId))) {
    if (s.status !== "error") continue;
    // ⚠️ **אחרי הקיפול ולא לפניו.** מקטע שהוצא עדיין משתתף בקיפול ריצוד
    // הנתק כרגיל — הוא קרה, והוא ההקשר שקובע אם המקטע שאחריו הוא המשך או
    // תקלה חדשה. סינון לפני הקיפול היה משנה את גבולות המקטעים של שכניו,
    // כלומר הוצאה של תקלה אחת הייתה מזיזה את הספירה של אחרת.
    if (s.excluded_at) continue;
    if (!(s.started_at >= from && s.started_at < to)) continue;
    if (wasInMaintenanceMem(data, siteId, s.started_at)) errorsInMaintenance++;
    else errors++;
  }

  const failureRate = operations > 0 ? (errors / operations) * 100 : 0;
  return {
    operations,
    errors,
    errorsInMaintenance,
    failureRate: Math.round(failureRate * 100) / 100,
  };
}

export function uptimeFromData(data, siteId, { from, to }) {
  // אותה צורה מלאה כמו ב-getUptimeBreakdown — ראה ההסבר שם.
  const empty = {
    readyHours: 0, operatingHours: 0, errorHours: 0,
    maintenanceHours: 0, repairHours: 0, plannedHours: 0, noCommHours: 0,
    excludedHours: 0,
    totalHours: 0, measuredHours: 0, availabilityPercent: 0,
  };

  const nowIso = new Date().toISOString();
  const rangeEnd = to < nowIso ? to : nowIso;   // לא סופרים אל תוך העתיד
  const windowStart = Date.parse(from);
  const windowEnd = Date.parse(rangeEnd);
  if (!(windowEnd > windowStart)) return empty;

  const ms = { ready: 0, operating: 0, error: 0, maintenance: 0, no_comm: 0, excluded: 0 };

  // ⚠️ מצטברי הפילוח יושבים **מחוץ ל-ms**, ובכוונה. totalMs מסכם את
  // Object.values(ms), ולכן הכנסתם לשם סופרת את שעות התחזוקה פעמיים —
  // וזה נתפס מיד: parity נפל על totalHours ב-28 השוואות (1343: JS=153.29
  // מול SQL=153.12). הפילוח הוא **חתך** של maintenance, לא מצב נוסף.
  let repairMs = 0, plannedMs = 0;

  // ==========================================================
  // חלון תחזוקה ידני נספר כתחזוקה, ולא כמצב שה-PLC דיווח
  // ==========================================================
  // עד כאן רק סטטוס 'maintenance' *בהיסטוריה* הוחרג מהמכנה — כלומר תחזוקה
  // שהבקר דיווח עליה. חלון ידני מהדשבורד לא נגע בחישוב בכלל, והזמן שבתוכו
  // נספר לפי מה שה-PLC אמר.
  //
  // וזה לא היה ניטרלי אלא הפוך מהכוונה: תקלה בזמן תחזוקה נזרקת בקליטה
  // (state-handler), ולכן מקטע ה-'ready' פשוט ממשיך — **וזמן שבור נספר
  // כזמן זמין**. אתר שהושבת ידנית קיבל 100% זמינות. נמדד: 24 שעות שמתוכן
  // 12 בתחזוקה ידנית החזירו maintenance_hours=0 ו-100%.
  //
  // שני קובצי ההנחיות אומרים את ההפך במפורש — "מוחרגת מהמכנה", "אינה
  // uptime ואינה downtime, ואסור שתתוגמל כזמינות". זה מיישר את הקוד למפרט.
  // ⚠️ חלונות שסומנו כניסוי אינם מכסים כלום. חלון תחזוקה אינו רק שורה
  // בלוג — הוא **הופך** זמן של מקטעים אחרים לתחזוקה, ולכן סימונו כניסוי
  // חייב להסיר גם את הכיסוי ולא רק את השורה.
  const cover = mergedWindows(
    (data.windows.get(siteId) || []).filter((w) => !w.excluded_at),
    windowStart, windowEnd);

  // ============================================================
  // תחזוקה אחרי תקלה היא **תפעול תקלה**, לא תחזוקה מתוכננת
  // ============================================================
  // שתיהן מקטע maintenance זהה בטבלה, והן שני דברים הפוכים: מתוכננת היא
  // **החלטה** (סימן טוב), ותפעול תקלה הוא **תוצאה** של נפילה — מבחינת מי
  // שרצה לחנות זו אותה השבתה שנמשכת. ערבובן מייפה את התמונה: אתר שנופל
  // שלוש פעמים בשבוע ומטופל נראה כמו אתר בתחזוקה שוטפת מסודרת.
  // נמדד: 18 מתוך 141 (13%) ממקטעי התחזוקה מתחילים בדיוק כשתקלה נגמרת.
  //
  // ⚠️ הזיהוי חד-משמעי ואינו הערכה:
  //     error.ended_at === maintenance.started_at
  // הסוכן סוגר מקטע ופותח את הבא באותו סבב דגימה, ולכן החותם משותף בדיוק.
  // תחזוקה שבאה אחרי 'מוכן' או 'בפעולה' לעולם לא תתאים לחותם כזה.
  //
  // ⚠️ **הזמן לא זז בין המדדים.** שניהם נשארים maintenanceHours ומוחרגים
  // מהמכנה בדיוק כמו קודם — הזמינות אינה משתנה בכלל. מה שנוסף הוא **פילוח
  // בלבד**: repairHours + plannedHours === maintenanceHours, תמיד.
  //
  // ⚠️ החלון הידני נספר תמיד כ**מתוכננת**: מישהו לחץ על כפתור, וזו החלטה
  // לפי הגדרה. רק מקטע PLC יכול להיות תפעול תקלה.
  const errorEndSet = new Set(
    (segmentsOf(data, siteId))
      .filter((r) => r.status === "error" && r.ended_at)
      .map((r) => r.ended_at)
  );

  for (const row of segmentsOf(data, siteId)) {
    if (ms[row.status] === undefined) continue;

    // ============================================================
    // ⚠️ מקטע שהוצא — לא במונה, לא במכנה, אבל **כן נספר**
    // ============================================================
    // ההכרעה הייתה "לא נמדד בכלל", בדיוק כמו תחזוקה. `availabilityFrom`
    // קורא רשימת סטטוסים סגורה, ולכן דלי `excluded` נשאר מחוץ לשתי
    // הצלעות מעצם קיומו — בלי לגעת בהגדרת הזמינות.
    //
    // ⚠️ ולמה דלי ולא `continue` פשוט: `totalHours` הוא סכום הדליים, והוא
    // מה שמצויר בפס הזמינות. השמטה הייתה מקצרת את הפס בלי לומר למה —
    // כלומר זמן שנעלם מהמסך. כאן הוא מוצג ומוסבר.
    if (row.excluded_at) {
      const s0 = Math.max(Date.parse(row.started_at), windowStart);
      const e0 = Math.min(row.ended_at ? Date.parse(row.ended_at) : windowEnd, windowEnd);
      if (e0 > s0 && row.started_at < rangeEnd &&
          (row.ended_at === null || row.ended_at > from)) ms.excluded += e0 - s0;
      continue;
    }
    // אותו תנאי חפיפה כמו בשאילתה המקורית
    if (!(row.started_at < rangeEnd && (row.ended_at === null || row.ended_at > from))) continue;

    const start = Math.max(Date.parse(row.started_at), windowStart);
    const end = Math.min(row.ended_at ? Date.parse(row.ended_at) : windowEnd, windowEnd);
    if (!(end > start)) continue;

    // החלק שנופל בתוך חלון ידני עובר ל-maintenance; היתר נשאר במצבו.
    const covered = coveredMs(cover, start, end);
    ms.maintenance += covered;
    plannedMs += covered;                        // חלון ידני = החלטה, תמיד מתוכננת
    if (row.status !== "maintenance") {
      ms[row.status] += (end - start) - covered;
    } else {
      const own = (end - start) - covered;
      ms.maintenance += own;
      if (errorEndSet.has(row.started_at)) repairMs += own;
      else plannedMs += own;
    }
  }

  const toHours = (v) => Math.round((v / 3600000) * 100) / 100;
  const totalMs = Object.values(ms).reduce((a, b) => a + b, 0);
  const { measuredMs, availabilityPercent } = availabilityFrom(ms);

  return {
    readyHours: toHours(ms.ready),
    operatingHours: toHours(ms.operating),
    errorHours: toHours(ms.error),
    maintenanceHours: toHours(ms.maintenance),
    // פילוח בלבד — סכומם שווה ל-maintenanceHours ואינו נוגע בזמינות.
    repairHours: toHours(repairMs),
    plannedHours: toHours(plannedMs),
    noCommHours: toHours(ms.no_comm),
    // זמן שמנהל הוציא מהסטטיסטיקה. מחוץ לזמינות, בתוך totalHours.
    excludedHours: toHours(ms.excluded),
    totalHours: toHours(totalMs),          // כל הזמן שנמדד, כולל תחזוקה (לתצוגה)
    // המכנה של הזמינות — בלי תחזוקה. 0 = אין נתון, ולא "זמינות אפס".
    measuredHours: toHours(measuredMs),
    availabilityPercent,
  };
}

export function directionFromData(data, siteIds, { from, to }) {
  let entries = 0, exits = 0;
  for (const id of siteIds) {
    for (const o of data.ops.get(id) || []) {
      // superseded_by: ניסיון שנקטע והוחלף בניסיון חוזר אינו מעבר נוסף.
      // בלעדיו פילוח הכניסות/יציאות סותר את ספירת הפעולות שלצידו על אותו מסך.
      //
      // ⚠️ **ו-excluded_at מאותה סיבה בדיוק.** statsFromData מדלגת עליו
      // (שורה 301) וכאן לא — ולכן פעולה שמנהל הוציא ידנית ("הקפצנו את
      // הדלת כדי לבדוק") נעלמה מ'סך הפעולות' והמשיכה להיספר בפילוח
      // הכניסות/יציאות **שלצידו על אותו מסך**. כניסות+יציאות > פעולות,
      // וזה נראה כמו טעות עיגול ולא כמו מקור שונה.
      if (o.excluded_at) continue;
      if (o.is_anomaly !== 0 || o.superseded_by || o.start_end !== "end") continue;
      if (!(o.occurred_at >= from && o.occurred_at < to)) continue;
      if (o.entry_exit === "entry") entries++;
      else if (o.entry_exit === "exit") exits++;
    }
  }
  return { entries, exits };
}

export function heatmapFromData(data, sites, buckets) {
  const rows = sites.map((site) => ({
    siteCode: site.code,
    siteName: site.site_name,
    values: buckets.map((b) =>
      statsFromData(data, site.id, { from: b.from, to: b.to }).operations),
  }));

  const max = Math.max(0, ...rows.flatMap((r) => r.values));
  return { labels: buckets.map((b) => b.label), rows, max };
}

// דירוג אתרים: הכי זמינים / הכי בעייתיים. מקבל את שורות ה-supervisor כדי
// לא לחשב הכל פעמיים.
export function getTopPerformers(rows, limit = 5) {
  return rows
    .filter((r) => r.hasUptimeData)
    .sort((a, b) => b.availability - a.availability || b.operations - a.operations)
    .slice(0, limit)
    .map((r) => ({
      code: r.code, name: r.name,
      availability: r.availability, operations: r.operations,
    }));
}

export function getWorstPerformers(rows, limit = 5) {
  return rows
    .filter((r) => r.errors > 0)
    .sort((a, b) => b.failureRate - a.failureRate || b.errors - a.errors)
    .slice(0, limit)
    .map((r) => ({
      code: r.code, name: r.name,
      failureRate: r.failureRate, errors: r.errors,
    }));
}

/**
 * הרכבת מסך ההנהלה — טהור לחלוטין.
 *
 * הקלט הוא בדיוק מה שהשרת שולף ב-getSupervisorStatsWithData, ומה שהדשבורד
 * שולף מ-Supabase: שורות המסך, הנתונים הגולמיים לטווח, ורשימת האתרים.
 */
export function computeExecutive({ allRows, data, allSites, from, to,
                                   siteCodes, statuses, minFailureRate = 0,
                                   groupBy = "site", granularity = "day" }) {
  const totalSitesInSystem = allRows.length;

  // --- סינון ---
  const codeSet = siteCodes?.length ? new Set(siteCodes) : null;
  const statusSet = statuses?.length ? new Set(statuses) : null;

  const rows = allRows.filter((r) => {
    if (codeSet && !codeSet.has(r.code)) return false;
    if (statusSet && !statusSet.has(r.status)) return false;
    if (minFailureRate > 0 && r.failureRate < minFailureRate) return false;
    return true;
  });

  const idOf = new Map(allSites.map((s) => [s.code, s.id]));
  const selectedIds = rows.map((r) => idOf.get(r.code)).filter((x) => x !== undefined);

  // --- KPIs (על המסונן בלבד) ---
  const sum = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const totalOperations = sum("operations");
  const totalErrors = sum("errors");

  const withData = rows.filter((r) => r.hasUptimeData);
  const avgAvailability = withData.length
    ? Math.round((withData.reduce((s, r) => s + r.availability, 0) / withData.length) * 100) / 100
    : 0;

  const sitesByStatus = { ready: 0, operating: 0, error: 0, maintenance: 0, no_comm: 0 };
  for (const r of rows) if (sitesByStatus[r.status] !== undefined) sitesByStatus[r.status]++;

  // סך הכניסות/היציאות בכל הטווח (לאריחי הסיכום מתחת לגרף) — מהזיכרון
  const totals = directionFromData(data, selectedIds, { from, to });

  const kpis = {
    totalSites: rows.length,
    activeSites: sitesByStatus.ready + sitesByStatus.operating,
    totalOperations,
    totalEntries: totals.entries,
    totalExits: totals.exits,
    totalErrors,
    // משוקלל (סך תקלות ÷ סך פעולות), ולא ממוצע של אחוזים — אחרת אתר עם
    // 2 פעולות מקבל אותו משקל כמו אתר עם 2000.
    avgFailureRate: totalOperations > 0
      ? Math.round((totalErrors / totalOperations) * 10000) / 100
      : 0,
    avgAvailability,
    totalMaintenanceHours: Math.round(sum("maintenanceHours") * 100) / 100,
    totalDowntimeHours: Math.round(sum("downtimeHours") * 100) / 100,
  };

  // --- סדרת הזמן (משמשת גם לגרף וגם ל-groupBy=time) ---
  const buckets = getBucketRanges({ from, to, granularity });

  // הלולאה הזו הייתה הרוצחת: (דליים × אתרים × 3) שאילתות. חודש בגרנולריות
  // יומית = 30 דליים; עם 200 אתרים זה היה ~18,000 סיבובי רשת. עכשיו: אפס.
  const chart = buckets.map((b) => {
    let ops = 0, errs = 0, maint = 0, availSum = 0, availCount = 0;

    for (const id of selectedIds) {
      const st = statsFromData(data, id, { from: b.from, to: b.to });
      ops += st.operations;
      errs += st.errors;

      const up = uptimeFromData(data, id, { from: b.from, to: b.to });
      maint += up.maintenanceHours;
      if (up.measuredHours > 0) {
        availSum += up.availabilityPercent;
        availCount++;
      }
    }

    const { entries, exits } = directionFromData(data, selectedIds, { from: b.from, to: b.to });

    return {
      label: b.label,
      operations: ops,
      entries,
      exits,
      errors: errs,
      maintenanceHours: Math.round(maint * 100) / 100,
      availability: availCount ? Math.round((availSum / availCount) * 100) / 100 : 0,
      failureRate: ops > 0 ? Math.round((errs / ops) * 10000) / 100 : 0,
    };
  });

  // --- מפת חום (שורה לאתר, תא לדלי) — גם היא מהזיכרון ---
  const heatRows = rows.map((r) => {
    const id = idOf.get(r.code);
    return {
      siteCode: r.code,
      siteName: r.name,
      values: buckets.map((b) => statsFromData(data, id, { from: b.from, to: b.to }).operations),
    };
  });
  const heatmap = {
    labels: buckets.map((b) => b.label),
    rows: heatRows,
    max: Math.max(0, ...heatRows.flatMap((r) => r.values)),
  };

  // --- פילוח (groupBy) ---
  let groups;
  if (groupBy === "status") {
    const byStatus = new Map();
    for (const r of rows) {
      const g = byStatus.get(r.status) || {
        key: r.status, label: r.status,
        sites: 0, operations: 0, errors: 0,
        maintenanceHours: 0, availSum: 0, availCount: 0,
      };
      g.sites++;
      g.operations += r.operations;
      g.errors += r.errors;
      g.maintenanceHours += r.maintenanceHours || 0;
      if (r.hasUptimeData) { g.availSum += r.availability; g.availCount++; }
      byStatus.set(r.status, g);
    }
    groups = [...byStatus.values()].map((g) => ({
      key: g.key,
      label: g.label,
      sites: g.sites,
      operations: g.operations,
      errors: g.errors,
      maintenanceHours: Math.round(g.maintenanceHours * 100) / 100,
      availability: g.availCount ? Math.round((g.availSum / g.availCount) * 100) / 100 : 0,
      failureRate: g.operations > 0 ? Math.round((g.errors / g.operations) * 10000) / 100 : 0,
    }));
  } else if (groupBy === "time") {
    groups = chart.map((c) => ({
      key: c.label, label: c.label,
      sites: rows.length,
      operations: c.operations,
      errors: c.errors,
      maintenanceHours: c.maintenanceHours,
      availability: c.availability,
      failureRate: c.failureRate,
    }));
  } else {
    groups = rows.map((r) => ({
      key: r.code,
      label: r.name,
      sites: 1,
      operations: r.operations,
      errors: r.errors,
      maintenanceHours: r.maintenanceHours || 0,
      availability: r.hasUptimeData ? r.availability : 0,
      failureRate: r.failureRate,
    }));
  }

  // --- שורות גולמיות לייצוא CSV ---
  //
  // "מצב נוכחי" ולא "מצב": כל שאר העמודות מתארות את *התקופה* (פעולות, תקלות,
  // זמינות), אבל הסטטוס הוא צילום רגע — המצב של האתר כרגע, לא בתקופה. בשם
  // "מצב" הוא נקרא כאילו הוא נתון של התקופה, וזה מטעה.
  // בדוח המודפס הוא לא מופיע כלל (ראה ReportView) — שם זה מסמך על תקופה.
  const rawRows = rows.map((r) => ({
    "קוד אתר": r.code,
    "שם האתר": r.name,
    "מצב נוכחי": r.status,
    "פעולות": r.operations,
    "תקלות": r.errors,
    "אחוז כשל": r.failureRate,
    "זמינות": r.hasUptimeData ? r.availability : "",
    "שעות תחזוקה": r.maintenanceHours || 0,
    "שעות השבתה": r.downtimeHours || 0,
    "מונה מחזורים": r.cycleTotal,
    "פעולות מאז התקלה": r.operationsSinceLastError,
  }));

  return {
    kpis,
    sitesByStatus,
    topPerformers: getTopPerformers(rows),
    worstPerformers: getWorstPerformers(rows),
    chart,
    heatmap,
    groups,
    rawRows,
    filteredSitesCount: rows.length,
    totalSitesInSystem,
    // רשימת כל האתרים במערכת — כדי שה-UI יוכל לבנות את בורר האתרים
    allSites: allRows.map((r) => ({ code: r.code, name: r.name, status: r.status })),
  };
}


// ==========================================================
// חישוב טהור של סדרת הגרף — לוגיקת הדליים במקום אחד
// ==========================================================
// מקבל שלוש רשימות של חותמות-זמן (ISO): פעולות, כניסות ל-error, כניסות
// ל-maintenance — כבר מסוננות לטווח. מופרד מ-getPeriodBreakdown כדי ש*גם*
// המסלול ששולף מה-DB *וגם* המסלול שמחשב מנתונים שכבר נטענו (getSiteAnalyticsData)
// יפיקו בדיוק אותה סדרה. שינוי כאן משנה את שניהם — אין שתי הגדרות.
export function buildPeriodSeries(opsIso, errIso, maintIso, { from, to, granularity }, maintSegments = []) {
  const byMonth = granularity === "month";

  // מפתח הדלי נגזר בשעון ה*מקומי*, לא מקידומת ה-ISO (שהיא UTC). גבולות התקופה
  // קלנדריים-מקומיים, וקיבוץ לפי UTC היה משייך פעולות סמוכות-לחצות לדלי הלא נכון.
  const keyOfDate = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    if (byMonth) return `${y}-${m}`;
    return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const tally = (isoList) => {
    const map = new Map();
    for (const iso of isoList) {
      const k = keyOfDate(new Date(iso));
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  };

  const ops = tally(opsIso);
  const errs = tally(errIso);
  const maints = tally(maintIso);

  // מקטעי תחזוקה (start/end במילישניות) — כדי לסמן ימים שהאתר היה *בתוך*
  // תחזוקה, גם כשלא הייתה כניסה חדשה באותו יום (תחזוקה שנמשכה מיום קודם).
  // כך יום שכולו תחזוקה לא נראה "ריק" אלא מסומן כתחזוקה.
  const maintSegs = maintSegments.map((s) => ({
    start: Date.parse(s.started_at),
    end: s.ended_at ? Date.parse(s.ended_at) : Infinity,
  }));

  // סדרה רציפה: דלי לכל יום/חודש מ-from ועד to *כולל*.
  // הלולאה נעצרת לפי מפתח הדלי של to, ולא לפי הזמן — תנאי כמו `cursor < to`
  // היה מפיל את הדלי של היום הנוכחי (שעדיין לא הסתיים), ואיתו כל הפעולות
  // והתקלות שקרו היום. דלי ריק מקבל 0, כדי שהגרף לא "יקפוץ".
  const points = [];
  const lastKey = keyOfDate(new Date(to));
  const cursor = new Date(from);

  // עיגון לתחילת היום/החודש, כדי שהמפתחות ייפלו על גבולות קלנדריים
  if (byMonth) cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);

  const MAX_POINTS = byMonth ? 24 : 400;   // בלם בטיחות מפני לולאה אינסופית

  while (points.length < MAX_POINTS) {
    const key = keyOfDate(cursor);
    const bucketStart = cursor.getTime();
    const nextCursor = new Date(cursor);
    if (byMonth) nextCursor.setMonth(nextCursor.getMonth() + 1);
    else nextCursor.setDate(nextCursor.getDate() + 1);
    const bucketEnd = nextCursor.getTime();

    // כמה מהדלי האתר היה בתחזוקה — חיתוך כל מקטע לגבולות הדלי. משמש לעמודת
    // התחזוקה בגרף: יום שכולו תחזוקה = עמודה מלאה, גם בלי כניסה חדשה באותו יום.
    let maintMs = 0;
    for (const s of maintSegs) {
      const os = Math.max(s.start, bucketStart);
      const oe = Math.min(s.end, bucketEnd);
      if (oe > os) maintMs += oe - os;
    }

    points.push({
      label: byMonth
        ? cursor.toLocaleDateString("he-IL", { month: "short" })
        : `${cursor.getDate()}.${cursor.getMonth() + 1}`,
      operations: ops.get(key) || 0,
      errors: errs.get(key) || 0,
      maintenance: maints.get(key) || 0,
      maintenanceActive: maintMs > 0,
      maintenanceHours: Math.round((maintMs / 3600000) * 10) / 10,
      // חלק הדלי שהיה בתחזוקה (0..1) — גובה עמודת התחזוקה בגרף.
      maintenanceFraction: Math.round((maintMs / (bucketEnd - bucketStart)) * 100) / 100,
    });

    if (key === lastKey) break;
    cursor.setTime(bucketEnd);
  }

  return points;
}

/**
 * אנליטיקת אתר בודד — טהור לחלוטין.
 *
 * הקלט הוא בדיוק מה ש-loadRangeData מחזיר: הנתונים הגולמיים על **טווח-העל**
 * שמכיל את שתי התקופות (הנוכחית והקודמת). לכן שתיהן מחושבות ממנו בלי שליפה
 * נוספת, וההשוואה ביניהן מובטחת להיות על אותם נתונים.
 */
export function computeAnalytics(data, siteId, { range, prev, granularity }) {

  // סדרת הגרף — התקופה הנוכחית בלבד, מאותם נתונים שכבר נטענו.
  // אותם מסננים בדיוק כמו השאילתות של getPeriodBreakdown.
  const inRange = (t) => t >= range.from && t < range.to;
  const segs = segmentsOf(data, siteId);
  // ⚠️ excluded_at — אותו דילוג כמו ב-statsFromData. בלעדיו גרף המגמה
  // מצייר עמודה על פעולה שהמדד לצידו כבר לא סופר.
  const opsIso = (data.ops.get(siteId) || [])
    .filter((o) => !o.excluded_at
      && o.is_anomaly === 0 && !o.superseded_by && o.start_end === "end" && inRange(o.occurred_at))
    .map((o) => o.occurred_at);
  // תקלות בזמן תחזוקה מוחרגות גם מגרף המגמה — "תחזוקה גוברת". כך הגרף עקבי
  // עם stats.errors (שגם הוא מחריג דרך wasInMaintenanceMem) ולא מציג תקלה
  // שאיננה נספרת. מהיום ה-ingestion ממילא לא רושם תקלות כאלה; זו הגנה על היסטוריה.
  // אותו קיפול ריצוד כמו ב-statsFromData — אחרת הגרף היה מציג 107 תקלות
  // בזמן שהמדד לצידו מציג אחת, ושני המספרים היו סותרים זה את זה.
  // ⚠️ מקטע שסומן כניסוי מוסר **לפני** הקיפול: הוא לא קרה, ולכן הוא גם
  // אינו מפריד בין שני מקטעים שכן קרו. uptimeFromData כבר מתעלם ממנו,
  // והגרף המשיך לצייר עליו עמודת תקלה.
  const counted = collapseNoCommFlicker(segs.filter((x) => !x.excluded_at));
  const errIso = counted
    .filter((s) => s.status === "error" && inRange(s.started_at)
      && !wasInMaintenanceMem(data, siteId, s.started_at))
    .map((s) => s.started_at);
  const maintIso = counted
    .filter((s) => s.status === "maintenance" && inRange(s.started_at))
    .map((s) => s.started_at);
  // *מקטעי* התחזוקה (לא רק כניסות) — כדי לסמן בגרף ימים שהאתר היה בתחזוקה
  // מתמשכת, גם בלי כניסה חדשה באותו יום.
  const maintSegments = segs.filter((s) => s.status === "maintenance");

  return {
    stats: statsFromData(data, siteId, range),
    uptime: uptimeFromData(data, siteId, range),
    prevStats: statsFromData(data, siteId, prev),
    prevUptime: uptimeFromData(data, siteId, prev),
    chart: buildPeriodSeries(opsIso, errIso, maintIso, {
      from: range.from, to: range.to, granularity,
    }, maintSegments),
  };
}
