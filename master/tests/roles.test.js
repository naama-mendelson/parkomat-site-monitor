// tests/roles.test.js — שלושה תפקידים: מנהל, עורך, בקר (19/10/2026).
//
// בעלת המוצר: "אני רוצה שיהיה עורך, בקר ומנהל. בקר אין לו שום יכולת לשנות כלום רק לראות. עורך יש לו יכולות עריכה של
// הכל חוץ מחיקת אתר, הוספת משתמשים ומחיקת משתמשים". הכלל במסד: app.require_editor() בכל פעולה שכותבת,
// app.require_manager() במה שנשאר למנהל בלבד, ו-require_staff (קריאה) לכל השלושה.
//
// ⚠️ הבדיקה הראשונה היא מפקד: כל פונקציה ציבורית במסד חייבת להופיע באחת משלוש הרשימות כאן. פונקציה חדשה שלא סווגה
// נכשלת — כך אי אפשר להוסיף כתיבה עם require_staff (שמכניס גם בקר) בלי שמישהו יחליט.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "d3000000-0000-0000-0000-000000000001";
const MGR2 = "d3000000-0000-0000-0000-000000000002";
const ED = "d3000000-0000-0000-0000-000000000003";
const RO = "d3000000-0000-0000-0000-000000000004";

let h;
let seq = 0;
const sup = async (sql, params = []) => (await h.pg.query(sql, params)).rows;
const rpc = async (uid, sql, params = []) => (await h.as("authenticated", uid, (tx) => tx.query(sql, params))).rows;
const one = async (uid, sql, params = []) => (await rpc(uid, sql, params))[0];
async function fails(p, code, re) {
  await assert.rejects(p, (e) => {
    if (code) assert.equal(e.code, code, `ציפיתי ל-${code}, התקבל ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
}
async function newSite() {
  const code = `ROL${++seq}`;
  const id = (await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$2,'ready','2026-01-01T00:00:00.000Z') RETURNING id`,
    [code, code]))[0].id;
  return { id, code };
}
const uid2id = async (uid) => (await sup(`SELECT id FROM app_users WHERE supabase_uid = $1`, [uid]))[0].id;

// כל פעולה שכותבת — מנהל או עורך
const EDITOR = [
  "broadcast_reload", "cancel_maintenance", "inspection_close_by_report", "inspection_defect_delete", "inspection_defect_done",
  "inspection_defect_photo_add", "inspection_defect_photo_delete", "inspection_defect_reopen", "inspection_defect_save",
  "inspection_machine_retire", "inspection_report_delete", "inspection_report_update", "inspection_upload", "mark_as_test",
  "mark_controller_replaced", "pm_historical_upload", "pm_profile_delete", "pm_profile_save", "pm_profile_sites_set",
  "pm_site_profile_set", "pm_site_templates_set", "pm_template_create", "pm_template_meta_set", "pm_template_rename",
  "pm_template_save", "pm_visit_delete", "pm_visit_discard", "pm_visit_item_check", "pm_visit_item_note", "pm_visit_photo_add",
  "pm_visit_photo_delete", "pm_visit_start", "pm_visit_submit", "publish_announcement", "reclassify_status", "register_site",
  "schedule_maintenance", "site_geo_set", "start_maintenance", "task_add", "task_delete", "task_done", "task_start", "task_unstart",
  "tl_add_column", "tl_add_row", "tl_delete_column", "tl_delete_row", "tl_move_column", "tl_move_row", "tl_paste_rows",
  "tl_set_cell", "tl_update_column", "unmark_test", "update_site", "wizenet_request_lookups", "wizenet_request_update",
  "tech_dispatch", "tech_dispatch_end", "tech_dispatch_mark", "tech_save", "tech_set_status", "tech_phone_begin", "tech_phone_unpair",
  // רשימת רכבי השירות (21/10/2026): השמירה, וגם הקריאה של הרשימה המלאה — היא כוללת את רכבי המשרד, שבקר לא אמור לראות
  "fleet_shown_set", "fleet_list",
];
// מנהל בלבד: מחיקת אתר וכלי השאריות שלו, ניהול משתמשים, קוד הניהול, תיבת הדיווחים, ופעולות השרת המת
const MANAGER = [
  "compliance_orphans", "compliance_purge", "compliance_reattach", "compliance_storage", "delete_field_report", "delete_site",
  "list_users", "reply_to_field_report", "request_service_ping", "request_service_restart", "resolve_field_report",
  "set_admin_code", "set_user_active", "set_user_role",
];
// קריאה (require_staff / RLS), זהויות מכונה (סוכן, ממסר, קליטה), ומה שמשתמש עושה לעצמו בלבד
const OTHER = [
  "activity_rows", "claim_service_command", "complete_service_command", "compliance_file", "compliance_history_list",
  "compliance_thumbs", "executive_series", "executive_series_json", "ingest_batch", "insights_rows", "inspection_site",
  "login_code_issue", "login_code_status", "login_code_unsend", "login_code_verify",
  "ituran_ingest", "ituran_sync_failed", "vehicles_live_list", "site_geo_import", "site_locations_list", "tech_on_site",
  "tech_board", "tech_day", "tech_me", "tech_phone_link", "tech_push_subscribe", "tech_push_claim", "tech_push_result", "tech_self_ack", "tech_self_unpair",
  "mark_announcement_seen", "my_role", "my_seen_announcements", "pending_announcement", "pm_profiles_list", "pm_site",
  "pm_template", "pm_templates_list", "pm_visit_detail", "recent_errors", "report_by_site", "report_monthly",
  "report_site_months", "server_heartbeat", "service_call_counts", "service_calls_board", "service_calls_history",
  "service_calls_open", "service_calls_recent", "service_calls_recent_count", "service_calls_recent_summary",
  "service_health", "site_compliance", "site_globals", "site_segments_collapsed", "site_service_links", "site_stats",
  "site_status_history", "site_uptime", "site_uptime_service", "submit_field_report", "task_counts", "tasks_list", "tl_board",
  "wizenet_claim", "wizenet_complete", "wizenet_lookups_list", "wizenet_relay_me", "wizenet_relays_status",
  "wizenet_request_status",
];

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
      ('rl-mgr@parkomat.co.il','מנהלת','manager',true,$1,$5),
      ('rl-mgr2@parkomat.co.il','מנהל שני','manager',true,$2,$5),
      ('rl-ed@parkomat.co.il','עורכת','editor',true,$3,$5),
      ('rl-ro@parkomat.co.il','בקר','operator',true,$4,$5)`, [MGR, MGR2, ED, RO, now]);
});
after(async () => { if (h) await h.close(); });

test("מפקד: כל פונקציה ציבורית מסווגת; עורך = require_editor, מנהל = require_manager / is_manager", { skip }, async () => {
  const rows = await sup(`SELECT p.proname AS n,
      p.prosrc LIKE '%app.require_editor()%' AS ed,
      (p.prosrc LIKE '%app.require_manager()%' OR p.prosrc LIKE '%app.is_manager()%') AS mg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f'`);
  const all = new Set([...EDITOR, ...MANAGER, ...OTHER]);
  assert.equal(all.size, EDITOR.length + MANAGER.length + OTHER.length, "פונקציה מופיעה ביותר מרשימה אחת");
  const unknown = rows.map((r) => r.n).filter((n) => !all.has(n));
  assert.deepEqual(unknown, [], "פונקציה ציבורית חדשה בלי סיווג — להחליט: עורך, מנהל, או קריאה");
  const by = Object.fromEntries(rows.map((r) => [r.n, r]));
  for (const n of EDITOR) {
    assert.ok(by[n], `${n} ברשימה ואינה קיימת`);
    assert.ok(by[n].ed && !by[n].mg, `${n}: צריכה require_editor (ולא require_manager)`);
  }
  for (const n of MANAGER) {
    assert.ok(by[n], `${n} ברשימה ואינה קיימת`);
    assert.ok(by[n].mg && !by[n].ed, `${n}: צריכה require_manager / is_manager (ולא require_editor)`);
  }
  for (const n of OTHER) assert.ok(by[n] && !by[n].ed && !by[n].mg, `${n}: ברשימת הקריאה אבל קוראת לבדיקת עורך/מנהל — לסווג מחדש`);
});

test("האילוץ מכיר את 'editor', ולא תפקיד מומצא; my_role מחזיר את התפקיד מהטבלה", { skip }, async () => {
  assert.equal((await one(ED, `SELECT public.my_role() r`)).r, "editor");
  assert.equal((await one(RO, `SELECT public.my_role() r`)).r, "operator");
  await fails(sup(`INSERT INTO app_users (email, role, is_active, created_at) VALUES ('rl-x@parkomat.co.il','boss',true,'x')`), "23514");
  assert.equal((await one(ED, `SELECT app.can_edit() c`)).c, true);
  assert.equal((await one(MGR, `SELECT app.can_edit() c`)).c, true);
  assert.equal((await one(RO, `SELECT app.can_edit() c`)).c, false);
});

test("בקר: כל כתיבה נדחית ב-42501 עם הסבר; קריאה מותרת", { skip }, async () => {
  const s = await newSite();
  const writes = [
    [`SELECT * FROM public.start_maintenance($1, 1, 'בדיקה', 'בקר בדיקה')`, [s.code]],
    [`SELECT * FROM public.schedule_maintenance($1, now() + interval '1 day', now() + interval '2 days', 'בדיקה')`, [s.code]],
    [`SELECT * FROM public.cancel_maintenance($1, 'בקר בדיקה')`, [s.code]],
    [`SELECT * FROM public.register_site(p_code => 'ROLX1', p_site_name => 'חדש')`],
    [`SELECT * FROM public.update_site(p_code => $1, p_site_name => 'שם אחר')`, [s.code]],
    [`SELECT public.reclassify_status(1, 'maintenance')`],
    [`SELECT public.tl_set_cell(1, 'c_code', '"x"'::jsonb)`],
    [`SELECT public.publish_announcement('כותרת', 'גוף ההודעה')`],
    [`SELECT public.task_add(NULL, 'משימה', $1, gen_random_uuid())`, [s.code]],
    [`SELECT public.wizenet_request_update('1', 'status', '1')`],
  ];
  for (const [sql, params] of writes) await fails(rpc(RO, sql, params ?? []), "42501", /בקר יכול רק לצפות/);
  // ...ואינו מגיע לכלי המנהל
  await fails(rpc(RO, `SELECT public.delete_site($1)`, [s.code]), "42501");
  await fails(rpc(RO, `SELECT * FROM public.list_users()`), "42501");
  // קורא
  await rpc(RO, `SELECT public.tasks_list(NULL, $1, 10)`, [s.code]);
  await rpc(RO, `SELECT public.inspection_site($1)`, [s.code]);
  await rpc(RO, `SELECT public.pm_site($1)`, [s.code]);
  await rpc(RO, `SELECT public.service_calls_board(24)`);
  await rpc(RO, `SELECT * FROM public.site_globals()`);
  // הדבר היחיד שבקר משנה — שראה הודעה (מצב שלו בלבד), ודיווח למנהלת (מכתב, לא נתוני אתרים)
  assert.equal((await rpc(RO, `SELECT * FROM public.my_seen_announcements()`)).length >= 0, true);
});

test("עורך: עורך הכל — רישום ועדכון אתר, תחזוקה; לא מוחק אתר, לא מנהל משתמשים ולא משנה את קוד הניהול", { skip }, async () => {
  await rpc(ED, `SELECT * FROM public.register_site(p_code => 'ROLE1', p_site_name => 'אתר של עורכת')`);
  assert.equal((await sup(`SELECT count(*)::int n FROM sites WHERE code = 'ROLE1'`))[0].n, 1);
  await rpc(ED, `SELECT * FROM public.update_site(p_code => 'ROLE1', p_site_name => 'שם חדש')`);
  assert.equal((await sup(`SELECT site_name FROM sites WHERE code = 'ROLE1'`))[0].site_name, "שם חדש");
  await rpc(ED, `SELECT * FROM public.start_maintenance('ROLE1', 1, 'בדיקה', 'עורכת בדיקה')`);
  await rpc(ED, `SELECT * FROM public.cancel_maintenance('ROLE1', 'עורכת בדיקה')`);
  // מנהל בלבד
  await fails(rpc(ED, `SELECT public.delete_site('ROLE1')`), "42501", /למנהלים בלבד/);
  await fails(rpc(ED, `SELECT * FROM public.list_users()`), "42501", /למנהלים בלבד/);
  await fails(rpc(ED, `SELECT * FROM public.set_user_role($1, 'manager')`, [await uid2id(RO)]), "42501", /למנהלים בלבד/);
  await fails(rpc(ED, `SELECT * FROM public.set_user_active($1, false)`, [await uid2id(RO)]), "42501", /למנהלים בלבד/);
  await fails(rpc(ED, `SELECT public.set_admin_code('a', 'b')`), "42501");
  // והמנהלת מוחקת
  await rpc(MGR, `SELECT public.delete_site('ROLE1')`);
  assert.equal((await sup(`SELECT count(*)::int n FROM sites WHERE code = 'ROLE1'`))[0].n, 0);
});

test("set_user_role: שלושה תפקידים; הורדה ממנהל — לעורך או לבקר — שומרת על המנהל האחרון ועל עצמי", { skip }, async () => {
  const roId = await uid2id(RO), m2 = await uid2id(MGR2), m1 = await uid2id(MGR);
  const set = (actor, id, role) => one(actor, `SELECT out_role FROM public.set_user_role($1, $2)`, [id, role]);
  assert.equal((await set(MGR, roId, "editor")).out_role, "editor");
  assert.equal((await set(MGR, roId, "operator")).out_role, "operator");
  await fails(set(MGR, roId, "boss"), "23514", /תפקיד לא תקין/);
  await fails(set(MGR, m1, "editor"), "23514", /את עצמך/);
  // שני מנהלים — מורידים אחד לעורך, והיומן אומר מאיפה לאן
  // (שמירת "המנהל האחרון" אינה נבחנת כאן: מי שקורא היא מנהלת פעילה, כך שהיעד האחרון הוא תמיד היא עצמה — שמירת
  // "את עצמך" שלמעלה)
  assert.equal((await set(MGR, m2, "editor")).out_role, "editor");
  const au = await sup(`SELECT details FROM audit_log WHERE action = 'user.role' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual([au[0].details.from, au[0].details.to], ["manager", "editor"]);
  await sup(`UPDATE app_users SET role = 'manager' WHERE id = $1`, [m2]);
});

test("⚠️ המעבר החד-פעמי (בקרים של 19/10 → עורכים) רץ פעם אחת בלבד: החלה חוזרת אינה הופכת בקר חדש לעורך", { skip }, async () => {
  const sec = fs.readFileSync(path.join(__dirname, "..", "db", "security.postgres.sql"), "utf8");
  assert.equal((await sup(`SELECT count(*)::int n FROM settings WHERE key = 'roles_editor_migrated'`))[0].n, 1, "הסימן נכתב באתחול");
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, created_at) VALUES ('rl-new@parkomat.co.il','בקר חדש','operator',true,'x')`);
  await h.pg.exec(sec);
  assert.equal((await sup(`SELECT role FROM app_users WHERE email = 'rl-new@parkomat.co.il'`))[0].role, "operator", "החלה חוזרת שינתה בקר");
  // וכשאין סימן (כמו בייצור לפני ההחלה) — הבקרים עוברים, והסימן נכתב
  await sup(`DELETE FROM settings WHERE key = 'roles_editor_migrated'`);
  await h.pg.exec(sec);
  assert.equal((await sup(`SELECT role FROM app_users WHERE email = 'rl-new@parkomat.co.il'`))[0].role, "editor");
  assert.equal((await sup(`SELECT count(*)::int n FROM settings WHERE key = 'roles_editor_migrated'`))[0].n, 1);
  await sup(`UPDATE app_users SET role = 'operator' WHERE supabase_uid = $1`, [RO]);
});

test("המסך: canEdit / isManagerRole / roleLabel — שלושה תפקידים, ותפקיד לא מוכר אינו עורך", async () => {
  const r = await import("../../dashboard/src/utils/roles.js");
  assert.deepEqual(r.ROLES, ["manager", "editor", "operator"]);
  assert.deepEqual(r.ROLES.map(r.canEdit), [true, true, false]);
  assert.deepEqual(r.ROLES.map(r.isManagerRole), [true, false, false]);
  for (const x of [undefined, null, "", "agent", "supervisor", "Manager"]) {
    assert.equal(r.canEdit(x), false, `${x} אינו עורך`);
    assert.equal(r.isManagerRole(x), false);
  }
  assert.deepEqual(r.ROLES.map(r.roleLabel), ["מנהל", "עורך", "בקר"]);
  assert.equal(r.roleLabel("agent"), "—");
  // אותה הודעה כמו במסד (app.require_editor) — כך בקר רואה את אותו משפט לפני הלחיצה ואחריה
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "writes.postgres.sql"), "utf8");
  assert.ok(sql.includes(r.READ_ONLY_MSG.split(" — ")[0]), "המשפט במסך והמשפט במסד נפרדו");
});

test("⚠️ זהות הקליטה מוויזנט (בייצור — תפקיד מנהל) אינה עורכת ואינה מנהלת: התפקיד שלה הוא intake", { skip }, async () => {
  const INT = "d3000000-0000-0000-0000-000000000009";
  await sup(`INSERT INTO app_users (email, role, is_active, supabase_uid, created_at) VALUES ('rl-intake@parkomat.co.il','manager',true,$1,'x')`, [INT]);
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('intake_user_id', $1, 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [INT]);
  try {
    await fails(rpc(INT, `SELECT * FROM public.register_site(p_code => 'ROLI1', p_site_name => 'מהקליטה')`), "42501", /בקר יכול רק לצפות/);
    await fails(rpc(INT, `SELECT public.task_add(NULL, 'משימה', NULL, gen_random_uuid())`), "42501");
    // הסקירה של 19/10: require_manager ושתי ה-Edge Functions (שבודקות my_role) לא הוציאו אותה
    assert.equal((await one(INT, `SELECT public.my_role() r`)).r, "intake");
    assert.equal((await one(INT, `SELECT app.is_manager() m`)).m, false);
    assert.equal((await one(INT, `SELECT app.can_edit() c`)).c, false);
    const s = await newSite();
    await fails(rpc(INT, `SELECT public.delete_site($1)`, [s.code]), "42501", /מנהלים בלבד/);
    await fails(rpc(INT, `SELECT public.set_user_role($1, 'manager')`, [await uid2id(RO)]), "42501", /מנהלים בלבד/);
    await fails(rpc(INT, `SELECT * FROM public.list_users()`), "42501");
    assert.equal((await sup(`SELECT 1 FROM sites WHERE code = $1`, [s.code])).length, 1, "האתר נמחק בידי זהות הקליטה");
    // ובלי המפתח ב-settings — אותה שורה היא שוב מה שכתוב בה (התנאי אינו נוגע במשתמשים אחרים)
    assert.equal((await one(MGR, `SELECT public.my_role() r`)).r, "manager");
  } finally {
    await sup(`DELETE FROM settings WHERE key = 'intake_user_id'`);
  }
});

test("שתי פונקציות השרת המת (claim/complete_service_command) סגורות בפני anon ו-authenticated — גם במסד נקי", { skip }, async () => {
  for (const fn of ["public.claim_service_command()", "public.complete_service_command(bigint, boolean, text)"]) {
    for (const role of ["anon", "authenticated"]) {
      const r = (await sup(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS can`, [role, fn]))[0];
      assert.equal(r.can, false, `${role} רשאי להריץ את ${fn}`);
    }
  }
  await fails(rpc(RO, `SELECT public.claim_service_command()`), "42501");
});
