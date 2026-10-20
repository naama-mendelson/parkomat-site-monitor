// tests/vehicles.test.js — רכבי הטכנאים מאיתוראן (vehicles.postgres.sql): קליטה, השעון, מחיקה, מצב הסנכרון, הרשאות,
// והקריאה ל-Edge Function מ-pg_cron.
//
// ⚠️ הנתונים כאן מומצאים — בצורה של תשובת איתוראן אמיתית (נמדדה 20/10/2026), בלי שמות ולוחיות אמיתיים: המאגר ציבורי.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "f1000000-0000-0000-0000-000000000001";
const RO = "f1000000-0000-0000-0000-000000000002";
const AG = "f1000000-0000-0000-0000-000000000003";
const IN = "f1000000-0000-0000-0000-000000000004";

let h;
const sup = async (sql, params = []) => (await h.pg.query(sql, params)).rows;
async function as(role, claims, sql, params = []) {
  return h.pg.transaction(async (tx) => {
    await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, ...claims })]);
    await tx.query(`SET LOCAL ROLE ${role}`);
    return (await tx.query(sql, params)).rows;
  });
}
const svc = (sql, params) => as("service_role", {}, sql, params);
const user = (uid, sql, params) => as("authenticated", { sub: uid, session_id: "5e550000-0000-0000-0000-0000000000aa" }, sql, params);
const ingest = async (vehicles, meta = { complete: true }) =>
  (await svc(`SELECT public.ituran_ingest($1::jsonb, $2::jsonb) n`, [JSON.stringify(vehicles), JSON.stringify(meta)]))[0].n;
const list = async (uid = MGR) => (await user(uid, `SELECT public.vehicles_live_list() j`))[0].j;
async function fails(p, code) {
  await assert.rejects(p, (e) => { assert.equal(e.code, code, `ציפיתי ל-${code}, התקבל ${e.code}: ${e.message}`); return true; });
}

// רכב בצורה של GET /api/v2/vehicles?realtime_fields=LastLocation&realtime_fields=Driver&realtime_fields=Places
const car = (plate, over = {}) => ({
  license_plate: plate, vehicle_id: Number(plate.slice(-5)), vin: "X", nickname: `טכנאי בדיקה ${plate}`,
  model_name: "דגם", make_name: "יצרן", model_year: "2024", color: "לבן", motion_status: "driving",
  last_location: {
    location: { point: { lat: 32.0853, lon: 34.7818 }, address: { location: "רחוב הבדיקה, תל אביב", speedlimit: 50 } },
    odometer: 12345.6, speed: 54, heading: 270, timestamp: "2026-10-20T12:58:46.64",
  },
  places: [{ place_name: "משרד", place_id: 1 }],
  current_driver: { first_name: "נהג", last_name: "בדיקה" },
  ...over,
});

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  const site = (await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ('VH1','אתר','ready',$1) RETURNING id`, [now]))[0].id;
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, site_id, created_at) VALUES
      ('vh-mgr@parkomat.co.il','מנהלת','manager',true,$1,NULL,$5),
      ('vh-ro@parkomat.co.il','בקר','operator',true,$2,NULL,$5),
      ('site-vh1@parkomat.co.il','סוכן','agent',true,$3,$6,$5),
      ('intake@parkomat.co.il','קליטה','editor',true,$4,NULL,$5)`, [MGR, RO, AG, IN, now, site]);
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('intake_user_id', $1, 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [IN]);
});
after(async () => { if (h) await h.close(); });

test("השעון של איתוראן: בלי אזור זמן = שעון ישראל, קיץ וחורף; עם Z או היסט — כמו שהוא; משובש — NULL", { skip }, async () => {
  // ⚠️ כטקסט ב-UTC מתוך ה-SQL: timestamp בלי אזור שחוזר ל-node מתפרש לפי השעון של המחשב, ובדיקה כזו הייתה עוברת רק בחורף
  const u = (x) => `to_char(${x} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;
  const r = (await sup(`SELECT
      ${u("app.ituran_ts('2026-10-20T12:58:46.64')")} summer,
      ${u("app.ituran_ts('2026-12-20T12:58:46')")} winter,
      ${u("app.ituran_ts('2026-10-25T00:30:00')")} dst_day,
      ${u("app.ituran_ts('2026-10-25T03:00:00')")} dst_after,
      ${u("app.ituran_ts('2026-10-20T09:58:46Z')")} zulu,
      ${u("app.ituran_ts('2026-10-20T12:58:46+03:00')")} offs,
      app.ituran_ts('not a date') bad, app.ituran_ts('') empty, app.ituran_ts(NULL) nul`))[0];
  const iso = (s) => s;
  assert.equal(iso(r.summer), "2026-10-20T09:58:46.640");   // +3 בקיץ
  assert.equal(iso(r.winter), "2026-12-20T10:58:46.000");   // +2 בחורף
  // 25/10/2026: השעון חוזר ב-02:00 ל-01:00. 00:30 עוד קיץ (+3), 03:00 כבר חורף (+2). (01:00–02:00 מופיע פעמיים — לא נבדק)
  assert.equal(iso(r.dst_day), "2026-10-24T21:30:00.000");
  assert.equal(iso(r.dst_after), "2026-10-25T01:00:00.000");
  assert.equal(iso(r.zulu), "2026-10-20T09:58:46.000");
  assert.equal(iso(r.offs), "2026-10-20T09:58:46.000");
  assert.deepEqual([r.bad, r.empty, r.nul], [null, null, null]);
});

test("קליטה: כל השדות מהצורה של איתוראן, ומצב הסנכרון", { skip }, async () => {
  assert.equal(await ingest([car("1000001"), car("1000002", { motion_status: "parking", current_driver: null })]), 2);
  const j = await list();
  assert.equal(j.vehicles.length, 2);
  const a = j.vehicles.find((v) => v.plate === "1000001");
  assert.deepEqual({ ...a, located_at: a.located_at, synced_at: undefined }, {
    plate: "1000001", name: "טכנאי בדיקה 1000001", make: "יצרן", model: "דגם", motion: "driving",
    lat: 32.0853, lon: 34.7818, address: "רחוב הבדיקה, תל אביב", speed: 54, heading: 270, odometer: 12345.6,
    located_at: "2026-10-20T09:58:46Z", places: [{ place_name: "משרד", place_id: 1 }], driver: "נהג בדיקה", synced_at: undefined,
  });
  assert.equal(j.vehicles.find((v) => v.plate === "1000002").driver, null);
  assert.equal(j.sync.vehicles, 2);
  assert.ok(j.sync.last_ok_at);
  assert.match(j.now, /Z$/);
});

test("עדכון: מיקום חדש מחליף; תשובה בלי מיקום או ישנה יותר — לא מוחקת ולא מחזירה לאחור; 0,0 אינו מיקום", { skip }, async () => {
  await ingest([car("1000001", { last_location: { ...car("x").last_location, location: { point: { lat: 31.5, lon: 34.9 }, address: { location: "מקום חדש" } }, timestamp: "2026-10-20T13:10:00" } })]);
  let v = (await list()).vehicles.find((x) => x.plate === "1000001");
  assert.deepEqual([v.lat, v.lon, v.address, v.located_at], [31.5, 34.9, "מקום חדש", "2026-10-20T10:10:00Z"]);
  // בלי LastLocation — המיקום נשאר, השאר מתעדכן
  await ingest([car("1000001", { last_location: undefined, motion_status: "parking" })]);
  v = (await list()).vehicles.find((x) => x.plate === "1000001");
  assert.deepEqual([v.lat, v.address, v.motion, v.located_at], [31.5, "מקום חדש", "parking", "2026-10-20T10:10:00Z"]);
  // מיקום ישן יותר שהגיע באיחור — לא מחזיר לאחור
  await ingest([car("1000001", { last_location: { ...car("x").last_location, location: { point: { lat: 30, lon: 35 } }, timestamp: "2026-10-20T12:00:00" } })]);
  v = (await list()).vehicles.find((x) => x.plate === "1000001");
  assert.deepEqual([v.lat, v.located_at], [31.5, "2026-10-20T10:10:00Z"]);
  // 0,0 — "אין מיקום"
  await ingest([car("1000003", { last_location: { ...car("x").last_location, location: { point: { lat: 0, lon: 0 } } } })]);
  v = (await list()).vehicles.find((x) => x.plate === "1000003");
  assert.deepEqual([v.lat, v.lon], [null, null]);
  // שדות משובשים אינם מפילים את הסנכרון
  assert.equal(await ingest([car("1000004", { vehicle_id: "abc", last_location: { speed: "fast", timestamp: "אתמול" } }), { nickname: "בלי לוחית" }],
                            { complete: false }), 1);
});

test("מחיקה: רכב שהוצא מהחשבון נעלם — רק בתשובה מלאה ולא ריקה", { skip }, async () => {
  await ingest([car("1000001"), car("1000002"), car("1000003")]);
  await ingest([car("1000001")], { complete: false });   // חלקית — לא מוחקת
  assert.equal((await list()).vehicles.length, 3);
  await ingest([], { complete: true });                  // ריקה — לא מוחקת (תקלה אצלם)
  assert.equal((await list()).vehicles.length, 3);
  await ingest([car("1000001"), car("1000003")], { complete: true });
  assert.deepEqual((await list()).vehicles.map((v) => v.plate), ["1000001", "1000003"]);
});

test("מצב הסנכרון: כשל נרשם; טוקן חדש נספר", { skip }, async () => {
  await svc(`SELECT public.ituran_sync_failed('איתוראן לא ענו (503)')`);
  let j = await list();
  assert.equal(j.sync.last_error, "איתוראן לא ענו (503)");
  assert.ok(j.sync.last_error_at);
  const before = Number((await sup(`SELECT token_fetches n FROM vehicles_sync`))[0].n);
  await ingest([car("1000001"), car("1000003")], { complete: true, token_fresh: true });
  await ingest([car("1000001"), car("1000003")], { complete: true, token_fresh: false });
  const s = (await sup(`SELECT token_fetches n, last_token_at, last_error FROM vehicles_sync`))[0];
  assert.equal(Number(s.n), before + 1);
  assert.ok(s.last_token_at);
  assert.equal(s.last_error, "איתוראן לא ענו (503)");   // נשאר לתיעוד; המסך משווה לזמן ההצלחה האחרונה
});

test("הרשאות: מנהל ובקר רואים; סוכן, קליטה ואנונימי — לא; כתיבה לשירות בלבד; הטבלאות סגורות", { skip }, async () => {
  assert.ok((await list(MGR)).vehicles.length > 0);
  assert.ok((await list(RO)).vehicles.length > 0);   // "כל מי שמחובר"
  await fails(user(AG, `SELECT public.vehicles_live_list()`), "42501");
  await fails(user(IN, `SELECT public.vehicles_live_list()`), "42501");
  await fails(as("anon", {}, `SELECT public.vehicles_live_list()`), "42501");
  await fails(user(MGR, `SELECT public.ituran_ingest('[]'::jsonb, '{}'::jsonb)`), "42501");
  await fails(user(MGR, `SELECT public.ituran_sync_failed('x')`), "42501");
  for (const t of ["vehicles_live", "vehicles_sync"]) {
    await fails(user(MGR, `SELECT * FROM ${t}`), "42501");
    await fails(as("anon", {}, `SELECT * FROM ${t}`), "42501");
  }
  // התחברות שלא הקלידה את הקוד מהמייל — לא רואה רכבים (קוד הכניסה, security.postgres.sql)
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('login_code_required', 'all', 'x')`);
  try { await fails(user(MGR, `SELECT public.vehicles_live_list()`), "42501"); }
  finally { await sup(`DELETE FROM settings WHERE key = 'login_code_required'`); }
});

test("pg_cron → Edge Function: בלי סוד — לא נשלח כלום; עם סוד — POST עם המפתח והסוד; בלי מפתח — נרשם כשל", { skip }, async () => {
  await sup(`DELETE FROM net.http_request_queue`);
  await sup(`DELETE FROM settings WHERE key IN ('ituran_caller_secret', 'push_anon_key')`);
  assert.equal((await sup(`SELECT app.ituran_sync_request() id`))[0].id, null);
  assert.equal(Number((await sup(`SELECT count(*) n FROM net.http_request_queue`))[0].n), 0);

  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('ituran_caller_secret', ' S3CRET ', 'x')`);
  assert.equal((await sup(`SELECT app.ituran_sync_request() id`))[0].id, null);
  assert.match((await sup(`SELECT last_error FROM vehicles_sync`))[0].last_error, /push_anon_key/);

  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('push_anon_key', 'ANON', 'x')`);
  assert.ok((await sup(`SELECT app.ituran_sync_request() id`))[0].id);
  const q = (await sup(`SELECT url, headers FROM net.http_request_queue`))[0];
  assert.equal(q.url, "https://xvfsikwaaaohnmldjbtv.supabase.co/functions/v1/ituran-sync");
  assert.equal(q.headers.Authorization, "Bearer ANON");
  assert.equal(q.headers["x-parkomat-ituran-secret"], "S3CRET");
  // מתוזמן כל דקה, ולא נגיש לדפדפן
  const job = (await sup(`SELECT schedule, command FROM cron.job WHERE jobname = 'parkomat-ituran-sync'`))[0];
  assert.deepEqual(job, { schedule: "* * * * *", command: "SELECT app.ituran_sync_request()" });
  await fails(user(MGR, `SELECT app.ituran_sync_request()`), "42501");
  await sup(`DELETE FROM settings WHERE key IN ('ituran_caller_secret', 'push_anon_key')`);
});
