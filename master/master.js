// master.js — מנצח: מדליק MQTT, ingestion, ו-API (כולל SSE)

const bus = require("./bus");
const db = require("./db/db");
const { handleMessage } = require("./ingestion/dispatcher");
const { startApiServer } = require("./api/routes");

// תחזוקה יומית: גיבוי → סיכום → ניקוי (בודק כל 24 שעות)
const { runBackup } = require("./tools/backup-db");
const { runMonthlySummary } = require("./tools/monthly-summary");
const { runCleanup } = require("./tools/cleanup-old-data");

async function dailyMaintenance() {
  // כל שלב עטוף בנפרד: כשל בסיכום/ניקוי לא צריך להפיל את השרת (MQTT + API)
  // ולא צריך למנוע את השלבים האחרים.
  const steps = [
    ["גיבוי", runBackup],               // 1. ביטוח — לפני כל שינוי
    ["סיכום חודשי", runMonthlySummary],  // 2. לחודש שנגמר
    ["ניקוי", runCleanup],              // 3. מעל שנה
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

async function main() {
  // הסכמה חייבת להיות מוכנה *לפני* שמאזינים ל-MQTT — אחרת ההודעה הראשונה
  // תגיע לטבלה שעדיין לא נוצרה.
  await db.init();

  require("./mqtt/subscriber");   // מתחבר רק אחרי שה-DB מוכן

  bus.on("message", (topic, data) => {
    // handleMessage מטפל בשגיאות בעצמו; ה-catch כאן הוא רשת ביטחון אחרונה
    // כדי שהודעה תקולה לא תפיל את התהליך.
    enqueue(topic, () =>
      handleMessage(topic, data).catch((err) => {
        console.error("[master] שגיאה בטיפול בהודעה:", err.message);
      }));
  });

  await startApiServer();

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
  }
  warmPool();                          // מיד בעלייה — לא ממתינים 60ש' לפינג הראשון
  setInterval(warmPool, KEEP_ALIVE_MS);
}

main().catch((err) => {
  console.error("master: כשל בהפעלה —", err.message);
  process.exit(1);
});
