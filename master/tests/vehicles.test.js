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

// רכב בצורה של GET /api/v2/vehicles?realtime_fields=LastLocation&realtime_fields=Places&realtime_fields=Events
// (current_driver נשאר בצורה כדי לבדוק שהקליטה עוד יודעת לקרוא אותו, אף שהסנכרון כבר לא מבקש אותו)
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
  // המצב תלוי בגיל הדיווח ביום הרצת הבדיקה — נבדק בנפרד, עם זמנים יחסיים
  assert.deepEqual({ ...a, synced_at: undefined, state: undefined, state_since: undefined }, {
    plate: "1000001", name: "טכנאי בדיקה 1000001", make: "יצרן", model: "דגם", motion: "driving",
    lat: 32.0853, lon: 34.7818, address: "רחוב הבדיקה, תל אביב", speed: 54, heading: 270, odometer: 12345.6,
    located_at: "2026-10-20T09:58:46Z", places: [{ place_name: "משרד", place_id: 1 }], driver: "נהג בדיקה",
    power_alert: null, synced_at: undefined, state: undefined, state_since: undefined,
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

// ── המצב שמוצג (20/10/2026) ──
// זמנים יחסיים לשעון של המחשב: הטקסט הוא שעון ישראל כמו אצל איתוראן, והציפייה ב-UTC כמו ש-vehicles_live_list מחזירה.
const IL = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
                                              hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const ilText = (d) => { const p = Object.fromEntries(IL.formatToParts(d).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`; };
const T0 = Math.floor(Date.now() / 1000) * 1000;
const ago = (sec) => new Date(T0 - sec * 1000);
const utc = (d) => d.toISOString().slice(0, 19) + "Z";
const P = { lat: 32.0853, lon: 34.7818 };
const north = (m) => ({ lat: P.lat + m / 111_195, lon: P.lon });   // מטר צפונה ≈ 1/111,195 מעלה
const ev = (id, name, sec, point = P) => ({ event_id: id, event_name: name, time_start: ilText(ago(sec)), point });
const at = (sec, over = {}) => ({ ...car("x").last_location, location: { point: P, address: { location: "רחוב הבדיקה, תל אביב" } },
                                  timestamp: ilText(ago(sec)), ...over });
const OFF = [10181704, "סגירת סוויץ"], ENGINE_OFF = [12746436, "מנוע כבוי"], STOP = [12746438, "רכב בעצירה"];
const SWITCH_ON = [12746440, "פתיחת סוויץ"], ENGINE_ON = [5295693, "מנוע עובד"], MOVING = [12746437, "רכב בתנועה"];
const CUT = [12746446, "ניתוק מתח"], LOW = [12746445, "מתח מצבר נמוך"], POWER_OK = [12746447, "חיבור  מתח"];
const byPlate = async () => Object.fromEntries((await list()).vehicles.map((v) => [v.plate, v]));

test("מצב: לפי גיל הדיווח — נסיעה עד 5 דקות, מנוע דולק עד 10, 'לא מדווח' אחרי 24 שעות; הגבולות", { skip }, async () => {
  const st = async (motion, age, located = true) => (await sup(
    `SELECT app.vehicle_state($1, CASE WHEN $4 THEN $2::timestamptz - make_interval(secs => $3) END, $2::timestamptz) s`,
    [motion, "2026-10-20T10:00:00Z", age, located]))[0].s;
  const cases = [
    ["driving", 0, "driving"], ["driving", 299, "driving"], ["driving", 300, "driving"], ["driving", 301, "silent"],
    ["driving", 2400, "silent"], ["driving", 86400, "silent"], ["driving", 86401, "no_report"],
    ["driving", -30, "driving"],                       // שעון המכשיר מקדים — לא "לא מתעדכן"
    ["idle", 599, "idle"], ["idle", 600, "idle"], ["idle", 601, "silent"], ["idle", 86460, "no_report"],
    ["parking", 0, "parking"], ["parking", 43200, "parking"], ["parking", 86340, "parking"], ["parking", 86400, "parking"],
    ["parking", 86401, "no_report"],
    ["none", 60, "unknown"], [null, 60, "unknown"], ["none", 90000, "no_report"],
  ];
  for (const [motion, age, want] of cases) assert.equal(await st(motion, age), want, `${motion} לפני ${age} שניות`);
  for (const motion of ["driving", "parking", null]) assert.equal(await st(motion, 0, false), "no_report", `${motion} בלי מיקום`);
});

test("סוג אירוע: לפי המזהה, ואם אינו מוכר — לפי השם (רווחים מצומצמים); אירוע אחר — NULL", { skip }, async () => {
  const k = (id, name) => `app.ituran_event_kind(${id === null ? "NULL" : `'${id}'`}, ${name === null ? "NULL" : `'${name}'`})`;
  const r = (await sup(`SELECT ${[
    k("10181704", null), k("12746436", "שם אחר"), k("12746438", null), k("12746440", null), k("5295693", null),
    k("12746437", null), k("12746446", null), k("12746445", null), k("12746447", null),
    k("1", " סגירת  סוויץ "), k("1", "מנוע כבוי"), k("1", "רכב בעצירה"), k("1", "חיבור  מתח"), k("1", "ניתוק מתח"),
    k("12746451", "פקודת נטרול סקוטר עברה בהצלחה"), k("12746449", "סוללה נמוכה בשלט"), k(null, null),
  ].map((x, i) => `${x} c${i}`).join(", ")}`))[0];
  assert.deepEqual(Object.values(r), ["off", "off", "stop", "on", "on", "on", "power_cut", "power_cut", "power_ok",
                                      "off", "off", "stop", "power_ok", "power_cut", null, null, null]);
});

test("מצב במפה: 'חונה מאז' מהכיבוי הקרוב שאחרי כל הדלקה; לא מתעדכן / לא מדווח — הדיווח האחרון; ניתוק מתח", { skip }, async () => {
  const park = (plate, events, loc = at(600)) => car(plate, { motion_status: "parking", last_location: loc, events });
  await ingest([
    // כיבוי סוויץ ומנוע כאן אחרי תנועה ועצירה → הכיבוי האחרון
    park("2000001", [ev(...MOVING, 2400), ev(...STOP, 1920, north(50)), ev(...OFF, 1800), ev(...ENGINE_OFF, 1797)]),
    park("2000002", [ev(...OFF, 1800, north(300))]),                        // כיבוי רחוק מ-200 מ' → לא ידוע
    park("2000003", [ev(...OFF, 1800), ev(...SWITCH_ON, 1200)]),             // הודלק אחרי הכיבוי → לא ידוע
    park("2000004", [ev(...STOP, 1500)]),                                    // רק עצירה → העצירה
    park("2000005", [ev(...OFF, 1800), ev(...STOP, 1200)]),                  // כיבוי ואחריו עצירה → הכיבוי
    park("2000006", [ev(1, " מנוע  כבוי ", 1700)]),                          // מזהה לא מוכר, השם מוכר
    park("2000007", [ev(...OFF, 200000)], at(190000)),                       // יומיים בלי דיווח
    car("2000008", { motion_status: "driving", last_location: at(60) }),
    car("2000009", { motion_status: "driving", last_location: at(7200), events: [ev(...MOVING, 7300)] }),
    park("2000011", [ev(...OFF, 1800), ev(...CUT, 600)]),
    park("2000012", [ev(...CUT, 10800), ev(...ENGINE_ON, 7200), ev(...ENGINE_OFF, 3600)]),
    park("2000013", [ev(...LOW, 10800), ev(...POWER_OK, 7200)]),
    car("2000014", { motion_status: "parking", last_location: at(600) }),   // בלי אירועים בכלל
    // ניתוק ואחריו מתח נמוך, שניהם אחרי הכיבוי → מאז הראשון, בשמו (כמו האופנוע שנמדד)
    park("2000015", [ev(...ENGINE_ON, 4000), ev(...OFF, 3000), ev(...CUT, 2760), ev(...LOW, 2700), ev(9, "", 2600)]),
    park("2000016", [ev(12746446, "", 500)]),                               // בלי שם → שם כללי
  ], { complete: false });
  let v = await byPlate();
  const show = (p) => [v[p].state, v[p].state_since, v[p].power_alert];
  assert.deepEqual(show("2000001"), ["parking", utc(ago(1797)), null]);
  assert.deepEqual(show("2000002"), ["parking", null, null]);
  assert.deepEqual(show("2000003"), ["parking", null, null]);
  assert.deepEqual(show("2000004"), ["parking", utc(ago(1500)), null]);
  assert.deepEqual(show("2000005"), ["parking", utc(ago(1800)), null]);
  assert.deepEqual(show("2000006"), ["parking", utc(ago(1700)), null]);
  assert.deepEqual(show("2000007"), ["no_report", utc(ago(190000)), null]);
  assert.deepEqual(show("2000008"), ["driving", null, null]);
  assert.deepEqual(show("2000009"), ["silent", utc(ago(7200)), null]);
  assert.deepEqual(show("2000011"), ["parking", utc(ago(1800)), { at: utc(ago(600)), name: "ניתוק מתח" }]);
  assert.deepEqual(show("2000012"), ["parking", utc(ago(3600)), null]);   // הונע אחרי הניתוק — המתח חזר
  assert.deepEqual(show("2000013"), ["parking", null, null]);              // חיבור מתח אחרי מתח נמוך
  assert.deepEqual(show("2000014"), ["parking", null, null]);
  assert.deepEqual(show("2000015"), ["parking", utc(ago(3000)), { at: utc(ago(2760)), name: "ניתוק מתח" }]);
  assert.deepEqual(show("2000016"), ["parking", null, { at: utc(ago(500)), name: "תקלת מתח" }]);
  assert.equal(v["2000001"].motion, "parking");   // מה שאיתוראן אמרו נשאר גלוי לצד המצב

  // תשובה בלי Events לא מוחקת את "חונה מאז"; מערך ריק — כן (איתוראן אומרים שאין)
  await ingest([car("2000001", { motion_status: "parking", last_location: at(300) })], { complete: false });
  assert.equal((await byPlate())["2000001"].state_since, utc(ago(1797)));
  await ingest([car("2000001", { motion_status: "parking", last_location: at(300), events: [] })], { complete: false });
  assert.equal((await byPlate())["2000001"].state_since, null);

  // ⚠️ הגיל נמדד מול synced_at של השורה, לא מול now(): סנכרון שנתקע לשעתיים לא הופך את הצי ל"לא מתעדכן" — את זה אומרת
  // שורת הסנכרון. דיווח של לפני דקה, כפי שהיה ברגע הסנכרון, נשאר "בנסיעה".
  await ingest([car("2000008", { motion_status: "driving", last_location: at(60) })], { complete: false });
  await sup(`UPDATE vehicles_live SET synced_at = synced_at - interval '2 hours', located_at = located_at - interval '2 hours'
              WHERE license_plate = '2000008'`);
  assert.equal((await byPlate())["2000008"].state, "driving");
});

test("שמירה מנתונים משובשים: -999, '!! Address not found !!', 0,0 חדש יותר לא מוחק מיקום; המקומות הולכים עם המיקום", { skip }, async () => {
  await ingest([
    car("2000021", { last_location: at(60, { speed: -999, heading: -999, location: { point: P, address: { location: "!! Address not found !!" } } }) }),
    car("2000022", { last_location: at(60, { speed: "1000000000000", heading: 400 }) }),   // לא מפיל את הסנכרון
    car("2000023", { last_location: at(1200), places: [{ place_name: "משרד", place_id: 1 }] }),
  ], { complete: false });
  let v = await byPlate();
  assert.deepEqual([v["2000021"].speed, v["2000021"].heading, v["2000021"].address, v["2000021"].lat], [null, null, null, P.lat]);
  assert.deepEqual([v["2000022"].speed, v["2000022"].heading], [null, null]);

  // יחידה עם תקלת GPS: רשומה חדשה יותר בלי מיקום (0,0, -999) — המיקום, הכתובת והזמן הידועים נשארים
  await ingest([car("2000023", { last_location: at(60, { speed: -999, heading: -999,
    location: { point: { lat: 0, lon: 0 }, address: { location: "!! Address not found !!" } } }), places: [] })], { complete: false });
  v = await byPlate();
  assert.deepEqual([v["2000023"].lat, v["2000023"].address, v["2000023"].located_at, v["2000023"].places],
                   [P.lat, "רחוב הבדיקה, תל אביב", utc(ago(1200)), [{ place_name: "משרד", place_id: 1 }]]);
  // מיקום חדש בלי השדה places — המקומות נשארים; מיקום ישן יותר עם מקומות אחרים — לא מחליף
  await ingest([car("2000023", { last_location: at(900), places: undefined })], { complete: false });
  await ingest([car("2000023", { last_location: at(1000), places: [{ place_name: "אחר", place_id: 2 }] })], { complete: false });
  v = await byPlate();
  assert.deepEqual([v["2000023"].located_at, v["2000023"].places], [utc(ago(900)), [{ place_name: "משרד", place_id: 1 }]]);
  // מיקום חדש יותר בלי אזורים — יצא מהאזור
  await ingest([car("2000023", { last_location: at(800), places: [] })], { complete: false });
  assert.deepEqual((await byPlate())["2000023"].places, []);
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
