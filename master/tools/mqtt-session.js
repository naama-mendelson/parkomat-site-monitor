// tools/mqtt-session.js — יצירה ומחיקה של session מול HiveMQ, לפי clientId.
//
// ==========================================================
// למה הכלי הזה קיים
// ==========================================================
// ה-Master מתחבר עם clientId קבוע ו-clean:false, כדי שהברוקר ישמור את המנוי
// ואת הודעות ה-QoS 1 בזמן שהוא למטה (ראה mqtt/subscriber.js). מכאן נובעות שתי
// פעולות תחזוקה שאין להן שום דרך אחרת:
//
//   --create  יוצר session *לפני* שה-Master מתחיל להשתמש בו. חיוני בהחלפת
//             clientId: ל-clientId חדש אין session, ולכן כל מה שמשודר לפני
//             החיבור הראשון שלו אינו נשמר לו בכלל. יוצרים אותו בעוד ה-Master
//             הישן עדיין רץ, וכך אין רגע שבו אף אחד לא אוסף.
//
//   --purge   מוחק session ואת התור שלו. משמש לניקוי מזהה שיצא משימוש, שאחרת
//             ממשיך לצבור הודעות שאיש לא יקרא עד שיפוג.
//
// שימוש (מתיקיית master):
//   node --env-file=.env tools/mqtt-session.js --create parkomat-master-subscriber-prod
//   node --env-file=.env tools/mqtt-session.js --purge  master
//
// ⚠️ --purge היא בדיוק הפעולה שמוחקת תור. הכלי מסרב להריץ אותה על ה-clientId
//    שמוגדר כרגע ב-MASTER_CLIENT_ID, כדי שלא נמחק בטעות את התור החי.

const mqtt = require("mqtt");

// ה-topics שה-Master מאזין להם. חייבים להיות זהים לאלה שב-mqtt/subscriber.js:
// session נושא את *המנויים* שלו, ולכן session שנוצר עם מנויים חלקיים יצבור
// רק חלק מההודעות — והחסר יאבד בשקט.
const TOPICS = ["sites/+/state", "sites/+/operation", "sites/+/bridge"];

const HOST = process.env.HIVEMQ_HOST;
const PORT = process.env.HIVEMQ_PORT;
const USERNAME = process.env.MASTER_USERNAME;
const PASSWORD = process.env.MASTER_PASSWORD;

const missing = [
  ["HIVEMQ_HOST", HOST],
  ["HIVEMQ_PORT", PORT],
  ["MASTER_USERNAME", USERNAME],
  ["MASTER_PASSWORD", PASSWORD],
].filter(([, value]) => !value).map(([name]) => name);

if (missing.length > 0) {
  console.error(`חסרות הגדרות סביבה: ${missing.join(", ")}`);
  console.error("הרץ מתיקיית master עם --env-file=.env");
  process.exit(1);
}

const mode = process.argv[2];
const targetId = process.argv[3];

if ((mode !== "--create" && mode !== "--purge") || !targetId) {
  console.error("שימוש: node --env-file=.env tools/mqtt-session.js --create|--purge <clientId>");
  process.exit(1);
}

// שער הבטיחות: לא מוחקים את ה-session שה-Master משתמש בו כרגע.
if (mode === "--purge" && targetId === (process.env.MASTER_CLIENT_ID || "").trim()) {
  console.error(
    `סירוב: '${targetId}' הוא ה-MASTER_CLIENT_ID הפעיל. מחיקת ה-session שלו תמחק ` +
    "את התור החי — כלומר כל מה שהאתרים שידרו בזמן שה-Master למטה.");
  process.exit(1);
}

const url = `mqtts://${HOST}:${PORT}`;
// create → clean:false משמר את ה-session ואת המנויים. purge → clean:true מוחק אותם.
const clean = mode === "--purge";

console.log(`${mode} '${targetId}' על ${HOST} (clean=${clean})...`);

const client = mqtt.connect(url, {
  username: USERNAME,
  password: PASSWORD,
  clientId: targetId,
  clean,
  // חיבור חד-פעמי: בלי ניסיונות חוזרים אינסופיים. אם החיבור נכשל רוצים לדעת מיד,
  // ולא לראות סקריפט שנתקע בלולאת reconnect.
  reconnectPeriod: 0,
  connectTimeout: 15000,
});

// יוצאים תמיד דרך כאן, כדי שקוד היציאה ישקף הצלחה/כשל גם אם ה-socket נשאר פתוח.
// הדגל חיוני: client.end מפעיל את אירוע ה-close, ובלעדיו מטפל ה-close היה מדווח
// "נסגר לפני שהפעולה הושלמה" ומחזיר 1 גם על הצלחה מלאה.
let done = false;
function finish(code, message) {
  if (done) return;
  done = true;
  console.log(message);
  client.end(true, () => process.exit(code));
  // רשת ביטחון: אם end לא חוזר, לא נשארים תלויים.
  setTimeout(() => process.exit(code), 3000).unref();
}

client.on("connect", (packet) => {
  const present = Boolean(packet && packet.sessionPresent);
  console.log(`התחברנו. sessionPresent=${present}`);

  if (mode === "--purge") {
    // clean:true בעצם החיבור כבר מחק את ה-session הקודם. sessionPresent חייב
    // להיות false — זו ההגדרה של clean session.
    return finish(0,
      `נמחק. ה-session של '${targetId}' והתור שלו אינם קיימים יותר.`);
  }

  // --create: נרשמים לכל ה-topics. רק אחרי SUBACK ה-session באמת צובר הודעות,
  // ולכן ממתינים לו ולא מתנתקים לפני.
  //
  // הצורה היא מפה של topic → אפשרויות. מערך של {topic, qos} *אינו* נתמך ב-mqtt v5
  // והוא נכשל ב-topic.split בתוך הוולידציה.
  const subscription = Object.fromEntries(TOPICS.map((t) => [t, { qos: 1 }]));

  client.subscribe(subscription, (err, granted) => {
    if (err) {
      return finish(1, `כשל בהרשמה ל-topics: ${err.message}`);
    }

    // QoS 128 = הרשמה שנדחתה (אין הרשאה). זה נראה כמו הצלחה ב-callback, ולכן
    // בודקים מפורשות — אחרת ניצור session שלא צובר כלום ונחשוב שהכול תקין.
    const denied = (granted || []).filter((g) => g.qos === 128).map((g) => g.topic);
    if (denied.length > 0) {
      return finish(1, `ההרשמה נדחתה (אין הרשאה) ל: ${denied.join(", ")}`);
    }

    const list = (granted || []).map((g) => `${g.topic} (qos ${g.qos})`).join(", ");
    console.log(`נרשמנו: ${list}`);

    if (present) {
      console.log("הערה: session כזה כבר היה קיים — לא נוצר חדש, והתור הקיים נשמר.");
    }

    finish(0,
      `ה-session של '${targetId}' קיים וצובר הודעות מעכשיו. ` +
      "אפשר להעביר את ה-Master למזהה הזה בלי לאבד דבר.");
  });
});

client.on("error", (err) => {
  finish(1, `שגיאת חיבור: ${err.message}`);
});

client.on("close", () => {
  // אם נסגר לפני שהספקנו לסיים — זה כשל (למשל אימות שנדחה).
  if (done) return;
  console.error("החיבור נסגר לפני שהפעולה הושלמה.");
  process.exit(1);
});
