// tools/rename-multiplier-sites.js — פסיק אחרי מספר הבית בשמות אתרי המכפילים, כמו שאר האתרים.
//
//   node --env-file=.env tools/rename-multiplier-sites.js            ← הרצה יבשה
//   node --env-file=.env tools/rename-multiplier-sites.js --apply    ← שינוי השמות
//
// בעלת המוצר (15/10/2026): "תוסיף פסיק אחרי מספר הרחוב כמו האתרים שכבר קיימים באתר". האתרים המנוטרים נקראים
// "מנחם בגין 3, ת\"א"; המכפילים נוצרו מלוח הרמזור בלי הפסיק ("אביגיל 12 ר\"ג"). הכלל: אחרי קבוצת מספר הבית
// הראשונה (12 / 12-10 / 6/8 / 3 א) שאחריה בא עוד טקסט בלי פסיק — ", ". שם שכבר יש בו פסיק אחרי המספר — לא נוגעים.
// ⚠️ רק אתרים ללא בקר (monitored = false): אלה שנוצרו מהלוח. השם בלוח עצמו נשאר כמו שהוא — הכלים שמתאימים
// שורה בלוח לאתר (create-multiplier-sites, link-multiplier-codes) משווים שמות בלי פיסוק.
// דרך update_site ב-PostgREST כמנהל זמני (tools/lib/gate-user), כמו ניהול אתרים.
const fs = require("node:fs");
const path = require("node:path");
const pg = require("pg");
const { gateToken } = require("./lib/gate-user");

const MASTER = path.join(__dirname, "..");
const APPLY = process.argv.includes("--apply");

/** "אביגיל 12 ר"ג" → "אביגיל 12, ר"ג"; "סמטת לאן 3 א ת''א" → "סמטת לאן 3 א, ת''א"; "רזיאל 2, יפו" → כמו שהוא */
function withComma(name) {
  const s = String(name ?? "").replace(/\s+/g, " ").trim();
  // קבוצת מספר: 12 · 12-10 · 6/8 · 15/הגליל 16 (לאט: הקבוצה הראשונה שאחריה רווח ולא פסיק)
  const m = /^(.*?\d+(?:[\/-]\d+)?(?: [א-ת])?)(?= [^,\d])\s+(.+)$/.exec(s);
  if (!m) return s;
  // "מכבי 15/הגליל 16 רעננה" — המספר הראשון מסתיים ב-"/הגליל": הביטוי הלא-חמדני יתקדם לקבוצה הבאה בעצמו
  return `${m[1]}, ${m[2]}`;
}
module.exports = { withComma };

if (require.main === module) (async () => {
  const SB = process.env.SUPABASE_URL, SECRET = process.env.SUPABASE_SECRET_KEY;
  const ANON = (fs.readFileSync(path.join(MASTER, "..", "dashboard", ".env"), "utf8").match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();
  if (!process.env.DATABASE_URL || !SB || !SECRET || !ANON) { console.error("חסרים פרטי חיבור"); process.exit(1); }

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  let sites;
  try {
    await db.query("BEGIN READ ONLY");
    sites = (await db.query(`SELECT code, btrim(site_name) AS name FROM sites WHERE monitored = false ORDER BY code`)).rows;
    await db.query("ROLLBACK");
  } finally { await db.end(); }
  const plan = sites.map((s) => ({ ...s, next: withComma(s.name) })).filter((s) => s.next !== s.name);
  console.log(`=== אתרים ללא בקר: ${sites.length} — לשנות: ${plan.length} ===`);
  for (const p of plan) console.log(`  ${p.code.padEnd(7)} ${p.name}  →  ${p.next}`);
  const same = sites.length - plan.length;
  if (same) console.log(`  (${same} כבר עם פסיק, או בלי מספר בית)`);
  if (!plan.length) return;
  if (!APPLY) { console.log("\nהרצה יבשה. לשינוי:  node --env-file=.env tools/rename-multiplier-sites.js --apply"); return; }

  const retry = async (url, opt) => { let last; for (let i = 0; i < 5; i++) { try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); } } throw last; };
  const g = await gateToken(SB, ANON, SECRET, retry);
  let ok = 0, failed = 0;
  try {
    const H = { apikey: ANON, Authorization: `Bearer ${g.token}`, "Content-Type": "application/json" };
    for (const p of plan) {
      const r = await retry(`${SB}/rest/v1/rpc/update_site`, { method: "POST", headers: H, body: JSON.stringify({ p_code: p.code, p_site_name: p.next }) });
      if (r.ok) { ok++; } else { failed++; console.log(`  ❌ ${p.code}: ${r.status} ${(await r.text()).slice(0, 140)}`); }
    }
  } finally { await g.cleanup(); }
  console.log(`\nשונו ${ok}, נכשלו ${failed}.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("rename-multiplier-sites:", e.message); process.exit(1); });
