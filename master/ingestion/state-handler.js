// ingestion/state-handler.js — מטפל בהודעת state: מעדכן מצב נוכחי + היסטוריה

const { updateLastSeenIfNewer, applyStateChange, getOpenStatusStartedAt, getActiveMaintenance,
        insertSuppressedFault, recordIngestDrop } = require("../db/queries");
const { shouldApplyNoComm } = require("./lwt-order");
const bus = require("../bus");
// ⚠️ מודול טהור בלי תלויות — כך הוא נבדק בלי מסד. ראה fault-text.js.
const { extractFaultText } = require("./fault-text");

async function handleState(site, data) {
  const newStatus = data.state;

  // ==========================================================
  // צוואה מאוחרת אינה דורסת מצב טרי
  // ==========================================================
  // ל-no_comm אין חותם זמן משלה (הברוקר מפרסם אותה), ולכן היא נחתמת ב"עכשיו"
  // — כלומר תמיד "החדשה ביותר", וכך צוואה שהתעכבה בתור עברה את שומר ה-backfill
  // ודרסה מצב שהאתר דיווח לפני רגע. ראה lwt-order.js.
  if (newStatus === "no_comm") {
    const verdict = shouldApplyNoComm(site.last_seen, Date.now());
    if (!verdict.apply) {
      console.warn(`[state] ⏮️ אתר ${site.code}: no_comm נדחתה — ${verdict.reason}`);
      return;
    }
  }

  let occurredAt;
  if (newStatus === "no_comm") {
    // מעגלים לשנייה שלמה, בדיוק כמו ב-bridge-handler. הסוכן מסנכרן מחדש עם חותם
    // בשניות שלמות; אם ה-no_comm נפתח באמצע שנייה (דיוק מילישניות) והסנכרון חוזר
    // באותה שנייה, guard ה-backfill (occurredAt < started_at) היה דוחה את הסנכרון
    // והאתר היה נתקע ב-no_comm אחרי שכבר התאושש. אותה מחלקת באג שתוקנה בגשר.
    occurredAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  } else {
    occurredAt = new Date(data.timestamp * 1000).toISOString();
  }

  // ==========================================================
  // מצב תחזוקה גובר על הכל — מהמדדים. **לא מהידיעה.**
  // ==========================================================
  // אם האתר בתחזוקה — חלון ידני פעיל (מה-dashboard) *או* מצב תחזוקה שדווח
  // מהבקר (site.status === 'maintenance') — הודעת error אינה ממשיכה במסלול
  // הרגיל: היא **אינה** נרשמת ב-status_history, אינה משנה את המצב (נשאר
  // תחזוקה), ואינה משודרת ב-SSE. כך היא אינה נספרת באחוז הכשל, אינה
  // משנה זמינות, ואין עליה התראה. זו החלטה מפורשת.
  //
  // ⚠️ **מה שכן השתנה: היא נרשמת ב-suppressed_faults.** קודם היא נעלמה
  // לגמרי, ומי שראה תקלה בשטח לא מצא לה זכר בלוג. ראה למטה.
  //
  // עדיין מעדכנים last_seen — האתר תקשר, ולכן הוא "נשמע".
  if (newStatus === "error") {
    const manualMaintenance = await getActiveMaintenance(site.id);
    if (manualMaintenance || site.status === "maintenance") {
      await updateLastSeenIfNewer(site.id, occurredAt);

      // ============================================================
      // ⚠️ מושמטת מהמדדים — אבל **נרשמת**, וזה לא אותו דבר
      // ============================================================
      // עד כאן היה רק console.log, ולכן התקלה נעלמה לחלוטין: מי שהיה
      // בשטח וראה אותה חיפש אותה בלוג ולא מצא כלום. "לא נספרת" ו"לא
      // קרתה" הם שני דברים שונים, והמסך הציג את השני.
      //
      // ⚠️ הרישום הוא לטבלה **נפרדת** ולא ל-status_history: שורת error
      // שם הייתה סוגרת את מקטע התחזוקה ופותחת מקטע תקלה — כלומר משנה
      // את מצב האתר ואת הזמינות, בדיוק הכלל שההשמטה נועדה לשמר.
      // אף מדד אינו קורא מ-suppressed_faults, ולכן אחוז הכשל אינו יכול
      // להשתנות ממנה. ראה ההסבר המלא ב-schema.postgres.sql.
      //
      // ⚠️ והכישלון כאן **אינו מפיל את הקליטה**: זהו רישום לתצוגה, ולא
      // נתון שמשהו נשען עליו. איבוד ההודעה כולה בגללו היה גרוע יותר.
      try {
        await insertSuppressedFault({
          siteId: site.id,
          occurredAt,
          faultText: extractFaultText(newStatus, data),
          reason: manualMaintenance ? "window" : "plc",
        });
      } catch (err) {
        console.error(`[state] אתר ${site.code}: רישום התקלה המושמטת נכשל —`, err.message);
      }

      console.log(`[state] אתר ${site.code}: תקלה בזמן תחזוקה — הושמטה מהמדדים ונרשמה ללוג`);
      return;
    }
  }

  // הגנת backfill: הודעה שקרתה לפני תחילת המצב הנוכחי הגיעה מאוחר (סדר הפוך /
  // redelivery). אסור לה לשכתב את הסטטוס — אחרת נוצרת שורת היסטוריה עם משך שלילי
  // ו-last_seen נדחף אחורה. no_comm תמיד עם זמן עכשווי, ולכן לעולם לא ייחסם כאן.
  const openStartedAt = await getOpenStatusStartedAt(site.id);
  if (openStartedAt && occurredAt < openStartedAt) {
    console.log(`[state] אתר ${site.code}: הודעת state מאוחרת (${occurredAt} < ${openStartedAt}) — התעלמנו`);
    // ⚠️ הגארד הזה הוא החשוד המרכזי באובדן תקלה: הודעת `no_comm` נחתמת
    // ב"עכשיו" של השרת, ולכן די בכך שהודעת מצב אמיתית תגיע שנייה אחריה עם
    // חותם מוקדם ממנה — והיא נזרקת בשקט. עכשיו זה נשאר רשום, עם שני
    // החותמים, כדי שאפשר יהיה לראות בדיוק בכמה היא "אחרה".
    recordIngestDrop({
      topic: `sites/${site.code}/state`,
      siteCode: site.code,
      kind: "state",
      reason: "state_late_vs_open_segment",
      detail: `occurredAt=${occurredAt} < openStartedAt=${openStartedAt}`,
      payload: JSON.stringify(data),
    });
    return;
  }

  if (newStatus === site.status) {
    // no_comm חוזר (למשל LWT נוסף) לא מרענן last_seen — האתר עדיין לא נשמע.
    if (newStatus === "no_comm") {
      console.log(`[state] אתר ${site.code}: no_comm (ללא שינוי, last_seen לא עודכן)`);
      return;
    }
    await updateLastSeenIfNewer(site.id, occurredAt);
    console.log(`[state] אתר ${site.code}: ${newStatus} (ללא שינוי, עודכן last_seen)`);
    return;
  }

  // ============================================================
  // תיאור התקלה מהבקר
  // ============================================================
  // הסוכן קורא מחרוזת מהבקר כשהמצב משתנה לתקלה, ושולח אותה בשדה faultText.
  // עד היום כל התקלות נראו זהות במסך — "מושבת" — ואי אפשר היה לדעת אם זו
  // תקלת חיישן, כרטיס שלא נקרא או תקלה מכנית.
  //
  // ⚠️ **מתקבל רק על תקלה.** סוכן שישלח טקסט על מצב אחר אינו אמור, ושמירתו
  // הייתה יוצרת שורות 'מוכן' עם תיאור תקלה — מידע שסותר את עצמו.
  //
  // ⚠️ ו-null נשמר כ-null: הוא אומר "לא נקרא" (סוכן ישן, בקר בלי התכונה),
  // בעוד '' אומר "נקרא והיה ריק". שני דברים שונים, ובמסך הם נראים אחרת.
  const faultText = extractFaultText(newStatus, data);

  // ============================================================
  // ⚠️ בודקים אם הכתיבה **באמת** קרתה — וזה תיקון לבאג אמיתי
  // ============================================================
  // `applyStateChange` מחזיר `{skipped}` כשגארד בתוך הטרנזקציה חסם את
  // הכתיבה: `backfill` (ההודעה קדמה לתחילת המקטע הפתוח) או `no_change`
  // (המקטע הפתוח כבר באותו מצב). הערך הזה **הוזנח כאן**, ולכן:
  //
  //   1. הלוג הדפיס "(שינוי נרשם)" כשלא נרשם דבר — כלומר **הלוג שיקר**,
  //      וזה בדיוק מה שהופך אבחון של תקלה שאבדה לבלתי אפשרי.
  //   2. `bus.publish` שידר לדשבורד מצב שאינו במסד. הכרטיס במסך התהפך,
  //      וברענון חזר לאחור — מסך ומסד שחולקים שני מצבים שונים.
  //
  // ⚠️ ו-bridge-handler.js **כן** בדק את זה, עם הערה שמסבירה למה זה חובה.
  // מקום אחד למד את הלקח והשני לא, וזו הסתירה שתוקנה.
  const result = await applyStateChange(site.id, newStatus, occurredAt, faultText);

  if (result?.skipped) {
    // ⚠️ warn ולא log: זו הודעה שהגיעה, אושרה ל-HiveMQ, ולא נרשמה. היא
    // נעלמת מכאן והלאה, ולכן זו השורה היחידה שתעיד עליה.
    //
    // ⚠️ ו-`site.status` מול המקטע הפתוח יכולים להיפרד: הגארד שלמעלה
    // משווה ל-`sites.status`, והגארד שבתוך הטרנזקציה למקטע. `no_change`
    // כאן פירושו שהשניים אינם מסונכרנים — מידע שכדאי לראות.
    console.warn(
      `[state] ⚠️ אתר ${site.code}: ${newStatus} **לא נרשם** — ${result.skipped}` +
      ` (sites.status=${site.status}, occurredAt=${occurredAt})`
    );

    // ⚠️ ולטבלה, לא רק ללוג: זו הודעה שהגיעה, אושרה ל-HiveMQ ונמחקה משם.
    // שורת console מתה עם הקונטיינר, וזה בדיוק מה שמנע מאיתנו לאבחן תקלה
    // שאבדה. ראה ingest_drops ב-schema.postgres.sql.
    recordIngestDrop({
      topic: `sites/${site.code}/state`,
      siteCode: site.code,
      kind: "state",
      reason: `state_${result.skipped}`,
      detail: `sites.status=${site.status} · occurredAt=${occurredAt}`,
      payload: JSON.stringify(data),
    });
    return;
  }

  console.log(
    `[state] אתר ${site.code}: ${site.status} → ${newStatus} (שינוי נרשם)` +
    (faultText ? ` · "${faultText}"` : "")
  );

  // שידור לכל מי שמאזין (SSE, ועוד בעתיד)
  bus.publish({
    type: "state",
    code: site.code,
    oldStatus: site.status,
    newStatus: newStatus,
    occurredAt: occurredAt,
    // ⚠️ נכלל גם כאן ולא רק ב-DB: הכרטיס במסך מתעדכן מה-SSE/Realtime בלי
    // רענון, ובלי השדה הזה התקלה הייתה מופיעה מיד והתיאור שלה רק ברענון.
    faultText,
  });
}

module.exports = { handleState };
