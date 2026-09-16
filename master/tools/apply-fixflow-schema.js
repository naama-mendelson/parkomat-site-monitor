// מחיל את סכימת FixFlow על Supabase.
//
//   node --env-file=.env tools/apply-fixflow-schema.js
//
// ============================================================
// ⚠️ תוספת בלבד — אף טבלה קיימת אינה נוגעת
// ============================================================
// שבע טבלאות חדשות בקידומת `ff_`, ואפס `ALTER` על משהו שקיים. זה מה שהופך
// את ההחלה לבטוחה להרצה על ייצור חי: הגרוע ביותר שיכול לקרות הוא שהיא
// תיכשל באמצע ותתגלגל חזרה, ואז שום דבר לא השתנה.
//
// ⚠️ `CREATE TABLE IF NOT EXISTS` לאורך כל הקובץ — הרצה חוזרת אינה מזיקה,
// וזו דרישה ולא נוחות: החלה שאי אפשר להריץ שוב היא החלה שאיש לא יעז לתקן.
import pg from "pg";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../db/fixflow.postgres.sql", import.meta.url), "utf8");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();
try {
  // ⚠️ lock_timeout קצר: יצירת טבלה נוטלת נעילה קלה, אבל `DROP POLICY` על
  // טבלה עמוסה ממתין. כישלון מהיר עדיף על החלה שתוקעת את הייצור.
  await c.query("SET lock_timeout = '5s'");
  await c.query("BEGIN");
  await c.query(sql);
  await c.query("COMMIT");

  const { rows } = await c.query(
    `SELECT c.relname AS table, c.relrowsecurity AS rls,
            (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname LIKE 'ff\\_%' AND c.relkind = 'r'
      ORDER BY c.relname`);
  for (const r of rows)
    console.log(`  ✅ ${r.table.padEnd(26)} RLS=${r.rls ? "on" : "OFF"}  מדיניות=${r.policies}`);
  console.log(`\n  ${rows.length} טבלאות`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n❌ ${e.message}`);
  c.release();
  await pool.end();
  process.exit(1);
}

// ⚠️ מחוץ לטרנזקציה. PostgREST מחזיק את רשימת הטבלאות בזיכרון, ובלי הרענון
// הוא יחזיר `404` על טבלה שכבר קיימת — טעות שנראית בדיוק כמו החלה שלא קרתה.
await c.query("NOTIFY pgrst, 'reload schema'");
console.log("  ✅ מטמון הסכימה של PostgREST רוענן");
c.release();
await pool.end();

console.log("\nהבא:  node --env-file=.env tools/migrate-fixflow-data.js");
