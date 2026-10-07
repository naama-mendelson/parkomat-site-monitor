// tests/compliance.test.js — בודק מוסמך, תחזוקה מונעת והרמזור, על Postgres 17 מקומי.
//
// כל הבדיקות כאן רצות על `db.init()` האמיתי (tests/helpers/local-pg.js) — אותו
// סדר קבצים, אותן הרשאות, אותו RLS. אף שורה לא נוגעת בייצור.
//
// ⚠️ הזהויות נזרעות **כמו בייצור**, כולל זהות הקליטה עם שורת operator פעילה
// (D3 במפרט). בלי השורה הזו התנאי `NOT app.is_intake_client()` ב-`app.is_staff()`
// היה נראה כקוד מת, והמוטציה שמוחקת אותו הייתה שורדת.
//
// הסדר בקובץ משמעותי: node:test מריץ ברצף, והבדיקה של "רשימת בדיקה ריקה"
// חייבת לרוץ לפני שהרשימה נזרעת.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "a1000000-0000-0000-0000-000000000001";
const OPR = "a1000000-0000-0000-0000-000000000002";
const OPR2 = "a1000000-0000-0000-0000-000000000003";
const AGT = "a1000000-0000-0000-0000-000000000004";
const OFF = "a1000000-0000-0000-0000-000000000005";
const INT = "a1000000-0000-0000-0000-000000000006";

const TABLES = ["inspection_machines", "inspection_files", "inspection_reports", "inspection_defects",
  "inspection_defect_photos", "pm_checklist_items", "pm_visits", "pm_visit_items", "pm_files", "compliance_history"];

let h;
let TODAY;
let siteSeq = 0;

// ---------------------------------------------------------------
// עזרים
// ---------------------------------------------------------------
const uuid = () => crypto.randomUUID();
const b64 = (buf) => buf.toString("base64");
const pdf = (n = 120, tag = uuid()) => b64(Buffer.from(`%PDF-1.4\n%${tag}\n${"x".repeat(n)}`));
const jpg = (tag = uuid()) => b64(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg-${tag}`)]));
// ⚠️ אחרי החתימה בת 8 הבתים חייב לבוא אורך ה-IHDR (00 00 00 0D): התו ה-11 ב-base64
// נגזר גם מהבית התשיעי, ובלעדיו הקידומת אינה 'iVBORw0KGgo' — כמו בקובץ אמיתי.
const png = (tag = uuid()) => b64(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
  Buffer.from(`IHDR-${tag}`)]));
const webp = (tag = uuid()) => b64(Buffer.from(`RIFF\0\0\0\0WEBPVP8 ${tag}`));
const addDays = (d, n) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};

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
  const code = `CMP${++siteSeq}`;
  const id = (await sup(
    `INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready','2026-01-01T00:00:00.000Z') RETURNING id`,
    [code]))[0].id;
  return { id, code };
}

async function upload(code, meta, { file, defects = [], uid = MGR, mime = "application/pdf" } = {}) {
  const m = { client_id: uuid(), ...meta };
  const f = file === null ? null : JSON.stringify({ mime, data: file ?? pdf(), name: "t.pdf" });
  return one(uid,
    `SELECT report_id::int, file_id::int, valid_until::text, defects, closed, replayed
       FROM public.inspection_upload($1, $2::jsonb, $3::jsonb, $4::jsonb)`,
    [code, JSON.stringify(m), f, JSON.stringify(defects)]);
}
const periodic = (s, o = {}) => upload(s.code, {
  kind: "periodic",
  inspected_on: o.insp ?? addDays(TODAY, -10),
  valid_until: "valid" in o ? o.valid : addDays(TODAY, 200),
  machine_key: o.machine,
  confirm_clean: o.defects ? false : true,
  parse: o.parse,
}, { defects: o.defects ?? [], file: o.file });
const followup = (s, parentId, o = {}) => upload(s.code, {
  kind: "followup",
  followup_of: parentId,
  inspected_on: o.insp ?? addDays(TODAY, -1),
  valid_until: o.valid ?? null,
  confirm_clean: o.defects ? false : true,
  close_open_defects: o.close ?? false,
}, { defects: o.defects ?? [], file: o.file });

const defectsOf = (reportId) => sup(
  `SELECT id::int, status, closure_no, done_photo_id::int, closed_by_report_id::int
     FROM inspection_defects WHERE report_id = $1 ORDER BY seq`, [reportId]);
const stagePhoto = async (uid, defectId, data = jpg(), client = uuid(), mime = "image/jpeg") => (await one(uid,
  `SELECT public.inspection_defect_photo_add($1, $2::jsonb, $3::uuid)::int AS id`,
  [defectId, JSON.stringify({ mime, data }), client])).id;
const done = (uid, defectId, req = uuid()) => one(uid,
  `SELECT defect_id::int, photos, replayed FROM public.inspection_defect_done($1, 'טכנאי בדיקה', NULL, $2::uuid)`,
  [defectId, req]);
const closeByPhoto = async (defectId) => { await stagePhoto(OPR, defectId); return done(OPR, defectId); };

const status = async (siteId, day) => (await sup(
  `SELECT inspection_state s, inspection_validity_state vs, inspection_valid_until::text vu, inspection_days_left dl,
          inspection_missing miss, inspection_cycle c, machines m, open_defects open,
          pm_state ps, pm_missing pmiss, pm_last_on::text plast, pm_last_visit_id::int pvid, pm_due_on::text pdue
     FROM app.compliance_rows(ARRAY[$1]::int[], $2::date)`, [siteId, day ?? TODAY]))[0];

const startVisit = (uid, code, restart = false) => one(uid,
  `SELECT visit_id::int, created FROM public.pm_visit_start($1, $2)`, [code, restart]);
const visitItems = (visitId) => sup(
  `SELECT id::int, label, kind, required, min_photos, checked, note FROM pm_visit_items WHERE visit_id = $1 ORDER BY seq, id`,
  [visitId]);
const pmPhoto = async (uid, itemId, client = uuid(), data = jpg()) => (await one(uid,
  `SELECT public.pm_visit_photo_add($1, $2::jsonb, $3::uuid)::int AS id`,
  [itemId, JSON.stringify({ mime: "image/jpeg", data }), client])).id;
const submit = (uid, visitId, { name = "טכנאי שטח", sig = { mime: "image/png", data: png() }, on = null, req = uuid() } = {}) =>
  one(uid, `SELECT visit_id::int, performed_on::text, next_due_on::text, replayed
              FROM public.pm_visit_submit($1, $2, $3::jsonb, $4::date, NULL, $5::uuid)`,
  [visitId, name, sig === null ? null : JSON.stringify(sig), on, req]);
const compEvents = async (code) => (await sup(
  `SELECT count(*)::int n FROM events WHERE type = 'compliance' AND site_code = $1`, [code]))[0].n;

before(async () => {
  if (skip) return;
  // ⚠️ עם ברירות המחדל של Supabase (ALL ל-anon/authenticated/service_role על כל אובייקט
  // חדש ב-public). בלעדיהן מחיקת ה-REVOKE מהקובץ לא הייתה משנה דבר כאן — ובייצור
  // הייתה פותחת את data_b64. בדיקות 1–3 עיוורות בלי זה.
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  await sup(
    `INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
       ('cm-mgr@parkomat.co.il','מנהלת בדיקה','manager',true,$1,$6),
       ('cm-op@parkomat.co.il','בקר בדיקה','operator',true,$2,$6),
       ('cm-op2@parkomat.co.il','בקר שני','operator',true,$3,$6),
       ('cm-off@parkomat.co.il','מושבת','operator',false,$4,$6),
       ('cm-intake@parkomat.co.il',NULL,'operator',true,$5,$6)`,
    [MGR, OPR, OPR2, OFF, INT, now]);
  const s = await newSite();
  await sup(`INSERT INTO app_users (email, role, is_active, supabase_uid, site_id, created_at)
             VALUES ('site-cm@parkomat.co.il','agent',true,$1,$2,$3)`, [AGT, s.id, now]);
  // ⚠️ כמו בייצור: זהות הקליטה מוגדרת ב-settings **וגם** יש לה שורת operator פעילה
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('intake_user_id', $1, 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [INT]);
  TODAY = (await sup(`SELECT app.compliance_today()::text d`))[0].d;
});
after(async () => { if (h) await h.close(); });

// ================================================================
// גישה
// ================================================================

test("1 · anon: אף RPC של הלשוניות אינו ניתן להרצה", { skip }, async () => {
  const r = await sup(`SELECT p.oid::regprocedure::text sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (p.proname LIKE 'inspection\\_%' OR p.proname LIKE 'pm\\_%'
       OR p.proname LIKE 'compliance\\_%' OR p.proname = 'site_compliance')`);
  assert.ok(r.length >= 25, `נמצאו רק ${r.length} פונקציות`);
  const anonX = await sup(`SELECT p.oid::regprocedure::text sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (p.proname LIKE 'inspection\\_%' OR p.proname LIKE 'pm\\_%'
       OR p.proname LIKE 'compliance\\_%' OR p.proname = 'site_compliance')
      AND has_function_privilege('anon', p.oid, 'EXECUTE')`);
  assert.deepEqual(anonX.map((x) => x.sig), []);
  for (const sql of [`SELECT * FROM public.site_compliance(NULL)`, `SELECT public.inspection_site('x')`,
    `SELECT public.pm_site('x')`, `SELECT * FROM public.compliance_file('inspection_pdf', 1)`]) {
    await fails(h.as("anon", null, (tx) => tx.query(sql)), "42501", /permission denied/);
  }
});

test("2 · מנהל, בקר וסוכן: SELECT ישיר על כל עשר הטבלאות נדחה", { skip }, async () => {
  for (const uid of [MGR, OPR, AGT]) {
    for (const t of TABLES) {
      await fails(rpc(uid, `SELECT 1 FROM ${t} LIMIT 1`), "42501", /permission denied/);
    }
  }
});

test("3 · אין הרשאת טבלה, עמודה או sequence ל-authenticated / service_role / anon", { skip }, async () => {
  // ⚠️ כל שבע הרשאות הטבלה ולא ארבע ה-DML בלבד: REVOKE שהוצר ל-DML היה משאיר TRUNCATE
  // (ש-RLS אינו מכסה), REFERENCES ו-TRIGGER — וזה בדיוק השארית שנמדדה בייצור.
  const r = await sup(`
    SELECT t || ':' || r || ':' || p AS k FROM unnest($1::text[]) t, unnest(ARRAY['anon','authenticated','service_role']) r,
           unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
     WHERE has_table_privilege(r, t, p)
    UNION ALL
    SELECT t || ':' || r || ':col-' || p FROM unnest($1::text[]) t, unnest(ARRAY['anon','authenticated','service_role']) r,
           unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
     WHERE has_any_column_privilege(r, t, p)
    UNION ALL
    SELECT pg_get_serial_sequence(t, 'id') || ':' || r || ':' || p FROM unnest($1::text[]) t,
           unnest(ARRAY['anon','authenticated','service_role']) r, unnest(ARRAY['USAGE','SELECT','UPDATE']) p
     WHERE t <> 'inspection_machines' AND has_sequence_privilege(r, pg_get_serial_sequence(t, 'id'), p)`, [TABLES]);
  assert.deepEqual(r, []);
  // המודל של Supabase באמת פעיל — אחרת כל השורות למעלה ריקות מסיבה אחרת
  const d = await sup(`SELECT count(*)::int n FROM pg_default_acl a JOIN pg_namespace n ON n.oid = a.defaclnamespace
                        WHERE n.nspname = 'public'`);
  assert.ok(d[0].n >= 3, "ALTER DEFAULT PRIVILEGES של Supabase חסר בהרצה המקומית");
  const ctl = await sup(`SELECT has_table_privilege('authenticated', 'public.sites', 'TRUNCATE') x`);
  assert.equal(ctl[0].x, true, "בקרה: טבלה שלא ננעלה מקבלת את ברירת המחדל — המודל עובד");
  const rls = await sup(`SELECT relname FROM pg_class WHERE relname = ANY($1) AND NOT relrowsecurity`, [TABLES]);
  assert.deepEqual(rls, []);
  const pol = await sup(`SELECT tablename FROM pg_policies WHERE tablename = ANY($1)`, [TABLES]);
  assert.deepEqual(pol, [], "D2: אין אף מדיניות על הטבלאות הסגורות");
});

test("4 · סוכן, מושבת וזהות הקליטה: site_compliance ריק, וכל RPC נדחה ב-42501", { skip }, async () => {
  const s = await newSite();
  const mine = await rpc(MGR, `SELECT site_id FROM public.site_compliance(NULL)`);
  assert.ok(mine.length > 0, "מנהל אמור לראות אתרים");
  for (const uid of [AGT, OFF, INT]) {
    assert.equal((await rpc(uid, `SELECT site_id FROM public.site_compliance(NULL)`)).length, 0, `uid ${uid}`);
    await fails(rpc(uid, `SELECT public.inspection_site($1)`, [s.code]), "42501");
    await fails(rpc(uid, `SELECT public.inspection_defect_photo_add(1, '{}'::jsonb, $1::uuid)`, [uuid()]), "42501");
    await fails(rpc(uid, `SELECT * FROM public.inspection_defect_done(1, 'שם', NULL, $1::uuid)`, [uuid()]), "42501");
    await fails(rpc(uid, `SELECT * FROM public.pm_visit_start($1)`, [s.code]), "42501");
    await fails(rpc(uid, `SELECT public.pm_visit_item_check(1, true)`), "42501");
  }
  // ⚠️ כל RPC ציבורי של הלשוניות — מתוך pg_proc, לא רשימה ידנית. רשימה ידנית החמיצה
  // את compliance_file (הדלת היחידה ל-data_b64), compliance_history_list (גוף ליקוי,
  // סיבות) ו-compliance_thumbs: החלפת השער שלהן ב-actor_display_name() שרדה את כל החבילה.
  const fns = await sup(`
    SELECT p.proname, ARRAY(SELECT format_type(t.oid, NULL) FROM unnest(p.proargtypes) WITH ORDINALITY t(oid, o)
                            ORDER BY t.o) AS types
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND (p.proname LIKE 'inspection\\_%' OR p.proname LIKE 'pm\\_%'
        OR p.proname LIKE 'compliance\\_%') ORDER BY p.proname`);
  assert.ok(fns.length >= 30, `נמצאו רק ${fns.length} פונקציות`);
  for (const f of ["compliance_file", "compliance_thumbs", "compliance_history_list", "pm_site", "pm_visit_detail"]) {
    assert.ok(fns.some((x) => x.proname === f), `חסרה ${f}`);
  }
  for (const uid of [AGT, OFF, INT]) {
    for (const f of fns) {
      const args = f.types.map((t) => `NULL::${t}`).join(", ");
      await fails(rpc(uid, `SELECT * FROM public.${f.proname}(${args})`), "42501");
    }
  }
});

test("5 · בקר: כל RPC של מנהל נדחה ב-42501", { skip }, async () => {
  const s = await newSite();
  const calls = [
    [`SELECT * FROM public.inspection_upload($1, '{}'::jsonb)`, [s.code]],
    [`SELECT public.inspection_report_update(1, '{}'::jsonb, NULL)`],
    [`SELECT public.inspection_report_delete(1, 'סיבה')`],
    [`SELECT public.inspection_machine_retire($1, '1', 'סיבה')`, [s.code]],
    [`SELECT public.inspection_defect_save(1, NULL, 'גוף', false, NULL)`],
    [`SELECT public.inspection_defect_delete(1, 'סיבה')`],
    [`SELECT public.inspection_close_by_report(1, 'סיבה')`],
    [`SELECT public.inspection_defect_reopen(1, 'סיבה')`],
    [`SELECT public.pm_template_save('[]'::jsonb)`],
    [`SELECT * FROM public.pm_historical_upload($1, '{}'::jsonb, '{}'::jsonb)`, [s.code]],
    [`SELECT public.pm_visit_delete(1, 'סיבה')`],
    [`SELECT * FROM public.compliance_storage()`],
    [`SELECT * FROM public.compliance_orphans()`],
    [`SELECT public.compliance_reattach('x', $1)`, [s.code]],
    [`SELECT public.compliance_purge('pm_visit', 1, 'סיבה')`],
  ];
  for (const [sql, params] of calls) await fails(rpc(OPR, sql, params ?? []), "42501");
});

// ================================================================
// העלאה ותוקף
// ================================================================

test("7 · תוקף: חובה בתקופתי; 'document' רק כשהתאריך זהה למפוענח (D25)", { skip }, async () => {
  const s = await newSite();
  await fails(periodic(s, { valid: null }), "23514", /תאריך התוקף/);
  const v = addDays(TODAY, 300);
  const parsed = (validUntil, validitySource = "document") =>
    ({ parser: "t", parsed: { inspectedAt: addDays(TODAY, -10), validUntil, validitySource } });
  const src = async (r) => (await sup(`SELECT validity_source FROM inspection_reports WHERE id=$1`, [r.report_id]))[0].validity_source;
  assert.equal(await src(await periodic(s, { valid: v, parse: parsed(v) })), "document");
  assert.equal(await src(await periodic(s, { valid: v, parse: parsed(addDays(v, 1)) })), "manual");
  assert.equal(await src(await periodic(s, { valid: v, parse: parsed(v, "next_inspection") })), "next_inspection");
  assert.equal(await src(await periodic(s, { valid: v, parse: parsed(addDays(v, -3), "next_inspection") })), "manual");
  assert.equal(await src(await periodic(s, { valid: v })), "manual");
});

test("8 · בדיקה חוזרת יורשת (NULL), ועריכת תאריך האב כלפי מטה צובעת את האתר אדום", { skip }, async () => {
  const s = await newSite();
  const p = await periodic(s, { insp: addDays(TODAY, -400), valid: addDays(TODAY, 100) });
  const f = await followup(s, p.report_id, { insp: addDays(TODAY, -10) });
  const fr = (await sup(`SELECT valid_until, validity_source FROM inspection_reports WHERE id=$1`, [f.report_id]))[0];
  assert.deepEqual(fr, { valid_until: null, validity_source: "inherited" });
  assert.equal((await status(s.id)).s, "ok");
  await rpc(MGR, `SELECT public.inspection_report_update($1, $2::jsonb, NULL)`,
    [p.report_id, JSON.stringify({ valid_until: addDays(TODAY, -1) })]);
  const st = await status(s.id);
  assert.deepEqual({ s: st.s, vu: st.vu }, { s: "expired", vu: addDays(TODAY, -1) });
  await fails(followup(s, p.report_id, { insp: addDays(TODAY, -401) }), "23514", /לפני התסקיר התקופתי/);
  const late = await followup(s, p.report_id, { insp: TODAY });
  assert.equal(late.valid_until, null, "בדיקה חוזרת מאוחרת (אחרי פקיעה) מתקבלת, בלי תוקף");
});

test("9 · בדיקה מחדש קצרה יותר מחליפה את המאוחרת — התוקף הוא האחרון, לא המקסימום", { skip }, async () => {
  const s = await newSite();
  await periodic(s, { insp: addDays(TODAY, -300), valid: addDays(TODAY, 65) });
  await periodic(s, { insp: addDays(TODAY, -10), valid: addDays(TODAY, 40) });
  assert.equal((await status(s.id)).vu, addDays(TODAY, 40));
});

test("10 · דחיות העלאה", { skip }, async () => {
  const s = await newSite();
  await fails(periodic(s, { file: png() }), "23514", /אינו תואם/);
  await fails(periodic(s, { file: pdf() + "!" }), "23514", /קידוד/);
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('compliance_pdf_max_bytes','100','x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await fails(periodic(s, { file: pdf(400) }), "23514", /גדול מדי/);
  await sup(`DELETE FROM settings WHERE key = 'compliance_pdf_max_bytes'`);
  await fails(sup(`INSERT INTO inspection_files (site_id, site_code, mime, data_b64, byte_size, content_md5, uploaded_by, created_at)
                   VALUES ($1, 'x', 'application/pdf', 'JVBERi0' || repeat('A', 13981017), 1, 'm', 'x', 'x')`, [s.id]), "23514");
  const file = pdf();
  await periodic(s, { file, machine: "1" });
  await fails(periodic(s, { file, machine: "1" }), "PT409");
  const files = async () => (await sup(`SELECT count(*)::int n FROM inspection_files WHERE site_id=$1`, [s.id]))[0].n;
  const before = await files();
  const second = await periodic(s, { file, machine: "2" });
  assert.ok(second.report_id);
  assert.equal(await files(), before, "אותו קובץ למתקן שני — אין עותק שני");
  await fails(upload(s.code, { kind: "periodic", inspected_on: addDays(TODAY, -3), valid_until: addDays(TODAY, 300) }),
    "23514", /לאשר במפורש/);
  await fails(upload(s.code, { kind: "periodic", inspected_on: addDays(TODAY, -3), valid_until: addDays(TODAY, 300),
    confirm_clean: true }, { defects: [{ body: "ליקוי" }] }), "23514", /סומן נקי/);
  await fails(periodic(s, { defects: [{ body: "ליקוי א" }, { body: "ליקוי ב", due_on: "not-a-date" }] }), "23514", /ליקוי 2/);
  await fails(periodic(s, { defects: [{ body: "ליקוי א", urgent: "maybe" }] }), "23514", /ליקוי 1/);
});

test("11 · replay: אותו client_id פעמיים — תסקיר אחד, והשני replayed", { skip }, async () => {
  const s = await newSite();
  const meta = { client_id: uuid(), kind: "periodic", inspected_on: addDays(TODAY, -5), valid_until: addDays(TODAY, 300),
    confirm_clean: true };
  const file = pdf();
  const a = await upload(s.code, meta, { file });
  const b = await upload(s.code, meta, { file });
  assert.deepEqual({ id: b.report_id, replayed: b.replayed }, { id: a.report_id, replayed: true });
  assert.equal(a.replayed, false);
  assert.equal((await sup(`SELECT count(*)::int n FROM inspection_reports WHERE site_id=$1`, [s.id]))[0].n, 1);
});

test("12 · שני מתקנים: אחד פג → האתר אדום; retire → ירוק; העלאה מחזירה; מחיקה אחרונה מוחקת מתקן", { skip }, async () => {
  const s = await newSite();
  await periodic(s, { machine: "A", insp: addDays(TODAY, -10), valid: addDays(TODAY, 200) });
  const b1 = await periodic(s, { machine: "B", insp: addDays(TODAY, -400), valid: addDays(TODAY, -5) });
  let st = await status(s.id);
  assert.deepEqual({ s: st.s, m: st.m }, { s: "expired", m: 2 });
  await rpc(MGR, `SELECT public.inspection_machine_retire($1, 'B', 'פורק')`, [s.code]);
  st = await status(s.id);
  assert.deepEqual({ s: st.s, m: st.m }, { s: "ok", m: 1 });
  const b2 = await periodic(s, { machine: "B", insp: addDays(TODAY, -1), valid: addDays(TODAY, 300) });
  st = await status(s.id);
  assert.deepEqual({ s: st.s, m: st.m }, { s: "ok", m: 2 });
  await rpc(MGR, `SELECT public.inspection_report_delete($1, 'הועלה בטעות')`, [b2.report_id]);
  await rpc(MGR, `SELECT public.inspection_report_delete($1, 'הועלה בטעות')`, [b1.report_id]);
  const ms = await sup(`SELECT machine_key FROM inspection_machines WHERE site_id=$1 ORDER BY 1`, [s.id]);
  assert.deepEqual(ms.map((x) => x.machine_key), ["A"]);
});

// ================================================================
// ליקויים
// ================================================================

let T13; // { s, r, d1, d2, p1 } — משמש גם את 14
test("13 · בוצע: PNG נדחה; JPEG ואז בוצע; replay; בקשה אחרת → PT409", { skip }, async () => {
  const s = await newSite();
  const r = await periodic(s, { defects: [{ body: "מעקה רופף" }, { body: "שלט חסר" }] });
  const [d1, d2] = await defectsOf(r.report_id);
  await fails(stagePhoto(OPR, d1.id, png(), uuid(), "image/png"), "23514", /סוג קובץ/);
  const client = uuid();
  const p1 = await stagePhoto(OPR, d1.id, jpg(), client);
  assert.equal(await stagePhoto(OPR, d1.id, jpg(), client), p1, "replay של תמונה מחזיר את אותה שורה");
  assert.equal((await sup(`SELECT count(*)::int n FROM inspection_defect_photos WHERE defect_id=$1`, [d1.id]))[0].n, 1);
  const req = uuid();
  assert.deepEqual(await done(OPR, d1.id, req), { defect_id: d1.id, photos: 1, replayed: false });
  assert.equal((await defectsOf(r.report_id))[0].status, "done");
  assert.equal((await done(OPR, d1.id, req)).replayed, true);
  await fails(done(OPR, d1.id, uuid()), "PT409");
  T13 = { s, r, d1: d1.id, d2: d2.id, p1 };
});

test("14 · ערבויות המסד, גם מול superuser", { skip }, async () => {
  const { r, d1, d2, p1 } = T13;
  const setDone = (id, extra) => sup(`UPDATE inspection_defects SET status='done', done_at='x', done_by='x',
                                       done_by_name='שם מלא' ${extra} WHERE id=$1`, [id]);
  await fails(sup(`UPDATE inspection_defects SET status='done', done_at='x', done_by='x' WHERE id=$1`, [d2]), "23514"); // בלי שם המבצע
  const own = (await sup(`INSERT INTO inspection_defect_photos (client_id, defect_id, closure_no, mime, data_b64, byte_size, uploaded_by, created_at)
                          VALUES ($1, $2, 1, 'image/jpeg', $3, 10, 'x', 'x') RETURNING id::int`, [uuid(), d2, jpg()]))[0].id;
  await fails(setDone(d2, `, done_photo_id=${own}, closed_by_report_id=${r.report_id}`), "23514"); // שתי ראיות
  await fails(setDone(d2, `, done_photo_id=${p1}`), "23503");                                   // תמונה של ליקוי אחר
  await rpc(MGR, `SELECT public.inspection_defect_reopen($1, 'לא תוקן')`, [d1]);
  await fails(setDone(d1, `, done_photo_id=${p1}`), "23503");                                   // תמונה מסגירה קודמת
  await done(OPR, d2);                                                                           // d2 נסגר בתמונה own
  await assert.rejects(sup(`DELETE FROM inspection_defect_photos WHERE id=$1`, [own]));        // הראיה אינה נמחקת
  await fails(sup(`UPDATE inspection_defect_photos SET mime = mime WHERE id=$1`, [p1]), "23514", /אינה ניתנת לשינוי/);
  await fails(sup(`DELETE FROM inspection_defect_photos WHERE id=$1`, [p1]), "23514", /סגירה קודמת/);
  await fails(sup(`INSERT INTO inspection_defect_photos (client_id, defect_id, closure_no, mime, data_b64, byte_size, uploaded_by, created_at)
                   VALUES ($1, $2, 2, 'image/jpeg', $3, 10, 'x', 'x')`, [uuid(), d1, webp()]), "23514");
});

test("15 · פתיחה מחדש: closure_no=2, תמונות ישנות נשמרות כהיסטוריה; 3 לסגירה, 12 לליקוי", { skip }, async () => {
  const s = await newSite();
  const r = await periodic(s, { defects: [{ body: "דלת חירום" }] });
  const [d] = await defectsOf(r.report_id);
  await closeByPhoto(d.id);
  await rpc(MGR, `SELECT public.inspection_defect_reopen($1, 'הבודק דחה')`, [d.id]);
  const row = (await defectsOf(r.report_id))[0];
  assert.deepEqual({ st: row.status, cl: row.closure_no }, { st: "open", cl: 2 });
  const thumbs = (k) => rpc(OPR, `SELECT id::int FROM public.compliance_thumbs($1, $2)`, [k, d.id]);
  assert.equal((await thumbs("defect")).length, 0);
  assert.equal((await thumbs("defect_history")).length, 1);
  for (let i = 0; i < 3; i++) await stagePhoto(OPR, d.id);
  await fails(stagePhoto(OPR, d.id), "23514", /עד 3/);
  // 4 עד כאן. עוד שלוש סגירות מלאות ועוד שתיים → 12, והשלוש-עשרה נדחית
  for (let c = 0; c < 3; c++) {
    await done(OPR, d.id);
    await rpc(MGR, `SELECT public.inspection_defect_reopen($1, 'שוב')`, [d.id]);
    for (let i = 0; i < (c < 2 ? 3 : 2); i++) await stagePhoto(OPR, d.id);
  }
  assert.equal((await sup(`SELECT count(*)::int n FROM inspection_defect_photos WHERE defect_id=$1`, [d.id]))[0].n, 12);
  await fails(stagePhoto(OPR, d.id), "23514", /המרבי/);
});

test("16 · סגירה בתסקיר חוזר נקי: כל הליקויים הפתוחים במחזור → done עם closed_by_report_id", { skip }, async () => {
  const s = await newSite();
  const p = await periodic(s, { insp: addDays(TODAY, -30), defects: [{ body: "א" + "1" }, { body: "ב" + "2" }] });
  const dirty = await followup(s, p.report_id, { insp: addDays(TODAY, -20), defects: [{ body: "ליקוי חדש" }] });
  await fails(rpc(MGR, `SELECT public.inspection_close_by_report($1, 'נקי')`, [dirty.report_id]), "23514", /תסקיר חוזר נקי/);
  const clean = await followup(s, p.report_id, { insp: addDays(TODAY, -2), close: true });
  assert.equal(clean.closed, 3);
  const all = [...await defectsOf(p.report_id), ...await defectsOf(dirty.report_id)];
  assert.ok(all.every((d) => d.status === "done" && d.closed_by_report_id === clean.report_id && d.done_photo_id === null));
  assert.equal((await status(s.id)).c, "clean");
  assert.equal(await one(MGR, `SELECT public.inspection_close_by_report($1, 'שוב') n`, [clean.report_id]).then((x) => x.n), 0);
});

// ================================================================
// מצב
// ================================================================

test("17 · מחזור: open → awaiting_clean (צהוב חזק) → clean; מחיקת כל הפתוחים → awaiting_clean", { skip }, async () => {
  const s = await newSite();
  const p = await periodic(s, { insp: addDays(TODAY, -10), valid: addDays(TODAY, 200), defects: [{ body: "גדר" }, { body: "תאורה" }] });
  assert.equal((await status(s.id)).c, "open");
  for (const d of await defectsOf(p.report_id)) await closeByPhoto(d.id);
  let st = await status(s.id);
  assert.deepEqual({ c: st.c, s: st.s, vs: st.vs }, { c: "awaiting_clean", s: "awaiting", vs: "ok" });
  const f = await followup(s, p.report_id, { insp: TODAY });
  st = await status(s.id);
  assert.deepEqual({ c: st.c, s: st.s }, { c: "clean", s: "ok" });
  await fails(rpc(MGR, `SELECT public.inspection_defect_save($1, NULL, 'ליקוי חדש', false, NULL)`, [f.report_id]),
    "23514", /סומן נקי/);

  // ⚠️ M18: "נקי" אינו "אפס שורות". הגוף נושא סימן כדי שבדיקה 6 תוכל לחפש אותו ב-audit_log.
  const s2 = await newSite();
  const p2 = await periodic(s2, { defects: [{ body: "סוד-ליקוי-א" }, { body: "סוד-ליקוי-ב" }] });
  for (const d of await defectsOf(p2.report_id)) {
    await rpc(MGR, `SELECT public.inspection_defect_delete($1, 'הוזן בטעות')`, [d.id]);
  }
  st = await status(s2.id);
  assert.deepEqual({ c: st.c, s: st.s }, { c: "awaiting_clean", s: "awaiting" }, "ליקוי שנרשם — גם אם נמחק — מחייב תסקיר נקי");
});

test("18 · ספים: +31 ok, +30 soon, +0 soon, −1 expired; go-live; PM; סוף חודש", { skip }, async () => {
  const s = await newSite();
  const V = addDays(TODAY, 100);
  await periodic(s, { insp: addDays(TODAY, -10), valid: V });
  assert.equal((await status(s.id, addDays(V, -31))).s, "ok");
  assert.equal((await status(s.id, addDays(V, -30))).s, "soon");
  assert.equal((await status(s.id, V)).s, "soon");
  assert.equal((await status(s.id, addDays(V, 1))).s, "expired");
  assert.equal((await status(s.id, addDays(V, -30))).dl, 30);

  const empty = await newSite();
  let st = await status(empty.id);
  assert.deepEqual({ s: st.s, miss: st.miss, ps: st.ps, pmiss: st.pmiss }, { s: "none", miss: true, ps: "none", pmiss: true });
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('compliance_go_live', $1, 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [addDays(TODAY, -1)]);
  st = await status(empty.id);
  assert.deepEqual({ s: st.s, miss: st.miss, ps: st.ps }, { s: "expired", miss: true, ps: "expired" });
  await sup(`DELETE FROM settings WHERE key = 'compliance_go_live'`);

  const pm = await newSite();
  await one(MGR, `SELECT visit_id FROM public.pm_historical_upload($1, $2::jsonb, $3::jsonb)`,
    [pm.code, JSON.stringify({ client_id: uuid(), performed_on: addDays(TODAY, -10) }),
      JSON.stringify({ mime: "application/pdf", data: pdf() })]);
  const D = (await status(pm.id)).pdue;
  assert.equal((await status(pm.id, addDays(D, -31))).ps, "ok");
  assert.equal((await status(pm.id, addDays(D, -30))).ps, "soon");
  assert.equal((await status(pm.id, addDays(D, 1))).ps, "expired");

  const me = await newSite();
  await sup(`INSERT INTO pm_visits (site_id, site_code, source, status, performed_on, started_by, started_at, last_activity_at)
             VALUES ($1, $2, 'historical', 'submitted', '2026-08-31', 'x', 'x', 'x')`, [me.id, me.code]);
  assert.equal((await status(me.id)).pdue, "2027-02-28");
});

test("19 · 'היום' הוא היום בישראל: 22:30Z ב-04/10 הוא 05/10", { skip }, async () => {
  const r = await sup(`SELECT app.compliance_today_at('2026-10-04 22:30Z')::text d`);
  assert.equal(r[0].d, "2026-10-05");
});

test("20 · מחיקה רכה: חזרה לתקופתי הקודם; קובץ של תסקיר שנמחק — PT404 לבקר, קריא למנהל; purge", { skip }, async () => {
  const s = await newSite();
  const a = await periodic(s, { insp: addDays(TODAY, -400), valid: addDays(TODAY, 50) });
  const b = await periodic(s, { insp: addDays(TODAY, -5), valid: addDays(TODAY, 300) });
  assert.equal((await status(s.id)).vu, addDays(TODAY, 300));
  await rpc(MGR, `SELECT public.inspection_report_delete($1, 'מסמך שגוי')`, [b.report_id]);
  assert.equal((await status(s.id)).vu, addDays(TODAY, 50));
  await followup(s, a.report_id, { insp: addDays(TODAY, -3) });
  await fails(rpc(MGR, `SELECT public.inspection_report_delete($1, 'מסמך שגוי')`, [a.report_id]), "23514", /בדיקות חוזרות/);
  const file = (fk, uid) => rpc(uid, `SELECT mime, data_b64 FROM public.compliance_file('inspection_pdf', $1)`, [fk]);
  await fails(file(b.file_id, OPR), "PT404");
  assert.equal((await file(b.file_id, MGR)).length, 1);
  assert.equal((await one(MGR, `SELECT public.compliance_purge('inspection_file', $1, 'ניקוי נפח') n`, [b.file_id])).n, 1);
  await fails(file(b.file_id, MGR), "PT404");
  assert.equal((await sup(`SELECT data_b64 FROM inspection_files WHERE id=$1`, [b.file_id]))[0].data_b64, "JVBERi0=");
  const hist = await one(MGR, `SELECT public.compliance_history_list($1) h`, [s.code]);
  assert.ok(hist.h.some((x) => x.action === "purge" && x.reason === "ניקוי נפח"), JSON.stringify(hist.h));
});

test("21 · delete_site: התסקירים שורדים; orphans; reattach; שינוי קוד — אירועים בקוד החדש", { skip }, async () => {
  const s = await newSite();
  const r = await periodic(s);
  await rpc(MGR, `SELECT * FROM public.delete_site($1)`, [s.code]);
  assert.equal((await sup(`SELECT site_id FROM inspection_reports WHERE id=$1`, [r.report_id]))[0].site_id, null);
  const orphans = await rpc(MGR, `SELECT site_code, reports FROM public.compliance_orphans()`);
  assert.ok(orphans.some((o) => o.site_code === s.code && o.reports === 1), JSON.stringify(orphans));
  const t = await newSite();
  const ev0 = await compEvents(t.code);
  const n = await one(MGR, `SELECT public.compliance_reattach($1, $2) n`, [s.code, t.code]);
  assert.ok(n.n >= 2);
  assert.equal(await compEvents(t.code), ev0 + 1, "reattach מפרסם אירוע באתר היעד");
  assert.equal((await sup(`SELECT site_id FROM inspection_reports WHERE id=$1`, [r.report_id]))[0].site_id, t.id);
  assert.equal((await status(t.id)).m, 1, "שורת המתקן שוחזרה");
  const newCode = `${t.code}X`;
  await rpc(MGR, `SELECT * FROM public.update_site($1, $2)`, [t.code, newCode]);
  await rpc(MGR, `SELECT public.inspection_report_update($1, '{"note":"אחרי שינוי קוד"}'::jsonb, NULL)`, [r.report_id]);
  const ev = (await sup(`SELECT site_code, payload FROM events WHERE type='compliance' ORDER BY id DESC LIMIT 1`))[0];
  assert.deepEqual({ c: ev.site_code, p: ev.payload.code }, { c: newCode, p: newCode });
});

// ================================================================
// תחזוקה מונעת
// ================================================================

test("22 · רשימה ריקה → אין פתיחה; פתיחה מצלמת 3 פריטים; טיוטה אחת; התחלה מחדש", { skip }, async () => {
  const s = await newSite();
  await fails(startVisit(OPR, s.code), "23514", /ריקה/);
  await fails(rpc(MGR, `SELECT public.pm_template_save($1::jsonb)`,
    [JSON.stringify([{ label: "צילום רשות", kind: "photo", required: false, min_photos: 1 }])]), "23514", /רשות/);
  await fails(sup(`INSERT INTO pm_checklist_items (seq, label, kind, required, min_photos, updated_at, updated_by)
                   VALUES (1, 'רשות', 'photo', false, 1, 'x', 'x')`), "23514");
  const n = await one(MGR, `SELECT public.pm_template_save($1::jsonb) n`, [JSON.stringify([
    { label: "בדיקת שמן", kind: "check", required: true },
    { label: "צילום לוח", kind: "photo", required: true, min_photos: 2 },
    { label: "צילום רשות", kind: "check_photo", required: false, min_photos: 0 },
  ])]);
  assert.equal(n.n, 3);
  const v = await startVisit(OPR, s.code);
  assert.equal(v.created, true);
  assert.equal((await visitItems(v.visit_id)).length, 3);
  assert.deepEqual(await startVisit(OPR, s.code), { visit_id: v.visit_id, created: false });
  await fails(sup(`INSERT INTO pm_visits (site_id, site_code, source, status, started_by, started_at, last_activity_at)
                   VALUES ($1, $2, 'dashboard', 'draft', 'x', 'x', 'x')`, [s.id, s.code]), "23505");
  await fails(startVisit(OPR2, s.code, true), "42501");
  await sup(`UPDATE pm_visits SET last_activity_at = to_char((now() - interval '49 hours') AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE id = $1`, [v.visit_id]);
  const again = await startVisit(OPR2, s.code, true);
  assert.equal(again.created, true);
  assert.notEqual(again.visit_id, v.visit_id);
});

test("23 · item_check שומר את ההערה; item_note שומר את הוי", { skip }, async () => {
  const s = await newSite();
  const v = await startVisit(OPR, s.code);
  const [i] = await visitItems(v.visit_id);
  await rpc(OPR, `SELECT public.pm_visit_item_check($1, true)`, [i.id]);
  await rpc(OPR, `SELECT public.pm_visit_item_note($1, 'שמן תקין')`, [i.id]);
  let row = (await visitItems(v.visit_id))[0];
  assert.deepEqual({ c: row.checked, n: row.note }, { c: true, n: "שמן תקין" });
  await rpc(OPR, `SELECT public.pm_visit_item_check($1, false)`, [i.id]);
  row = (await visitItems(v.visit_id))[0];
  assert.deepEqual({ c: row.checked, n: row.note }, { c: false, n: "שמן תקין" });
});

let T24; // { s, visit, items } — הביקור שהוגש; משמש את 25
test("24 · הגשה: פריטים חסרים, חתימה, תאריך, replay, טיוטה בת 8 ימים", { skip }, async () => {
  const s = await newSite();
  const v = await startVisit(OPR, s.code);
  const [chk, photo, opt] = await visitItems(v.visit_id);
  await fails(submit(OPR, v.visit_id), "23514", /בדיקת שמן.*צילום לוח/);
  await assert.rejects(submit(OPR, v.visit_id), (e) => !/צילום רשות/.test(e.message));
  await rpc(OPR, `SELECT public.pm_visit_item_check($1, true)`, [chk.id]);
  await pmPhoto(OPR, photo.id);
  await assert.rejects(submit(OPR, v.visit_id), (e) => /צילום לוח/.test(e.message) && !/בדיקת שמן/.test(e.message));
  await pmPhoto(OPR, photo.id);
  await fails(submit(OPR, v.visit_id, { sig: null }), "23514", /חתימה/);
  await fails(submit(OPR, v.visit_id, { sig: { mime: "image/jpeg", data: jpg() } }), "23514", /סוג קובץ/);
  await fails(submit(OPR, v.visit_id, { name: "א" }), "23514", /שם המבצע/);
  const req = uuid();
  const r = await submit(OPR, v.visit_id, { req });
  assert.equal(r.performed_on, TODAY);
  const due = (await sup(`SELECT ($1::date + interval '6 months')::date::text d`, [TODAY]))[0].d;
  assert.deepEqual({ due: r.next_due_on, rp: r.replayed }, { due, rp: false });
  assert.equal((await status(s.id)).pdue, due);
  assert.equal((await submit(OPR, v.visit_id, { req })).replayed, true);
  await fails(submit(OPR, v.visit_id), "PT409", /כבר הוגש/);
  assert.equal(opt.required, false);
  // ⚠️ items_done סופר גם פריט צילום (אין לו וי) — ביקור שלם אינו "1/3"; ו-me הוא
  // השם שהשרת כותב ב-submitted_by, כדי שהטופס יזהה עריכה של המשתמש עצמו.
  const pm = await one(OPR, `SELECT public.pm_site($1) j`, [s.code]);
  const sv = pm.j.visits.find((x) => x.id === Number(v.visit_id));
  // שמן (וי) + לוח (2 תמונות) בוצעו; "צילום רשות" (וי+תמונה, רשות) לא מולא — 2 מתוך 3
  assert.deepEqual({ total: sv.items_total, checked: sv.items_checked, done: sv.items_done }, { total: 3, checked: 1, done: 2 });
  assert.equal(pm.j.me, sv.submitted_by);
  T24 = { s, visit: v.visit_id, items: [chk, photo, opt] };

  const old = await newSite();
  const ov = await startVisit(OPR, old.code);
  const [c2, p2] = await visitItems(ov.visit_id);
  await rpc(OPR, `SELECT public.pm_visit_item_check($1, true)`, [c2.id]);
  await pmPhoto(OPR, p2.id);
  await pmPhoto(OPR, p2.id);
  await sup(`UPDATE pm_visits SET started_at = to_char((now() - interval '8 days') AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE id = $1`, [ov.visit_id]);
  await fails(submit(OPR, ov.visit_id), "23514", /לפני יותר משבוע/);
});

test("25 · ביקור שהוגש אינו משתנה — גם לא ב-superuser; PDF היסטורי פעם אחת", { skip }, async () => {
  const { visit, items: [chk, photo] } = T24;
  const fid = (await sup(`SELECT id::int FROM pm_files WHERE visit_id=$1 LIMIT 1`, [visit]))[0].id;
  const blocked = /הביקור כבר הוגש/;
  await fails(sup(`INSERT INTO pm_visit_items (visit_id, seq, label, kind, required, min_photos)
                   VALUES ($1, 9, 'חדש', 'check', false, 0)`, [visit]), "23514", blocked);
  await fails(sup(`UPDATE pm_visit_items SET checked = false WHERE id=$1`, [chk.id]), "23514", blocked);
  await fails(sup(`DELETE FROM pm_visit_items WHERE id=$1`, [chk.id]), "23514", blocked);
  await fails(sup(`INSERT INTO pm_files (client_id, visit_id, visit_item_id, kind, mime, data_b64, byte_size, uploaded_by, created_at)
                   VALUES ($1, $2, $3, 'photo', 'image/jpeg', $4, 10, 'x', 'x')`, [uuid(), visit, photo.id, jpg()]), "23514", blocked);
  await fails(sup(`UPDATE pm_files SET file_name = 'x' WHERE id=$1`, [fid]), "23514", blocked);
  await fails(sup(`DELETE FROM pm_files WHERE id=$1`, [fid]), "23514", blocked);

  const hs = await newSite();
  const hv = (await sup(`INSERT INTO pm_visits (site_id, site_code, source, status, performed_on, started_by, started_at, last_activity_at)
                         VALUES ($1, $2, 'historical', 'submitted', $3, 'x', 'x', 'x') RETURNING id::int`,
  [hs.id, hs.code, addDays(TODAY, -40)]))[0].id;
  const ins = () => sup(`INSERT INTO pm_files (visit_id, kind, mime, data_b64, byte_size, uploaded_by, created_at)
                         VALUES ($1, 'pdf', 'application/pdf', $2, 10, 'x', 'x')`, [hv, pdf()]);
  await ins();
  await fails(ins(), "23514", blocked);

  await fails(rpc(OPR, `SELECT public.pm_visit_item_check($1, false)`, [chk.id]), "23514", blocked);
  await fails(rpc(OPR, `SELECT public.pm_visit_item_note($1, 'x')`, [chk.id]), "23514", blocked);
  await fails(pmPhoto(OPR, photo.id), "23514", blocked);
  await fails(rpc(OPR, `SELECT public.pm_visit_photo_delete($1)`, [fid]), "23514", blocked);
});

test("26 · תקרות: תמונה שביעית לפריט נדחית; replay של תמונה; הוגש בלי חתימה — CHECK", { skip }, async () => {
  const s = await newSite();
  const v = await startVisit(OPR, s.code);
  const opt = (await visitItems(v.visit_id))[2];
  for (let i = 0; i < 6; i++) await pmPhoto(OPR, opt.id);
  await fails(pmPhoto(OPR, opt.id), "23514", /עד 6/);
  const chk = (await visitItems(v.visit_id))[1];
  const c = uuid();
  const a = await pmPhoto(OPR, chk.id, c);
  assert.equal(await pmPhoto(OPR, chk.id, c), a);
  assert.equal((await sup(`SELECT count(*)::int n FROM pm_files WHERE client_id=$1`, [c]))[0].n, 1);
  const s2 = await newSite();
  await fails(sup(`INSERT INTO pm_visits (site_id, site_code, source, status, performed_on, performer_name, started_by,
                                          started_at, last_activity_at, submitted_at)
                   VALUES ($1, $2, 'dashboard', 'submitted', $3, 'טכנאי', 'x', 'x', 'x', 'x')`,
  [s2.id, s2.code, TODAY]), "23514");
});

test("27 · העלאה היסטורית נספרת; ביטול טיוטה — לא ע\"י מי שלא פתח, כן ע\"י הפותח", { skip }, async () => {
  const s = await newSite();
  const file = pdf();
  const meta = { client_id: uuid(), performed_on: addDays(TODAY, -20) };
  const up = (m) => one(MGR, `SELECT visit_id::int, replayed FROM public.pm_historical_upload($1, $2::jsonb, $3::jsonb)`,
    [s.code, JSON.stringify(m), JSON.stringify({ mime: "application/pdf", data: file })]);
  const a = await up(meta);
  assert.equal((await up(meta)).replayed, true);
  await fails(up({ ...meta, client_id: uuid() }), "PT409", new RegExp(`ביקור ${a.visit_id}`));
  const st = await status(s.id);
  assert.deepEqual({ last: st.plast, vid: st.pvid }, { last: addDays(TODAY, -20), vid: a.visit_id });

  const v = await startVisit(OPR, s.code);
  await fails(rpc(OPR2, `SELECT public.pm_visit_discard($1, 'לא שלי')`, [v.visit_id]), "42501");
  await rpc(OPR, `SELECT public.pm_visit_discard($1, 'נפתח בטעות')`, [v.visit_id]);
  assert.equal((await sup(`SELECT count(*)::int n FROM pm_visits WHERE id=$1`, [v.visit_id]))[0].n, 0);
});

// ================================================================
// תופעות לוואי והיגיינה
// ================================================================

test("28 · אירועי compliance: אחרי upload, done, submit, retire — ולא אחרי שמירת טיוטה או צילום", { skip }, async () => {
  const s = await newSite();
  let n = await compEvents(s.code);
  const r = await periodic(s, { defects: [{ body: "ליקוי לאירוע" }], machine: "1" });
  assert.equal(await compEvents(s.code), ++n, "upload");
  const [d] = await defectsOf(r.report_id);
  await stagePhoto(OPR, d.id);
  assert.equal(await compEvents(s.code), n, "defect_photo_add — בלי אירוע");
  await done(OPR, d.id);
  assert.equal(await compEvents(s.code), ++n, "done");
  // ⚠️ פתיחה וזריקה של טיוטה משנות את pm_draft_id בשורת הכרטיס — ולכן מפרסמות (D20)
  const v0 = await startVisit(OPR, s.code);
  assert.equal(await compEvents(s.code), ++n, "visit_start");
  assert.equal((await startVisit(OPR, s.code)).created, false);
  assert.equal(await compEvents(s.code), n, "פתיחה שמחזירה טיוטה קיימת — בלי אירוע");
  await rpc(OPR, `SELECT public.pm_visit_discard($1, 'נפתח בטעות')`, [v0.visit_id]);
  assert.equal(await compEvents(s.code), ++n, "visit_discard");
  await startVisit(OPR, s.code);
  n++;
  const v = await startVisit(OPR, s.code, true);
  n += 2;
  assert.equal(await compEvents(s.code), n, "התחלה מחדש = זריקה + פתיחה");
  const [chk, photo] = await visitItems(v.visit_id);
  await rpc(OPR, `SELECT public.pm_visit_item_check($1, true)`, [chk.id]);
  await rpc(OPR, `SELECT public.pm_visit_item_note($1, 'הערה')`, [chk.id]);
  await pmPhoto(OPR, photo.id);
  await pmPhoto(OPR, photo.id);
  assert.equal(await compEvents(s.code), n, "item_check / item_note / photo_add — בלי אירוע");
  await submit(OPR, v.visit_id);
  assert.equal(await compEvents(s.code), ++n, "submit");
  await rpc(MGR, `SELECT public.inspection_machine_retire($1, '1', 'פורק')`, [s.code]);
  assert.equal(await compEvents(s.code), ++n, "retire");
});

// ================================================================
// רגרסיות מהסקירה — כל אחת נכתבה מול פגם שנמצא, וכל אחת נכשלת בלי התיקון שלה
// ================================================================

const setSetting = (k, v) => sup(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, 'x')
                                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
const delSetting = (k) => sup(`DELETE FROM settings WHERE key = $1`, [k]);
/** כמו rpc, עם תביעות נוספות באסימון (aal). */
const asClaims = (uid, claims, sql, params = []) => h.pg.transaction(async (tx) => {
  await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: uid, role: "authenticated", ...claims })]);
  await tx.query(`SET LOCAL ROLE authenticated`);
  return (await tx.query(sql, params)).rows;
});
const reportRow = async (id) => (await sup(
  `SELECT machine_key, followup_of::int, validity_source, valid_until::text FROM inspection_reports WHERE id=$1`, [id]))[0];

test("31 · מחיקת תסקיר חוזר נקי שסגר ליקויים פותחת אותם מחדש; כך גם ביטול 'נקי' (D8/D24)", { skip }, async () => {
  const s = await newSite();
  const p = await periodic(s, { insp: addDays(TODAY, -30), defects: [{ body: "מעקה שבור" }, { body: "שלט חסר" }] });
  const clean = await followup(s, p.report_id, { insp: addDays(TODAY, -2), close: true });
  assert.equal(clean.closed, 2);
  assert.equal((await status(s.id)).c, "clean");
  await rpc(MGR, `SELECT public.inspection_report_delete($1, 'הועלה לאתר הלא נכון')`, [clean.report_id]);
  const after = await defectsOf(p.report_id);
  assert.deepEqual(after.map((d) => [d.status, d.closure_no, d.closed_by_report_id]), [["open", 2, null], ["open", 2, null]]);
  assert.equal((await status(s.id)).c, "open");
  const hist = await one(MGR, `SELECT public.compliance_history_list($1) h`, [s.code]);
  assert.ok(hist.h.some((x) => x.action === "reopen_cycle" && x.reason === "הועלה לאתר הלא נכון"), JSON.stringify(hist.h));
  // אפשר לסגור מחדש בראיה של הסגירה החדשה
  await closeByPhoto(after[0].id);

  // ביטול "נקי" על התסקיר הסוגר
  const clean2 = await followup(s, p.report_id, { insp: addDays(TODAY, -1), close: true });
  assert.equal(clean2.closed, 1, "רק הפתוח נסגר; זה שנסגר בתמונה נשאר");
  await rpc(MGR, `SELECT public.inspection_report_update($1, '{"declared_clean": false}'::jsonb, 'לא היה נקי')`,
    [clean2.report_id]);
  const d2 = (await defectsOf(p.report_id))[1];
  assert.deepEqual([d2.status, d2.closure_no, d2.closed_by_report_id], ["open", 3, null]);
  assert.equal((await defectsOf(p.report_id))[0].status, "done", "ליקוי שנסגר בתמונה אינו נפתח");
  const dangling = await sup(`SELECT count(*)::int n FROM inspection_defects d JOIN inspection_reports r ON r.id = d.closed_by_report_id
                               WHERE d.status = 'done' AND (r.deleted_at IS NOT NULL OR NOT r.declared_clean)`);
  assert.equal(dangling[0].n, 0, "ליקוי 'בוצע' שמצביע על ראיה מתה");
});

test("32 · בדיקה חוזרת בשני מתקנים: machine_no קובע את האב; בלי מתקן — שגיאה; אב ומתקן סותרים — שגיאה (D6)", { skip }, async () => {
  const s = await newSite();
  const a = await upload(s.code, { kind: "periodic", machine_no: "40001", inspected_on: addDays(TODAY, -60),
    valid_until: addDays(TODAY, 300) }, { defects: [{ body: "ליקוי של 40001" }] });
  const b = await upload(s.code, { kind: "periodic", machine_no: "222", inspected_on: addDays(TODAY, -20),
    valid_until: addDays(TODAY, 300) }, { defects: [{ body: "ליקוי של 222" }] });
  const f = await upload(s.code, { kind: "followup", machine_no: "40001", inspected_on: addDays(TODAY, -1),
    confirm_clean: true, close_open_defects: true });
  const fr = await reportRow(f.report_id);
  assert.deepEqual({ of: fr.followup_of, mk: fr.machine_key }, { of: a.report_id, mk: "40001" });
  assert.equal(f.closed, 1);
  assert.equal((await defectsOf(a.report_id))[0].status, "done");
  assert.equal((await defectsOf(b.report_id))[0].status, "open", "הליקוי של המתקן השני נשאר פתוח");
  await fails(upload(s.code, { kind: "followup", inspected_on: addDays(TODAY, -1), confirm_clean: true }),
    "23514", /לבחור מתקן/);
  await fails(upload(s.code, { kind: "followup", machine_key: "222", followup_of: a.report_id,
    inspected_on: addDays(TODAY, -1), confirm_clean: true }), "23514", /מתקן אחר/);
  // מתקן יחיד: בלי מתקן מפורש — עדיין עובד (האתר הרגיל)
  const one1 = await newSite();
  const p1 = await periodic(one1, { insp: addDays(TODAY, -30) });
  const f1 = await upload(one1.code, { kind: "followup", inspected_on: addDays(TODAY, -1), confirm_clean: true });
  assert.equal((await reportRow(f1.report_id)).followup_of, p1.report_id);
});

test("33 · 'האחרון' לפי תאריך ולא לפי סדר העלאה: תקופתי, מחזור, PM", { skip }, async () => {
  const s = await newSite();
  await periodic(s, { insp: addDays(TODAY, -10), valid: addDays(TODAY, 40) });     // החדש — הועלה ראשון
  await periodic(s, { insp: addDays(TODAY, -300), valid: addDays(TODAY, 65) });    // ארכיון — הועלה שני
  assert.equal((await status(s.id)).vu, addDays(TODAY, 40));

  const c = await newSite();
  const p = await periodic(c, { insp: addDays(TODAY, -30), defects: [{ body: "גדר" }] });
  await closeByPhoto((await defectsOf(p.report_id))[0].id);
  await followup(c, p.report_id, { insp: addDays(TODAY, -2) });                      // נקי, מאוחר — הועלה ראשון
  const dirty = await followup(c, p.report_id, { insp: addDays(TODAY, -10), defects: [{ body: "תאורה" }] });
  await closeByPhoto((await defectsOf(dirty.report_id))[0].id);
  assert.equal((await status(c.id)).c, "clean", "המחזור נקבע לפי הבדיקה המאוחרת בתאריך");

  const pm = await newSite();
  const hist = (on) => one(MGR, `SELECT visit_id::int FROM public.pm_historical_upload($1, $2::jsonb, $3::jsonb)`,
    [pm.code, JSON.stringify({ client_id: uuid(), performed_on: on }), JSON.stringify({ mime: "application/pdf", data: pdf() })]);
  const newer = await hist(addDays(TODAY, -20));
  await hist(addDays(TODAY, -200));
  const st = await status(pm.id);
  assert.deepEqual({ last: st.plast, vid: st.pvid }, { last: addDays(TODAY, -20), vid: newer.visit_id });
});

test("34 · סגירה בתסקיר חוזר נקי — רק המחזור, רק המתקן, ורק עד תאריך הבדיקה (D24)", { skip }, async () => {
  const s = await newSite();
  const old = await periodic(s, { machine: "A", insp: addDays(TODAY, -500), valid: addDays(TODAY, -100),
    defects: [{ body: "ליקוי מחזור קודם" }] });
  const p = await periodic(s, { machine: "A", insp: addDays(TODAY, -30), defects: [{ body: "ליקוי במחזור" }] });
  const other = await periodic(s, { machine: "B", insp: addDays(TODAY, -30), defects: [{ body: "ליקוי במתקן B" }] });
  const later = await followup(s, p.report_id, { insp: addDays(TODAY, -1), defects: [{ body: "ליקוי מאוחר" }] });
  const clean = await followup(s, p.report_id, { insp: addDays(TODAY, -3), close: true });
  assert.equal(clean.closed, 1);
  assert.equal((await defectsOf(p.report_id))[0].status, "done");
  assert.equal((await defectsOf(old.report_id))[0].status, "open", "מחזור קודם של אותו מתקן — לא נגעים");
  assert.equal((await defectsOf(other.report_id))[0].status, "open", "מתקן אחר — לא נוגעים");
  assert.equal((await defectsOf(later.report_id))[0].status, "open", "בדיקה מאוחרת מהנקייה — לא נוגעים");
});

test("35 · הוצאה משימוש: העלאת ארכיון אינה מחזירה; העברת תסקיר למתקן שהוצא — נדחית; כולם הוצאו — לא 'חסר'", { skip }, async () => {
  const s = await newSite();
  await periodic(s, { machine: "A", insp: addDays(TODAY, -10), valid: addDays(TODAY, 300) });
  await periodic(s, { machine: "B", insp: addDays(TODAY, -400), valid: addDays(TODAY, -30) });
  await rpc(MGR, `SELECT public.inspection_machine_retire($1, 'B', 'פורק')`, [s.code]);
  await periodic(s, { machine: "B", insp: addDays(TODAY, -600), valid: addDays(TODAY, -300) });
  const m = await sup(`SELECT retired_at IS NOT NULL r FROM inspection_machines WHERE site_id=$1 AND machine_key='B'`, [s.id]);
  assert.equal(m[0].r, true, "העלאת ארכיון החזירה מתקן שפורק");
  assert.equal((await status(s.id)).s, "ok");
  const a = (await sup(`SELECT id::int FROM inspection_reports WHERE site_id=$1 AND machine_key='A'`, [s.id]))[0].id;
  await fails(rpc(MGR, `SELECT public.inspection_report_update($1, '{"machine_key":"B"}'::jsonb, NULL)`, [a]),
    "23514", /הוצא משימוש/);
  assert.equal((await status(s.id)).s, "ok");
  // תקופתי חדש אמיתי — כן מחזיר
  await periodic(s, { machine: "B", insp: addDays(TODAY, -1), valid: addDays(TODAY, 300) });
  assert.equal((await status(s.id)).m, 2);

  const solo = await newSite();
  await periodic(solo, { insp: addDays(TODAY, -10) });
  await rpc(MGR, `SELECT public.inspection_machine_retire($1, '1', 'המעלית פורקה')`, [solo.code]);
  await setSetting("compliance_go_live", addDays(TODAY, -5));
  try {
    const st = await status(solo.id);
    assert.deepEqual({ s: st.s, vs: st.vs, miss: st.miss, m: st.m }, { s: "none", vs: "none", miss: false, m: 0 });
    const empty = await newSite();
    assert.deepEqual(await status(empty.id).then((x) => ({ s: x.s, miss: x.miss })), { s: "expired", miss: true },
      "אתר בלי מתקנים כלל — עדיין 'חסר'");
  } finally { await delSetting("compliance_go_live"); }
});

test("36 · כללי מצב: תוקף בדיקה חוזרת, go-live עתידי, 'היום', מחזור האתר = הגרוע, awaiting_since", { skip }, async () => {
  const s = await newSite();
  const p = await periodic(s, { insp: addDays(TODAY, -100), valid: addDays(TODAY, 200) });
  await followup(s, p.report_id, { insp: addDays(TODAY, -50), valid: addDays(TODAY, 100) });
  assert.equal((await status(s.id)).vu, addDays(TODAY, 100), "בדיקה חוזרת עם תוקף משלה דורסת");
  await followup(s, p.report_id, { insp: addDays(TODAY, -10) });
  assert.equal((await status(s.id)).vu, addDays(TODAY, 100), "בדיקה חוזרת יורשת מאוחרת אינה מאפסת");

  const g = await newSite();
  await setSetting("compliance_go_live", addDays(TODAY, 1));
  try {
    const st = await status(g.id);
    assert.deepEqual({ s: st.s, miss: st.miss }, { s: "none", miss: true });
    assert.equal((await status(g.id, addDays(TODAY, 1))).s, "expired");
  } finally { await delSetting("compliance_go_live"); }

  const def = (await sup(`SELECT pg_get_functiondef('app.compliance_today()'::regprocedure) d`))[0].d;
  assert.match(def, /compliance_today_at\(now\(\)\)/, "'היום' חייב לעבור דרך שעון ישראל");

  const two = await newSite();
  await periodic(two, { machine: "A", defects: [{ body: "פתוח" }] });
  await periodic(two, { machine: "B" });
  assert.equal((await status(two.id)).c, "open", "מחזור האתר = המתקן הגרוע");

  const aw = await newSite();
  const ap = await periodic(aw, { defects: [{ body: "ממתין" }] });
  const [d] = await defectsOf(ap.report_id);
  await closeByPhoto(d.id);
  await sup(`UPDATE inspection_defects SET done_at = '2026-10-04T22:30:00.000Z' WHERE id = $1`, [d.id]);
  const r = (await sup(`SELECT inspection_cycle c, inspection_awaiting_since::text a FROM app.compliance_rows(ARRAY[$1]::int[], $2::date)`,
    [aw.id, TODAY]))[0];
  assert.deepEqual(r, { c: "awaiting_clean", a: "2026-10-05" });
});

test("37 · MFA: ענפי 'מנהל בלבד' דורשים aal2 כשהדגל דלוק — כמו require_manager", { skip }, async () => {
  const s = await newSite();
  const r = await periodic(s, { defects: [{ body: "לפני מחיקה" }] });
  const [d] = await defectsOf(r.report_id);
  await stagePhoto(OPR, d.id);
  await rpc(MGR, `SELECT public.inspection_report_delete($1, 'בדיקת MFA')`, [r.report_id]);
  const v = await startVisit(OPR, s.code);
  await setSetting("mfa_required_for_manager", "true");
  try {
    const aal1 = { aal: "aal1" }, aal2 = { aal: "aal2" };
    await fails(asClaims(MGR, aal1, `SELECT * FROM public.compliance_purge('inspection_file', $1, 'x1')`, [r.file_id]), "42501");
    await fails(asClaims(MGR, aal1, `SELECT mime FROM public.compliance_file('inspection_pdf', $1)`, [r.file_id]), "PT404");
    await fails(asClaims(MGR, aal1, `SELECT id FROM public.compliance_thumbs('defect', $1)`, [d.id]), "PT404");
    await fails(asClaims(MGR, aal1, `SELECT public.pm_visit_discard($1, 'לא שלי')`, [v.visit_id]), "42501");
    assert.equal((await asClaims(MGR, aal2, `SELECT mime FROM public.compliance_file('inspection_pdf', $1)`, [r.file_id])).length, 1);
    assert.equal((await asClaims(MGR, aal2, `SELECT id FROM public.compliance_thumbs('defect', $1)`, [d.id])).length, 1);
    await asClaims(MGR, aal2, `SELECT public.pm_visit_discard($1, 'מנהל מאומת')`, [v.visit_id]);
  } finally { await delSetting("mfa_required_for_manager"); }
});

test("38 · ביקור שהוגש: UPDATE ישיר נחסם; מחיקה רכה מותרת; קבצים של ביקור שנמחק — PT404 לבקר; purge רק לנמחק", { skip }, async () => {
  const { visit } = T24;
  const blocked = /הביקור כבר הוגש/;
  await fails(sup(`UPDATE pm_visits SET performed_on = performed_on + 40 WHERE id=$1`, [visit]), "23514", blocked);
  await fails(sup(`UPDATE pm_visits SET performer_name = 'מישהו אחר' WHERE id=$1`, [visit]), "23514", blocked);
  await fails(sup(`UPDATE pm_visits SET status = 'draft', submitted_at = NULL WHERE id=$1`, [visit]), "23514", blocked);
  await fails(sup(`DELETE FROM pm_visits WHERE id=$1`, [visit]), "23514", blocked);
  await fails(rpc(MGR, `SELECT public.compliance_purge('pm_visit', $1, 'עדיין חי')`, [visit]), "23514", /שנמחק/);
  const photo = (await sup(`SELECT id::int FROM pm_files WHERE visit_id=$1 AND kind='photo' LIMIT 1`, [visit]))[0].id;
  assert.equal((await rpc(OPR, `SELECT mime FROM public.compliance_file('pm_photo', $1)`, [photo])).length, 1);
  await rpc(MGR, `SELECT public.pm_visit_delete($1, 'נחתם בטעות')`, [visit]);
  await fails(rpc(OPR, `SELECT mime FROM public.compliance_file('pm_photo', $1)`, [photo]), "PT404");
  await fails(rpc(OPR, `SELECT mime FROM public.compliance_file('pm_signature', $1)`, [visit]), "PT404");
  await fails(rpc(OPR, `SELECT public.pm_visit_detail($1)`, [visit]), "PT404");
  assert.equal((await rpc(MGR, `SELECT mime FROM public.compliance_file('pm_signature', $1)`, [visit])).length, 1);
  assert.ok((await one(MGR, `SELECT public.compliance_purge('pm_visit', $1, 'ניקוי נפח') n`, [visit])).n >= 2);
  const row = (await sup(`SELECT signature_b64, performed_on::text FROM pm_visits WHERE id=$1`, [visit]))[0];
  assert.deepEqual(row, { signature_b64: null, performed_on: TODAY });

  // תמונת ליקוי של תסקיר שנמחק
  const s = await newSite();
  const r = await periodic(s, { defects: [{ body: "ליקוי לתמונה" }] });
  const [d] = await defectsOf(r.report_id);
  const ph = await stagePhoto(OPR, d.id);
  await rpc(MGR, `SELECT public.inspection_report_delete($1, 'מסמך שגוי')`, [r.report_id]);
  await fails(rpc(OPR, `SELECT mime FROM public.compliance_file('defect_photo', $1)`, [ph]), "PT404");
  assert.equal((await rpc(MGR, `SELECT mime FROM public.compliance_file('defect_photo', $1)`, [ph])).length, 1);
});

test("39 · תקרות ביקור: 40 תמונות, 15MB, ותאריך ביצוע לפני הפתיחה", { skip }, async () => {
  const s = await newSite();
  const v = await startVisit(OPR, s.code);
  for (let i = 0; i < 4; i++) {
    await sup(`INSERT INTO pm_visit_items (visit_id, seq, label, kind, required, min_photos)
               VALUES ($1, $2, 'צילום נוסף', 'photo', false, 0)`, [v.visit_id, 10 + i]);
  }
  const items = await visitItems(v.visit_id);
  assert.equal(items.length, 7);
  let added = 0;
  for (const it of items) for (let i = 0; i < 6 && added < 40; i++, added++) await pmPhoto(OPR, it.id);
  await fails(pmPhoto(OPR, items[6].id), "23514", /עד 40/);

  const s2 = await newSite();
  const v2 = await startVisit(OPR, s2.code);
  const [chk, photo] = await visitItems(v2.visit_id);
  await sup(`INSERT INTO pm_files (client_id, visit_id, visit_item_id, kind, mime, data_b64, byte_size, uploaded_by, created_at)
             VALUES ($1, $2, $3, 'photo', 'image/jpeg', $4, 15728630, 'x', 'x')`, [uuid(), v2.visit_id, photo.id, jpg()]);
  await fails(pmPhoto(OPR, photo.id), "23514", /15MB/);
  await sup(`DELETE FROM pm_files WHERE visit_id = $1`, [v2.visit_id]);                   // טיוטה — מותר
  await pmPhoto(OPR, photo.id);
  await pmPhoto(OPR, photo.id);
  await rpc(OPR, `SELECT public.pm_visit_item_check($1, true)`, [chk.id]);
  await fails(submit(OPR, v2.visit_id, { on: addDays(TODAY, -1) }), "23514", /בין פתיחת הביקור להיום/);
});

test("40 · תקרות טקסט חופשי ו-parse_meta מרשימה מותרת (D2(ג))", { skip }, async () => {
  const s = await newSite();
  const long = (n) => "א".repeat(n);
  const r = await periodic(s, { defects: [{ body: "ליקוי לתקרה" }] });
  const [d] = await defectsOf(r.report_id);
  await stagePhoto(OPR, d.id);
  await fails(one(OPR, `SELECT * FROM public.inspection_defect_done($1, $2, NULL, $3::uuid)`, [d.id, long(101), uuid()]),
    "23514", /ארוך מדי/);
  await fails(upload(s.code, { kind: "periodic", machine_key: "L", machine_label: long(81),
    inspected_on: addDays(TODAY, -3), valid_until: addDays(TODAY, 300), confirm_clean: true }), "23514", /ארוך מדי/);
  await fails(upload(s.code, { kind: "periodic", machine_key: "L", note: long(2001),
    inspected_on: addDays(TODAY, -3), valid_until: addDays(TODAY, 300), confirm_clean: true }), "23514", /ארוך מדי/);
  await fails(rpc(MGR, `SELECT public.inspection_report_delete($1, $2)`, [r.report_id, long(501)]), "23514", /ארוכה מדי/);
  await fails(rpc(MGR, `SELECT public.inspection_report_update($1, $2::jsonb, NULL)`,
    [r.report_id, JSON.stringify({ inspector_name: long(101) })]), "23514", /ארוך מדי/);

  const pv = await newSite();
  const v = await startVisit(OPR, pv.code);
  const [chk, photo] = await visitItems(v.visit_id);
  await rpc(OPR, `SELECT public.pm_visit_item_check($1, true)`, [chk.id]);
  await pmPhoto(OPR, photo.id);
  await pmPhoto(OPR, photo.id);
  await fails(submit(OPR, v.visit_id, { name: long(101) }), "23514", /ארוך מדי/);

  // ערבות המסד גם מול כתיבה ישירה (על ליקוי שנסגר כדין — כך רק התקרה נופלת)
  await done(OPR, d.id);
  await sup(`UPDATE inspection_defects SET done_by_name = repeat('x', 100) WHERE id = $1`, [d.id]);
  await fails(sup(`UPDATE inspection_defects SET done_by_name = repeat('x', 101) WHERE id = $1`, [d.id]), "23514",
    /text_caps/);
  await fails(sup(`UPDATE inspection_reports SET note = repeat('x', 2001) WHERE id = $1`, [r.report_id]), "23514", /text_caps/);
  await fails(sup(`UPDATE inspection_reports SET parse_meta = jsonb_build_object('blob', repeat('x', 5000)) WHERE id = $1`,
    [r.report_id]), "23514", /text_caps/);

  const ins = addDays(TODAY, -4), val = addDays(TODAY, 360);
  const pm = await upload(s.code, { kind: "periodic", machine_key: "P", inspected_on: ins, valid_until: val, confirm_clean: true,
    parse: { parser: "2", confidence: "high", extract: "ok", blob: "x".repeat(100000), rawLines: ["שורה"],
      section: { rawLines: ["שורה גולמית מה-PDF", "עוד שורה"] },
      notes: [{ code: "no_inspector", text: "הסבר ארוך" }, "empty_section"],
      parsed: { inspectedAt: ins, validUntil: val, validitySource: "document", extra: "x" } } });
  const meta = (await sup(`SELECT parse_meta FROM inspection_reports WHERE id=$1`, [pm.report_id]))[0].parse_meta;
  assert.deepEqual(meta, { parser: "2", confidence: "high", extract: "ok", notes: ["no_inspector", "empty_section"],
    parsed: { inspectedAt: ins, validUntil: val, validitySource: "document" } });
  assert.equal((await reportRow(pm.report_id)).validity_source, "document");
});

test("41 · idempotency ותשובות replay: ליקוי ידני, סגירה, client_id של תמונה על ליקוי/פריט אחר", { skip }, async () => {
  const s = await newSite();
  const r = await periodic(s, { defects: [{ body: "קיים" }] });
  const c = uuid();
  const save = (cl, rep = r.report_id) => one(MGR,
    `SELECT public.inspection_defect_save($1, NULL, 'תאורה בחדר מכונות', false, NULL, $2::uuid) id`, [rep, cl]);
  const a = await save(c);
  const b = await save(c);
  assert.equal(b.id, a.id, "אותו client_id — אותו ליקוי");
  assert.equal((await defectsOf(r.report_id)).length, 2);
  await fails(one(MGR, `SELECT public.inspection_defect_save($1, NULL, 'בלי מזהה', false, NULL)`, [r.report_id]),
    "23514", /מזהה בקשה/);
  const r2 = await periodic(s, { machine: "Q", defects: [{ body: "אחר" }] });
  await fails(save(c, r2.report_id), "PT409");

  // replay של העלאה מחזיר את מספר הנסגרים האמיתי
  const p = await periodic(s, { machine: "R", insp: addDays(TODAY, -20), defects: [{ body: "א1" }, { body: "ב2" }] });
  const meta = { client_id: uuid(), kind: "followup", followup_of: p.report_id, inspected_on: addDays(TODAY, -1),
    confirm_clean: true, close_open_defects: true };
  const file = pdf();
  const first = await upload(s.code, meta, { file });
  const again = await upload(s.code, meta, { file });
  assert.deepEqual({ c: again.closed, d: again.defects, r: again.replayed }, { c: first.closed, d: 0, r: true });
  assert.equal(first.closed, 2);

  // client_id של תמונה שכבר שימש לליקוי אחר → PT409 בעברית, לא 23505
  const [d1, d2] = await defectsOf(r.report_id);
  const pc = uuid();
  await stagePhoto(OPR, d1.id, jpg(), pc);
  await fails(stagePhoto(OPR, d2.id, jpg(), pc), "PT409", /ליקוי אחר/);
  const v = await startVisit(OPR, s.code);
  const [, ph, opt] = await visitItems(v.visit_id);
  const qc = uuid();
  await pmPhoto(OPR, ph.id, qc);
  await fails(pmPhoto(OPR, opt.id, qc), "PT409", /פריט אחר/);
});

test("42 · עריכת תסקיר: machine_key מעביר את הבדיקות החוזרות; תוקף שנערך = 'manual'; purge של תמונת WebP", { skip }, async () => {
  const s = await newSite();
  const v = addDays(TODAY, 300);
  const p = await periodic(s, { machine: "1", insp: addDays(TODAY, -10), valid: v,
    parse: { parsed: { inspectedAt: addDays(TODAY, -10), validUntil: v, validitySource: "document" } } });
  const f = await followup(s, p.report_id, { insp: addDays(TODAY, -2) });
  assert.equal((await reportRow(p.report_id)).validity_source, "document");
  await rpc(MGR, `SELECT public.inspection_report_update($1, '{"machine_key":"Z"}'::jsonb, NULL)`, [p.report_id]);
  assert.equal((await reportRow(f.report_id)).machine_key, "Z");
  await rpc(MGR, `SELECT public.inspection_report_update($1, $2::jsonb, NULL)`,
    [p.report_id, JSON.stringify({ valid_until: addDays(TODAY, 299) })]);
  assert.equal((await reportRow(p.report_id)).validity_source, "manual");

  const w = await newSite();
  const r = await periodic(w, { defects: [{ body: "ליקוי WebP" }] });
  const [d] = await defectsOf(r.report_id);
  await stagePhoto(OPR, d.id, webp(), uuid(), "image/webp");
  await rpc(MGR, `SELECT public.inspection_report_delete($1, 'מסמך שגוי')`, [r.report_id]);
  assert.equal((await one(MGR, `SELECT public.compliance_purge('inspection_file', $1, 'ניקוי') n`, [r.file_id])).n, 2);
  const row = (await sup(`SELECT mime, purged_at IS NOT NULL p FROM inspection_defect_photos WHERE defect_id=$1`, [d.id]))[0];
  assert.deepEqual(row, { mime: "image/jpeg", p: true });
});

// ================================================================
// רשימת הבדיקה: תקרת התמונות ושמירה מגרסה ישנה
// ================================================================

test("43 · רשימת הבדיקה: סך תמונות חובה ≤ 40; שמירה מגרסה ישנה → PT409; בלי אסימון — כמו קודם", { skip }, async () => {
  const cur = await sup(`SELECT id::int, label, kind, required, min_photos FROM pm_checklist_items WHERE active ORDER BY seq, id`);
  assert.ok(cur.length > 0, "בדיקה 22 אמורה להשאיר רשימה");
  const items = cur.map((r) => ({ id: r.id, label: r.label, kind: r.kind, required: r.required, min_photos: r.min_photos }));
  const base = items.reduce((n, r) => n + (r.required ? r.min_photos : 0), 0);
  const ver = async () => (await sup(`SELECT COALESCE(max(updated_at), '') v FROM pm_checklist_items WHERE active`))[0].v;
  const save = (list, token) => one(MGR, `SELECT public.pm_template_save($1::jsonb, $2) n`, [JSON.stringify(list), token]);
  // פריטי צילום חובה עד שהסכום הוא בדיוק `total`
  const upTo = (total) => {
    const extra = [];
    for (let left = total - base, n = 1; left > 0; n++) {
      const m = Math.min(6, left);
      extra.push({ label: `צילום חובה ${n}`, kind: "photo", required: true, min_photos: m });
      left -= m;
    }
    return [...items, ...extra];
  };

  // 41 — נדחה, ושום דבר לא נשמר (כל השמירה בעסקה אחת)
  await fails(rpc(MGR, `SELECT public.pm_template_save($1::jsonb)`, [JSON.stringify(upTo(41))]), "23514", /עולה על 40/);
  assert.equal((await sup(`SELECT count(*)::int n FROM pm_checklist_items WHERE active`))[0].n, cur.length);
  // ⚠️ פריט רשות אינו נספר: min_photos שלו הוא 0 בכל מקרה (pm_checklist_items_photo_shape)
  // 40 בדיוק — עובר
  assert.ok((await save(upTo(40), null)).n > cur.length);

  // אסימון: חותמת ישנה ידועה, כדי שהשמירה הבאה תהיה בהכרח שונה ממנה גם באותה מילישנייה
  await sup(`UPDATE pm_checklist_items SET updated_at = '2000-01-01T00:00:00.000Z' WHERE active`);
  const v0 = await ver();
  assert.equal(v0, "2000-01-01T00:00:00.000Z");
  // מנהל ב' שומר (מחזיר את הרשימה המקורית) — עם אסימון נכון
  assert.equal((await save(items, v0)).n, cur.length);
  const v1 = await ver();
  assert.notEqual(v1, v0);
  // מנהל א', עדיין על v0, מנסה לשמור את הגרסה הכבדה — נדחה, ולא שינה דבר
  await fails(rpc(MGR, `SELECT public.pm_template_save($1::jsonb, $2)`, [JSON.stringify(upTo(40)), v0]),
    "PT409", /עודכנה בינתיים ע״י/);
  assert.equal((await sup(`SELECT count(*)::int n FROM pm_checklist_items WHERE active`))[0].n, cur.length);
  // רשימה שנטענה ריקה ('') מול רשימה שאינה ריקה — גם היא ישנה
  await fails(rpc(MGR, `SELECT public.pm_template_save($1::jsonb, '')`, [JSON.stringify(items)]), "PT409");
  // האסימון הנוכחי — עובר; בלי אסימון (NULL) — בלי בדיקה, כמו קודם
  assert.equal((await save(items, v1)).n, cur.length);
  assert.equal((await save(items, null)).n, cur.length);
  const after = await sup(`SELECT id::int FROM pm_checklist_items WHERE active ORDER BY seq, id`);
  assert.deepEqual(after.map((r) => r.id), cur.map((r) => r.id));
});

test("44 · pm_visit_photo_add עם p_photo = NULL: ה-replay לפי client_id רץ ראשון — זה מה ש'ביטול תמונה' בדשבורד שואל", { skip }, async () => {
  const s = await newSite();
  const v = await startVisit(OPR, s.code);
  const it = (await visitItems(v.visit_id)).find((i) => i.kind !== "check");
  assert.ok(it, "הרשימה אמורה לכלול פריט צילום");
  const c = uuid();
  const fid = await pmPhoto(OPR, it.id, c);
  const probe = (client) => one(OPR, `SELECT public.pm_visit_photo_add($1, NULL, $2::uuid)::int AS id`, [it.id, client]);
  assert.equal((await probe(c)).id, fid, "תמונה שבשרת — מחזירה את ה-id שלה גם בלי תוכן");
  const n0 = (await sup(`SELECT count(*)::int n FROM pm_files WHERE visit_id = $1`, [v.visit_id]))[0].n;
  await fails(probe(uuid()), "23514", /תמונה לא תקינה/);
  assert.equal((await sup(`SELECT count(*)::int n FROM pm_files WHERE visit_id = $1`, [v.visit_id]))[0].n, n0,
    "תמונה שאינה בשרת — שום דבר לא נוסף");
});

test("45 · התחלה מחדש זורקת רק את הטיוטה שנראתה: מזהה אחר / פעילות מאז / טיוטה שנעלמה → PT409, בלי מחיקה", { skip }, async () => {
  const s = await newSite();
  const restart = (uid, id, at) => one(uid,
    `SELECT visit_id::int, created FROM public.pm_visit_start($1, true, $2, $3)`, [s.code, id, at]);
  const draftNow = async () => (await sup(
    `SELECT id::int, last_activity_at FROM pm_visits WHERE site_id = $1 AND status = 'draft'`, [s.id]))[0] ?? null;
  const v = await startVisit(OPR, s.code);
  const it = (await visitItems(v.visit_id))[0];
  await rpc(OPR, `SELECT public.pm_visit_item_check($1, true)`, [it.id]);
  const seen = await draftNow();

  // מזהה אחר — הטיוטה הוחלפה מאז שהכרטיס נטען
  await fails(restart(MGR, seen.id + 999, seen.last_activity_at), "PT409", /השתנתה בינתיים — בקר בדיקה פתח/);
  // אותו מזהה, אבל עבדו בה מאז (גם מנהל — שמותר לו תמיד — נעצר)
  await fails(restart(MGR, seen.id, "2000-01-01T00:00:00.000Z"), "PT409", /עבדו בה/);
  assert.deepEqual(await draftNow(), seen, "שום דבר לא נמחק ולא נגעו בפעילות");
  assert.equal((await visitItems(seen.id)).find((x) => x.id === it.id).checked, true, "העבודה בטיוטה נשמרה");
  // בלי התחלה מחדש — הציפייה אינה נבדקת, ומקבלים את הקיימת
  assert.deepEqual(await one(OPR, `SELECT visit_id::int, created FROM public.pm_visit_start($1, false, 1, 'x')`, [s.code]),
    { visit_id: seen.id, created: false });

  // מה שנראה הוא מה שקיים — עובר
  const v2 = await restart(MGR, seen.id, seen.last_activity_at);
  assert.equal(v2.created, true);
  assert.notEqual(v2.visit_id, seen.id);
  // הציפייה הישנה מול הטיוטה החדשה — נדחית
  await fails(restart(MGR, seen.id, seen.last_activity_at), "PT409", /השתנתה בינתיים — מנהלת בדיקה פתח/);
  // הטיוטה נעלמה (בוטלה) — לא נפתחת חדשה מתוך ציפייה לטיוטה שאיננה
  await rpc(MGR, `SELECT public.pm_visit_discard($1, 'בדיקת התחלה מחדש')`, [v2.visit_id]);
  await fails(restart(MGR, v2.visit_id, null), "PT409", /אינה קיימת/);
  assert.equal(await draftNow(), null);
  // NULL = בלי בדיקה, כמו קודם
  const v3 = await one(MGR, `SELECT visit_id::int, created FROM public.pm_visit_start($1, true)`, [s.code]);
  assert.equal(v3.created, true);
});

// ⚠️ בעלת המוצר, 06/10/2026: "אדום = לא תקין" — ליקוי שעבר את מועד התיקון צובע את נורת
// הבודק אדום גם כשהתסקיר בתוקף. התוקף עצמו (validity) חייב להישאר "בתוקף", אחרת התווית
// כותבת "בודק לא בתוקף" על תסקיר שבתוקף עוד חצי שנה.
const lights = async (siteId, day) => (await sup(
  `SELECT inspection_state s, inspection_validity_state vs, overdue_defects od, inspection_cycle c, machines_detail md
     FROM app.compliance_rows(ARRAY[$1]::int[], $2::date)`, [siteId, day]))[0];
const pick = (r) => ({ s: r.s, vs: r.vs, od: r.od });

test("46 · מועד תיקון: בתוך חודש → צהוב, עבר → כתום (תסקיר בתוקף) / אדום (פג); התוקף נשאר; בוצע/נמחק/מחזור קודם — לא נספרים", { skip }, async () => {
  const s = await newSite();
  const due = addDays(TODAY, 5);
  const p = await periodic(s, { insp: addDays(TODAY, -10), valid: addDays(TODAY, 200), defects: [{ body: "גדר", due_on: due }] });
  assert.deepEqual(pick(await lights(s.id, due)), { s: "soon", vs: "ok", od: 0 },
    "ביום היעד עצמו — עוד לא באיחור, אבל בתוך החודש: צהוב (מקרה 9)");
  let r = await lights(s.id, addDays(due, 1));
  // בעלת המוצר, 06/10/2026: מקרה 3 — "המסמך בתוקף, זמן תיקון הליקויים לא בתוקף" — כתום
  assert.deepEqual(pick(r), { s: "overdue", vs: "ok", od: 1 }, "יום אחרי היעד — כתום, והתוקף בתוקף");
  assert.deepEqual(r.md.map((m) => ({ s: m.state, v: m.validity, od: m.overdue })), [{ s: "overdue", v: "ok", od: 1 }],
    "פירוט המתקנים נושא גם את התוקף — בלעדיו התווית לא יודעת למה כתום");

  // בוצע עם תמונה → כבר לא באיחור: צהוב חזק של "ממתין לתסקיר נקי" (מקרה 8)
  const [d] = await defectsOf(p.report_id);
  await closeByPhoto(d.id);
  r = await lights(s.id, addDays(due, 1));
  assert.deepEqual({ ...pick(r), c: r.c }, { s: "awaiting", vs: "ok", od: 0, c: "awaiting_clean" });

  // תסקיר שפג וגם ליקוי באיחור — אדום, והתוקף אומר "לא בתוקף"
  const both = await newSite();
  await periodic(both, { insp: addDays(TODAY, -400), valid: addDays(TODAY, -2), defects: [{ body: "גם וגם", due_on: addDays(TODAY, -300) }] });
  assert.deepEqual(pick(await lights(both.id, TODAY)), { s: "expired", vs: "expired", od: 1 });

  // שני מתקנים: הכתום של A צובע את האתר; התוקף של האתר נשאר של התסקירים
  const two = await newSite();
  await periodic(two, { machine: "A", defects: [{ body: "באיחור", due_on: addDays(TODAY, -1) }] });
  await periodic(two, { machine: "B" });
  r = await lights(two.id, TODAY);
  assert.deepEqual(pick(r), { s: "overdue", vs: "ok", od: 1 });
  assert.deepEqual(r.md.map((m) => [m.key, m.state, m.validity]), [["A", "overdue", "ok"], ["B", "ok", "ok"]]);
  // ⚠️ אותו דבר בעמוד הבודק — מנורת המתקן נצבעת מ-inspection_site, לא מ-site_compliance
  const site = (await one(MGR, `SELECT public.inspection_site($1) j`, [two.code])).j;
  assert.deepEqual(site.machines.map((m) => [m.key, m.state, m.validity_state, m.overdue]),
    [["A", "overdue", "ok", 1], ["B", "ok", "ok", 0]]);
  assert.equal(site.status.inspection_state, "overdue");

  // ליקוי שנמחק (מחיקה רכה) אינו נספר
  const del = await newSite();
  const pd = await periodic(del, { defects: [{ body: "הוזן בטעות", due_on: addDays(TODAY, -1) }] });
  assert.deepEqual(pick(await lights(del.id, TODAY)), { s: "overdue", vs: "ok", od: 1 });
  await rpc(MGR, `SELECT public.inspection_defect_delete($1, 'הוזן בטעות')`, [(await defectsOf(pd.report_id))[0].id]);
  assert.deepEqual(pick(await lights(del.id, TODAY)), { s: "awaiting", vs: "ok", od: 0 }, "נמחק → לא באיחור; ממתין לתסקיר נקי");

  // ליקוי פתוח במחזור **קודם** אינו צובע: תקופתי חדש פותח מחזור חדש
  const old = await newSite();
  await periodic(old, { insp: addDays(TODAY, -400), valid: addDays(TODAY, -35), defects: [{ body: "ישן", due_on: addDays(TODAY, -300) }] });
  await periodic(old, { insp: addDays(TODAY, -5), valid: addDays(TODAY, 300) });
  assert.deepEqual(pick(await lights(old.id, TODAY)), { s: "ok", vs: "ok", od: 0 });
});

test("47 · ליקוי שנמחק ב'טופל' + סימון התסקיר המקורי נקי — נחסם; רק תסקיר נקי מהבודק סוגר", { skip }, async () => {
  // בדיוק מה שקרה בייצור, 06/10/2026: תסקיר עם ליקוי אחד, הליקוי נמחק בסיבה "טופל", והתסקיר
  // המקורי סומן נקי בעריכה — ירוק בלי שום מסמך מהבודק. בעלת המוצר: "צריך מסמך נקי שמעלה בודק
  // מוסמך שוב ומאשר".
  const s = await newSite();
  const p = await periodic(s, { defects: [{ body: "לתקן סנסור" }] });
  const [d] = await defectsOf(p.report_id);
  await rpc(MGR, `SELECT public.inspection_defect_delete($1, 'טופל')`, [d.id]);
  let st = await status(s.id);
  assert.deepEqual({ c: st.c, s: st.s, vs: st.vs }, { c: "awaiting_clean", s: "awaiting", vs: "ok" });
  await fails(rpc(MGR, `SELECT public.inspection_report_update($1, '{"declared_clean": true}'::jsonb, 'טופל')`, [p.report_id]),
    "23514", /נרשמו ליקויים/);
  assert.equal((await status(s.id)).c, "awaiting_clean");
  // עמוד הבודק יודע שנרשמו ליקויים — חלון העריכה לא מציע "נקי"
  const site = (await one(MGR, `SELECT public.inspection_site($1) j`, [s.code])).j;
  assert.deepEqual(site.reports.map((r) => [r.defects.length, r.deleted_defects]), [[0, 1]]);
  // התסקיר הנקי מהבודק — בדיקה חוזרת — הוא שסוגר
  await followup(s, p.report_id, { insp: TODAY });
  st = await status(s.id);
  assert.deepEqual({ c: st.c, s: st.s }, { c: "clean", s: "ok" });

  // תסקיר שמעולם לא נרשם בו ליקוי ושבוטל סימון ה"נקי" שלו — review, ומותר להחזיר את הסימון
  const s2 = await newSite();
  const p2 = await periodic(s2);
  await rpc(MGR, `SELECT public.inspection_report_update($1, '{"declared_clean": false}'::jsonb, 'בטעות')`, [p2.report_id]);
  assert.equal((await status(s2.id)).c, "review");
  await rpc(MGR, `SELECT public.inspection_report_update($1, '{"declared_clean": true}'::jsonb, 'המסמך נקי')`, [p2.report_id]);
  assert.equal((await status(s2.id)).c, "clean");
});

test("48 · בוצע בלי תמונה ובלי שם: מותר; בלי שם — נרשם המשתמש המחובר; בוצע ≠ נקי; פתיחה מחדש וסגירה שנייה", { skip }, async () => {
  // בעלת המוצר, 06/10/2026: "שזה יהיה אופציונלי — להמשיך גם בלי להעלות תמונה ולציין מי תיקן"
  const s = await newSite();
  const p = await periodic(s, { defects: [{ body: "לתקן סנסור" }, { body: "שלט חסר" }, { body: "תאורה" }] });
  const [d1, d2, d3] = await defectsOf(p.report_id);
  // "בלי למלא את הכל" (06/10/2026): בלי שם ובלי תמונה — מותר, ונרשם המשתמש המחובר (מהזהות, לא מהבקשה)
  await one(OPR, `SELECT * FROM public.inspection_defect_done($1, ' ', NULL, $2::uuid)`, [d3.id, uuid()]);
  assert.equal((await sup(`SELECT done_by_name FROM inspection_defects WHERE id=$1`, [d3.id]))[0].done_by_name, "בקר בדיקה");
  assert.deepEqual(await done(OPR, d1.id), { defect_id: d1.id, photos: 0, replayed: false });
  const row = (await sup(`SELECT status, done_by_name, done_photo_id, closed_by_report_id FROM inspection_defects WHERE id=$1`,
    [d1.id]))[0];
  assert.deepEqual(row, { status: "done", done_by_name: "טכנאי בדיקה", done_photo_id: null, closed_by_report_id: null });
  assert.equal((await status(s.id)).c, "open", "ליקוי אחד עדיין פתוח");
  await closeByPhoto(d2.id);                                    // עם תמונה — עדיין עובד, והיא הראיה
  assert.notEqual((await defectsOf(p.report_id))[1].done_photo_id, null);
  const st = await status(s.id);
  assert.deepEqual({ c: st.c, s: st.s }, { c: "awaiting_clean", s: "awaiting" }, "בוצע ≠ נקי: ממתין לתסקיר מהבודק");
  // פתיחה מחדש של ליקוי שנסגר בלי תמונה, וסגירה שנייה
  await rpc(MGR, `SELECT public.inspection_defect_reopen($1, 'לא תוקן')`, [d1.id]);
  assert.equal((await status(s.id)).c, "open");
  assert.equal((await done(OPR, d1.id)).photos, 0);
  assert.equal((await status(s.id)).c, "awaiting_clean");
});

test("49 · שבעה צבעים: תשעת המקרים של בעלת המוצר, קדימות, גבולות החודש, מתקן מול אתר, ומצב מועד לכל ליקוי", { skip }, async () => {
  // בעלת המוצר, 06/10/2026: 2 שחור-לבן (ok) · 1 ירוק (fixing) · 4, 9 צהוב (soon) · 8 צהוב חזק (awaiting)
  // · 3 כתום (overdue) · 5, 6, 7 אדום (expired). כשכמה חלים יחד — החמור קובע.
  const VALID = addDays(TODAY, 200), SOON = addDays(TODAY, 20);
  const EXP = { insp: addDays(TODAY, -400), valid: addDays(TODAY, -2) };
  const far = addDays(TODAY, 60), near = addDays(TODAY, 10), past = addDays(TODAY, -2);
  const row = async (s) => (await sup(
    `SELECT inspection_state s, inspection_validity_state vs, overdue_defects od, due_soon_defects ds, machines_detail md
       FROM app.compliance_rows(ARRAY[$1]::int[], $2::date)`, [s.id, TODAY]))[0];
  const closeAll = async (p) => { for (const d of await defectsOf(p.report_id)) await done(OPR, d.id); };
  const make = async (o, after) => {
    const s = await newSite();
    const p = await periodic(s, o);
    if (after) await after(p);
    return s;
  };
  const cases = [
    ["1 בתוקף, ליקוי שיש לו עוד זמן", { valid: VALID, defects: [{ body: "גדר", due_on: far }] }, null, "fixing"],
    ["2 בתוקף, אין ליקויים", { valid: VALID }, null, "ok"],
    ["3 בתוקף, ליקוי שעבר את המועד", { valid: VALID, defects: [{ body: "גדר", due_on: past }] }, null, "overdue"],
    ["4 בתוקף, פג בעוד פחות מחודש", { valid: SOON }, null, "soon"],
    ["5 לא בתוקף, אין ליקויים", { ...EXP }, null, "expired"],
    ["6 לא בתוקף, הליקויים טופלו", { ...EXP, defects: [{ body: "גדר", due_on: addDays(TODAY, -300) }] }, closeAll, "expired"],
    ["7 לא בתוקף, ליקוי שעבר את המועד", { ...EXP, defects: [{ body: "גדר", due_on: addDays(TODAY, -300) }] }, null, "expired"],
    ["8 בתוקף, הליקויים טופלו (ממתין לתסקיר נקי)", { valid: VALID, defects: [{ body: "גדר", due_on: far }] }, closeAll, "awaiting"],
    ["9 בתוקף, מועד תיקון בעוד פחות מחודש", { valid: VALID, defects: [{ body: "גדר", due_on: near }] }, null, "soon"],
    // קדימות
    ["4+3 → כתום", { valid: SOON, defects: [{ body: "גדר", due_on: past }] }, null, "overdue"],
    ["4+8 → צהוב חזק", { valid: SOON, defects: [{ body: "גדר", due_on: far }] }, closeAll, "awaiting"],
    ["4+1 → צהוב", { valid: SOON, defects: [{ body: "גדר", due_on: far }] }, null, "soon"],
    ["9+1 → צהוב", { valid: VALID, defects: [{ body: "גדר", due_on: near }, { body: "שלט", due_on: far }] }, null, "soon"],
    ["3+9 → כתום", { valid: VALID, defects: [{ body: "גדר", due_on: past }, { body: "שלט", due_on: near }] }, null, "overdue"],
    // גבולות החודש: היום עצמו עוד לא באיחור; 30 יום — בתוך החודש; 31 — כבר לא
    ["מועד היום → צהוב", { valid: VALID, defects: [{ body: "גדר", due_on: TODAY }] }, null, "soon"],
    ["מועד בעוד 30 → צהוב", { valid: VALID, defects: [{ body: "גדר", due_on: addDays(TODAY, 30) }] }, null, "soon"],
    ["מועד בעוד 31 → ירוק", { valid: VALID, defects: [{ body: "גדר", due_on: addDays(TODAY, 31) }] }, null, "fixing"],
  ];
  for (const [name, o, after, want] of cases) {
    const r = await row(await make(o, after));
    assert.equal(r.s, want, name);
    if (want !== "expired") assert.notEqual(r.vs, "expired", `${name}: התוקף נשאר טהור`);
  }

  // הספירות: overdue / due_soon נפרדות, באתר ובפירוט המתקנים
  const cnt = await make({ valid: VALID, defects: [{ body: "ליקוי א", due_on: past }, { body: "ליקוי ב", due_on: near },
                                                   { body: "ליקוי ג", due_on: TODAY }, { body: "ליקוי ד", due_on: far }] });
  let r = await row(cnt);
  assert.deepEqual({ od: r.od, ds: r.ds }, { od: 1, ds: 2 }, "באיחור = לפני היום; בתוך החודש = היום עד 30 יום");
  assert.deepEqual(r.md.map((m) => [m.state, m.overdue, m.due_soon]), [["overdue", 1, 2]]);

  // מצב המועד לכל ליקוי — מה-SQL, באותם כללים; ליקוי שבוצע — בלי מצב
  const ins = (await one(MGR, `SELECT public.inspection_site($1) j`, [cnt.code])).j;
  assert.deepEqual(ins.machines.map((m) => [m.state, m.overdue, m.due_soon]), [["overdue", 1, 2]]);
  const states = ins.reports[0].defects.map((d) => [d.body, d.due_state]);
  assert.deepEqual(states, [["ליקוי א", "overdue"], ["ליקוי ב", "soon"], ["ליקוי ג", "soon"], ["ליקוי ד", null]]);
  await done(OPR, ins.reports[0].defects[0].id);
  const ins2 = (await one(MGR, `SELECT public.inspection_site($1) j`, [cnt.code])).j;
  assert.equal(ins2.reports[0].defects[0].due_state, null, "ליקוי שבוצע — אין לו מצב מועד");
  assert.equal(ins2.status.inspection_state, "soon", "אחרי שהבאיחור בוצע — נשארו שניים בתוך החודש: צהוב");

  // אתר עם שני מתקנים — החמור קובע, והפירוט שומר את כל אחד
  const two = async (a, b) => {
    const s = await newSite();
    const pa = await periodic(s, { machine: "A", ...a.o }); if (a.after) await a.after(pa);
    const pb = await periodic(s, { machine: "B", ...b.o }); if (b.after) await b.after(pb);
    const x = await row(s);
    return [x.s, ...x.md.map((m) => m.state)];
  };
  const FIX = { o: { valid: VALID, defects: [{ body: "גדר", due_on: far }] } };
  const AWAIT = { o: { valid: VALID, defects: [{ body: "גדר", due_on: far }] }, after: closeAll };
  const OK = { o: { valid: VALID } };
  const LATE = { o: { valid: VALID, defects: [{ body: "גדר", due_on: past }] } };
  assert.deepEqual(await two(FIX, AWAIT), ["awaiting", "fixing", "awaiting"], "צהוב חזק מעל ירוק");
  assert.deepEqual(await two(OK, FIX), ["fixing", "ok", "fixing"], "ירוק מעל שחור-לבן");
  assert.deepEqual(await two(LATE, { o: { ...EXP } }), ["expired", "overdue", "expired"], "אדום מעל כתום");
});

test("6 · audit_log: מזהים, ספירות ושמות שדות בלבד — אין טקסט חופשי (D22)", { skip }, async () => {
  const rows = await sup(`SELECT action, details FROM audit_log WHERE action LIKE 'inspection.%' OR action LIKE 'pm.%'`);
  assert.ok(rows.length >= 20, `רק ${rows.length} שורות`);
  // ⚠️ לא רק שמות המפתחות — גם צורת הערך. מפתח מותר ('fields') שנושא אובייקט של
  // לפני/אחרי היה מבריח טקסט חופשי תחת שם תמים, והבדיקה הישנה עברה עליו.
  const FIELD_NAMES = new Set(["inspected_on", "valid_until", "validity_source", "declared_clean", "report_number",
    "inspector_name", "inspector_license", "machine_no", "note", "machine_key", "body", "urgent", "due_on"]);
  const ENUMS = { kind: new Set(["periodic", "followup", "inspection_file", "pm_visit"]),
    validity_source: new Set(["document", "next_inspection", "manual", "inherited"]) };
  const COUNTS = new Set(["defects", "closed", "photos", "item_count", "reports", "files", "visits", "history", "reopened"]);
  const bad = [];
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.details ?? {})) {
      const ok = k.endsWith("_id") ? Number.isInteger(v)
        : COUNTS.has(k) ? Number.isInteger(v)
        : k === "bytes" ? (v === null || Number.isInteger(v))
        : k in ENUMS ? ENUMS[k].has(v)
        : k === "machine_key" ? (typeof v === "string" && v.length <= 40)
        : k === "declared_clean" ? typeof v === "boolean"
        : k === "fields" ? (Array.isArray(v) && v.every((x) => FIELD_NAMES.has(x)))
        : false;
      if (!ok) bad.push(`${r.action}:${k}=${JSON.stringify(v).slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, []);
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ["inspection.upload", "inspection.defect_delete", "inspection.defect_done", "pm.visit_submit",
    "inspection.report_update", "inspection.purge", "pm.purge"]) {
    assert.ok(actions.has(a), `חסרה פעולה ${a}`);
  }
  // כל טקסט חופשי שהחבילה כתבה — נאסף מהמסד עצמו, לא מרשימה קבועה של ארבע מחרוזות
  const free = (await sup(`
    SELECT DISTINCT x.t FROM (
      SELECT body t FROM inspection_defects UNION ALL SELECT done_by_name FROM inspection_defects
      UNION ALL SELECT done_note FROM inspection_defects UNION ALL SELECT deleted_reason FROM inspection_defects
      UNION ALL SELECT note FROM inspection_reports UNION ALL SELECT deleted_reason FROM inspection_reports
      UNION ALL SELECT inspector_name FROM inspection_reports UNION ALL SELECT retired_reason FROM inspection_machines
      UNION ALL SELECT label FROM inspection_machines UNION ALL SELECT performer_name FROM pm_visits
      UNION ALL SELECT vendor FROM pm_visits UNION ALL SELECT note FROM pm_visits UNION ALL SELECT deleted_reason FROM pm_visits
      UNION ALL SELECT note FROM pm_visit_items UNION ALL SELECT reason FROM compliance_history
      UNION ALL SELECT full_name FROM app_users) x
     WHERE x.t ~ '[א-ת]' AND length(x.t) >= 3`)).map((x) => x.t);
  assert.ok(free.length >= 15, `רק ${free.length} מחרוזות חופשיות נאספו — הבדיקה לא רואה כלום`);
  for (const must of ["אחרי שינוי קוד", "הוזן בטעות", "טכנאי שטח"]) assert.ok(free.includes(must), `לא נאסף: ${must}`);
  for (const uid of [AGT, INT]) {
    const seen = await rpc(uid, `SELECT details::text t FROM audit_log WHERE action LIKE 'inspection.%' OR action LIKE 'pm.%'`);
    assert.ok(seen.length > 0, "הסוכן רואה את audit_log — ולכן אסור שיהיה בו טקסט");
    const leaks = free.filter((t) => seen.some((x) => x.t.includes(t)));
    assert.deepEqual(leaks, [], "טקסט חופשי דלף ל-audit_log");
  }
});

test("29 · הקובץ אידמפוטנטי — גם כששינוי ב-RETURNS TABLE מוחל פעמיים (DROP קודם)", { skip }, async () => {
  const file = path.join(h.MASTER, "db", "compliance.postgres.sql");
  const src = fs.readFileSync(file, "utf8");
  await h.pg.exec(src);
  await h.pg.exec(src);
  const from = "RETURNS TABLE (db_bytes bigint, blob_bytes bigint, blob_rows bigint)";
  assert.ok(src.includes(from), "הצורה של compliance_storage השתנתה — לעדכן את הבדיקה");
  await h.pg.exec(src.replace(from, "RETURNS TABLE (db_bytes bigint, blob_bytes bigint, blob_rows bigint, extra_col integer)"));
  await h.pg.exec(src);
  const cols = await sup(`SELECT pg_get_function_result('public.compliance_storage()'::regprocedure) r`);
  assert.doesNotMatch(cols[0].r, /extra_col/);
  // ⚠️ DROP מוחק הרשאות — ה-GRANT שאחריו חייב להחזיר אותן
  const x = await sup(`SELECT has_function_privilege('authenticated', 'public.compliance_storage()', 'EXECUTE') a,
                              has_function_privilege('anon', 'public.compliance_storage()', 'EXECUTE') n`);
  assert.deepEqual(x[0], { a: true, n: false });
  assert.doesNotMatch(src.replace(/--.*$/gm, ""), /cron\.schedule/, "תזמונים שייכים ל-cron.postgres.sql");
});

test("30 · אין overloads: שם אחד = פונקציה אחת", { skip }, async () => {
  const r = await sup(`SELECT p.proname, count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','app') AND (p.proname LIKE 'inspection\\_%' OR p.proname LIKE 'pm\\_%'
       OR p.proname LIKE 'compliance\\_%' OR p.proname = 'site_compliance')
    GROUP BY p.proname HAVING count(*) > 1`);
  assert.deepEqual(r, []);
});
