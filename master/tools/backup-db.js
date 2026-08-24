// tools/backup-db.js — גיבוי נתונים אמיתי, מחוץ ל-Supabase.
//
// ============================================================
// ⚠️ הכלי הזה היה no-op, וההערה שהסבירה למה עדיין נכונה — חלקית
// ============================================================
// הגרסה הקודמת העתיקה את קובץ ה-SQLite. אחרי ההגירה הקובץ ריק, ולכן
// היא הושבתה בצדק: גיבוי שנראה תקין ואינו שווה כלום ביום שצריך אותו
// גרוע מאי-גיבוי, כי הוא שקט. הנימוק ההוא עמד.
//
// מה שהשתנה: התברר שאין **שום** עותק מחוץ ל-Supabase, ושכל שמונת
// המשתמשים הם מנהלים — כלומר `delete_site` מוחק אתר ואת כל ההיסטוריה
// שלו, לצמיתות, בלחיצה אחת. הסיכון הזה אינו "פריצה": טעות אנוש אחת
// עושה את אותו נזק והיא סבירה בהרבה.
//
// ============================================================
// למה JS ולא pg_dump
// ============================================================
// pg_dump אינו קיים לא במחשב הפיתוח ולא בקונטיינר (node:24-alpine עם
// tzdata בלבד). אפשר היה להתקין postgresql-client, אבל זה מוסיף תלות
// בבינארי שגרסתו חייבת להתאים לשרת — כשל שמתגלה ביום השחזור.
//
// ⚠️ **וזה גיבוי נתונים בלבד, במכוון.** הסכימה, הפונקציות, המדיניות
// והתזמונים כבר חיים ב-git (`schema.postgres.sql`, `functions.postgres.sql`,
// `security.postgres.sql`, `writes.postgres.sql`, `cron.postgres.sql`) —
// זו כל הארכיטקטורה של הפרויקט. שחזור מלא = `db.init()` מ-git, ואז
// הנתונים מכאן. גיבוי שהיה כולל גם סכימה היה מייצר מקור אמת שני.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const db = require("../db/db");

// הסדר חשוב לשחזור: הורים לפני ילדים (מפתחות זרים).
const TABLES = [
  "sites", "app_users", "settings",
  "status_history", "operations", "maintenance_windows", "suppressed_faults",
  "monthly_summary", "audit_log", "events", "ingest_drops",
  "push_subscriptions", "push_user_sites", "push_user_types", "push_last_sent",
];

const DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "..", "backups");
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const CHUNK = 2000;

async function runBackup({ dir = DIR, keep = KEEP } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `parkomat-${stamp}.jsonl.gz`);
  const tmp = `${file}.partial`;

  // ⚠️ נכתב לשם זמני ומשנים שם רק בסוף. קובץ שנקטע באמצע (קריסה, דיסק
  // מלא, Ctrl+C) לא ייראה כמו גיבוי תקין בתיקייה.
  const gz = zlib.createGzip({ level: 9 });
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);
  const write = (o) => new Promise((res, rej) =>
    gz.write(JSON.stringify(o) + "\n", (e) => (e ? rej(e) : res())));

  const counts = {};
  await write({ __manifest: 1, at: new Date().toISOString(), tables: TABLES });

  for (const t of TABLES) {
    const { n } = await db.prepare(`SELECT COUNT(*)::int AS n FROM public."${t}"`).get();
    counts[t] = n;
    await write({ __table: t, rows: n });
    // מנות, ולא SELECT אחד: 17 אלף שורות זה כלום, אבל בעוד שנתיים זה
    // לא יהיה — והכלי הזה לא ייקרא שוב עד היום שבו הוא ייכשל.
    for (let off = 0; off < n; off += CHUNK) {
      const rows = await db.prepare(
        `SELECT * FROM public."${t}" ORDER BY 1 LIMIT ${CHUNK} OFFSET ${off}`
      ).all();
      for (const r of rows) await write(r);
    }
  }

  await new Promise((res, rej) => { gz.end(); out.on("finish", res); out.on("error", rej); });

  // ============================================================
  // ⚠️ אימות — בלעדיו זה שוב "אשליה של גיבוי"
  // ============================================================
  // הקובץ נקרא בחזרה ונספר. גיבוי שלא נבדק הוא בדיוק מה שההערה הישנה
  // הזהירה ממנו, רק בפורמט אחר.
  const seen = await countInFile(tmp);
  const bad = TABLES.filter((t) => (seen[t] || 0) !== counts[t]);
  if (bad.length) {
    fs.unlinkSync(tmp);
    throw new Error(`הגיבוי נכשל באימות: ${bad.map((t) => `${t} ${seen[t] || 0}/${counts[t]}`).join(", ")}`);
  }

  fs.renameSync(tmp, file);
  const kb = Math.round(fs.statSync(file).size / 1024);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[backup] ${path.basename(file)} · ${total.toLocaleString()} שורות · ${kb} KB · אומת`);

  pruneOld(dir, keep);
  return { file, counts };
}

// סופר שורות לכל טבלה מתוך קובץ גיבוי — משמש גם לאימות וגם לבדיקה ידנית.
async function countInFile(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  const seen = {};
  let cur = null;
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (o.__manifest) continue;
    if (o.__table) { cur = o.__table; seen[cur] = 0; continue; }
    if (cur) seen[cur]++;
  }
  return seen;
}

function pruneOld(dir, keep) {
  const files = fs.readdirSync(dir)
    .filter((f) => /^parkomat-.*\.jsonl\.gz$/.test(f))
    .sort()
    .reverse();
  for (const f of files.slice(keep)) {
    fs.unlinkSync(path.join(dir, f));
    console.log(`[backup] נמחק ישן: ${f}`);
  }
}

if (require.main === module) {
  (async () => {
    // ⚠️ בלי db.init(): כלי גיבוי אינו מריץ מיגרציות, ושני תהליכים
    // שמריצים DDL במקביל הם התרחיש שיצר deadlock מול הקליטה.
    try { await runBackup(); process.exit(0); }
    catch (e) { console.error("[backup] ❌", e.message); process.exit(1); }
  })();
}

module.exports = { runBackup, countInFile, TABLES };
