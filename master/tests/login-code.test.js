// tests/login-code.test.js — קוד כניסה במייל, 4 ספרות (20/10/2026). security.postgres.sql: login_codes, app.session_ok,
// login_code_status / _verify / _issue / _unsend, app.prune_login_codes.
//
// בעלת המוצר: "כל פעם כשמישהו רוצה להיכנס לדשבורד נשלח לו מהדשבורד למייל שהוא חיבר כשהוא נרשם מייל עם קוד בן 4
// ספרות". ההחלטות: בכל התחברות חדשה, לכל המשתמשים, מאחורי מתג (settings.login_code_required: 'all' או רשימת מיילים).
//
// ⚠️ מה שנבדק כאן הוא האכיפה במסד — לא המסך: התחברות שלא אומתה אינה קוראת ואינה כותבת כלום, גם בלי דשבורד.
// הקריאות רצות כמו ש-PostgREST מריץ אותן: SET ROLE + תביעות JWT, כולל session_id.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "e1000000-0000-0000-0000-000000000001";
const ED = "e1000000-0000-0000-0000-000000000002";
const RO = "e1000000-0000-0000-0000-000000000003";
const AG = "e1000000-0000-0000-0000-000000000004";
const IN = "e1000000-0000-0000-0000-000000000005";
const OFF = "e1000000-0000-0000-0000-000000000006";
const S = (n) => `5e550000-0000-0000-0000-${String(n).padStart(12, "0")}`;

let h;
const sup = async (sql, params = []) => (await h.pg.query(sql, params)).rows;

// בקשה של משתמש מחובר: אסימון עם sub ו-session_id, בתפקיד authenticated
async function asUser(uid, sess, sql, params = []) {
  return h.pg.transaction(async (tx) => {
    const claims = { sub: uid, role: "authenticated" };
    if (sess) claims.session_id = sess;
    await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await tx.query(`SET LOCAL ROLE authenticated`);
    return (await tx.query(sql, params)).rows;
  });
}
const oneU = async (uid, sess, sql, params) => (await asUser(uid, sess, sql, params))[0];
// ה-Edge Function: זהות השירות (בלי sub)
async function asSvc(sql, params = [], role = "service_role") {
  return h.pg.transaction(async (tx) => {
    await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })]);
    await tx.query(`SET LOCAL ROLE ${role}`);
    return (await tx.query(sql, params)).rows;
  });
}
const issue = async (uid, sess, force = false) =>
  (await asSvc(`SELECT public.login_code_issue($1::uuid, $2::uuid, $3) j`, [uid, sess, force]))[0].j;
const verify = async (uid, sess, code) => (await oneU(uid, sess, `SELECT public.login_code_verify($1) j`, [code])).j;
const status = async (uid, sess) => (await oneU(uid, sess, `SELECT public.login_code_status() j`)).j;
const role = async (uid, sess) => (await oneU(uid, sess, `SELECT public.my_role() r`)).r;
const setFlag = async (v) => {
  await sup(`DELETE FROM settings WHERE key = 'login_code_required'`);
  if (v !== null) await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('login_code_required', $1, 'x')`, [v]);
};
const other = (code) => String((Number(code) + 1) % 10000).padStart(4, "0");
async function fails(p, code, re) {
  await assert.rejects(p, (e) => {
    if (code) assert.equal(e.code, code, `ציפיתי ל-${code}, התקבל ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
}

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  // ⚠️ בייצור RLS דלוק על כל הטבלאות (Supabase מדליק אותו לכל טבלה חדשה); מקומית — רק איפה שהקבצים מדליקים
  await sup(`ALTER TABLE sites ENABLE ROW LEVEL SECURITY`);
  await sup(`ALTER TABLE app_users ENABLE ROW LEVEL SECURITY`);
  const now = new Date().toISOString();
  const site = (await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ('LC1','אתר','ready',$1) RETURNING id`, [now]))[0].id;
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, site_id, created_at) VALUES
      ('lc-mgr@parkomat.co.il','מנהלת','manager',true,$1,NULL,$7),
      ('lc-ed@parkomat.co.il','עורך','editor',true,$2,NULL,$7),
      ('lc-ro@parkomat.co.il','בקר','operator',true,$3,NULL,$7),
      ('site-lc1@parkomat.co.il','סוכן','agent',true,$4,$8,$7),
      ('intake@parkomat.co.il','קליטה','manager',true,$5,NULL,$7),
      ('lc-off@parkomat.co.il','מושבת','manager',false,$6,NULL,$7)`, [MGR, ED, RO, AG, IN, OFF, now, site]);
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('intake_user_id', $1, 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [IN]);
});
after(async () => { if (h) await h.close(); });

test("כבוי: בלי המפתח — הכול כמו קודם, והמסך יודע שאין צורך בקוד", { skip }, async () => {
  await setFlag(null);
  assert.equal(await role(MGR, S(1)), "manager");
  assert.equal((await oneU(MGR, S(1), `SELECT app.is_active_user() a`)).a, true);
  assert.ok(Number((await oneU(MGR, S(1), `SELECT count(*) n FROM sites`)).n) >= 1);
  assert.deepEqual(await status(MGR, S(1)), { required: false, verified: true, email: "lc-mgr@parkomat.co.il" });
  assert.equal((await issue(MGR, S(1))).status, "not_required");
});

test("דלוק: התחברות שלא אומתה — אינה מנהלת, אינה קוראת ואינה כותבת", { skip }, async () => {
  await setFlag("all");
  assert.equal(await role(MGR, S(2)), "unverified");
  const g = await oneU(MGR, S(2), `SELECT app.is_manager() m, app.can_edit() e, app.is_staff() s, app.is_active_user() a,
                                          app.current_app_user() u`);
  assert.deepEqual(g, { m: false, e: false, s: false, a: false, u: null });
  // RLS: אפס שורות, בלי שגיאה
  assert.equal(Number((await oneU(MGR, S(2), `SELECT count(*) n FROM sites`)).n), 0);
  assert.equal(Number((await oneU(MGR, S(2), `SELECT count(*) n FROM app_users`)).n), 0);
  // קריאה דרך RPC, וכתיבה
  await fails(asUser(MGR, S(2), `SELECT public.tasks_list(NULL, NULL)`), "42501");
  await fails(asUser(MGR, S(2), `SELECT app.require_manager()`), "42501");
  await fails(asUser(ED, S(2), `SELECT app.require_editor()`), "42501");
  await fails(asUser(MGR, S(2), `SELECT * FROM public.list_users()`), "42501");
  assert.deepEqual(await status(MGR, S(2)), { required: true, verified: false, email: "lc-mgr@parkomat.co.il" });
  // ובלי session_id באסימון — אין דרך לאמת, ולכן גם אין גישה
  assert.equal(await role(MGR, null), "unverified");
  assert.deepEqual(await verify(MGR, null, "1234"), { ok: false, error: "no_session" });
});

test("הנפקה ואימות: קוד שגוי נספר, קוד נכון פותח — רק את ההתחברות הזו", { skip }, async () => {
  await setFlag("all");
  const a = await issue(MGR, S(3));
  assert.equal(a.status, "send");
  assert.match(a.code, /^\d{4}$/);
  assert.equal(a.email, "lc-mgr@parkomat.co.il");
  assert.equal(a.name, "מנהלת");
  assert.equal(a.ttl_min, 10);
  // הקוד אינו נשמר גלוי
  const row = (await sup(`SELECT code_hash FROM login_codes WHERE session_id = $1`, [S(3)]))[0];
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);

  // פתיחה מחדש של המסך — לא נשלח קוד נוסף; לחיצה על "שלח שוב" מיד — המתנה
  const p = await issue(MGR, S(3));
  assert.equal(p.status, "pending");
  assert.ok(p.resend_in > 55 && p.resend_in <= 60, `resend_in=${p.resend_in}`);
  const w = await issue(MGR, S(3), true);
  assert.equal(w.status, "wait");
  assert.ok(w.resend_in > 55 && w.resend_in <= 60);

  assert.deepEqual(await verify(MGR, S(3), other(a.code)), { ok: false, error: "wrong", left: 4 });
  assert.deepEqual(await verify(MGR, S(3), "12"), { ok: false, error: "format" });   // לא נספר
  assert.deepEqual(await verify(MGR, S(3), other(other(a.code))), { ok: false, error: "wrong", left: 3 });
  assert.deepEqual(await verify(MGR, S(3), ` ${a.code} `), { ok: true });
  assert.equal(await role(MGR, S(3)), "manager");
  assert.equal((await oneU(MGR, S(3), `SELECT app.is_active_user() a`)).a, true);
  assert.ok(Number((await oneU(MGR, S(3), `SELECT count(*) n FROM sites`)).n) >= 1);
  assert.deepEqual(await status(MGR, S(3)), { required: true, verified: true, email: "lc-mgr@parkomat.co.il" });
  assert.deepEqual(await verify(MGR, S(3), "0000"), { ok: true });   // כבר מאומת
  assert.equal((await issue(MGR, S(3))).status, "verified");

  // אותו משתמש, התחברות אחרת — עדיין לא מאומת, והקוד של הראשונה אינו פותח אותה
  assert.equal(await role(MGR, S(4)), "unverified");
  const b = await issue(MGR, S(4));
  assert.equal(b.status, "send");
  if (b.code !== a.code) assert.equal((await verify(MGR, S(4), a.code)).ok, false);
  // משתמש אחר אינו יכול לאמת את ההתחברות של מנהלת
  assert.deepEqual(await verify(ED, S(4), b.code), { ok: false, error: "none" });
  assert.equal(await role(MGR, S(4)), "unverified");
  // ⚠️ ואינו יכול לבקש קוד ל-session שלה
  await fails(issue(ED, S(4)), "42501");
});

test("הקוד אקראי: 4 ספרות, ואינו חוזר על עצמו בין התחברויות", { skip }, async () => {
  await setFlag("all");
  const codes = [];
  for (let i = 0; i < 8; i++) {
    await sup(`DELETE FROM login_code_sends WHERE user_id = $1`, [MGR]);
    codes.push((await issue(MGR, S(200 + i))).code);
  }
  assert.ok(codes.every((c) => /^\d{4}$/.test(c)), codes.join());
  assert.ok(new Set(codes).size >= 4, `רק ${new Set(codes).size} קודים שונים מתוך 8: ${codes.join()}`);
  await sup(`DELETE FROM login_code_sends WHERE user_id = $1`, [MGR]);
});

test("חמישה ניסיונות, תוקף 10 דקות, וקוד חדש מאפס את הספירה", { skip }, async () => {
  await setFlag("all");
  const a = await issue(ED, S(5));
  for (let i = 1; i <= 4; i++) assert.equal((await verify(ED, S(5), other(a.code))).error, "wrong");
  assert.deepEqual(await verify(ED, S(5), other(a.code)), { ok: false, error: "locked", left: 0 });
  assert.deepEqual(await verify(ED, S(5), a.code), { ok: false, error: "locked" });
  assert.equal(await role(ED, S(5)), "unverified");
  // נעול ופחות מדקה — המתנה, לא "קוד בתוקף"
  assert.equal((await issue(ED, S(5))).status, "wait");
  await sup(`UPDATE login_codes SET last_sent_at = now() - interval '61 seconds' WHERE session_id = $1`, [S(5)]);
  const b = await issue(ED, S(5));
  assert.equal(b.status, "send");
  assert.deepEqual(await verify(ED, S(5), b.code), { ok: true });

  const c = await issue(ED, S(6));
  await sup(`UPDATE login_codes SET expires_at = now() - interval '1 second' WHERE session_id = $1`, [S(6)]);
  assert.deepEqual(await verify(ED, S(6), c.code), { ok: false, error: "expired" });
  // פג תוקף ועברה דקה — פתיחת המסך שולחת חדש בלי "שלח שוב"
  await sup(`UPDATE login_codes SET last_sent_at = now() - interval '11 minutes' WHERE session_id = $1`, [S(6)]);
  assert.equal((await issue(ED, S(6))).status, "send");
});

test("תקרות: 5 קודים בשעה ו-20 ביממה לכל משתמש — גם על פני התחברויות שונות", { skip }, async () => {
  await setFlag("all");
  await sup(`DELETE FROM login_code_sends WHERE user_id = $1`, [RO]);
  for (let i = 0; i < 5; i++) {
    const r = await issue(RO, S(100 + i));
    assert.equal(r.status, "send", `שליחה ${i + 1}`);
  }
  assert.deepEqual(await issue(RO, S(110)), { status: "limit", email: "lc-ro@parkomat.co.il", per: "hour" });
  await sup(`UPDATE login_code_sends SET sent_at = now() - interval '2 hours' WHERE user_id = $1`, [RO]);
  assert.equal((await issue(RO, S(111))).status, "send");
  await sup(`INSERT INTO login_code_sends (user_id, sent_at) SELECT $1, now() - interval '3 hours' FROM generate_series(1, 15)`, [RO]);
  assert.equal((await issue(RO, S(112))).per, "day");
  await sup(`DELETE FROM login_code_sends WHERE user_id = $1`, [RO]);
});

test("המייל לא יצא (unsend): אפשר לשלוח מיד שוב, והשליחה עדיין בספירה", { skip }, async () => {
  await setFlag("all");
  await sup(`DELETE FROM login_code_sends WHERE user_id = $1`, [RO]);
  const a = await issue(RO, S(7));
  await asSvc(`SELECT public.login_code_unsend($1::uuid)`, [S(7)]);
  assert.deepEqual(await verify(RO, S(7), a.code), { ok: false, error: "none" });
  const b = await issue(RO, S(7));
  assert.equal(b.status, "send");
  assert.equal(Number((await sup(`SELECT count(*) n FROM login_code_sends WHERE user_id = $1`, [RO]))[0].n), 2);
  assert.deepEqual(await verify(RO, S(7), b.code), { ok: true });
  // אינו מבטל אימות שכבר נעשה
  await asSvc(`SELECT public.login_code_unsend($1::uuid)`, [S(7)]);
  assert.equal(await role(RO, S(7)), "operator");
});

test("פטורים: סוכן, זהות הקליטה, וקריאה בלי אסימון (השרת והשערים); משתמש מושבת לא מקבל קוד", { skip }, async () => {
  await setFlag("all");
  assert.equal(await role(AG, S(8)), "agent");
  const ag = await oneU(AG, S(8), `SELECT app.is_agent() a, app.agent_site_id() s`);
  assert.equal(ag.a, true);
  assert.ok(ag.s);
  assert.equal((await issue(AG, S(8))).status, "not_required");
  assert.equal((await status(AG, S(8))).required, false);
  assert.equal(await role(IN, S(9)), "intake");
  assert.equal((await issue(IN, S(9))).status, "not_required");
  // בלי אסימון — GUC של זהות, כמו שער בדיקה
  const guc = await h.pg.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.user_id', $1, true)`, [MGR]);
    return (await tx.query(`SELECT app.current_app_role() r, app.is_staff() s`)).rows[0];
  });
  assert.deepEqual(guc, { r: "manager", s: true });
  assert.equal((await issue(OFF, S(10))).status, "no_user");
});

test("פיילוט: רשימת מיילים (רישיות ורווחים לא משנים) — רק מי שבה צריך קוד", { skip }, async () => {
  await setFlag(" LC-Mgr@parkomat.co.il , someone@parkomat.co.il");
  assert.equal(await role(MGR, S(11)), "unverified");
  assert.equal(await role(ED, S(11)), "editor");
  assert.equal((await issue(ED, S(12))).status, "not_required");
  assert.equal((await issue(MGR, S(11))).status, "send");
  await setFlag("");   // ריק = אף אחד
  assert.equal(await role(MGR, S(13)), "manager");
});

test("הרשאות: ההנפקה לשירות בלבד; הטבלאות סגורות; הדפדפן קורא רק למצב ולאימות", { skip }, async () => {
  await setFlag("all");
  await fails(asUser(MGR, S(14), `SELECT public.login_code_issue($1::uuid, $2::uuid, false)`, [MGR, S(14)]), "42501");
  await fails(asUser(MGR, S(14), `SELECT public.login_code_unsend($1::uuid)`, [S(14)]), "42501");
  await fails(asSvc(`SELECT public.login_code_issue($1::uuid, $2::uuid, false)`, [MGR, S(14)], "anon"), "42501");
  await fails(asSvc(`SELECT public.login_code_status()`, [], "anon"), "42501");
  for (const t of ["login_codes", "login_code_sends"]) {
    await fails(asUser(MGR, S(3), `SELECT * FROM ${t}`), "42501");   // גם התחברות מאומתת
    await fails(asSvc(`SELECT * FROM ${t}`, [], "anon"), "42501");
  }
  await fails(asUser(MGR, S(3), `UPDATE login_codes SET verified_at = now()`), "42501");
  const grants = await sup(`SELECT p.proname n, has_function_privilege('authenticated', p.oid, 'EXECUTE') a,
                                   has_function_privilege('service_role', p.oid, 'EXECUTE') s
                              FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                             WHERE ns.nspname = 'public' AND p.proname LIKE 'login_code%' ORDER BY 1`);
  assert.deepEqual(grants, [
    { n: "login_code_issue", a: false, s: true },
    { n: "login_code_status", a: true, s: true },
    { n: "login_code_unsend", a: false, s: true },
    { n: "login_code_verify", a: true, s: true },
  ]);
});

test("גריפה: שורה של התחברות שכבר אינה — נמחקת; prune_auth_sessions מריץ אותה", { skip }, async () => {
  await sup(`DELETE FROM login_codes`);
  await sup(`DELETE FROM login_code_sends`);
  await sup(`INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)`, [S(20), MGR]);
  await sup(`INSERT INTO login_codes (session_id, user_id, created_at) VALUES
      ($1, $4, now() - interval '2 hours'), ($2, $4, now() - interval '2 hours'), ($3, $4, now())`, [S(20), S(21), S(22), MGR]);
  await sup(`INSERT INTO login_code_sends (user_id, sent_at) VALUES ($1, now() - interval '3 days'), ($1, now())`, [ED]);
  assert.equal((await sup(`SELECT app.prune_login_codes() n`))[0].n, 1);
  assert.deepEqual((await sup(`SELECT session_id s FROM login_codes ORDER BY 1`)).map((r) => r.s), [S(20), S(22)]);
  assert.equal(Number((await sup(`SELECT count(*) n FROM login_code_sends WHERE user_id = $1`, [ED]))[0].n), 1);
  // session ישן נגרף — והקוד שלו איתו
  await sup(`UPDATE auth.sessions SET updated_at = now() - interval '2 days', created_at = now() - interval '2 days' WHERE id = $1`, [S(20)]);
  await sup(`SELECT app.prune_auth_sessions(interval '1 day')`);
  assert.deepEqual((await sup(`SELECT session_id s FROM login_codes ORDER BY 1`)).map((r) => r.s), [S(22)]);
});
