// master.js — מנצח: מדליק MQTT, ingestion, ו-API (כולל SSE)

const bus = require("./bus");
const db = require("./db/db");
const { handleMessage } = require("./ingestion/dispatcher");
const { startApiServer, closeSseClients } = require("./api/routes");
const { acquireSingleInstanceLock } = require("./db/single-instance");

// תחזוקה יומית: גיבוי → סיכום → ניקוי (בודק כל 24 שעות)
const { runBackup } = require("./tools/backup-db");
const { runMonthlySummary } = require("./tools/monthly-summary");
const { runCleanup } = require("./tools/cleanup-old-data");

// גריפת טבלת events. הרטנציה שלה קצרה בכוונה (שבוע): היא נועדה ל-replay
// אחרי ניתוק, שנמדד בדקות עד שעות. ההיסטוריה האמיתית יושבת ב-status_history
// וב-operations ואינה תלויה בה, ולכן אין סיבה לצבור אותה לאורך שנה.
async function runPruneEvents() {
  const { pruneEvents } = require("./db/queries");
  const removed = await pruneEvents(7);
  console.log(`[events] נגרפו ${removed} אירועים מעל שבוע.`);
}

async function dailyMaintenance() {
  // כל שלב עטוף בנפרד: כשל בסיכום/ניקוי לא צריך להפיל את השרת (MQTT + API)
  // ולא צריך למנוע את השלבים האחרים.
  const steps = [
    ["גיבוי", runBackup],               // 1. ביטוח — לפני כל שינוי
    ["סיכום חודשי", runMonthlySummary],  // 2. לחודש שנגמר
    ["ניקוי", runCleanup],              // 3. מעל שנה
    ["גריפת אירועים", runPruneEvents],  // 4. events מעל שבוע — נועדו ל-replay, לא להיסטוריה
  ];

  for (const [name, step] of steps) {
    try {
      // await חיוני: השלבים אסינכרוניים עכשיו. בלעדיו ה-catch לא היה תופס
      // כלום, וכשל היה מסיים את התהליך כ-unhandled rejection.
      await step();
    } catch (err) {
      console.error(`[maintenance] שלב '${name}' נכשל:`, err.message);
    }
  }
}

// ==========================================================
// תור עיבוד לכל אתר — הכרחי, לא אופטימיזציה
// ==========================================================
// עם SQLite עיבוד ההודעה היה סינכרוני: כל הודעה הסתיימה לפני שהבאה התחילה.
// עם Postgres הוא אסינכרוני, ובלי תור שתי הודעות שמגיעות ברצף מעובדות
// *במקביל*.
//
// זה שבר את המערכת בפועל: הסוכן שולח state=operating ומיד אחריו
// operation/start, עם אותו חותם זמן. שתיהן קראו status='ready' (לפני שאף
// אחת הספיקה לכתוב), שתיהן החליטו לפתוח מקטע 'operating', ושתיהן כתבו —
// וכך נוצרו שורות כפולות, כמה מקטעים פתוחים בו-זמנית, ואפילו ended_at
// מוקדם מ-started_at (משך שלילי). זה מרעיל את חישובי הזמינות.
//
// התור הוא *לכל אתר* ולא גלובלי: הסדר חשוב רק בתוך אתר (המצב שלו הוא
// מכונת מצבים), ואתרים שונים יכולים להתעבד במקביל בלי להפריע זה לזה.
const queues = new Map();   // קוד אתר → ה-Promise האחרון בתור

function enqueue(topic, task) {
  const code = topic.split("/")[1] || "?";

  const previous = queues.get(code) || Promise.resolve();
  const next = previous.then(task);
  queues.set(code, next);

  // ניקוי כשהתור התרוקן — אחרת המפה גדלה לנצח
  next.finally(() => {
    if (queues.get(code) === next) queues.delete(code);
  });

  return next;
}

/**
 * ממתין שכל מה שכבר נכנס לתורים ייכתב. נקרא בכיבוי, **אחרי** שה-MQTT נסגר
 * (אחרת התורים ממשיכים להתמלא ואין לזה סוף).
 *
 * למה זה נחוץ: התורים חיים בזיכרון בלבד. יציאה לפני שהתרוקנו מוחקת הודעות
 * שכבר אושרו ל-HiveMQ — כלומר שכבר נמחקו מהתור שלו. בלי הריקון הזה אפילו
 * `docker compose down` תקין היה מאבד את מה שהיה באוויר.
 *
 * הלולאה חוזרת כי המתנה לתור אחד עלולה לאפשר לתור אחר להתקדם ולהיווצר מחדש.
 * @returns כמה תורים נשארו לא-ריקים (0 = הכל נכתב)
 */
async function drainQueues(deadlineMs = 8000) {
  const until = Date.now() + deadlineMs;
  while (queues.size > 0 && Date.now() < until) {
    await Promise.allSettled([...queues.values()]);
  }
  return queues.size;
}

// ==========================================================
// כיבוי מסודר — Docker שולח SIGTERM, לא SIGKILL
// ==========================================================
// `docker stop` (וכל `docker compose down`) שולח SIGTERM וממתין
// stop_grace_period לפני שהוא הורג בכוח. ברירת המחדל של Node ל-SIGTERM היא
// לצאת *מיד*, ולכן בלי המטפל הזה כל עצירה הייתה:
//   • מנתקת את MQTT בפתאומיות, באמצע מסירת QoS-1 שבאוויר;
//   • קוטעת בקשות HTTP וחיבורי SSE פתוחים;
//   • משאירה את ה-pool של Postgres עם חיבורים תלויים עד שה-pooler יזרוק אותם.
//
// הסדר כאן אינו שרירותי — קודם מפסיקים להיכנס, ואחר כך מנקים:
//   1. MQTT ראשון: מפסיק את זרם ההודעות הנכנס, כדי שלא ייכנסו עוד עבודות לתור.
//   2. SSE: חיבור SSE לעולם אינו נגמר מעצמו, ולכן server.close() בלעדיו
//      ממתין לנצח — וזה בדיוק מה שהופך "עצירה מסודרת" ל-SIGKILL.
//   3. שרת ה-HTTP: מפסיק לקבל חדשות, מסיים את מה שבאוויר.
//   4. ה-pool של ה-DB — אחרון, כי השלבים שלפניו עדיין עלולים לכתוב.
//
// ומעל הכול דדליין קשיח: אם משהו נתקע, יוצאים בכל מקרה. תהליך שנתקע בכיבוי
// גרוע מתהליך שיצא מהר מדי — הוא זה שמקבל SIGKILL וגורר restart אינסופי.
const SHUTDOWN_DEADLINE_MS = 12_000;
let shuttingDown = false;
let httpServer = null;
let releaseLock = null;   // ראה db/single-instance.js

async function shutdown(signal) {
  if (shuttingDown) return;      // SIGTERM כפול לא מפעיל שני כיבויים
  shuttingDown = true;
  console.log(`master: ${signal} — כיבוי מסודר...`);

  const deadline = setTimeout(() => {
    console.error(`master: הכיבוי לא הושלם ב-${SHUTDOWN_DEADLINE_MS}ms — יוצאים בכל זאת.`);
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();

  try {
    if (typeof bus.close === "function") {
      await bus.close();
      console.log("master: MQTT נסגר.");
    }

    // אחרי שהזרם הנכנס נעצר — מסיימים לכתוב את מה שכבר התקבל. חייב לקרות
    // לפני db.close(), אחרת הכתיבות האחרונות ייפלו על pool סגור.
    const stuck = await drainQueues();
    if (stuck > 0) {
      console.error(`master: ${stuck} תורי קליטה לא התרוקנו בזמן — ייתכן אובדן.`);
    } else {
      console.log("master: תורי הקליטה התרוקנו.");
    }

    const sse = closeSseClients();
    if (sse > 0) console.log(`master: נסגרו ${sse} חיבורי SSE.`);

    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
      console.log("master: שרת ה-HTTP נסגר.");
    }

    // ⚠️ לפני db.close ולא אחריו: זה חיבור נפרד משלו, ואם ה-pool ייסגר
    // קודם עדיין אין מי שיסגור אותו — הנעילה הייתה משתחררת רק כשהתהליך מת.
    // בפועל זה עובד גם כך, אבל שחרור מפורש הופך "לא הצלחתי לעלות" לתשובה
    // מיידית במקום להמתנה עד ש-Postgres יבחין שה-session מת.
    if (releaseLock) {
      await releaseLock();
      releaseLock = null;
      console.log("master: נעילת המופע היחיד שוחררה.");
    }

    await db.close();
    console.log("master: ה-pool של ה-DB נסגר.");

    clearTimeout(deadline);
    console.log("master: כיבוי הושלם.");
    process.exit(0);
  } catch (err) {
    console.error("master: שגיאה בכיבוי —", err.message);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  // הסכמה חייבת להיות מוכנה *לפני* שמאזינים ל-MQTT — אחרת ההודעה הראשונה
  // תגיע לטבלה שעדיין לא נוצרה.
  await db.init();

  // ⚠️ **לפני ה-subscriber, ואחרי db.init — הסדר הזה הוא כל התועלת.**
  // אחרי init כי הנעילה צריכה מסד שעונה; לפני ה-subscriber כי מרגע שהוא
  // עולה שני התהליכים כבר מנתקים זה את זה. נעילה שנתפסת אחריו הייתה מדווחת
  // על הבעיה אחרי שכבר נגרמה.
  releaseLock = await acquireSingleInstanceLock(process.env.DATABASE_URL);

  require("./mqtt/subscriber");   // מתחבר רק אחרי שה-DB מוכן

  // רישום המעבד — ולא bus.on("message"). ההבדל אינו סגנוני: המעבד מחזיר
  // Promise, וה-subscriber מאשר את ההודעה ל-HiveMQ (PUBACK) רק כשהוא נפתר.
  // מאזין רגיל הוא fire-and-forget, ואיתו ההודעה מאושרת ונמחקת מהתור של
  // הברוקר עוד לפני שנכתבה — ואז קריסה מאבדת אותה. ראה mqtt/subscriber.js.
  bus.setMessageProcessor((topic, data) =>
    // handleMessage מטפל בשגיאות בעצמו; ה-catch כאן הוא רשת ביטחון אחרונה
    // כדי שהודעה תקולה לא תפיל את התהליך.
    enqueue(topic, () =>
      handleMessage(topic, data).catch((err) => {
        console.error("[master] שגיאה בטיפול בהודעה:", err.message);
      })));

  httpServer = await startApiServer();

  console.log("master: started");

  setTimeout(dailyMaintenance, 10 * 1000);
  setInterval(dailyMaintenance, 24 * 60 * 60 * 1000);

  // ==========================================================
  // Keep-alive — מונע "קימה קרה" של ה-DB בענן
  // ==========================================================
  // אחרי חוסר פעילות ה-pooler וה-compute של Supabase מתקררים, והבקשה הראשונה
  // משלמת ~2.4ש' של התעוררות במקום ~200ms.
  //
  // המרווח הוא 20ש' ולא 60ש': נמדד ש-Supabase מתקרר תוך ~30ש' — עם פינג כל
  // 60ש' הבקשה הראשונה עדיין נחתה על pooler קר (2.4ש'). 20ש' מבטיח שהפינג
  // האחרון תמיד בתוך חלון-הקירור, וכך הבקשה הראשונה אחרי המתנה יורדת ל-~0.34ש'.
  // (נשמע צפוף, אבל 4 שאילתות SELECT 1 כל 20ש' הן עומס אפסי.)
  //
  // הפינג מחמם *כמה* חיבורים במקביל, לא אחד: פתיחת פאנל יורה בקשה עם מספר
  // שאילתות מקבילות, וחיבור חם בודד לא מספיק — השאר עדיין נפתחים קר. עם
  // idleTimeoutMillis=120ש' (ראה db.js) החיבורים שה-keepalive מחמם שורדים
  // בין הפינגים. שקט בהצלחה — רק כשל נרשם.
  const KEEP_ALIVE_MS = 20 * 1000;
  const KEEP_ALIVE_WARM = 4;   // כמה חיבורים להחזיק חמים (מכסה בקשת analytics שלמה)
  async function warmPool() {
    try {
      // Promise.all מכריח את הפינגים לרוץ *במקביל* → תופס KEEP_ALIVE_WARM
      // חיבורים נפרדים ומאפס להם את שעון הסרק. פינג טורי היה נוגע בחיבור אחד.
      await Promise.all(
        Array.from({ length: KEEP_ALIVE_WARM }, () => db.prepare("SELECT 1").get())
      );
    } catch (err) {
      console.error("[keepalive] פינג ל-DB נכשל:", err.message);
    }

    // ============================================================
    // ⚠️ אות חיים — כדי שהדשבורד יידע שהוא מציג נתונים ישנים
    // ============================================================
    // ב-22.08 השרת היה למטה 14.7 שעות. המסך הראה מצב בן 14 שעות **בלי שום
    // סימן שמשהו לא בסדר**, וזה מה שהפך תקלה של דקה לבוקר שלם של חיפוש.
    // אותו דבר בדיוק קרה ב-26.07 (15 שעות). זה כבר לא מקרה.
    //
    // ⚠️ **ולמה אות חיים ולא גיל הנתונים.** הסוכן משדר רק ב**שינוי** MODE,
    // ולכן לילה שקט באמת נראה זהה לשרת מת: אפס הודעות בשני המקרים. גיל
    // הנתונים אינו יכול להבחין ביניהם, ומסך שיצעק על כל שעה שקטה בלילה
    // הוא מסך שמלמדים להתעלם ממנו. שורה שהשרת כותב בעצמו כן מבחינה.
    //
    // ⚠️ ורוכב על ה-keep-alive במכוון — טיימר שני היה עוד דבר שיכול ליפול
    // בשקט. אם הלולאה הזו מפסיקה לרוץ, גם אות החיים מפסיק, וזה בדיוק הרצוי.
    //
    // עדכון שורה בודדת כל 20ש' הוא עומס אפסי, ובאותו סדר גודל של הפינגים
    // שכבר רצים כאן.
    try {
      const { setSetting } = require("./db/queries");
      await setSetting("server_heartbeat", new Date().toISOString());
    } catch (err) {
      // ⚠️ כשל כאן **אינו** מפיל דבר: אות חיים שנכשל יגרום למסך להציג
      // אזהרה, וזו התנהגות נכונה. מה שאסור הוא שהוא יפיל את הקליטה.
      console.error("[heartbeat] כתיבת אות החיים נכשלה:", err.message);
    }
  }
  warmPool();                          // מיד בעלייה — לא ממתינים 60ש' לפינג הראשון
  setInterval(warmPool, KEEP_ALIVE_MS);
}

main().catch((err) => {
  console.error("master: כשל בהפעלה —", err.message);
  process.exit(1);
});
