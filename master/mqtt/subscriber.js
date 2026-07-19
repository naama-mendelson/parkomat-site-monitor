// mqtt/subscriber.js — מתחבר ל-HiveMQ, מאזין, ומשדר כל הודעה כאירוע
const mqtt = require("mqtt");
const bus = require("../bus");

// פרטי החיבור (master — מאזין בלבד)
const HOST = process.env.HIVEMQ_HOST;
const PORT = process.env.HIVEMQ_PORT;
const USERNAME = process.env.MASTER_USERNAME;
const PASSWORD = process.env.MASTER_PASSWORD;

// בלי בדיקה כאן הכתובת הופכת ל-"mqtts://undefined:undefined" והשרת נכנס
// ללולאת שגיאות אינסופית בלי לרמוז שחסרה הגדרה.
const missing = [
  ["HIVEMQ_HOST", HOST],
  ["HIVEMQ_PORT", PORT],
  ["MASTER_USERNAME", USERNAME],
  ["MASTER_PASSWORD", PASSWORD],
].filter(([, value]) => !value).map(([name]) => name);

if (missing.length > 0) {
  console.error(`subscriber: חסרות הגדרות סביבה: ${missing.join(", ")}`);
  console.error("subscriber: ראה README — בלעדיהן אין קליטת מידע מהאתרים.");
  process.exit(1);
}

const url = `mqtts://${HOST}:${PORT}`;

// clientId קבוע (ולא אקראי) יחד עם clean:false — כך ה-Broker שומר את המנוי
// ואת הודעות ה-QoS 1 בזמן שה-Master למטה, ומוסר אותן בהתחברות הבאה.
// עם clientId אקראי כל הפעלה מחדש פותחת session חדש, וכל מה ששודר בינתיים אבד.
// שימו לב: רק מופע אחד של ה-Master יכול לרוץ עם המזהה הזה — שני מופעים ינתקו זה את זה.
const clientId = process.env.MASTER_CLIENT_ID || "master";

console.log("subscriber: connecting to HiveMQ..");

const client = mqtt.connect(url, {
  username: USERNAME,
  password: PASSWORD,
  clientId: clientId,
  clean: false,
});

client.on("connect", (packet) => {
  console.log("subscriber: connected!");

  // sessionPresent=true פירושו שה-Broker שימר את המנוי מהחיבור הקודם.
  // נרשמים בכל מקרה — הרשמה חוזרת היא idempotent, ומגנה על מקרה שבו
  // ה-Broker כן איבד את ה-session (למשל אחרי restart שלו).
  if (packet && packet.sessionPresent) {
    console.log("subscriber: session קודם שוחזר — הודעות שהצטברו יימסרו כעת");
  }

  client.subscribe("sites/+/state", { qos: 1 }, (err) => {
    if (err) console.error("subscriber: failed to subscribe to state:", err.message);
  });

  client.subscribe("sites/+/operation", { qos: 1 }, (err) => {
    if (err) console.error("subscriber: failed to subscribe to operation:", err.message);
  });

  // ==========================================================
  // מצב הגשר — השכבה השנייה של זיהוי הניתוק
  // ==========================================================
  // ה-LWT של הסוכן (על sites/+/state) מכסה מקרה אחד: תהליך הסוכן נופל
  // בזמן שהמחשב חי — Mosquitto המקומי רואה זאת ומפרסם no_comm.
  //
  // אבל כשהחשמל נופל באתר, Mosquitto מת יחד עם הסוכן ואין מי שיפרסם. מה
  // שכן קורה: חיבור הגשר ל-HiveMQ נשבר, ו-HiveMQ — שאצלו רשום will של
  // הגשר — מפרסם "0" ל-topic הזה אחרי 1.5 × keepalive (90 שניות).
  //
  // זה ה-topic שמסגיר אתר שנעלם לגמרי, וזה המקרה שהכי חשוב לתפוס בחניון.
  client.subscribe("sites/+/bridge", { qos: 1 }, (err) => {
    if (err) console.error("subscriber: failed to subscribe to bridge:", err.message);
  });

  console.log("subscriber: listening to sites/+/state, sites/+/operation, sites/+/bridge (QoS 1)");
});

// כל הודעה שמגיעה — משדרים אותה הלאה כאירוע "message"
client.on("message", (topic, message) => {
  bus.emit("message", topic, message.toString());
});

client.on("reconnect", () => {
  console.log("subscriber: מתחבר מחדש...");
});

client.on("close", () => {
  console.log("subscriber: החיבור נסגר");
});

client.on("error", (err) => {
  console.log("subscriber error:", err.message);
});

// חושפים את ה-bus כדי שחלקים אחרים יוכלו להאזין
module.exports = bus;
