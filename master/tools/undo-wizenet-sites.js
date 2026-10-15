// tools/undo-wizenet-sites.js — מוחק את האתרים הזמניים שרשם register-wizenet-sites.js (15/10/2026).
//
//   node --env-file=.env tools/undo-wizenet-sites.js            ← הרצה יבשה: אילו אתרים יימחקו
//   node --env-file=.env tools/undo-wizenet-sites.js --apply    ← מחיקה בפועל
//
// ⚠️ למה: 25 קודי פרויקט מוויזנט נרשמו כאתרים "ללא בקר" בשם "אתר <קוד>" — ובעלת המוצר: "לא הבנת, תעיף אותם,
// לא התכוונתי לזה" (היא התכוונה ללוח "מכפילים" ברמזור — ראו create-multiplier-sites.js). הקריאות עצמן
// נשארות בטבלה; הן רק חוזרות להיות בלי אתר, כמו שהיו.
//
// ⚠️ הקריטריון מבני ולא רשימה: אתר ללא בקר ששמו הוא בדיוק "אתר <הקוד שלו>" — זה מה שהכלי ההוא כתב, ושום
// אדם לא קורא כך לאתר. אתר כזה ששמו כבר שונה ביד **לא יימחק** (מישהו כבר אימץ אותו).
// דרך delete_site ב-PostgREST כמנהל זמני (tools/lib/gate-user), כמו הרישום: אותו audit_log ואותו אירוע.
const fs = require("node:fs");
const path = require("node:path");
const pg = require("pg");
const { gateToken } = require("./lib/gate-user");

const MASTER = path.join(__dirname, "..");
const APPLY = process.argv.includes("--apply");

(async () => {
  const SB = process.env.SUPABASE_URL;
  const SECRET = process.env.SUPABASE_SECRET_KEY;
  const ANON = (fs.readFileSync(path.join(MASTER, "..", "dashboard", ".env"), "utf8")
    .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();
  if (!process.env.DATABASE_URL || !SB || !SECRET || !ANON) {
    console.error("חסרים DATABASE_URL / SUPABASE_URL / SUPABASE_SECRET_KEY / VITE_SUPABASE_PUBLISHABLE_KEY");
    process.exit(1);
  }

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  let sites;
  try {
    await db.query("BEGIN READ ONLY");
    const { rows } = await db.query(`
      SELECT s.code, s.site_name,
             (SELECT count(*)::int FROM operations o WHERE o.site_id = s.id) AS ops,
             (SELECT count(*)::int FROM app_users u WHERE u.site_id = s.id AND u.role = 'agent') AS agents
        FROM sites s
       WHERE s.monitored = false AND s.site_name = 'אתר ' || s.code
       ORDER BY s.code`);
    sites = rows;
    await db.query("ROLLBACK");
  } finally { await db.end(); }

  console.log(`=== אתרים זמניים "אתר <קוד>" ללא בקר: ${sites.length} ===`);
  for (const s of sites) console.log(`  ${s.code}  ${s.site_name}  (פעולות ${s.ops}, זהויות סוכן ${s.agents})`);
  const dirty = sites.filter((s) => s.ops > 0 || s.agents > 0);
  if (dirty.length) {
    console.error(`\n⚠️ ${dirty.length} מהם כבר צברו פעולות או זהות סוכן — לא נוגעים בהם בכלי הזה.`);
    sites = sites.filter((s) => !dirty.includes(s));
  }
  if (!sites.length) return;
  if (!APPLY) { console.log("\nהרצה יבשה. למחיקה:  node --env-file=.env tools/undo-wizenet-sites.js --apply"); return; }

  const retry = async (url, opt) => {
    let last;
    for (let i = 0; i < 5; i++) {
      try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); }
    }
    throw last;
  };
  const g = await gateToken(SB, ANON, SECRET, retry);
  let done = 0, failed = 0;
  try {
    const H = { apikey: ANON, Authorization: `Bearer ${g.token}`, "Content-Type": "application/json" };
    for (const { code } of sites) {
      const r = await retry(`${SB}/rest/v1/rpc/delete_site`, { method: "POST", headers: H, body: JSON.stringify({ p_code: code }) });
      if (r.ok) { done++; console.log(`  🗑 ${code} נמחק`); }
      else { failed++; console.log(`  ❌ ${code}: ${r.status} ${(await r.text()).slice(0, 160)}`); }
    }
  } finally { await g.cleanup(); }
  console.log(`\nנמחקו ${done}, נכשלו ${failed}.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("undo-wizenet-sites:", e.message); process.exit(1); });
