// tools/create-multiplier-sites.js — יוצר אתר "ללא בקר מחובר" לכל שורה בלוח "מכפילים" שברמזור.
//
//   node --env-file=.env tools/create-multiplier-sites.js            ← הרצה יבשה: מה ייווצר, מה ידולג
//   node --env-file=.env tools/create-multiplier-sites.js --apply    ← יצירה בפועל
//
// ============================================================
// ⚠️ למה
// ============================================================
// בעלת המוצר (15/10/2026): "אני רוצה שהאתרים שנמצאים במכפילים שברמזור — ליצור אותם ולערוך ידנית את הקוד
// שלהם… אני אסווג להם סוג ואכניס קוד למה שצריך". המיון: "הם תמיד יהיו בסוף המסך אלא אם כן יש קריאה, ואז
// הם נמצאים במיון אחרי התקלה" (utils/sortSites.js).
//
// הלוח "מכפילים" (traffic_light_rows WHERE board = 'multipliers', 130 שורות) מחזיק שם אתר, סוג הסכם, סוג
// מתקן, שלט… — **ואין בו עמודת "קוד אתר"** (בניגוד ללוח הרובוטי). לכן:
//   - הקוד נוצר זמני, `MX-001`…`MX-130` לפי סדר הלוח, והיא מחליפה אותו לקוד הפרויקט האמיתי בניהול אתרים
//     (שורת העריכה, שדה "קוד" — מנהל בלבד; update_site עם p_new_code). קוד אמיתי הוא מה שמחבר את הקריאות
//     מוויזנט לאתר. ⚠️ MX- ולא ספרות, כדי שקוד זמני לא ייראה כקוד פרויקט ולא יתנגש בקוד אמיתי.
//   - השם — תא "אתר" בלוח, כמו שהוא.
//   - סוג המתקן — ריק. אין "מכפיל" ברשימת הסוגים (shared/site-types.mjs), והיא אמרה שתסווג בעצמה.
//   - monitored = false: כרטיס בלי בקר (בודק, תחזוקה, משימות, קריאות), בלי זהות סוכן.
//   - tier — 'basic' לכולם. sites.tier מקבל רק vip/extended/basic, ובכל מקרה התג בכרטיס בא מהלוח הרובוטי
//     (site_service_links קורא רק board='robotic'), ולכן המכפילים יראו "לא חובר" עד שיוחלט איך לקשר אותם.
//
// ⚠️ אידמפוטנטי: שורה ששמה כבר קיים כשם אתר — דילוג (גם אחרי שהקוד הזמני הוחלף, השם נשאר); קוד MX שכבר
// תפוס — דילוג. כך הרצה חוזרת אחרי כשל באמצע משלימה רק את החסר ולא מכפילה.
// דרך register_site ב-PostgREST כמנהל זמני (tools/lib/gate-user), כמו הרישום מהדשבורד: אותה ולידציה,
// אותו audit_log, אותו אירוע. ⚠️ ב-audit_log השורות ייראו בשם המשתמש הזמני.
const fs = require("node:fs");
const path = require("node:path");
const pg = require("pg");
const { gateToken } = require("./lib/gate-user");

const MASTER = path.join(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const NAME_LABEL = "אתר";
/** שם להשוואה: בלי פיסוק ורווחים כפולים — "אביגיל 12, ר"ג" ו-"אביגיל 12 ר"ג" הם אותו אתר */
const nameKeyOf = (n) => String(n ?? "").replace(/[^0-9א-תA-Za-z]+/g, " ").replace(/s+/g, " ").trim();

(async () => {
  const SB = process.env.SUPABASE_URL;
  const SECRET = process.env.SUPABASE_SECRET_KEY;
  const ANON = (fs.readFileSync(path.join(MASTER, "..", "dashboard", ".env"), "utf8")
    .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();
  if (!process.env.DATABASE_URL || !SB || !SECRET || !ANON) {
    console.error("חסרים DATABASE_URL / SUPABASE_URL / SUPABASE_SECRET_KEY / VITE_SUPABASE_PUBLISHABLE_KEY");
    process.exit(1);
  }

  // ---- הלוח והאתרים הקיימים: קריאה בלבד ----
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  let rows, existingNames, existingCodes;
  try {
    await db.query("BEGIN READ ONLY");
    const key = (await db.query(
      `SELECT key FROM traffic_light_columns WHERE board = 'multipliers' AND label = $1 ORDER BY position, id LIMIT 1`,
      [NAME_LABEL])).rows[0]?.key;
    if (!key) throw new Error(`בלוח "מכפילים" אין עמודה "${NAME_LABEL}"`);
    rows = (await db.query(
      `SELECT id, position, btrim(cells ->> $1) AS name FROM traffic_light_rows WHERE board = 'multipliers' ORDER BY position, id`,
      [key])).rows;
    const s = (await db.query(`SELECT code, btrim(site_name) AS name FROM sites`)).rows;
    // ⚠️ בלי פיסוק: לאתרים נוסף פסיק אחרי מספר הבית (rename-multiplier-sites, 15/10/2026), והלוח נשאר בלעדיו
    existingNames = new Set(s.map((x) => nameKeyOf(x.name)));
    existingCodes = new Set(s.map((x) => x.code));
    await db.query("ROLLBACK");
  } finally { await db.end(); }

  const plan = rows.map((r, i) => {
    const code = `MX-${String(i + 1).padStart(3, "0")}`;
    const skip = !r.name ? "שם ריק" : existingNames.has(nameKeyOf(r.name)) ? "השם כבר קיים כאתר" : existingCodes.has(code) ? `הקוד ${code} תפוס` : null;
    return { code, name: r.name, skip };
  });
  const todo = plan.filter((p) => !p.skip);
  console.log(`=== לוח "מכפילים": ${rows.length} שורות — ליצור ${todo.length}, לדלג ${plan.length - todo.length} ===`);
  for (const p of plan) console.log(`  ${p.skip ? "↷" : "+"} ${p.code}  ${p.name}${p.skip ? "  (" + p.skip + ")" : ""}`);
  if (!todo.length) return;
  if (!APPLY) { console.log("\nהרצה יבשה. ליצירה:  node --env-file=.env tools/create-multiplier-sites.js --apply"); return; }

  // ---- יצירה, דרך PostgREST כמנהל זמני ----
  const retry = async (url, opt) => {
    let last;
    for (let i = 0; i < 5; i++) {
      try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); }
    }
    throw last;
  };
  const g = await gateToken(SB, ANON, SECRET, retry);
  let done = 0, skipped = 0, failed = 0;
  try {
    const H = { apikey: ANON, Authorization: `Bearer ${g.token}`, "Content-Type": "application/json" };
    for (const { code, name } of todo) {
      const r = await retry(`${SB}/rest/v1/rpc/register_site`, {
        method: "POST", headers: H,
        body: JSON.stringify({ p_code: code, p_site_name: name, p_monitored: false }),
      });
      if (r.ok) { done++; console.log(`  ✅ ${code}  ${name}`); }
      else if (r.status === 409) { skipped++; console.log(`  ↷ ${code} כבר קיים — דילוג`); }
      else { failed++; console.log(`  ❌ ${code} ${name}: ${r.status} ${(await r.text()).slice(0, 160)}`); }
    }
  } finally { await g.cleanup(); }
  console.log(`\nנוצרו ${done}, דולגו ${skipped}, נכשלו ${failed}. הקוד הזמני (MX-…) מוחלף בניהול אתרים → עריכה → "קוד".`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("create-multiplier-sites:", e.message); process.exit(1); });
