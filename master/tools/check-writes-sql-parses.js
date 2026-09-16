// בודק ש-`db/writes.postgres.sql` נטען בלי שגיאת תחביר — **בטרנזקציה שמתגלגלת
// חזרה**, כלומר בלי לשנות דבר בייצור.
//
//   node --env-file=.env tools/check-writes-sql-parses.js
//
// ============================================================
// ⚠️ למה זה נחוץ דווקא עכשיו
// ============================================================
// הדשבורד מוגש מ-Cloudflare Pages ומתעדכן מכל `git push`; ה-SQL מוחל רק
// כשעולה `master` ב-DELL008. כלומר **מסך שקורא לפונקציה חדשה יכול לעלות לפני
// שהפונקציה קיימת** — והמשתמשת תראה שמירה שנכשלת בלי שום הסבר מובן.
//
// הבדיקה הזו אינה מחליפה את ההחלה; היא רק מוודאת שכשההחלה תרוץ, היא לא תיפול
// באמצע ותשאיר חצי מהפונקציות מוחלפות.
//
// ⚠️ **ROLLBACK ולא COMMIT, ובמכוון.** ב-Postgres גם DDL הוא טרנזקציוני, ולכן
// אפשר לטעון את כל הקובץ, לראות שהוא נטען, ולהחזיר את המצב בדיוק כפי שהיה.
// כלי אימות שמשנה את מה שהוא בא לאמת הוא מלכודת.
import pg from "pg";
import { readFileSync } from "node:fs";

const FILES = ["../db/writes.postgres.sql"];

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  let failed = 0;
  try {
    for (const f of FILES) {
      const sql = readFileSync(new URL(f, import.meta.url), "utf8");
      await c.query("BEGIN");
      try {
        await c.query("SET LOCAL lock_timeout = '5s'");
        await c.query(sql);
        console.log(`✅ ${f} — נטען במלואו (${sql.length} תווים)`);
      } catch (e) {
        failed++;
        console.log(`❌ ${f} — ${e.message}`);
        if (e.position) console.log(`   מיקום ${e.position}: …${sql.slice(Math.max(0, e.position - 120), Number(e.position) + 60)}…`);
      } finally {
        await c.query("ROLLBACK");
      }
    }
  } finally {
    c.release();
    await pool.end();
  }
  console.log(failed ? `\n❌ ${failed} קבצים נכשלו` : `\n✅ הכול נטען — ההחלה לא תיפול באמצע`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
