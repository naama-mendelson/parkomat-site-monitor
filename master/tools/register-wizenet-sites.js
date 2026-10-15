// tools/register-wizenet-sites.js — רושם כאתרים "ללא בקר מחובר" את קודי הפרויקט שמגיעים מוויזנט ואין להם אתר.
//
//   node --env-file=.env tools/register-wizenet-sites.js            ← הרצה יבשה: אילו קודים, כמה קריאות לכל אחד
//   node --env-file=.env tools/register-wizenet-sites.js --apply    ← רישום בפועל
//
// ============================================================
// ⚠️ למה
// ============================================================
// קריאה מוויזנט משויכת לאתר לפי קוד הפרויקט מול sites.code, **בזמן הקריאה** (app.service_calls_current),
// ולא בזמן הקליטה. קוד שאין לו אתר — הקריאה נקלטת ונשמרת, אבל לא נראית בשום מקום על הלוח: לא על
// כרטיס, לא בספירה, לא במיון. נמדד 15/10/2026: 25 קודים כאלה, 79 מתוך 184 הקריאות הנוכחיות.
//
// בעלת המוצר (15/10/2026): "תציג אותם, אני אסווג להם סוג ואכניס קוד למה שצריך" — ועל המיון: "הם תמיד
// יהיו בסוף המסך אלא אם כן יש קריאה, ואז הם נמצאים במיון אחרי התקלה" (utils/sortSites.js).
//
// לכן: register_site עם p_monitored=false — כרטיס בלי בקר (בודק, תחזוקה, משימות, קריאות), בשם זמני
// "אתר <קוד>", שהיא משלימה בניהול אתרים. ⚠️ ויזנט לא שולחים שם פרויקט — אין מאיפה לקחת שם אמיתי.
//
// ⚠️ דרך register_site ב-PostgREST, לא INSERT ישיר: אותה ולידציה של קוד, אותו audit_log ואותו אירוע כמו
// רישום מהדשבורד. הזהות היא משתמש-מנהל זמני (tools/lib/gate-user, כמו check-writes), שנמחק בסוף —
// ב-audit_log השורות ייראו בשם שלו. ⚠️ אתר "ללא בקר" לא מקבל זהות סוכן (כמו בדשבורד), ולכן אין
// provision-agent כאן.
//
// ⚠️ רק קודים בני ארבע ספרות (^[1-9][0-9]{3}$): '0' ו-NULL מגיעים מהודעות בדיקה ומקריאות בלי קוד.
// קוד שכבר קיים חוזר 409 — דילוג, לא כשל — ולכן אפשר להריץ שוב אחרי כשל באמצע.
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

  // ---- מה חסר: קריאה בלבד (BEGIN READ ONLY — ה-pooler משתף סשנים, ו-SET היה דולף) ----
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  let codes;
  try {
    await db.query("BEGIN READ ONLY");
    const { rows } = await db.query(`
      SELECT c.project AS code, count(*)::int AS calls, count(*) FILTER (WHERE c.open)::int AS open
        FROM app.service_calls_current() c
       WHERE c.site_id IS NULL AND c.project ~ '^[1-9][0-9]{3}$'
       GROUP BY 1 ORDER BY 1`);
    codes = rows;
    await db.query("ROLLBACK");
  } finally { await db.end(); }

  console.log(`=== קודי פרויקט מוויזנט בלי אתר: ${codes.length} ===`);
  for (const r of codes) console.log(`  ${r.code}  ${String(r.calls).padStart(3)} קריאות, ${r.open} פתוחות`);
  if (!codes.length) return;
  if (!APPLY) { console.log("\nהרצה יבשה. לרישום:  node --env-file=.env tools/register-wizenet-sites.js --apply"); return; }

  // ---- רישום, דרך PostgREST כמנהל זמני ----
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
    for (const { code } of codes) {
      const r = await retry(`${SB}/rest/v1/rpc/register_site`, {
        method: "POST", headers: H,
        body: JSON.stringify({ p_code: code, p_site_name: `אתר ${code}`, p_monitored: false }),
      });
      if (r.ok) { done++; console.log(`  ✅ ${code} נרשם`); }
      else if (r.status === 409) { skipped++; console.log(`  ↷ ${code} כבר קיים — דילוג`); }
      else { failed++; console.log(`  ❌ ${code}: ${r.status} ${(await r.text()).slice(0, 160)}`); }
    }
  } finally { await g.cleanup(); }
  console.log(`\nנרשמו ${done}, דולגו ${skipped}, נכשלו ${failed}. הקריאות שלהם יופיעו על הכרטיסים בטעינה הבאה של הלוח.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("register-wizenet-sites:", e.message); process.exit(1); });
