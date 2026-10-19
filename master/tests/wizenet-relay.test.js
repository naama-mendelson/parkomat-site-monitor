// tests/wizenet-relay.test.js — עדכון קריאות בוויזנט דרך מחשבי אתרים (15/10/2026), על Postgres מקומי.
//
// db.init() האמיתי (tests/helpers/local-pg.js). כל צד בזהות שלו, כמו בייצור: הלוחץ (בקר/מנהל) מכניס לתור,
// הממסר (סוכן של אתר שמופיע ב-wizenet_relays) לוקח ומחזיר את התשובה של ויזנט כפי שהיא.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "d1000000-0000-0000-0000-000000000001";
const OPR = "d1000000-0000-0000-0000-000000000002";
const R1 = "d1000000-0000-0000-0000-000000000003";   // סוכן של אתר-ממסר
const R2 = "d1000000-0000-0000-0000-000000000004";   // סוכן של אתר-ממסר שני
const AG = "d1000000-0000-0000-0000-000000000005";   // סוכן של אתר רגיל
const INT = "d1000000-0000-0000-0000-000000000006";  // הקולט של ויזנט

let h;
let seq = 0;
let site1, site2, site3;
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
  const code = String(7600 + ++seq);
  const id = (await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready','2026-01-01T00:00:00.000Z') RETURNING id`,
    [code]))[0].id;
  return { id, code };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// קריאה כמו שוויזנט שולחים — בזהות הקולט
async function call(p) {
  const raw = JSON.stringify(p);
  await h.as("authenticated", INT, (tx) => tx.query(`INSERT INTO service_calls (raw, payload, source, received_at) VALUES ($1, $3::jsonb, 'wizenet', $2)`,
    [raw, new Date().toISOString(), raw]));
  await sleep(5);
}
const sys = async (sql, params = []) => (await h.as("postgres", R1, (tx) => tx.query(sql, params))).rows;
const setLists = async () => {
  await sup(`DELETE FROM wizenet_lookups`);
  await sys(`SELECT app.wizenet_lookups_store('status', $1::jsonb, 'x')`,
    [JSON.stringify([{ id: "148", name: "פתוחה" }, { id: "150", name: "סגורה" }, { id: "151", name: "בטיפול" }])]);
  await sys(`SELECT app.wizenet_lookups_store('type', $1::jsonb, 'x')`, [JSON.stringify([{ id: "1", name: "תקלה" }, { id: "2", name: "בירור" }])]);
};

const claim = async (uid, socket = true, version = "1.0.60") =>
  (await one(uid, `SELECT public.wizenet_claim($1, $2) AS j`, [socket, version])).j;
const complete = async (uid, id, attempt, results) =>
  (await one(uid, `SELECT public.wizenet_complete($1, $2, $3::jsonb) AS j`, [id, attempt, JSON.stringify(results)])).j;
const requestUpdate = async (uid, ticket, field, value) =>
  Number((await one(uid, `SELECT public.wizenet_request_update($1, $2, $3) AS id`, [ticket, field, value])).id);
const status = async (uid, id) => (await one(uid, `SELECT public.wizenet_request_status($1) AS j`, [id])).j;
const reset = async () => {
  await sup(`DELETE FROM wizenet_requests`);
  await sup(`UPDATE wizenet_relays SET enabled = true, polled_at = NULL`);
};
// ממסר "חי" = שאל ב-3 הדקות האחרונות. השאלה עצמה היא wizenet_claim, ולכן ממסר שעוד לא שאל — אינו חי.
const wake = async () => { assert.equal(await claim(R1), null); };

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  site1 = await newSite(); site2 = await newSite(); site3 = await newSite();
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
      ('wr-mgr@parkomat.co.il','מנהלת ממסר','manager',true,$1,$4),
      ('wr-op@parkomat.co.il','בקר ממסר','editor',true,$2,$4),
      ('wr-intake@parkomat.co.il',NULL,'operator',true,$3,$4)`, [MGR, OPR, INT, now]);
  await sup(`INSERT INTO app_users (email, role, is_active, supabase_uid, site_id, created_at) VALUES
      ('site-${site1.code}@parkomat.co.il','agent',true,$1,$4,$7),
      ('site-${site2.code}@parkomat.co.il','agent',true,$2,$5,$7),
      ('site-${site3.code}@parkomat.co.il','agent',true,$3,$6,$7)`, [R1, R2, AG, site1.id, site2.id, site3.id, now]);
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('intake_user_id', $1, 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [INT]);
  await sup(`INSERT INTO wizenet_relays (site_id) VALUES ($1), ($2)`, [site1.id, site2.id]);
  await call({ ticket_number: "880001", parking_code: `${site3.code}-1-02`, status: "148", ticket_type: "1" });
  await call({ ticket_number: "880002", parking_code: site3.code, status: "148", ticket_type: "1" });
});
after(async () => { if (h) await h.close(); });

test("R1 · מי ממסר: רק סוכן של אתר שברשימה ופעיל — לא סוכן אחר, לא מנהל, לא ממסר מושבת", { skip }, async () => {
  await reset();
  const me = async (uid) => (await one(uid, `SELECT public.wizenet_relay_me() AS b`)).b;
  assert.equal(await me(R1), true);
  assert.equal(await me(R2), true);
  assert.equal(await me(AG), false);
  assert.equal(await me(MGR), false, "מנהל אינו ממסר — agent_site_id מחזירה לו NULL");
  await sup(`UPDATE wizenet_relays SET enabled = false WHERE site_id = $1`, [site2.id]);
  assert.equal(await me(R2), false);
  // ⚠️ ממסר מושבת אינו נספר, וגם אינו "חי" אחרי שהושבת — גם אם שאל לפני רגע
  await sup(`UPDATE wizenet_relays SET polled_at = now()`);
  assert.deepEqual((await one(OPR, `SELECT public.wizenet_relays_status() AS j`)).j, { alive: 1, enabled: 1 });
  await fails(claim(R2), "42501", /אינו ממסר/);
  await fails(claim(AG), "42501", /אינו ממסר/);
  await fails(claim(MGR), "42501", /אינו ממסר/);
  await fails(complete(AG, 1, 1, []), "42501");
});

test("R2 · בלי ממסר חי — סירוב מיידי (503), ולא שורה שתחכה ותפוג; אחרי שממסר שאל — נכנס לתור", { skip }, async () => {
  await reset();
  await setLists();
  await fails(requestUpdate(OPR, "880001", "status", "151"), "PT503", /אין כרגע ממסר פעיל/);
  assert.equal((await sup(`SELECT count(*)::int n FROM wizenet_requests`))[0].n, 0);
  await wake();
  const st = await one(OPR, `SELECT public.wizenet_relays_status() AS j`);
  assert.deepEqual(st.j, { alive: 1, enabled: 2 });
  // ממסר ששאל לפני יותר מ-3 דקות — כבר אינו חי
  await sup(`UPDATE wizenet_relays SET polled_at = now() - interval '4 minutes'`);
  await fails(requestUpdate(OPR, "880001", "status", "151"), "PT503");
  await wake();
  const id = await requestUpdate(OPR, "880001", "status", "151");
  assert.ok(id > 0);
  assert.equal((await status(MGR, id)).state, "pending", "כל איש צוות רואה את מצב הבקשה");
});

test("R3 · בדיקות לפני התור: שדה, מספר קריאה, ערך, ערך שאינו ברשימה, קריאה שאינה אצלנו; ורק צוות", { skip }, async () => {
  await reset();
  await setLists();
  await wake();
  await fails(requestUpdate(OPR, "880001", "priority", "1"), "23514", /שדה לא מוכר/);
  await fails(requestUpdate(OPR, "88a001", "status", "151"), "23514", /מספר קריאה לא תקין/);
  await fails(requestUpdate(OPR, "000", "status", "151"), "23514", /מספר קריאה לא תקין/);
  await fails(requestUpdate(OPR, "", "status", "151"), "23514", /מספר קריאה לא תקין/);
  await fails(requestUpdate(OPR, "880001", "status", "x1"), "23514", /ערך לא תקין/);
  await fails(requestUpdate(OPR, "880001", "status", "999"), "23514", /ערך לא מוכר/);
  await fails(requestUpdate(OPR, "990999", "status", "151"), "PT404", /לא נמצאה/);
  for (const uid of [R1, AG, INT]) await fails(requestUpdate(uid, "880001", "status", "151"), "42501");
  for (const uid of [R1, AG, INT]) await fails(one(uid, `SELECT public.wizenet_request_lookups()`), "42501");
  for (const uid of [R1, AG]) await fails(status(uid, 1), "42501");
  await fails(status(OPR, 987654), "PT404", /הבקשה לא נמצאה/);
  assert.equal((await sup(`SELECT count(*)::int n FROM wizenet_requests`))[0].n, 0, "אף בקשה שנדחתה לא נכנסה לתור");
  // ⚠️ רווחים מסביב — נחתכים, ולא נדחים
  assert.ok(await requestUpdate(OPR, " 880001 ", "type", " 2 ") > 0);
});

test("R4 · הפעמון: שורת events מסוג service_calls עם המספר בלבד — בלי קריאה, ערך או שם", { skip }, async () => {
  await reset();
  await setLists();
  await wake();
  const before = Number((await sup(`SELECT COALESCE(max(id), 0) m FROM events`))[0].m);
  const id = await requestUpdate(OPR, "880001", "status", "151");
  const ev = await sup(`SELECT type, site_code, payload FROM events WHERE id > $1 ORDER BY id`, [before]);
  assert.deepEqual(ev, [{ type: "service_calls", site_code: "*", payload: { type: "service_calls", code: null, action: "relay", id } }]);
});

test("R5 · לקיחה: ממסר אחד לוקח, השני מקבל NULL; מה שנשלח — בדיוק הפונקציה והשדות של ויזנט; סימן חיים וגרסה", { skip }, async () => {
  await reset();
  await setLists();
  await wake();
  const a = await requestUpdate(OPR, "880001", "status", "151");
  const b = await requestUpdate(MGR, "880002", "type", "2");
  const c1 = await claim(R1, false, "1.0.60");
  assert.deepEqual(c1, { id: a, attempt: 1,
    calls: [{ func: "wizeApp_updateCallStatus", body: { callid: "880001", callstatusid: "151" } }] }, "הוותיקה ראשונה");
  const c2 = await claim(R2, true, "1.0.61");
  assert.deepEqual(c2.calls, [{ func: "wizeApp_updateCallType", body: { callid: "880002", calltypeid: "2" } }]);
  assert.equal(await claim(R1), null, "שתיהן נלקחו — אין עוד");
  const rel = await sup(`SELECT site_id, socket_ok, agent_version, polled_at > now() - interval '1 minute' AS fresh
                           FROM wizenet_relays ORDER BY site_id`);
  assert.deepEqual(rel.map((r) => [r.site_id, r.socket_ok, r.agent_version, r.fresh]),
    [[site1.id, true, "1.0.60", true], [site2.id, true, "1.0.61", true]]);
  // ⚠️ שאלה בלי גרסה אינה מוחקת את הגרסה האחרונה
  await claim(R1, false, "");
  assert.equal((await sup(`SELECT agent_version FROM wizenet_relays WHERE site_id = $1`, [site1.id]))[0].agent_version, "1.0.60");
  assert.equal((await status(OPR, a)).state, "claimed");
});

test("R6 · הצלחה: 'update successfully' — נרשם השינוי בשם מי שלחץ, הקריאה מתעדכנת, ומתפרסם אירוע", { skip }, async () => {
  await reset();
  await setLists();
  await wake();
  const id = await requestUpdate(OPR, "880001", "status", "151");
  const c = await claim(R1);
  const before = Number((await sup(`SELECT COALESCE(max(id), 0) m FROM events`))[0].m);
  const r = await complete(R1, c.id, c.attempt, [{ status: 200, text: '{"result":"Update Successfully"}' }]);
  assert.deepEqual(r, { accepted: true, state: "done", result: "עודכן בוויזנט" });
  assert.deepEqual(await status(OPR, id), { id, kind: "update", state: "done", result: "עודכן בוויזנט" });
  const ch = await sup(`SELECT ticket, field, value, changed_by, changed_by_user FROM service_call_changes WHERE ticket = '880001' ORDER BY id DESC LIMIT 1`);
  const opId = (await sup(`SELECT id FROM app_users WHERE supabase_uid = $1`, [OPR]))[0].id;
  assert.deepEqual(ch, [{ ticket: "880001", field: "status", value: "151", changed_by: "בקר ממסר", changed_by_user: opId }]);
  const open = (await one(OPR, `SELECT public.service_calls_open($1) AS j`, [site3.code])).j;
  assert.equal(open.find((x) => x.ticket === "880001").status_id, "151");
  const ev = await sup(`SELECT payload FROM events WHERE id > $1 ORDER BY id`, [before]);
  assert.deepEqual(ev.map((e) => e.payload.action), ["status"]);
  // ⚠️ שורת הביקורת — מי שלחץ ובאיזה תפקיד, לא "סוכן"
  const au = await sup(`SELECT actor_name, actor_role, details FROM audit_log WHERE action = 'service_call.status' AND target_id = '880001' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual([au[0].actor_name, au[0].actor_role, au[0].details.via], ["בקר ממסר", "editor", "relay"]);
  // תשובה שנייה לאותה בקשה — נדחית, ולא נרשם שוב
  assert.deepEqual(await complete(R1, c.id, c.attempt, [{ status: 200, text: "update successfully" }]), { accepted: false });
  assert.equal((await sup(`SELECT count(*)::int n FROM service_call_changes WHERE ticket = '880001'`))[0].n, 1);
});

test("R7 · כשלים: 200 עם שגיאה בגוף, הפניה להתחברות, קצב-זמן, אין חיבור, תשובה חסרה — failed, בעברית, ולא נרשם דבר", { skip }, async () => {
  await reset();
  await setLists();
  await wake();
  const cases = [
    [[{ status: 200, text: "error: call not found" }], "הקריאה לא נמצאה בוויזנט"],
    [[{ status: 200, text: "callstatusid not found" }], "הערך שנבחר אינו קיים בוויזנט"],
    [[{ status: 500, text: "GO_TO_WIZENET" }], "שגיאה במערכת של ויזנט — לנסות שוב מאוחר יותר"],
    [[{ status: 401, text: "Unauthorized" }], "ויזנט דחו את הטוקן"],
    [[{ status: 302, text: "<html>Object moved</html>" }], "ויזנט דחו את הבקשה (הפניה להתחברות) — כנראה הטוקן"],
    [[{ error: "timeout", detail: "15s" }], "ויזנט לא ענו בזמן"],
    [[{ error: "network", detail: "No such host" }], "אין חיבור לוויזנט מהממסר"],
    [[{ error: "config", detail: "אין ערך ל-qry_status" }], "חסרה הגדרה בממסר: אין ערך ל-qry_status"],
    [[], "הממסר לא החזיר תשובה לפנייה"],
    [[{ text: "update successfully" }], "הממסר לא החזיר תשובה לפנייה"],
    [[{ status: 200, text: "ok" }], "ויזנט החזירו שגיאה: ok"],
  ];
  const changesBefore = (await sup(`SELECT count(*)::int n FROM service_call_changes`))[0].n;
  for (const [results, want] of cases) {
    const id = await requestUpdate(OPR, "880002", "status", "151");
    const c = await claim(R1);
    assert.equal(c.id, id);
    const r = await complete(R1, c.id, c.attempt, results);
    assert.deepEqual([r.state, r.result], ["failed", want], JSON.stringify(results));
    assert.equal((await status(OPR, id)).state, "failed");
  }
  assert.equal((await sup(`SELECT count(*)::int n FROM service_call_changes`))[0].n, changesBefore, "כשל אינו נרשם כשינוי");
  // התשובה הגולמית נשמרת לאבחון (חתוכה)
  assert.match((await sup(`SELECT response FROM wizenet_requests WHERE result LIKE 'ויזנט החזירו שגיאה%'`))[0].response, /^ok$/);
});

test("R8 · רק הממסר שלקח, ורק בניסיון שלו; חכירה שפגה — ממסר אחר לוקח, והתשובה המאוחרת של הראשון נדחית", { skip }, async () => {
  await reset();
  await setLists();
  await wake();
  const id = await requestUpdate(OPR, "880001", "type", "2");
  const c1 = await claim(R1);
  assert.deepEqual(await complete(R2, c1.id, c1.attempt, [{ status: 200, text: "update successfully" }]), { accepted: false },
    "ממסר שלא לקח");
  assert.deepEqual(await complete(R1, c1.id, c1.attempt + 1, [{ status: 200, text: "update successfully" }]), { accepted: false },
    "ניסיון שלא קיים");
  assert.equal(await claim(R2), null, "בתוך החכירה — אין מה לקחת");
  await sup(`UPDATE wizenet_requests SET claimed_at = now() - interval '121 seconds' WHERE id = $1`, [id]);
  const c2 = await claim(R2);
  assert.deepEqual([c2.id, c2.attempt], [id, 2]);
  assert.deepEqual(await complete(R1, c1.id, c1.attempt, [{ status: 200, text: "update successfully" }]), { accepted: false },
    "תשובה מאוחרת של מי שהחכירה שלו פגה");
  assert.equal((await complete(R2, c2.id, c2.attempt, [{ status: 200, text: "update successfully" }])).state, "done");
  assert.equal((await sup(`SELECT count(*)::int n FROM service_call_changes WHERE ticket = '880001' AND field = 'type'`))[0].n, 1);
});

test("R9 · פקיעה: שאיש לא לקח — 'לא נשלח'; שנלקח ולא חזר — 'לא ידוע'; ובתוך החכירה — לא פג, והתשובה מתקבלת", { skip }, async () => {
  await reset();
  await setLists();
  await wake();
  const a = await requestUpdate(OPR, "880001", "status", "151");
  await sup(`UPDATE wizenet_requests SET created_at = now() - interval '121 seconds' WHERE id = $1`, [a]);
  assert.deepEqual([(await status(OPR, a)).state, (await status(OPR, a)).result],
    ["expired", "לא נשלח לוויזנט — אף ממסר לא לקח את הבקשה תוך 2 דקות"]);
  assert.equal(await claim(R1), null, "בקשה שפגה אינה נלקחת");

  const b = await requestUpdate(OPR, "880001", "status", "151");
  const cb = await claim(R1);
  await sup(`UPDATE wizenet_requests SET created_at = now() - interval '250 seconds', claimed_at = now() - interval '130 seconds' WHERE id = $1`, [b]);
  assert.deepEqual([(await status(OPR, b)).state, (await status(OPR, b)).result],
    ["expired", "לא ידוע אם השינוי הגיע לוויזנט — הממסר שלקח את הבקשה לא החזיר תשובה"]);
  assert.deepEqual(await complete(R1, cb.id, cb.attempt, [{ status: 200, text: "update successfully" }]), { accepted: false });

  const c = await requestUpdate(OPR, "880001", "status", "150");
  const cc = await claim(R1);
  await sup(`UPDATE wizenet_requests SET created_at = now() - interval '150 seconds', claimed_at = now() - interval '100 seconds' WHERE id = $1`, [c]);
  assert.equal((await status(OPR, c)).state, "claimed", "בתוך החכירה — עוד לא פג, אולי הממסר באמצע הפנייה");
  assert.equal((await complete(R1, cc.id, cc.attempt, [{ status: 200, text: "update successfully" }])).state, "done");
});

test("R10 · רשימות: שתי שאילתות עם מקום-שמור ל-QRYID; שתיהן מפוענחות ונשמרות; אחת שלא — אף אחת לא נשמרת", { skip }, async () => {
  await reset();
  await setLists();
  await wake();
  const id = Number((await one(OPR, `SELECT public.wizenet_request_lookups() AS id`)).id);
  const c = await claim(R2);
  assert.deepEqual(c.calls, [
    { kind: "status", func: "wizeApp_getBIReportQuery", body: { QRYID: "{{qry_status}}" } },
    { kind: "type", func: "wizeApp_getBIReportQuery", body: { QRYID: "{{qry_type}}" } }]);
  const before = Number((await sup(`SELECT COALESCE(max(id), 0) m FROM events`))[0].m);
  const r = await complete(R2, c.id, c.attempt, [
    { status: 200, text: JSON.stringify({ Table: [{ StatusId: "148", StatusDesc: "פתוחה" }, { StatusId: "160", StatusDesc: "חדש מוויזנט" }] }) },
    { status: 200, text: JSON.stringify([{ ID: 1, Name: "תקלה" }, { ID: 3, Name: "התקנה" }]) }]);
  assert.deepEqual([r.state, r.result], ["done", "נטענו 2 סטטוסים ו-2 סוגי קריאה"]);
  assert.equal((await status(OPR, id)).state, "done");
  const lists = (await one(OPR, `SELECT public.wizenet_lookups_list() AS j`)).j;
  assert.ok(lists.status.some((s) => s.id === "160" && s.name === "חדש מוויזנט"));
  assert.ok(lists.type.some((s) => s.id === "3" && s.name === "התקנה"));
  const ev = await sup(`SELECT payload FROM events WHERE id > $1 ORDER BY id`, [before]);
  assert.deepEqual(ev.map((e) => e.payload.action), ["lookups"]);

  // ⚠️ השנייה לא פוענחה — גם הראשונה אינה נשמרת (חצי עבודה בלי סימן)
  await one(OPR, `SELECT public.wizenet_request_lookups() AS id`);
  const c2 = await claim(R1);
  const r2 = await complete(R1, c2.id, c2.attempt, [
    { status: 200, text: JSON.stringify([{ id: "170", name: "לא אמור להישמר" }]) },
    { status: 200, text: "<html>not json</html>" }]);
  assert.deepEqual([r2.state, r2.result], ["failed", "לא הצלחנו לקרוא את הרשימה מוויזנט"]);
  assert.equal((await sup(`SELECT count(*)::int n FROM wizenet_lookups WHERE id = '170'`))[0].n, 0);
  assert.match((await sup(`SELECT response FROM wizenet_requests WHERE id = $1`, [c2.id]))[0].response, /not json/);
  // והראשונה נכשלה בתעבורה — עוצרים שם
  await one(OPR, `SELECT public.wizenet_request_lookups() AS id`);
  const c3 = await claim(R1);
  assert.deepEqual((await complete(R1, c3.id, c3.attempt, [{ error: "timeout" }])).result, "ויזנט לא ענו בזמן");
});

test("R11 · פענוח רשימה — אותו כלל כמו parseLookup שהיה בפונקציית ה-Edge, כולל סדר המפתחות כפי שנכתבו", { skip }, async () => {
  const parse = async (text) => (await sup(`SELECT app.wizenet_parse_lookup($1) AS j`, [text]))[0].j;
  // המקרים של wizenet-fn.test.js (13/10/2026), מילה במילה
  assert.deepEqual(await parse(JSON.stringify([{ ID: 1, Name: "א" }, { foo: 1 }, { id: "", name: "ריק" }])), [{ id: "1", name: "א" }]);
  assert.deepEqual(await parse(JSON.stringify({ Table: [{ StatusId: "5", StatusDesc: "ב" }] })), [{ id: "5", name: "ב" }]);
  assert.deepEqual(await parse(JSON.stringify([{ "קוד": 3, "שם": "ג" }])), [{ id: "3", name: "ג" }]);
  assert.deepEqual(await parse(JSON.stringify([{ typeid: 7, x: "ד" }])), [{ id: "7", name: "ד" }]);
  assert.deepEqual(await parse("text"), []);
  assert.deepEqual(await parse("null"), []);
  assert.deepEqual(await parse(null), []);
  // ⚠️ "המפתח הראשון שמסתיים ב-id" — לפי הסדר בתשובה. jsonb היה ממיין (TypeId לפני StatusId, כי קצר יותר)
  assert.deepEqual(await parse('[{"StatusId":"9","TypeId":"2","StatusName":"נ"}]'), [{ id: "9", name: "נ" }]);
  // המערך הראשון באובייקט, לפי הסדר — לא האחרון ולא הארוך
  assert.deepEqual(await parse('{"meta":{"a":1},"Rows":[{"id":1,"name":"ראשון"}],"Other":[{"id":2,"name":"שני"}]}'),
    [{ id: "1", name: "ראשון" }]);
  // trim של JS — גם שורה חדשה וטאב
  assert.deepEqual(await parse(JSON.stringify([{ id: "\t11\n", name: " שם\n" }])), [{ id: "11", name: "שם" }]);
  assert.deepEqual(await parse("[1, \"x\", null, []]"), []);
});

test("R12 · תקרה: 20 בקשות פתוחות — הבאה נדחית (429)", { skip }, async () => {
  await reset();
  await setLists();
  await wake();
  for (let i = 0; i < 20; i++) await requestUpdate(OPR, "880001", "status", "151");
  await fails(requestUpdate(OPR, "880001", "status", "151"), "PT429", /יותר מדי בקשות/);
  await reset();
});

test("R13 · פעם ביום: גריפה של 30 יום, ורענון רשימות רק כשיש ממסר חי — ובלי שגיאה כשאין", { skip }, async () => {
  await reset();
  await setLists();
  await sys(`SELECT app.wizenet_daily()`);
  assert.equal((await sup(`SELECT count(*)::int n FROM wizenet_requests`))[0].n, 0, "בלי ממסר חי — אין בקשה");
  await wake();
  const old = await requestUpdate(OPR, "880001", "status", "151");
  await sup(`UPDATE wizenet_requests SET created_at = now() - interval '31 days', state = 'done' WHERE id = $1`, [old]);
  await sys(`SELECT app.wizenet_daily()`);
  const rows = await sup(`SELECT kind, requested_by, state FROM wizenet_requests ORDER BY id`);
  assert.deepEqual(rows, [{ kind: "lookups", requested_by: "רענון יומי", state: "pending" }]);
  // תור מלא — מדלגים, בלי שגיאה (משימה מתוזמנת: אין מי שיקרא אותה)
  for (let i = 0; i < 19; i++) await requestUpdate(OPR, "880001", "status", "151");
  await sys(`SELECT app.wizenet_daily()`);
  assert.equal((await sup(`SELECT count(*)::int n FROM wizenet_requests`))[0].n, 20);
  await reset();
});

test("R14 · הטבלאות סגורות — גם לממסר; ו-anon אינו מגיע לאף פונקציה", { skip }, async () => {
  for (const uid of [MGR, OPR, R1, AG]) {
    for (const t of ["wizenet_requests", "wizenet_relays"]) {
      await fails(rpc(uid, `SELECT * FROM ${t}`), "42501", /permission denied/);
    }
  }
  const fns = await sup(`SELECT p.oid::regprocedure::text sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'app') AND p.proname LIKE 'wizenet%' AND has_function_privilege('anon', p.oid, 'EXECUTE')`);
  assert.deepEqual(fns, []);
  // והפנימיות — לאף אחד מבחוץ
  for (const uid of [MGR, R1]) {
    await fails(rpc(uid, `SELECT app.wizenet_enqueue('lookups', NULL, NULL, NULL, '[]'::jsonb, 'x', NULL)`), "42501");
    await fails(rpc(uid, `SELECT app.wizenet_expire()`), "42501");
  }
});

test("R15 · ויזנט אישרו, אבל הרישום אצלנו נכשל — done, עם הסבר (השינוי כבר קרה אצלם)", { skip }, async () => {
  await reset();
  await setLists();
  await wake();
  await requestUpdate(OPR, "880002", "status", "151");
  const c = await claim(R1);
  // בין הלחיצה לתשובה הרשימה נטענה מחדש בלי 151 — הרישום ידחה את הערך
  await sup(`DELETE FROM wizenet_lookups WHERE kind = 'status' AND id = '151'`);
  const r = await complete(R1, c.id, c.attempt, [{ status: 200, text: "update successfully" }]);
  assert.deepEqual([r.state, r.result], ["done", "עודכן בוויזנט, אבל לא נרשם אצלנו — המסך יתעדכן כשוויזנט ישלחו את העדכון"]);
});

test("R16 · הקובץ אידמפוטנטי, ואין שתי גרסאות של אף פונקציה", { skip }, async () => {
  const fs = require("node:fs"), path = require("node:path");
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "wizenet-relay.postgres.sql"), "utf8");
  await h.pg.exec(sql);
  await h.pg.exec(sql);
  const dup = await sup(`SELECT p.proname, count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'app') AND p.proname LIKE 'wizenet%' GROUP BY 1 HAVING count(*) > 1`);
  assert.deepEqual(dup, []);
});

// ⚠️ סקירה, 15/10/2026: ממסר שאינו מגיע לוויזנט (ספק שכתובתו אינה "ישראלית", DNS שבור) עדיין "חי" ומכשיל כל בקשה
// שלקח. עכשיו בקשה שלא הגיעה לוויזנט חוזרת לתור, ואותו ממסר לא לוקח אותה שוב.
test("R17 · לא הגיע לוויזנט (רשת/תצורה) — חוזר לתור לממסר אחר; כולם ניסו — נכשל מיד; קצב-זמן — נכשל ולא חוזר", { skip }, async () => {
  await reset();
  await setLists();
  await claim(R1); await claim(R2);   // שניהם חיים
  const maxEv = async () => Number((await sup(`SELECT COALESCE(max(id), 0) m FROM events`))[0].m);

  const id = await requestUpdate(OPR, "880001", "status", "151");
  const c1 = await claim(R1);
  const ev0 = await maxEv();
  assert.deepEqual(await complete(R1, c1.id, c1.attempt, [{ error: "network", detail: "No such host is known" }]),
    { accepted: true, state: "pending", result: "אין חיבור לוויזנט מהממסר" });
  const ring = await sup(`SELECT payload FROM events WHERE id > $1`, [ev0]);
  assert.deepEqual(ring.map((e) => [e.payload.action, e.payload.id]), [["relay", id]], "צלצול שוב לממסרים האחרים");
  assert.equal(await claim(R1), null, "הממסר שלא הגיע — לא לוקח אותה שוב");
  const c2 = await claim(R2);
  assert.deepEqual([c2.id, c2.attempt], [id, 2]);
  assert.equal((await complete(R2, c2.id, c2.attempt, [{ status: 200, text: "update successfully" }])).state, "done");

  // שני הממסרים החיים לא הגיעו — אין למי להעביר: נכשל עכשיו, עם הסיבה
  const id2 = await requestUpdate(OPR, "880001", "status", "150");
  const a = await claim(R1);
  assert.equal((await complete(R1, a.id, a.attempt, [{ error: "config", detail: "אין ערך ל-qry_status" }])).state, "pending");
  const b = await claim(R2);
  assert.equal(b.id, id2);
  const rb = await complete(R2, b.id, b.attempt, [{ error: "network", detail: "x" }]);
  assert.deepEqual([rb.state, rb.result], ["failed", "אין חיבור לוויזנט מהממסר"]);
  assert.equal((await status(OPR, id2)).state, "failed");

  // קצב-זמן — אולי הגיע: נכשל, ולא חוזר לתור (שליחה שנייה הייתה "פעמיים", לא "במקום")
  const id3 = await requestUpdate(OPR, "880001", "status", "151");
  const t = await claim(R1);
  assert.equal(t.id, id3);
  assert.equal((await complete(R1, t.id, t.attempt, [{ error: "timeout" }])).state, "failed");

  // חזרה לתור ואז פקיעה — אומרים למה, ולא "אף ממסר לא לקח"
  const id4 = await requestUpdate(OPR, "880002", "status", "151");
  const u = await claim(R1);
  await complete(R1, u.id, u.attempt, [{ error: "network", detail: "x" }]);
  await sup(`UPDATE wizenet_requests SET created_at = now() - interval '121 seconds' WHERE id = $1`, [id4]);
  assert.deepEqual([(await status(OPR, id4)).state, (await status(OPR, id4)).result],
    ["expired", "לא נשלח לוויזנט — אין חיבור לוויזנט מהממסר"]);

  // רשימות: הפנייה השנייה לא הגיעה — גם כן חוזרת (שאילתת קריאה; שליחה חוזרת אינה מזיקה)
  await one(OPR, `SELECT public.wizenet_request_lookups() AS id`);
  const l = await claim(R1);
  const rl = await complete(R1, l.id, l.attempt, [{ status: 200, text: JSON.stringify([{ id: "1", name: "x" }]) }, { error: "network", detail: "x" }]);
  assert.equal(rl.state, "pending");
  // ⚠️ ורענון רשימות — גם בקצב-זמן: חסימה של ויזנט נראית כך, ושאילתת קריאה שנשלחת שוב אינה מזיקה
  await reset();
  await claim(R1); await claim(R2);
  await one(OPR, `SELECT public.wizenet_request_lookups() AS id`);
  const lt = await claim(R1);
  assert.equal((await complete(R1, lt.id, lt.attempt, [{ error: "timeout" }])).state, "pending");
  const lt2 = await claim(R2);
  assert.deepEqual([lt2.id, lt2.attempt], [lt.id, 2]);
  // update: כשל ב"פנייה" שאינה הראשונה אינו קיים — רק הראשונה נבדקת (אחרת "פנייה שנייה" מדומה הייתה מחזירה לתור שינוי שכבר נעשה)
  await reset();
  await wake();
  await requestUpdate(OPR, "880001", "status", "151");
  const x = await claim(R1);
  const rx = await complete(R1, x.id, x.attempt, [{ status: 200, text: "update successfully" }, { error: "network" }]);
  assert.equal(rx.state, "done");
});
