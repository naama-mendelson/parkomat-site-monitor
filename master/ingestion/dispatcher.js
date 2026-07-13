// ingestion/dispatcher.js — מקבל הודעה, מפענח, בודק רישום, ומנתב

const { findSiteByCode } = require("../db/queries");
const { handleState } = require("./state-handler");
const { handleOperation } = require("./operation-handler");

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

function handleMessage(topic, raw) {
  try {
    // 1. שליפת קוד האתר וסוג ההודעה מה-topic
    const parts = topic.split("/");
    if (parts.length !== 3 || parts[0] !== "sites" || !parts[1]) {
      console.log(`[dispatcher] topic לא מוכר: ${topic}`);
      return;
    }
    const siteCode = parts[1];
    const kind = parts[2]; // "state" או "operation"

    // 2. פענוח ה-JSON
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.log(`[dispatcher] הודעה לא תקינה (לא JSON) מ-${topic}:`, raw);
      return;
    }

    if (data === null || typeof data !== "object") {
      console.log(`[dispatcher] הודעה לא תקינה (לא אובייקט) מ-${topic}:`, raw);
      return;
    }

    // 3. בדיקת רישום — אתר לא רשום נדחה
    const site = findSiteByCode(siteCode);
    if (!site) {
      console.log(`[dispatcher] נדחתה הודעה מאתר לא רשום: code=${siteCode}`);
      return;
    }

    // 4. אכיפת state חוקי — בשני סוגי ההודעות יש שדה state
    if (!VALID_STATES.includes(data.state)) {
      console.log(`[dispatcher] נדחתה הודעה עם state לא חוקי '${data.state}' מאתר ${siteCode}`);
      return;
    }

    // 5. ניתוב לפי סוג ההודעה
    if (kind === "state") {
      // הודעת ה-LWT (no_comm) נוצרת ב-Broker ואין לה זמן משלה (timestamp=0);
      // state-handler גוזר לה את זמן הקליטה. שאר ההודעות חייבות חותם זמן תקין.
      if (data.state !== "no_comm" && !isValidTimestamp(data.timestamp)) {
        console.log(`[dispatcher] נדחתה הודעת state מאתר ${siteCode}: timestamp לא תקין (${data.timestamp})`);
        return;
      }
      handleState(site, data);
    } else if (kind === "operation") {
      const problem = validateOperation(data);
      if (problem) {
        console.log(`[dispatcher] נדחתה הודעת operation מאתר ${siteCode}: ${problem}`);
        return;
      }
      handleOperation(site, data);
    } else {
      console.log(`[dispatcher] סוג הודעה לא מוכר (${kind}) מ-${topic}`);
    }
  } catch (err) {
    console.error(`[dispatcher] שגיאה בטיפול בהודעה מ-${topic}:`, err.message);
  }
}

module.exports = { handleMessage };
