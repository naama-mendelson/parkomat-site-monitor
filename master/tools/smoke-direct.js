// tools/smoke-direct.js — האם המסלולים הישירים בכלל **מורשים** לרוץ.
//
//   PARITY_EMAIL=<מייל> PARITY_PASSWORD=<סיסמה> \
//     node --env-file=.env tools/smoke-direct.js
//
// ============================================================
// למה זה נחוץ בנפרד משערי ה-parity
// ============================================================
// כל שערי ה-parity משווים מספרים דרך **db.js**, כלומר כתפקיד `postgres` —
// ול-`postgres` יש `rolbypassrls = true`. הוא עוקף את כל המדיניות בהגדרה.
//
// המשמעות: מדיניות RLS חסרה, GRANT חסר על פונקציה חדשה, או טבלה שנשכחה —
// **כל אלה עוברים את כל השערים בהצלחה מלאה** ונופלים רק בדפדפן, אצל
// המשתמשת. השערים משווים "האם המספרים זהים", לא "האם מותר לקרוא אותם".
//
// כאן נכנסים כמו הדפדפן: התחברות אמיתית מול GoTrue, ואז כל שליפה שהמסלולים
// הישירים עושים — דרך PostgREST, בתפקיד `authenticated`.
//
// ⚠️ נכשל = הדשבורד ייפול אצל המשתמשת גם אם כל 2,279 ההשוואות ירוקות.

const fs = require("node:fs");
const path = require("node:path");

// ============================================================
// ניסיון חוזר על כשל רשת — ולא על כשל הרשאה
// ============================================================
// נתפס בפועל: שלוש ריצות רצופות נפלו על `fetch failed / ECONNRESET`, בזמן
// שאותה התחברות בדיוק החזירה 200 בבדיקה נפרדת. זו אותה משפחה של תקלות
// ש-db.js כבר מתמודד איתה (Supavisor סוגר חיבורים באמצע) — רק שכאן היא
// מגיעה מ-fetch ולא מ-pg.
//
// ⚠️ הניסיון החוזר הוא **רק על כשל רשת**. תשובת 401/403 חוזרת כמות שהיא
// ואינה מנוסה שוב — זו בדיוק התשובה שהשער קיים כדי לראות, וניסיון חוזר
// עליה היה הופך מדיניות שבורה ל"עבר אחרי כמה ניסיונות".
async function tryFetch(url, opts, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const pick = (k) => (ENV.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const SB_URL = pick("VITE_SUPABASE_URL");
const SB_KEY = pick("VITE_SUPABASE_PUBLISHABLE_KEY");

let pass = 0, fail = 0;
const problems = [];

function ok(name, detail = "") {
  pass++;
  console.log(`  ✔ ${name}${detail ? "  " + detail : ""}`);
}
function bad(name, why) {
  fail++;
  problems.push(`${name}: ${why}`);
  console.log(`  ✘ ${name}  ${why}`);
}

(async () => {
  if (!SB_URL || !SB_KEY) {
    console.error("smoke-direct: חסרים מפתחות ב-dashboard/.env");
    process.exit(1);
  }

  const email = process.env.PARITY_EMAIL, password = process.env.PARITY_PASSWORD;
  if (!email || !password) {
    console.error("smoke-direct: נדרשים PARITY_EMAIL ו-PARITY_PASSWORD — בלעדיהם אין מה לבדוק.");
    process.exit(1);
  }

  // ---- התחברות, בדיוק כמו הדפדפן ----
  const authRes = await tryFetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!authRes.ok) {
    console.error(`smoke-direct: התחברות נכשלה — ${authRes.status} ${(await authRes.text()).slice(0, 150)}`);
    process.exit(1);
  }
  const { access_token: TOKEN } = await authRes.json();
  console.log(`מחובר כ-${email}\n`);

  const H = { apikey: SB_KEY, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

  const get = async (q) => {
    const res = await tryFetch(`${SB_URL}/rest/v1/${q}`, { headers: { ...H, Range: "0-999" } });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  };
  const rpc = async (fn, args) => {
    const res = await tryFetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: H, body: JSON.stringify(args),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  };

  const from = new Date(Date.now() - 7 * 864e5).toISOString();
  const to = new Date().toISOString();

  // ============================================================
  // כל שליפה שמסלול ישיר עושה
  // ============================================================
  console.log("=== טבלאות (RLS) ===");
  for (const [name, q] of [
    ["sites", "sites?select=*"],
    ["operations", `operations?select=site_id,occurred_at&occurred_at=gte.${encodeURIComponent(from)}`],
    ["status_history", `status_history?select=site_id,status&started_at=lt.${encodeURIComponent(to)}`],
    ["maintenance_windows", "maintenance_windows?select=site_id,started_at"],
  ]) {
    const r = await get(q);
    if (!r.ok) bad(name, `${r.status} ${r.body?.message || ""}`);
    else ok(name, `${Array.isArray(r.body) ? r.body.length : "?"} שורות`);
  }

  console.log("\n=== יחסים מקוננים (sites(site_name)) ===");
  // ⚠️ קינון דורש שגם הטבלה המקושרת תהיה קריאה. אם ל-sites אין מדיניות,
  // השאילתה **לא נופלת** — היא מחזירה sites: null, ושם האתר נעלם בשקט.
  const nested = await get(`operations?select=site_id,sites(site_name)&limit=1`);
  if (!nested.ok) bad("קינון sites", `${nested.status} ${nested.body?.message || ""}`);
  else if (!nested.body?.[0]?.sites?.site_name) bad("קינון sites", "חזר null — שם האתר ייעלם מהלוג");
  else ok("קינון sites", `"${nested.body[0].sites.site_name}"`);

  console.log("\n=== פונקציות SQL (RPC) ===");
  for (const [fn, args] of [
    ["site_stats", { p_site_ids: null, p_from: from, p_to: to }],
    ["site_uptime", { p_site_ids: null, p_from: from, p_to: to }],
    ["site_globals", { p_site_ids: null }],
    ["site_segments_collapsed", { p_site_ids: null, p_from: from, p_to: to }],
    ["recent_errors", { p_limit: 10 }],
  ]) {
    const r = await rpc(fn, args);
    if (!r.ok) bad(fn, `${r.status} ${r.body?.message || r.body?.hint || ""}`);
    else ok(fn, `${Array.isArray(r.body) ? r.body.length : "?"} שורות`);
  }

  console.log("\n=== מה שחייב להישאר חסום ===");
  // settings מחזיקה את גיבוב קוד המנהל — היא בלי מדיניות בכוונה.
  const settings = await get("settings?select=*");
  if (settings.ok && Array.isArray(settings.body) && settings.body.length) {
    bad("settings", "⚠️ נקראת! היא מחזיקה את גיבוב קוד המנהל");
  } else ok("settings חסומה", `${settings.status}`);

  // כתיבה מהדפדפן חייבת להיחסם — הקליטה עוברת דרך השרת בלבד.
  const write = await tryFetch(`${SB_URL}/rest/v1/operations`, {
    method: "POST", headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ site_id: -1, start_end: "start", entry_exit: "entry",
                           state: "operating", occurred_at: to, received_at: to }),
  });
  if (write.ok) bad("כתיבה ל-operations", "⚠️ הצליחה! הדפדפן יכול לזייף פעולות");
  else ok("כתיבה חסומה", `${write.status}`);

  // ---- ובלי אסימון בכלל ----
  const anon = await tryFetch(`${SB_URL}/rest/v1/operations?select=id&limit=1`, {
    headers: { apikey: SB_KEY },
  });
  if (anon.ok) bad("קריאה אנונימית", "⚠️ הצליחה! הנתונים חשופים לאינטרנט");
  else ok("קריאה אנונימית חסומה", `${anon.status}`);

  console.log(`\n${"=".repeat(60)}`);
  if (fail) {
    console.log(`❌ ${fail} כשלים מתוך ${pass + fail} בדיקות\n`);
    problems.forEach((p) => console.log("   " + p));
    process.exit(1);
  }
  console.log(`✅ כל ${pass} המסלולים הישירים מורשים ועובדים תחת משתמש אמיתי`);
  process.exit(0);
})().catch((e) => { console.error("smoke-direct: נפל —", e.message); process.exit(1); });
