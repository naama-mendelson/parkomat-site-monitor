// ingestion/dispatcher.js — מקבל הודעה, מפענח, בודק רישום, ומנתב

const { findSiteByCode, recordIngestDrop } = require("../db/queries");

// ============================================================
// ⚠️ הרישום לעולם אינו משנה את מסלול הריצה — ועכשיו זה נאכף
// ============================================================
// `recordIngestDrop` נקרא מתוך ה-try של dispatch, ולכן **כל** זריקה ממנו
// מתפשטת ל-handleMessage — שמפרש אותה כשגיאת עיבוד, מנסה חמש פעמים עם
// backoff (3.75ש'), ואז רושם "נטישה". כלומר דחייה נקייה ומכוונת הייתה
// הופכת לסערת ניסיונות ולדיווח שגוי על אובדן.
//
// ⚠️ **וזה נתפס בפועל:** שמונה בדיקות דיספאצ'ר שעברו קודם התחילו לקחת
// 3,780ms כל אחת — בדיוק ה-backoff — כי ה-stub שלהן אינו כולל את הפונקציה,
// ו-undefined(...) זורק לפני שנכנסים לגוף שלה.
//
// העוטף הופך את הכלל מהצהרה בהערה למשהו שנאכף בקוד. `?.` מכסה גם את
// המקרה שהפונקציה כלל אינה קיימת.
function noteDrop(row) {
  try {
    recordIngestDrop?.(row);
  } catch (err) {
    console.error("[dispatcher] רישום הזריקה נכשל —", err?.message);
  }
}
const { handleState } = require("./state-handler");
const { handleOperation } = require("./operation-handler");
const { handleBridgeState } = require("./bridge-handler");
const { classifyTimestamp } = require("./plausibility");
const { isLikelyReplay } = require("./replay-window");
const { recallClamp, rememberClamp } = require("./clamp-memo");

// המצבים החוקיים שהקצה רשאי לשלוח (no_comm נגזר LWT, לא נשלח)
const VALID_STATES = ["ready", "operating", "error", "maintenance","no_comm"];

// חותם זמן לפני 2020-01-01 אינו unix-seconds סביר (בדרך כלל 0, או שעון בקר
// שלא אותחל). בלי הבדיקה הזו new Date(NaN).toISOString() זורק, וההודעה אובדת
// עם שגיאה כללית שלא מסגירה את הסיבה.
const MIN_TIMESTAMP = 1577836800; // 2020-01-01T00:00:00Z
// גבול עליון: חוסם timestamp שנשלח בטעות במילישניות (ננקלט אחרת כתאריך שנת ~58000)
// או ערך אבסורדי שיזרוק RangeError ב-toISOString.
const MAX_TIMESTAMP = 4102444800; // 2100-01-01T00:00:00Z

function isValidTimestamp(ts) {
  return Number.isFinite(ts) && ts >= MIN_TIMESTAMP && ts < MAX_TIMESTAMP;
}

// מוודא שהודעת operation שלמה ומנרמל שדות רופפים.
// מחזיר מחרוזת שגיאה, או null אם ההודעה תקינה.
function validateOperation(data) {
  if (!isValidTimestamp(data.timestamp)) {
    return `timestamp לא תקין (${data.timestamp})`;
  }
  if (data.start_end !== "start" && data.start_end !== "end") {
    return `start_end חייב להיות start או end (קיבלנו '${data.start_end}')`;
  }
  if (data.entry_exit !== "entry" && data.entry_exit !== "exit") {
    return `entry_exit חייב להיות entry או exit (קיבלנו '${data.entry_exit}')`;
  }

  // רק הודעת end נושאת את מונה הבקר. ערך לא-שלם היה מצטבר ל-NaN ב-cycle_total.
  if (data.start_end === "end" && !Number.isInteger(data.cycle_counter)) {
    return `cycle_counter חייב להיות מספר שלם (קיבלנו '${data.cycle_counter}')`;
  }

  // החוזה מחייב user="" ולא null. null אינו סיבה לאבד פעולה — מנרמלים:
  // card_number הוא NOT NULL ומשתתף במפתח ה-dedup, ולכן חייב להיות מחרוזת.
  // מספר כרטיס שנשלח כ-JSON number (למשל 12345) מומר למחרוזת, לא נמחק ל-"".
  if (data.user == null) {
    data.user = "";
  } else if (typeof data.user !== "string") {
    data.user = String(data.user);
  }

  return null;
}

// המתנה קצרה בין ניסיונות חוזרים.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// כמה פעמים לנסות לכתוב ל-DB לפני שמוותרים. שגיאת DB חולפת (Supabase cold-start,
// ECONNRESET על ה-pooler) אסור שתאבד הודעת ניטור — בפרט מעבר ל-error/no_comm, שהוא
// בדיוק האירוע שהמערכת קיימת כדי לתפוס. ה-dispatch אידמפוטנטי (טרנזקציות חוזרות
// לאחור על שגיאה, dedup דרך unique constraint, ומשמרות backfill/no-change), ולכן
// ניסיון חוזר בטוח. תור ה-FIFO של האתר מוחזק במהלך ההמתנה — הסדר נשמר.
const MAX_ATTEMPTS = 5;

async function handleMessage(topic, raw) {
  for (let attempt = 1; ; attempt++) {
    try {
      await dispatch(topic, raw);
      return;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        console.error(
          `[dispatcher] אובדן הודעה מ-${topic} אחרי ${MAX_ATTEMPTS} ניסיונות:`,
          err.message);

        // ============================================================
        // ⚠️ **זה מסלול האובדן האמיתי, וכל האחרים הם רעש לידו**
        // ============================================================
        // `return` ולא `throw` — ובכוונה: הודעה תקולה שתיזרק שוב הייתה
        // חוזרת בכל חיבור מחדש וחוסמת את התור אחריה. אבל התוצאה היא
        // שהמנוי נכנס לענף ההצלחה, שולח PUBACK, וההודעה **נמחקת
        // מ-HiveMQ לתמיד** — בזמן שהוא כלל לא ידע שמשהו נכשל.
        //
        // ⚠️ ולכן `recordIngestDrop` שהוסף במנוי **לא כיסה את זה**: הוא
        // תלוי בזריקה, וכאן אין זריקה. הנקודה הסבירה ביותר לאובדן הייתה
        // בדיוק זו שנשארה בלי תיעוד.
        //
        // ⚠️ **וזה נמדד, לא הוסק.** ב-23.08 שודרו שתי הודעות בהפרש שתי
        // מילישניות; אחת נקלטה והשנייה נעלמה. הפער בין השידור לרישום היה
        // **7.13 שניות** — וסך ה-backoff של חמישה ניסיונות הוא 3.75ש'
        // בתוספת חמש כתיבות למסד (נמדדו 84–2400ms כל אחת), כלומר טווח של
        // 4.2 עד 15.7 שניות. ההודעה השנייה המתינה בתור ה-FIFO של האתר עד
        // שהראשונה ננטשה — ולכן היא נראתה מאוחרת.
        //
        // הכשל עצמו היה חולף: ECONNRESET מול ה-pooler של Supabase, שנמדד
        // לאורך כל אותו יום. לא היה שום דבר מיוחד בהודעת ה-state; היא
        // פשוט הייתה הראשונה בתור.
        noteDrop({
          topic,
          siteCode: topic.split("/")[1] || null,
          kind: topic.split("/")[2] || null,
          reason: "gave_up_after_retries",
          detail: `${MAX_ATTEMPTS} ניסיונות · ${err.message}`,
          payload: raw,
        });
        return;
      }
      // backoff מעריכי: 250ms, 500, 1000, 2000 (מוגבל ל-4s).
      const backoffMs = Math.min(250 * 2 ** (attempt - 1), 4000);
      console.warn(
        `[dispatcher] ניסיון ${attempt}/${MAX_ATTEMPTS} נכשל מ-${topic}: ${err.message} — שוב בעוד ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
}

// מפענח ומנתב הודעה אחת. *אינו* בולע שגיאת DB — היא מתפשטת כדי ש-handleMessage
// ינסה שוב. כשל ולידציה/רישום מסתיים ב-return רגיל (drop) ואינו גורם לניסיון חוזר.
async function dispatch(topic, raw) {
  try {
    // 1. שליפת קוד האתר וסוג ההודעה מה-topic
    const parts = topic.split("/");
    if (parts.length !== 3 || parts[0] !== "sites" || !parts[1]) {
      console.log(`[dispatcher] topic לא מוכר: ${topic}`);
      // ⚠️ נראה בייצור: `sites//bridge` — קוד אתר ריק. עד כה זה נעלם
      // עם הקונטיינר, ולכן איש לא ידע שיש מכשיר ששולח לכתובת שבורה.
      noteDrop({ topic, siteCode: parts[1] || null, kind: parts[2] || null,
                 reason: "unknown_topic", payload: raw });
      return;
    }
    const siteCode = parts[1];
    const kind = parts[2]; // "state" | "operation" | "bridge"

    // 2. הודעת מצב הגשר — מטופלת *לפני* ניתוח ה-JSON, ובכוונה.
    //    זו הודעת notification של Mosquitto, וה-payload שלה הוא "1"/"0"
    //    ולא JSON. אילו הייתה עוברת דרך JSON.parse היא הייתה נדחית
    //    ("לא אובייקט") ומקרה נפילת החשמל היה נשאר בלי זיהוי.
    if (kind === "bridge") {
      const bridgeSite = await findSiteByCode(siteCode);
      if (!bridgeSite) {
        console.log(`[dispatcher] נדחתה הודעת גשר מאתר לא רשום: code=${siteCode}`);
        noteDrop({ topic, siteCode, kind, reason: "bridge_site_not_registered", payload: raw });
        return;
      }
      await handleBridgeState(bridgeSite, raw);
      return;
    }

    // 3. פענוח ה-JSON
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.log(`[dispatcher] הודעה לא תקינה (לא JSON) מ-${topic}:`, raw);
      // ⚠️ הודעה פגומה היא **אובדן אמיתי**: היא אושרה ל-HiveMQ ונמחקה,
      // ואם לא נשמור אותה כאן אין שום דרך לדעת מה הבקר ניסה לומר.
      noteDrop({ topic, siteCode, kind, reason: "malformed_json",
                 detail: String(e?.message || "").slice(0, 120), payload: raw });
      return;
    }

    if (data === null || typeof data !== "object") {
      console.log(`[dispatcher] הודעה לא תקינה (לא אובייקט) מ-${topic}:`, raw);
      noteDrop({ topic, siteCode, kind, reason: "payload_not_object", payload: raw });
      return;
    }

    // 4. בדיקת רישום — אתר לא רשום נדחה
    const site = await findSiteByCode(siteCode);
    if (!site) {
      console.log(`[dispatcher] נדחתה הודעה מאתר לא רשום: code=${siteCode}`);
      // ⚠️ נרשם למרות שאין site_id — ולכן אין FK בטבלה הזו. אתר שמשדר
      // ואינו רשום הוא בדיוק המקרה שצריך לראות: זה קרה עם 1416, שהודעותיו
      // נזרקו שבועות בשקט. הזיכרון הקצר ב-recordIngestDrop מונע הצפה.
      noteDrop({ topic, siteCode, kind, reason: "site_not_registered", payload: raw });
      return;
    }

    // 4. אכיפת state חוקי — בשני סוגי ההודעות יש שדה state
    if (!VALID_STATES.includes(data.state)) {
      console.log(`[dispatcher] נדחתה הודעה עם state לא חוקי '${data.state}' מאתר ${siteCode}`);
      noteDrop({ topic, siteCode, kind, reason: "invalid_state",
                         detail: String(data.state), payload: raw });
      return;
    }

    // ============================================================
    // 4.5. סבירות חותם הזמן — דוחים את האבסורדי, מיישרים את הסחיף
    // ============================================================
    // הבדיקה הישנה (isValidTimestamp) חוסמת 1970 ו-58000, אבל לא חותם שנמצא
    // שנה בעתיד — וזה בדיוק זה שמשתיק אתר לצמיתות. ראה plausibility.js.
    //
    // **החותם המקורי לעולם אינו אובד**: הוא נשמר ב-reported_timestamp, וממנו
    // נבנה מפתח ה-dedup. data.timestamp מוחלף בזמן ה"אמת" (המיושר) שממנו
    // נגזרים סדר וזמינות. בלי ההפרדה הזו, יישור היה משנה את מפתח ה-dedup
    // בכל מסירה חוזרת — והופך תיקון-סחיפה למחולל-כפילויות.
    //
    // הודעת LWT של no_comm פטורה: היא נוצרת בברוקר עם timestamp=0 ואין לה זמן
    // משלה — ה-state-handler גוזר לה את זמן הקליטה.
    const exemptFromPlausibility = kind === "state" && data.state === "no_comm";

    if (!exemptFromPlausibility) {
      // יישור-לאחור מותר רק כשאיננו בתוך פריקת תור. בחלון הפריקה חותם ישן הוא
      // כמעט תמיד אירוע אמיתי שמגיע באיחור, ולא שעון מפגר — ראה replay-window.js.
      const now = Date.now();
      const verdict = classifyTimestamp(
        data.timestamp,
        now,
        site.registered_at ? Date.parse(site.registered_at) : null,
        { allowPastClamp: !isLikelyReplay(now) }
      );

      if (verdict.action === "reject") {
        console.warn(
          `[dispatcher] ⛔ נדחתה הודעת ${kind} מאתר ${siteCode}: ${verdict.reason}. ` +
          `בדוק את שעון המחשב באתר (סוללת RTC / סנכרון NTP).`);
        // ⚠️ הגארד הזה **נועד** לתפוס שעון שגוי באתר — וכשהוא תופס, ההודעה
        // נעלמת. בלי רישום אין שום דרך לדעת שזו הסיבה, ובדיוק זה מה שחיפשנו
        // שש שעות. נשמר עם `verdict.reason` והמטען, כדי שאפשר יהיה להשוות
        // לחותם שהסוכן חושב ששלח.
        noteDrop({ topic, siteCode, kind, reason: "timestamp_rejected",
                           detail: verdict.reason, payload: raw });
        return;
      }

      // המקור, לפני כל נגיעה — זהו מפתח ה-dedup.
      data.reported_timestamp = data.timestamp;

      // ============================================================
      // החלטת יישור אחת למעבר MODE אחד
      // ============================================================
      // state ו-operation של אותו מעבר נושאים את אותו חותם מדווח, אבל מעובדים
      // בזו אחר זו — ולכן "עכשיו" שונה ביניהם. יישור עצמאי היה נותן לכל אחד
      // שנייה אחרת, ומייצר בלוג סדר בלתי אפשרי ('מוכן' לפני 'הפעולה הסתיימה').
      // לכן ההחלטה נזכרת לפי (אתר, חותם מדווח) — ראה clamp-memo.js.
      const remembered = recallClamp(site.id, data.reported_timestamp, now);

      if (remembered !== null) {
        // ההודעה השנייה של אותו מעבר. מקבלת בדיוק את מה שקיבלה הראשונה,
        // ובשקט — האזהרה כבר נרשמה עבור הראשונה.
        data.timestamp = remembered;
      } else if (verdict.action === "clamp") {
        data.timestamp = verdict.effectiveSec;
        // רושמים רק סטייה משמעותית. סחיפה של שנייה היא רעש עיגול (החוזה הוא
        // שניות שלמות), ואתר כזה היה מייצר שורת אזהרה לכל הודעה — כלומר מציף
        // את הלוג ב-200 אתרים ומסתיר בדיוק את מה שחשוב לראות.
        if (verdict.warn) {
          const direction = verdict.classification === "drift_future" ? "מקדים" : "מפגר";
          console.warn(
            `[dispatcher] ⏱️ אתר ${siteCode}: שעון ${direction} ב-${Math.abs(verdict.skewSeconds)}s — ` +
            `החותם יושר לזמן השרת (${verdict.effectiveSec}). ` +
            `ה-dedup ממשיך לפי החותם המקורי (${data.reported_timestamp}).`);
        }
      } else if (verdict.classification === "backfill") {
        // חשוב שזה ייראה בלוג: כאן בחרנו **לא** לגעת בזמן, וזו ההתנהגות הנכונה
        // ל-backfill. אם שורות כאלה מופיעות בשגרה (ולא אחרי נפילה), סימן שיש
        // אתר עם שעון מפגר מאוד — והתקרה אינה מכסה אותו.
        console.log(
          `[dispatcher] ⏮️ אתר ${siteCode}: ${verdict.reason} ` +
          `(occurred_at נשמר: ${data.timestamp}).`);
      } else if (verdict.warn) {
        console.warn(
          `[dispatcher] ⚠️ אתר ${siteCode}: שעון סוטה ב-${Math.abs(verdict.skewSeconds)}s — ` +
          `ההודעה נקלטה כמות שהיא.`);
      }

      // זוכרים את ההכרעה — גם כשלא יישרנו. אחרת ההודעה השנייה של אותו מעבר
      // הייתה נשקלת מחדש מול "עכשיו" מאוחר יותר, ועלולה לחצות את הרצפה
      // ולהיושר בעוד שהראשונה נשמרה כמות שהיא. גם זה היה מפריד ביניהן.
      if (remembered === null) {
        rememberClamp(site.id, data.reported_timestamp, data.timestamp, now);
      }
    }

    // 5. ניתוב לפי סוג ההודעה
    if (kind === "state") {
      // הודעת ה-LWT (no_comm) נוצרת ב-Broker ואין לה זמן משלה (timestamp=0);
      // state-handler גוזר לה את זמן הקליטה. שאר ההודעות חייבות חותם זמן תקין.
      if (data.state !== "no_comm" && !isValidTimestamp(data.timestamp)) {
        console.log(`[dispatcher] נדחתה הודעת state מאתר ${siteCode}: timestamp לא תקין (${data.timestamp})`);
        noteDrop({ topic, siteCode, kind, reason: "state_bad_timestamp",
                   detail: `timestamp=${data.timestamp}`, payload: raw });
        return;
      }
      // await חיוני: ה-handlers אסינכרוניים עכשיו, ובלעדיו כשל בכתיבה ל-DB
      // היה הופך ל-unhandled rejection — ה-try/catch כאן לא היה תופס אותו,
      // וההודעה הייתה נעלמת בשקט.
      await handleState(site, data, raw);
    } else if (kind === "operation") {
      const problem = validateOperation(data);
      if (problem) {
        console.log(`[dispatcher] נדחתה הודעת operation מאתר ${siteCode}: ${problem}`);
        noteDrop({ topic, siteCode, kind, reason: "operation_invalid",
                   detail: String(problem).slice(0, 160), payload: raw });
        return;
      }
      await handleOperation(site, data);
    } else {
      console.log(`[dispatcher] סוג הודעה לא מוכר (${kind}) מ-${topic}`);
    }
  } catch (err) {
    // לא בולעים כאן: שגיאת DB/תשתית מתפשטת ל-handleMessage שינסה שוב, ורק אחרי
    // מיצוי הניסיונות תירשם כאובדן. (שגיאות ולידציה כבר יצאו ב-return למעלה.)
    throw err;
  }
}

module.exports = { handleMessage };
