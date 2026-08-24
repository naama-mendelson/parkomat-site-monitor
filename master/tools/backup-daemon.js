// tools/backup-daemon.js — מריץ את הגיבוי בשעה קבועה, בתהליך נפרד.
//
// ============================================================
// ⚠️ למה קונטיינר נפרד ולא חזרה ל-master
// ============================================================
// המשימה היומית הוצאה מ-master במכוון: הוא מחזיק קליטת MQTT ובוט, וזהו.
// גיבוי שרץ בתוכו היה מחזיר בדיוק את מה שהוצא — ובנוסף, כל כשל בגיבוי
// היה נוגע בתהליך שמחזיק session פתוח מול HiveMQ.
//
// ⚠️ **וזו הסיבה שאין כאן db.init().** שני קונטיינרים שעולים יחד ומריצים
// את ה-DDL במקביל זה בדיוק התרחיש שיצר deadlock מול הקליטה ואיבד הודעת
// תקלה מאתר 1284. `db.prepare` עובד בלי אתחול — נבדק — ולכלי גיבוי אין
// שום עסק להריץ מיגרציות.
//
// ============================================================
// ⚠️ שני הכשלים של המתזמן הישן, ואיך הם נמנעים כאן
// ============================================================
// 1. **סחיפה.** הישן היה setTimeout(10 שניות) ואז setInterval(24 שעות),
//    כך שהשעה זזה בכל הפעלה מחדש, ושרת שהופעל מחדש לעתים קרובות יותר
//    מפעם ביום **לא הגיע לטיימר כלל**. כאן מחושב מחדש בכל פעם כמה זמן
//    נשאר עד השעה הקבועה הבאה — אין מה שיסחף.
// 2. **דילוג שקט.** שרת שהיה למטה בשעה היעודה פשוט פספס. כאן, בעלייה,
//    אם אין גיבוי מהיום — הוא נעשה מיד.
const fs = require("fs");
const path = require("path");
const { runBackup } = require("./backup-db");

// UTC, כמו pg_cron ושאר המערכת. 02:30 — לפני גיזום ה-events ב-03:17,
// כך שהגיבוי כולל גם את מה שעומד להימחק.
const HOUR = Number(process.env.BACKUP_HOUR_UTC || 2);
const MINUTE = Number(process.env.BACKUP_MINUTE_UTC || 30);
const DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "..", "backups");

function msUntilNext() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(HOUR, MINUTE, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function hasBackupToday() {
  if (!fs.existsSync(DIR)) return false;
  const today = new Date().toISOString().slice(0, 10);
  return fs.readdirSync(DIR).some((f) => f.startsWith(`parkomat-${today}`));
}

async function once(reason) {
  try {
    await runBackup({ dir: DIR });
  } catch (e) {
    // ⚠️ לא מפילים את התהליך. restart: unless-stopped היה מרים אותו מיד,
    // הוא היה נכשל שוב, ונוצרת לולאת הפעלות שמסתירה את הסיבה בלוג.
    console.error(`[backup] ❌ (${reason}) ${e.message}`);
  }
}

function schedule() {
  const ms = msUntilNext();
  const at = new Date(Date.now() + ms).toISOString().replace("T", " ").slice(0, 16);
  console.log(`[backup] הגיבוי הבא: ${at} UTC (בעוד ${Math.round(ms / 60000)} דקות)`);
  setTimeout(async () => { await once("מתוזמן"); schedule(); }, ms);
}

(async () => {
  console.log(`[backup] דיימון עלה · יעד ${DIR} · שעה ${String(HOUR).padStart(2, "0")}:${String(MINUTE).padStart(2, "0")} UTC`);
  if (!hasBackupToday()) {
    console.log("[backup] אין גיבוי מהיום — מגבה עכשיו");
    await once("עלייה");
  } else {
    console.log("[backup] כבר קיים גיבוי מהיום — מדלג");
  }
  schedule();
})();
