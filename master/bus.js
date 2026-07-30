// bus.js — EventEmitter מרכזי לתקשורת פנימית בין רכיבי ה-Master
const EventEmitter = require("events");

const bus = new EventEmitter();

// ============================================================
// publish — משדר *וגם* מתמיד. נקודה אחת, ולא שמונה.
// ============================================================
// היו שמונה קריאות ל-bus.emit("siteUpdate", …) פזורות ב-routes ובמטפלי
// הקליטה. כל אירוע צריך מעכשיו גם להיכתב לטבלת events (ראה schema —
// replay אחרי ניתוק, ושני קוראים לחוזה אחד), ולולא הריכוז כאן זה היה
// שמונה מקומות שאפשר לשכוח אחד מהם.
//
// **סדר הפעולות מכוון: קודם משדרים, אחר כך מתמידים.**
// ה-SSE הוא המסלול החי, ואין סיבה שהוא ימתין ל-INSERT. הכתיבה היא
// best-effort ובאה אחריו.
//
// ⚠️ מה שמתקבל מזה, ומה שלא: אם ה-INSERT נכשל, האירוע *ישודר* ולא
// *יירשם*, ולכן ב-replay ייווצר חור. זה מכוון — אירוע הוא נתון נגזר,
// והחלופה (להפיל הודעת קליטה בגלל כשל ברישום אירוע) גרועה בהרבה.
// ההתראה הקולית בדשבורד ממילא נגזרת מהשוואת מצב ולא מהאירועים, בדיוק
// כדי לשרוד חורים כאלה.
//
// הרישום נטען עצלנית (require בתוך הפונקציה) כדי לא ליצור תלות מחזורית:
// queries → db, ו-routes/ingestion → bus. טעינה עצלה שוברת את המחזור.
bus.publish = function publish(payload) {
  bus.emit("siteUpdate", payload);

  try {
    const { recordEvent } = require("./db/queries");
    Promise.resolve(recordEvent(payload)).catch((err) =>
      console.error("bus: רישום אירוע נכשל —", err.message));
  } catch (err) {
    console.error("bus: רישום אירוע נכשל —", err.message);
  }
};

module.exports = bus;
