// ingestion/bridge-handler.js — מטפל בהודעת מצב הגשר (sites/{code}/bridge).
//
// ==========================================================
// למה יש כאן מטפל נפרד
// ==========================================================
// זיהוי הניתוק בנוי משתי שכבות LWT, ולא אחת:
//
//   1. **הסוכן מול Mosquitto המקומי** — LWT עם payload JSON
//      ({"timestamp":0,"state":"no_comm"}) על sites/{code}/state.
//      מכסה: תהליך הסוכן קרס, בזמן שהמחשב עצמו חי.
//
//   2. **הגשר מול HiveMQ** — הודעת notification עם payload "1"/"0" על
//      sites/{code}/bridge. מכסה: **המחשב כולו מת** (נפילת חשמל).
//      במקרה כזה Mosquitto מת יחד עם הסוכן ואין מי שיפרסם את ה-LWT של
//      שכבה 1 — ורק HiveMQ, שאצלו רשום ה-will של הגשר, יכול לדווח.
//      הוא עושה זאת אחרי 1.5 × keepalive = 90 שניות.
//
// זו הסיבה שההודעה כאן איננה JSON: זו הודעת notification של Mosquitto,
// והפורמט שלה קבוע ("1" או "0"). לכן היא הולכת ל-topic נפרד ולא ל-state,
// שם החוזה מחייב JSON.

const { applyStateChange } = require("../db/queries");
const bus = require("../bus");

/**
 * @param site אובייקט האתר (כבר אומת שהוא רשום)
 * @param payload גוף ההודעה כמחרוזת: "1" (הגשר מחובר) או "0" (מנותק)
 */
async function handleBridgeState(site, payload) {
  const connected = String(payload).trim() === "1";

  // ===== הגשר חזר =====
  // *לא* משנים כאן את המצב ל-ready. הגשר שחזר אומר רק שיש שוב קו תקשורת,
  // לא שהאתר תקין. המצב האמיתי יגיע מהסוכן עצמו: הוא משדר resync עם חותם
  // זמן טרי ברגע שהוא מזהה שהגשר חזר (ראה Worker.cs). ניחוש כאן היה גורם
  // לאתר מושבת להיראות "מוכן" לרגע.
  if (connected) {
    console.log(`[bridge] אתר ${site.code}: הגשר ל-HiveMQ מחובר`);
    return;
  }

  // ===== הגשר נפל =====
  if (site.status === "no_comm") {
    return;   // כבר מסומן — אין מה לעשות
  }

  // ==========================================================
  // הזמן: "עכשיו", אבל **מעוגל לשנייה שלמה**.
  // ==========================================================
  // ה"עכשיו" עצמו אינו מדויק — האתר מת עד 90 שניות קודם (זמן ה-keepalive),
  // ו-HiveMQ לא מספר *מתי* הגשר מת אלא רק שהוא מת. 90 שניות של אי-דיוק הן
  // זניחות, ואין מקור טוב יותר. (last_seen אינו מקור טוב: הסוכן משדר רק על
  // שינוי, ולכן אתר שקט ותקין יכול להיות עם last_seen בן שעות.)
  //
  // אבל **העיגול לשנייה קריטי**. החוזה מול הסוכן הוא unix-*שניות*, ואילו
  // כאן היינו יוצרים חותם זמן ברזולוציית מילישניות. הודעת ה-resync שהסוכן
  // משדר כשהגשר חוזר נושאת שנייה שלמה, ולכן היא תמיד נראית *מוקדמת* ממקטע
  // ה-no_comm שנפתח באמצע אותה שנייה — והגנת ה-backfill דוחה אותה.
  // התוצאה: האתר נתקע ב"אין תקשורת" לנצח, גם אחרי שחזר לעבוד.
  //
  // עיגול כלפי מטה מיישר את שתי הרזולוציות: הודעה מאותה שנייה מקבלת חותם
  // זמן *שווה*, וההגנה בודקת `<` ולא `<=` — כלומר היא עוברת.
  const occurredAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();

  const result = await applyStateChange(site.id, "no_comm", occurredAt);

  // applyStateChange מחזיר {skipped} אם ה-guard חסם. בלי הבדיקה הזו היינו
  // משדרים אירוע SSE על שינוי שלא נרשם, והדשבורד היה מציג מצב שאינו ב-DB.
  if (result?.skipped) {
    console.log(`[bridge] אתר ${site.code}: דילוג (${result.skipped})`);
    return;
  }

  // הערה: applyStateChange כבר יודע ש-no_comm אינו "צפייה" ולכן אינו מקדם
  // את last_seen (הוא קורא ל-updateStatusOnly). אתר מת לא ייראה "נצפה זה עתה".
  console.warn(
    `[bridge] ⚠️ אתר ${site.code} (${site.site_name}): הגשר ל-HiveMQ נפל — ` +
    `סומן no_comm (היה ${site.status})`
  );

  bus.emit("siteUpdate", {
    type: "state",
    code: site.code,
    oldStatus: site.status,
    newStatus: "no_comm",
    occurredAt,
  });
}

module.exports = { handleBridgeState };
