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

  // ---- בודק מוסמך ותחזוקה מונעת (complianceDirect.js) ----
  // ⚠️ כל הקוראים כאן מחזירים **jsonb יחיד** או שורות שחסומות ב-LIMIT בתוך
  // ה-RPC עצמו — הטבלאות סגורות (D2), ואין דרך לקרוא אותן בלי לעבור כאן.
  inspection_site: "jsonb יחיד",
  pm_site: "jsonb יחיד",
  pm_visit_detail: "jsonb יחיד",
  pm_template: "jsonb יחיד (עד 100 פריטים — תקרה ב-pm_template_save)",
  pm_profiles_list: "jsonb יחיד — כל הפרופילים עם האתרים שלהם, והאתרים בלי פרופיל",
  // ⚠️ ארבע אלה (רשימות לפי סוג, 07/10/2026) לא הוכרזו עד 15/10 — השער לא רץ מאז
  pm_templates_list: "jsonb יחיד — כל רשימות התחזוקה",
  pm_template_create: "כתיבה",
  pm_template_rename: "כתיבה",
  pm_site_templates_set: "כתיבה",
  pm_template_meta_set: "כתיבה — סיווג רשימה לפי סוג (15/10/2026)",
  pm_profile_save: "כתיבה",
  pm_profile_delete: "כתיבה",
  pm_profile_sites_set: "כתיבה",
  pm_site_profile_set: "כתיבה",
  compliance_history_list: "jsonb יחיד, ≤200 (LEAST ב-RPC)",
  compliance_file: "שורה אחת לפי id",
  compliance_thumbs: "≤3 לסגירה נוכחית / ≤9 היסטוריה / ≤40 לביקור — LIMIT ב-RPC, ותקרה של 12 לליקוי ו-40 לביקור ב-RPC הכתיבה",
  compliance_storage: "שורה אחת",
  compliance_orphans: "שורה לקוד אתר שנמחק",
  inspection_upload: "כתיבה",
  inspection_report_update: "כתיבה",
  inspection_report_delete: "כתיבה",
  inspection_machine_retire: "כתיבה",
  inspection_close_by_report: "כתיבה",

  // ---- הרמזור (לוח השירות) — לא הוכרז עד 15/10/2026 ----
  tl_board: "jsonb יחיד — הלוח כולו",
  tl_add_column: "כתיבה",
  tl_update_column: "כתיבה",
  tl_delete_column: "כתיבה",
  tl_move_column: "כתיבה",
  tl_add_row: "כתיבה",
  tl_delete_row: "כתיבה",
  tl_move_row: "כתיבה",
  tl_set_cell: "כתיבה",
  tl_paste_rows: "כתיבה",
  // שורה לאתר, אבל נקרא עם אתר **אחד** (detailDirect: p_site_ids: [site.id])
  site_uptime_service: "שורה לאתר — נקרא עם אתר אחד",

  // ---- רכבי הטכנאים ומיקומי האתרים (vehiclesDirect.js, 20/10/2026) ----
  vehicles_live_list: "jsonb יחיד — כל הרכבים (38) + שורת הסנכרון",
  site_locations_list: "jsonb יחיד — כל האתרים (219) עם המיקום שלהם",
  site_geo_set: "כתיבה",

  // ---- לוח הטכנאים (techniciansDirect.js, 20/10/2026) — הטבלאות סגורות, הכול דרך RPC ----
  tech_board: "jsonb יחיד — הטכנאים הפעילים (עשרות) + הצי + המקומות האחרונים",
  tech_day: "jsonb יחיד — היומן של יום אחד (כ-300 שורות)",
  tech_save: "כתיבה",
  tech_set_status: "כתיבה",
  tech_dispatch: "כתיבה",
  tech_dispatch_mark: "כתיבה",
  tech_dispatch_end: "כתיבה",
  // קוד כניסה במייל (20/10/2026) — נמצאו לא מוכרזות בבדיקה המקיפה של 21/10
  login_code_status: "jsonb יחיד — {required, verified, email} של המשתמש עצמו",
  login_code_verify: "jsonb יחיד — {ok, error, left}",
  // הטלפון של הטכנאי והצפצוף (21/10/2026, שלבים 2 ו-4)
  tech_phone_unpair: "כתיבה",
  tech_me: "jsonb יחיד — הטכנאי עצמו והמשימה הפתוחה שלו (אחת לכל היותר)",
  tech_push_subscribe: "כתיבה",
  tech_self_ack: "כתיבה",
  tech_self_unpair: "כתיבה — ניתוק הטלפון מהטלפון עצמו (21/10/2026)",
  // רשימת רכבי השירות (21/10/2026): jsonb יחיד — כל רכבי הצי (≈38) והרשימה עצמה; השמירה כתיבה
  fleet_list: "jsonb יחיד — רכבי הצי מאיתוראן (≈38) והרשימה המוצגת",
  fleet_shown_set: "כתיבה",
  // "טכנאי באתר" בלוח (21/10/2026): ביקור פתוח אחד לכל רכב (אינדקס ייחודי), כלומר עד מספר הרכבים בצי (38)
  tech_on_site: "jsonb יחיד — הביקורים הפתוחים, אחד לכל רכב לכל היותר",

  // ---- משימות (tasksDirect.js) — הטבלה סגורה, הכול דרך RPC ----
  tasks_list: "jsonb יחיד — הפתוחות + p_done_limit אחרונות שבוצעו (200; NULL = כולן, של אתר אחד) + done_total",
  task_counts: "שורה לאתר×סוג (עד 4: שלושת הסוגים — app.task_kinds() — ו-'none' למשימה בלי סוג) — רק אתרים עם משימה פתוחה",
  task_add: "כתיבה",
  task_start: "כתיבה",
  task_unstart: "כתיבה",
  task_done: "כתיבה",
  task_delete: "כתיבה",

  // ---- קריאות ויזנט (serviceCallsDirect.js) — הטבלאות סגורות, הכול דרך RPC ----
  service_call_counts: "שורה לאתר — רק אתרים עם קריאה פתוחה",
  service_calls_open: "jsonb יחיד — הקריאות הפתוחות של אתר אחד",
  // ⚠️ 15/10/2026: "להיסטוריה" — הסגורות של אתר, עם תקרה במסד (100, לכל היותר 500) ו-total לצידה
  service_calls_history: "jsonb יחיד — עד 100 (לכל היותר 500) הסגורות של אתר אחד + total",
  // ⚠️ "קריאות היום" (14/10) לא הוכרזה עד 15/10 — העטיפה rpc() נסרקת מ-12/10, אבל אף אחד לא הריץ את השער מאז
  service_calls_recent: "jsonb יחיד — מה שהגיע ב-24 השעות (עד 168) וכל קריאה פתוחה",
  service_calls_recent_summary: "jsonb יחיד — שני מספרים",
  // 18/10/2026: שתי הקודמות בקריאה אחת (App.loadCallCounts). נמצא לא-מוכרז בהרצת השערים בערב אותו יום.
  service_calls_board: "jsonb יחיד — שורת ספירה לכל אתר עם קריאה (≤ מספר האתרים) + שני מספרים",
  wizenet_lookups_list: "jsonb יחיד — שתי הרשימות של ויזנט",
  // הממסר לוויזנט (15/10/2026) — תור; הדפדפן מכניס ושואל, מחשב באתר מבצע
  wizenet_request_update: "כתיבה — מחזיר מספר בקשה",
  wizenet_request_lookups: "כתיבה — מחזיר מספר בקשה",
  wizenet_request_status: "jsonb יחיד — בקשה אחת",
  wizenet_relays_status: "jsonb יחיד — שני מספרים",
  inspection_defect_save: "כתיבה",
  inspection_defect_delete: "כתיבה",
  inspection_defect_photo_add: "כתיבה",
  inspection_defect_photo_delete: "כתיבה",
  inspection_defect_done: "כתיבה",
  inspection_defect_reopen: "כתיבה",
  pm_template_save: "כתיבה",
  pm_visit_start: "כתיבה",
  pm_visit_item_check: "כתיבה",
  pm_visit_item_note: "כתיבה",
  pm_visit_photo_add: "כתיבה",
  pm_visit_photo_delete: "כתיבה",
  pm_visit_submit: "כתיבה",
  pm_visit_discard: "כתיבה",
  pm_historical_upload: "כתיבה",
  pm_visit_delete: "כתיבה",
  compliance_reattach: "כתיבה",
  compliance_purge: "כתיבה",
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
  { fn: "site_compliance", why: "שורה לאתר", args: () => ({ p_site_ids: null }) },
  // שורה לכל אתר שחובר ברמזור (sitesDirect, בכל טעינה). לא הוכרזה עד 15/10/2026.
  { fn: "site_service_links", why: "שורה לאתר", args: () => ({}) },
];

// ============================================================
// טבלאות שנקראות ישירות — ומה חוסם כל אחת
// ============================================================
// ⚠️ הרשימה הזו נבנתה אחרי שהשער תפס שש טבלאות שסריקה ידנית החמיצה:
// חלק מהקריאות כתובות `supabase\n  .from(...)`, ו-grep על `supabase.from`
// אינו רואה אותן. זו בדיוק הסיבה שהחצי הסטטי כאן סובלני לרווחים.
const TABLES = {
  sites: "שורה לאתר",
  // ⚠️ שלוש אלה לא הוכרזו עד 15/10/2026 (השער לא רץ מ-12/10). כולן שורה לאתר **מעצם המבנה**:
  // alive — upsert, שורה אחת לאתר לנצח (ראו "Heartbeat"); site_card_metrics — pg_cron כותב שורה לאתר;
  // app_users — שורה למשתמש, והקוראים מסננים ל-role='agent' — אינדקס ייחודי חלקי: סוכן פעיל אחד לאתר.
  alive: "שורה לאתר — upsert, לעולם אינה גדלה",
  site_card_metrics: "שורה לאתר — נכתבת ב-pg_cron",
  app_users: "שורה למשתמש; הקוראים מסננים ל-role='agent' — זהות פעילה אחת לאתר (אינדקס ייחודי חלקי), ולא-פעילות רק מהחלפת בקר",
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
    // ⚠️ complianceDirect.js קורא דרך עטיפה עם זמן קצוב (rpcT / rpcRaw /
    // outboxCall) ולא `supabase.rpc("...")` ישירות. בלי השורה הזו 33 קריאות
    // היו נעלמות מהשער — ירוק בלי לסרוק אותן, בדיוק הכשל שהשער נבנה נגדו.
    // ⚠️ ו-tasksDirect.js (וכל שירות עם עטיפה בשם rpc) קורא `rpc("task_add", …)` — עד 12/10/2026 אף קריאת
    // משימות לא נסרקה כאן, וההכרזות שלהן עמדו בלי שום דבר שמחייב אותן. task_delete נוסף בלי הכרזה ולא נתפס.
    for (const m of src.matchAll(/\b(?:rpcT|rpcRaw|outboxCall|rpc)\(\s*["'](\w+)["']/g)) rpcs.add(m[1]);
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
    // ⚠️ וגם הזמן, לא רק המספר (18/10/2026). PostgREST מנתק אחרי 8 שניות (57014), והקריאה הזו הייתה 13.4 שניות
    // ב-15/10 — השער הדפיס אז "-1 איברים", שנראה כמו הקאפ ואינו, ואיש לא ראה את הגרף שלא נטען. אחרי התיקון היא
    // 3.6 שניות, וגדלה עם מספר האתרים. מעל SLOW_MS השער אדום: ככה שומעים על ההתקרבות לתקרה חודשים לפני שהמסך
    // מפסיק להיטען. ⚠️ אין כאן נתחים: פיצול ל-5 קריאות נמדד איטי יותר (4.6 שניות) וכפול בזמן מסד — ראו CLAUDE.md.
    const SLOW_MS = 5000;
    const t0 = Date.now();
    const r = await retry(`${SB}/rest/v1/rpc/executive_series_json`, {
      method: "POST", headers: H,
      body: JSON.stringify({ p_site_ids: null, p_from: ctx.yearAgo, p_to: now, p_buckets: withTotal }),
    });
    const ms = Date.now() - t0;
    const arr = await r.json();
    const n = Array.isArray(arr) ? arr.length : -1;
    const slow = ms > SLOW_MS;
    const ok = n > 0 && n !== LIMIT && !slow;
    if (!ok) fails++;
    let tail = "";
    if (n === LIMIT) tail = "  — בדיוק 1,000, חתימת הקאפ!";
    // תשובה שאינה מערך היא שגיאה של PostgREST — להדפיס אותה, ולא "-1" שנראה כמו קאפ
    else if (n < 0) tail = `  — לא מערך (status ${r.status}): ${JSON.stringify(arr).slice(0, 140)}`;
    else if (slow) tail = `  — איטי: מעל ${SLOW_MS / 1000} שניות, תקרת PostgREST היא 8`;
    console.log(`  ${ok ? "✅" : "❌"} ${"executive_series_json".padEnd(20)} ${String(n).padStart(5)} איברים · ${withTotal.length} דליים · ${ms} ms${tail}`);
  } finally {
    await g.cleanup();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(fails === 0 ? "✅ אף קריאה אינה מתקרבת לתקרה" : `❌ ${fails} ממצאים`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
