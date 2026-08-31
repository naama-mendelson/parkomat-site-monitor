// tools/backup-health.js — האם הגיבוי באמת קורה. יוצא 0 אם כן, 1 אם לא.
//
// ============================================================
// ⚠️ למה בכלל צריך את זה — הקונטיינר היה לא-בריא מעצם הבנייה
// ============================================================
// שירות `backup` משתמש ב-`image: parkomat:latest`, ולכן ירש את
// ה-HEALTHCHECK של master — בקשת HTTP ל-127.0.0.1:4000/health. אבל
// הקונטיינר הזה מריץ `backup-daemon.js` ואינו מגיש דבר על 4000, כלומר
// **הוא לא יכול לעבור את הבדיקה אף פעם**.
//
// ⚠️ נמדד ב-DELL008: `parkomat-backup  Up 20 minutes (unhealthy)` —
// והכפתור בשולחן העבודה הדפיס לידו **וי ירוק**. סימן שדולק תמיד הוא סימן
// שמפסיקים לקרוא, ואז גם האמיתי נבלע בתוכו.
//
// ============================================================
// ⚠️ ולמה לא פשוט לכבות את הבדיקה
// ============================================================
// `healthcheck: disable: true` היה מסיר את הרעש ומשאיר את הקונטיינר בלי
// שום סימן חיים. אבל לדיימון הזה **יש** מצב בריאות אמיתי, והוא בדיוק מה
// שחשוב: האם נוצר גיבוי לאחרונה.
//
// ⚠️ והשאלה הזו אינה "האם התהליך חי". דיימון יכול לרוץ חודש שלם בזמן
// ש-runBackup נכשל בכל פעם — הוא תופס את השגיאה בכוונה ואינו מפיל את
// עצמו (אחרת `restart: unless-stopped` היה יוצר לולאת הפעלות שמסתירה את
// הסיבה). כלומר תהליך חי הוא **בדיוק** מה שרואים כשהגיבוי מת.
const fs = require("node:fs");
const path = require("node:path");

const DIR = process.env.BACKUP_DIR || "/backups";

// 25 שעות ולא 24: הגיבוי רץ בשעה קבועה, ובדיקה של 24 שעות בדיוק הייתה
// נכשלת על הפרש של דקות סביב אותה שעה בכל יום. אותו סף בדיוק שב-deploy.ps1.
const MAX_AGE_MS = 25 * 60 * 60 * 1000;

try {
  if (!fs.existsSync(DIR)) {
    console.error(`אין תיקיית גיבוי: ${DIR}`);
    process.exit(1);
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  let newest = null;

  for (const f of fs.readdirSync(DIR)) {
    if (!f.startsWith("parkomat-")) continue;
    const st = fs.statSync(path.join(DIR, f));
    // ⚠️ גודל אפס נספר ככישלון ולא כהצלחה. קובץ חתוך — בדיוק מה שנוצר
    // כשהקונטיינר נהרג באמצע כתיבה — נראה כמו גיבוי בכל בדיקה שסופרת
    // קבצים בלבד.
    if (st.size === 0) continue;
    if (!newest || st.mtimeMs > newest.mtimeMs) newest = { f, ...st };
  }

  if (!newest) {
    console.error("אין אף קובץ גיבוי תקין");
    process.exit(1);
  }

  const ageH = (Date.now() - newest.mtimeMs) / 3600000;
  if (newest.mtimeMs < cutoff) {
    console.error(`הגיבוי האחרון (${newest.f}) בן ${ageH.toFixed(1)} שעות`);
    process.exit(1);
  }

  console.log(`${newest.f} · ${Math.round(newest.size / 1024)}KB · לפני ${ageH.toFixed(1)} שעות`);
  process.exit(0);
} catch (e) {
  // ⚠️ שגיאה בבדיקה עצמה היא **לא-בריא**, לא "אין ידיעה". בדיקת בריאות
  // שמחזירה 0 כשהיא נכשלה היא הדבר היחיד שגרוע מאין בדיקה בכלל.
  console.error(`בדיקת הבריאות נכשלה: ${e.message}`);
  process.exit(1);
}
