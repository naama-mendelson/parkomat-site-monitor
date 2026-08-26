const db = require("./db");

async function findSiteByCode(code) {
  return await db.prepare("SELECT * FROM sites WHERE code = ?").get(code);
}

async function insertSite(code, siteName, meta = {}, isNewSite = 1) {
  const now = new Date().toISOString();
  const { plcType = null, tier = "basic" } = meta;
  return await db
    .prepare(
      `INSERT INTO sites (code, site_name, registered_at, plc_type, is_new_site, tier)
       -- ⚠️ שישה placeholders לשש עמודות. הגרסה הקודמת סיפקה שמונה,
       -- ו-Postgres החזיר "INSERT has more expressions than target
       -- columns" — כלומר POST /api/sites נכשל ב-500 **תמיד**. זה לא
       -- נתפס כי אף שער לא רשם אתר; 14 האתרים נוספו דרך add-test-site.
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(code, siteName, now, plcType, isNewSite ? 1 : 0, tier);
}

// שלושה זמנים, ולכל אחד תפקיד אחר — אל תמזגו אותם:
//   occurred_at — זמן ה"אמת" של השרת. מיושר אם שעון האתר הקדים. ממנו נגזרים
//                 סדר, זמינות, דליים וסטטיסטיקה.
//   reported_at — מה שהסוכן אמר, בדיוק. **מפתח ה-dedup** (אינדקס ux_operations_dedup),
//                 ולכן חייב להישאר מקורי: הוא מה שמזהה מסירה חוזרת של QoS-1.
//   received_at — מתי השרת קלט בפועל. לאבחון בלבד.
// ==========================================================
// כרטיס שאבד בין ה-start ל-end — מושלם מהפתיחה
// ==========================================================
// בחלק מהבקרים רגיסטר הכרטיס מתאפס לפני שה-MODE יוצא ממצב הפעולה, וזה קורה
// ביציאה. הסוכן אמור לשאת את הכרטיס לאורך הפעולה (OperationDetector.
// _operationCard), אבל אתרים שטרם עודכנו מריצים גרסה שאין בה את זה.
//
// נמדד: exit/start נושא כרטיס ב-**100%** מהמקרים, ואילו exit/end רק ב-67%.
// בשלושה אתרים (1399, 3501, 1343) האובדן שיטתי — 0%, 7.5% ו-8.5%. כלומר
// המידע קיים תמיד, הוא פשוט על השורה השנייה.
//
// ⚠️ זה נעשה בשרת ולא רק בסוכן, בכוונה: השרת אינו יכול לכפות עדכון גרסה על
// אתר בשטח, וכרטיס חסר הוא אובדן מידע שאין ממנו חזרה. זו אותה הכרעה כמו
// בשאר שכבת הקליטה — מתקנים במקום שרואה את כל האתרים.
//
// שלוש הגנות מפני שיוך שגוי:
//   1. חלון זמן — פעולה נמשכת דקות, ולכן start ישן מכדי להיות שייך נפסל.
//   2. **ה-start חייב להיות פתוח**: אם כבר נסגר ב-end אחר בין לבין, הוא
//      שייך לרכב אחר. בלי הבדיקה הזו כרטיס היה נדבק ליציאה הבאה.
//   3. רק לכיוון הזהה (entry/exit) ולאותו אתר.
const CARD_INHERIT_WINDOW_MS = 2 * 3600 * 1000;   // שעתיים — נדיב מאוד לפעולה

async function inheritCardFromStart(siteId, entryExit, occurredAt) {
  const since = new Date(Date.parse(occurredAt) - CARD_INHERIT_WINDOW_MS).toISOString();

  const start = await db.prepare(
    `SELECT card_number, occurred_at FROM operations
      WHERE site_id = ? AND entry_exit = ? AND start_end = 'start'
        AND card_number <> ''
        AND occurred_at <= ? AND occurred_at >= ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`
  ).get(siteId, entryExit, occurredAt, since);

  if (!start) return "";

  // האם ה-start כבר נסגר? end אחר שנמצא *בין* הפתיחה לבינינו פירושו שהפעולה
  // ההיא הסתיימה, והכרטיס שלה אינו שייך לנו.
  const closed = await db.prepare(
    `SELECT 1 FROM operations
      WHERE site_id = ? AND entry_exit = ? AND start_end = 'end'
        AND occurred_at > ? AND occurred_at < ?
      LIMIT 1`
  ).get(siteId, entryExit, start.occurred_at, occurredAt);

  return closed ? "" : start.card_number;
}

// ============================================================
// ניסיון חוזר מאחד את הניסיון שנקטע
// ============================================================
// רכב מתחיל כניסה, קורית תקלה תוך כדי, המצב חוזר ל'מוכן', ואותו כרטיס מנסה
// שוב. זה **מעבר פיזי אחד**, ועד עכשיו הוא נספר כשתי פעולות חניה.
//
// הפתיחה החדשה מצביעה אחורה על הסגירה שנקטעה: superseded_by = id של הפתיחה.
// כל מדד מוסיף `superseded_by IS NULL`, והשורה עצמה נשארת — היא זו שבגללה
// קרתה התקלה, ובלעדיה מאבדים את מי שהיה בפנים.
//
// ⚠️ שלוש הגנות, זהות לאלה שב-tools/merge-retries.js. איחוד שגוי גרוע
// מאי-איחוד, כי הוא מעלים פעולה אמיתית מהספירה **בשקט**:
//   1. הפעולה נקטעה בתקלה — end.occurred_at == error.started_at בדיוק.
//      מעבר MODE אחד מייצר את שתי ההודעות באותו סבב ועם אותו חותם.
//   2. אותו אתר, אותו כרטיס, אותו כיוון. נהג אחר אינו ניסיון חוזר.
//   3. חלון של 30 דקות. נמדד: 5 תוך 10 דקות, 9 תוך 30, 10 תוך שעה — ואז
//      שטוח עד 4 שעות. חלון פתוח היה מחבר כניסה של הבוקר לזו של הצהריים.
const RETRY_MERGE_WINDOW_MS = 30 * 60 * 1000;

// ============================================================
// ריצוד MODE — פעולה שנקטעה ומיד נפתחה מחדש
// ============================================================
// הסוכן מזהה פעולה לפי **שינוי** ב-MODE. כשהרגיסטר יוצא ממצב הפעולה וחוזר
// אליו תוך שניות, הוא סוגר פעולה ופותח חדשה — **מעבר פיזי אחד נרשם כשתיים.**
//
// ⚠️ וההטיה אינה סימטרית, וזה מה שהופך אותה לבאג ולא לרעש. נמדד על כל
// הנתונים: בחלון של 5 שניות — 15 יציאות מול 5 כניסות. הריצוד מנפח את
// היציאות פי שלושה, ומכאן התפוסה השלילית וכרטיס עם 10 יציאות מול 7 כניסות.
//
// ⚠️ **15 שניות ולא יותר, וזה נמדד.** בטווח 15–60 שניות ההטיה **מתהפכת**
// (17 כניסות מול 10 יציאות) — כלומר שם כבר מדובר בפעולות אמיתיות שחוזרות,
// וחלון רחב יותר היה מוחק אותן.
const FLICKER_MERGE_WINDOW_MS = 15 * 1000;

/**
 * @returns id של הפעולה שאוחדה, או null אם לא נמצאה התאמה.
 */
async function supersedeInterruptedAttempt(siteId, entryExit, cardNumber, occurredAt, retryId) {
  const since = new Date(Date.parse(occurredAt) - RETRY_MERGE_WINDOW_MS).toISOString();

  const cut = await db.prepare(
    `SELECT o.id FROM operations o
      JOIN status_history h
        ON h.site_id = o.site_id AND h.started_at = o.occurred_at AND COALESCE(h.reclassified_to, h.status) = 'error'
     WHERE o.site_id = ? AND o.entry_exit = ? AND o.card_number = ?
       AND o.start_end = 'end' AND o.is_anomaly = 0
       AND o.superseded_by IS NULL
       AND o.occurred_at < ? AND o.occurred_at >= ?
     ORDER BY o.occurred_at DESC, o.id DESC
     LIMIT 1`
  ).get(siteId, entryExit, cardNumber, occurredAt, since);

  if (!cut) return null;

  await db.prepare(
    // התנאי חוזר גם ב-UPDATE — הגנה מפני מרוץ מול הכלי שרץ במקביל.
    "UPDATE operations SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL"
  ).run(retryId, cut.id);

  return cut.id;
}

/**
 * פעולה שנקטעה בריצוד MODE ומיד נפתחה מחדש — מאחדים אותן.
 *
 * ⚠️ **בלי תנאי על הכרטיס**, ובכוונה: הריצוד קורה באמצע מעבר אחד, ובחלק
 * מהמקרים הרגיסטר טרם נקרא ולכן אחד הצדדים ריק (נמדד: אתר 3501, כניסה בלי
 * כרטיס). תנאי על שוויון כרטיסים היה מפספס בדיוק את המקרים האלה.
 *
 * החלון הקצר (15 שניות) הוא מה שמחליף את הבדיקה הזו: אין תרחיש שבו שני
 * רכבים שונים עוברים באותו כיוון בהפרש של שניות.
 *
 * @returns id של הפעולה שאוחדה, או null.
 */
async function supersedeFlicker(siteId, entryExit, occurredAt, resumeId) {
  const since = new Date(Date.parse(occurredAt) - FLICKER_MERGE_WINDOW_MS).toISOString();

  const cut = await db.prepare(
    `SELECT id FROM operations
      WHERE site_id = ? AND entry_exit = ? AND start_end = 'end'
        AND is_anomaly = 0 AND superseded_by IS NULL
        AND occurred_at < ? AND occurred_at >= ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`
  ).get(siteId, entryExit, occurredAt, since);

  if (!cut) return null;

  await db.prepare(
    "UPDATE operations SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL"
  ).run(resumeId, cut.id);

  return cut.id;
}

async function insertOperation(siteId, startEnd, entryExit, cardNumber, state, isAnomaly,
                               occurredAt, receivedAt, reportedAt = null,
                               cycleCounter = null) {
  try {
    const result = await db
      .prepare(
        // RETURNING id: הקליטה צריכה את המזהה כדי שפתיחה חדשה תוכל להצביע
        // אחורה על הניסיון שנקטע (supersedeInterruptedAttempt).
        // cycle_counter — המונה הגולמי מהבקר. נשמר לכל פעולה כדי שאפשר יהיה
        // לחשב כמה מחזורים המכונה עשתה **בתקופה** ולא רק בסך הכל.
        `INSERT INTO operations (site_id, start_end, entry_exit, card_number, state, is_anomaly, occurred_at, received_at, reported_at, cycle_counter)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .get(siteId, startEnd, entryExit, cardNumber, state, isAnomaly,
           occurredAt, receivedAt, reportedAt ?? occurredAt,
           Number.isInteger(cycleCounter) ? cycleCounter : null);
    return { inserted: true, id: result?.id ?? null, result };
  } catch (err) {
    // 23505 = unique_violation ב-Postgres (היה SQLITE_CONSTRAINT_UNIQUE)
    if (err.code === "23505") {
      return { inserted: false, duplicate: true };
    }
    throw err;
  }
}

// עדכן מונה סייקלים מצטבר (מטפל ב-first, delta, reset, ו-Backfill לפי זמן).
//
// כמו applyStateChange — זו סדרת read-modify-write, ולכן היא רצה בטרנזקציה עם
// נעילת שורת האתר (FOR UPDATE). בלי הנעילה, שתי הודעות end באותה שנייה (או שני
// שרתים) קוראות את אותו plc_cycle_last, שתיהן מחשבות delta, ואחד העדכונים
// ל-cycle_total אובד או נספר פעמיים — מונה הבלאי מתקלקל. הנעילה מסדרת אותן
// בזה אחר זה *ברמת ה-DB*, בעקביות עם ההקשחה של applyStateChange.
// ההחלטה עצמה חיה ב-db/cycle-rules.js — טהורה ונבדקת בנפרד. כאן רק מבצעים אותה
// בתוך טרנזקציה עם נעילת שורת האתר.
const { decideCycleUpdate, RESET_PLAUSIBLE_MAX } = require("./cycle-rules");

async function applyCycleCounter(siteId, current, occurredAt) {
  return db.transaction(async () => {
    const site = await db
      .prepare("SELECT cycle_total, plc_cycle_last, cycle_last_ts, is_new_site FROM sites WHERE id = ? FOR UPDATE")
      .get(siteId);

    const decision = decideCycleUpdate({
      last: site.plc_cycle_last,
      lastTs: site.cycle_last_ts,
      total: site.cycle_total,
      isNewSite: site.is_new_site,
      current,
      occurredAt,
    });

    if (!decision.write) {
      return {
        mode: decision.mode,
        total: decision.total,
        last: site.plc_cycle_last,
        current,
        ignored: true,
      };
    }

    await db.prepare("UPDATE sites SET cycle_total = ?, plc_cycle_last = ?, cycle_last_ts = ? WHERE id = ?")
      .run(decision.total, decision.nextLast, occurredAt, siteId);

    return {
      mode: decision.mode,
      total: decision.total,
      last: site.plc_cycle_last,
      current,
      ignoredAmount: decision.ignoredAmount,
    };
  });
}

// עדכון המצב הנוכחי + last_seen.
//
// last_seen מתקדם *קדימה בלבד*, בדיוק כמו ב-updateLastSeenIfNewer. קודם הוא
// נכתב ללא תנאי, ולכן הודעת state שהגיעה מאוחר (מסירה מחדש של תור MQTT אחרי
// שהשרת היה כבוי) דחפה את last_seen *אחורה* — ואתר שדיווח לפני דקה נראה
// כאילו לא נשמע 12 שעות. הסטטוס עצמו כן מתעדכן: הוא מתאר את המצב הנוכחי,
// ומי שמגן עליו מפני הודעות ישנות הוא ה-guard שב-applyStateChange.
async function updateSiteStatus(siteId, status, lastSeen) {
  return await db
    .prepare(
      `UPDATE sites
       SET status = ?,
           last_seen = CASE
             WHEN last_seen IS NULL OR last_seen < ? THEN ?
             ELSE last_seen
           END
       WHERE id = ?`
    )
    .run(status, lastSeen, lastSeen, siteId);
}

// עדכון מצב בלי לגעת ב-last_seen. משמש ל-no_comm: ההודעה הזו מגיעה מה-Broker
// (LWT) בשם האתר שהתנתק — היא מעידה שהאתר *לא* נשמע, ולכן אסור לה לרענן
// את last_seen. אחרת אתר מת נראה "נצפה זה עתה" וכלל ה-90 שניות לא יתפוס אותו.
async function updateStatusOnly(siteId, status) {
  return await db
    .prepare("UPDATE sites SET status = ? WHERE id = ?")
    .run(status, siteId);
}

async function updateLastSeen(siteId, lastSeen) {
  return await db
    .prepare("UPDATE sites SET last_seen = ? WHERE id = ?")
    .run(lastSeen, siteId);
}

// עדכון last_seen רק אם הזמן החדש מאוחר מהקיים. מונע החזרת last_seen אחורה
// כשהודעה ישנה מגיעה מאוחר (backfill / redelivery של QoS 1).
async function updateLastSeenIfNewer(siteId, lastSeen) {
  return await db
    .prepare("UPDATE sites SET last_seen = ? WHERE id = ? AND (last_seen IS NULL OR last_seen < ?)")
    .run(lastSeen, siteId, lastSeen);
}

// זמן ההתחלה של המצב הנוכחי (השורה הפתוחה ב-status_history), או null אם אין.
// משמש כ-guard: הודעה שקרתה *לפני* תחילת המצב הנוכחי היא מאוחרת, ואסור לה
// לשכתב את הסטטוס (מקביל לזיהוי ה-backfill ב-applyCycleCounter).
async function getOpenStatusStartedAt(siteId) {
  const row = await db
    .prepare("SELECT started_at FROM status_history WHERE site_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
    .get(siteId);
  return row ? row.started_at : null;
}

async function closeOpenStatus(siteId, endedAt) {
  return await db
    .prepare("UPDATE status_history SET ended_at = ? WHERE site_id = ? AND ended_at IS NULL")
    .run(endedAt, siteId);
}

// faultText — תיאור התקלה מהבקר. null כשאין: מצב שאינו תקלה, סוכן ישן,
// או בקר בלי התכונה.
//
// ⚠️ null ו-'' אינם אותו דבר, ואסור למזג אותם: null = **לא נקרא**,
// '' = נקרא והיה ריק. הראשון אומר "אין לנו מידע", השני אומר "הבקר לא
// אמר כלום" — ובמסך הם צריכים להיראות אחרת.
async function insertStatusHistory(siteId, status, startedAt, faultText = null) {
  return await db
    .prepare(
      "INSERT INTO status_history (site_id, status, started_at, fault_text) VALUES (?, ?, ?, ?)"
    )
    .run(siteId, status, startedAt, faultText);
}

// טרנזקציה: שינוי מצב (סגירת קודם + פתיחת חדש + עדכון) כיחידה אחת.
// שלוש הפעולות חייבות להצליח או להיכשל ביחד — אחרת נשארת שורה פתוחה בלי
// סוגרת, או סטטוס שלא תואם להיסטוריה.
//
// שלוש הפונקציות הפנימיות ממשיכות לקרוא ל-db הגלובלי כרגיל; db.transaction
// מנתב אותן לאותו client דרך AsyncLocalStorage (ראה db.js). לכן החתימות
// שלהן לא השתנו.
// ============================================================
// ⚠️ תיאור שהגיע באיחור — ממלא, ולא נזרק
// ============================================================
// הבקר מחזיק את ה-MODE בכתובת 290 ואת טקסט התקלה בכתובת 2, והוא אינו
// כותב אותם באותו רגע. הסוכן מחכה לטקסט **שנייה אחת** (10 דגימות) ואז
// משדר בלעדיו — כי דיווח על תקלה חשוב יותר מהתיאור שלה.
//
// ⚠️ נמדד על מטענים גולמיים: חלק מהודעות ה-error מגיעות עם faultText
// וחלק **בלי השדה כלל**. כלומר התיאור לא נדחה בשרת (0 שורות
// fault_text_unreadable) — הוא פשוט לא נשלח, כי הבקר טרם כתב אותו.
//
// עד כה הודעה שנייה עם אותו מצב נבלעה כ"אין שינוי", ולכן התיאור
// שהגיע רגע אחר כך לא היה לו לאן להיכנס. כאן הוא נכנס — **רק** לתוך
// מקטע פתוח שאין לו תיאור, וכך תיאור נכון לעולם אינו נדרס.
//
// ⚠️ ההבחנה בין NULL ל-'' נשמרת: '' פירושו "נקרא והיה ריק" וזו תשובה,
// ואילו NULL פירושו "לא נקרא". רק NULL ממולא.
async function fillFaultTextIfMissing(siteId, faultText) {
  if (typeof faultText !== "string" || faultText === "") return { changes: 0 };
  return await db
    .prepare(
      `UPDATE status_history SET fault_text = ?
        WHERE site_id = ? AND ended_at IS NULL
          AND COALESCE(reclassified_to, status) = 'error'
          AND fault_text IS NULL`
    )
    .run(faultText, siteId);
}

async function applyStateChange(siteId, newStatus, occurredAt, faultText = null) {
  return db.transaction(async () => {
    // ============================================================
    // נעילת שורת האתר — זה מה שהיה חסר, וזה שיבש נתונים אמיתיים
    // ============================================================
    // ההגנות בקוד (בדיקת backfill, השוואת סטטוס) *קוראות ואז כותבות*. עם
    // SQLite זה היה בטוח כי העיבוד היה סינכרוני — הודעה הסתיימה לפני הבאה.
    // עם Postgres שתי הודעות מעובדות במקביל, שתיהן קוראות את אותו מצב,
    // שתיהן עוברות את ההגנה, ושתיהן כותבות.
    //
    // התוצאה בשטח (אתר 1234): שורות 'operating' כפולות באותה שנייה, ארבעה
    // מקטעים פתוחים בו-זמנית, ושורה עם ended_at מוקדם מ-started_at — משך
    // שלילי, שמרעיל את חישוב הזמינות.
    //
    // FOR UPDATE נועל את שורת האתר עד סוף הטרנזקציה, וכך שינויי מצב של אותו
    // אתר מסתדרים בזה אחר זה *ברמת ה-DB* — לא רק בתוך התהליך. זה מחזיק גם
    // אם ירוצו שני שרתים במקביל.
    await db.prepare("SELECT id FROM sites WHERE id = ? FOR UPDATE").get(siteId);

    // עכשיו, אחרי הנעילה, המצב שנקרא הוא אמיתי ולא יכול להשתנות תחתינו.
    const open = await db.prepare(
      `SELECT status, started_at FROM status_history
       WHERE site_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
    ).get(siteId);

    if (open) {
      // הודעה שקדמה למצב הפתוח הגיעה מאוחר — היא לא רשאית לשכתב אותו.
      // (אותה הגנה קיימת ב-state-handler; כאן היא אטומית.)
      if (occurredAt < open.started_at) {
        return { skipped: "backfill" };
      }
      // המצב כבר פתוח — אין מה לשנות. זה מה שמנע את השורות הכפולות:
      // הודעת state=operating והודעת operation/start נושאות את אותו מצב
      // ואת אותו חותם זמן, ובלי הבדיקה הזו שתיהן פתחו מקטע.
      if (open.status === newStatus) {
        return { skipped: "no_change" };
      }
    }

    await closeOpenStatus(siteId, occurredAt);
    await insertStatusHistory(siteId, newStatus, occurredAt, faultText);

    // ניתוק אינו "צפייה" — ראה updateStatusOnly.
    if (newStatus === "no_comm") {
      await updateStatusOnly(siteId, newStatus);
    } else {
      await updateSiteStatus(siteId, newStatus, occurredAt);
    }

    return { applied: true };
  });
}

async function getAllSites() {
  return await db.prepare("SELECT * FROM sites ORDER BY code").all();
}


// מתי המצב הנוכחי התחיל — started_at של השורה הפתוחה (ended_at IS NULL) ב-status_history
async function getCurrentStatusSince(siteId) {
  const row = await db.prepare(
    "SELECT started_at FROM status_history WHERE site_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
  ).get(siteId);
  return row ? row.started_at : null;
}

// היסטוריית המצבים האחרונה (לוג שינויי מצב) — מהחדש לישן.
// מסננים החוצה 'operating' *בתצוגה בלבד*: פעולת חניה שולחת גם state=operating וגם
// operation, ולוג מלא ב"בפעולה" הוא רעש. הבקר רוצה לראות רק אירועים משמעותיים
// (תקלה, תחזוקה, נתק, מוכן). ה-DB עדיין רושם את כל המצבים כולל operating —
// הסינון כאן לא משפיע על status_history, על operating_hours, על sites.status,
// או על חישובי זמינות/אחוז-כשל (אלה שולפים מ-status_history ישירות).
//
// הסינון מותנה: 'בפעולה' שאין לו פעולה תואמת **כן** מוצג. ראה ההסבר בגוף
// הפונקציה — הסינון הגורף הסתיר תקלה אמיתית.
async function getStatusHistory(siteId, limit = 10) {
  // שולפים יותר מ-limit, כי חלק מהשורות (תקלות בזמן תחזוקה) יסוננו החוצה.
  //
  // ⚠️ 'בפעולה' מסונן — אבל **רק כשיש פעולה שמסבירה אותו**. הסינון הגורף
  // הקודם הסתיר גם מקטע 'בפעולה' יתום, כלומר כזה שנוצר מ-resync של הסוכן
  // בלי שום פעולה. זה היה עיוור בדיוק לתקלה החשובה ביותר: אתר 1348 היה
  // תקוע ב'בפעולה' 11 שעות, וזה לא הופיע בפאנל המצבים כלל — לא כשורה, ולא
  // כמצב הנוכחי. אותו כלל בדיוק כמו בציר הזמן המאוחד.
  const rows = await db.prepare(
    // ⚠️ COALESCE ולא status גולמי: מקטע שסווג מחדש כתחזוקה עדיין
    // נשא status='error', ולכן הפאנל הציג אותו כתקלה בזמן שהציר,
    // הזמינות ו-site_status_history כבר קראו לו תחזוקה. אותה שורה,
    // שני שמות, לפי המסך שמסתכלים בו.
    `SELECT COALESCE(h.reclassified_to, h.status) AS status,
            h.started_at, h.ended_at
       FROM status_history h
      WHERE h.site_id = ?
        AND (COALESCE(h.reclassified_to, h.status) <> 'operating'
             OR ${noPairedStartSql("h")})
      ORDER BY h.started_at DESC LIMIT ?`
  ).all(siteId, Math.max(limit * 4, 40));

  if (rows.length === 0) return rows;

  // "תחזוקה גוברת" — תקלה שקרתה בזמן/בגבול תחזוקה לא מוצגת בלוג (כמו שהיא לא
  // נספרת). מזהים תחזוקה משני מקורות: מקטעי maintenance מהבקר (כבר בשליפה)
  // וחלונות תחזוקה ידניים חופפים. אותו גבול כולל כמו wasInMaintenanceMem.
  // (מהיום ה-ingestion ממילא זורק תקלות כאלה; זו הגנה על היסטוריה שכבר נרשמה.)
  const maintSegs = rows.filter((r) => r.status === "maintenance");
  const oldest = rows[rows.length - 1].started_at;
  const windows = await db
    .prepare(
      `SELECT started_at, expires_at, cancelled_at, excluded_at FROM maintenance_windows
       WHERE site_id = ? AND COALESCE(cancelled_at, expires_at) >= ?`
    )
    .all(siteId, oldest);

  const inMaintenance = (ts) => {
    for (const s of maintSegs) {
      if (s.started_at <= ts && (s.ended_at === null || s.ended_at >= ts)) return true;
    }
    for (const w of windows) {
      const end = w.cancelled_at || w.expires_at;
      if (w.started_at <= ts && end >= ts) return true;
    }
    return false;
  };

  return rows
    .filter((r) => !(r.status === "error" && inMaintenance(r.started_at)))
    .slice(0, limit);
}

// היסטוריית חלונות תחזוקה ידנית (מי הפעיל, משך, מתי) — מהחדש לישן.
// תחזוקה ידנית לא נרשמת ב-status_history, ולכן נשלפת בנפרד ללוג המצבים.
async function getMaintenanceHistory(siteId, limit = 10) {
  return await db.prepare(
    `SELECT set_by_name, reason, started_at, duration_hours, expires_at, cancelled_at
     FROM maintenance_windows WHERE site_id = ? ORDER BY started_at DESC LIMIT ?`
  ).all(siteId, limit);
}

async function getRecentOperations(siteId, limit = 10) {
  return await db
    .prepare("SELECT * FROM operations WHERE site_id = ? ORDER BY occurred_at DESC LIMIT ?")
    .all(siteId, limit);
}

async function getFilteredOperations({ siteCode, from, to, limit = 100 } = {}) {
  let sql = `
    SELECT o.*, s.code, s.site_name
    FROM operations o
    JOIN sites s ON o.site_id = s.id
    WHERE 1=1
  `;
  const params = [];

  if (siteCode) {
    sql += " AND s.code = ?";
    params.push(siteCode);
  }
  if (from) {
    sql += " AND o.occurred_at >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND o.occurred_at < ?";
    params.push(to);
  }

  // limit לא-מספרי (למשל ?limit=abc) היה מגיע כ-NaN ומפיל את השאילתה ב-500.
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 1000) : 100;
  sql += " ORDER BY o.occurred_at DESC LIMIT ?";
  params.push(safeLimit);

  return await db.prepare(sql).all(...params);
}

// ===== תחזוקה =====

async function startMaintenance(siteId, setByName, durationHours, reason = null, setByRole = null) {
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + durationHours * 60 * 60 * 1000);

  // RETURNING id — ב-Postgres זו הדרך היחידה לקבל את המזהה שנוצר.
  // (ב-SQLite הוא הגיע חינם ב-lastInsertRowid.)
  const result = await db
    .prepare(
      `INSERT INTO maintenance_windows (site_id, set_by_name, set_by_role, reason, started_at, duration_hours, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .run(siteId, setByName, setByRole, reason, startedAt.toISOString(), durationHours, expiresAt.toISOString());

  return {
    id: result.lastInsertRowid,
    startedAt: startedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

// ============================================================
// מצב הגשר — האות היחיד שמבדיל בין 'שקט' ל'מת'
// ============================================================
// ⚠️ עד כה '1' (מחובר) נכתב ללוג ונשכח, ולכן לא הייתה דרך לשאול
// 'האם האתר מחובר עכשיו'. מדדתי שפערי שקט תקינים מגיעים ל-40 שעות,
// אז שקט לבדו אינו עדות לכלום — אבל **גשר מחובר + שקט ארוך** הוא
// חריגה חד-משמעית: הסוכן חי ואינו מדווח.
async function recordBridgeState(siteId, connected, at) {
  return await db
    .prepare("UPDATE sites SET bridge_connected = ?, bridge_seen_at = ? WHERE id = ?")
    .run(connected ? 1 : 0, at, siteId);
}

async function getActiveMaintenance(siteId) {
  const now = new Date().toISOString();
  return await db
    .prepare(
      `SELECT * FROM maintenance_windows
       -- ⚠️ הערת SQL היא "--" ולא "//". הגרסה הקודמת כאן הפילה **כל**
       -- הודעת תקלה: syntax error at or near "//", חמישה ניסיונות, ואז
       -- ויתור — כלומר PUBACK ומחיקת ההודעה מ-HiveMQ לתמיד.
       -- גם started_at: חלון מתוזמן למחר אינו "פעיל" היום.
       WHERE site_id = ? AND cancelled_at IS NULL AND started_at <= ? AND expires_at > ?
       ORDER BY expires_at DESC LIMIT 1`
    )
    .get(siteId, now, now);
}

// ⚠️ **מי ביטל — חובה, ולא רשות.** הביטול מחזיר את האתר לספירת התקלות
// ולמכנה הזמינות, כלומר הוא משנה מספרים בדוחות בדיוק כמו ההפעלה. השם
// נשמר ב-cancelled_by, בדיוק כמו ב-RPC של הזרוע הישירה
// (db/writes.postgres.sql), כדי ששתי הזרועות ירשמו את אותו הדבר.
async function cancelMaintenance(siteId, performedBy) {
  const by = String(performedBy ?? "").trim();
  if (by.length < 2) {
    const err = new Error("חובה לציין מי מוציא מתחזוקה (שם מלא)");
    err.code = "NAME_REQUIRED";
    throw err;
  }
  const now = new Date().toISOString();
  return await db
    .prepare(
      `UPDATE maintenance_windows SET cancelled_at = ?, cancelled_by = ?
       WHERE site_id = ? AND cancelled_at IS NULL AND expires_at > ?`
    )
    .run(now, by, siteId, now);
}

// ===== סטטיסטיקה =====

// בדוק אם בזמן נתון האתר היה בתחזוקה (ידני או PLC)
async function wasInMaintenance(siteId, ts) {
  const manual = await db
    .prepare(
      `SELECT 1 FROM maintenance_windows
       WHERE site_id = ?
         AND started_at <= ?
         AND COALESCE(cancelled_at, expires_at) >= ?
       LIMIT 1`
    )
    .get(siteId, ts, ts);
  if (manual) return true;

  const plc = await db
    .prepare(
      `SELECT 1 FROM status_history
       WHERE site_id = ? AND COALESCE(reclassified_to, status) = 'maintenance'
         AND started_at <= ?
         AND (ended_at IS NULL OR ended_at >= ?)
       LIMIT 1`
    )
    .get(siteId, ts, ts);
  if (plc) return true;

  return false;
}

// אחוז הזמינות של האתר בחלון נתון: כמה מהזמן הוא *לא* היה ב-error או no_comm.
// מחזיר null כשאין מספיק היסטוריה כדי לענות (אתר שנרשם ומעולם לא דיווח).
/**
 * הזמינות של אתר בחלון [from, now] — מחזיר אחוז, או null כשאין מה למדוד.
 *
 * הפונקציה הזו הכילה *הגדרה שנייה, סותרת* של זמינות: היא ספרה תחזוקה
 * כזמן זמין, וחילקה באורך החלון כולו במקום בזמן הנמדד. אותו אתר קיבל
 * ממנה 100% ומ-getUptimeBreakdown 0%.
 *
 * עכשיו היא רק עוטפת את getUptimeBreakdown — מקור אמת אחד, הגדרה אחת.
 * null (ולא 0) כשאין זמן נמדד: "אין נתון" ו"זמינות אפס" הם שני דברים שונים.
 */
async function getSiteUptime(siteId, from, to = new Date().toISOString()) {
  const uptime = await getUptimeBreakdown(siteId, { from, to });
  return uptime.measuredHours > 0 ? uptime.availabilityPercent : null;
}

// מתי התחילה התקלה האחרונה (null אם מעולם לא הייתה)
async function getLastFaultAt(siteId) {
  return (await db
    .prepare("SELECT MAX(started_at) AS t FROM status_history WHERE site_id = ? AND COALESCE(reclassified_to, status) = 'error'")
    .get(siteId)).t;
}

// הפעולה האחרונה — מאפשרת לדשבורד להציג "רכב נכנס/יוצא" בזמן שהאתר בפעולה
async function getLastOperation(siteId) {
  return (await db
    .prepare(
      `SELECT start_end, entry_exit, occurred_at FROM operations
       WHERE site_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`
    )
    .get(siteId)) ?? null;
}

// חשב מדדים לאתר: errors (ללא אלה שבתחזוקה), operations, אחוז כשל
async function getSiteStats(siteId, { from = null, to = null } = {}) {
  let opsSql = "SELECT COUNT(*) AS n FROM operations WHERE site_id = ? AND is_anomaly = 0 AND superseded_by IS NULL AND start_end = 'end'";
  const opsParams = [siteId];
  if (from) { opsSql += " AND occurred_at >= ?"; opsParams.push(from); }
  if (to)   { opsSql += " AND occurred_at < ?"; opsParams.push(to); }

  let errSql = "SELECT started_at FROM status_history WHERE site_id = ? AND COALESCE(reclassified_to, status) = 'error'";
  const errParams = [siteId];
  if (from) { errSql += " AND started_at >= ?"; errParams.push(from); }
  if (to)   { errSql += " AND started_at < ?"; errParams.push(to); }

  // כאן היה N+1 נוסף: wasInMaintenance רץ *לכל תקלה*, ושלח שתי שאילתות בכל
  // פעם. אתר עם 50 תקלות בחודש = 100 סיבובי רשת רק כדי לסווג אותן.
  // עכשיו שולפים את חלונות התחזוקה ואת מקטעי ה-maintenance פעם אחת,
  // ומסווגים בזיכרון — בדיוק אותם תנאי גבול (ראה wasInMaintenanceMem).
  const rangeFrom = from || "";                       // בלי טווח: כל ההיסטוריה
  const rangeTo = to || "9999-12-31T23:59:59.999Z";

  // ארבע השאילתות בלתי-תלויות זו בזו — סיבוב רשת אחד במקום ארבעה בטור.
  // (היו כאן: ops בטור, errorRows בטור, ואז Promise.all על שתי האחרונות.)
  const [opsRow, errorRows, windows, maintSegs] = await Promise.all([
    db.prepare(opsSql).get(...opsParams),
    db.prepare(errSql).all(...errParams),

    db.prepare(
      `SELECT site_id, started_at, expires_at, cancelled_at
       FROM maintenance_windows
       WHERE site_id = ? AND started_at < ? AND COALESCE(cancelled_at, expires_at) >= ?`
    ).all(siteId, rangeTo, rangeFrom),

    db.prepare(
      `SELECT site_id, COALESCE(reclassified_to, status) AS status, started_at, ended_at
       FROM status_history
       WHERE site_id = ? AND COALESCE(reclassified_to, status) = 'maintenance'
         AND started_at < ? AND (ended_at IS NULL OR ended_at >= ?)`
    ).all(siteId, rangeTo, rangeFrom),
  ]);
  const operations = opsRow.n;

  const mem = {
    windows: new Map([[siteId, windows]]),
    segments: new Map([[siteId, maintSegs]]),
  };

  let errors = 0;
  let errorsInMaintenance = 0;
  for (const row of errorRows) {
    if (wasInMaintenanceMem(mem, siteId, row.started_at)) {
      errorsInMaintenance++;
    } else {
      errors++;
    }
  }

  const failureRate = operations > 0 ? (errors / operations) * 100 : 0;

  return {
    operations,
    errors,
    errorsInMaintenance,
    failureRate: Math.round(failureRate * 100) / 100,
  };
}

// ===== צבירה לסיכום חודשי =====

async function generateMonthlySummary(siteId, yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number);
  // גבולות החודש בזמן *מקומי* (של השרת), לא UTC. הסיכום הזה נשמר לצמיתות
  // ב-monthly_summary, וכל התצוגות החיות (periods.js, גרפים, heatmap) מחלקות
  // לחודשים בזמן מקומי. אילו חושב כאן ב-UTC, פעולה ב-1 בחודש 00:30 (מקומי)
  // הייתה נספרת בחודש הקודם בארכיון אך בחודש הנוכחי בתצוגה החיה — ואחרי
  // ש-cleanup-old-data מוחק את השורות הגולמיות, אי-ההתאמה נשארת לתמיד.
  const monthStart = new Date(year, month - 1, 1).toISOString();
  const monthEnd = new Date(year, month, 1).toISOString();

  // --- פעולות ואנומליות ---
  const ops = await db.prepare(
    `SELECT
       SUM(CASE WHEN is_anomaly = 0 AND superseded_by IS NULL THEN 1 ELSE 0 END) AS operations,
       SUM(CASE WHEN is_anomaly = 1 THEN 1 ELSE 0 END) AS anomalies
     FROM operations
     WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ? AND start_end = 'end'`
  ).get(siteId, monthStart, monthEnd);

  const operations = ops.operations || 0;
  const anomalies = ops.anomalies || 0;

  // --- תקלות (כולל החרגת תחזוקה) ---
  const stats = await getSiteStats(siteId, { from: monthStart, to: monthEnd });

  // ==========================================================
  // --- שעות בכל מצב (חתוך לגבולות החודש, בשני הקצוות) ---
  // ==========================================================
  // כאן היה באג חמור. השאילתה סיננה `started_at >= monthStart`, כלומר
  // *כל מקטע שהתחיל לפני החודש ונמשך לתוכו נעלם לגמרי*. ההערה טענה
  // "חתוך לגבולות החודש", אבל היא חתכה רק את הסוף.
  //
  // אתר שנפל ב-28 בינואר ונשאר מושבת עד 10 בפברואר קיבל **0 שעות תקלה
  // בפברואר** במקום 216. אתר יציב שיושב במקטע 'ready' אחד שלושה חודשים
  // קיבל 0 שעות מוכן בחודש האמצעי.
  //
  // ולמה זה היה קריטי ולא רק לא-מדויק: cleanup-old-data מוחק את הנתונים
  // הגולמיים אחרי שנה ומשאיר את הסיכום כמקור היחיד. **השגיאה הייתה הופכת
  // בלתי הפיכה.**
  //
  // עכשיו: אותו תנאי חפיפה בדיוק שבו משתמש getUptimeBreakdown — כל מקטע
  // שחופף לחודש, עם חיתוך *בשני* הקצוות.
  const monthStartTime = new Date(monthStart).getTime();
  const monthEndTime = new Date(monthEnd).getTime();

  const statusRows = await db.prepare(
    `SELECT status, started_at, ended_at
     FROM status_history
     WHERE site_id = ?
       AND started_at < ?
       AND (ended_at IS NULL OR ended_at > ?)`
  ).all(siteId, monthEnd, monthStart);

  const hours = { ready: 0, operating: 0, error: 0, maintenance: 0, no_comm: 0 };
  for (const row of statusRows) {
    if (hours[row.status] === undefined) continue;

    // חיתוך לשני הקצוות: מקטע שהתחיל לפני החודש נספר מתחילת החודש,
    // ומקטע שנמשך אחריו נחתך בסופו. מקטע פתוח נמשך עד סוף החודש.
    const start = Math.max(new Date(row.started_at).getTime(), monthStartTime);
    const end = Math.min(
      row.ended_at ? new Date(row.ended_at).getTime() : monthEndTime,
      monthEndTime,
    );

    if (end > start) {
      hours[row.status] += (end - start) / (1000 * 60 * 60);
    }
  }

  // --- מונה סייקלים (הערך הנוכחי — מדויק לחודש הנוכחי, אפרוקסימציה להיסטוריים) ---
  const cycleEnd = (await db.prepare("SELECT cycle_total FROM sites WHERE id = ?").get(siteId)).cycle_total;

  const round = (n) => Math.round(n * 100) / 100;

  // --- שמירה (INSERT או UPDATE אם כבר קיים) ---
  await db.prepare(
    `INSERT INTO monthly_summary
       (site_id, year_month, operations, anomalies, errors, errors_in_maintenance, failure_rate,
        ready_hours, operating_hours, error_hours, maintenance_hours, no_comm_hours,
        cycle_total_start, cycle_total_end, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, year_month) DO UPDATE SET
       operations=excluded.operations, anomalies=excluded.anomalies,
       errors=excluded.errors, errors_in_maintenance=excluded.errors_in_maintenance,
       failure_rate=excluded.failure_rate,
       ready_hours=excluded.ready_hours, operating_hours=excluded.operating_hours,
       error_hours=excluded.error_hours, maintenance_hours=excluded.maintenance_hours,
       no_comm_hours=excluded.no_comm_hours,
       cycle_total_start=excluded.cycle_total_start, cycle_total_end=excluded.cycle_total_end,
       generated_at=excluded.generated_at`
  ).run(
    siteId, yearMonth, operations, anomalies, stats.errors, stats.errorsInMaintenance, stats.failureRate,
    round(hours.ready), round(hours.operating), round(hours.error), round(hours.maintenance), round(hours.no_comm),
    null, cycleEnd, new Date().toISOString()
  );

  return {
    yearMonth, operations, anomalies,
    errors: stats.errors, errorsInMaintenance: stats.errorsInMaintenance, failureRate: stats.failureRate,
    hours: {
      ready: round(hours.ready), operating: round(hours.operating), error: round(hours.error),
      maintenance: round(hours.maintenance), no_comm: round(hours.no_comm),
    },
    cycleTotalEnd: cycleEnd,
  };
}

// ===== סיכום מערכתי (כל האתרים) =====

async function getSystemSummary({ yearMonth = null, year = null, from = null, to = null } = {}) {
  let whereClause = "";
  const params = [];

  if (yearMonth) {
    whereClause = "WHERE year_month = ?";
    params.push(yearMonth);
  } else if (year) {
    whereClause = "WHERE year_month >= ? AND year_month <= ?";
    params.push(`${year}-01`, `${year}-12`);
  } else if (from || to) {
    // year_month הוא "YYYY-MM". משווים תמיד לתחילית באותו פורמט — אחרת תאריך
    // מלא כמו "2026-03-15" היה גדול לקסיקוגרפית מ-"2026-03" ומחריג בשקט את מרץ.
    whereClause = "WHERE 1=1";
    if (from) { whereClause += " AND year_month >= ?"; params.push(String(from).slice(0, 7)); }
    if (to)   { whereClause += " AND year_month <= ?"; params.push(String(to).slice(0, 7)); }
  }

  const row = await db.prepare(`
    SELECT
      COUNT(DISTINCT site_id) AS sites_count,
      COUNT(*) AS months_reported,
      SUM(operations) AS total_operations,
      SUM(anomalies) AS total_anomalies,
      SUM(errors) AS total_errors,
      SUM(errors_in_maintenance) AS total_errors_in_maintenance,
      SUM(ready_hours) AS total_ready_hours,
      SUM(operating_hours) AS total_operating_hours,
      SUM(error_hours) AS total_error_hours,
      SUM(maintenance_hours) AS total_maintenance_hours,
      SUM(no_comm_hours) AS total_no_comm_hours
    FROM monthly_summary
    ${whereClause}
  `).get(...params);

  const ops = row.total_operations || 0;
  const errs = row.total_errors || 0;
  const failureRate = ops > 0 ? (errs / ops) * 100 : 0;

  return {
    sitesCount: row.sites_count || 0,
    monthsReported: row.months_reported || 0,
    operations: ops,
    anomalies: row.total_anomalies || 0,
    errors: errs,
    errorsInMaintenance: row.total_errors_in_maintenance || 0,
    failureRate: Math.round(failureRate * 100) / 100,
    hours: {
      ready: Math.round((row.total_ready_hours || 0) * 100) / 100,
      operating: Math.round((row.total_operating_hours || 0) * 100) / 100,
      error: Math.round((row.total_error_hours || 0) * 100) / 100,
      maintenance: Math.round((row.total_maintenance_hours || 0) * 100) / 100,
      no_comm: Math.round((row.total_no_comm_hours || 0) * 100) / 100,
    },
  };
}


// ============================================================
// דוח חודשי לטווח חופשי — פעולות ותקלות לכל חודש
// ============================================================
// ⚠️ נשען על public.report_monthly ולא על monthly_summary. נמדד שהטבלה ההיא
// שגויה (יולי 633 מול 806 בפועל, אוגוסט חסר), כי העבודה היומית שבונה אותה
// אינה רצה. דוח שנשען עליה היה מדווח פחות ממה שקרה, בלי שום סימן.
async function getSiteReport({ siteIds = null, from, to }) {
  return await db.prepare(
    'SELECT * FROM public.report_by_site(?, ?, ?)'
  ).all(siteIds, from, to);
}

async function getSiteMonthsReport({ siteIds = null, from, to }) {
  return await db.prepare(
    'SELECT * FROM public.report_site_months(?, ?, ?)'
  ).all(siteIds, from, to);
}

async function getMonthlyReport({ siteIds = null, from, to }) {
  return await db.prepare(
    'SELECT * FROM public.report_monthly(?, ?, ?)'
  ).all(siteIds, from, to);
}

async function getSystemMonthlyBreakdown({ year = null, from = null, to = null } = {}) {
  let whereClause = "";
  const params = [];

  if (year) {
    whereClause = "WHERE year_month >= ? AND year_month <= ?";
    params.push(`${year}-01`, `${year}-12`);
  } else if (from || to) {
    // year_month הוא "YYYY-MM". משווים תמיד לתחילית באותו פורמט — אחרת תאריך
    // מלא כמו "2026-03-15" היה גדול לקסיקוגרפית מ-"2026-03" ומחריג בשקט את מרץ.
    whereClause = "WHERE 1=1";
    if (from) { whereClause += " AND year_month >= ?"; params.push(String(from).slice(0, 7)); }
    if (to)   { whereClause += " AND year_month <= ?"; params.push(String(to).slice(0, 7)); }
  }

  return await db.prepare(`
    SELECT
      year_month,
      COUNT(DISTINCT site_id) AS sites_count,
      SUM(operations) AS operations,
      SUM(anomalies) AS anomalies,
      SUM(errors) AS errors,
      SUM(errors_in_maintenance) AS errors_in_maintenance,
      SUM(maintenance_hours) AS maintenance_hours,
      SUM(no_comm_hours) AS no_comm_hours
    FROM monthly_summary
    ${whereClause}
    GROUP BY year_month
    ORDER BY year_month
  `).all(...params);
}

// ===== אנליטיקה לפי תקופה (משמש את GET /api/sites/:code/analytics) =====

// ==========================================================
// זמינות — הגדרה אחת, ורק אחת
// ==========================================================
// קודם היו כאן *שתי* הגדרות סותרות, ושתיהן הוצגו כעובדה:
//   getUptimeBreakdown : תחזוקה נספרת כ"לא זמין"  → אתר בתחזוקה שבוע = 0%
//   getSiteUptime      : תחזוקה נספרת כ"זמין"     → אותו אתר בדיוק = 100%
// אותו אתר הציג 100% במסך אחד ו-0% במסך אחר, באותו רגע.
//
// ההחלטה: **תחזוקה מתוכננת מוחרגת מהמכנה לחלוטין.** היא לא זמינות ולא
// השבתה — היא פשוט לא נמדדת.
//
//     זמינות = (ready + operating) / (ready + operating + error + no_comm)
//
// שלוש סיבות:
//   1. עקביות עם כלל שכבר קיים ומתועד: תקלה שקרתה בתוך חלון תחזוקה
//      *מוחרגת* מאחוז הכשל (wasInMaintenance). אם מחלנו על התקלה, אי אפשר
//      להעניש על הזמן שבו היא קרתה. אחרת אותה תחזוקה גם מזכה וגם מרשיעה.
//   2. הממשק כבר אומר למשתמשת "מתוכנן — לא כשל". המספר צריך להסכים עם זה.
//   3. זה התקן המקובל: SLA מחריג planned maintenance מהמכנה.
//
// no_comm כן נספר כהשבתה: אתר שאיננו שומעים ממנו הוא אתר שלא יכולנו
// להוכיח שהוא נותן שירות. ההנחה השמרנית היא שלא.
//
// אתר שהיה בתחזוקה *כל* התקופה: המכנה הוא 0 → אין נתון. במקרה כזה
// measuredHours = 0, וזה השער שדרכו הממשק מציג "—" ולא "0%".
// ==========================================================

const { AVAILABLE_STATUSES } = require("../../shared/executive.mjs");
// siteTrend — הפסק "משתפר/מחמיר" לכרטיס האתר. הכלל במודול המשותף כדי
// ששתי זרועות המתג יגיעו לאותה תשובה; ראה ההסבר שם.
const { siteTrend } = require("../../shared/executive.mjs");

/**
 * פילוח זמינות מפורט: כמה שעות האתר היה בכל מצב בטווח [from, to).
 * נגזר מ-status_history, עם חיתוך נכון של מקטעים בשני הקצוות:
 *   - מקטע שהתחיל לפני from ונמשך לתוכו → נספר רק החלק שבטווח.
 *   - מקטע שנמשך אחרי to → נחתך ב-to.
 *   - מקטע פתוח (ended_at IS NULL) → נמשך עד to או עד עכשיו (המוקדם).
 *
 * totalHours הוא סך הזמן ה*נמדד* (סכום המקטעים), ולא אורך החלון —
 * אתר שנרשם באמצע התקופה לא ייענש על זמן שלא היה קיים בו.
 */
// ============================================================
// ⚠️ עוטף את uptimeFromData — ולא מיישם מחדש
// ============================================================
// הגרסה הקודמת חישבה בעצמה, ו**שלושה כללים חסרו בה**: היא קראה status
// גולמי (התעלמה מסיווג מחדש), שלפה excluded_at ומעולם לא בדקה אותו,
// ולא טענה maintenance_windows בכלל.
//
// ⚠️ נמדד על הייצור לפני ההחלפה: **6 מתוך 14 אתרים** קיבלו זמינות
// שונה בין הזרועות. אתר 1399 — 88.64% מול 91.23%. אתר 3501 — 1.58
// שעות תחזוקה מול 3.57. כלומר אותו אתר, אותו טווח, שני מספרים,
// לפי ערך של משתנה סביבה.
//
// ⚠️ וזה בדיוק מה ש-CLAUDE.md אוסר: "לזמינות יש הגדרה אחת בלבד".
// מימוש שני אינו אופטימיזציה — הוא הגדרה שנייה שתסחף.
//
// המחיר: שלוש שאילתות במקום אחת. עבור אתר בודד זה זניח, והחלופה היא
// לשכפל שלושה כללים ולתחזק אותם בשני מקומות.
async function getUptimeBreakdown(siteId, { from, to }) {
  const data = await loadRangeData([siteId], { from, to });
  return uptimeFromData(data, siteId, { from, to });
}

/**
 * כמה מחזורים נוספו למונה הבקר בטווח.
 *
 * מחזיר null — הערך אינו ניתן לחישוב מהנתונים השמורים: טבלת operations
 * אינה שומרת את ה-cycle_counter של כל הודעה (רק sites.cycle_total המצטבר
 * ו-plc_cycle_last העדכני), ואין היסטוריה של המונה לאורך זמן.
 * כדי לאפשר זאת יש לשמור את המונה בכל שורת operation — שינוי סכמה.
 * ה-frontend מציג "לא זמין" במקום לנחש.
 */
// eslint-disable-next-line no-unused-vars
function getCycleDelta(siteId, { from, to }) {
  return null;
}

/**
 * סדרת נקודות לגרף המגמה: פעולות ותקלות לכל יום/חודש בטווח.
 * granularity: 'day' (נקודה ליום) או 'month' (נקודה לחודש).
 * מחזיר מערך רציף — גם דלי ריק מקבל נקודה עם 0, כדי שהגרף לא "יקפוץ".
 */
// getSiteAnalyticsData — הקריאה ל-DB כאן, החישוב ב-shared/executive.mjs.
// ההפרדה היא מה שמאפשר לדשבורד להריץ את **אותו חישוב בדיוק** על שורות
// שהוא שלף מ-Supabase בעצמו.
async function getSiteAnalyticsData(siteId, { range, prev, granularity }) {
  const data = await loadRangeData([siteId], { from: prev.from, to: range.to });
  return computeAnalytics(data, siteId, { range, prev, granularity });
}

async function getPeriodBreakdown(siteId, { from, to, granularity }) {
  // שלוש השאילתות בלתי-תלויות — במקביל, סיבוב רשת אחד במקום שלושה בטור.
  // תחזוקה: כמה פעמים האתר נכנס למצב תחזוקה באותו יום/חודש — מקביל ל-errors
  // (כניסות למצב), כדי שהיחידות בגרף יישארו אחידות.
  const [opsRows, errRows, maintRows] = await Promise.all([
    db.prepare(
      `SELECT occurred_at FROM operations
       WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
         AND is_anomaly = 0 AND superseded_by IS NULL AND start_end = 'end'`
    ).all(siteId, from, to),

    db.prepare(
      `SELECT started_at FROM status_history
       WHERE site_id = ? AND started_at >= ? AND started_at < ? AND COALESCE(reclassified_to, status) = 'error'`
    ).all(siteId, from, to),

    db.prepare(
      `SELECT started_at FROM status_history
       WHERE site_id = ? AND started_at >= ? AND started_at < ? AND COALESCE(reclassified_to, status) = 'maintenance'`
    ).all(siteId, from, to),
  ]);

  return buildPeriodSeries(
    opsRows.map((r) => r.occurred_at),
    errRows.map((r) => r.started_at),
    maintRows.map((r) => r.started_at),
    { from, to, granularity },
  );
}

/**
 * כל נתוני מסך האנליטיקה — תקופה נוכחית + תקופת השוואה — משליפה *אחת* של
 * הנתונים הגולמיים על פני טווח-העל [prev.from, range.to].
 *
 * קודם המסלול ירה 5 קריאות נפרדות (getSiteStats×2, getUptimeBreakdown×2,
 * getPeriodBreakdown) = ~14 שאילתות. loadRangeData מביא את אותם נתונים גולמיים
 * ב-3 שאילתות, וכל השאר מחושב בזיכרון עם *אותן* פונקציות טהורות שמשמשות את
 * המנהל הכללי (statsFromData/uptimeFromData) ואת הגרף (buildPeriodSeries) —
 * ולכן המספרים זהים בהגדרה. סה"כ: findSiteByCode(1) + 3 = 4 שאילתות.
 *
 * טווח-העל מכיל את שתי התקופות, ולכן כל תת-טווח מחושב ממנו בלי שליפה נוספת
 * (ראה ההוכחה בתנאי הגבול של loadRangeData). הגרף מכסה את התקופה הנוכחית בלבד.
 */

/**
 * מתאם כרטיס↔תקלה: אחרי הפעולה של איזה מספר כרטיס האתר נכנס הכי הרבה פעמים
 * לתקלה. לכל מקטע error בטווח מוצאים את פעולת-הכרטיס האחרונה שקדמה לו *בתוך
 * חלון זמן*, ומייחסים לה את התקלה; מקבצים לפי כרטיס.
 *
 * החלון (windowSeconds) הכרחי: בלעדיו תקלה ששעות אחרי פעולה הייתה מיוחסת לה
 * ומטעה. ברירת מחדל 600ש' (10 דק') — רחב מספיק לתפוס תקלה שנגרמה מהפעולה,
 * צר מספיק כדי שהקשר יהיה משמעותי. זהו *מתאם*, לא הוכחת סיבתיות.
 *
 * מימוש בזיכרון (two-pointer) ולא SQL: חותמי הזמן הם TEXT (ISO), וחשבון
 * חלונות עליהם ב-SQL דורש casting מסורבל; בזיכרון זה פשוט ומדויק.
 */
async function getCardFaultCorrelation(siteId, { from, to, windowSeconds = 600, limit = 10 }) {
  const opsFrom = new Date(Date.parse(from) - windowSeconds * 1000).toISOString();

  const [errors, ops] = await Promise.all([
    db.prepare(
      `SELECT started_at FROM status_history
       WHERE site_id = ? AND COALESCE(reclassified_to, status) = 'error' AND started_at >= ? AND started_at < ?
       ORDER BY started_at ASC`
    ).all(siteId, from, to),

    // card_number הוא TEXT עם ברירת מחדל '' (פעולה בלי כרטיס), ולכן <> '' ולא IS NOT NULL.
    db.prepare(
      `SELECT occurred_at, card_number FROM operations
       WHERE site_id = ? AND card_number <> '' AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at ASC`
    ).all(siteId, opsFrom, to),
  ]);

  // לכל תקלה (ממוינות עולה) — פעולת-הכרטיס האחרונה שקדמה לה בתוך החלון.
  // j זז רק קדימה (התקלות עולות), ולכן O(n+m).
  const counts = new Map();
  let attributed = 0;
  let j = 0;
  for (const e of errors) {
    const et = Date.parse(e.started_at);
    const windowStart = et - windowSeconds * 1000;
    while (j < ops.length && Date.parse(ops[j].occurred_at) <= et) j++;
    const cand = j > 0 ? ops[j - 1] : null;
    if (cand && cand.card_number && Date.parse(cand.occurred_at) >= windowStart) {
      counts.set(cand.card_number, (counts.get(cand.card_number) || 0) + 1);
      attributed++;
    }
  }

  const topCards = [...counts.entries()]
    .map(([cardNumber, faultsAfter]) => ({ cardNumber, faultsAfter }))
    .sort((a, b) => b.faultsAfter - a.faultsAfter || (a.cardNumber < b.cardNumber ? -1 : 1))
    .slice(0, limit);

  return {
    windowSeconds,
    totalErrors: errors.length,       // כל התקלות בתקופה
    attributedErrors: attributed,     // מתוכן — כמה הייתה לפניהן פעולת-כרטיס בחלון
    topCards,                         // [{ cardNumber, faultsAfter }] — מהגבוה לנמוך
  };
}

// ============================================================
// התובנות וקיפול הריצוד עברו ל-shared/insights.mjs
// ============================================================
// לוגיקת תצוגה שהדשבורד מריץ עכשיו בעצמו כשהוא קורא ישירות מ-Supabase.
// **אותו קובץ בדיוק** משרת את שני הצדדים — ההסבר המלא שם.
//
// ⚠️ אל תעתיקו אותן לכאן בחזרה. שני עותקים של כלל תצוגה נפרדים בשינוי
// הראשון, ואז אותה תקופה נקראת אחרת בשני מצבי המתג.
const { WEEKDAY_LABELS, computeInsights,
        collapseNoCommFlicker, collapseSegmentsBySite } = require("../../shared/insights.mjs");


/**
 * סטטיסטיקה מעמיקה לאתר בטווח [from, to) — למסך "עוד מידע".
 *
 * שולף פעם אחת את הפעולות ואת מקטעי המצב, ומחשב הכל ב-JS.
 * זול יותר מ-8 שאילתות נפרדות, ומאפשר חישובים (שיוך start↔end) שקשה לבטא ב-SQL.
 */
// שולף תובנות לאתר בודד ומעביר לחישוב הטהור (computeInsights).
async function getSiteInsights(siteId, { from, to }) {
  // ארבע השאילתות של המסך (פעולות, מקטעי error, מקטעי maintenance, חלונות
  // ידניים) בלתי-תלויות זו בזו — נשלפות במקביל, סיבוב רשת אחד במקום ארבעה.
  const [ops, segments, windows] = await Promise.all([
    db.prepare(
      `SELECT site_id, start_end, entry_exit, card_number, is_anomaly, superseded_by, occurred_at
       FROM operations
       WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at ASC, id ASC`
    ).all(siteId, from, to),
    // *כל* המצבים, לא רק error/maintenance — חייבים גם את מקטעי ה-no_comm כדי
    // לזהות המשכיות (`X → no_comm → X`). ומיון כרונולוגי, כי הקיפול תלוי בסדר.
    db.prepare(
      `SELECT site_id, COALESCE(reclassified_to, status) AS status, started_at, ended_at, excluded_at FROM status_history
       WHERE site_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)
       ORDER BY started_at ASC`
    ).all(siteId, to, from),
    db.prepare(
      `SELECT site_id, set_by_name, reason, started_at, duration_hours, cancelled_at, excluded_at
       FROM maintenance_windows
       WHERE site_id = ? AND started_at >= ? AND started_at < ?
       ORDER BY started_at DESC`
    ).all(siteId, from, to),
  ]);
  // מקפלים ריצוד תקשורת לפני הספירה: `X → no_comm → X` הוא אירוע אחד.
  // הקיפול חייב לרוץ על *כל* המקטעים יחד ולפי סדר זמן — אי אפשר להחליט על
  // מקטע error בלי לראות את ה-no_comm ואת ה-error שלפניו.
  // ⚠️ מקטע שסומן כניסוי מוסר **לפני** הקיפול, לא אחריו: הוא לא קרה, ולכן
  // הוא גם אינו מפריד בין שני מקטעים שכן קרו. בלי זה הוא נספר כאירוע השבתה
  // נוסף — בזמן שהזמינות כבר התעלמה ממנו לגמרי.
  const kept = segments.filter((s) => !s.excluded_at);
  const counted = collapseSegmentsBySite(kept);
  const errorRows = counted.filter((s) => s.status === "error");
  const maintRows = counted.filter((s) => s.status === "maintenance");

  // allRows = המקטעים ה**גולמיים**, לפני הקיפול. computeInsights סופרת
  // אירועים לפי המקופלים וסוכמת זמן לפי הגולמיים — ראה ההסבר שם.
  return computeInsights({ ops, errorRows, maintRows, windows, from, to, allRows: kept });
}

// אותה סטטיסטיקה מעמיקה, אך מצרפת על *כל* האתרים (מנהל כללי → "כל האתרים").
// מספר השאילתות קבוע ואינו גדל עם מספר האתרים — עקבי עם מדיניות ה-N+1.
//
// ⚠️ **ההערה שהייתה כאן טענה שהכרטיסים משויכים לפי site_id — וזה לא היה
// נכון.** computeInsights קיבצה לפי מספר הכרטיס בלבד, ולכן "כרטיס 4"
// במצרפת היה 11 כרטיסים פיזיים מ-11 אתרים בשורה אחת. הערה שמבטיחה תכונה
// שאינה קיימת גרועה מהיעדר הערה: היא מונעת מהקורא לבדוק.
// תוקן; המפתח הוא כעת (site_id, card_number). שמות האתרים נשלפים כאן כדי
// שהטבלה תוכל לומר לאיזה אתר כל שורה שייכת.
async function getGlobalInsights({ from, to }) {
  const [ops, segments, windows] = await Promise.all([
    db.prepare(
      `SELECT site_id, start_end, entry_exit, card_number, is_anomaly, superseded_by, occurred_at
       FROM operations
       WHERE occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at ASC, id ASC`
    ).all(from, to),
    // כל המצבים של כל האתרים. הקיפול חייב להיעשות **לכל אתר בנפרד** — ראה
    // collapseSegmentsBySite; רשימה מעורבת הייתה מקפלת מקטעים של אתרים שונים
    // זה לתוך זה.
    db.prepare(
      `SELECT site_id, COALESCE(reclassified_to, status) AS status, started_at, ended_at, excluded_at FROM status_history
       WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)
       ORDER BY site_id ASC, started_at ASC`
    ).all(to, from),
    db.prepare(
      `SELECT s.site_name, w.site_id, w.set_by_name, w.reason, w.started_at, w.duration_hours, w.cancelled_at, w.excluded_at
       FROM maintenance_windows w JOIN sites s ON w.site_id = s.id
       WHERE w.started_at >= ? AND w.started_at < ?
       ORDER BY w.started_at DESC`
    ).all(from, to),
  ]);
  // מקפלים ריצוד תקשורת לפני הספירה: `X → no_comm → X` הוא אירוע אחד.
  // הקיפול חייב לרוץ על *כל* המקטעים יחד ולפי סדר זמן — אי אפשר להחליט על
  // מקטע error בלי לראות את ה-no_comm ואת ה-error שלפניו.
  // ⚠️ מקטע שסומן כניסוי מוסר **לפני** הקיפול, לא אחריו: הוא לא קרה, ולכן
  // הוא גם אינו מפריד בין שני מקטעים שכן קרו. בלי זה הוא נספר כאירוע השבתה
  // נוסף — בזמן שהזמינות כבר התעלמה ממנו לגמרי.
  const kept = segments.filter((s) => !s.excluded_at);
  const counted = collapseSegmentsBySite(kept);
  const errorRows = counted.filter((s) => s.status === "error");
  const maintRows = counted.filter((s) => s.status === "maintenance");

  // ⚠️ שאילתה אחת נוספת, קטנה וקבועה (13 שורות) — לא N+1. בלעדיה טבלת
  // הכרטיסים במצרפת מציגה "כרטיס 4" חמש פעמים בלי שום דרך להבדיל ביניהם,
  // וזה גרוע יותר מהמיזוג השגוי שהיא באה להחליף: שם לפחות הייתה שורה אחת.
  const nameRows = await db.prepare("SELECT id, site_name FROM sites").all();
  const siteNames = new Map(nameRows.map((r) => [r.id, r.site_name]));

  return computeInsights({ ops, errorRows, maintRows, windows, from, to, siteNames, allRows: kept });
}


// ============================================================
// חלון ההצמדה בין הודעת state להודעת operation
// ============================================================
// הסוכן מפרסם את שתיהן באותו סבב דגימה, אבל לא באותה מילישנייה — בשטח נמדד
// פער של עד שנייה-שתיים (אתר 2439: state ב-16:22:12, הפעולה ב-16:22:13).
// 5 שניות מכסות את זה בנוחות ועדיין רחוק מלחבר בטעות שתי פעולות שונות.
//
// ⚠️ מקור אמת אחד. הערך הזה משמש גם לסימון entries (buildActivityLog) וגם
// לספירת המונה בצ'יפ (SQL). אם השניים יסטו זה מזה, המספר על הצ'יפ יפסיק
// להתאים למספר השורות שבאמת נפתחות — וזה בדיוק סוג התקלה שהלוג הזה אמור
// לגלות, לא לייצר.
// ⚠️ מיובא מ-shared ולא מוגדר כאן: הוא משמש גם את buildTimeline (בדפדפן)
// וגם את noPairedStartSql (SQL, כאן). שני עותקים היו מפרידים את המונה שעל
// הצ'יפ ממספר השורות שנפתחות ברגע שמישהו יכוונן אחד מהם.
const { OP_PAIR_TOLERANCE_SECONDS } = require("../../shared/timeline.mjs");

// אותה הצמדה, בניסוח SQL. מחזיר תנאי שמתקיים כשלשורת status_history בשם
// {h} *אין* פעולה שמסבירה אותה. משמש גם למונים וגם ל-getStatusHistory.
const noPairedStartSql = (h) => `
  NOT EXISTS (
    SELECT 1 FROM operations o
     WHERE o.site_id = ${h}.site_id
       AND o.start_end = 'start'
       AND abs(EXTRACT(EPOCH FROM (
             o.occurred_at::timestamptz - ${h}.started_at::timestamptz
           ))) <= ${OP_PAIR_TOLERANCE_SECONDS})`;

/**
 * לוג פעילות מלא לתקופה — מאחד שלושה מקורות לציר זמן אחד:
 * פעולות (כניסה/יציאה), שינויי מצב, וחלונות תחזוקה ידניים.
 *
 * counts הם הסכומים ה*מלאים* בתקופה, גם אם entries נחתך ל-limit —
 * כדי שה-UI יוכל לומר "מוצגות 300 מתוך 812".
 */
// ============================================================
// תקרת שליפה — לא תקרת תצוגה
// ============================================================
// שני המספרים היו אותו מספר, וזה היה הבאג: `limit` שימש גם כמה לשלוף מה-DB
// וגם כמה להציג, ולכן "7 הימים האחרונים" הביא 300 שורות מתוך 3,124 ונחתך
// לחדשות ביותר — בערך יממה. הפרדה: שולפים את התקופה, מציגים עמוד.
//
// 20,000 מכסה בנוחות שבוע (~3,100) וחודש (~13,000) בקצב הנוכחי. אם ייגמר,
// `capped` חוזר ל-UI — כי "סה\"כ" שקטן מהאמת גרוע מהודעה שאומרת "חלקי".
const LOG_FETCH_CAP = 20000;

async function getActivityLog(siteId, { from, to, limit = 300, offset = 0, filter = "all", card = null }) {

  // שלוש רשימות בלתי-תלויות — נשלפות במקביל, סיבוב רשת אחד במקום שלושה בטור.
  //
  // הערה על 'operating': כל פעולת חניה מייצרת גם state=operating וגם הודעת
  // operation, ולכן בציר המאוחד כל כניסת רכב הופיעה פעמיים. לכן נשלף הכל,
  // ו-LOG_FILTERS מסתיר את 'operating' בכל מסנן חוץ מ-"שינויי מצב" (שם זה
  // בדיוק התוכן). שום חישוב (זמינות/אחוז כשל) לא נגזר מכאן.
  const [ops, states, maint, suppressed] = await Promise.all([
    db.prepare(
      // id נשלף כי superseded_by מצביע עליו: הפתיחה שאיחדה ניסיון קודם חייבת
      // להיעלם מהציר יחד עם הסגירה שהיא איחדה, אחרת נשארת התחלה בלי סיום.
      `SELECT id, site_id, start_end, entry_exit, card_number, is_anomaly, superseded_by, state, occurred_at, excluded_at, excluded_by
       FROM operations
       WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at DESC LIMIT ?`
    ).all(siteId, from, to, LOG_FETCH_CAP),

    db.prepare(
      // site_id נשלף גם באתר בודד: buildActivityLog מצמיד מצבים לפעולות
      // *לפי אתר*, ואם צד אחד מחזיר site_id והשני לא — ההצמדה לא תתפוס אף
      // פעם, וכל שינוי מצב ייראה יתום.
      `SELECT id, site_id, status, started_at, ended_at, fault_text, excluded_at, excluded_by,
              reclassified_to, reclassified_by, reclassified_at FROM status_history
       WHERE site_id = ? AND started_at >= ? AND started_at < ?
       ORDER BY started_at DESC LIMIT ?`
    ).all(siteId, from, to, LOG_FETCH_CAP),

    db.prepare(
      `SELECT id, set_by_name, set_by_role, reason, started_at, duration_hours, expires_at, cancelled_at,
              excluded_at, excluded_by
       FROM maintenance_windows
       WHERE site_id = ? AND started_at >= ? AND started_at < ?
       ORDER BY started_at DESC LIMIT ?`
    ).all(siteId, from, to, LOG_FETCH_CAP),

    // ⚠️ תקלות שהושמטו מהמדדים בזמן תחזוקה. הן **אינן** ב-status_history
    // בכוונה, ולכן הן חייבות שליפה נפרדת — ואף מדד אינו קורא מהטבלה הזו,
    // כך שאחוז הכשל אינו יכול להשתנות מהן.
    db.prepare(
      `SELECT site_id, occurred_at, fault_text, reason FROM suppressed_faults
       WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at DESC LIMIT ?`
    ).all(siteId, from, to, LOG_FETCH_CAP),
  ]);

  return buildActivityLog({
    ops, states, maint, suppressed, limit, offset, filter, card,
    capped: ops.length >= LOG_FETCH_CAP || states.length >= LOG_FETCH_CAP,
  });
}

// אותו לוג פעילות, אך מאחד את *כל* האתרים (מנהל כללי → "כל האתרים"). כל שורה
// נושאת את שם האתר להצגה. מספר השאילתות קבוע (עקבי עם מדיניות ה-N+1).
async function getGlobalActivityLog({ from, to, limit = 300, offset = 0, filter = "all", card = null }) {
  const [ops, states, maint, suppressed] = await Promise.all([
    db.prepare(
      `SELECT o.id, o.site_id, s.site_name, o.start_end, o.entry_exit, o.card_number, o.is_anomaly, o.superseded_by, o.state, o.occurred_at
       FROM operations o JOIN sites s ON o.site_id = s.id
       WHERE o.occurred_at >= ? AND o.occurred_at < ?
       ORDER BY o.occurred_at DESC LIMIT ?`
    ).all(from, to, LOG_FETCH_CAP),

    db.prepare(
      // ⚠️ **id, reclassified_* ו-excluded_* חייבים להיות כאן.** בלעדיהם
      // buildActivityLog מקבל שורות בלי הסיווג ובלי הסימון, ואז החלפת
      // הסיווג בכניסה היא no-op והמסנן 'ניסויים' ריק — ביומן **כל
      // האתרים** בלבד, בזמן שהיומן הפר-אתרי כן שולף אותם.
      //
      // ⚠️ שני מסכים שמראים אותה שורה אחרת הם בדיוק מה שהופך חקירה
      // למרדף: מי שסיווג תקלה מחדש ראה את זה באתר ולא ראה בכללי.
      `SELECT h.id, h.site_id, s.site_name, h.status, h.started_at, h.ended_at, h.fault_text,
              h.reclassified_to, h.reclassified_by, h.reclassified_at,
              h.excluded_at, h.excluded_by, h.exclusion_reason
       FROM status_history h JOIN sites s ON h.site_id = s.id
       WHERE h.started_at >= ? AND h.started_at < ?
       ORDER BY h.started_at DESC LIMIT ?`
    ).all(from, to, LOG_FETCH_CAP),

    db.prepare(
      `SELECT w.site_id, s.site_name, w.set_by_name, w.set_by_role, w.reason, w.started_at, w.duration_hours, w.expires_at, w.cancelled_at, w.performed_by, w.cancelled_by
       FROM maintenance_windows w JOIN sites s ON w.site_id = s.id
       WHERE w.started_at >= ? AND w.started_at < ?
       ORDER BY w.started_at DESC LIMIT ?`
    ).all(from, to, LOG_FETCH_CAP),

    // ראה ההערה ב-getActivityLog: טבלה נפרדת, ואף מדד אינו קורא ממנה.
    db.prepare(
      `SELECT f.site_id, s.site_name, f.occurred_at, f.fault_text, f.reason
       FROM suppressed_faults f JOIN sites s ON f.site_id = s.id
       WHERE f.occurred_at >= ? AND f.occurred_at < ?
       ORDER BY f.occurred_at DESC LIMIT ?`
    ).all(from, to, LOG_FETCH_CAP),
  ]);

  return buildActivityLog({
    ops, states, maint, suppressed, limit, offset, filter, card,
    capped: ops.length >= LOG_FETCH_CAP || states.length >= LOG_FETCH_CAP,
  });
}

// ============================================================
// ציר הזמן של הלוג עבר ל-shared/timeline.mjs
// ============================================================
// זו לוגיקת תצוגה, לא הגדרת מדד, והדשבורד מריץ אותה עכשיו בעצמו כשהוא קורא
// ישירות מ-Supabase. **אותו קובץ בדיוק** משרת את שני הצדדים: Node טוען ESM
// דרך require() מגרסה 22.12, ו-Vite מייבא אותו כרגיל.
//
// ⚠️ אל תעתיקו את הפונקציות האלה לכאן בחזרה. שני עותקים של כלל תצוגה נפרדים
// בשינוי הראשון, ואז אותה תקופה נקראת אחרת בשני מצבי המתג.
const { LOG_FILTERS, buildTimeline, buildActivityLog } = require("../../shared/timeline.mjs");

// ==========================================================
// ===== שכבת ה-BATCH — הפתרון ל-N+1 =====
// ==========================================================
//
// הבעיה: הפונקציות לכל אתר (getSiteStats, getUptimeBreakdown...) נקראו בתוך
// לולאות — פעם לכל אתר, ובמנהל הכללי גם פעם לכל *דלי* בגרף. מול SQLite מקומי
// שאילתה עלתה מיקרו-שניות וזה לא הורגש. מול Postgres מרוחק כל שאילתה היא
// סיבוב רשת (~100ms), ולכן:
//
//     מנהל כללי, חודש, אתר אחד     = 100 שאילתות = 3.5 שניות
//     מנהל כללי, חודש, 200 אתרים   = ~18,000 שאילתות = בלתי שמיש
//
// הפתרון: לשלוף את הנתונים הגולמיים *פעם אחת* לכל הטווח ולכל האתרים, ולחשב
// את כל האתרים וכל הדליים בזיכרון. מספר השאילתות הופך לקבוע — הוא לא גדל
// עם מספר האתרים ולא עם מספר הדליים.
//
// קריטי: החישוב כאן הוא *העתק מדויק* של האריתמטיקה בפונקציות לכל אתר —
// אותם חיתוכים, אותם עיגולים, אותם תנאי גבול. הפונקציות המקוריות נשארו
// כפי שהן ומשמשות את ה-endpoints של אתר בודד.
// ==========================================================

/**
 * שולף את כל הנתונים הגולמיים הדרושים לטווח — 3 שאילתות, ללא תלות בכמות
 * האתרים או הדליים.
 *
 * הטווח שנשלף הוא *מכיל* (superset) של מה שכל דלי צריך, ולכן אפשר לחשב ממנו
 * כל תת-טווח בזיכרון.
 */
async function loadRangeData(siteIds, { from, to }) {
  const empty = { ops: new Map(), segments: new Map(), windows: new Map() };
  if (siteIds && siteIds.length === 0) return empty;

  // siteIds === null פירושו "כל האתרים". זה לא נוחות בלבד: בלי זה היינו
  // חייבים לשלוף קודם את רשימת האתרים כדי לדעת את המזהים — סיבוב רשת שלם
  // (115ms) בטור, לפני שאפשר בכלל להתחיל. בלעדיו הכול רץ במקביל.
  const filter = siteIds ? `site_id IN (${siteIds.map(() => "?").join(",")})` : "TRUE";
  const ids = siteIds || [];

  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.site_id)) m.set(r.site_id, []);
      m.get(r.site_id).push(r);
    }
    return m;
  };

  // ============================================================
  // מיון כרונולוגי — collapseNoCommFlicker הוא קיפול תלוי-סדר
  // ============================================================
  // הקיפול משווה כל מקטע ל*מצב הקודם שנצפה*, כלומר המשמעות שלו מוגדרת רק
  // על קלט ממוין. השאילתה שמעליו אינה ממוינת, ו-Postgres אינו מבטיח סדר
  // בלי ORDER BY — נמדד בפועל: **כל 13 האתרים** מחזירים שורות בסדר
  // לא-כרונולוגי (heap order). כלומר "המצב הקודם" היה בפועל "השורה
  // שהמנוע החזיר לפני זו".
  //
  // למה כאן ולא ORDER BY בשאילתה: נמדד עם EXPLAIN ANALYZE על 1,323 שורות —
  // ORDER BY גורם למתכנן לזנוח את ה-Seq Scan לטובת idx_status_hist_site
  // כדי להימנע ממיון, ומשלם על כך בגישה אקראית לערמה: 0.52ms → 6.12ms
  // ו-35 → 391 buffers. מיון של 837 שורות בזיכרון עולה 0.22ms ואינו נוגע
  // בתוכנית כלל. אותה דטרמיניזם, שמינית מהמחיר.
  //
  // רק segments מקבל מיון: הוא היחיד שמוזן לקיפול תלוי-סדר. ops ו-windows
  // נצרכים באגרגציה בלבד, ושם הסדר אינו משנה.
  // id הוא שובר-השוויון, ולא קוסמטיקה: קיימים מקטעים באותה שנייה בדיוק
  // (נמדד — אתר 2439 ב-2026-07-22T11:57:05: מקטע no_comm באורך אפס לצד
  // מקטע operating). מיון JS הוא יציב, ולכן שוויון היה משמר את סדר ה-heap
  // — כלומר בדיוק את האי-דטרמיניזם שהמיון בא להסיר. id הוא SERIAL, ולכן
  // הוא סדר ההכנסה: המקטע שנרשם ראשון גם ממוין ראשון.
  const sortByStartedAt = (m) => {
    for (const segs of m.values()) {
      segs.sort((a, b) =>
        a.started_at < b.started_at ? -1
        : a.started_at > b.started_at ? 1
        : (a.id ?? 0) - (b.id ?? 0));
    }
    return m;
  };

  const [ops, segments, windows] = await Promise.all([
    // כל הפעולות בטווח
    db.prepare(
      // superseded_by נשלף כי statsFromData מחריג לפיו — ניסיון שנקטע והוחלף
      // בניסיון חוזר אינו פעולה נוספת. **בלעדיו ה-JS סופר והפונקציה ב-SQL לא**,
      // וזה בדיוק מה ש-tools/parity.js תפס: JS=1029 מול SQL=1018.
      `SELECT site_id, occurred_at, entry_exit, start_end, is_anomaly, superseded_by,
              excluded_at
       FROM operations
       WHERE ${filter} AND occurred_at >= ? AND occurred_at < ?`
    ).all(...ids, from, to),

    // כל מקטעי המצב שחופפים לטווח.
    // '>= from' ולא '> from' (כמו במקור) — זה superset, ומקטע באורך אפס
    // תורם 0ms ממילא. עדיף להביא יותר מדי מלפספס מקטע קצה.
    // id נשלף כדי לשמש שובר-שוויון למיון — ראה sortByStartedAt.
    db.prepare(
      // ⚠️ reclassified_to חייב להישלף: segmentsOf ב-executive.mjs מחיל
      // אותו, ובלי העמודה הוא undefined והסיווג נעלם בשקט.
      `SELECT id, site_id, status, started_at, ended_at, excluded_at,
              reclassified_to
       FROM status_history
       WHERE ${filter} AND started_at < ? AND (ended_at IS NULL OR ended_at >= ?)`
    ).all(...ids, to, from),

    // חלונות תחזוקה ידנית שחופפים לטווח (להחרגת תקלות שקרו בתחזוקה)
    db.prepare(
      // ⚠️ גם כאן excluded_at: חלון שסומן כניסוי אינו אמור להשפיע על
      // הזמינות, ו-mergedWindows כבר מסנן לפיו — בלי העמודה הסינון עובר
      // בשקט ולא מסנן כלום.
      `SELECT site_id, started_at, expires_at, cancelled_at, excluded_at
       FROM maintenance_windows
       WHERE ${filter} AND started_at < ? AND COALESCE(cancelled_at, expires_at) >= ?`
    ).all(...ids, to, from),
  ]);

  return { ops: group(ops), segments: sortByStartedAt(group(segments)), windows: group(windows) };
}


/** גרסת הזיכרון של getSiteStats — מחזירה את אותו אובייקט בדיוק. */
/**
 * מקפל ריצוד תקשורת: `X → no_comm → X` הוא אירוע **אחד** של X, לא שניים.
 *
 * ==========================================================
 * למה
 * ==========================================================
 * `no_comm` פירושו "איבדנו ראייה על האתר", ולא "המצב הסתיים". אתר שהיה בתקלה,
 * נותק לרגע, וחזר לתקלה — לא נכנס לתקלה *חדשה*; זו אותה תקלה שלא הפסיקה. אילו
 * הוא באמת התאושש, היינו רואים ready/operating באמצע.
 *
 * בלי הקיפול, קו תקשורת מרצד מנפח את הספירה בלי גבול. נמדד בפועל: אתר אחד צבר
 * 106 רצפי `maintenance → no_comm → maintenance` ביום אחד, עם נתק חציוני של
 * **5 שניות** — כלומר תחזוקה אחת נספרה 107 פעם.
 *
 * ==========================================================
 * מה הפונקציה *לא* עושה
 * ==========================================================
 * היא לא מוחקת ולא משנה שום שורה. מקטעי ה-no_comm נשמרים כמות שהם — הנתק אכן
 * קרה וזה מידע אמיתי. רק **הספירה** מתעלמת מהחזרה למצב שכבר היינו בו. לכן גם
 * הנתונים ההיסטוריים מיישרים את עצמם מיד, בלי מיגרציה ובלי סיכון.
 *
 * דורש רשימה **ממוינת כרונולוגית** של מקטעי אתר אחד.
 */

/**
 * מחיל את קיפול-הריצוד על רשימה שעשויה לערבב כמה אתרים (המסלול המצרף).
 * הקיפול הוא **לכל אתר בנפרד** — בלעדי זה מקטע של אתר א' היה "ממשיך" מקטע
 * של אתר ב' ומבטל אותו מהספירה. מחזיר את השורות בסדר המקורי.
 */

// ============================================================
// חישובי המסכים עברו ל-shared/executive.mjs
// ============================================================
// הדשבורד מריץ אותם עכשיו בעצמו כשהוא קורא ישירות מ-Supabase, ו**אותו קובץ
// בדיוק** משרת את שני הצדדים.
//
// ⚠️ statsFromData ו-uptimeFromData הן גם צד הייחוס של tools/parity.js.
// הן לא נמחקו — הן עברו. אל תשכפלו אותן חזרה לכאן.
const { getBucketRanges, statsFromData, uptimeFromData, directionFromData,
        heatmapFromData, getTopPerformers, getWorstPerformers, computeExecutive,
        mergedWindows, coveredMs, wasInMaintenanceMem, availabilityFrom,
        buildPeriodSeries, computeAnalytics,
        DOWN_STATUSES } = require("../../shared/executive.mjs");

/** גרסת הזיכרון של getUptimeBreakdown — אותם חיתוכים ואותם עיגולים. */

/** כמה מ-[start,end) מכוסה בקטעים המאוחדים. */


/** גרסת הזיכרון של getDirectionCounts (על פני קבוצת אתרים). */

/**
 * המדדים שאינם תלויי-טווח, לכל האתרים בבת אחת — 5 שאילתות במקום 5 לכל אתר.
 * מחזיר Map: site_id → { lastFaultAt, statusSince, lastOperation,
 *                        operationsSinceLastError, activeMaintenance, firstStatusAt }
 */
async function getAllSitesGlobals(siteIds) {
  const result = new Map();
  if (siteIds && siteIds.length === 0) return result;

  // כמו ב-loadRangeData: null = כל האתרים, כדי לא לחכות לשליפת המזהים.
  const all = !siteIds;
  const filter = all ? "TRUE" : `site_id IN (${siteIds.map(() => "?").join(",")})`;
  const ids = siteIds || [];

  const blank = () => ({
    lastFaultAt: null, statusSince: null, lastOperation: null,
    operationsSinceLastError: 0, activeMaintenance: null, firstStatusAt: null,
    currentFaultText: null,
    currentAfterError: false,
  });
  const at = (id) => {
    if (!result.has(id)) result.set(id, blank());
    return result.get(id);
  };
  for (const id of ids) at(id);

  const holes = filter;   // נשאר בשם הזה כדי לא לשנות את גוף השאילתות
  const now = new Date().toISOString();

  const [faults, open, lastOps, sinceError, maint] = await Promise.all([
    // התקלה האחרונה + המקטע הראשון אי-פעם (ל-getSiteUptime)
    db.prepare(
      `SELECT site_id,
              MAX(started_at) FILTER (WHERE COALESCE(reclassified_to, status) = 'error') AS "lastFaultAt",
              MIN(started_at) AS "firstStatusAt"
       FROM status_history
       WHERE ${holes}
       GROUP BY site_id`
    ).all(...ids),

    // המצב הפתוח הנוכחי. DISTINCT ON הוא הדרך של Postgres ל"שורה אחת לכל
    // קבוצה" — במקום שאילתה נפרדת עם LIMIT 1 לכל אתר.
    //
    // ============================================================
    // תיאור התקלה **שורד את המעבר לטיפול**
    // ============================================================
    // המקרה הנפוץ ביותר: הבקר נופל לתקלה, ומיד אחריה מישהו מעביר את האתר
    // לתחזוקה כדי לטפל בה. ברגע הזה מקטע התקלה **נסגר** ונפתח מקטע תחזוקה
    // — ואיתו נעלם התיאור, בדיוק כשהוא הכי נחוץ: מי שרואה "בטיפול" רוצה
    // לדעת **במה** מטפלים.
    //
    // ⚠️ ולכן COALESCE של שני מקורות:
    //   1. התיאור של המקטע הפתוח עצמו — כשהאתר בתקלה עכשיו.
    //   2. התיאור של התקלה ש**נסגרה בדיוק כשהמקטע הזה נפתח** — כשהאתר
    //      בטיפול, וזו התקלה שבה מטפלים.
    //
    // ⚠️ ההתאמה על `ended_at = started_at` בדיוק, ולא על "התקלה האחרונה":
    // הסוכן סוגר מקטע ופותח את הבא באותו סבב דגימה ועם אותו חותם. תקלה
    // מלפני שעתיים אינה מה שמטפלים בו עכשיו, והצגתה הייתה שקר.
    // אותו כלל בדיוק כמו פילוח "תפעול תקלה" ב-shared/executive.mjs.
    db.prepare(
      `SELECT DISTINCT ON (h.site_id) h.site_id, h.started_at,
              COALESCE(
                h.fault_text,
                (SELECT e.fault_text FROM status_history e
                  WHERE e.site_id = h.site_id
                    AND COALESCE(e.reclassified_to, e.status) = 'error'
                    AND e.ended_at = h.started_at
                  LIMIT 1)
              ) AS "faultText",
              EXISTS (
                SELECT 1 FROM status_history e
                 WHERE e.site_id = h.site_id
                   AND COALESCE(e.reclassified_to, e.status) = 'error'
                   AND e.ended_at = h.started_at
              ) AS "afterError"
       FROM status_history h
       WHERE ${holes} AND h.ended_at IS NULL
       ORDER BY h.site_id, h.started_at DESC`
    ).all(...ids),

    // הפעולה האחרונה
    db.prepare(
      `SELECT DISTINCT ON (site_id) site_id, start_end, entry_exit, card_number, occurred_at
       FROM operations
       WHERE ${holes}
       ORDER BY site_id, occurred_at DESC, id DESC`
    ).all(...ids),

    // כמה פעולות מאז התקלה האחרונה. CTE מחשב את זמן התקלה לכל אתר, ואז
    // סופרים מולו — הכול בשאילתה אחת במקום שתיים לכל אתר.
    db.prepare(
      `WITH last_fault AS (
         SELECT site_id, MAX(started_at) AS t
         FROM status_history
         WHERE ${holes} AND COALESCE(reclassified_to, status) = 'error'
         GROUP BY site_id
       )
       SELECT o.site_id, COUNT(*) AS n
       FROM operations o
       LEFT JOIN last_fault f ON f.site_id = o.site_id
       WHERE ${holes.replace(/site_id/g, "o.site_id")}
         AND o.is_anomaly = 0 AND o.superseded_by IS NULL AND o.start_end = 'end'
         AND (f.t IS NULL OR o.occurred_at > f.t)
       GROUP BY o.site_id`
    ).all(...ids, ...ids),

    // תחזוקה ידנית פעילה כרגע
    db.prepare(
      // ⚠️ started_at <= now: חלון שתוזמן למחר אינו פעיל היום.
      // site_globals ב-SQL מחזיק את התנאי; כאן הוא היה חסר, ושתי
      // הזרועות היו מציגות סטטוס שונה לאותו אתר.
      `SELECT DISTINCT ON (site_id) *
       FROM maintenance_windows
       WHERE ${holes} AND cancelled_at IS NULL
         AND started_at <= ? AND expires_at > ?
       ORDER BY site_id, expires_at DESC`
    ).all(...ids, now, now),
  ]);

  // at() ולא result.get(): כשקוראים עם null (כל האתרים) המפה מתחילה ריקה,
  // ו-get היה מחזיר undefined — כל המדדים היו נזרקים בשקט.
  for (const r of faults) {
    const g = at(r.site_id);
    g.lastFaultAt = r.lastFaultAt;
    g.firstStatusAt = r.firstStatusAt;
  }
  for (const r of open) {
    const g = at(r.site_id);
    g.statusSince = r.started_at;
    // תיאור התקלה הנוכחית — או של זו שמטפלים בה כרגע. ראה השאילתה למעלה.
    g.currentFaultText = r.faultText ?? null;
    // ⚠️ האם המקטע הפתוח הוא תפעול תקלה. אותו כלל, אותה שאילתה — בכוונה.
    g.currentAfterError = r.afterError === true;
  }
  for (const r of lastOps) {
    at(r.site_id).lastOperation = {
      start_end: r.start_end, entry_exit: r.entry_exit,
      card_number: r.card_number, occurred_at: r.occurred_at,
    };
  }
  for (const r of sinceError) {
    at(r.site_id).operationsSinceLastError = r.n;
  }
  for (const r of maint) {
    at(r.site_id).activeMaintenance = r;
  }

  return result;
}

/**
 * גרסת ה-batch של GET /api/sites: כל האתרים, כל המדדים — במספר שאילתות
 * קבוע (8) במקום 6 לכל אתר. מחזיר בדיוק את אותו מבנה כמו הלולאה הישנה.
 */
// ============================================================
// המסלול הראשון שעבר לחישוב בבסיס הנתונים
// ============================================================
// קודם נטענו כל מקטעי המצב וכל הפעולות של הטווח לזיכרון (loadRangeData),
// והחישוב רץ ב-JS לכל אתר. עכשיו site_stats ו-site_uptime מחשבים בתוך
// Postgres ומחזירים שורה לכל אתר.
//
// למה זה עדיף כאן ולא רק "יותר נכון ארכיטקטונית":
//   • הנתונים לא עוברים ברשת. במקום ~840 מקטעים + כל הפעולות של השבוע,
//     חוזרות 13 שורות מסוכמות.
//   • הפעולה החוסמת נעלמת. ההערה ב-CLAUDE.md מזהירה שהמעבר בזיכרון הוא
//     O(אתרים × דליים × פעולות) ושב-200 אתרים × 365 ימים הוא חוסם את
//     לולאת האירועים ל-~26 שניות — ומכיוון ש-Node חד-חוטי, זה עוצר גם את
//     הקליטה. אגרגציה בצד ה-DB אינה חוסמת את הלולאה בכלל.
//   • זו אותה הגדרה שהדשבורד יקרא לה ישירות בהמשך, ולכן אין שתי גרסאות.
//
// NULL = כל האתרים, ולכן שלוש הקריאות עדיין רצות במקביל: אין צורך לשלוף
// קודם את רשימת המזהים.
//
// ⚠️ הפונקציות בזיכרון (statsFromData / uptimeFromData) **נשארות** — הן
// עדיין משמשות מסלולים אחרים (supervisor/executive) שטרם הועברו, והן
// נקודת ההשוואה של tools/parity.js. אין למחוק אותן לפני שגם אלה עברו.
async function getAllSitesWithMetrics({ from, prevFrom = null }) {
  const now = new Date().toISOString();

  // ⚠️ שאילתה חמישית ולא סיבוב נוסף לכל אתר: site_stats מקבלת NULL ומחזירה
  // שורה לכל אתר, ולכן התקופה הקודמת עולה בדיוק כמו הנוכחית — אחת. זה מה
  // ששומר על "מספר שאילתות קבוע ללא תלות במספר האתרים".
  const [sites, statsRows, uptimeRows, globals, prevRows] = await Promise.all([
    getAllSites(),
    db.prepare("SELECT * FROM public.site_stats(NULL, ?, ?)").all(from, now),
    db.prepare("SELECT * FROM public.site_uptime(NULL, ?, ?)").all(from, now),
    getAllSitesGlobals(null),
    prevFrom
      ? db.prepare("SELECT * FROM public.site_stats(NULL, ?, ?)").all(prevFrom, from)
      : Promise.resolve([]),
  ]);
  if (sites.length === 0) return [];

  const statsById = new Map(statsRows.map((r) => [r.site_id, r]));
  const uptimeById = new Map(uptimeRows.map((r) => [r.site_id, r]));
  const prevById = new Map(prevRows.map((r) => [r.site_id, r]));

  return sites.map((site) => {
    // אתר שאין לו שום היסטוריה לא יופיע בשליפות — ואז g היה undefined
    const g = globals.get(site.id) || {
      lastFaultAt: null, statusSince: null, lastOperation: null,
      operationsSinceLastError: 0, activeMaintenance: null, firstStatusAt: null,
    };
    // אתר בלי נתונים בטווח מקבל שורת אפסים מהפונקציה (הנהג הוא טבלת
    // האתרים), ולכן ה-fallback כאן הוא הגנה על מקרה שאתר נמחק בין
    // השליפות — לא מסלול רגיל.
    const stats = statsById.get(site.id)
      || { operations: 0, errors: 0, errors_in_maintenance: 0, failure_rate: 0 };
    const up = uptimeById.get(site.id);

    // חלון תחזוקה ידני פעיל. הוא גובר על מה שה-PLC דיווח (כמו applyMaintenanceStatus):
    // תקלה שקורה בתוך תחזוקה מתוכננת אינה "תקלה" — היא כבר מוחרגת מאחוז הכשל
    // (wasInMaintenance), וכאן היא לא הופכת את הכרטיס ל"מושבת". הדגל נחשף כדי
    // שגם עדכון ה-SSE החי בכרטיס (sitePatch) יכבד את אותו כלל, ולא רק ריענון מלא.
    const inMaintenance = !!g.activeMaintenance;
    const status = inMaintenance || site.status === "maintenance"
      ? "maintenance"
      : site.status;

    return {
      ...site,
      status,
      inMaintenance,
      failureRate: stats.failure_rate,
      operations: stats.operations,
      errors: stats.errors,
      // measured_hours = 0 פירושו "אין נתון", ואז null כדי שהדשבורד יציג
      // "—" ולא "0%". אותו כלל בדיוק כמו getSiteUptime.
      uptime: up && up.measured_hours > 0 ? up.availability_percent : null,
      // null = אין מספיק מדגם להשוואה, ולא "אין שינוי". ראה siteTrend.
      trend: siteTrend(
        { operations: stats.operations, failureRate: stats.failure_rate },
        prevById.get(site.id)
          ? { operations: prevById.get(site.id).operations,
              failureRate: prevById.get(site.id).failure_rate }
          : null
      ),
      lastFaultAt: g.lastFaultAt,
      lastOperation: g.lastOperation,
      // ⚠️ אותו תיקון כמו בזרוע הישירה, ומאותה סיבה: הסטטוס נדרס
      // ל-'maintenance' והזמן נשאר של מקטע הבקר, כך שהכרטיס הראה
      // "השתנה לבתחזוקה לפני 3 שעות" על חלון בן שתי דקות.
      // שתי הזרועות חייבות להחזיר את אותו ערך — check-switch מוודא.
      statusSince: inMaintenance
        ? (g.activeMaintenance?.started_at ?? g.statusSince)
        : g.statusSince,
      // תיאור התקלה הנוכחית — או של זו שמטפלים בה כרגע. ראה getAllSitesGlobals.
      currentFaultText: g.currentFaultText ?? null,
      currentAfterError: g.currentAfterError === true,
    };
  });
}

// uptimeFromDataLegacy הוסרה כאן: היא הייתה עטיפה של uptimeFromData עבור
// getAllSitesWithMetrics בלבד, וזה המסלול שעבר ל-site_uptime ב-SQL. הכלל
// שהיא מימשה — measuredHours = 0 מחזיר null ולא 0% — נשמר במקום שקורא
// לפונקציה, וגם ב-getSiteUptime.
//
// ההערה שהייתה מעליה טענה שהיא מחלקת בכל החלון ולא בזמן הנמדד. זה היה לא
// נכון, וזו הטעות שהובילה לניתוח שגוי ולהחלטת מוצר שלא הייתה קיימת. נמדד
// אז על כל 13 האתרים: הפרש 0 בכל התקופות. שווה לזכור כשמוסיפים עטיפה —
// שם מטעה עולה יותר מקוד מיותר.

// ==========================================================
// ===== אגרגציה מערכתית (מנהל בקרה / מנהל כללי) =====
// ==========================================================

/**
 * גבולות הדליים לתקופה — [{ label, from, to }].
 * נחוץ כדי לחשב מדד *לכל דלי* (למשל זמינות ליום), מה ש-getPeriodBreakdown
 * לא מספק (הוא מחזיר ספירות בלבד).
 */

/**
 * ספירת כניסות/יציאות עבור *קבוצת* אתרים בטווח — שאילתה אחת לכל דלי,
 * ולא אחת לכל אתר לכל דלי (שהיה מכפיל את מספר השאילתות במספר האתרים).
 */
async function getDirectionCounts(siteIds, { from, to }) {
  if (!siteIds || siteIds.length === 0) return { entries: 0, exits: 0 };

  const holes = siteIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT entry_exit, COUNT(*) AS n FROM operations
       WHERE site_id IN (${holes})
         AND occurred_at >= ? AND occurred_at < ?
         AND is_anomaly = 0 AND superseded_by IS NULL AND start_end = 'end'
       GROUP BY entry_exit`
    )
    .all(...siteIds, from, to);

  let entries = 0, exits = 0;
  for (const r of rows) {
    if (r.entry_exit === "entry") entries = r.n;
    else if (r.entry_exit === "exit") exits = r.n;
  }
  return { entries, exits };
}

// כמה פעולות בוצעו מאז התקלה האחרונה (מדד "כמה זמן האתר יציב")
async function getOperationsSinceLastError(siteId) {
  const lastError = await getLastFaultAt(siteId);
  if (!lastError) {
    // מעולם לא הייתה תקלה — סופרים את כל הפעולות
    return (await db.prepare(
      "SELECT COUNT(*) AS n FROM operations WHERE site_id = ? AND is_anomaly = 0 AND superseded_by IS NULL AND start_end = 'end'"
    ).get(siteId)).n;
  }
  return (await db.prepare(
    `SELECT COUNT(*) AS n FROM operations
     WHERE site_id = ? AND is_anomaly = 0 AND superseded_by IS NULL AND start_end = 'end' AND occurred_at > ?`
  ).get(siteId, lastError)).n;
}

/**
 * שורת נתונים מלאה לכל אתר בתקופה — הבסיס גם למנהל הבקרה וגם למנהל הכללי.
 * מרכיב מהפונקציות הקיימות (getSiteStats / getUptimeBreakdown) ולא משכפל לוגיקה.
 */
// ה-loader מוחזר יחד עם השורות, כדי שהמנהל הכללי יוכל להשתמש *באותם*
// נתונים גולמיים לחישוב הדליים של הגרף ומפת החום — בלי לשלוף אותם שוב.
async function getSupervisorStats({ from, to }) {
  const { rows, summary } = await getSupervisorStatsWithData({ from, to });
  return { sites: rows, summary };
}

async function getSupervisorStatsWithData({ from, to }) {
  // null = כל האתרים. כך שלוש הקבוצות רצות *במקביל* — קודם היינו מחכים
  // לרשימת האתרים (סיבוב רשת שלם) רק כדי לדעת אילו מזהים לבקש.
  const [sites, data, globals] = await Promise.all([
    getAllSites(),
    loadRangeData(null, { from, to }),
    getAllSitesGlobals(null),
  ]);

  const rows = sites.map((site) => {
    // אתר בלי שום היסטוריה לא מופיע בשליפות — ואז אין לו רשומה במפה
    const g = globals.get(site.id) || {
      lastFaultAt: null, statusSince: null, lastOperation: null,
      operationsSinceLastError: 0, activeMaintenance: null, firstStatusAt: null,
    };
    const stats = statsFromData(data, site.id, { from, to });
    const uptime = uptimeFromData(data, site.id, { from, to });
    const activeMaint = g.activeMaintenance;

    // המצב האפקטיבי: תחזוקה ידנית פעילה גוברת על מה שה-PLC דיווח
    const status = activeMaint || site.status === "maintenance" ? "maintenance" : site.status;

    return {
      code: site.code,
      name: site.site_name,
      status,
      // דרגת האתר והפעולה האחרונה — לצורך מיון ברירת-המחדל בטבלת הבקרה
      // (מצב → דרגה → אחוז כשל). כבר טעונים כאן, בלי שאילתה נוספת.
      tier: site.tier,
      lastOperation: g.lastOperation,
      operations: stats.operations,
      errors: stats.errors,
      failureRate: stats.failureRate,
      availability: uptime.availabilityPercent,
      // הזמן *הנמדד* (בלי תחזוקה) — אתר שהיה בתחזוקה כל התקופה אין
      // עליו נתון זמינות, ואסור להציג לו 0%.
      hasUptimeData: uptime.measuredHours > 0,
      maintenanceHours: uptime.maintenanceHours,
      downtimeHours: uptime.errorHours,
      lastError: g.lastFaultAt,
      operationsSinceLastError: g.operationsSinceLastError,
      // "מונה מחזורים" = המונה הפיזי האמיתי של המכונה (הגולמי מהבקר), ולא
      // cycle_total (שהוא "גידול מאז ההתקנה" ולכן ≤ מספר הפעולות באתר חדש —
      // מבלבל). עקבי עם פאנל הפירוט (totalFromPLC) ועם כרטיס האתר.
      cycleTotal: site.plc_cycle_last,
      // לא ניתן לחישוב: המונה אינו נשמר לכל פעולה (ראה getCycleDelta)
      cycleDelta: null,
      inManualMaintenance: Boolean(activeMaint),
    };
  });

  // שתי שאלות שונות לגמרי, ואסור לערבב ביניהן:
  //   sitesInError      — כמה אתרים *מושבתים ברגע זה* (מצב נוכחי, כמו בתחזוקה/ללא תקשורת)
  //   sitesWithErrors   — בכמה אתרים *הייתה* תקלה כלשהי בתקופה הנבחרת (מצטבר)
  // אתר שנפל והתאושש נספר ב-sitesWithErrors אבל לא ב-sitesInError.
  const summary = {
    totalSites: rows.length,
    sitesInError: rows.filter((r) => r.status === "error").length,
    sitesWithErrors: rows.filter((r) => r.errors > 0).length,
    sitesInMaintenance: rows.filter((r) => r.status === "maintenance").length,
    sitesOffline: rows.filter((r) => r.status === "no_comm").length,
  };

  // data ו-globals נמסרים הלאה: המנהל הכללי מחשב מהם את דליי הגרף ואת מפת
  // החום *בלי אף שאילתה נוספת*. זה מה שהופך את המנהל הכללי מ-100 שאילתות
  // לספרה חד-ספרתית.
  return { rows, summary, data, sites };
}

// התקלות האחרונות בכל המערכת (חוצה אתרים)
//
// ⚠️ המרכאות הכפולות סביב ה-aliases אינן קישוט. Postgres מקטין כל מזהה
// שאינו מצוטט לאותיות קטנות, ולכן `AS siteCode` היה חוזר כ-`sitecode`
// ו-r.siteCode היה undefined — האובייקט היה נבנה ריק, בלי שאף שגיאה תיזרק.
// SQLite שימר את הרישיות ולכן זה עבד שם. זה ההבדל היחיד ב-SQL שבאמת נשך.
async function getRecentErrors({ limit = 10 } = {}) {
  return (await db
    .prepare(
      // faultText — תיאור התקלה מהבקר. ⚠️ זו הרשימה שאנשים קוראים כדי
      // להבין **מה קרה**, ובלי התיאור כל שורה בה זהה לשנייה: אתר, שעה,
      // משך. הטקסט הוא ההבדל בין רשימת אירועים לבין רשימת תקלות.
      `SELECT s.code AS "siteCode", s.site_name AS "siteName",
              h.started_at AS "startedAt", h.ended_at AS "endedAt",
              h.fault_text AS "faultText"
       FROM status_history h
       JOIN sites s ON h.site_id = s.id
       WHERE COALESCE(h.reclassified_to, h.status) = 'error'
         -- "תחזוקה גוברת" — תקלה שהתחילה בתוך/בגבול תחזוקה לא מוצגת (כמו שהיא
         -- לא נספרת). מקור 1: מקטע maintenance מהבקר. גבול כולל כמו wasInMaintenanceMem.
         AND NOT EXISTS (
           SELECT 1 FROM status_history m
           WHERE m.site_id = h.site_id AND COALESCE(m.reclassified_to, m.status) = 'maintenance'
             AND m.started_at <= h.started_at
             AND (m.ended_at IS NULL OR m.ended_at >= h.started_at)
         )
         -- מקור 2: חלון תחזוקה ידני מה-dashboard.
         AND NOT EXISTS (
           SELECT 1 FROM maintenance_windows w
           WHERE w.site_id = h.site_id
             AND w.started_at <= h.started_at
             AND COALESCE(w.cancelled_at, w.expires_at) >= h.started_at
         )
       ORDER BY h.started_at DESC
       LIMIT ?`
    )
    .all(limit))
    .map((r) => {
      const end = r.endedAt ? Date.parse(r.endedAt) : Date.now();
      const ms = Math.max(0, end - Date.parse(r.startedAt));
      return {
        ...r,
        ongoing: !r.endedAt,
        durationMinutes: Math.round(ms / 60000),
        // ההשבתות הקצרות הן רוב הרשימה, ובדקות מעוגלות כולן נראות "0 דק'" —
        // כלומר בדיוק המידע שמבדיל בין הבהוב של 3 שניות לתקלה של 50 אובד.
        // השרת שולח את המשך המדויק, והתצוגה בוחרת יחידה (ראה formatOutage).
        durationSeconds: Math.round(ms / 1000),
      };
    });
}

// כל חלונות התחזוקה הידניים שפעילים כרגע
async function getActiveMaintenances() {
  const now = new Date().toISOString();
  return await db
    .prepare(
      `SELECT s.code AS "siteCode", s.site_name AS "siteName",
              m.set_by_name AS "setBy", m.reason, m.started_at AS "startedAt",
              m.expires_at AS "expiresAt"
       FROM maintenance_windows m
       JOIN sites s ON m.site_id = s.id
       -- ⚠️ גם started_at: פאנל "תחזוקות פעילות" הציג חלונות שטרם התחילו.
       WHERE m.cancelled_at IS NULL
         AND m.started_at <= ? AND m.expires_at > ?
       ORDER BY m.expires_at ASC`
    )
    .all(now, now);
}



/**
 * מפת חום: שורה לכל אתר, תא לכל דלי — עוצמת הפעילות.
 *
 * גרסת הזיכרון: מקבלת את הנתונים הגולמיים שכבר נשלפו (data) ולא מריצה
 * אף שאילתה. הגרסה הישנה קראה ל-getPeriodBreakdown לכל אתר — כלומר
 * שאילתה לכל אתר, ובגרנולריות יומית זה הצטבר מהר.
 */

/**
 * מפת חום — נשמרה לתאימות (משמשת קוד חיצוני/בדיקות). שולפת בעצמה.
 */
async function getSystemHeatmap({ from, to, granularity }) {
  const sites = await getAllSites();
  const buckets = getBucketRanges({ from, to, granularity });
  const data = await loadRangeData(sites.map((s) => s.id), { from, to });
  return heatmapFromData(data, sites, buckets);
}

/**
 * תמונה עסקית כוללת של כל המערכת.
 * rows מגיע מ-getSupervisorStats כדי לא לחשב את אותם מדדים פעמיים.
 */
async function getExecutiveStats({ from, to, granularity }) {
  const { rows, data, sites: allSites } = await getSupervisorStatsWithData({ from, to });

  const sum = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const totalOperations = sum("operations");
  const totalErrors = sum("errors");

  // ממוצע זמינות — רק על אתרים שיש עליהם נתוני מצב, אחרת אתר חדש
  // שמעולם לא דיווח היה גורר את הממוצע ל-0 ומעוות את התמונה.
  const withData = rows.filter((r) => r.hasUptimeData);
  const avgAvailability = withData.length
    ? Math.round((withData.reduce((s, r) => s + r.availability, 0) / withData.length) * 100) / 100
    : 0;

  const sitesByStatus = { ready: 0, operating: 0, error: 0, maintenance: 0, no_comm: 0 };
  for (const r of rows) {
    if (sitesByStatus[r.status] !== undefined) sitesByStatus[r.status]++;
  }

  const kpis = {
    totalSites: rows.length,
    activeSites: sitesByStatus.ready + sitesByStatus.operating,
    totalOperations,
    totalErrors,
    // אחוז כשל מערכתי = סך התקלות ÷ סך הפעולות (ולא ממוצע של אחוזים,
    // שהיה נותן משקל זהה לאתר עם 2 פעולות ולאתר עם 2000)
    avgFailureRate: totalOperations > 0
      ? Math.round((totalErrors / totalOperations) * 10000) / 100
      : 0,
    avgAvailability,
    totalMaintenanceHours: Math.round(sum("maintenanceHours") * 100) / 100,
    totalDowntimeHours: Math.round(sum("downtimeHours") * 100) / 100,
  };

  // ===== גרף לאורך זמן =====
  const buckets = getBucketRanges({ from, to, granularity });

  // אפס שאילתות בלולאה הזו: הכול מחושב מהנתונים שכבר בזיכרון.
  const chart = buckets.map((b) => {
    let ops = 0, errs = 0, availSum = 0, availCount = 0;

    for (const site of allSites) {
      const st = statsFromData(data, site.id, { from: b.from, to: b.to });
      ops += st.operations;
      errs += st.errors;

      const up = uptimeFromData(data, site.id, { from: b.from, to: b.to });
      if (up.measuredHours > 0) {
        availSum += up.availabilityPercent;
        availCount++;
      }
    }

    return {
      label: b.label,
      operations: ops,
      errors: errs,
      availability: availCount ? Math.round((availSum / availCount) * 100) / 100 : null,
    };
  });

  return {
    kpis,
    sitesByStatus,
    topPerformers: getTopPerformers(rows),
    worstPerformers: getWorstPerformers(rows),
    chart,
    heatmap: heatmapFromData(data, allSites, buckets),
  };
}

/**
 * גרסה מסוננת ומפולחת של התמונה העסקית — הבסיס לכלי הניתוח של המנהל הכללי.
 *
 * siteCodes      — רשימת קודי אתרים. ריק/undefined = כל האתרים.
 * statuses       — סינון לפי מצב נוכחי. ריק = כל המצבים.
 * minFailureRate — רק אתרים שאחוז הכשל שלהם מעל הסף.
 * groupBy        — 'site' | 'status' | 'time'
 * granularity    — 'day' | 'week' | 'month' (רזולוציית הגרף)
 *
 * הסינון מוחל *לפני* חישוב ה-KPIs, כך שכל המספרים במסך עקביים עם מה שנבחר.
 */
async function getExecutiveStatsFiltered({
  from, to, siteCodes, statuses, minFailureRate = 0,
  groupBy = "site", granularity = "day",
}) {
  // ============================================================
  // שליפה אחת, וכל השאר חישוב טהור
  // ============================================================
  // data ו-sites משמשים את *כל* החישובים — הדליים, מפת החום והפילוחים —
  // בלי אף שאילתה נוספת. זה מה שהפך את המסך הזה מ-100 שאילתות לספרה
  // חד-ספרתית.
  //
  // ⚠️ ומכאן והלאה **אין גישה ל-DB**, וזה מה שמאפשר לדשבורד להריץ את אותו
  // חישוב בעצמו על שורות שהוא שלף מ-Supabase. ראה shared/executive.mjs.
  const { rows: allRows, data, sites: allSites } = await getSupervisorStatsWithData({ from, to });

  return computeExecutive({
    allRows, data, allSites, from, to,
    siteCodes, statuses, minFailureRate, groupBy, granularity,
  });
}

// ==========================================================
// ===== ניהול: קוד מנהל + עריכת/מחיקת אתרים =====
// ==========================================================

const crypto = require("crypto");

const ADMIN_KEY = "admin_code_hash";
const DEFAULT_ADMIN_CODE = "admin123";

// הקוד נשמר כ-hash ולא כטקסט גלוי, כדי שמי שמציץ במסד לא יקרא אותו ישירות.
// שימו לב: זו *לא* מערכת הרשאות אמיתית — ראה README.
function hashCode(code) {
  return crypto.createHash("sha256").update(String(code), "utf8").digest("hex");
}

// ============================================================
// events — רישום אירוע סמנטי אחד
// ============================================================
// המטענה נרשמת *כפי שהיא נשלחת ל-SSE*, בלי עיבוד. site_id נגזר מהקוד
// בתוך אותה שאילתה (תת-שאילתה ולא lookup נפרד) כדי לא להוסיף סיבוב רשת
// לכל הודעה נכנסת. אתר שאינו קיים נותן NULL ב-site_id, וזה תקין: הקוד
// נשמר ב-site_code והאירוע שורד.
async function recordEvent(payload) {
  const code = String(payload?.code ?? "");
  return await db
    .prepare(
      `INSERT INTO events (site_id, site_code, type, payload, created_at)
       VALUES ((SELECT id FROM sites WHERE code = ?), ?, ?, ?::jsonb, ?)
       RETURNING id`
    )
    .run(code, code, String(payload?.type ?? "unknown"), JSON.stringify(payload ?? {}),
         new Date().toISOString());
}

/**
 * אירועים שאחרי סמן נתון — זה ה-replay.
 *
 * הדשבורד שומר את ה-id האחרון שראה; אחרי ניתוק הוא מבקש את מה שאחריו
 * ומשלים את הפער. ה-SSE לבדו לא יכול לזה — הודעה שנשלחה לטאב מנותק אבדה.
 *
 * limit הוא תקרה קשה: אחרי ניתוק ארוך עדיף להחזיר את ההתחלה ולתת ללקוח
 * לבקש שוב, מאשר לשלוף מאה אלף שורות לזיכרון.
 */
async function getEventsSince(afterId, limit = 500) {
  const rows = await db
    .prepare(
      `SELECT id, site_code, type, payload, created_at
         FROM events
        WHERE id > ?
        ORDER BY id
        LIMIT ?`
    )
    .all(Number(afterId) || 0, Math.min(Math.max(Number(limit) || 500, 1), 2000));
  return rows;
}

/** ה-id הגבוה ביותר — הסמן שממנו לקוח חדש מתחיל להאזין. */
async function getLatestEventId() {
  const row = await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get();
  return row.id;
}

// גריפת רטנציה. שבעה ימים ולא שנה: הטבלה הזו נועדה ל-replay אחרי ניתוק,
// שנמדד בדקות עד שעות. ההיסטוריה האמיתית יושבת ב-status_history
// וב-operations, ואינה תלויה בטבלה הזו.
async function pruneEvents(retentionDays = 7) {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  const res = await db.prepare("DELETE FROM events WHERE created_at < ?").run(cutoff);
  return res.changes;
}

async function getSetting(key) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, new Date().toISOString());
}

// נזרע בהרצה הראשונה בלבד — שינוי הקוד לא נדרס בהפעלה מחדש
async function ensureAdminCode() {
  if (!await getSetting(ADMIN_KEY)) {
    await setSetting(ADMIN_KEY, hashCode(DEFAULT_ADMIN_CODE));
  }
}

async function verifyAdminCode(code) {
  if (!code) return false;
  const stored = await getSetting(ADMIN_KEY);
  if (!stored) return false;

  // השוואה בזמן קבוע — מונעת דליפת מידע דרך זמן התגובה
  const a = Buffer.from(hashCode(code), "hex");
  const b = Buffer.from(stored, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function setAdminCode(newCode) {
  await setSetting(ADMIN_KEY, hashCode(newCode));
}

/**
 * עדכון אתר: שם ו/או קוד.
 * שינוי הקוד הוא פעולה עדינה — הוא ה-{code} בנתיב ה-MQTT, ולכן משנה
 * *לאיזה אתר* משויכות ההודעות הנכנסות. ההיסטוריה הקיימת עוברת איתו (site_id
 * לא משתנה), אבל הסוכן בשטח חייב להתעדכן גם הוא, אחרת הודעותיו יידחו.
 */
async function updateSite(currentCode, { newCode, siteName, tier, plcType }) {
  const site = await findSiteByCode(currentCode);
  if (!site) return { ok: false, reason: "not_found" };

  if (newCode && newCode !== currentCode && await findSiteByCode(newCode)) {
    return { ok: false, reason: "code_taken" };
  }

  const fields = [];
  const params = [];
  if (newCode && newCode !== currentCode) { fields.push("code = ?"); params.push(newCode); }
  if (siteName) { fields.push("site_name = ?"); params.push(siteName); }
  if (tier) { fields.push("tier = ?"); params.push(tier); }

  // ==========================================================
  // סוג המתקן — '' פירושו **ניקוי**, ולכן נבדק undefined ולא truthy
  // ==========================================================
  // ⚠️ שלוש השורות מעל משתמשות בבדיקת truthy, וזה נכון עבורן: שם ריק, קוד
  // ריק או דרגה ריקה אינם ערכים חוקיים ואין משמעות ל"נקה אותם".
  //
  // כאן זה הפוך. זהו שדה אופציונלי, ו"האתר הזה כבר לא דולי" היא פעולה
  // לגיטימית שחייבת דרך לבצע. בדיקת truthy הייתה בולעת אותה בשקט: המשתמשת
  // בוחרת "לא הוגדר", לוחצת שמור, מקבלת אישור — והערך הישן נשאר.
  //
  // ההבחנה: `undefined` = השדה לא נשלח בכלל (עדכון חלקי). `''` = נשלח ריק
  // במפורש → נשמר כ-NULL, כדי שלא יהיו במסד גם '' וגם NULL לאותו מצב.
  if (plcType !== undefined) { fields.push("plc_type = ?"); params.push(plcType || null); }

  if (fields.length === 0) return { ok: true, site };

  params.push(site.id);
  await db.prepare(`UPDATE sites SET ${fields.join(", ")} WHERE id = ?`).run(...params);

  return { ok: true, site: await findSiteByCode(newCode || currentCode) };
}

/**
 * מחיקת אתר. ה-cascade שבסכמה מוחק גם את כל ההיסטוריה שלו
 * (operations, status_history, maintenance_windows, monthly_summary).
 */
async function deleteSite(code) {
  const site = await findSiteByCode(code);
  if (!site) return { ok: false, reason: "not_found" };

  const counts = {
    operations: (await db.prepare("SELECT COUNT(*) n FROM operations WHERE site_id = ?").get(site.id)).n,
    statusHistory: (await db.prepare("SELECT COUNT(*) n FROM status_history WHERE site_id = ?").get(site.id)).n,
  };

  await db.prepare("DELETE FROM sites WHERE id = ?").run(site.id);
  return { ok: true, deleted: { code: site.code, name: site.site_name, ...counts } };
}

// ===== תחזוקת נתונים (summary / cleanup / backup) =====

// האם קיים סיכום חודשי לאתר+חודש
async function hasMonthlySummary(siteId, yearMonth) {
  return !!await db.prepare(
    "SELECT 1 FROM monthly_summary WHERE site_id = ? AND year_month = ?"
  ).get(siteId, yearMonth);
}

// חודשים ייחודיים עם נתוני raw לפני חודש-חתך (איחוד מכל טבלאות ה-raw)
async function getRawMonthsBefore(cutoffMonth) {
  return (await db.prepare(
    `SELECT DISTINCT substr(occurred_at, 1, 7) AS ym FROM operations WHERE substr(occurred_at, 1, 7) < ?
     UNION
     SELECT DISTINCT substr(started_at, 1, 7) AS ym FROM status_history WHERE substr(started_at, 1, 7) < ?
     UNION
     SELECT DISTINCT substr(started_at, 1, 7) AS ym FROM maintenance_windows WHERE substr(started_at, 1, 7) < ?
     ORDER BY ym`
  ).all(cutoffMonth, cutoffMonth, cutoffMonth)).map((r) => r.ym);
}

// מחיקת נתוני raw בטווח [monthStart, monthEnd) מכל שלוש הטבלאות
async function deleteRawInRange(monthStart, monthEnd) {
  const operations = (await db.prepare(
    "DELETE FROM operations WHERE occurred_at >= ? AND occurred_at < ?"
  ).run(monthStart, monthEnd)).changes;
  // לא מוחקים את השורה הפתוחה (ended_at IS NULL) — היא המצב הנוכחי של האתר.
  // אתר יציב מעל שנה עלול להחזיק שורה פתוחה ישנה; מחיקתה תשבש את
  // getCurrentStatusSince ו-getSiteUptime בזמן שהמצב עצוב עדיין ב-sites.status.
  const statusHistory = (await db.prepare(
    "DELETE FROM status_history WHERE started_at >= ? AND started_at < ? AND ended_at IS NOT NULL"
  ).run(monthStart, monthEnd)).changes;
  const maintenance = (await db.prepare(
    "DELETE FROM maintenance_windows WHERE started_at >= ? AND started_at < ?"
  ).run(monthStart, monthEnd)).changes;
  return { operations, statusHistory, maintenance };
}

// גיבוי: היה עוטף את backup API של better-sqlite3. ב-Postgres אין מקבילה
// ברמת הדרייבר (גיבוי נעשה ב-pg_dump, או אוטומטית ע"י Supabase), ולכן
// הפונקציה זורקת במקום להעמיד פנים שגיבתה. ראה tools/backup-db.js.
function backupDatabase() {
  throw new Error(
    "backupDatabase לא נתמך ב-PostgreSQL. Supabase מגבה אוטומטית; " +
    "לגיבוי מקומי השתמש ב-pg_dump."
  );
}

module.exports = {
  // ---- שכבת ה-batch (הפתרון ל-N+1) ----
  getAllSitesWithMetrics,   // GET /api/sites — כל האתרים, מספר שאילתות קבוע
  getAllSitesGlobals,       // מדדים לא-תלויי-טווח לכל האתרים בבת אחת
  loadRangeData,            // שליפת הנתונים הגולמיים לטווח (3 שאילתות)
  statsFromData,            // = getSiteStats, מהזיכרון
  collapseNoCommFlicker,    // נחשף כדי ש-tools/parity.js יוכל להשוות מול ה-SQL
  uptimeFromData,           // = getUptimeBreakdown, מהזיכרון
  directionFromData,        // = getDirectionCounts, מהזיכרון
  getBucketRanges,
  getDirectionCounts,
  wasInMaintenance,
  wasInMaintenanceMem,

  findSiteByCode,
  insertSite,
  insertOperation,
  inheritCardFromStart,
  supersedeInterruptedAttempt,   // ניסיון חוזר מאחד את הניסיון שנקטע
  supersedeFlicker,              // ריצוד MODE — מעבר אחד שנרשם כשניים
  RETRY_MERGE_WINDOW_MS,   // השלמת כרטיס שאבד בין start ל-end (ראה ההסבר שם)
  applyCycleCounter,
  decideCycleUpdate,   // טהורה — נבדקת ישירות ב-tests/cycle-counter.test.js
  RESET_PLAUSIBLE_MAX,
  updateSiteStatus,
  updateLastSeen,
  closeOpenStatus,
  insertStatusHistory,
  applyStateChange,
  getAllSites,
  getCurrentStatusSince,
  getStatusHistory,
  getMaintenanceHistory,
  getRecentOperations,
  getFilteredOperations,
  startMaintenance,
  getActiveMaintenance,
  recordBridgeState,
  cancelMaintenance,
  getSiteStats,
  getSiteUptime,
  getOperationsSinceLastError,
  getLastFaultAt,
  getLastOperation,
  updateLastSeenIfNewer,
  getOpenStatusStartedAt,
  getUptimeBreakdown,
  getCycleDelta,
  getPeriodBreakdown,
  getSiteAnalyticsData,
  getCardFaultCorrelation,
  getSiteInsights,
  getGlobalInsights,
  getActivityLog,
  getGlobalActivityLog,
  // מיוצא לבדיקות: פונקציה טהורה שמחליטה מה מוצג, באיזה סדר, ומה נספר.
  // זו ההחלטה שנשברה שלוש פעמים בתצוגה, ולכן היא נעולה בבדיקות.
  buildActivityLog,
  buildTimeline,
  LOG_FILTERS,
  OP_PAIR_TOLERANCE_SECONDS,
  getSupervisorStats,
  getExecutiveStats,
  getExecutiveStatsFiltered,
  ensureAdminCode,
  verifyAdminCode,
  setAdminCode,
  updateSite,
  deleteSite,
  getRecentErrors,
  getActiveMaintenances,
  recordEvent,              // נקרא מ-bus.publish — נקודת הרישום היחידה
  getEventsSince,           // ה-replay
  getLatestEventId,
  pruneEvents,
  getSystemHeatmap,
  generateMonthlySummary,
  getSystemSummary,
  getSystemMonthlyBreakdown,
  getSiteMonthsReport,       // אתר × חודש (report_site_months)
  getSiteReport,             // דוח לכל אתר: תקלות ומחזורים (report_by_site)
  getMonthlyReport,          // דוח חודשי לטווח חופשי (report_monthly)
  hasMonthlySummary,
  getRawMonthsBefore,
  deleteRawInRange,
  backupDatabase,
};
// ============================================================
// תפקיד המשתמש — **מהטבלה, לא מהאסימון**
// ============================================================
// ⚠️ `parkomat_role` באסימון נכתב פעם אחת בהרשמה ותקף שעה. בקר שקודם
// למנהל, או מנהל שהושבת, ממשיך לשאת את התביעה הישנה עד שהאסימון יפוג —
// כלומר עד שעה שלמה של הרשאה שגויה, לשני הכיוונים.
//
// לכן `app_users` הוא מקור האמת, בדיוק כפי שקובעת `app.current_app_role()`
// במסד. שאילתה אחת לבקשה, ורק על נתיבי ניהול המשתמשים — נדירים ממילא.
//
// ⚠️ `is_active` נבדק כאן ולא רק התפקיד: משתמש שהושבת אינו "בקר", הוא
// אינו כלום. בלי התנאי הזה, השבתה הייתה מסירה הרשאות ניהול ומשאירה גישה.
async function getAppUserByUid(uid) {
  if (!uid) return null;
  return db
    .prepare(
      `SELECT id, email, full_name, role, is_active
         FROM app_users
        WHERE supabase_uid::text = ? AND is_active
        LIMIT 1`,
    )
    .get(String(uid));
}

/**
 * איתור לפי מייל — **רק למסלול ההזמנה**, כדי לקבוע דרגה לשורה שהטריגר
 * זה עתה יצר.
 *
 * ⚠️ בלי `is_active` בכוונה, בשונה מ-`getAppUserByUid`: כאן לא נבדקת
 * הרשאה של אף אחד אלא מאותרת שורה שנוצרה לפני שנייה. סינון על is_active
 * היה מחזיר ריק דווקא כשמזמינים מחדש מישהו שהושבת בעבר — כלומר משאיר
 * אותו בדרגה הישנה בשקט.
 */
async function getAppUserByEmail(email) {
  if (!email) return null;
  return db
    .prepare(
      `SELECT id, email, full_name, role, is_active
         FROM app_users
        WHERE LOWER(email) = LOWER(?)
        LIMIT 1`,
    )
    .get(String(email));
}

/** כל המשתמשים, לניהול. מושבתים כלולים — הם חלק מהתמונה. */
async function listAppUsers() {
  return db
    .prepare(
      // ⚠️ `supabase_uid` נבחר במפורש — הוא **היה חסר**, ושני מסלולים הסתמכו
      // עליו: עדכון הדרגה ב-app_metadata (`adminUsers.setRole`) קיבל
      // `undefined` ונכשל **בשקט** בתוך ה-catch שלו, ולכן שינוי דרגה נכתב
      // אצלנו ולא הגיע לאסימון — כלומר RLS המשיך לראות את הדרגה הישנה.
      // אינו נחשף החוצה: `GET /api/users` בורר שדות בעצמו.
      `SELECT id, email, full_name, role, is_active, created_at, disabled_at, supabase_uid
         FROM app_users ORDER BY is_active DESC, role, email`,
    )
    .all();
}

/**
 * השבתה או החזרה לפעילות.
 *
 * ⚠️ **הפעולה ההפיכה מבין השתיים.** `is_active=false` מנתק את הגישה
 * ומשאיר את השורה, כך שאפשר להחזיר. `deleteAppUser` מסיר אותה לגמרי
 * ואי אפשר לחזור ממנו — ראה שם.
 */
// ⚠️ **`byAppUserId` הוא מזהה מספרי, ולא מייל — וזה היה באג שהשבית את
// ההשבתה לחלוטין.** `disabled_by` מוגדר בסכמה כ-
// `INTEGER REFERENCES app_users(id)`, בעוד הנתיב העביר לכאן את
// `req.actor.name`, כלומר כתובת מייל. Postgres דחה כל קריאה עם
//
//     column "disabled_by" is of type integer but expression is of type text
//
// והנתיב החזיר 500. כלומר כפתור ההשבתה במסך **מעולם לא עבד** — והתסמין
// היה "שגיאה בעדכון המשתמש", שנראה כמו תקלה חולפת ולא כמו יכולת חסרה.
// שם הפרמטר הישן (`byEmail`) הוא מה שהסגיר את אי-ההתאמה.
async function setAppUserActive(id, active, byAppUserId) {
  const r = await db
    .prepare(
      `UPDATE app_users
          SET is_active = ?,
              disabled_at = CASE WHEN ? THEN NULL ELSE ? END,
              disabled_by = CASE WHEN ? THEN NULL ELSE ?::integer END
        WHERE id = ?`,
    )
    .run(active, active, new Date().toISOString(), active, byAppUserId ?? null, id);
  return r;
}

module.exports.getAppUserByUid = getAppUserByUid;
module.exports.listAppUsers = listAppUsers;
module.exports.setAppUserActive = setAppUserActive;

/**
 * שינוי תפקיד. app_users הוא הסמכות — requireManager קורא ממנו,
 * ו-app.current_app_role() במסד קורא ממנו.
 *
 * ⚠️ הכלל **מי** מותר לשנות חי ב-auth/deactivation.js ונבדק שם
 * כהתנהגות. כאן רק הכתיבה.
 */
async function setAppUserRole(id, role) {
  return db.prepare("UPDATE app_users SET role = ? WHERE id = ?").run(role, id);
}

module.exports.setAppUserRole = setAppUserRole;
module.exports.getAppUserByEmail = getAppUserByEmail;

/**
 * מחיקה מלאה של שורת המשתמש.
 *
 * ⚠️ **מה ששורד את המחיקה, ולמה זה לא מקרי.** `audit_log.actor_name` ו-
 * `maintenance_windows.set_by_name` הם **צילומי טקסט בלי FK** — כלומר
 * שורת ביקורת ממשיכה לומר מי עשה מה גם כשהמשתמש כבר לא קיים. שתי
 * ההצבעות הפנימיות (`created_by`, `disabled_by`) מתאפסות ל-NULL דרך
 * ON DELETE SET NULL בסכמה.
 *
 * ⚠️ מחזיר את השורה שנמחקה: הנתיב צריך את `supabase_uid` כדי למחוק גם
 * בצד Supabase, ואת המייל לשורת הביקורת — ואחרי המחיקה אי אפשר לשלוף
 * אותם יותר.
 */
async function deleteAppUser(id) {
  return db
    .prepare("DELETE FROM app_users WHERE id = ? RETURNING id, email, role, supabase_uid")
    .get(id);
}

module.exports.deleteAppUser = deleteAppUser;

// ============================================================
// recordAudit — ועד עכשיו השרת לא כתב לטבלה הזו כלום
// ============================================================
// ⚠️ **נמדד: `audit_log` הכיל אפס שורות `user.%`.** שלושת נתיבי ניהול
// המשתמשים — הזמנה, השבתה/תפקיד, ומחיקה — כתבו `console.log` בלבד. לוג
// שנעלם עם הקונטיינר.
//
// ⚠️ וזה נתפס בדרך הגרועה: משתמש **נמחק בפועל**, וכשנשאל מי מחק אותו ומתי
// לא הייתה תשובה בשום מקום. המחיקה היא הפעולה הבלתי-הפיכה היחידה בניהול
// המשתמשים, והיא הייתה גם היחידה בלי שום תיעוד עמיד.
//
// ⚠️ ולמה לא לקרוא ל-`app.record_write_audit` שקיים ב-SQL: הוא שולף את
// הפועל מ-`app.current_actor()`, שקורא תביעת JWT — ולשרת אין אחת, הוא
// מתחבר כ-`postgres`. הוא גם מקבע `trust='token'`. כאן הערכים מפורשים,
// כולל `ip`, שדווקא **כן** קיים בשרת ואינו קיים ב-SQL.
//
// ⚠️ התחילית `user.` נושאת את כל ההרשאה: מדיניות `audit_log` מסתירה
// `user.%` מבקרים. פעולה שתיקרא אחרת תהיה גלויה לכולם, בלי שגיאה ובלי סימן.
async function recordAudit({
  action, actorId = null, actorName, actorRole = null, trust = "anonymous",
  targetType = null, targetId = null, targetName = null, details = null, ip = null,
}) {
  // ⚠️ נכשל בשקט ואינו מפיל את הפעולה. שורת ביקורת שלא נכתבה היא אובדן
  // מידע; פעולה שנפלה **בגלל** שורת הביקורת היא אובדן הפעולה — והמשתמשת
  // הייתה רואה "המחיקה נכשלה" על מחיקה שכן בוצעה ב-Supabase.
  try {
    await db.prepare(
      `INSERT INTO audit_log
         (at, actor_id, actor_name, actor_role, trust, action,
          target_type, target_id, target_name, details, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(), actorId, actorName || "לא ידוע", actorRole, trust, action,
      targetType, targetId === null ? null : String(targetId), targetName,
      details === null ? null : JSON.stringify(details), ip,
    );
  } catch (err) {
    console.error("[audit] כתיבת שורת ביקורת נכשלה:", err.message);
  }
}

module.exports.recordAudit = recordAudit;

// ============================================================
// תקלות שהושמטו בזמן תחזוקה
// ============================================================
// ⚠️ **אף מדד אינו קורא מהטבלה הזו, וזו התכונה המרכזית שלה.** אחוז הכשל,
// הזמינות והפילוחים לא יכולים להשתנות ממנה — לא היום ולא בשינוי עתידי
// שמישהו ישכח לסנן בו. היא נקראת אך ורק בלוג הפעילות.
//
// ראה ההסבר המלא ב-schema.postgres.sql.

/**
 * רושם תקלה שהגיעה בזמן תחזוקה ולכן הושמטה מהמדדים.
 *
 * ⚠️ `ON CONFLICT DO NOTHING` ולא UPSERT: מסירה חוזרת של QoS-1 היא מקרה
 * רגיל ב-MQTT. עדכון היה יכול לדרוס תיאור תקין בתיאור ריק ממסירה שנייה.
 */
async function insertSuppressedFault({ siteId, occurredAt, faultText, reason }) {
  return db.prepare(
    `INSERT INTO suppressed_faults (site_id, occurred_at, fault_text, reason, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (site_id, occurred_at) DO NOTHING`
  ).run(siteId, occurredAt, faultText ?? null, reason, new Date().toISOString());
}

/** תקלות מושמטות בטווח — ללוג הפעילות בלבד. */
async function getSuppressedFaults(siteIds, { from, to }) {
  const all = siteIds === null;
  const holes = all ? "TRUE" : `site_id IN (${siteIds.map(() => "?").join(",")})`;
  const params = all ? [] : siteIds;

  return db.prepare(
    `SELECT f.site_id, f.occurred_at, f.fault_text, f.reason, s.site_name
       FROM suppressed_faults f
       JOIN sites s ON s.id = f.site_id
      WHERE ${holes} AND f.occurred_at >= ? AND f.occurred_at < ?
      ORDER BY f.occurred_at ASC`
  ).all(...params, from, to);
}

module.exports.insertSuppressedFault = insertSuppressedFault;
module.exports.getSuppressedFaults = getSuppressedFaults;

// ⚠️ `setSetting` היה מוגדר ולא מיוצא. אות החיים של השרת (keep-alive
// ב-master.js) קורא לו, ובלי השורה הזו הוא `undefined` — כלומר שגיאה כל 20
// שניות בלוג, ובאנר "הנתונים אינם מתעדכנים" שנדלק על מערכת תקינה לגמרי.
module.exports.setSetting = setSetting;

// ============================================================
// ingest_drops — רישום כל הודעה שהגיעה ולא נכתבה
// ============================================================
// ⚠️ **נולד מאובדן אמיתי.** אתר היה בתקלה שלוש שעות והמסך הראה "בפעולה".
// הסוכן שידר, HiveMQ אישר ב-PUBACK, וההודעה נעלמה אצלנו — ואת ה"למה"
// איבדנו כי הקונטיינר נוצר מחדש והלוג נמחק איתו.
//
// ⚠️ **הכתיבה כאן לעולם אינה מפילה את הקליטה.** זהו רישום לאבחון, ולא
// נתון שמשהו נשען עליו. הודעה שאבדה בגלל הכשל **ברישום** של הודעה שאבדה
// היא בדיוק האבסורד שהטבלה הזו קיימת כדי למנוע. אותו נימוק בדיוק כמו
// ב-insertSuppressedFault.
//
// ⚠️ **ולא await בשרשרת הקליטה** — ראה dispatcher: הקריאה היא fire-and-
// forget. עיכוב ברישום אינו אמור לעכב את ה-PUBACK, ובעיקר אינו אמור
// להיכנס לתור ה-FIFO של האתר, שם משימה תקועה חוסמת את האתר לנצח.
//
// ⚠️ ומינון: אתר לא רשום שמשדר כל שנייה היה מייצר אלפי שורות ביום. הזיכרון
// הקצר למטה בולע חזרות של אותו (topic, reason) בתוך דקה. הוא **בזיכרון
// בלבד** ובכוונה: הפעלה מחדש מאפסת אותו, וזה עדיף על שאילתת בדיקה לכל
// הודעה נזרקת.
const DROP_DEDUP_MS = 60_000;
const dropSeen = new Map();   // "topic|reason" → חותם אחרון

function shouldRecordDrop(topic, reason) {
  const key = `${topic}|${reason}`;
  const now = Date.now();
  const last = dropSeen.get(key);
  if (last && now - last < DROP_DEDUP_MS) return false;
  dropSeen.set(key, now);
  // ניקוי עצמי — אחרת המפה גדלה לנצח על אתרים שמשדרים זבל.
  if (dropSeen.size > 500) {
    for (const [k, t] of dropSeen) if (now - t > DROP_DEDUP_MS) dropSeen.delete(k);
  }
  return true;
}

/**
 * רושם הודעה שהגיעה ולא נכתבה. אינו זורק ואינו מחזיר דבר משמעותי.
 * `payload` נשמר **כפי שהגיע** — מחרוזת גולמית, לא מפורסרת.
 */
async function recordIngestDrop({ topic, siteCode = null, kind = null, reason, detail = null, payload = null }) {
  try {
    if (!shouldRecordDrop(topic, reason)) return;
    await db.prepare(
      `INSERT INTO ingest_drops (at, topic, site_code, kind, reason, detail, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      new Date().toISOString(), topic, siteCode, kind, reason,
      detail === null ? null : String(detail).slice(0, 500),
      payload === null ? null : String(payload).slice(0, 2000),
    );
  } catch (err) {
    // ⚠️ console בלבד, ובכוונה: אם גם הרישום נכשל, אין לאן לרשום את זה.
    console.error("[ingest-drop] הרישום נכשל —", err.message);
  }
}

module.exports.recordIngestDrop = recordIngestDrop;
module.exports.fillFaultTextIfMissing = fillFaultTextIfMissing;
