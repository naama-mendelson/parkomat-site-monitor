// check-security.js — האם המערכת חשופה. מדידה, לא הערכה.
//
// ============================================================
// ⚠️ למה שער ולא סקירה חד-פעמית
// ============================================================
// כל ממצא כאן נבדק פעם אחת ידנית ונמצא תקין. הבעיה עם זה היא שהתשובה
// נכונה ליום שבו נבדקה: מדיניות RLS שמישהו יוסיף, GRANT ל-anon,
// SECURITY DEFINER בלי search_path, או קוד מנהל שיחזור לברירת המחדל —
// כולם ישברו את התמונה בלי שאיש ישים לב.
//
// ⚠️ **ובעיקר: כל הבדיקות כאן הן על הייצור החי, ואף אחת אינה כותבת.**
const fs = require("fs");
const path = require("path");
const db = require("../db/db");

const SB = process.env.SUPABASE_URL;
const ANON = (fs.readFileSync(path.join(__dirname, "..", "..", "dashboard", ".env"), "utf8")
  .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

async function f(url, opt) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 500)); }
  }
  throw last;
}

const TABLES = ["sites", "status_history", "operations", "maintenance_windows", "settings",
                "app_users", "audit_log", "events", "ingest_drops", "push_subscriptions",
                "monthly_summary", "suppressed_faults"];

const RPCS = ["delete_site", "register_site", "update_site", "set_user_role", "set_user_active",
              "list_users", "reclassify_status", "mark_as_test", "start_maintenance",
              "cancel_maintenance", "my_role"];

(async () => {
  const H = { apikey: ANON, Authorization: `Bearer ${ANON}` };

  // ---- 1. קריאה אנונימית ----
  let leaked = [];
  for (const t of TABLES) {
    const r = await f(`${SB}/rest/v1/${t}?select=*&limit=1`, { headers: H });
    const body = await r.text();
    if (r.ok && body !== "[]" && body.length > 2) leaked.push(t);
  }
  check(`קריאה אנונימית מ-${TABLES.length} טבלאות`, leaked.length === 0,
    leaked.length ? `דלפו: ${leaked.join(", ")}` : "כולן חסומות");

  // ---- 2. כתיבה אנונימית ----
  let wrote = [];
  for (const t of ["sites", "status_history", "app_users"]) {
    const r = await f(`${SB}/rest/v1/${t}`, {
      method: "POST", headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "__sec__" }),
    });
    if (r.status < 400) wrote.push(t);
  }
  check("כתיבה אנונימית", wrote.length === 0, wrote.length ? `עברה: ${wrote.join(", ")}` : "חסומה");

  // ---- 3. RPC ללא הזדהות ----
  let openRpc = [];
  for (const fn of RPCS) {
    const r = await f(`${SB}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: "{}",
    });
    if (r.status < 400) openRpc.push(fn);
  }
  check(`${RPCS.length} פונקציות RPC רגישות`, openRpc.length === 0,
    openRpc.length ? `פתוחות: ${openRpc.join(", ")}` : "כולן חסומות");

  // ---- 4. הרשמה עצמית ----
  const su = await f(`${SB}/auth/v1/signup`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: `sec${Date.now()}@parkomat.co.il`, password: "Xq7#mR2$vL9!" }),
  });
  const suBody = await su.text();
  check("הרשמה עצמית ללא הזמנה", su.status >= 400 || /error|Unexpected/i.test(suBody),
    `HTTP ${su.status}`);

  // ---- 5. הרשאות ב-SQL ----
  await db.init();

  const defs = await db.prepare(`
    SELECT n.nspname || '.' || p.proname AS fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname IN ('public','app')
       AND (p.proconfig IS NULL OR NOT (array_to_string(p.proconfig, ',') LIKE '%search_path%'))
  `).all();
  check("SECURITY DEFINER עם search_path נעוץ", defs.length === 0,
    defs.length ? `חשופות: ${defs.map((d) => d.fn).join(", ")}` : "כולן נעוצות");

  const grants = await db.prepare(`
    SELECT p.proname AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE')
       AND p.proname = ANY($1)
  `).all(RPCS);
  check("EXECUTE ל-anon על פונקציות רגישות", grants.length === 0,
    grants.length ? `הוענק: ${grants.map((g) => g.fn).join(", ")}` : "לא הוענק לאף אחת");

  const noRls = await db.prepare(`
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  `).all();
  check("RLS מופעל על כל טבלה", noRls.length === 0,
    noRls.length ? `בלי RLS: ${noRls.map((x) => x.t).join(", ")}` : "כולן מוגנות");

  // ---- 6. קוד המנהל ----
  const crypto = require("crypto");
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'admin_code_hash'").get();
  const def = crypto.createHash("sha256").update("admin123").digest("hex");
  check("קוד המנהל אינו ברירת המחדל הפומבית", Boolean(row) && row.value !== def,
    row ? (row.value === def ? "עדיין admin123 — מפורסם במאגר" : "הוחלף") : "לא מוגדר");

  // ---- 7. משתמשים יתומים ----
  const orphans = await db.prepare(`
    SELECT u.email FROM app_users u
     WHERE u.is_active AND u.supabase_uid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.supabase_uid)
  `).all();
  check("אין משתמשים פעילים בלי חשבון", orphans.length === 0,
    orphans.length ? orphans.map((o) => o.email).join(", ") : "נקי");

  // ---- 8. תשתית ה-2FA ----
  const mfa = await db.prepare(`
    SELECT COUNT(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app' AND p.proname IN ('current_aal','came_from_token','mfa_required','require_mfa')
  `).get();
  check("תשתית האימות הדו-שלבי קיימת", mfa.n === 4, `${mfa.n}/4 פונקציות`);

  const enrolled = await db.prepare(`
    SELECT COUNT(DISTINCT u.id)::int AS have,
           (SELECT COUNT(*)::int FROM app_users WHERE is_active) AS total
      FROM app_users u JOIN auth.mfa_factors f ON f.user_id = u.supabase_uid AND f.status = 'verified'
     WHERE u.is_active
  `).get();
  const flag = await db.prepare("SELECT value FROM settings WHERE key = 'mfa_required_for_manager'").get();
  const on = String(flag?.value).toLowerCase() === "true";
  // ⚠️ אינו נכשל: 2FA שלא נרשמו אליו אינו חשיפה חדשה, הוא הגנה שטרם הופעלה.
  console.log(`\nרישום ל-2FA: ${enrolled.have}/${enrolled.total} · אכיפה: ${on ? "דלוקה" : "כבויה"}`);
  // ⚠️ אבל **זה** כן נכשל: אכיפה דלוקה כשמישהו אינו רשום = אנשים נעולים בחוץ.
  check("אין מצב של אכיפה דלוקה עם משתמשים לא רשומים", !(on && enrolled.have < enrolled.total),
    on && enrolled.have < enrolled.total ? `${enrolled.total - enrolled.have} נעולים` : "תקין");

  // ---- סיכום ----
  console.log("\n" + "=".repeat(66));
  let bad = 0;
  for (const r of results) {
    if (!r.ok) bad++;
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.name.padEnd(42)} ${r.detail}`);
  }
  console.log("=".repeat(66));
  console.log(bad ? `❌ ${bad} כשלים` : `✅ ${results.length}/${results.length} — אין חשיפה`);
  process.exit(bad ? 1 : 0);
})();
