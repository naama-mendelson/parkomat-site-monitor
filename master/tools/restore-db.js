// tools/restore-db.js — האם הגיבוי בכלל ניתן לשחזור.
//
// ============================================================
// ⚠️ זה העיקר, ולא תוספת לגיבוי
// ============================================================
// גיבוי נכשל ביום השחזור מסיבה אחת בעיקר: **הסכימה זזה**. עמודה נוספה,
// שונתה או ירדה, והקובץ מלפני חודשיים כבר לא נכנס. זה מתגלה ברגע הגרוע
// ביותר — אותה משפחת כשל בדיוק שההערה הישנה ב-backup-db הזהירה ממנה:
// משהו שנראה תקין עד שצריך אותו.
//
// כאן כל שורה מהגיבוי נטענת לטבלה **זמנית** שנבנית כ-LIKE של הטבלה
// האמיתית — אותן עמודות, אותם טיפוסים, אותם ברירות מחדל. אם הנתונים
// נכנסים לשם, הם ייכנסו גם בשחזור אמיתי.
//
// ⚠️ טבלה זמנית חיה בתוך ה-session ונעלמת בסופו, ולכן זה בטוח מול הייצור
// גם בזמן קליטת MQTT פעילה — היא אינה נראית לאף חיבור אחר.
//
// ⚠️ **וההכנסה במנות, לא שורה-שורה.** הגרסה הראשונה שלחה INSERT לכל
// שורה: 17 אלף הלוך-ושוב ברשת בתוך טרנזקציה אחת. היא רצה מעל עשר דקות
// והחזיקה טרנזקציה פתוחה על הייצור כל הזמן הזה. כלי בדיקה שמסכן את מה
// שהוא בודק אינו כלי בדיקה.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const db = require("../db/db");
const { assertTestDatabase } = require("../db/test-guard");

const BATCH = 500;

function latestBackup(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^parkomat-.*\.jsonl\.gz$/.test(f)).sort();
  if (!files.length) throw new Error(`אין קובצי גיבוי ב-${dir}`);
  return path.join(dir, files[files.length - 1]);
}

async function* readBackup(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  let table = null;
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (o.__manifest) { yield { manifest: o }; continue; }
    if (o.__table) { table = o.__table; yield { table, expected: o.rows }; continue; }
    yield { table, row: o };
  }
}

async function verify(file) {
  console.log(`בודק: ${path.basename(file)}`);
  const results = [];

  // db.transaction אינו מקבל פרמטר — הוא מנתב את ה-db הגלובלי דרך
  // AsyncLocalStorage, כך שכל db.prepare בפנים רץ על אותו client. זה בדיוק
  // מה שדרוש: טבלה זמנית שייכת ל-session, ודרך ה-pool כל שאילתה הייתה
  // נוחתת על חיבור אחר והטבלה "הייתה נעלמת".
  await db.transaction(async () => {
    let cur = null, buf = [], expected = 0;

    const flush = async () => {
      if (!cur) return;
      let loaded = 0, err = null;
      try {
        await db.prepare(`CREATE TEMP TABLE _v (LIKE public."${cur}" INCLUDING DEFAULTS)`).run();
        if (buf.length) {
          const cols = Object.keys(buf[0]);
          const names = cols.map((c) => `"${c}"`).join(", ");
          for (let i = 0; i < buf.length; i += BATCH) {
            const slice = buf.slice(i, i + BATCH);
            const tuple = `(${cols.map(() => "?").join(", ")})`;
            const values = [];
            for (const r of slice) for (const c of cols) values.push(r[c]);
            await db.prepare(
              `INSERT INTO _v (${names}) VALUES ${slice.map(() => tuple).join(", ")}`
            ).run(...values);
          }
        }
        const { n } = await db.prepare("SELECT COUNT(*)::int AS n FROM _v").get();
        loaded = n;
      } catch (e) {
        err = String(e.message).split("\n")[0].slice(0, 80);
      }
      try { await db.prepare("DROP TABLE IF EXISTS _v").run(); } catch { /* מתגלגל ממילא */ }
      results.push({ table: cur, expected, loaded, err });
      buf = [];
    };

    for await (const ev of readBackup(file)) {
      if (ev.manifest) { console.log(`נוצר: ${ev.manifest.at}`); continue; }
      if (ev.row === undefined) { await flush(); cur = ev.table; expected = ev.expected; continue; }
      buf.push(ev.row);
    }
    await flush();

    // ⚠️ גלגול לאחור תמיד. אין כאן שום מסלול שכותב לייצור.
    const e = new Error("rollback"); e.__rollback = true; throw e;
  }).catch((e) => { if (!e?.__rollback) throw e; });

  let bad = 0;
  console.log("");
  for (const r of results) {
    const ok = !r.err && r.loaded === r.expected;
    if (!ok) bad++;
    console.log(`  ${ok ? "✅" : "❌"} ${r.table.padEnd(22)} ${String(r.loaded).padStart(6)}/${String(r.expected).padEnd(6)} ${r.err || ""}`);
  }
  console.log("=".repeat(58));
  console.log(bad ? `❌ ${bad} טבלאות לא ניתנות לשחזור` : "✅ כל הטבלאות נטענו לסכימה החיה — הגיבוי בר-שחזור");
  return bad;
}

if (require.main === module) {
  (async () => {
    const dir = process.env.BACKUP_DIR || path.join(__dirname, "..", "..", "backups");
    const file = process.argv.find((a) => a.endsWith(".gz")) || latestBackup(dir);
    await db.init();
    if (process.argv.includes("--verify")) process.exit((await verify(file)) ? 1 : 0);
    // ⚠️ שחזור אמיתי דורש את סמן מסד הבדיקות. שחזור לייצור הוא פעולה
    // ידנית ומודעת, ולא משהו שכלי מריץ כי הועבר לו דגל.
    await assertTestDatabase();
    console.error("שחזור אמיתי טרם מומש — כשיהיה מסד בדיקות, כאן מקומו.");
    process.exit(1);
  })();
}

module.exports = { verify, latestBackup, readBackup };
