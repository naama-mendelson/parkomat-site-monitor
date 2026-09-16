// מחיל את שדה `sites.fixflow_profile` ואת הפונקציות שנוגעות בו.
//
//   node --env-file=.env tools/apply-fixflow-field.js
//
// ============================================================
// ⚠️ מה זה מתקן
// ============================================================
// המסך קורא ל-`update_site` עם `p_fixflow_profile`, והפונקציה בייצור עדיין
// בחתימה הישנה. PostgREST מפענח קריאה **לפי שמות הארגומנטים שנשלחו**, ולכן
// הוא אינו מוצא התאמה ומחזיר:
//
//     Could not find the function public.update_site(p_code, p_fixflow_profile)
//     in the schema cache
//
// ⚠️ **ושלושה חלקים, לא אחד.** חסר מהם משאיר את השגיאה בדיוק כפי שהיא:
//   1. העמודה `sites.fixflow_profile` — בלעדיה הפונקציה תיפול בזמן ריצה.
//   2. `check_fixflow_profile`, `register_site`, `update_site` בחתימות החדשות.
//   3. **רענון מטמון הסכימה של PostgREST.** הוא מחזיק את רשימת הפונקציות
//      בזיכרון; בלי `NOTIFY pgrst` הוא ימשיך לומר "not found" על פונקציה
//      שכבר קיימת — וזו טעות שנראית בדיוק כמו החלה שלא קרתה.
//
// ⚠️ `CREATE OR REPLACE` ו-`ADD COLUMN IF NOT EXISTS` — הרצה חוזרת אינה מזיקה.
// ו-`DROP FUNCTION` של החתימה הישנה נחוץ: הוספת פרמטר יוצרת **עמסה** ולא
// החלפה, ואז קריאה מהדפדפן נופלת על "function is not unique".
import pg from "pg";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../db/writes.postgres.sql", import.meta.url), "utf8");

// חותך מהקובץ בלוק אחד: מהעוגן ועד סוף ההגדרה.
function block(startAnchor, endAnchor) {
  const a = sql.indexOf(startAnchor);
  if (a < 0) throw new Error(`לא נמצא: ${startAnchor}`);
  const b = sql.indexOf(endAnchor, a);
  if (b < 0) throw new Error(`לא נמצא סוף עבור: ${startAnchor}`);
  return sql.slice(a, b + endAnchor.length);
}

const parts = [
  ["העמודה", `ALTER TABLE sites ADD COLUMN IF NOT EXISTS fixflow_profile TEXT;`],
  ["app.check_fixflow_profile", block("CREATE OR REPLACE FUNCTION app.check_fixflow_profile", "$fn$;")],
  ["public.register_site", block("DROP FUNCTION IF EXISTS public.register_site", "$fn$;")],
  ["public.update_site", block("DROP FUNCTION IF EXISTS public.update_site", "$fn$;")],
  ["הרשאות", `
    REVOKE ALL ON FUNCTION app.check_fixflow_profile(text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.register_site(text, text, text, text, boolean, text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.update_site(text, text, text, text, text, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.register_site(text, text, text, text, boolean, text) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.update_site(text, text, text, text, text, text) TO authenticated;`],
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();
try {
  // ⚠️ lock_timeout קצר: `DROP FUNCTION` ממתין לכל קריאה שבאוויר, והמתנה
  // בלי גבול הופכת להחלה שתוקעת את הייצור. כישלון מהיר עדיף.
  await c.query("SET lock_timeout = '5s'");
  await c.query("BEGIN");
  for (const [name, stmt] of parts) {
    await c.query(stmt);
    console.log(`  ✅ ${name}`);
  }
  await c.query("COMMIT");
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n❌ ${e.message}`);
  c.release();
  await pool.end();
  process.exit(1);
}

// ⚠️ מחוץ לטרנזקציה: PostgREST מאזין ל-NOTIFY, והודעה בטרנזקציה שנכשלת
// לא נשלחת — אבל הודעה שנשלחת לפני ה-COMMIT הייתה מרעננת מטמון על סכימה
// שעוד לא קיימת.
await c.query("NOTIFY pgrst, 'reload schema'");
console.log("  ✅ מטמון הסכימה של PostgREST רוענן");
c.release();
await pool.end();

console.log("\nלאימות:  node --env-file=.env tools/check-fixflow-mapping.js");
