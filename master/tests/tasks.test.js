// tests/tasks.test.js — משימות של אתר (לביצוע → בטיפול → בוצעה; קשרי לקוחות / טכני), על Postgres 17 מקומי.
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
// רק sherut@parkomat.co.il מסמן "בוצעה" (11/10/2026). בכוונה בקר ולא מנהל: הכלל הוא החשבון,
// לא התפקיד. ושני מתחזים — שם מוצג זהה, ומייל שמכיל את המילה.
const SRV = "b1000000-0000-0000-0000-000000000007";
const IMP = "b1000000-0000-0000-0000-000000000008";
const XSR = "b1000000-0000-0000-0000-000000000009";

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
const list = async (uid, kind = null, site = null, limit = 200) =>
  (await one(uid, `SELECT public.tasks_list($1, $2, $3::int) AS j`, [kind, site, limit])).j;
const done = async (uid, id) => (await one(uid, `SELECT public.task_done($1) AS d`, [id])).d;
const start = async (uid, id) => (await one(uid, `SELECT public.task_start($1) AS s`, [id])).s;
const unstart = async (uid, id) => one(uid, `SELECT public.task_unstart($1)`, [id]);
const findIn = (j, id) => [...j.open, ...j.done].find((t) => Number(t.id) === id);
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
      ('tk-intake@parkomat.co.il',NULL,'operator',true,$5,$6),
      ('sherut@parkomat.co.il','שירות','operator',true,$7,$6),
      ('tk-imp@parkomat.co.il','sherut@parkomat.co.il','manager',true,$8,$6),
      ('xsherut@parkomat.co.il','שירות','manager',true,$9,$6)`, [MGR, OPR, OPR2, OFF, INT, now, SRV, IMP, XSR]);
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
  // tasks_list, task_add, task_counts, task_start, task_unstart, task_done
  assert.equal(fns.length, 6, JSON.stringify(fns));
  assert.deepEqual(fns.filter((f) => f.anon).map((f) => f.sig), []);
  await fails(h.as("anon", null, (tx) => tx.query(`SELECT public.tasks_list(NULL, NULL)`)), "42501", /permission denied/);
  // גם מנהל אינו קורא את הטבלאות ישירות — רק דרך ה-RPC (ההיסטוריה כמו המשימות)
  for (const uid of [MGR, OPR, AGT]) {
    for (const t of ["tasks", "task_history"]) {
      await fails(rpc(uid, `SELECT * FROM ${t}`), "42501", /permission denied/);
      await fails(rpc(uid, `DELETE FROM ${t}`), "42501", /permission denied/);
    }
  }
  const grants = await sup(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
                             WHERE table_name IN ('tasks', 'task_history') AND grantee IN ('anon','authenticated','service_role','PUBLIC')`);
  assert.deepEqual(grants, []);
  // וגם אם הרשאה תחזור יום אחד — RLS בלי מדיניות לא מחזיר שורה
  const rls = await sup(`SELECT relname FROM pg_class WHERE relname IN ('tasks', 'task_history') AND relrowsecurity ORDER BY relname`);
  assert.deepEqual(rls.map((r) => r.relname), ["task_history", "tasks"]);
});

test("T2 · סוכן, מושבת וזהות הקליטה: כל RPC נדחה ב-42501, וספירות — אפס שורות ולא שגיאה", { skip }, async () => {
  for (const uid of [AGT, OFF, INT]) {
    await fails(list(uid), "42501");
    await fails(add(uid, "customer", "לא אמור להיכנס"), "42501");
    await fails(start(uid, 1), "42501");
    await fails(unstart(uid, 1), "42501");
    await fails(done(uid, 1), "42501");
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
  assert.equal(ca.can_close, false, "מנהל אחר — לא מסמן");
  assert.equal((await list(SRV, "customer")).open.find((t) => Number(t.id) === a).can_close, true);
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
  const d1 = await done(SRV, id);
  const d2 = await done(MGR, id);
  assert.equal(d1, d2, "אידמפוטנטי — וגם מי שאינו רשאי לסמן מקבל את הסימון הקיים, לא שגיאה");
  const j = await list(OPR, "technical");
  assert.ok(!j.open.some((t) => Number(t.id) === id));
  const t = j.done.find((x) => Number(x.id) === id);
  assert.deepEqual({ by: t.done_by, at: t.done_at }, { by: "שירות", at: d1 });
  assert.equal((await sup(`SELECT count(*)::int n FROM tasks WHERE id = $1`, [id]))[0].n, 1, "לא נמחקה");
  await fails(done(OPR, 999999), "PT404", /לא נמצאה/);
  // האילוץ: בוצעה בלי מי, או מי בלי מתי — לא אפשרי גם מתחת ל-RPC
  await fails(sup(`UPDATE tasks SET done_by = NULL WHERE id = $1`, [id]), "23514");
});

test("T6 · סדר: פתוחות מהוותיקה לחדשה (טבלה צומחת), בוצעו — מהאחרונה; 200 כברירת מחדל, NULL — כולן", { skip }, async () => {
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
  // "שיראו את כל ההסטוריה": בלי תקרה — כולן, באותו סדר
  j = await list(OPR, null, s2.code, null);
  assert.equal(j.done.length, 205);
  assert.deepEqual([j.done[0].body, j.done.at(-1).body], ["ישנה 205", "ישנה 1"]);
  j = await list(OPR, null, s2.code, 3);
  assert.deepEqual(j.done.map((t) => t.body), ["ישנה 205", "ישנה 204", "ישנה 203"]);
  assert.equal(Number(j.done_total), 205, "המספר הכולל לא תלוי בתקרה");
  // ⚠️ התקרה חלה על שבוצעו בלבד — פתוחה לעולם לא נחתכת
  j = await list(OPR, null, s.code, 0);
  assert.equal(j.open.length, 3);
  await fails(list(OPR, null, s2.code, -1), "23514", /לא תקין/);
  // חבילה ישנה בדפדפן קוראת בשני פרמטרים — עדיין עובד (ברירת המחדל 200)
  const old = (await one(OPR, `SELECT public.tasks_list($1, $2) AS j`, [null, s2.code])).j;
  assert.equal(old.done.length, 200);
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

test("T8 · ספירות לכפתורים: פתוחות בלבד (גם בטיפול), שורה לכל אתר×סוג", { skip }, async () => {
  await sup(`DELETE FROM task_history`);
  await sup(`DELETE FROM tasks`);
  const s = await newSite();
  const t = await newSite();
  await add(OPR, "customer", "ק1", s.code);
  await add(OPR, "customer", "ק2", s.code);
  await add(OPR, "technical", "ט1", s.code);
  const taken = await add(OPR, "technical", "ט2", t.code);
  await start(OPR2, taken);                  // בטיפול — עדיין פתוחה, ונספרת
  const closed = await add(OPR, "technical", "ט3", t.code);
  await start(OPR, closed);
  await done(SRV, closed);
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
  await start(OPR, id);
  await start(OPR2, id);                     // כבר בטיפול — לא כתיבה, ולכן לא אירוע ולא יומן
  await unstart(MGR, id);
  await unstart(MGR, id);                    // כבר לביצוע — כנ"ל
  await done(SRV, id);
  const s2 = await newSite();
  await add(OPR, "customer", "לאתר אחר", s2.code);
  const ev = await sup(`SELECT site_code, type, payload FROM events WHERE id > $1 ORDER BY id`, [before]);
  assert.deepEqual(ev.map((e) => [e.type, e.site_code, e.payload.action, e.payload.kind]),
    [["tasks", s.code, "add", "technical"], ["tasks", s.code, "start", "technical"], ["tasks", s.code, "unstart", "technical"],
     ["tasks", s.code, "done", "technical"], ["tasks", s2.code, "add", "customer"]]);
  const audit = await sup(`SELECT action, details::text d FROM audit_log WHERE action LIKE 'task.%' AND target_id = $1 ORDER BY id`, [String(id)]);
  assert.deepEqual(audit.map((a) => a.action), ["task.add", "task.start", "task.unstart", "task.done"]);
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

test("T11 · רק sherut@parkomat.co.il מסמן בוצעה — בשני הסוגים, לפי המייל של הזהות המאומתת", { skip }, async () => {
  const s = await newSite();
  const c = await add(OPR, "customer", "להתקשר ללקוח", s.code);
  const t = await add(OPR, "technical", "לגרז שרשרת", s.code);
  // כל אחד אחר — גם מנהל, גם מי שהשם המוצג שלו הוא המייל, גם מייל שמכיל את המילה — לא
  for (const uid of [OPR, OPR2, MGR, IMP, XSR]) {
    for (const id of [c, t]) await fails(done(uid, id), "42501", /אין הרשאה/);
    assert.ok((await list(uid, null, s.code)).open.every((x) => x.can_close === false), "הכפתור מוסתר לפי אותה פונקציה");
  }
  assert.ok((await list(SRV, null, s.code)).open.every((x) => x.can_close === true));
  assert.ok(await done(SRV, c));
  assert.ok(await done(SRV, t));
  // מייל באותיות גדולות או עם רווחים — עדיין אותו חשבון
  const t2 = await add(OPR, "technical", "להחליף נורה", s.code);
  await sup(`UPDATE app_users SET email = ' Sherut@Parkomat.co.il ' WHERE supabase_uid = $1`, [SRV]);
  try {
    assert.ok(await done(SRV, t2));
  } finally {
    await sup(`UPDATE app_users SET email = 'sherut@parkomat.co.il' WHERE supabase_uid = $1`, [SRV]);
  }
  // חשבון מושבת — לא צוות, ולכן לא מסמן (ולא נכנס בכלל)
  const t3 = await add(OPR, "customer", "לחזור ללקוח", s.code);
  await sup(`UPDATE app_users SET is_active = false WHERE supabase_uid = $1`, [SRV]);
  try {
    await fails(done(SRV, t3), "42501");
  } finally {
    await sup(`UPDATE app_users SET is_active = true WHERE supabase_uid = $1`, [SRV]);
  }
  assert.equal(findIn(await list(MGR, null, s.code), t3).state, "todo");
});

test("T12 · הקובץ אידמפוטנטי — החלה שנייה לא נכשלת ולא מכפילה", { skip }, async () => {
  const fs = require("node:fs"), path = require("node:path");
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "tasks.postgres.sql"), "utf8");
  const n0 = (await sup(`SELECT count(*)::int n FROM tasks`))[0].n;
  const hist = async () => (await sup(`SELECT count(*)::int n FROM task_history`))[0].n;
  await h.pg.exec(sql);
  const h1 = await hist();
  await h.pg.exec(sql);
  assert.equal((await sup(`SELECT count(*)::int n FROM tasks`))[0].n, n0);
  assert.equal(await hist(), h1, "ההשלמה של ההיסטוריה לא מכפילה בהחלה חוזרת");
  const over = await sup(`SELECT proname, count(*)::int n FROM pg_proc
                           WHERE proname IN ('tasks_list','task_add','task_done','task_counts','task_start','task_unstart')
                           GROUP BY proname HAVING count(*) > 1`);
  assert.deepEqual(over, [], "שם אחד = פונקציה אחת — PostgREST מסרב לשתי חתימות");
  const sig = await sup(`SELECT pg_get_function_identity_arguments(oid) a FROM pg_proc WHERE proname = 'tasks_list'`);
  assert.deepEqual(sig.map((r) => r.a), ["p_kind text, p_site_code text, p_done_limit integer"]);
});

test("T13 · שלושה מצבים: לביצוע → בטיפול → בוצעה, החזרה לביצוע, וכל המעברים בהיסטוריה", { skip }, async () => {
  const s = await newSite();
  const id = await add(OPR, "technical", "לגרז שרשרת", s.code);
  let t = findIn(await list(MGR, null, s.code), id);
  assert.deepEqual({ state: t.state, at: t.started_at, by: t.started_by }, { state: "todo", at: null, by: null });

  // לטיפול — מי ומתי
  const s1 = await start(OPR2, id);
  t = findIn(await list(MGR, null, s.code), id);
  assert.deepEqual({ state: t.state, at: t.started_at, by: t.started_by }, { state: "in_progress", at: s1, by: "בקר שני" });
  assert.ok((await list(MGR, null, s.code)).open.some((x) => Number(x.id) === id), "בטיפול — עדיין ברשימת הפתוחות");
  // ⚠️ שני אנשים לחצו: הראשון לקח, והשני אינו דורס אותו
  assert.equal(await start(MGR, id), s1);
  assert.equal(findIn(await list(MGR, null, s.code), id).started_by, "בקר שני");
  const uid = async () => (await sup(`SELECT started_by_user u FROM tasks WHERE id = $1`, [id]))[0].u;
  assert.equal(await uid(), (await sup(`SELECT id FROM app_users WHERE supabase_uid = $1`, [OPR2]))[0].id);

  // החזרה לביצוע: העמודות מתאפסות — כולן
  await unstart(MGR, id);
  t = findIn(await list(MGR, null, s.code), id);
  assert.deepEqual({ state: t.state, at: t.started_at, by: t.started_by }, { state: "todo", at: null, by: null });
  assert.equal(await uid(), null);
  await unstart(MGR, id);                    // כבר לביצוע — כלום

  // שוב לטיפול, ובוצעה מבטיפול
  await start(OPR, id);
  const d = await done(SRV, id);
  const j = await list(MGR, null, s.code);
  assert.ok(!j.open.some((x) => Number(x.id) === id));
  t = j.done.find((x) => Number(x.id) === id);
  assert.deepEqual({ state: t.state, at: t.done_at, by: t.done_by, started: t.started_by },
    { state: "done", at: d, by: "שירות", started: "בקר משימות" }, "started_* נשארות: המשימה הייתה בטיפול");
  // ⚠️ ההיסטוריה זוכרת גם את מה שהעמודות כבר שכחו (הלקיחה הראשונה וההחזרה)
  assert.deepEqual(t.history.map((x) => [x.action, x.by]), [
    ["created", "בקר משימות"], ["started", "בקר שני"], ["unstarted", "מנהלת משימות"],
    ["started", "בקר משימות"], ["done", "שירות"]]);
  assert.equal(t.history[1].at, s1);
  assert.equal(t.history.at(-1).at, d);
  assert.ok(t.history.every((x, i) => i === 0 || x.at >= t.history[i - 1].at), "מהראשון לאחרון");

  // "בוצעה" סופי
  await fails(start(OPR, id), "PT409", /כבר בוצעה/);
  await fails(unstart(OPR, id), "PT409", /כבר בוצעה/);
  assert.equal(await done(OPR, id), d);
  assert.equal((await sup(`SELECT count(*)::int n FROM task_history WHERE task_id = $1`, [id]))[0].n, 5,
    "פעולה שלא שינתה כלום אינה נרשמת");
  await fails(start(OPR, 999999), "PT404", /לא נמצאה/);
  await fails(unstart(OPR, 999999), "PT404", /לא נמצאה/);

  // ישר מלביצוע לבוצעה — מותר, בלי "בטיפול"
  const id2 = await add(OPR, "customer", "להתקשר ללקוח", s.code);
  await done(SRV, id2);
  const t2 = findIn(await list(MGR, null, s.code), id2);
  assert.deepEqual({ state: t2.state, started: t2.started_at, steps: t2.history.map((x) => x.action) },
    { state: "done", started: null, steps: ["created", "done"] });

  // ⚠️ מי שאינו רשאי לסגור — עדיין לוקח ומחזיר
  const id3 = await add(OPR, "technical", "להחליף נורה", s.code);
  await start(OPR, id3);
  await unstart(OPR, id3);
  await fails(done(OPR, id3), "42501", /אין הרשאה/);
});

test("T14 · משימה מלפני היומן מקבלת היסטוריה ממה שהעמודות יודעות — פעם אחת", { skip }, async () => {
  const fs = require("node:fs"), path = require("node:path");
  const s = await newSite();
  const ids = (await sup(`INSERT INTO tasks (client_id, kind, site_id, site_code, body, created_by, created_at, done_at, done_by)
      VALUES (gen_random_uuid(), 'technical', $1, $2, 'ישנה פתוחה', 'אנה', '2026-10-07T08:00:00.000Z', NULL, NULL),
             (gen_random_uuid(), 'customer',  $1, $2, 'ישנה שבוצעה', 'בני', '2026-10-07T09:00:00.000Z', '2026-10-08T10:00:00.000Z', 'גדי')
      RETURNING id`, [s.id, s.code])).map((r) => Number(r.id));
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "tasks.postgres.sql"), "utf8");
  await h.pg.exec(sql);
  await h.pg.exec(sql);
  const hist = await sup(`SELECT task_id, action, actor, at FROM task_history WHERE task_id IN (${ids.join(",")}) ORDER BY task_id, id`);
  assert.deepEqual(hist.map((r) => [Number(r.task_id), r.action, r.actor, r.at]), [
    [ids[0], "created", "אנה", "2026-10-07T08:00:00.000Z"],
    [ids[1], "created", "בני", "2026-10-07T09:00:00.000Z"],
    [ids[1], "done", "גדי", "2026-10-08T10:00:00.000Z"]]);
  const j = await list(MGR, null, s.code);
  assert.deepEqual(findIn(j, ids[0]).history.map((x) => [x.action, x.by]), [["created", "אנה"]]);
  // ומכאן היא ממשיכה כמו כל משימה
  await start(OPR, ids[0]);
  assert.deepEqual(findIn(await list(MGR, null, s.code), ids[0]).history.map((x) => x.action), ["created", "started"]);
});

test("T15 · אילוצים: בטיפול בלי מי — לא; פעולה לא מוכרת בהיסטוריה — לא; משימה עם היסטוריה לא נמחקת", { skip }, async () => {
  const s = await newSite();
  const id = await add(OPR, "technical", "בדיקת אילוץ", s.code);
  await fails(sup(`UPDATE tasks SET started_at = '2026-10-11T08:00:00.000Z' WHERE id = $1`, [id]), "23514");
  await start(OPR, id);
  await fails(sup(`UPDATE tasks SET started_by = NULL WHERE id = $1`, [id]), "23514");
  await fails(sup(`INSERT INTO task_history (task_id, action, actor, at) VALUES ($1, 'deleted', 'x', '2026-10-11T08:00:00.000Z')`, [id]), "23514");
  // ⚠️ אין DELETE ב-RPC; ומחיקה ידנית נכשלת בקול במקום להעלים את ההיסטוריה איתה
  await fails(sup(`DELETE FROM tasks WHERE id = $1`, [id]), "23503");
});
