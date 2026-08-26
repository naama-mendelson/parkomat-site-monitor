// mqtt/subscriber.js — מתחבר ל-HiveMQ, מאזין, ומשדר כל הודעה כאירוע
const mqtt = require("mqtt");
const bus = require("../bus");
const { markBrokerConnected } = require("../ingestion/replay-window");

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
//
// ==========================================================
// למה המזהה ספציפי, ולא "master"
// ==========================================================
// ה-session הזה הוא **כל** הביטוח שלנו מפני נפילת ה-Master: כל מה שהאתרים
// משדרים בזמן שהוא למטה מחכה בתור אצל HiveMQ, ונמסר בהתחברות הבאה. אבל ה-session
// שייך ל-clientId — ולכן הוא שווה בדיוק כמה שהשם שלו ייחודי.
//
// לפי התקן, חיבור עם אותו clientId ועם clean:true **מוחק את ה-session השמור**
// ואת כל ההודעות שהצטברו בו. "master" הוא שם שכל אחד עלול לתפוס בדרך אגב —
// סקריפט בדיקה, לקוח MQTT גרפי, פריסה שנייה, בדיקה מהירה של מתכנת. חיבור אחד
// כזה מוחק בשקט את התור, ואין שום שגיאה: פשוט מגיע יום שבו כלום לא הושלם.
//
// זה קרה (22-26/07/2026): הודעות של 3.6 ימים אבדו, ובחיבור הראשון אחרי הנפילה
// ה-Broker דיווח sessionPresent=false — כלומר ה-session לא היה שם. לכן השם כאן
// ספציפי, ולא מילה גנרית.
//
// ברירת המחדל היא **ליטרל קבוע** ולא נגזרת משם המחשב בכוונה: שם מחשב משתנה
// בבנייה מחדש של קונטיינר או בשינוי שם המארח, ואז נוצר session חדש והתור אובד
// בשקט — בדיוק הבאג שהקוד הזה בא למנוע, רק בגרסה שקשה יותר לראות.
const clientId = process.env.MASTER_CLIENT_ID || "parkomat-master-subscriber";

console.log("subscriber: connecting to HiveMQ..");

const client = mqtt.connect(url, {
  username: USERNAME,
  password: PASSWORD,
  clientId: clientId,
  clean: false,
});

client.on("connect", (packet) => {
  connected = true;
  disconnectedSince = null;
  console.log("subscriber: connected!");

  // פותח "חלון פריקה": מיד אחרי חיבור, כל מה שהצטבר בתור נמסר בבת אחת. בחלון
  // הזה ה-dispatcher לא מיישר חותמי זמן מהעבר — שם הם backfill אמיתי ולא
  // סחיפת שעון. ראה ingestion/replay-window.js.
  markBrokerConnected();

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

// ============================================================
// PUBACK רק אחרי שההודעה נכתבה — לא כשהיא מגיעה
// ============================================================
// זו נקודת האובדן האמיתית, והיא הייתה בלתי-נראית: QoS 1 מבטיח "לפחות פעם
// אחת", אבל ההבטחה תקפה רק עד ה-PUBACK. ברגע שאישרנו, HiveMQ מוחק את ההודעה
// מהתור — לתמיד.
//
// ברירת המחדל של MQTT.js היא לאשר **מיד עם ההגעה**: handleMessage המובנה קורא
// ל-callback שלו בלי לעשות כלום, וה-PUBACK נשלח מיד אחריו
// (node_modules/mqtt/build/lib/handlers/publish.js). מכאן ההודעה חיה רק בתור
// שבזיכרון (enqueue ב-master.js). כלומר:
//
//     ההודעה מגיעה → אושרה ונמחקה מ-HiveMQ → ממתינה בזיכרון → התהליך נופל
//     → ההודעה אבדה. אין אותה בשום מקום.
//
// זה מה שקרה ב-26-27/07: השרת היה למטה ~14 שעות, בבוקר HiveMQ שפך את כל התור
// בבת אחת, השרת אישר את הכל תוך מילישניות, ואז קרס באמצע העיבוד. חמישה אתרים
// נשארו עם פעולת start חסרה, ומקטעי 'בפעולה' נפתחו בלי הפעולה שמסבירה אותם.
//
// התיקון הוא בדיוק הוו שהספרייה מיועדת לו: דוחים את ה-callback עד שההודעה
// נכתבה. מה שלא הספיק להיכתב — לא אושר, נשאר בתור אצל HiveMQ, ונמסר שוב
// בחיבור הבא. מסירה חוזרת בטוחה: ה-dedup של הפעולות בנוי על reported_at
// (שאינו משתנה), ו-applyStateChange מדלג על מצב זהה.
//
// תופעת לוואי רצויה: זה יוצר **backpressure**. הברוקר לא ירוץ קדימה מעבר
// לקצב הכתיבה שלנו, ולכן גל פריקה של 14 שעות כבר לא נבלע לתוך הזיכרון בבת
// אחת. הפינג של ה-keepalive רץ על טיימר נפרד ולא נחסם מזה.
let processMessage = null;

/**
 * רושם את מעבד ההודעות. חייב להיקרא לפני שההודעה הראשונה מגיעה — master.js
 * עושה זאת מיד אחרי ה-require, לפני שהחיבור נפתח.
 * @param fn (topic, payload) => Promise — נפתר כשההודעה נכתבה במלואה.
 */
function setMessageProcessor(fn) {
  processMessage = fn;
}

client.handleMessage = (packet, callback) => {
  const topic = packet.topic;
  const payload = packet.payload.toString();

  // עדיין לא נרשם מעבד — לא מאשרים. ההודעה תישאר בתור ותימסר שוב, וזה עדיף
  // על לאבד אותה בשקט בגלל תקלת סדר-אתחול.
  if (typeof processMessage !== "function") {
    console.error(`subscriber: אין מעבד הודעות רשום — ${topic} לא אושרה`);
    return callback(new Error("no message processor registered"));
  }

  // בכוונה אין כאן bus.emit("message"): מסלול קליטה אחד בלבד. מסלול שני היה
  // מעבד כל הודעה פעמיים — ומחוץ לחשבון האישור, כלומר בלי ההגנה שלמעלה.
  Promise.resolve()
    .then(() => processMessage(topic, payload))
    .then(
      () => callback(),
      (err) => {
        // כשל אפליקטיבי (לא קריסה): מאשרים בכל זאת, אחרת הודעה תקולה הייתה
        // חוזרת בכל חיבור מחדש וחוסמת את התור אחריה. ההתנהגות כאן זהה למה
        // שהיה קודם — נרשם ונזרק; מה שהשתנה הוא שקריסה כבר לא מאבדת הודעה.
        console.error(`subscriber: עיבוד ${topic} נכשל — ${err.message}`);

        // ============================================================
        // ⚠️ **זו הנקודה שבה תקלה אמיתית נעלמה, ולא נשאר ממנה דבר**
        // ============================================================
        // ה-callback למטה שולח PUBACK, וההודעה נמחקת מ-HiveMQ לתמיד. עד
        // עכשיו העדות היחידה הייתה שורת ה-console שמעל — ולוג של תהליך
        // נמחק כשהקונטיינר נוצר מחדש. נמדד: אתר היה בתקלה שלוש שעות, המסך
        // הראה "בפעולה", וכשחיפשנו את הסיבה הלוג של אותה שעה כבר לא היה.
        //
        // ⚠️ **בלי await, ובכוונה.** ה-PUBACK אינו אמור להמתין לרישום
        // האבחון, והרישום אינו אמור להיכנס לתור ה-FIFO של האתר.
        try {
          const { recordIngestDrop } = require("../db/queries");
          recordIngestDrop({
            topic,
            siteCode: topic.split("/")[1] || null,
            kind: topic.split("/")[2] || null,
            reason: "handler_threw",
            detail: err.message,
            payload,
          });
        } catch { /* אין לאן לרשום שהרישום נכשל */ }

        callback();
      }
    );
};

client.on("reconnect", () => {
  console.log("subscriber: מתחבר מחדש...");
});

client.on("close", () => {
  connected = false;

  // ============================================================
  // ⚠️ רק בפעם הראשונה — אחרת הניתוק לעולם לא "מזדקן"
  // ============================================================
  // mqtt.js פולט `close` **בכל ניסיון חיבור מחדש**, וה-reconnectPeriod
  // הוא שנייה. איפוס החותם בכל אירוע פירושו ש-downForSeconds() לעולם
  // לא עובר ~1 שנייה — גם בניתוק בן שעות.
  //
  // ⚠️ **וזה מבטל את בדיקת הבריאות לגמרי.** /health מחזיר 200 כי
  // `mqttDown < MQTT_UNHEALTHY_AFTER_SECONDS` תמיד מתקיים, וה-HEALTHCHECK
  // ב-Dockerfile בודק בדיוק statusCode===200. כלומר הקונטיינר מדווח
  // "בריא" לאורך ניתוק אינסופי מ-HiveMQ — בדיוק כשל ה"מגיש דפים ואינו
  // קולט" שהבדיקה נכתבה כדי לתפוס, ושארך 14.7 שעות ב-22.08.
  if (disconnectedSince === null) disconnectedSince = Date.now();

  console.log("subscriber: החיבור נסגר");
});

client.on("error", (err) => {
  console.log("subscriber error:", err.message);
});

// ============================================================
// מצב החיבור וכיבוי מסודר
// ============================================================
// שניהם נחשפים לצורכי תשתית בלבד, ואינם משנים את היגיון הקליטה:
//   • isConnected/downForSeconds — /health צריך לדעת אם השרת באמת מאזין
//     לאתרים, ולא רק אם התהליך חי. Master שמגיש דפים אבל מנותק מ-HiveMQ
//     אינו "בריא" — הוא בדיוק התקלה השקטה שהמערכת הזו קיימת כדי לתפוס.
//   • close — Docker שולח SIGTERM בעצירה. בלי ניתוק מסודר הברוקר רואה
//     ניתוק פתאומי, ובלי end(false) הודעות QoS-1 שבאוויר נקטעות באמצע.
let connected = false;
let disconnectedSince = Date.now();

function isConnected() {
  return connected;
}

/** כמה שניות החיבור למטה, או 0 אם הוא למעלה. */
function downForSeconds() {
  return connected || disconnectedSince === null
    ? 0
    : Math.round((Date.now() - disconnectedSince) / 1000);
}

/**
 * ניתוק מסודר. false = לא לכפות; נותנים ל-MQTT לסיים מסירות שבאוויר ולשלוח
 * DISCONNECT תקני. הבטחה: תמיד נפתר, גם אם הברוקר לא עונה (timeout).
 */
function close(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!client) return resolve();
    const done = setTimeout(resolve, timeoutMs);
    try {
      client.end(false, {}, () => { clearTimeout(done); resolve(); });
    } catch {
      clearTimeout(done);
      resolve();
    }
  });
}

// ה-bus נשאר ה-export הראשי (תאימות: `require("./mqtt/subscriber")` מחזיר אותו),
// והתשתית נתלית עליו כמאפיינים כדי לא לשבור אף קורא קיים.
bus.isConnected = isConnected;
bus.downForSeconds = downForSeconds;
bus.close = close;
bus.setMessageProcessor = setMessageProcessor;

module.exports = bus;
