// מחיל את `app.mark_silent_agents` מתוך db/cron.postgres.sql על מסד הייצור.
//
//   node --env-file=.env tools/apply-mark-silent-agents.js
//
// ⚠️ `CREATE OR REPLACE` ולא `DROP` + `CREATE`. `DROP FUNCTION` על פונקציה
// חיה לוקח ACCESS EXCLUSIVE ומחכה לכל קריאה שבאוויר — ב-15/09/2026 זה הפיל
// `canceling statement due to statement timeout` על מסך המשתמשת. החתימה לא
// משתנה, ולכן החלפה במקום היא כל מה שנדרש.
//
// ⚠️ ו-`lock_timeout` קצר במכוון: הסריקה רצה כל דקה, והחלפה שממתינה בלי
// גבול הופכת לתור על הייצור. כישלון מהיר עדיף — אפשר לנסות שוב.
import pg from "pg";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../db/cron.postgres.sql", import.meta.url), "utf8");
const start = sql.indexOf("CREATE OR REPLACE FUNCTION app.mark_silent_agents");
const end = sql.indexOf("$fn$;", start);
if (start < 0 || end < 0) throw new Error("לא נמצאה ההגדרה של mark_silent_agents");
const body = sql.slice(start, end + "$fn$;".length);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await pool.query("SET lock_timeout = '5s'");
await pool.query(body);
console.log(`✅ app.mark_silent_agents הוחלה (${body.length} תווים)`);
await pool.end();
