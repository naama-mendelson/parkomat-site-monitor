// tools/backup-db.js — גיבוי בטוח של ה-DB ל-Google Drive
// שימוש ידני: node master/tools/backup-db.js
// שימוש מ-master: require("./tools/backup-db").runBackup()

const path = require("path");
const fs = require("fs");
const { backupDatabase } = require("../db/queries");

// נתיב הגיבוי — תיקייה ב-Google Drive (מסונכרנת אוטומטית לענן)
const BACKUP_DIR = path.join("G:", "האחסון שלי", "Parkomat-Backups");
const MAX_BACKUPS = 7;

function runBackup() {
  // בדיקה ש-Google Drive נגיש
  if (!fs.existsSync(path.join("G:", "האחסון שלי"))) {
    console.error("[backup] ❌ Google Drive לא נגיש (G:\\האחסון שלי). גיבוי דולג.");
    return;
  }

  // יצירת תיקיית גיבויים אם לא קיימת
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`[backup] נוצרה תיקייה: ${BACKUP_DIR}`);
  }

  // שם הקובץ עם תאריך
  const today = new Date().toISOString().slice(0, 10); // "2026-06-30"
  const backupPath = path.join(BACKUP_DIR, `sitemonitor_${today}.db`);

  // אם כבר גיבה היום — דלג
  if (fs.existsSync(backupPath)) {
    console.log(`[backup] גיבוי להיום כבר קיים: ${today}`);
    return;
  }

  // גיבוי בטוח (better-sqlite3 backup API — בטוח גם תוך כדי כתיבה)
  try {
    backupDatabase(backupPath);
    console.log(`[backup] ✅ גיבוי נוצר: ${backupPath}`);
  } catch (err) {
    console.error(`[backup] ❌ שגיאה בגיבוי:`, err.message);
    return;
  }

  // מחיקת גיבויים ישנים (שומר רק 7 אחרונים)
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("sitemonitor_") && f.endsWith(".db"))
    .sort()
    .reverse(); // מהחדש לישן

  if (files.length > MAX_BACKUPS) {
    const toDelete = files.slice(MAX_BACKUPS);
    for (const file of toDelete) {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
      console.log(`[backup] 🗑️ גיבוי ישן נמחק: ${file}`);
    }
  }
}

if (require.main === module) {
  runBackup();
}

module.exports = { runBackup };