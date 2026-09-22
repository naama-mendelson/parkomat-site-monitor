// tools/check-row-cap.js — אף קריאה ישירה אינה מתקרבת לתקרת 1,000 השורות.
//
// ============================================================
// ⚠️ למה שער, ולמה דווקא עכשיו
// ============================================================
// PostgREST חוסם כל תשובה ב-1,000 שורות. זה **לא ניתן לעקיפה מהלקוח**:
// `limit` מתעלמים ממנו, ו-`Range` מזיז את החלון בלי להגדיל אותו. התשובה
// חוזרת בסטטוס 200, בלי אזהרה ובלי 206.
//
// ⚠️ הקאפ היה מוכר — services/pageAll.js קיים בדיוק בשבילו, ושלושה
// שירותים מדפדפים דרכו. אבל **איש לא חשב עליו עבור RPC**, ושם הוא הכה:
// `executive_series` החזירה שורה לכל (דלי × אתר), ו"השנה הנוכחית"
// ברזולוציה יומית — ברירת המחדל של המסך — הציגה 1,000 מתוך 3,920.
//
// ⚠️ ואף שער לא יכול היה לתפוס: parity-exec-series קורא דרך ה-pool, כלומר
// הוא מוכיח ש-SQL ו-JS מסכימים ואינו חוצה את PostgREST כלל. הקטימה קורית
// בשכבה שביניהם.
//
// לכן שני חצאים כאן, ושניהם נחוצים:
//   1. **סטטי** — כל שם RPC שהדשבורד קורא לו חייב להיות מוכרז. שם חדש
//      מפיל את השער, כלומר מכריח החלטה במקום שכחה.
//   2. **חי** — כל RPC שמחזיר שורות נקרא בפועל מול הייצור, בפרמטרים
//      הרחבים ביותר שהמסך מאפשר, ונספר.
//
// ⚠️ הסף הוא 900 ולא 1,000. שער שנדלק רק בקטימה נדלק **אחרי** שהנתונים
// כבר נעלמו מהמסך; ההתראה חייבת להקדים את הנזק, לא לתעד אותו.
const fs = require("node:fs");
const path = require("node:path");

const SERVICES = path.join(__dirname, "..", "..", "dashboard", "src", "services");
const LIMIT = 1000;
const WARN = 900;

// ============================================================
// RPC-ים שאינם יכולים לחרוג — עם הסיבה, לא רק השם
// ============================================================
// ⚠️ "מחזיר מעט" אינו סיבה. הסיבה חייבת להיות **מבנית**: מה חוסם את
// מספר השורות. בלעדיה אף אחד לא יידע מתי ההנחה חדלה להיות נכונה.
const BOUNDED = {
  verify_admin_code: "בוליאני יחיד",
  set_admin_code: "כתיבה",
  pending_announcement: "הודעה אחת",
  mark_announcement_seen: "כתיבה",
  publish_announcement: "כתיבה",
  my_role: "ערך יחיד",
  my_app_user_id: "ערך יחיד",
  schedule_maintenance: "כתיבה",
  start_maintenance: "כתיבה",
  cancel_maintenance: "כתיבה",
  submit_field_report: "כתיבה",
  reply_to_field_report: "כתיבה",
  delete_field_report: "כתיבה",
  resolve_field_report: "כתיבה",
  server_heartbeat: "ערך יחיד",
  broadcast_reload: "כתיבה",
  mark_as_test: "כתיבה",
  unmark_test: "כתיבה",
  reclassify_status: "כתיבה",
  request_service_restart: "כתיבה",
  service_health: "שורה אחת",
  request_service_ping: "כתיבה",
  register_site: "כתיבה",
  update_site: "כתיבה",
  delete_site: "כתיבה",
  // כתיבה שמחזירה שורה אחת — האתר שסומן. RETURNS TABLE עם SELECT יחיד.
  mark_controller_replaced: "כתיבה",
  set_user_active: "כתיבה",
  set_user_role: "כתיבה",
  delete_user: "כתיבה",
  // חסומים בפרמטר מפורש שנשלח מהדשבורד.
  site_status_history: "p_limit=10",
  recent_errors: "p_limit=10",
  // חסום במספר המשתמשים, לא במספר השורות שנקראו.
  list_users: "שורה למשתמש — עשרות, לא אלפים",
};

// ============================================================
// RPC-ים שנמדדים בפועל — ולא נסמכים על הנחה
// ============================================================
// הפרמטרים הם הרחבים ביותר שהמסך מאפשר. בדיקה על טווח צר עוברת תמיד
// ואינה אומרת דבר: התקרה נפגעת רק בקצה.
const MEASURED = [
  { fn: "site_stats", why: "שורה לאתר", args: (c) => ({ p_site_ids: null, p_from: c.yearAgo, p_to: c.now }) },
  { fn: "site_uptime", why: "שורה לאתר", args: (c) => ({ p_site_ids: null, p_from: c.yearAgo, p_to: c.now }) },
  { fn: "site_globals", why: "שורה לאתר", args: () => ({ p_site_ids: null }) },
  { fn: "report_monthly", why: "שורה לחודש", args: (c) => ({ p_site_ids: null, p_from: c.twoYearsAgo, p_to: c.now }) },
  { fn: "report_by_site", why: "שורה לאתר", args: (c) => ({ p_site_ids: null, p_from: c.twoYearsAgo, p_to: c.now }) },
  { fn: "report_site_months", why: "שורה לאתר×חודש", args: (c) => ({ p_site_ids: null, p_from: c.twoYearsAgo, p_to: c.now }) },
];

// ============================================================
// טבלאות שנקראות ישירות — ומה חוסם כל אחת
// ============================================================
// ⚠️ הרשימה הזו נבנתה אחרי שהשער תפס שש טבלאות שסריקה ידנית החמיצה:
// חלק מהקריאות כתובות `supabase\n  .from(...)`, ו-grep על `supabase.from`
// אינו רואה אותן. זו בדיוק הסיבה שהחצי הסטטי כאן סובלני לרווחים.
const TABLES = {
  sites: "שורה לאתר",
  operations: "limit או pageAll בכל הקוראים",
  maintenance_windows: "limit או pageAll בכל הקוראים",
  status_history: "pageAll",
  suppressed_faults: "pageAll",
  push_subscriptions: "כתיבה או מחיקה",
  push_user_sites: "שורה לאתר למשתמש",
  // ⚠️ סיבה **מבנית**, לא "מחזיר מעט": ה-RLS מסננת ל-`app_user_id` של
  // הקורא, ו-`kind` מוגבל לשלושת הערכים ב-`KINDS`. כלומר התקרה היא שלוש
  // שורות למשתמש מעצם המבנה — לא מפני שהטבלה קטנה היום.
  push_user_types: "שורה לסוג למשתמש — שלושה סוגים בסך הכול",
  announcements: "limit מפורש",
  field_reports: "limit מפורש",
  service_commands: "limit מפורש",
  // ⚠️ שתי אלה חסומות ב**שימוש** ולא במבנה, וזה הבדל שכדאי לשמור עליו
  // גלוי. אין להן limit; מה שמחזיק אותן קטנות הוא שאיש אינו כותב אלף
  // תשובות לדיווח אחד. אם דיווחי השטח יהפכו לערוץ פעיל — כאן יסתכלו.
  field_report_replies: "⚠️ תשובות לדיווח **אחד** — שיחה, לא היסטוריה. אין limit.",
  field_report_files: "⚠️ קבצים של דיווחים שכבר הוגבלו ב-limit. אין limit משלו.",
};

function scan() {
  const rpcs = new Set();
  const tables = new Set();
  for (const f of fs.readdirSync(SERVICES).filter((x) => x.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(SERVICES, f), "utf8");
    for (const m of src.matchAll(/supabase\s*\.\s*rpc\(\s*["'](\w+)["']/g)) rpcs.add(m[1]);
    for (const m of src.matchAll(/supabase\s*\.\s*from\(\s*["'](\w+)["']/g)) tables.add(m[1]);
  }
  return { rpcs, tables };
}

(async () => {
  console.log("=== check-row-cap ===\n");
  let fails = 0;

  // ---------- חצי ראשון: סטטי ----------
  const { rpcs, tables } = scan();
  const known = new Set([...Object.keys(BOUNDED), ...MEASURED.map((m) => m.fn), "executive_series_json"]);
  const undeclared = [...rpcs].filter((r) => !known.has(r)).sort();
  const undeclaredT = [...tables].filter((t) => !TABLES[t]).sort();

  console.log(`נסרקו ${rpcs.size} קריאות RPC ו-${tables.size} טבלאות ב-services/`);
  if (undeclared.length) {
    fails++;
    console.log(`❌ ${undeclared.length} RPC לא מוכרזים: ${undeclared.join(", ")}`);
    console.log("   הוסיפו ל-BOUNDED (עם סיבה מבנית) או ל-MEASURED (וייקרא בפועל).");
  } else {
    console.log("✅ כל ה-RPC מוכרזים");
  }
  if (undeclaredT.length) {
    fails++;
    console.log(`❌ ${undeclaredT.length} טבלאות לא מוכרזות: ${undeclaredT.join(", ")}`);
  } else {
    console.log("✅ כל הטבלאות מוכרזות");
  }

  // ⚠️ והכיוון ההפוך: הכרזה שאיש כבר אינו קורא לה היא רעש שנראה ככיסוי.
  const stale = [...known].filter((k) => !rpcs.has(k)).sort();
  if (stale.length) console.log(`⚠️  מוכרזים שאינם בשימוש (אפשר להסיר): ${stale.join(", ")}`);

  // ---------- חצי שני: חי, דרך PostgREST ----------
  console.log("\n── נמדד בפועל מול PostgREST ──");
  const { gateToken } = require("./lib/gate-user");
  const SB = process.env.SUPABASE_URL;
  const SECRET = process.env.SUPABASE_SECRET_KEY;
  const ANON = (fs.readFileSync(path.join(__dirname, "..", "..", "dashboard", ".env"), "utf8")
    .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();
  if (!SB || !SECRET || !ANON) {
    console.log("⚠️  אין פרטי חיבור — החצי החי לא רץ, ולכן זו אינה תשובה.");
    process.exit(2);
  }

  const retry = async (url, opt) => {
    let last;
    for (let i = 0; i < 5; i++) {
      try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); }
    }
    throw last;
  };

  const g = await gateToken(SB, ANON, SECRET, retry);
  try {
    const H = { apikey: ANON, Authorization: `Bearer ${g.token}`, "Content-Type": "application/json" };
    const now = new Date().toISOString();
    const ctx = {
      now,
      yearAgo: new Date(Date.now() - 365 * 86400000).toISOString(),
      twoYearsAgo: new Date(Date.now() - 730 * 86400000).toISOString(),
    };

    for (const m of MEASURED) {
      const r = await retry(`${SB}/rest/v1/rpc/${m.fn}`, {
        method: "POST", headers: H, body: JSON.stringify(m.args(ctx)),
      });
      const body = await r.json();
      const n = Array.isArray(body) ? body.length : null;
      if (n === null) {
        fails++;
        console.log(`  ❌ ${m.fn.padEnd(20)} לא החזיר מערך (status ${r.status})`);
        continue;
      }
      // ⚠️ בדיוק 1,000 הוא **חתימת הקאפ**, ולא מספר שיוצא מנתונים אמיתיים.
      const capped = n >= LIMIT;
      const near = n >= WARN;
      if (capped || near) fails++;
      const mark = capped ? "❌" : near ? "⚠️ " : "✅";
      const tail = capped ? "  — נחתך!" : near ? "  — מתקרב לתקרה" : "";
      console.log(`  ${mark} ${m.fn.padEnd(20)} ${String(n).padStart(5)} שורות · ${m.why}${tail}`);
    }

    // ⚠️ הפונקציה שמנהל כללי באמת קורא לה, בטווח הרחב ביותר שהבורר מאפשר.
    // היא מחזירה **שורה אחת** (jsonb) בכוונה, ולכן נספרים האיברים שבתוכה.
    const { getBucketRanges } = await import("../../shared/executive.mjs");
    const bs = getBucketRanges({ from: ctx.yearAgo, to: now, granularity: "day" });
    const withTotal = [...bs.map((b) => ({ from: b.from, to: b.to })), { from: ctx.yearAgo, to: now }];
    const r = await retry(`${SB}/rest/v1/rpc/executive_series_json`, {
      method: "POST", headers: H,
      body: JSON.stringify({ p_site_ids: null, p_from: ctx.yearAgo, p_to: now, p_buckets: withTotal }),
    });
    const arr = await r.json();
    const n = Array.isArray(arr) ? arr.length : -1;
    const ok = n > 0 && n !== LIMIT;
    if (!ok) fails++;
    const tail = n === LIMIT ? "  — בדיוק 1,000, חתימת הקאפ!" : "";
    console.log(`  ${ok ? "✅" : "❌"} ${"executive_series_json".padEnd(20)} ${String(n).padStart(5)} איברים · ${withTotal.length} דליים${tail}`);
  } finally {
    await g.cleanup();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(fails === 0 ? "✅ אף קריאה אינה מתקרבת לתקרה" : `❌ ${fails} ממצאים`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
