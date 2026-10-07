// tests/tasks.test.js — משימות (קשרי לקוחות / טכני), על Postgres 17 מקומי.
//
// רצות על `db.init()` האמיתי (tests/helpers/local-pg.js) — אותם קבצים, אותן הרשאות,
// אותו RLS. אף שורה לא נוגעת בייצור. הזהויות נזרעות כמו ב-compliance.test.js, כולל
// זהות הקליטה (operator פעיל שאינו "צוות").
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "b1000000-0000-0000-0000-000000000001";
const OPR = "b1000000-0000-0000-0000-000000000002";
const OPR2 = "b1000000-0000-0000-0000-000000000003";
const AGT = "b1000000-0000-0000-0000-000000000004";
const OFF = "b1000000-0000-0000-0000-000000000005";
const INT = "b1000000-0000-0000-0000-000000000006";

let h;
let seq = 0;
const uuid = () => crypto.randomUUID();
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
async function newSite(name) {
  const code = `TSK${++seq}`;
  const id = (await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$2,'ready','2026-01-01T00:00:00.000Z') RETURNING id`,
    [code, name ?? code]))[0].id;
  return { id, code };
}
const add = async (uid, kind, body, site = null, client = uuid()) =>
  Number((await one(uid, `SELECT public.task_add($1, $2, $3, $4::uuid) AS id`, [kind, body, site, client])).id);
const list = async (uid, kind = null, site = null) =>
  (await one(uid, `SELECT public.tasks_list($1, $2) AS j`, [kind, site])).j;
const done = async (uid, id) => (await one(uid, `SELECT public.task_done($1) AS d`, [id])).d;
const counts = async (uid) => rpc(uid, `SELECT kind, site_id, open FROM public.task_counts() ORDER BY kind NULLS LAST, site_id`);

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
      ('tk-mgr@parkomat.co.il','מנהלת משימות','manager',true,$1,$6),
      ('tk-op@parkomat.co.il','בקר משימות','operator',true,$2,$6),
      ('tk-op2@parkomat.co.il','בקר שני','operator',true,$3,$6),
      ('tk-off@parkomat.co.il','מושבת','operator',false,$4,$6),
      ('tk-intake@parkomat.co.il',NULL,'operator',true,$5,$6)`, [MGR, OPR, OPR2, OFF, INT, now]);
  const s = await newSite();
  await sup(`INSERT INTO app_users (email, role, is_active, supabase_uid, site_id, created_at)
             VALUES ('site-tk@parkomat.co.il','agent',true,$1,$2,$3)`, [AGT, s.id, now]);
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('intake_user_id', $1, 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [INT]);
});
after(async () => { if (h) await h.close(); });

test("T1 · anon: אף RPC של משימות אינו ניתן להרצה, והטבלה סגורה לכולם", { skip }, async () => {
  const fns = await sup(`SELECT p.oid::regprocedure::text sig, has_function_privilege('anon', p.oid, 'EXECUTE') anon
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND (p.proname LIKE 'task\\_%' OR p.proname = 'tasks_list')`);
  assert.equal(fns.length, 4, JSON.stringify(fns));
  assert.deepEqual(fns.filter((f) => f.anon).map((f) => f.sig), []);
  await fails(h.as("anon", null, (tx) => tx.query(`SELECT public.tasks_list(NULL, NULL)`)), "42501", /permission denied/);
  // גם מנהל אינו קורא את הטבלה ישירות — רק דרך ה-RPC
  for (const uid of [MGR, OPR, AGT]) {
    await fails(rpc(uid, `SELECT * FROM tasks`), "42501", /permission denied/);
    await fails(rpc(uid, `DELETE FROM tasks`), "42501", /permission denied/);
  }
  const grants = await sup(`SELECT grantee, privilege_type FROM information_schema.role_table_grants
                             WHERE table_name = 'tasks' AND grantee IN ('anon','authenticated','service_role','PUBLIC')`);
  assert.deepEqual(grants, []);
});

test("T2 · סוכן, מושבת וזהות הקליטה: כל RPC נדחה ב-42501, וספירות — אפס שורות ולא שגיאה", { skip }, async () => {
  for (const uid of [AGT, OFF, INT]) {
    await fails(list(uid), "42501");
    await fails(add(uid, "customer", "לא אמור להיכנס"), "42501");
    assert.deepEqual(await counts(uid), [], "הכפתורים נטענים עם רשימת האתרים — שגיאה כאן הייתה מפילה אותה");
  }
  assert.equal((await sup(`SELECT count(*)::int n FROM tasks`))[0].n, 0);
});

test("T3 · הוספה: מי הזין (השם המזוהה, לא מוקלד), לאתר; בלי אתר — נדחה; שגיאות ברורות", { skip }, async () => {
  const s = await newSite("חניון בדיקה");
  const a = await add(OPR, "customer", "  להודיע ללקוח שלא חנה כמו שצריך  ", s.code);
  const b = await add(MGR, "technical", "לגרז את המסילות", s.code);
  const cj = await list(MGR, "customer");
  const ca = cj.open.find((t) => Number(t.id) === a);
  assert.equal(ca.body, "להודיע ללקוח שלא חנה כמו שצריך", "רווחים בקצוות נחתכים");
  assert.equal(ca.created_by, "בקר משימות");
  assert.equal(ca.site_code, s.code);
  assert.equal(ca.can_close, true);
  const tj = await list(OPR, "technical");
  const tb = tj.open.find((t) => Number(t.id) === b);
  assert.deepEqual({ by: tb.created_by, code: tb.site_code, name: tb.site_name }, { by: "מנהלת משימות", code: s.code, name: "חניון בדיקה" });
  assert.ok(!tj.open.some((t) => Number(t.id) === a), "סוג אחר — לא ברשימה");
  // ⚠️ משימה נפתחת מכרטיס של אתר — בלי אתר אין לה רשימה שבה תופיע
  await fails(add(OPR, "customer", "בלי אתר"), "23514", /נדרש אתר/);
  await fails(add(OPR, "technical", "x", s.code), "23514", /ריק/);
  await fails(add(OPR, "technical", "א".repeat(2001), s.code), "23514", /ארוך/);
  await fails(add(OPR, "sales", "סוג אחר", s.code), "23514", /סוג משימה/);
  await fails(add(OPR, "technical", "לאתר שלא קיים", "NOPE"), "PT404", /אתר לא נמצא/);
});

test("T4 · שליחה חוזרת (אותו client_id) — משימה אחת", { skip }, async () => {
  const c = uuid();
  const s = await newSite();
  const a = await add(OPR, "customer", "לחזור ללקוח בעניין החשבונית", s.code, c);
  const b = await add(OPR2, "customer", "לחזור ללקוח בעניין החשבונית", s.code, c);
  assert.equal(a, b);
  assert.equal((await sup(`SELECT count(*)::int n FROM tasks WHERE client_id = $1`, [c]))[0].n, 1);
});

test("T5 · בוצעה: מי ומתי; סימון שני לא דורס את השם; המשימה לא נמחקת אלא עוברת ל'בוצעו'", { skip }, async () => {
  const id = await add(OPR, "technical", "להחליף נורה בכניסה", (await newSite()).code);
  const d1 = await done(OPR2, id);
  const d2 = await done(MGR, id);
  assert.equal(d1, d2, "אידמפוטנטי");
  const j = await list(OPR, "technical");
  assert.ok(!j.open.some((t) => Number(t.id) === id));
  const t = j.done.find((x) => Number(x.id) === id);
  assert.deepEqual({ by: t.done_by, at: t.done_at }, { by: "בקר שני", at: d1 });
  assert.equal((await sup(`SELECT count(*)::int n FROM tasks WHERE id = $1`, [id]))[0].n, 1, "לא נמחקה");
  await fails(done(OPR, 999999), "PT404", /לא נמצאה/);
  // האילוץ: בוצעה בלי מי, או מי בלי מתי — לא אפשרי גם מתחת ל-RPC
  await fails(sup(`UPDATE tasks SET done_by = NULL WHERE id = $1`, [id]), "23514");
});

test("T6 · סדר: פתוחות מהוותיקה לחדשה (טבלה צומחת), בוצעו — מהאחרונה; 200 אחרונות + המספר הכולל", { skip }, async () => {
  const s = await newSite();
  const ids = [];
  for (const [i, body] of ["ראשונה", "שנייה", "שלישית"].entries()) {
    ids.push(await add(OPR, "technical", `משימה ${body}`, s.code));
    await sup(`UPDATE tasks SET created_at = $2 WHERE id = $1`, [ids[i], `2026-10-0${i + 1}T08:00:00.000Z`]);
  }
  let j = await list(OPR, null, s.code);
  assert.deepEqual(j.open.map((t) => Number(t.id)), ids);
  // 205 שבוצעו — רק 200 נשלחות, הספירה מלאה
  const s2 = await newSite();
  await sup(`INSERT INTO tasks (client_id, kind, site_id, site_code, body, created_by, created_at, done_at, done_by)
             SELECT gen_random_uuid(), 'customer', $1, $2, 'ישנה ' || g, 'x', '2026-01-01T00:00:00.000Z',
                    to_char(timestamp '2026-02-01' + g * interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"'), 'y'
               FROM generate_series(1, 205) g`, [s2.id, s2.code]);
  j = await list(OPR, null, s2.code);
  assert.equal(j.done.length, 200);
  assert.equal(Number(j.done_total), 205);
  assert.equal(j.done[0].body, "ישנה 205", "האחרונה שבוצעה — ראשונה");
});

test("T7 · משימות של אתר: שני הסוגים, רק של האתר; אתר שלא קיים — PT404", { skip }, async () => {
  const s = await newSite();
  const other = await newSite();
  const a = await add(OPR, "customer", "להתקשר ללקוח של האתר", s.code);
  const b = await add(OPR, "technical", "לגרז שרשרת", s.code);
  await add(OPR, "technical", "של אתר אחר", other.code);
  const j = await list(MGR, null, s.code);
  assert.deepEqual(j.open.map((t) => Number(t.id)).sort(), [a, b].sort());
  assert.deepEqual(j.open.map((t) => t.kind).sort(), ["customer", "technical"]);
  await fails(list(MGR, null, "NOPE"), "PT404");
});

test("T8 · ספירות לכפתורים: פתוחות בלבד, שורה לכל אתר×סוג", { skip }, async () => {
  await sup(`DELETE FROM tasks`);
  const s = await newSite();
  const t = await newSite();
  await add(OPR, "customer", "ק1", s.code);
  await add(OPR, "customer", "ק2", s.code);
  await add(OPR, "technical", "ט1", s.code);
  await add(OPR, "technical", "ט2", t.code);
  const closed = await add(OPR, "technical", "ט3", t.code);
  await done(OPR, closed);
  const c = await counts(MGR);
  assert.deepEqual(c.map((r) => [r.kind, r.site_id, r.open]).sort(),
    [["customer", s.id, 2], ["technical", s.id, 1], ["technical", t.id, 1]].sort());
  // אתר שנמחק — המשימות שלו (site_id NULL) אינן מופיעות בספירה של אף כרטיס
  await sup(`DELETE FROM sites WHERE id = $1`, [t.id]);
  assert.ok(!(await counts(MGR)).some((r) => r.site_id == null));
});

test("T9 · כל כתיבה מפרסמת אירוע (type='tasks') לעדכון המסכים, וביומן — בלי גוף המשימה", { skip }, async () => {
  const s = await newSite();
  const before = Number((await sup(`SELECT COALESCE(max(id), 0) m FROM events`))[0].m);
  const id = await add(OPR, "technical", "סוד-גוף-המשימה", s.code);
  await done(MGR, id);
  const s2 = await newSite();
  await add(OPR, "customer", "לאתר אחר", s2.code);
  const ev = await sup(`SELECT site_code, type, payload FROM events WHERE id > $1 ORDER BY id`, [before]);
  assert.deepEqual(ev.map((e) => [e.type, e.site_code, e.payload.action, e.payload.kind]),
    [["tasks", s.code, "add", "technical"], ["tasks", s.code, "done", "technical"], ["tasks", s2.code, "add", "customer"]]);
  const audit = await sup(`SELECT action, details::text d FROM audit_log WHERE action LIKE 'task.%' AND target_id = $1 ORDER BY at`, [String(id)]);
  assert.deepEqual(audit.map((a) => a.action), ["task.add", "task.done"]);
  assert.ok(audit.every((a) => !a.d.includes("סוד-גוף-המשימה")), "audit_log קריא לכל משתמש פעיל — רק מזהים");
});

test("T10 · מחיקת אתר: המשימות נשארות עם קוד האתר (snapshot)", { skip }, async () => {
  const s = await newSite();
  const id = await add(OPR, "technical", "משימה לאתר שיימחק", s.code);
  await sup(`DELETE FROM sites WHERE id = $1`, [s.id]);
  const row = (await sup(`SELECT site_id, site_code FROM tasks WHERE id = $1`, [id]))[0];
  assert.deepEqual(row, { site_id: null, site_code: s.code });
  const j = await list(MGR, "technical");
  assert.equal(j.open.find((t) => Number(t.id) === id).site_code, s.code);
});

test("T11 · הרשאת הסימון — מקום אחד (app.can_close_task), וה-RPC מכבד אותו", { skip }, async () => {
  const id = await add(OPR, "customer", "לבדוק חסימה", (await newSite()).code);
  // מדמים את ההחלטה העתידית: רק מנהלים מסמנים
  await sup(`CREATE OR REPLACE FUNCTION app.can_close_task(p_kind text) RETURNS boolean
             LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$ SELECT app.is_manager() $$`);
  try {
    await fails(done(OPR, id), "42501", /אין הרשאה/);
    assert.equal((await list(OPR, "customer")).open.find((t) => Number(t.id) === id).can_close, false, "הכפתור מוסתר לפי אותה פונקציה");
    assert.ok(await done(MGR, id));
  } finally {
    await sup(`CREATE OR REPLACE FUNCTION app.can_close_task(p_kind text) RETURNS boolean
               LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$ SELECT app.is_staff() $$`);
  }
});

test("T12 · הקובץ אידמפוטנטי — החלה שנייה לא נכשלת ולא מכפילה", { skip }, async () => {
  const fs = require("node:fs"), path = require("node:path");
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "tasks.postgres.sql"), "utf8");
  const n0 = (await sup(`SELECT count(*)::int n FROM tasks`))[0].n;
  await h.pg.exec(sql);
  await h.pg.exec(sql);
  assert.equal((await sup(`SELECT count(*)::int n FROM tasks`))[0].n, n0);
  const over = await sup(`SELECT proname, count(*)::int n FROM pg_proc WHERE proname IN ('tasks_list','task_add','task_done','task_counts')
                           GROUP BY proname HAVING count(*) > 1`);
  assert.deepEqual(over, [], "שם אחד = פונקציה אחת");
});
