// tools/backfill-control-system.mjs — ממלא את מערכת ההפעלה (לולק / ביטנקם …) בכל אתר.
//
//   node --env-file=.env tools/backfill-control-system.mjs            ← ריצה יבשה: מדפיס תוכנית
//   node --env-file=.env tools/backfill-control-system.mjs --apply    ← כותב, בטרנזקציה אחת
//
// ⚠️ **כותב לייצור.** ההחלטות עצמן ב-`lib/control-system-plan.mjs` ונבדקות ב-
// tests/backfill-control-system.test.js; כאן רק קריאה, הדפסה וכתיבה.
//
// ⚠️ **רץ ממחשב הפיתוח בלבד**: הטבלה נקראת מהכונן המשותף (`G:`), והקורא שלה הוא של
// FixFlow — אותו קורא שממנו נזרעו האתרים שם, כך ששני הצדדים רואים את אותה טבלה.
//
// ⚠️ מה הכלי **לעולם** אינו עושה: דורס מערכת שכבר הוגדרה, מתאים שם לשתי שורות,
// או מתרגם סוג שאין לו מקבילה בדשבורד. כל אלה מודפסים ונשארים להכרעת אדם.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { readXlsxRows } from "file:///C:/Users/נעמהמנדלסון/Documents/FixFlow/server/src/import/xlsx.js";
import { planControlSystems } from "./lib/control-system-plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const TABLE = process.env.FIXFLOW_SITE_TABLE || "G:/תיקיות אחסון שיתופי/איתור תקלות/טבלת אתרים.xlsx";
const MAP_FILE = join(HERE, "..", "..", "dashboard", "src", "components", "FixFlowLink", "fixflow-sites.json");

function readTable(file) {
  const rows = readXlsxRows(file);
  const starts = [];
  (rows[0] || []).forEach((v, i) => { if (String(v).trim() === "שם אתר") starts.push(i); });
  const out = [];
  for (const r of rows.slice(1))
    for (const c of starts) {
      const name = String(r[c] || "").trim();
      if (!name || name === "שם אתר") continue;
      out.push({ name, robot: String(r[c + 1] || "").trim().replace(/\s+/g, " "), sys: String(r[c + 2] || "").trim() });
    }
  return out;
}

async function main() {
  const table = readTable(TABLE);
  const map = JSON.parse(readFileSync(MAP_FILE, "utf8"));
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const hasColumn = (await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'sites' AND column_name = 'control_system'`)).rowCount > 0;
    if (!hasColumn && APPLY) {
      console.log("⛔ העמודה sites.control_system אינה קיימת במסד. יש להחיל קודם את db.init (deploy.ps1). לא נכתב דבר.");
      process.exitCode = 1;
      return;
    }
    const { rows: sites } = await c.query(
      `SELECT id, code, site_name, plc_type, fixflow_profile${hasColumn ? ", control_system" : ""}
         FROM sites ORDER BY code`);

    const plan = planControlSystems(sites, table, map);
    console.log(`\n=== טבלת האתרים: ${table.length} שורות · אתרים מנוטרים: ${sites.length}${hasColumn ? "" : " · ⚠️ העמודה עוד לא קיימת — תצוגה בלבד"} ===\n`);
    for (const p of plan) {
      const changes = Object.entries(p.set).map(([k, v]) => `${k}=${v === "" ? "(נקה)" : v}`).join(" · ") || "ללא שינוי";
      console.log(`${String(p.code).padEnd(5)} ${p.name}`);
      console.log(`      ${changes}${p.systemSource ? `   [${p.systemSource}]` : ""}`);
      for (const n of p.notes) console.log(`      · ${n}`);
    }
    const toWrite = plan.filter((p) => Object.keys(p.set).length);
    const bySystem = {};
    for (const p of plan) { const v = p.set.control_system ?? sites.find((s) => s.id === p.id)?.control_system ?? "?"; bySystem[v] = (bySystem[v] || 0) + 1; }
    console.log(`\nמערכת אחרי: ${Object.entries(bySystem).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
    console.log(`אתרים שישתנו: ${toWrite.length}`);

    if (!APPLY) { console.log("\n(ריצה יבשה — לא נכתב דבר. להחלה: --apply)"); return; }

    await c.query("BEGIN");
    for (const p of toWrite) {
      const cols = Object.keys(p.set);
      const assign = cols.map((k, i) => `${k} = NULLIF($${i + 2}, '')`).join(", ");
      await c.query(`UPDATE sites SET ${assign} WHERE id = $1`, [p.id, ...cols.map((k) => p.set[k])]);
      await c.query(`SELECT app.record_write_audit('site.backfill_control_system', 'tools/backfill-control-system',
                       'system', 'site', $1, $2::jsonb)`,
        [String(p.code), JSON.stringify({ set: p.set, source: p.systemSource, notes: p.notes })]);
    }
    await c.query("COMMIT");

    // ⚠️ אימות בקריאה חוזרת, ולא אמון ב-UPDATE: "נכתב" הוא מה שהמסד מחזיר עכשיו.
    const { rows: after } = await c.query(`SELECT id, plc_type, control_system, fixflow_profile FROM sites`);
    const byId = new Map(after.map((r) => [r.id, r]));
    let bad = 0;
    for (const p of toWrite)
      for (const [k, v] of Object.entries(p.set))
        if ((byId.get(p.id)?.[k] ?? "") !== v) { bad++; console.log(`❌ ${p.code}: ${k} צפוי "${v}", במסד "${byId.get(p.id)?.[k]}"`); }
    console.log(bad ? `\n❌ ${bad} ערכים לא נכתבו כמצופה` : `\n✅ ${toWrite.length} אתרים עודכנו ואומתו בקריאה חוזרת`);
    process.exitCode = bad ? 1 : 0;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.log(`⛔ ${e.message} — בוטל, לא נכתב דבר`);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

main();
