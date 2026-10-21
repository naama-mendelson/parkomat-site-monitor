// tests/technicians.test.js — לוח טכנאי השטח (technicians.postgres.sql, 20/10/2026): הפיילוט, ההרשאות, הטכנאים והרכבים,
// השליחה (הגיע / נכנס / סיים), השעות בדיעבד, היומן, הגריפה, ומה ששורד מחיקת אתר ורכב שאיתוראן הורידו.
//
// ⚠️ השמות, האתרים והרכבים כאן מומצאים — המאגר ציבורי.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "f2000000-0000-0000-0000-000000000001";
const ED = "f2000000-0000-0000-0000-000000000002";
const ED2 = "f2000000-0000-0000-0000-000000000003";   // עורך שאינו בפיילוט
const RO = "f2000000-0000-0000-0000-000000000004";
const AG = "f2000000-0000-0000-0000-000000000005";
const IN = "f2000000-0000-0000-0000-000000000006";
const PILOT = " TC-MGR@parkomat.co.il ,tc-ed@PARKOMAT.co.il,  tc-ro@parkomat.co.il ";

let h;
let site1;
const sup = async (sql, params = []) => (await h.pg.query(sql, params)).rows;
async function as(role, claims, sql, params = []) {
  return h.pg.transaction(async (tx) => {
    await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, ...claims })]);
    await tx.query(`SET LOCAL ROLE ${role}`);
    return (await tx.query(sql, params)).rows;
  });
}
// 21/10/2026: הדשבורד מציג רק רכבים שב-fleet_shown. הבדיקות שנכתבו לפני כן מצפות לכל הרכבים — אז לפני כל קריאה כל רכבי
// הבדיקה מסומנים כמוצגים. בדיקת ההסתרה עצמה עוברת דרך userRaw, בלי הסימון.
const userRaw = (uid, sql, params) => as("authenticated", { sub: uid, session_id: "5e550000-0000-0000-0000-0000000000bb" }, sql, params);
const user = async (uid, sql, params) => { await h.pg.query(`INSERT INTO fleet_shown (license_plate) SELECT license_plate FROM vehicles_live ON CONFLICT DO NOTHING`); return userRaw(uid, sql, params); };
const fn = async (uid, name, ...args) =>
  (await user(uid, `SELECT public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")}) r`, args))[0].r;
const board = (uid = ED) => fn(uid, "tech_board");
const save = (uid, id, name, plate = null, active = null, rev = null) => fn(uid, "tech_save", id, name, plate, active, rev);
const setStatus = (uid, tech, st, at = null, rev = null) => fn(uid, "tech_set_status", tech, st, at, rev);
const dispatch = (uid, tech, o = {}) => fn(uid, "tech_dispatch", tech, o.site ?? null, o.place ?? null, o.details ?? null,
  o.ticket ?? null, "client" in o ? o.client : randomUUID(), o.rev ?? null);
const mark = (uid, d, m, at = null) => fn(uid, "tech_dispatch_mark", d, m, at);
const end = (uid, d, kind, next = null, at = null) => fn(uid, "tech_dispatch_end", d, kind, next, at);
const day = (uid, d = null) => fn(uid, "tech_day", d);
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const techOf = async (id, uid = ED) => (await board(uid)).technicians.find((t) => t.id === Number(id));
const logOf = async (tech) => sup(`SELECT * FROM tech_log WHERE technician_id = $1 ORDER BY at, id`, [tech]);
async function fails(p, code, re) {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, `ציפיתי ל-${code}, התקבל ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
}
let seq = 0;
const newTech = async (plate = null, uid = ED) => (await save(uid, null, `טכנאי בדיקה ${++seq}`, plate)).id;

// רכב בצורה של איתוראן (כמו ב-vehicles.test.js): מיקום בתל אביב, דיווח מלפני דקה
const car = (plate) => ({
  license_plate: plate, vehicle_id: Number(plate.slice(-5)), nickname: `רכב בדיקה ${plate}`, make_name: "יצרן",
  model_name: "דגם", motion_status: "parking",
  last_location: {
    location: { point: { lat: 32.08, lon: 34.78 }, address: { location: "רחוב הבדיקה, תל אביב" } },
    speed: 0, heading: 0, timestamp: new Date(Date.now() - 60_000).toISOString().replace("Z", "+00:00"),
  },
  places: [],
});
// רכב נפרד לכל בדיקה: רכב משויך לטכנאי פעיל אחד בלבד
const FLEET = ["7300001", "7300002", "7300003", "7300004", "7300005", "7300006", "7300007", "7300008"];
const ingest = (vehicles) => as("service_role", {}, `SELECT public.ituran_ingest($1::jsonb, $2::jsonb) n`,
  [JSON.stringify(vehicles), JSON.stringify({ complete: true })]);

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  site1 = (await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ('TC1','רחוב הבדיקה 50, תל אביב','error',$1)
                      RETURNING id`, [now]))[0].id;
  await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ('TC2','רחוב השני 7, רמת גן','ready',$1)`, [now]);
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, site_id, created_at) VALUES
      ('tc-mgr@parkomat.co.il','מנהלת בדיקה','manager',true,$1,NULL,$7),
      ('tc-ed@parkomat.co.il','רכז בדיקה','editor',true,$2,NULL,$7),
      ('tc-ed2@parkomat.co.il','עורך אחר','editor',true,$3,NULL,$7),
      ('tc-ro@parkomat.co.il','בקר בדיקה','operator',true,$4,NULL,$7),
      ('site-tc1@parkomat.co.il','סוכן','agent',true,$5,$8,$7),
      ('tc-intake@parkomat.co.il','קליטה','editor',true,$6,NULL,$7)`, [MGR, ED, ED2, RO, AG, IN, now, site1]);
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('intake_user_id', $1, 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [IN]);
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('technicians_board', $1, 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [PILOT]);
  await ingest(FLEET.map(car));
});
after(async () => { if (h) await h.close(); });

test("המצבים: אותה רשימה ב-app.tech_statuses(), בשני האילוצים ובמסך — בסדר של הרכז", { skip }, async () => {
  const { TECH_STATUSES, TECH_STATUS, STATUS_BUTTONS } = await import("../../dashboard/src/utils/technicians.js");
  assert.deepEqual(TECH_STATUSES, ["free", "en_route", "on_site", "feedback", "break", "evening", "vacation", "day_done"]);
  assert.deepEqual((await sup(`SELECT app.tech_statuses() s`))[0].s, TECH_STATUSES, "app.tech_statuses() = TECH_STATUSES");
  for (const con of ["technicians_status_chk", "tech_log_status"]) {
    const def = (await sup(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = $1`, [con]))[0].d;
    assert.deepEqual([...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]), TECH_STATUSES, `${con}: ${def}`);
  }
  for (const s of TECH_STATUSES) assert.ok(TECH_STATUS[s]?.label, `תווית ל-${s}`);
  // "בדרך" ו"באתר" באים מהשליחה — אין להם כפתור
  assert.deepEqual(STATUS_BUTTONS.map((b) => b.status), TECH_STATUSES.filter((s) => s !== "en_route" && s !== "on_site"));
});

test("הפיילוט: בלי הגדרה — כבוי לכולם; רשימה — רק מי שבה (רווחים ואותיות גדולות לא משנים); 'all' — כולם", { skip }, async () => {
  try {
    await sup(`DELETE FROM settings WHERE key = 'technicians_board'`);
    assert.deepEqual(await board(ED), { enabled: false });
    assert.deepEqual(await day(ED), { enabled: false });
    await fails(save(ED, null, "טכנאי פיילוט"), "42501", /אינו פעיל/);

    await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('technicians_board', $1, 'x')`, [PILOT]);
    for (const uid of [MGR, ED, RO]) assert.equal((await board(uid)).enabled, true, uid);
    assert.deepEqual(await board(ED2), { enabled: false }, "עורך שאינו ברשימה — המפה בלבד");
    await fails(save(ED2, null, "טכנאי פיילוט"), "42501", /אינו פעיל/);

    await sup(`UPDATE settings SET value = ' ALL ' WHERE key = 'technicians_board'`);
    assert.equal((await board(ED2)).enabled, true);
    await sup(`UPDATE settings SET value = '' WHERE key = 'technicians_board'`);
    assert.deepEqual(await board(MGR), { enabled: false }, "ריק = אף אחד");
  } finally {
    await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('technicians_board', $1, 'x')
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [PILOT]);
  }
});

test("הרשאות: בקר רואה ולא כותב; סוכן, קליטה, אנונימי והתחברות בלי קוד — לא רואים; הטבלאות והעזרים סגורים", { skip }, async () => {
  const t = await newTech("7300004", MGR);
  const d = (await dispatch(ED, t, { site: "TC2" })).dispatch_id;
  const ro = await board(RO);
  assert.equal(ro.enabled, true);
  assert.equal(ro.can_edit, false);
  assert.equal((await board(ED)).can_edit, true);
  assert.equal((await day(RO)).enabled, true);
  const readOnly = /בקר יכול רק לצפות/;
  await fails(save(RO, null, "טכנאי של בקר"), "42501", readOnly);
  await fails(save(RO, t, "שם חדש"), "42501", readOnly);
  await fails(setStatus(RO, t, "break"), "42501", readOnly);
  await fails(dispatch(RO, t, { site: "TC1" }), "42501", readOnly);
  await fails(mark(RO, d, "arrived"), "42501", readOnly);
  await fails(end(RO, d, "done"), "42501", readOnly);
  for (const uid of [AG, IN]) {
    await fails(board(uid), "42501");
    await fails(day(uid), "42501");
    await fails(save(uid, null, "טכנאי של מכונה"), "42501");
  }
  await fails(as("anon", {}, `SELECT public.tech_board()`), "42501");
  await fails(as("anon", {}, `SELECT public.tech_save(NULL, 'x', NULL, NULL, NULL)`), "42501");
  for (const tbl of ["technicians", "tech_dispatches", "tech_log"]) {
    await fails(user(ED, `SELECT * FROM ${tbl}`), "42501");
    await fails(user(ED, `DELETE FROM ${tbl}`), "42501");
  }
  await fails(user(ED, `SELECT app.tech_log_add(1, now(), 'status', 'free', NULL, NULL, 'x', false)`), "42501");
  // התחברות שלא אומתה בקוד במייל (20/10/2026) — לא "אני": לא רואה ולא כותבת
  try {
    await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('login_code_required', 'tc-ed@parkomat.co.il', 'x')
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    await fails(board(ED), "42501");
    await fails(setStatus(ED, t, "break"), "42501");
  } finally {
    await sup(`DELETE FROM settings WHERE key = 'login_code_required'`);
  }
  await end(ED, d, "cancelled");
});

test("טכנאים: שם ורכב ייחודיים בין הפעילים, מסך ישן — PT409, השבתה משחררת רכב, החלפת רכב ביומן, רווחים מנורמלים", { skip }, async () => {
  const a = await save(ED, null, "  Tech\tAlpha   One ", "7300001");
  const ta = await techOf(a.id);
  assert.equal(ta.name, "Tech Alpha One", "טאב ורווחים כפולים בהתחלה, באמצע ובסוף");
  assert.equal(ta.plate, "7300001");
  assert.equal(ta.status_today, null);
  await fails(save(ED, null, "tech alpha one"), "PT409", /כבר יש טכנאי פעיל בשם הזה/);
  await fails(save(ED, null, "טכנאי שני", "7300001"), "PT409", /הרכב הזה כבר משויך לTech Alpha One/);
  await fails(save(ED, null, "א"), "22023");
  await fails(save(ED, null, "שם".repeat(31)), "22023");

  // עריכה: מסך ישן נדחה; בלי שינוי — כלום
  await fails(save(ED, a.id, "Tech Alpha Two", "7300001", true, a.rev + 1), "PT409", /השתנה בינתיים/);
  const same = await save(ED, a.id, "Tech Alpha One", "7300001", true, a.rev);
  assert.equal(same.changed, false);
  assert.equal(same.rev, a.rev);
  const renamed = await save(ED, a.id, "Tech Alpha Two", "7300001", true, a.rev);
  assert.equal(renamed.rev, a.rev + 1);

  // השבתה משחררת את הרכב; החזרה לפעילות כשהרכב תפוס — נדחית
  const off = await save(ED, a.id, "Tech Alpha Two", "7300001", false, renamed.rev);
  const b = await save(ED, null, "Tech Beta", "7300001");
  const bd = await board();
  assert.ok(bd.inactive.some((x) => x.id === a.id && x.plate === "7300001"));
  assert.ok(!bd.technicians.some((x) => x.id === a.id), "מושבת אינו בלוח");
  await fails(save(ED, a.id, "Tech Alpha Two", "7300001", true, off.rev), "PT409", /כבר משויך לTech Beta/);
  await save(ED, a.id, "Tech Alpha Two", null, true, off.rev);

  // ההיסטוריה של הרכבים: הוספה עם רכב והחלפה — שורת vehicle עם from / to
  await save(ED, b.id, "Tech Beta", "7300002", null, b.rev);
  const v = (await logOf(b.id)).filter((r) => r.action === "vehicle").map((r) => r.detail);
  assert.deepEqual(v, [{ from: null, to: "7300001" }, { from: "7300001", to: "7300002" }]);
});

test("המסלול המלא: שלח → הגיע → נכנס → סיים; המצבים, היומן, ותמונת הרכב רק באבני הדרך", { skip }, async () => {
  const t = await save(ED, null, "Flow Tech", "7300003");
  await setStatus(ED, t.id, "free", null, t.rev);
  let x = await techOf(t.id);
  assert.equal(x.status_today, "free");
  assert.equal(x.status_by, "רכז בדיקה");
  assert.equal(x.vehicle.plate, "7300003", "הרכב — מהבונה של המפה");

  const r = await dispatch(ED, t.id, { site: "TC1", details: "  המעלית תקועה בקומה 2  ", ticket: " 774501 ", rev: x.rev });
  x = await techOf(t.id);
  assert.equal(x.status_today, "en_route");
  assert.equal(x.dispatch.id, r.dispatch_id);
  assert.equal(x.dispatch.site_code, "TC1");
  assert.equal(x.dispatch.site_name, "רחוב הבדיקה 50, תל אביב");
  assert.equal(x.dispatch.details, "המעלית תקועה בקומה 2");
  assert.equal(x.dispatch.ticket, "774501");
  assert.equal(x.dispatch.arrived_at, null);

  await mark(ED, r.dispatch_id, "arrived");
  x = await techOf(t.id);
  assert.equal(x.status_today, "on_site");
  assert.equal(x.status_at, x.dispatch.arrived_at, "'באתר מ-' = שעת ההגעה");
  assert.equal(x.dispatch.arrived_late, false);
  await mark(ED, r.dispatch_id, "entered");
  x = await techOf(t.id);
  assert.equal(x.status_today, "on_site");
  assert.ok(x.dispatch.entered_at);

  const e = await end(ED, r.dispatch_id, "done");
  assert.equal(e.changed, true);
  x = await techOf(t.id);
  assert.equal(x.status_today, "free", "ברירת המחדל אחרי סיום — פנוי");
  assert.equal(x.dispatch, null);

  const rows = await logOf(t.id);
  assert.deepEqual(rows.map((l) => [l.action, l.status_after]), [
    ["vehicle", null], ["status", "free"], ["dispatch", "en_route"], ["arrived", "on_site"], ["entered", null], ["ended", "free"],
  ]);
  const snap = (l) => [l.veh_plate, l.veh_lat != null, l.veh_lon != null, l.veh_address, l.veh_state];
  for (const l of rows) {
    if (["dispatch", "arrived", "entered", "ended"].includes(l.action)) {
      assert.deepEqual(snap(l), ["7300003", true, true, "רחוב הבדיקה, תל אביב", "parking"], `${l.action}: תמונת רכב`);
      assert.equal(l.site_code, "TC1");
    } else {
      assert.deepEqual(snap(l), [null, false, false, null, null], `${l.action}: בלי מיקום`);
    }
    assert.equal(l.actor, "רכז בדיקה");
    assert.equal(l.source, "dispatcher");
  }
  assert.equal(rows.find((l) => l.action === "ended").detail.end_kind, "done");

  // היומן של היום: החדש למעלה, עם שם הטכנאי, בלי מיקום
  const today = await day(RO);
  const mine = today.rows.filter((l) => l.technician_id === t.id);
  assert.deepEqual(mine.map((l) => l.action), ["ended", "entered", "arrived", "dispatch", "status", "vehicle"]);
  assert.ok(mine.every((l) => l.name === "Flow Tech" && l.late === false));
  assert.equal(mine[0].site_name, "רחוב הבדיקה 50, תל אביב");
  assert.ok(!JSON.stringify(today).includes("32.08"), "בלי קואורדינטות ביומן");
  assert.equal(today.day, today.today);
});

test("אתר אחר: שליחה חדשה סוגרת את הפתוחה כ'הועבר'; אחת פתוחה לכל טכנאי; מקום חופשי נזכר", { skip }, async () => {
  const t = await newTech();
  const a = await dispatch(ED, t, { site: "TC1" });
  const b = await dispatch(ED, t, { place: "  מחסן   החברה " });
  const rows = await sup(`SELECT id::int AS id, ended_at IS NOT NULL ended, end_kind, place FROM tech_dispatches WHERE technician_id = $1 ORDER BY id`, [t]);
  assert.deepEqual(rows.map((r) => [r.id, r.ended, r.end_kind, r.place]),
    [[a.dispatch_id, true, "moved", null], [b.dispatch_id, false, null, "מחסן החברה"]]);
  const x = await techOf(t);
  assert.equal(x.dispatch.place, "מחסן החברה");
  assert.equal(x.dispatch.site_code, null);
  assert.equal(x.status_today, "en_route");
  assert.equal((await board()).recent_places[0], "מחסן החברה");
  const moved = (await logOf(t)).find((l) => l.action === "ended");
  assert.equal(Number(moved.dispatch_id), a.dispatch_id);
  assert.deepEqual(moved.detail, { end_kind: "moved" });
  // האינדקס, לא רק הפונקציה: שתי פתוחות לאותו טכנאי — אי אפשר בכלל
  await fails(sup(`INSERT INTO tech_dispatches (client_id, technician_id, place, created_by) VALUES ($1, $2, 'כפול', 'x')`,
    [randomUUID(), t]), "23505");
  // יעד: אחד בדיוק
  await fails(dispatch(ED, t, {}), "22023", /אחד מהם/);
  await fails(dispatch(ED, t, { site: "TC1", place: "משרד" }), "22023", /אחד מהם/);
  await fails(dispatch(ED, t, { site: "NOPE" }), "PT404", /האתר לא נמצא/);
  await fails(dispatch(ED, t, { place: "א" }), "22023");
  await fails(dispatch(ED, t, { place: "משרד", details: "פ".repeat(501) }), "22023");
  await end(ED, b.dispatch_id, "cancelled");
});

test("מצבים: בזמן שליחה אין שינוי מצב; 'בדרך'/'באתר' לא ביד; אותו מצב שוב — כלום (בלי שורה, audit ו-rev)", { skip }, async () => {
  const t = await newTech();
  const d = await dispatch(ED, t, { site: "TC2" });
  await fails(setStatus(ED, t, "break"), "PT409", /שליחה פתוחה/);
  await fails(setStatus(ED, t, "day_done"), "PT409", /שליחה פתוחה/);
  await fails(setStatus(ED, t, "en_route"), "22023", /נקבעים מהשליחה/);
  await fails(setStatus(ED, t, "on_site"), "22023", /נקבעים מהשליחה/);
  await fails(setStatus(ED, t, "lunch"), "22023", /מצב לא מוכר/);
  await end(ED, d.dispatch_id, "cancelled", "break");
  let x = await techOf(t);
  assert.equal(x.status_today, "break", "המצב הבא מהסיום");
  const logs = (await logOf(t)).length;
  const audits = (await sup(`SELECT count(*)::int n FROM audit_log WHERE action LIKE 'tech.%'`))[0].n;
  const again = await setStatus(ED, t, "break", null, x.rev);
  assert.deepEqual([again.changed, again.rev], [false, x.rev]);
  assert.equal((await logOf(t)).length, logs);
  assert.equal((await sup(`SELECT count(*)::int n FROM audit_log WHERE action LIKE 'tech.%'`))[0].n, audits);
  await fails(setStatus(ED, t, "free", null, x.rev + 5), "PT409", /השתנה בינתיים/);
  await setStatus(ED, t, "evening", null, x.rev);
  x = await techOf(t);
  assert.equal(x.status_today, "evening");
  // טכנאי מושבת — לא נמצא
  const off = await save(ED, t, x.name, null, false, x.rev);
  await fails(setStatus(ED, t, "free", null, off.rev), "PT404");
  await fails(dispatch(ED, t, { site: "TC1" }), "PT404");
});

test("שעות: בדיעבד בגבולות; הסימון הראשון קובע; תיקון = שורת correction; 'נכנס' בלי 'הגיע' קובע את שניהם", { skip }, async () => {
  const t = await newTech();
  const d = (await dispatch(ED, t, { site: "TC1" })).dispatch_id;
  await fails(mark(ED, d, "arrived", ago(10)), "22023", /מוקדמת מהשליחה/);
  // השליחה "נעשתה" לפני חצי שעה
  await sup(`UPDATE tech_dispatches SET created_at = now() - interval '30 minutes' WHERE id = $1`, [d]);
  await sup(`UPDATE technicians SET status_at = now() - interval '30 minutes' WHERE id = $1`, [t]);
  await fails(mark(ED, d, "arrived", new Date(Date.now() + 5 * 60_000).toISOString()), "22023", /עוד לא הגיעה/);
  await fails(mark(ED, d, "arrived", ago(13 * 60)), "22023", /12 שעות/);

  const at10 = ago(10);
  await mark(ED, d, "arrived", at10);
  let x = await techOf(t);
  assert.equal(Date.parse(x.dispatch.arrived_at), Math.floor(Date.parse(at10) / 1000) * 1000);
  assert.equal(x.dispatch.arrived_late, true);
  assert.equal(x.status_at, x.dispatch.arrived_at);
  assert.equal((await mark(ED, d, "arrived")).changed, false, "לחיצה שנייה בלי שעה — הסימון הראשון קובע");

  // תיקון: שורת correction, והמצב "באתר מ-" זז איתו
  await mark(ED, d, "arrived", ago(20));
  x = await techOf(t);
  assert.ok(Date.parse(x.dispatch.arrived_at) < Date.parse(at10));
  assert.equal(x.status_at, x.dispatch.arrived_at);
  const corr = (await logOf(t)).filter((l) => l.action === "correction");
  assert.equal(corr.length, 1);
  assert.equal(corr[0].detail.mark, "arrived");
  assert.equal(Date.parse(corr[0].detail.from), Math.floor(Date.parse(at10) / 1000) * 1000);
  assert.equal(corr[0].detail.to, x.dispatch.arrived_at);

  await fails(mark(ED, d, "entered", ago(25)), "22023", /מוקדמת מההגעה/);
  await mark(ED, d, "entered", ago(5));
  await fails(mark(ED, d, "arrived", ago(2)), "22023", /מאוחרת מהכניסה/);
  await fails(end(ED, d, "done", null, ago(8)), "22023", /מוקדמת מהכניסה/);
  // עתיד של חצי דקה (סטיית שעון) — מתקבל, כ"עכשיו"
  await end(ED, d, "done", null, new Date(Date.now() + 30_000).toISOString());
  const ended = (await sup(`SELECT ended_at <= now() ok, ended_late FROM tech_dispatches WHERE id = $1`, [d]))[0];
  assert.deepEqual(ended, { ok: true, ended_late: true });

  // "נכנס" בלי "הגיע": שניהם באותה שעה, ושתי שורות ביומן
  const d2 = (await dispatch(ED, t, { site: "TC2" })).dispatch_id;
  await mark(ED, d2, "entered");
  const both = (await sup(`SELECT arrived_at = entered_at same, arrived_by FROM tech_dispatches WHERE id = $1`, [d2]))[0];
  assert.deepEqual(both, { same: true, arrived_by: "רכז בדיקה" });
  assert.deepEqual((await logOf(t)).filter((l) => String(l.dispatch_id) === String(d2)).map((l) => l.action),
    ["dispatch", "arrived", "entered"]);
  assert.equal((await techOf(t)).status_today, "on_site");
  await end(ED, d2, "done");

  // מצב בדיעבד: לא לפני המצב הנוכחי
  await fails(setStatus(ED, t, "break", ago(60)), "22023", /מוקדמת מהמצב הקודם/);
  assert.equal((await setStatus(ED, t, "break")).changed, true);
});

test("אותו client_id שוב מחזיר את אותה שליחה (גם ממסך ישן); של טכנאי אחר — נדחה", { skip }, async () => {
  const t = await newTech();
  const other = await newTech();
  const client = randomUUID();
  const a = await dispatch(ED, t, { site: "TC1", client });
  const count = async () => (await sup(`SELECT count(*)::int n FROM tech_dispatches WHERE technician_id = $1`, [t]))[0].n;
  const b = await dispatch(ED, t, { site: "TC2", client, rev: 0 });
  assert.deepEqual([b.dispatch_id, b.changed], [a.dispatch_id, false]);
  assert.equal(await count(), 1);
  await fails(dispatch(ED, other, { site: "TC1", client }), "22023", /כבר שימש/);
  await fails(dispatch(ED, t, { site: "TC1", client: null }), "22023", /מזהה בקשה/);
  // השבתה של טכנאי באמצע שליחה — נדחית (השליחה הייתה נשארת פתוחה לנצח)
  const x = await techOf(t);
  await fails(save(ED, t, x.name, null, false, x.rev), "PT409", /שליחה פתוחה/);
  await end(ED, a.dispatch_id, "cancelled");
});

test("סיום: אותו סיום שוב — כלום; סיום אחר או סימון אחרי סיום — PT409; המצב הבא; 'moved' רק מבפנים", { skip }, async () => {
  const t = await newTech();
  const d = (await dispatch(ED, t, { site: "TC1" })).dispatch_id;
  await fails(end(ED, d, "moved"), "22023", /סיום לא מוכר/);
  await fails(end(ED, d, "done", "on_site"), "22023", /אינו תקין/);
  await fails(end(ED, d, "done", "lunch"), "22023", /אינו תקין/);
  await end(ED, d, "done", "day_done");
  assert.equal((await techOf(t)).status_today, "day_done");
  assert.equal((await end(ED, d, "done")).changed, false);
  await fails(end(ED, d, "cancelled"), "PT409", /כבר הסתיימה/);
  await fails(mark(ED, d, "arrived"), "PT409", /כבר הסתיימה/);
  await fails(mark(ED, d, "left"), "22023", /סימון לא מוכר/);
  await fails(mark(ED, 999999, "arrived"), "PT404");
  await fails(end(ED, 999999, "done"), "PT404");
  const c = (await dispatch(ED, t, { place: "משרד" })).dispatch_id;
  await end(ED, c, "cancelled");
  const row = (await sup(`SELECT end_kind FROM tech_dispatches WHERE id = $1`, [c]))[0];
  assert.equal(row.end_kind, "cancelled");
  assert.equal((await techOf(t)).status_today, "free");
});

test("עמידות: רכב שאיתוראן הורידו ומחיקת אתר — הטכנאי, השליחה והתמונה נשארים; טכנאי בלי רכב — בלי תמונה", { skip }, async () => {
  const now = new Date().toISOString();
  await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ('TC9','אתר שיימחק 9, חולון','ready',$1)`, [now]);
  await ingest([...FLEET, "7300009"].map(car));
  const t = (await save(ED, null, "Resilient Tech", "7300009")).id;
  const d = (await dispatch(ED, t, { site: "TC9" })).dispatch_id;
  await ingest(FLEET.map(car));   // 7300009 יצא מהחשבון
  let x = await techOf(t);
  assert.equal(x.plate, "7300009", "הרכב נשאר משויך");
  assert.equal(x.vehicle, null);
  await mark(ED, d, "arrived");
  const arr = (await logOf(t)).find((l) => l.action === "arrived");
  assert.deepEqual([arr.veh_plate, arr.veh_lat, arr.veh_state], ["7300009", null, null]);

  await fn(MGR, "delete_site", "TC9");
  x = await techOf(t);
  assert.equal(x.dispatch.id, d);
  assert.equal(x.dispatch.site_id, null);
  assert.deepEqual([x.dispatch.site_code, x.dispatch.site_name], ["TC9", "אתר שיימחק 9, חולון"]);
  assert.ok((await day(ED)).rows.some((l) => l.dispatch_id === d && l.site_name === "אתר שיימחק 9, חולון"));
  await end(ED, d, "done");

  const bare = await newTech();
  const d2 = (await dispatch(ED, bare, { site: "TC1" })).dispatch_id;
  const snap = (await logOf(bare)).find((l) => l.action === "dispatch");
  assert.deepEqual([snap.veh_plate, snap.veh_lat, snap.veh_address], [null, null, null]);
  await end(ED, d2, "cancelled");
});

test("המצב של היום: מאתמול (בשעון ישראל) = לא התחיל יום; חופש נמשך; שליחה פתוחה מאתמול נשארת", { skip }, async () => {
  const t = await newTech();
  await setStatus(ED, t, "free");
  await sup(`UPDATE technicians SET status_at = now() - interval '1 day' WHERE id = $1`, [t]);
  let x = await techOf(t);
  assert.deepEqual([x.status, x.status_today], ["free", null]);
  // "פנוי" שוב = תחילת היום — שינוי, לא "אותו מצב"
  assert.equal((await setStatus(ED, t, "free", null, x.rev)).changed, true);
  // הגבול בעבר אינו המצב של אתמול: אפשר לסמן "התחיל לפני שעה"
  await setStatus(ED, t, "vacation");
  await sup(`UPDATE technicians SET status_at = now() - interval '3 days' WHERE id = $1`, [t]);
  assert.equal((await techOf(t)).status_today, "vacation");
  await setStatus(ED, t, "free", ago(60));
  const d = (await dispatch(ED, t, { site: "TC1" })).dispatch_id;
  await sup(`UPDATE technicians SET status_at = now() - interval '1 day' WHERE id = $1`, [t]);
  await sup(`UPDATE tech_dispatches SET created_at = now() - interval '1 day' WHERE id = $1`, [d]);
  assert.equal((await techOf(t)).status_today, "en_route");
  await end(ED, d, "cancelled");
  // app.tech_status_today ישירות — שעון ישראל, לא UTC: 23:30 בישראל אתמול = אתמול, גם כשב-UTC זה "היום"
  const r = (await sup(`SELECT
      app.tech_status_today('free', ((now() AT TIME ZONE 'Asia/Jerusalem')::date::timestamp - interval '30 minutes') AT TIME ZONE 'Asia/Jerusalem', false) y,
      app.tech_status_today('free', ((now() AT TIME ZONE 'Asia/Jerusalem')::date::timestamp + interval '1 minute') AT TIME ZONE 'Asia/Jerusalem', false) t,
      app.tech_status_today(NULL, NULL, true) n`))[0];
  assert.deepEqual(r, { y: null, t: "free", n: null });
});

test("יומן יום: גבולות היום בישראל (25/10 — 25 שעות), החדש למעלה, 'בדיעבד' = נרשם יותר משתי דקות אחרי", { skip }, async () => {
  const t = await newTech();
  const ins = (at, logged = at) => sup(`INSERT INTO tech_log (technician_id, at, logged_at, action, status_after, actor)
                                        VALUES ($1, $2, $3, 'status', 'free', 'x')`, [t, at, logged]);
  await ins("2026-10-24T20:59:59Z");                          // 24/10 23:59:59 (קיץ, +3)
  await ins("2026-10-24T21:00:00Z");                          // 25/10 00:00 — הרגע הראשון של היום
  await ins("2026-10-25T21:59:59Z", "2026-10-25T22:30:00Z");  // 25/10 23:59:59 (חורף, +2) — נרשם חצי שעה אחר כך
  await ins("2026-10-25T22:00:00Z");                          // 26/10 00:00
  const r = await day(ED, "2026-10-25");
  assert.equal(r.day, "2026-10-25");
  const mine = r.rows.filter((l) => l.technician_id === t);
  assert.deepEqual(mine.map((l) => [l.at, l.late]), [["2026-10-25T21:59:59Z", true], ["2026-10-24T21:00:00Z", false]]);
  assert.equal((await day(ED, "2026-10-24")).rows.filter((l) => l.technician_id === t).length, 1);
  assert.equal((await day(ED, "2026-10-26")).rows.filter((l) => l.technician_id === t).length, 1);
});

test("בלי events; audit עם מזהים בלבד — בלי שם הטכנאי ובלי שם האתר", { skip }, async () => {
  const before = (await sup(`SELECT count(*)::int n FROM events`))[0].n;
  const t = (await save(ED, null, "Secret Name Tech", "7300006")).id;
  const d = (await dispatch(ED, t, { site: "TC1", details: "פרטים פרטיים" })).dispatch_id;
  await sup(`UPDATE tech_dispatches SET created_at = now() - interval '10 minutes' WHERE id = $1`, [d]);
  await mark(ED, d, "arrived");
  await mark(ED, d, "entered");
  await mark(ED, d, "arrived", ago(5));
  await end(ED, d, "done");
  await setStatus(ED, t, "break");
  assert.equal((await sup(`SELECT count(*)::int n FROM events`))[0].n, before, "אף שורת events");
  const audits = await sup(`SELECT action, target_type, target_id, details FROM audit_log
                             WHERE action LIKE 'tech.%' AND target_id = $1 ORDER BY id`, [String(t)]);
  assert.deepEqual(audits.map((a) => a.action),
    ["tech.add", "tech.dispatch", "tech.arrived", "tech.entered", "tech.correction", "tech.end", "tech.status"]);
  for (const a of audits) {
    const s = JSON.stringify(a.details ?? {});
    for (const secret of ["Secret Name Tech", "רחוב הבדיקה", "פרטים פרטיים", "7300006"]) {
      assert.ok(!s.includes(secret), `${a.action}: ${s}`);
    }
    assert.equal(a.target_type, "technician");
  }
  assert.equal(audits[1].details.site_code, "TC1");
});

test("הגריפה: מיקום אחרי 30 יום, יומן ושליחויות אחרי 90; שליחה פתוחה נשארת; המשימה מתוזמנת", { skip }, async () => {
  const t = await newTech();
  const ins = (days, d = null) => sup(`INSERT INTO tech_log (technician_id, at, action, dispatch_id, actor, veh_plate, veh_lat, veh_lon, veh_address)
                                        VALUES ($1, now() - make_interval(days => $2), 'arrived', $3, 'x', 'P', 32.1, 34.8, 'כתובת')
                                        RETURNING id::int AS id`, [t, days, d]);
  const disp = (days, ended) => sup(`INSERT INTO tech_dispatches (client_id, technician_id, place, created_by, created_at, ended_at, ended_by, end_kind)
                                      VALUES ($1, $2, 'מקום', 'x', now() - make_interval(days => $3),
                                              CASE WHEN $4 THEN now() - make_interval(days => $3) END, CASE WHEN $4 THEN 'x' END,
                                              CASE WHEN $4 THEN 'done' END) RETURNING id::int AS id`, [randomUUID(), t, days, ended]);
  const oldDone = (await disp(100, true))[0].id;
  const oldOpen = (await disp(100, false))[0].id;
  const recent = (await ins(10))[0].id;
  const month = (await ins(40))[0].id;
  const ancient = (await ins(100, oldDone))[0].id;
  const r = (await sup(`SELECT app.prune_technicians() r`))[0].r;
  assert.ok(r.coords >= 1 && r.log >= 1 && r.dispatches >= 1, JSON.stringify(r));
  const rows = Object.fromEntries((await sup(`SELECT id::int AS id, veh_lat, veh_lon, veh_address, veh_plate FROM tech_log WHERE id = ANY($1)`,
    [[recent, month, ancient]])).map((x) => [x.id, x]));
  assert.equal(rows[recent].veh_lat, 32.1, "10 ימים — המיקום נשאר");
  assert.deepEqual([rows[month].veh_lat, rows[month].veh_lon, rows[month].veh_address, rows[month].veh_plate],
    [null, null, null, "P"], "40 ימים — הקואורדינטות והכתובת נמחקו, השורה נשארה");
  assert.equal(rows[ancient], undefined, "100 ימים — נמחקה");
  const left = (await sup(`SELECT id::int AS id FROM tech_dispatches WHERE id = ANY($1)`, [[oldDone, oldOpen]])).map((x) => x.id);
  assert.deepEqual(left, [oldOpen], "שליחה פתוחה לא נמחקת בשום גיל");
  const job = (await sup(`SELECT command, active FROM cron.job WHERE jobname = 'parkomat-prune-technicians'`))[0];
  assert.deepEqual(job, { command: "SELECT app.prune_technicians()", active: true });
  await sup(`DELETE FROM tech_dispatches WHERE id = $1`, [oldOpen]);
});

test("הלוח: הרכב זהה לזה של המפה (בונה אחד), כל הצי ב-fleet, מצב הסנכרון", { skip }, async () => {
  const t = (await save(ED, null, "Map Twin Tech", null)).id;
  const x0 = await techOf(t);
  await save(ED, t, "Map Twin Tech", "7300007", true, x0.rev);
  const x = await techOf(t);
  assert.equal(x.plate, "7300007");
  // המפה מוסיפה stats (הסיכום היומי); כל השאר — אותו בונה, app.vehicle_json
  const { stats, ...map } = (await fn(RO, "vehicles_live_list")).vehicles.find((v) => v.plate === x.plate);
  assert.equal(typeof stats, "object");
  assert.deepEqual(x.vehicle, map);
  const b = await board(RO);
  assert.deepEqual(b.fleet.map((v) => v.plate).sort(), FLEET);
  assert.ok(b.fleet.every((v) => v.name.startsWith("רכב בדיקה")));
  assert.ok(b.sync && b.sync.last_ok_at, "מצב הסנכרון");
  assert.match(b.now, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test("החלה חוזרת של הקובץ לא משנה כלום — הנתונים, האילוצים והאינדקסים נשארים", { skip }, async () => {
  const count = async () => (await sup(`SELECT (SELECT count(*) FROM technicians)::int t, (SELECT count(*) FROM tech_dispatches)::int d,
                                               (SELECT count(*) FROM tech_log)::int l`))[0];
  const before = await count();
  await h.pg.exec(fs.readFileSync(path.join(__dirname, "..", "db", "vehicles.postgres.sql"), "utf8"));
  await h.pg.exec(fs.readFileSync(path.join(__dirname, "..", "db", "technicians.postgres.sql"), "utf8"));
  assert.deepEqual(await count(), before);
  const cons = (await sup(`SELECT conname FROM pg_constraint WHERE conrelid IN ('technicians'::regclass, 'tech_dispatches'::regclass,
                             'tech_log'::regclass) AND contype = 'c'`)).map((r) => r.conname).sort();
  assert.deepEqual(cons, ["tech_dispatches_dest", "tech_dispatches_end_kind", "tech_dispatches_end_shape", "tech_dispatches_marks_shape",
    "tech_dispatches_order", "tech_log_action", "tech_log_source", "tech_log_status", "technicians_name_shape",
    "technicians_plate_shape", "technicians_status_chk", "technicians_status_shape"]);
  const idx = (await sup(`SELECT indexname FROM pg_indexes WHERE tablename IN ('technicians','tech_dispatches','tech_log')
                           AND indexname LIKE 'ux_%' OR indexname LIKE 'ix_tech%' ORDER BY indexname`)).map((r) => r.indexname);
  for (const i of ["ux_technicians_active_name", "ux_technicians_active_plate", "ux_tech_dispatch_open", "ix_tech_dispatch_site",
    "ix_tech_log_dispatch", "ix_tech_log_at"]) assert.ok(idx.includes(i), i);
  assert.equal((await board()).enabled, true);
});

// ============================================================
// הטלפון של הטכנאי — שלב 2 של "צא ל:" (21/10/2026)
// ============================================================
// מדמה את ה-Edge Function provision-technician: begin (בזהות הרכז) → משתמש חדש באימייל שה-SQL החזיר (כמו
// provision_app_user: שורה בתפקיד בקר) → link (בזהות השירות).
const phoneUser = async (email) => {
  const uid = randomUUID();
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at)
             VALUES ($1, NULL, 'operator', true, $2, 'x')`, [email, uid]);
  return uid;
};
const linkAs = (role, tech, gen, uid, actor = "רכז בדיקה") =>
  as(role, role === "service_role" ? {} : { sub: ED, session_id: "5e550000-0000-0000-0000-0000000000bb" },
    `SELECT public.tech_phone_link($1, $2, $3, $4) r`, [tech, gen, uid, actor]).then((r) => r[0].r);
async function pair(tech, uid0 = ED) {
  const b = await fn(uid0, "tech_phone_begin", tech);
  const uid = await phoneUser(b.email);
  const l = await linkAs("service_role", tech, b.gen, uid, b.actor);
  return { b, uid, l };
}

test("הטלפון: QR לעורך בפיילוט בלבד; משתמש חדש מקבל 'טכנאי' ורואה רק את המשימה שלו", { skip }, async () => {
  // ⚠️ טכנאי אחר עם שליחה פתוחה — לפני שלנו: "שליחה פתוחה כלשהי" הייתה מראה אותה בטלפון שלנו
  const early = await newTech();
  await dispatch(ED, early, { site: "TC2", details: "של מישהו אחר" });
  const tech = await newTech();
  await fails(fn(RO, "tech_phone_begin", tech), "42501");
  await fails(fn(ED2, "tech_phone_begin", tech), "42501", /לוח הטכנאים אינו פעיל/);
  await fails(fn(ED, "tech_phone_begin", 999999), "PT404");

  const { b, uid, l } = await pair(tech);
  assert.equal(b.email, `tech-${tech}-1@parkomat.co.il`);
  assert.equal(b.gen, 1);
  assert.equal(b.old_uid, null);
  assert.equal(b.actor, "רכז בדיקה");
  assert.equal(l.ok, true);
  assert.equal(l.replaced, false);
  const row = (await sup(`SELECT role, is_active, full_name, site_id FROM app_users WHERE supabase_uid = $1`, [uid]))[0];
  assert.deepEqual(row, { role: "technician", is_active: true, full_name: (await techOf(tech)).name, site_id: null });
  assert.equal((await sup(`SELECT count(*)::int n FROM audit_log WHERE action = 'tech.phone_qr' AND target_id = $1`, [String(tech)]))[0].n, 1);

  // הכרטיס: QR נוצר, עוד לא נסרק
  let x = await techOf(tech);
  assert.equal(x.phone.paired, true);
  assert.equal(x.phone.paired_by, "רכז בדיקה");
  assert.match(x.phone.paired_at, /Z$/);
  assert.equal(x.phone.seen_at, null, "עד שהטלפון פונה — לא נסרק");

  // הטלפון: מי אני, בלי משימה; "נראה" נרשם
  assert.equal(await fn(uid, "my_role"), "technician");
  let me = await fn(uid, "tech_me");
  assert.equal(me.id, Number(tech));
  assert.equal(me.dispatch, null);
  x = await techOf(tech);
  assert.match(x.phone.seen_at, /Z$/);

  // משימה עם אתר שיש לו מיקום — הטלפון מקבל לאן, מה, מי ומתי, ואת המיקום לניווט
  await sup(`UPDATE sites SET lat = 32.08, lon = 34.78, geo_source = 'manual', geo_precision = 'pin' WHERE code = 'TC1'`);
  await dispatch(ED, tech, { site: "TC1", details: "מעלית תקועה" });
  me = await fn(uid, "tech_me");
  assert.equal(me.dispatch.site_code, "TC1");
  assert.equal(me.dispatch.details, "מעלית תקועה");
  assert.equal(me.dispatch.created_by, "רכז בדיקה");
  assert.equal(me.dispatch.lat, 32.08);
  assert.equal(me.dispatch.lon, 34.78);

  // ⚠️ ורק את זה: לא הלוח, לא הרכבים, לא טבלות האתרים, ולא כתיבה של רכז
  await fails(fn(uid, "tech_board"), "42501");
  await fails(fn(uid, "vehicles_live_list"), "42501");
  // ⚠️ RLS על sites דלוק בייצור (Supabase מדליק לכל טבלה חדשה), אבל לא ב-PGlite — מדליקים כאן לרגע
  await sup(`ALTER TABLE sites ENABLE ROW LEVEL SECURITY`);
  try {
    assert.equal((await user(uid, `SELECT count(*)::int n FROM sites`))[0].n, 0, "RLS: הטלפון לא קורא אתרים");
    assert.ok((await user(RO, `SELECT count(*)::int n FROM sites`))[0].n >= 2, "ובקר — כן (המדיניות עצמה עובדת)");
  } finally {
    await sup(`ALTER TABLE sites DISABLE ROW LEVEL SECURITY`);
  }
  assert.equal((await user(uid, `SELECT app.is_staff() s`))[0].s, false);
  assert.equal((await user(uid, `SELECT app.is_active_user() s`))[0].s, false);
  await fails(dispatch(uid, tech, { site: "TC2" }), "42501");
  await fails(fn(uid, "tech_phone_begin", tech), "42501");
  // ⚠️ וטכנאי אחר — לא: technician_id() הוא מי שהקורא, לא פרמטר
  const other = await newTech();
  await dispatch(ED, other, { site: "TC2", details: "של השני" });
  me = await fn(uid, "tech_me");
  assert.equal(me.dispatch.site_code, "TC1");
  assert.equal(me.dispatch.details, "מעלית תקועה");

  // הגנה כפולה: גם אם השורות שונו ביד — טכנאי מושבת, או משתמש שאינו בתפקיד technician — הטלפון אינו רואה כלום
  await sup(`UPDATE technicians SET is_active = false WHERE id = $1`, [tech]);
  await fails(fn(uid, "tech_me"), "42501");
  await sup(`UPDATE technicians SET is_active = true WHERE id = $1`, [tech]);
  await sup(`UPDATE app_users SET role = 'operator' WHERE supabase_uid = $1`, [uid]);
  await fails(fn(uid, "tech_me"), "42501");
  await sup(`UPDATE app_users SET role = 'technician' WHERE supabase_uid = $1`, [uid]);
  assert.equal((await fn(uid, "tech_me")).id, Number(tech));
  // משתמש שהושבת (ביד) — הכרטיס אומר "לא מחובר", גם כשהקישור נשאר
  await sup(`UPDATE app_users SET is_active = false WHERE supabase_uid = $1`, [uid]);
  assert.equal((await techOf(tech)).phone.paired, false);
  await sup(`UPDATE app_users SET is_active = true WHERE supabase_uid = $1`, [uid]);
  assert.equal((await techOf(tech)).phone.paired, true);
});

test("הטלפון: QR חדש = משתמש חדש, והקודם נסגר מיד; QR ישן שהגיע באיחור נדחה; ניתוק; השבתת הטכנאי", { skip }, async () => {
  const tech = await newTech();
  const first = await pair(tech);
  assert.ok(await fn(first.uid, "tech_me"));

  // שני QR במקביל: הישן (gen 2) נדחה כשה-gen 3 כבר נוצר
  const b2 = await fn(ED, "tech_phone_begin", tech);
  const b3 = await fn(ED, "tech_phone_begin", tech);
  assert.equal(b3.old_uid, first.uid, "המשתמש הקודם — כדי שהפונקציה תמחק אותו אחרי החיבור");
  const u2 = await phoneUser(b2.email);
  await fails(linkAs("service_role", tech, b2.gen, u2), "PT409", /QR חדש/);
  const u3 = await phoneUser(b3.email);
  await fails(linkAs("service_role", tech, b3.gen, u2), "22023", /אינו של החיבור/);
  await fails(linkAs("service_role", tech, b3.gen, randomUUID()), "PT404");
  const l3 = await linkAs("service_role", tech, b3.gen, u3);
  assert.equal(l3.replaced, true);

  // הקודם — מושבת, ונסגר מיד (גם עם אסימון תקף)
  assert.equal((await sup(`SELECT is_active FROM app_users WHERE supabase_uid = $1`, [first.uid]))[0].is_active, false);
  await fails(fn(first.uid, "tech_me"), "42501", /יש לסרוק QR חדש/);
  assert.equal((await fn(u3, "tech_me")).id, Number(tech));

  // ⚠️ link רק בזהות השירות
  await fails(linkAs("authenticated", tech, b3.gen, u3), "42501");

  // ניתוק: הטלפון נסגר; פעם שנייה — כלום
  const un = await fn(ED, "tech_phone_unpair", tech);
  assert.equal(un.changed, true);
  assert.equal((await sup(`SELECT is_active FROM app_users WHERE supabase_uid = $1`, [u3]))[0].is_active, false,
    "המשתמש עצמו מושבת — לא רק הקישור");
  await fails(fn(u3, "tech_me"), "42501");
  assert.equal((await techOf(tech)).phone.paired, false);
  assert.equal((await fn(ED, "tech_phone_unpair", tech)).changed, false);
  await fails(fn(RO, "tech_phone_unpair", tech), "42501");

  // השבתת טכנאי משביתה גם את הטלפון
  const again = await pair(tech);
  assert.equal(again.b.gen, 4);
  const t = await techOf(tech);
  await save(ED, tech, t.name, null, false, t.rev);
  assert.equal((await sup(`SELECT is_active FROM app_users WHERE supabase_uid = $1`, [again.uid]))[0].is_active, false);
  await fails(fn(again.uid, "tech_me"), "42501");
});

test("הטלפון: לא ברשימת המשתמשים, לא מקבל תפקיד אחר, וקוד הכניסה במייל אינו חל עליו", { skip }, async () => {
  const tech = await newTech();
  const { uid } = await pair(tech);
  const id = (await sup(`SELECT id FROM app_users WHERE supabase_uid = $1`, [uid]))[0].id;
  const list = await user(MGR, `SELECT out_role FROM public.list_users()`);
  assert.ok(list.every((r) => r.out_role !== "technician" && r.out_role !== "agent"));
  await fails(user(MGR, `SELECT * FROM public.set_user_role($1, 'manager')`, [id]), "23514", /זהות של סוכן או של טלפון/);
  try {
    await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('login_code_required', 'all', 'x')
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    assert.equal((await fn(uid, "tech_me")).id, Number(tech), "בלי קוד — לטכנאי אין תיבת מייל");
    assert.equal(await fn(ED, "my_role"), "unverified", "ולרכז — כן (הבדיקה עצמה תקינה)");
  } finally {
    await sup(`DELETE FROM settings WHERE key = 'login_code_required'`);
  }
  // ⚠️ המסלול של הייצור: אילוץ ישן בלי 'technician' מוחלף בהחלה של schema.postgres.sql (במסד חדש ה-CREATE TABLE
  // כבר כולל אותו, וה-DO לא רץ — בלי זה הבדיקה לא הייתה רואה את הבלוק בכלל)
  await sup(`UPDATE app_users SET role = 'operator' WHERE role = 'technician'`);
  await sup(`ALTER TABLE app_users DROP CONSTRAINT app_users_role_check`);
  await sup(`ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('operator', 'editor', 'manager', 'agent'))`);
  await h.pg.exec(fs.readFileSync(path.join(__dirname, "..", "db", "schema.postgres.sql"), "utf8"));
  await sup(`UPDATE app_users SET role = 'technician' WHERE id = $1`, [id]);
  // האילוץ מקבל את התפקיד, ורק אותו בנוסף
  const def = (await sup(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'app_users_role_check'`))[0].d;
  assert.match(def, /'technician'/);
  await assert.rejects(sup(`UPDATE app_users SET role = 'tech' WHERE id = $1`, [id]));
});

// ============================================================
// הצפצוף — שלב 4 (21/10/2026)
// ============================================================
const svc = async (sql, params = []) => (await as("service_role", {}, sql, params))[0];
const claim = async (d) => (await svc(`SELECT public.tech_push_claim($1) r`, [d])).r;
const result = async (d, sent, dead, err) =>
  (await svc(`SELECT public.tech_push_result($1, $2, $3::bigint[], $4) r`, [d, sent, dead, err])).r;
const SUB = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/test-${n}-${randomUUID()}`, p256dh: "B".repeat(87), auth: "a".repeat(22) });
const subscribe = (uid, s) => fn(uid, "tech_push_subscribe", s.endpoint, s.p256dh, s.auth);
const dispOf = async (id) => (await sup(`SELECT * FROM tech_dispatches WHERE id = $1`, [id]))[0];
const queued = async () => sup(`SELECT url, headers, body FROM net.http_request_queue ORDER BY id`);
async function withPushSettings(f) {
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('push_caller_secret', 'test-secret', 'x'), ('push_anon_key', 'anon-test', 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  try { await f(); } finally { await sup(`DELETE FROM settings WHERE key IN ('push_caller_secret', 'push_anon_key')`); }
}

test("הצפצוף: הטלפון נרשם לצפצוף (רק הוא, ורק מנוי תקין), והשליחה מבקשת צפצוף מ-notify-tech", { skip }, async () => {
  const tech = await newTech();
  const { uid } = await pair(tech);
  // רישום: רק הטלפון של טכנאי, ורק מנוי בצורה של Web Push
  await fails(subscribe(ED, SUB(1)), "42501");
  await fails(fn(uid, "tech_push_subscribe", "http://not-https", "B".repeat(87), "a".repeat(22)), "22023");
  await fails(fn(uid, "tech_push_subscribe", SUB(1).endpoint, "short", "a".repeat(22)), "22023");
  assert.equal((await techOf(tech)).phone.push_ready, false);
  const s1 = SUB(1);
  assert.deepEqual(await subscribe(uid, s1), { ok: true, devices: 1 });
  assert.deepEqual(await subscribe(uid, { ...s1, auth: "b".repeat(22) }), { ok: true, devices: 1 }, "אותו endpoint — מתעדכן, לא כפול");
  assert.equal((await techOf(tech)).phone.push_ready, true);
  assert.equal((await fn(uid, "tech_me")).push_devices, 1);

  // בלי הגדרות push — השליחה עוברת, והכרטיס אומר למה אין צפצוף
  await sup(`DELETE FROM net.http_request_queue`);
  const d0 = (await dispatch(ED, tech, { site: "TC1", details: "בלי הגדרות" })).dispatch_id;
  assert.equal((await queued()).length, 0);
  assert.equal((await dispOf(d0)).push_error, "הצפצוף אינו מוגדר במערכת");

  await withPushSettings(async () => {
    const d1 = (await dispatch(ED, tech, { site: "TC1", details: "מעלית 2 תקועה" })).dispatch_id;
    const q = await queued();
    assert.equal(q.length, 1);
    assert.equal(q[0].url, "https://xvfsikwaaaohnmldjbtv.supabase.co/functions/v1/notify-tech");
    assert.deepEqual(q[0].body, { dispatch_id: Number(d1) });
    assert.equal(q[0].headers["x-parkomat-push-secret"], "test-secret");
    assert.equal(q[0].headers.Authorization, "Bearer anon-test");
    // ⚠️ צפצוף שנכשל (פונקציית הבקשה חסרה) אינו מכשיל שליחה
    await sup(`ALTER FUNCTION app.tech_push_request(bigint) RENAME TO tech_push_request_off`);
    try {
      const d2 = (await dispatch(ED, tech, { site: "TC2" })).dispatch_id;
      assert.ok(d2, "השליחה הצליחה");
      assert.match((await dispOf(d2)).push_error, /^הצפצוף לא נשלח: /);
    } finally {
      await sup(`ALTER FUNCTION app.tech_push_request_off(bigint) RENAME TO tech_push_request`);
    }
  });
});

test("הצפצוף: claim — מתי שולחים, למי, ומה כתוב; result — מה הגיע, ומנויים שנעלמו נמחקים (רק של הטכנאי הזה)", { skip }, async () => {
  const tech = await newTech();
  const { uid } = await pair(tech);
  const s1 = SUB(1), s2 = SUB(2);
  await subscribe(uid, s1);
  await subscribe(uid, s2);
  const other = await newTech();
  const o = await pair(other);
  await subscribe(o.uid, SUB(3));
  const otherSubId = (await sup(`SELECT s.id FROM tech_push_subs s JOIN app_users u ON u.id = s.app_user_id WHERE u.supabase_uid = $1`, [o.uid]))[0].id;

  const d = (await dispatch(ED, tech, { site: "TC1", details: "מעלית 2\nתקועה" })).dispatch_id;
  let c = await claim(d);
  assert.equal(c.send, true);
  assert.equal(c.n, 1);
  assert.equal(c.title, "משימה חדשה: רחוב הבדיקה 50, תל אביב · TC1");
  assert.equal(c.body, "מעלית 2 תקועה", "שורות — רווח אחד");
  assert.equal(c.tag, `dispatch-${d}`);
  assert.deepEqual(c.subs.map((s) => s.endpoint).sort(), [s1.endpoint, s2.endpoint].sort(), "רק המנויים של הטכנאי הזה");
  assert.equal((await claim(d)).reason, "recent", "בקשה כפולה באותה דקה — לא שולחים פעמיים");
  await assert.rejects(user(ED, `SELECT public.tech_push_claim($1)`, [d]), "רק השירות");
  await assert.rejects(user(ED, `SELECT public.tech_push_result($1, 1, '{}'::bigint[], NULL)`, [d]));

  // result: נשלח לאחד; endpoint שנעלם — נמחק; מנוי של טכנאי אחר ברשימה — לא נוגעים
  const subIds = c.subs.map((s) => s.id);
  const r = await result(d, 1, [subIds[1], otherSubId], null);
  assert.equal(r.removed, 1);
  assert.equal((await sup(`SELECT count(*)::int n FROM tech_push_subs WHERE id = $1`, [otherSubId]))[0].n, 1, "המנוי של טכנאי אחר נשאר");
  let row = await dispOf(d);
  assert.equal(row.push_sent, 1);
  assert.equal(row.push_error, null);
  // תזכורת: אחרי 90 שניות, כותרת אחרת; אחרי 3 — לא עוד
  await sup(`UPDATE tech_dispatches SET push_last_at = now() - interval '3 minutes' WHERE id = $1`, [d]);
  c = await claim(d);
  assert.equal(c.n, 2);
  assert.match(c.title, /^תזכורת — משימה ממתינה: /);
  await result(d, 0, [], "לא ענו");
  assert.equal((await dispOf(d)).push_error, "לא ענו");
  await sup(`UPDATE tech_dispatches SET push_last_at = now() - interval '3 minutes' WHERE id = $1`, [d]);
  assert.equal((await claim(d)).n, 3);
  await sup(`UPDATE tech_dispatches SET push_last_at = now() - interval '3 minutes' WHERE id = $1`, [d]);
  assert.equal((await claim(d)).reason, "max");

  // אושר / הסתיים / אין טלפון
  const d2 = (await dispatch(ED, tech, { site: "TC2" })).dispatch_id;
  await fn(uid, "tech_self_ack", d2);
  assert.equal((await claim(d2)).reason, "acked");
  await end(ED, d2, "done");
  assert.equal((await claim(d2)).reason, "ended");
  assert.equal((await claim(999999)).reason, "gone");
  const lonely = await newTech();
  const d3 = (await dispatch(ED, lonely, { site: "TC1" })).dispatch_id;
  assert.equal((await claim(d3)).reason, "no_phone");
  row = await dispOf(d3);
  assert.equal(row.push_error, "הטלפון של הטכנאי לא הפעיל צפצוף");
  assert.equal(row.push_count, 0, "בלי טלפון — לא נספר כניסיון");
  await end(ED, d3, "cancelled");
  // משתמש הטלפון הושבת בדרך אחרת (המנויים שלו נשארו בטבלה) — לא מצפצפים אליו
  await sup(`UPDATE app_users SET is_active = false WHERE supabase_uid = $1`, [o.uid]);
  const d4 = (await dispatch(ED, other, { site: "TC2" })).dispatch_id;
  assert.equal((await claim(d4)).reason, "no_phone", "משתמש מושבת — המכשירים שלו לא מקבלים");
  await sup(`UPDATE app_users SET is_active = true, role = 'operator' WHERE supabase_uid = $1`, [o.uid]);
  await sup(`UPDATE tech_dispatches SET push_last_at = NULL, push_error = NULL WHERE id = $1`, [d4]);
  assert.equal((await claim(d4)).reason, "no_phone", "משתמש שאינו בתפקיד טכנאי — לא");
  await sup(`UPDATE app_users SET role = 'technician' WHERE supabase_uid = $1`, [o.uid]);
  await end(ED, d4, "cancelled");
});

test("הצפצוף: התזכורת כל 2 דקות — רק לפתוחה שלא אושרה, עם טלפון, ופחות מ-3", { skip }, async () => {
  await withPushSettings(async () => {
    const mk = async (withPhone = true) => {
      const tech = await newTech();
      let uid = null;
      if (withPhone) { uid = (await pair(tech)).uid; await subscribe(uid, SUB(tech)); }
      const d = (await dispatch(ED, tech, { site: "TC1" })).dispatch_id;
      return { tech, uid, d };
    };
    const due = await mk();          // צפצוף אחד לפני 3 דקות — תזכורת
    const fresh = await mk();        // צפצוף לפני דקה — עוד לא
    const acked = await mk();        // אישר
    const maxed = await mk();        // 3 צפצופים
    const missed = await mk();       // הראשון לא יצא (0), השליחה לפני 3 דקות — תזכורת
    const nophone = await mk(false); // בלי טלפון — לא
    const arrived = await mk();      // הרכז סימן "הגיע" — לא (21/10/2026, בדיקת הבאגים)
    const capped = await mk();       // 5 בקשות בלי claim (הפונקציה לא עונה) — לא עוד
    const edge = await mk();         // הצפצוף לפני 110 שניות — כן (סובלנות 20 שניות: אחרת יצא כל 2.5–3 דקות)
    // ⚠️ כל שליחה כבר יצאה לבקשה ראשונה (push_requested_at = עכשיו) — מזיזים גם אותה, כמו בייצור
    const set = (d, cols) => sup(`UPDATE tech_dispatches SET ${cols} WHERE id = $1`, [d]);
    await set(due.d, `push_count = 1, push_last_at = now() - interval '3 minutes', push_requested_at = now() - interval '181 seconds'`);
    await set(fresh.d, `push_count = 1, push_last_at = now() - interval '1 minute', push_requested_at = now() - interval '61 seconds'`);
    await set(acked.d, `push_count = 1, push_last_at = now() - interval '3 minutes', push_requested_at = now() - interval '181 seconds'`);
    await fn(acked.uid, "tech_self_ack", acked.d);
    await set(maxed.d, `push_count = 3, push_last_at = now() - interval '9 minutes', push_requested_at = now() - interval '9 minutes'`);
    await set(missed.d, `push_count = 0, push_last_at = NULL, created_at = now() - interval '3 minutes', push_requested_at = now() - interval '3 minutes'`);
    await set(nophone.d, `created_at = now() - interval '5 minutes', push_requested_at = now() - interval '5 minutes'`);
    await set(arrived.d, `push_count = 1, push_last_at = now() - interval '3 minutes', push_requested_at = now() - interval '181 seconds', arrived_at = now(), arrived_by = 'רכז בדיקה'`);
    await set(capped.d, `push_count = 0, push_last_at = NULL, push_attempts = 5, created_at = now() - interval '20 minutes', push_requested_at = now() - interval '3 minutes'`);
    await set(edge.d, `push_count = 1, push_last_at = now() - interval '110 seconds', push_requested_at = now() - interval '112 seconds'`);
    await sup(`DELETE FROM net.http_request_queue`);
    const n = (await sup(`SELECT app.tech_push_repeat() n`))[0].n;
    const ids = (await queued()).map((x) => x.body.dispatch_id).sort((a, b) => a - b);
    const want = [due.d, missed.d, edge.d].map(Number).sort((a, b) => a - b);
    assert.deepEqual(ids, want, JSON.stringify({ ids, due: due.d, missed: missed.d, edge: edge.d }));
    assert.equal(n, 3);
    // בקשה שאף claim לא בא אחריה — הכרטיס אומר שהשירות לא ענה (עד 21/10 נשאר "שולח צפצוף…" בלי סוף)
    assert.equal((await dispOf(missed.d)).push_error, "שירות הצפצוף לא ענה — הצפצוף לא נשלח");
    assert.equal((await dispOf(capped.d)).push_error, "שירות הצפצוף לא ענה — הצפצוף לא נשלח");
    assert.equal((await dispOf(due.d)).push_error, null, "צפצוף שנשלח — בלי שגיאה");
    // כל בקשה נספרת — גם זו של התזכורת
    assert.equal((await dispOf(missed.d)).push_attempts, 2);
    // claim אחרי "הגיע" — לא שולחים
    const c = (await sup(`SELECT public.tech_push_claim($1) j`, [arrived.d]))[0].j;
    assert.deepEqual({ send: c.send, reason: c.reason }, { send: false, reason: "arrived" });
    for (const x of [due, fresh, acked, maxed, missed, nophone, arrived, capped, edge]) await end(ED, x.d, "cancelled");
  });
  // התזמון קיים (ב-PGlite יש תחליף ל-cron.job)
  const job = await sup(`SELECT schedule, command FROM cron.job WHERE jobname = 'parkomat-tech-push-repeat'`).catch(() => []);
  if (job.length) assert.deepEqual({ ...job[0] }, { schedule: "* * * * *", command: "SELECT app.tech_push_repeat()" });
});

test("הצפצוף: 'קיבלתי' — רק על המשימה שלו; פעם שנייה כלום; הכרטיס אומר 'קיבל'; QR חדש, ניתוק והשבתה מוחקים את המנויים", { skip }, async () => {
  const tech = await newTech();
  const { uid } = await pair(tech);
  await subscribe(uid, SUB(1));
  const d = (await dispatch(ED, tech, { site: "TC1" })).dispatch_id;
  const other = await newTech();
  const od = (await dispatch(ED, other, { site: "TC2" })).dispatch_id;
  await fails(fn(uid, "tech_self_ack", od), "PT404", /המשימה לא נמצאה/);
  await fails(fn(ED, "tech_self_ack", d), "42501");
  const rev0 = (await techOf(tech)).rev;
  const a1 = await fn(uid, "tech_self_ack", d);
  assert.equal(a1.changed, true);
  assert.match(a1.acked_at, /Z$/);
  assert.equal((await fn(uid, "tech_self_ack", d)).changed, false);
  const x = await techOf(tech);
  assert.match(x.dispatch.acked_at, /Z$/);
  assert.equal(x.rev, rev0 + 1, "הכרטיס מתעדכן (rev)");
  assert.match((await fn(uid, "tech_me")).dispatch.acked_at, /Z$/);
  assert.equal((await sup(`SELECT count(*)::int n FROM audit_log WHERE action = 'tech.ack' AND target_id = $1`, [String(tech)]))[0].n, 1);
  await end(ED, d, "done");
  await fails(fn(uid, "tech_self_ack", d), "PT409");
  await end(ED, od, "cancelled");

  const subsOf = async (u) => (await sup(`SELECT count(*)::int n FROM tech_push_subs s JOIN app_users a ON a.id = s.app_user_id WHERE a.supabase_uid = $1`, [u]))[0].n;
  assert.equal(await subsOf(uid), 1);
  const second = await pair(tech);
  assert.equal(await subsOf(uid), 0, "QR חדש — הטלפון הקודם לא יצפצף");
  await subscribe(second.uid, SUB(2));
  await fn(ED, "tech_phone_unpair", tech);
  assert.equal(await subsOf(second.uid), 0, "ניתוק — לא יצפצף");
  const third = await pair(tech);
  await subscribe(third.uid, SUB(3));
  const t = await techOf(tech);
  await save(ED, tech, t.name, null, false, t.rev);
  assert.equal(await subsOf(third.uid), 0, "טכנאי מושבת — לא יצפצף");
});

test("בדיקת הבאגים (21/10): היומן ורשימת העובדים — רק צוות; 'ניתוק הטלפון הזה' מנתק באמת; ביומן בלי שם הטכנאי", { skip }, async () => {
  const tech = await newTech();
  const { uid } = await pair(tech);
  await subscribe(uid, SUB(`self-${tech}`));
  const d = (await dispatch(ED, tech, { site: "TC1" })).dispatch_id;
  await fn(uid, "tech_self_ack", d);
  const ackRow = (await sup(`SELECT actor_name FROM audit_log WHERE action = 'tech.ack' ORDER BY id DESC LIMIT 1`))[0];
  assert.equal(ackRow.actor_name, "טלפון של טכנאי", "'קיבלתי' ביומן — בלי שם הטכנאי");

  // היומן ורשימת העובדים: צוות קורא; טלפון, סוכן וקליטה — לא (עד 21/10 כל חשבון מחובר קרא)
  const n = async (who, t) => (await user(who, `SELECT count(*)::int n FROM ${t}`))[0].n;
  for (const who of [MGR, ED, RO]) {
    assert.ok((await n(who, "audit_log")) > 0, `צוות (${who}) קורא את היומן`);
    assert.ok((await n(who, "app_users")) > 0, `צוות (${who}) קורא את רשימת העובדים`);
  }
  for (const [who, label] of [[uid, "טלפון"], [AG, "סוכן"], [IN, "קליטה"]]) {
    assert.equal(await n(who, "audit_log"), 0, `${label} — לא קורא את היומן`);
    assert.equal(await n(who, "app_users"), 0, `${label} — לא קורא את רשימת העובדים`);
  }
  // בקר שהושבת — גם לא (עד שהטוקן שלו פג הוא קרא הכול)
  await sup(`UPDATE app_users SET is_active = false WHERE supabase_uid = $1`, [RO]);
  assert.equal(await n(RO, "audit_log"), 0, "מושבת — לא קורא את היומן");
  await sup(`UPDATE app_users SET is_active = true WHERE supabase_uid = $1`, [RO]);

  // "ניתוק הטלפון הזה" מהטלפון: המנוי נמחק, הקישור נמחק, המשתמש מושבת
  await end(ED, d, "done");
  const r = await fn(uid, "tech_self_unpair");
  assert.equal(r.changed, true);
  assert.equal((await sup(`SELECT count(*)::int n FROM tech_push_subs s JOIN app_users u ON u.id = s.app_user_id WHERE u.supabase_uid = $1`, [uid]))[0].n, 0,
    "המנוי לצפצוף נמחק — הטלפון לא יצפצף יותר");
  assert.equal((await sup(`SELECT app_user_id FROM technicians WHERE id = $1`, [tech]))[0].app_user_id, null, "הכרטיס: אין טלפון מחובר");
  assert.equal((await sup(`SELECT is_active FROM app_users WHERE supabase_uid = $1`, [uid]))[0].is_active, false);
  await fails(fn(uid, "tech_me"), "42501");
  assert.equal((await fn(uid, "tech_self_unpair")).changed, false, "פעם שנייה — כלום, בלי שגיאה");
  const unpairRow = (await sup(`SELECT actor_name FROM audit_log WHERE action = 'tech.phone_self_unpair' ORDER BY id DESC LIMIT 1`))[0];
  assert.equal(unpairRow.actor_name, "טלפון של טכנאי");
  await fails(as("anon", {}, `SELECT public.tech_self_unpair()`), "42501");
});
