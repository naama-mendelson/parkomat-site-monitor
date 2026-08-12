// ingestion/state-handler.js — מטפל בהודעת state: מעדכן מצב נוכחי + היסטוריה

const { updateLastSeenIfNewer, applyStateChange, getOpenStatusStartedAt, getActiveMaintenance } = require("../db/queries");
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
  // מצב תחזוקה גובר על הכל — תקלה בזמן תחזוקה מושמטת לחלוטין
  // ==========================================================
  // אם האתר בתחזוקה — חלון ידני פעיל (מה-dashboard) *או* מצב תחזוקה שדווח
  // מהבקר (site.status === 'maintenance') — הודעת error נזרקת כאן ולא ממשיכה:
  // לא נרשמת ב-status_history, לא משנה את המצב (נשאר "תחזוקה"), ולא משודרת
  // ב-SSE. כך התקלה לא נספרת (אין שורת error), לא נראית בכרטיס/בגרפים, ואין
  // עליה התראה. זו החלטה מפורשת: "מצב תחזוקה גובר על הכלל".
  // עדיין מעדכנים last_seen — האתר תקשר, ולכן הוא "נשמע".
  if (newStatus === "error") {
    const manualMaintenance = await getActiveMaintenance(site.id);
    if (manualMaintenance || site.status === "maintenance") {
      await updateLastSeenIfNewer(site.id, occurredAt);
      console.log(`[state] אתר ${site.code}: תקלה בזמן תחזוקה — הושמטה (המצב נשאר תחזוקה)`);
      return;
    }
  }

  // הגנת backfill: הודעה שקרתה לפני תחילת המצב הנוכחי הגיעה מאוחר (סדר הפוך /
  // redelivery). אסור לה לשכתב את הסטטוס — אחרת נוצרת שורת היסטוריה עם משך שלילי
  // ו-last_seen נדחף אחורה. no_comm תמיד עם זמן עכשווי, ולכן לעולם לא ייחסם כאן.
  const openStartedAt = await getOpenStatusStartedAt(site.id);
  if (openStartedAt && occurredAt < openStartedAt) {
    console.log(`[state] אתר ${site.code}: הודעת state מאוחרת (${occurredAt} < ${openStartedAt}) — התעלמנו`);
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

  await applyStateChange(site.id, newStatus, occurredAt, faultText);
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
