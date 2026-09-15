// check-fixflow-mapping.js — לאן כל אתר מגיע ב-FixFlow, לפי סוג המכונה שלו.
//
//   node --env-file=.env tools/check-fixflow-mapping.js
//
// שער, לא דוח: הוא נופל כשאתר מגיע לספרייה ריקה. אתר שמציג רשימת תקלות ריקה
// אינו מראה שגיאה למוקדן — הוא נראה בדיוק כמו אתר שאין לו תקלות ידועות, וזה
// כשל שאי אפשר להבחין בו מהמסך.
//
// ⚠️ הכלי אינו כותב דבר, לא כאן ולא ב-FixFlow.
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { resolveProfile } from "../../shared/fixflow-profiles.mjs";

const FIXFLOW_DB =
  process.env.FIXFLOW_DB_PATH ||
  "C:\\Users\\נעמהמנדלסון\\Documents\\FixFlow\\server\\data\\parkomat.sqlite";

async function main() {
  const ff = new DatabaseSync(FIXFLOW_DB, { readOnly: true });
  const counts = new Map();
  for (const r of ff
    .prepare(
      `SELECT sy.name AS system, p.name AS profile,
              (SELECT COUNT(*) FROM faults f WHERE f.profile_id = p.id AND f.deleted_at IS NULL) AS faults,
              (SELECT COUNT(*) FROM procedures pr WHERE pr.profile_id = p.id AND pr.deleted_at IS NULL) AS procs
         FROM profiles p JOIN systems sy ON sy.id = p.system_id`
    )
    .all())
    counts.set(`${r.system}|${r.profile}`, r.faults + r.procs);
  ff.close();

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows: sites } = await pool.query(`SELECT code, site_name, plc_type FROM sites ORDER BY code`);
  await pool.end();

  const buckets = { ok: [], empty: [], needsSystem: [], unmapped: [], noType: [] };
  for (const s of sites) {
    // ⚠️ המערכת (לולק/ביטנקם) אינה נשמרת באף שדה ב-SiteMonitor, ולכן לא מועבר
    // כאן ערך. זו אינה השמטה — זה בדיוק הפער שהכלי אמור להאיר.
    const r = resolveProfile(s.plc_type, null);
    const row = { ...s, ...r };
    if (r.status === "no-type") buckets.noType.push(row);
    else if (r.status === "needs-system") buckets.needsSystem.push(row);
    else if (r.status === "unmapped") buckets.unmapped.push(row);
    else {
      row.docs = counts.get(`${r.system}|${r.profile}`) ?? 0;
      (row.docs > 0 ? buckets.ok : buckets.empty).push(row);
    }
  }

  const line = (s, extra = "") =>
    `   ${String(s.code).padEnd(6)} ${String(s.site_name).slice(0, 24).padEnd(25)} ${String(s.plc_type ?? "—").padEnd(11)} ${extra}`;

  console.log(`\n=== לאן כל אתר מגיע ב-FixFlow ===   (${sites.length} אתרים)\n`);
  console.log(`✅ מחובר לספרייה עם תוכן (${buckets.ok.length}):`);
  for (const s of buckets.ok) console.log(line(s, `${s.profile} — ${s.docs} מסמכים`));

  if (buckets.empty.length) {
    console.log(`\n❌ מחובר לספרייה **ריקה** (${buckets.empty.length}) — המוקדן יראה רשימה ריקה:`);
    for (const s of buckets.empty) console.log(line(s, `${s.profile} — 0 מסמכים`));
  }
  if (buckets.needsSystem.length) {
    console.log(`\n⚠️  חסר לדעת לולק או ביטנקם (${buckets.needsSystem.length}):`);
    for (const s of buckets.needsSystem) console.log(line(s, s.reason));
  }
  if (buckets.unmapped.length) {
    console.log(`\n⚠️  סוג שטרם הוכרע (${buckets.unmapped.length}):`);
    for (const s of buckets.unmapped) console.log(line(s, s.reason));
  }
  if (buckets.noType.length) {
    console.log(`\n⚠️  אין סוג מכונה (${buckets.noType.length}) — אי אפשר לחבר לשום ספרייה:`);
    for (const s of buckets.noType) console.log(line(s));
  }

  const broken = buckets.empty.length;
  console.log(
    `\nמחוברים: ${buckets.ok.length} · ריקים: ${buckets.empty.length} · ממתינים להכרעה: ${buckets.needsSystem.length + buckets.unmapped.length + buckets.noType.length}`
  );
  process.exit(broken === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
