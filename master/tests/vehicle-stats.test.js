// tests/vehicle-stats.test.js — מה הטכנאים עשו היום (vehicle-stats.postgres.sql, 21/10/2026): "באתר" לפי רדיוס, הסיכום
// היומי, ציר היום, הביקורים באתרים, ו"מי הכי קרוב" לאתר בתקלה.
//
// היום מדומה דקה אחר דקה: שורת vehicles_live נכתבת ישירות (כמו שהקליטה הייתה כותבת), ואז app.vehicles_track(t).
// ⚠️ הלוחיות והאתרים מומצאים — המאגר ציבורי.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
const MGR = "f3000000-0000-0000-0000-000000000001";
const RO = "f3000000-0000-0000-0000-000000000002";

let h;
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
const userRaw = (uid, sql, params) => as("authenticated", { sub: uid, session_id: "5e550000-0000-0000-0000-0000000000cc" }, sql, params);
const user = async (uid, sql, params) => { await h.pg.query(`INSERT INTO fleet_shown (license_plate) SELECT license_plate FROM vehicles_live ON CONFLICT DO NOTHING`); return userRaw(uid, sql, params); };
async function fails(p, code) {
  await assert.rejects(p, (e) => { assert.equal(e.code, code, `ציפיתי ל-${code}, התקבל ${e.code}: ${e.message}`); return true; });
}

// 10/11/2026 08:00 בישראל (חורף, +2) = 06:00Z. T(m) = m דקות אחר כך; היום מתחיל ב-22:00Z של אתמול, ולכן 08:00 = דקה 480.
const BASE = Date.parse("2026-11-10T06:00:00Z");
const T = (m) => new Date(BASE + m * 60_000).toISOString();
const DAY = "2026-11-10";
const M0 = 480;
const S1 = { lat: 32.1, lon: 34.8 };       // אתר בבניין — רדיוס 150 מ'
const S2 = { lat: 32.12, lon: 34.82 };     // אתר משוער לפי רחוב — רדיוס 300 מ'
const HOME = { lat: 32.05, lon: 34.75 };   // רחוק מכל אתר
const off = (p, north, east = 0) => ({ lat: p.lat + north / 111195, lon: p.lon + east / (111195 * Math.cos((p.lat * Math.PI) / 180)) });

async function car(plate, { motion, at = HOME, m, fixM = m, speed = 0, odo = null, events = [] }) {
  await sup(`INSERT INTO vehicles_live (license_plate, nickname, motion, lat, lon, speed, odometer, located_at, events, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
             ON CONFLICT (license_plate) DO UPDATE SET motion = EXCLUDED.motion, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
               speed = EXCLUDED.speed, odometer = COALESCE(EXCLUDED.odometer, vehicles_live.odometer),
               located_at = EXCLUDED.located_at, events = EXCLUDED.events, synced_at = EXCLUDED.synced_at`,
  [plate, `רכב בדיקה ${plate}`, motion, at.lat, at.lon, speed, odo, T(fixM), JSON.stringify(events), T(m)]);
}
const track = async (m) => (await sup(`SELECT app.vehicles_track($1::timestamptz) n`, [T(m)]))[0].n;
// 22/10/2026: "באתר" רק לרכב שנסע היום — רכב שמגיע לאתר בבדיקה נוסע קודם (מהבית, ב-30 קמ"ש, בדקה m)
const drove = async (plates, m) => {
  for (const p of plates) await car(p, { motion: "driving", at: HOME, m, speed: 30 });
  await track(m);
};
const dayRow = async (plate, day = DAY) => (await sup(`SELECT * FROM vehicle_days WHERE license_plate = $1 AND day = $2`, [plate, day]))[0];
const stats = async (plate, m) => (await sup(`SELECT app.vehicle_stats_json($1, $2::timestamptz) j`, [plate, T(m)]))[0].j;
const visits = async (plate) => sup(`SELECT site_code, started_at, last_at, ended_at, no_signal, approx FROM vehicle_visits
                                     WHERE license_plate = $1 ORDER BY started_at`, [plate]);
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  const geo = (code, p, precision, source = "geocoded") =>
    sup(`INSERT INTO sites (code, site_name, status, registered_at, lat, lon, geo_source, geo_precision, geo_set_at, geo_set_by)
         VALUES ($1, $2, 'ready', $3, $4, $5, $6, $7, $3, 'בדיקה')`, [code, `אתר בדיקה ${code}`, now, p.lat, p.lon, source, precision]);
  await geo("VS1", S1, "house");
  await geo("VS2", S2, "street");
  await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ('VS3', 'אתר בלי מיקום', 'ready', $1)`, [now]);
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
      ('vs-mgr@parkomat.co.il','מנהלת','manager',true,$1,$3), ('vs-ro@parkomat.co.il','בקר','operator',true,$2,$3)`, [MGR, RO, now]);
});
after(async () => { if (h) await h.close(); });

test("באתר: 150 מ' לאתר בבניין, 300 מ' לאתר משוער; הקרוב מנצח; אתר בלי מיקום — לא", { skip }, async () => {
  const at = async (p) => (await sup(`SELECT app.site_at($1, $2) j`, [p.lat, p.lon]))[0].j;
  assert.equal((await at(off(S1, 140))).code, "VS1");
  assert.equal((await at(off(S1, 140))).approx, false);
  assert.equal(await at(off(S1, 160)), null);
  assert.equal((await at(off(S2, 0, 290))).code, "VS2");
  assert.equal((await at(off(S2, 0, 290))).approx, true);
  assert.equal(await at(off(S2, 0, 310)), null);
  assert.equal(await at(HOME), null);
  assert.equal((await sup(`SELECT app.site_at(NULL, NULL) j`))[0].j, null);
  // שני אתרים בטווח — הקרוב
  const now = new Date().toISOString();
  const near = off(S1, 100);
  await sup(`INSERT INTO sites (code, site_name, status, registered_at, lat, lon, geo_source, geo_precision, geo_set_at, geo_set_by)
             VALUES ('VS9', 'שכן', 'ready', $1, $2, $3, 'manual', 'pin', $1, 'בדיקה')`, [now, near.lat, near.lon]);
  assert.equal((await at(off(S1, 70))).code, "VS9");
  assert.equal((await at(off(S1, 20))).code, "VS1");
  await sup(`DELETE FROM sites WHERE code = 'VS9'`);
});

test("סוג הרגע: נוסע, באתר (חונה / מנוע דולק / השתתק ליד אתר), חונה, השתתק, לא מדווח; רמזור = נסיעה", { skip }, async () => {
  const r = (await sup(`SELECT
      app.vehicle_kind('driving', true) a, app.vehicle_kind('idle', false) b, app.vehicle_kind('idle', true) c,
      app.vehicle_kind('parking', true) d, app.vehicle_kind('parking', false) e, app.vehicle_kind('silent', true) f,
      app.vehicle_kind('silent', false) g, app.vehicle_kind('no_report', true) i, app.vehicle_kind('unknown', NULL) j`))[0];
  assert.deepEqual(r, { a: "drive", b: "drive", c: "site", d: "site", e: "park", f: "site", g: "silent", i: "none", j: "none" });
});

test("יום שלם, דקה אחר דקה: נסיעה, ביקור באתר, רמזור ליד אתר אינו ביקור, ק\"מ, מהירות, עצירות וציר היום", { skip }, async () => {
  const P = "8100001";
  await car(P, { motion: "parking", m: 0, odo: 1000 });
  assert.equal(await track(0), 1);
  for (let m = 1; m <= 10; m++) {
    await car(P, { motion: "driving", at: off(HOME, m * 300), m, speed: m === 5 ? 77 : 40, odo: 1000 + m * 0.5 });
    await track(m);
  }
  for (let m = 11; m <= 40; m++) {
    await car(P, { motion: "parking", at: off(S1, 50), m, odo: 1005 });
    await track(m);
    if (m === 11) {
      const s = await stats(P, 11);
      assert.equal(s.visit.code, "VS1");
      assert.equal(s.visit.since, iso(T(11)));
      assert.equal(s.visit.approx, false);
    }
  }
  await car(P, { motion: "driving", at: off(S1, 600), m: 41, speed: 40, odo: 1005.5 });
  await track(41);
  // רמזור ליד אתר משוער: דגימה אחת של מנוע דולק — נכנס לציר, אבל אינו ביקור
  await car(P, { motion: "idle", at: off(S2, 100), m: 42, odo: 1006 });
  await track(42);
  for (let m = 43; m <= 49; m++) {
    await car(P, { motion: "driving", at: off(S2, -500 - m * 100), m, speed: 40, odo: 1005 + (m - 40) * 0.5 });
    await track(m);
  }
  await car(P, { motion: "parking", at: HOME, m: 50, odo: 1009.5 });
  await track(50);

  const d = await dayRow(P);
  assert.equal(d.drive_s, 1080, "10 דקות עד האתר, דקה אחריו, ושש וחצי עד הבית — בדגימות של דקה");
  assert.equal(d.site_s, 1860);
  assert.equal(d.stops, 3);
  assert.equal(d.max_speed, 77);
  assert.equal(Number(d.odo_last) - Number(d.odo_start), 9.5);
  assert.equal(iso(d.first_move), iso(T(1)));
  assert.equal(iso(d.last_move), iso(T(49)));
  assert.deepEqual(d.segments, [
    ["park", M0, M0 + 1, null], ["drive", M0 + 1, M0 + 11, null], ["site", M0 + 11, M0 + 41, "VS1"],
    ["drive", M0 + 41, M0 + 42, null], ["site", M0 + 42, M0 + 43, "VS2"], ["drive", M0 + 43, M0 + 50, null],
    ["park", M0 + 50, M0 + 50, null],
  ]);
  const v = await visits(P);
  assert.equal(v.length, 1, "הרמזור ליד VS2 נמחק — פחות משתי דקות");
  assert.deepEqual([v[0].site_code, iso(v[0].started_at), iso(v[0].ended_at)], ["VS1", iso(T(11)), iso(T(40))]);

  // ביקור מאתמול (שהסתיים) — לא ברשימת היום, כן בעמודה של אתמול בשבוע
  await sup(`INSERT INTO vehicle_visits (license_plate, site_code, site_name, started_at, last_at, ended_at)
             VALUES ($1, 'VS2', 'אתמול', $2, $3, $3)`, [P, T(-24 * 60), T(-24 * 60 + 30)]);
  const s = await stats(P, 50);
  assert.equal(s.visit, null, "בבית — אין ביקור פתוח");
  assert.equal(s.week.at(-2).visits, 1, "הביקור של אתמול — בעמודה של אתמול");
  assert.equal(s.today.km, 9.5);
  assert.equal(s.today.drive_s, 1080);
  assert.equal(s.today.stops, 3);
  assert.deepEqual(s.visits.map((x) => [x.code, x.from, x.to, x.open]), [["VS1", iso(T(11)), iso(T(40)), false]], "בלי הביקור של אתמול");
  assert.equal(s.day_start, "2026-11-09T22:00:00Z");
  assert.equal(s.day_minutes, 1440);
  assert.equal(s.now_min, M0 + 50);
  assert.equal(s.week.length, 7);
  assert.deepEqual(s.week.at(-1), { day: DAY, km: 9.5, drive_s: 1080, visits: 1, sites: 1, tracked: true });
  assert.deepEqual(s.week[0], { day: "2026-11-04", km: null, drive_s: 0, visits: 0, sites: 0, tracked: false });

  // פער של 25 דקות בסנכרון: נרשם כ-none, והזמן לא נספר
  await car(P, { motion: "parking", at: HOME, m: 75, odo: 1009.5 });
  await track(75);
  const g = await dayRow(P);
  assert.deepEqual(g.segments.slice(-3), [["park", M0 + 50, M0 + 55, null], ["none", M0 + 55, M0 + 75, null], ["park", M0 + 75, M0 + 75, null]]);
  assert.deepEqual([g.drive_s, g.site_s], [1080, 1860]);
  // אותה דגימה פעמיים, או דגימה ישנה שהגיעה באיחור — לא נספרת שוב
  await track(75);
  await car(P, { motion: "driving", m: 70, speed: 40 });
  await track(70);
  const g2 = await dayRow(P);
  assert.deepEqual([g2.drive_s, g2.segments.length, iso(g2.last_seen)], [1080, g.segments.length, iso(T(75))]);
});

test("פער באמצע נסיעה נספר עד 5 דקות; רכב שלא הגיע בסנכרון האחרון לא נספר; ק\"מ לא סבירים — אין", { skip }, async () => {
  const P = "8100008";
  await car(P, { motion: "driving", m: 600, speed: 40, odo: 10 });
  await track(600);
  await car(P, { motion: "driving", m: 620, speed: 40, odo: 20 });
  await track(620);
  assert.equal((await dayRow(P)).drive_s, 300, "20 דקות בלי סנכרון — לא 20 דקות נסיעה");
  // שורה שסונכרנה לאחרונה בדקה 620 — סנכרון בדקה 640 בלעדיה לא נוגע בה
  await track(640);
  assert.equal(iso((await dayRow(P)).last_seen), iso(T(620)));
  const km = (await sup(`SELECT app.vehicle_day_km(100, 50) a, app.vehicle_day_km(100, 2000) b, app.vehicle_day_km(100, 150.26) c,
                               app.vehicle_day_km(NULL, 5) d`))[0];
  assert.deepEqual([km.a, km.b, Number(km.c), km.d], [null, null, 50.3, null]);
});

test("חצות בישראל: יום חדש בשורה חדשה, והציר מתחיל מאפס", { skip }, async () => {
  const P = "8100002";
  // 10/11 23:59 בישראל = 21:59Z; 11/11 00:01 = 22:01Z
  await car(P, { motion: "parking", m: 959, odo: 500 });
  await track(959);
  await car(P, { motion: "driving", m: 961, speed: 30, odo: 500.4 });
  await track(961);
  const a = await dayRow(P, "2026-11-10");
  const b = await dayRow(P, "2026-11-11");
  assert.deepEqual(a.segments, [["park", 1439, 1439, null]]);
  assert.deepEqual(b.segments, [["drive", 1, 1, null]]);
  assert.equal(Number(b.odo_start), 500.4);
  assert.equal(iso(b.first_move), iso(T(961)));
  // 25/10/2026 — 25 שעות; 26/03/2027 — 23
  const len = async (t) => (await sup(`SELECT app.vehicle_stats_json('x', $1::timestamptz) j`, [t]))[0].j.day_minutes;
  assert.equal(await len("2026-10-25T10:00:00Z"), 1500);
  assert.equal(await len("2027-03-26T10:00:00Z"), 1380);
});

test("השתתק ליד אתר (חניון תת-קרקעי): באתר, אין קליטה; ההגעה לפי כיבוי ההצתה כשהוא ידוע", { skip }, async () => {
  const P = "8100003";
  await car(P, { motion: "driving", at: off(S1, 30), m: 100, speed: 20 });
  await track(100);
  // עד דקה 105 — עוד "בנסיעה"; בדקה 107 השתתק (בלי מיקום חדש שש דקות) — ליד האתר
  await car(P, { motion: "driving", at: off(S1, 30), m: 107, fixM: 100, speed: 20 });
  await track(107);
  await car(P, { motion: "driving", at: off(S1, 30), m: 108, fixM: 100, speed: 20 });
  await track(108);
  let s = await stats(P, 108);
  assert.deepEqual([s.visit.code, s.visit.no_signal], ["VS1", true]);
  assert.equal((await dayRow(P)).segments.at(-1)[0], "site");

  // חונה ליד אתר, וההצתה כובתה לפני 12 דקות שם — ההגעה היא הכיבוי
  const Q = "8100004";
  const ilText = (m) => new Date(BASE + m * 60_000 + 2 * 3_600_000).toISOString().slice(0, 19);   // שעון ישראל בחורף, בלי אזור
  const offEv = { event_id: "10181704", event_name: "כיבוי סוויץ'", time_start: ilText(188), point: off(S2, 40) };
  await drove([Q], 180);
  await car(Q, { motion: "parking", at: off(S2, 40), m: 200, events: [offEv] });
  await track(200);
  s = await stats(Q, 200);
  assert.equal(s.visit.since, iso(T(188)));
  // כיבוי ישן מ-12 שעות — לא נלקח
  const R = "8100005";
  const oldEv = { ...offEv, time_start: ilText(200 - 13 * 60) };
  await drove([R], 181);
  await car(R, { motion: "parking", at: off(S2, 40), m: 200, events: [oldEv] });
  await track(200);
  assert.equal((await stats(R, 200)).visit.since, iso(T(200)));
});

test("רכב שהוצא מהחשבון — הביקור הפתוח שלו נסגר; תקרת 400 מקטעים ליום", { skip }, async () => {
  const P = "8100006";
  await drove([P], 290);
  await car(P, { motion: "parking", at: off(S1, 10), m: 300 });
  await track(300);
  await car(P, { motion: "parking", at: off(S1, 10), m: 305 });
  await track(305);
  assert.equal((await visits(P)).filter((x) => !x.ended_at).length, 1);
  await sup(`DELETE FROM vehicles_live WHERE license_plate = $1`, [P]);
  await track(306);
  const v = await visits(P);
  assert.deepEqual([v.length, iso(v[0].ended_at)], [1, iso(T(305))]);

  const F = "8100007";
  for (let m = 0; m <= 420; m++) {
    await car(F, { motion: m % 2 ? "driving" : "parking", m: 500 + m, speed: 30 });
    await track(500 + m);
  }
  const d = await dayRow(F);
  assert.equal(d.segments.length, 400);
  assert.equal(d.segments.at(-1)[2], M0 + 920, "המקטע האחרון ממשיך להתארך");
});

test("הקליטה מפעילה את הסיכום; תקלה בסיכום לא מפילה את הסנכרון — נרשמת ומוצגת, ומתנקה כשהוא חוזר", { skip }, async () => {
  const ingest = (vehicles) => as("service_role", {}, `SELECT public.ituran_ingest($1::jsonb, '{}'::jsonb) n`, [JSON.stringify(vehicles)]);
  const v = {
    license_plate: "8200001", nickname: "רכב בדיקה 8200001", motion_status: "parking",
    last_location: { location: { point: off(S1, 20), address: { location: "רחוב, עיר" } }, odometer: 4321,
                     timestamp: new Date().toISOString().replace("Z", "+00:00") },
  };
  // נוסע קודם (לפני דקה), ואז חונה ליד האתר — "באתר" רק לרכב שנסע היום
  await ingest([{ ...v, motion_status: "driving",
                  last_location: { ...v.last_location, speed: 30, location: { point: HOME, address: { location: "רחוב, עיר" } },
                                   timestamp: new Date(Date.now() - 60_000).toISOString().replace("Z", "+00:00") } }]);
  await ingest([v]);
  const today = (await sup(`SELECT (now() AT TIME ZONE 'Asia/Jerusalem')::date::text d`))[0].d;
  const d = await dayRow("8200001", today);
  assert.ok(d, "שורה ליום");
  assert.equal(d.last_kind, "site");
  assert.equal(Number(d.odo_start), 4321);
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    await sup(`CREATE OR REPLACE FUNCTION app.vehicles_track(p_now timestamptz DEFAULT now()) RETURNS integer
               LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'vehicles_track: תקלה מדומה'; END $f$`);
    assert.equal((await ingest([v]))[0].n, 1, "הסנכרון עבר");
    const sync = (await sup(`SELECT stats_error, last_ok_at FROM vehicles_sync WHERE id = 1`))[0];
    assert.match(sync.stats_error, /vehicles_track/);
    const list = (await user(MGR, `SELECT public.vehicles_live_list() j`))[0].j;
    assert.match(list.sync.stats_error, /vehicles_track/);
  } finally {
    await h.pg.exec(fs.readFileSync(path.join(__dirname, "..", "db", "vehicle-stats.postgres.sql"), "utf8"));
  }
  await ingest([v]);
  assert.equal((await sup(`SELECT stats_error FROM vehicles_sync WHERE id = 1`))[0].stats_error, null);
  const one = (await user(MGR, `SELECT public.vehicles_live_list() j`))[0].j.vehicles.find((x) => x.plate === "8200001");
  assert.equal(one.at_site.code, "VS1");
  assert.equal(one.stats.visit.code, "VS1");
  await ingest([{ ...v, motion_status: "driving" }]);
  const moving = (await user(MGR, `SELECT public.vehicles_live_list() j`))[0].j.vehicles.find((x) => x.plate === "8200001");
  assert.equal(moving.state, "driving");
  assert.equal(moving.at_site, null, "נוסע ליד אתר — לא באתר");
  assert.equal(moving.stats.visit, null, "והביקור נסגר");
});

test("מי הכי קרוב: אתר בתקלה ואתר עם קריאה פתוחה, שלושת הקרובים, בלי 'לא מדווח', ומי כבר באתר", { skip }, async () => {
  await sup(`DELETE FROM vehicle_visits`);
  await sup(`DELETE FROM vehicles_live`);
  await sup(`UPDATE sites SET status = 'error' WHERE code IN ('VS1', 'VS3')`);
  await sup(`INSERT INTO service_calls (raw, payload, source, received_at) VALUES ($1, $3::jsonb, 'wizenet', $2)`,
    [JSON.stringify({ ticket_number: "VS-T1", parking_code: "VS2", status: "777" }), new Date().toISOString(),
     JSON.stringify({ ticket_number: "VS-T1", parking_code: "VS2", status: "777" })]);
  // אתר בלי בקר עם status = 'error' — לא תקלה (אין בקר שיודע); וקריאה סגורה בהרצל — לא נספרת
  await sup(`INSERT INTO sites (code, site_name, status, registered_at, monitored) VALUES ('VS4', 'מכפיל', 'error', now()::text, false)`);
  await sup(`INSERT INTO wizenet_lookups (kind, id, name, closed) VALUES ('status', 'VSX', 'סגורה', true) ON CONFLICT DO NOTHING`);
  await sup(`INSERT INTO service_calls (raw, payload, source, received_at) VALUES ($1, $3::jsonb, 'wizenet', $2)`,
    [JSON.stringify({ ticket_number: "VS-T2", parking_code: "VS1", status: "VSX" }), new Date().toISOString(),
     JSON.stringify({ ticket_number: "VS-T2", parking_code: "VS1", status: "VSX" })]);
  const now = Date.now();
  const put = async (plate, p, motion, fixAgoMin = 0) => {
    const fix = new Date(now - fixAgoMin * 60_000).toISOString();
    await sup(`INSERT INTO vehicles_live (license_plate, motion, lat, lon, located_at, synced_at) VALUES ($1, $2, $3, $4, $5, now())`,
      [plate, motion, p.lat, p.lon, fix]);
  };
  await put("8300001", off(S1, 400), "parking");
  await put("8300002", off(S1, 900), "driving");
  await put("8300003", off(S1, 100), "parking", 3000);   // לא מדווח — יומיים
  await put("8300004", off(S1, 20), "parking");
  await put("8300005", off(S1, 2000), "parking");
  await put("8300006", off(S1, 3000), "parking");
  // 8300004 נסע היום (לפני שעה) — "באתר" רק לרכב שנסע היום
  await sup(`INSERT INTO vehicle_days (license_plate, day, first_seen, last_seen, max_speed, last_kind, segments)
             VALUES ('8300004', (now() AT TIME ZONE 'Asia/Jerusalem')::date, now() - interval '1 hour', now() - interval '1 hour', 40, 'drive', '[]')`);
  await sup(`SELECT app.vehicles_track(now())`);
  const alerts = async () => Object.fromEntries((await user(RO, `SELECT public.vehicles_live_list() j`))[0].j.alerts.map((a) => [a.code, a]));
  const j = (await user(RO, `SELECT public.vehicles_live_list() j`))[0].j;
  let by = Object.fromEntries(j.alerts.map((a) => [a.code, a]));
  assert.deepEqual(j.alerts.map((a) => a.code), ["VS1", "VS3", "VS2"], "תקלות קודם, ואז קריאות");
  assert.deepEqual([by.VS1.fault, by.VS1.calls, by.VS1.located, by.VS1.approx], [true, 0, true, false]);
  // ⚠️ 21/10/2026 (בדיקת הבאגים): "באתר" כאן — אותו כלל כמו האיקון בלוח (app.visit_current). ביקור שנפתח עכשיו — עוד לא
  // (רמזור ליד אתר), ולכן 8300004 עדיין "הכי קרוב".
  assert.deepEqual(by.VS1.on_site, [], "ביקור של פחות מ-2 דקות — לא 'באתר'");
  assert.deepEqual(by.VS1.nearest.map((x) => [x.plate, x.state]), [["8300004", "parking"], ["8300001", "parking"], ["8300002", "driving"]]);
  assert.ok(Math.abs(by.VS1.nearest[1].m - 400) <= 2);
  assert.deepEqual([by.VS2.fault, by.VS2.calls, by.VS2.approx, by.VS2.on_site], [false, 1, true, []]);
  assert.equal(by.VS4, undefined, "אתר בלי בקר אינו 'בתקלה'");
  assert.deepEqual([by.VS3.located, by.VS3.nearest], [false, []]);
  // באתר כבר 10 דקות — "באתר", ויוצא מ"הכי קרוב" לפני ה-LIMIT (נכנס הרביעי בתור)
  await sup(`UPDATE vehicle_visits SET started_at = now() - interval '10 minutes' WHERE license_plate = '8300004'`);
  by = await alerts();
  assert.deepEqual(by.VS1.on_site, ["8300004"]);
  assert.deepEqual(by.VS1.nearest.map((x) => x.plate), ["8300001", "8300002", "8300005"], "מי שבאתר אינו בין 'הכי קרובים'");
  // הביקור לא עודכן 20 דקות (הסנכרון נעצר) — כבר לא "באתר"
  await sup(`UPDATE vehicle_visits SET started_at = now() - interval '40 minutes', last_at = now() - interval '20 minutes' WHERE license_plate = '8300004'`);
  by = await alerts();
  assert.deepEqual(by.VS1.on_site, [], "ביקור שלא עודכן 15 דקות — לא 'באתר'");
  assert.equal(by.VS1.nearest[0].plate, "8300004");
  // 21/10/2026: רכב שאינו ברשימת רכבי השירות (fleet_shown) לא "באתר" ולא "הכי קרוב" — userRaw, בלי הסימון של user
  await sup(`UPDATE vehicle_visits SET started_at = now() - interval '10 minutes', last_at = now() WHERE license_plate = '8300004'`);
  await sup(`DELETE FROM fleet_shown WHERE license_plate IN ('8300004', '8300002')`);
  by = Object.fromEntries((await userRaw(RO, `SELECT public.vehicles_live_list() j`))[0].j.alerts.map((a) => [a.code, a]));
  assert.deepEqual(by.VS1.on_site, [], "רכב שאינו ברשימה — לא 'באתר'");
  assert.deepEqual(by.VS1.nearest.map((x) => x.plate), ["8300001", "8300005", "8300006"],
    "ולא 'הכי קרוב' — גם בלי ביקור (8300002); השלישי בתור נכנס במקומם");
  await sup(`UPDATE vehicle_visits SET started_at = now() - interval '40 minutes', last_at = now() - interval '20 minutes' WHERE license_plate = '8300004'`);
  await sup(`UPDATE sites SET status = 'ready' WHERE code IN ('VS1', 'VS3')`);
});

test("הרשאות: הטבלאות והעזרים סגורים; הסיכום מגיע רק דרך vehicles_live_list (כל מי שמחובר)", { skip }, async () => {
  for (const t of ["vehicle_days", "vehicle_visits"]) await fails(user(RO, `SELECT * FROM ${t}`), "42501");
  await fails(user(RO, `SELECT app.vehicles_track(now())`), "42501");
  await fails(user(RO, `SELECT app.vehicle_stats_json('x', now())`), "42501");
  await fails(as("anon", {}, `SELECT public.vehicles_live_list()`), "42501");
  const j = (await user(RO, `SELECT public.vehicles_live_list() j`))[0].j;
  assert.ok(Array.isArray(j.alerts));
});

test("הגריפה: ביקורים אחרי שנה (22/10/2026; עד אז 90 יום), ציר היום אחרי 90, הסיכום אחרי 13 חודשים; ביקור פתוח נשאר; המשימה מתוזמנת", { skip }, async () => {
  const P = "8400001";
  const vis = (days, open = false) => sup(`INSERT INTO vehicle_visits (license_plate, site_code, started_at, last_at, ended_at)
      VALUES ($1, 'VS1', now() - make_interval(days => $2), now() - make_interval(days => $2),
              CASE WHEN $3 THEN NULL ELSE now() - make_interval(days => $2) END) RETURNING id::int AS id`, [P + (open ? "o" : ""), days, open]);
  const dayAgo = (days) => sup(`INSERT INTO vehicle_days (license_plate, day, first_seen, last_seen, last_kind, segments)
      VALUES ($1, (now() AT TIME ZONE 'Asia/Jerusalem')::date - $2::int, now(), now(), 'park', '[["park",0,1,null]]')`, [P, days]);
  const v10 = (await vis(10))[0].id, v100 = (await vis(100))[0].id, v364 = (await vis(364))[0].id, v366 = (await vis(366))[0].id;
  const vOpen = (await vis(400, true))[0].id;
  await dayAgo(10); await dayAgo(100); await dayAgo(500);
  const r = (await sup(`SELECT app.prune_vehicle_stats() r`))[0].r;
  assert.ok(r.visits >= 1 && r.days >= 1 && r.segments >= 1, JSON.stringify(r));
  const left = (await sup(`SELECT id::int AS id FROM vehicle_visits WHERE id = ANY($1) ORDER BY id`, [[v10, v100, v364, v366, vOpen]])).map((x) => x.id);
  assert.deepEqual(left, [v10, v100, v364, vOpen].sort((a, b) => a - b), "שנה: 364 יום נשאר, 366 נמחק; ביקור פתוח נשאר");
  const days = await sup(`SELECT (now() AT TIME ZONE 'Asia/Jerusalem')::date - day AS ago, segments FROM vehicle_days
                           WHERE license_plate = $1 ORDER BY day DESC`, [P]);
  assert.deepEqual(days.map((x) => [x.ago, x.segments.length]), [[10, 1], [100, 0]]);
  const job = (await sup(`SELECT command FROM cron.job WHERE jobname = 'parkomat-prune-vehicle-stats'`))[0];
  assert.equal(job.command, "SELECT app.prune_vehicle_stats()");
});

test("טכנאי באתר (לוח האתרים): ביקור פתוח של 2 דקות ומעלה ועדכני; שם הטכנאי מהלוח; רק צוות", { skip }, async () => {
  const sid = async (code) => (await sup(`SELECT id FROM sites WHERE code = $1`, [code]))[0].id;
  const s1 = await sid("VS1"), s2 = await sid("VS2");
  const plates = ["TOS1", "TOS2", "TOS3", "TOS4", "TOS5", "TOS6"];
  for (const p of plates) {
    await sup(`INSERT INTO vehicles_live (license_plate, nickname, motion, synced_at) VALUES ($1, $2, 'parking', now())
               ON CONFLICT (license_plate) DO NOTHING`, [p, `כינוי ${p}`]);
  }
  const visit = (plate, siteId, code, startMin, lastMin, ended = false) => sup(
    `INSERT INTO vehicle_visits (license_plate, site_id, site_code, site_name, started_at, last_at, ended_at)
     VALUES ($1, $2, $3, 'x', now() - make_interval(mins => $4), now() - make_interval(mins => $5),
             CASE WHEN $6 THEN now() - interval '30 seconds' END)`, [plate, siteId, code, startMin, lastMin, ended]);
  await visit("TOS1", s1, "VS1", 40, 1);         // באתר 40 דקות — כן, עם שם מהלוח
  await visit("TOS2", s1, "VS1", 10, 0);         // באתר 10 דקות — כן; הטכנאי שלו מושבת, ולכן בלי שם
  await visit("TOS3", s2, "VS2", 1, 0);          // דקה אחת — רמזור ליד אתר, לא
  await visit("TOS4", s2, "VS2", 60, 20);        // לא עודכן 20 דקות — הסנכרון נעצר, לא
  await visit("TOS5", s2, "VS2", 30, 5, true);   // הביקור נגמר — לא
  await visit("TOS6", null, "GONE", 30, 0);      // האתר נמחק — לא
  await sup(`INSERT INTO technicians (display_name, plate, is_active, created_by) VALUES
             ('אבי לוי', 'TOS1', true, 'בדיקה'), ('דני ישן', 'TOS2', false, 'בדיקה')`);
  try {
    const j = (await user(RO, `SELECT public.tech_on_site() j`))[0].j;
    assert.deepEqual(j.map((r) => r.plate), ["TOS1", "TOS2"], "רק שני הביקורים שבאמת באתר, לפי הסדר");
    assert.equal(j[0].site_id, s1);
    assert.equal(j[0].code, "VS1");
    assert.equal(j[0].tech, "אבי לוי");
    assert.equal(j[0].nickname, "כינוי TOS1");
    assert.match(j[0].since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(Date.now() - Date.parse(j[0].since) >= 39 * 60_000, "since = מתי הגיע");
    assert.equal(j[1].tech, null, "טכנאי מושבת לא נותן שם");
    assert.equal(j[1].no_signal, false);
    // 21/10/2026: רכב שאינו ברשימת רכבי השירות (רכב משרד שחונה ליד אתר) — אין "טכנאי באתר"
    await sup(`DELETE FROM fleet_shown WHERE license_plate = 'TOS1'`);
    const j2 = (await userRaw(RO, `SELECT public.tech_on_site() j`))[0].j;
    assert.deepEqual(j2.map((r) => r.plate), ["TOS2"], "רכב שאינו ברשימה — לא בלוח");
    await fails(as("anon", {}, `SELECT public.tech_on_site()`), "42501");
    await fails(user("f3000000-0000-0000-0000-0000000000ff", `SELECT public.tech_on_site()`), "42501");
  } finally {
    await sup(`DELETE FROM technicians WHERE plate LIKE 'TOS%'`);
    await sup(`DELETE FROM vehicle_visits WHERE license_plate LIKE 'TOS%'`);
    await sup(`DELETE FROM vehicles_live WHERE license_plate LIKE 'TOS%'`);
  }
});

test("בדיקת הבאגים (21/10): השתתק באמצע נסיעה — לא 'באתר'; קפיצה על גבול הטווח — ביקור אחד; ביקור חדש לא חופף לקודם", { skip }, async () => {
  await sup(`DELETE FROM vehicle_visits`);
  await sup(`DELETE FROM vehicles_live`);
  const ilText = (m) => new Date(BASE + m * 60_000 + 2 * 3_600_000).toISOString().slice(0, 19);   // שעון ישראל בחורף, בלי אזור

  // A — יחידה שהפסיקה לשדר ב-60 קמ"ש, 80 מ' מאתר: לא ביקור, ובמסך לא "באתר" (עד 21/10: באתר שעות, עם האיקון בלוח)
  const A = "8400001";
  await car(A, { motion: "driving", at: off(S1, 80), m: 600, speed: 60 });
  await track(600);
  for (const m of [607, 608]) { await car(A, { motion: "driving", at: off(S1, 80), m, fixM: 600, speed: 60 }); await track(m); }
  assert.equal((await visits(A)).length, 0, "השתתק במהירות — לא ביקור");
  assert.equal((await dayRow(A)).segments.at(-1)[0], "silent");
  const va = (await user(MGR, `SELECT public.vehicles_live_list() j`))[0].j.vehicles.find((x) => x.plate === A);
  assert.equal(va.state, "silent");
  assert.equal(va.at_site, null, "השתתק במהירות — המסך לא אומר 'באתר'");
  // מכאן כל רכב שמגיע לאתר נסע קודם (22/10/2026: "באתר" רק לרכב שנסע היום)
  await drove(["8400002", "8400003", "8400005", "8400006", "8400007"], 590);
  // ואותו דבר ב-15 קמ"ש — כן (חניון תת-קרקעי: נכנס לאט ואיבד קליטה)
  const A2 = "8400004";
  await car(A2, { motion: "driving", at: off(S1, 80), m: 600, speed: 15 });
  await track(600);
  for (const m of [607, 608]) { await car(A2, { motion: "driving", at: off(S1, 80), m, fixM: 600, speed: 15 }); await track(m); }
  assert.equal((await visits(A2)).length, 1, "השתתק לאט ליד אתר — ביקור (אין קליטה)");

  // B — חונה 140 מ' מאתר שהרדיוס שלו 150; דקה אחת המיקום קופץ ל-160 מ', וחוזר: ביקור אחד, פתוח (עד 21/10: שניים, חופפים)
  const B = "8400002";
  for (let m = 620; m <= 626; m++) { await car(B, { motion: "parking", at: off(S1, 140), m }); await track(m); }
  await car(B, { motion: "parking", at: off(S1, 160), m: 627 });
  await track(627);
  for (let m = 628; m <= 630; m++) { await car(B, { motion: "parking", at: off(S1, 140), m }); await track(m); }
  const vb = await visits(B);
  assert.equal(vb.length, 1, "ביקור אחד — לא שניים");
  assert.equal(vb[0].ended_at, null, "והוא עדיין פתוח");
  assert.equal(iso(vb[0].started_at), iso(T(620)));
  assert.equal((await stats(B, 630)).visits.length, 1, "בכרטיס: ביקור אחד");

  // C — באתר S1 בדקות 640–650, ואז חונה ב-S2 עם כיבוי הצתה ישן (דקה 600, לפני הביקור הקודם): הביקור החדש מתחיל
  // בסוף הקודם, לא לפניו (עד 21/10: התחיל בדקה 600 — שני ביקורים חופפים, ונספרו שניהם)
  const C = "8400003";
  for (let m = 640; m <= 650; m++) { await car(C, { motion: "parking", at: off(S1, 30), m }); await track(m); }
  const offEv = { event_id: "10181704", event_name: "כיבוי סוויץ'", time_start: ilText(600), point: off(S2, 40) };
  await car(C, { motion: "parking", at: off(S2, 40), m: 651, events: [offEv] });
  await track(651);
  const vc = await visits(C);
  assert.deepEqual(vc.map((x) => x.site_code), ["VS1", "VS2"]);
  assert.ok(Date.parse(vc[1].started_at) >= Date.parse(vc[0].ended_at), `לא חופף: ${iso(vc[0].ended_at)} → ${iso(vc[1].started_at)}`);
  // ובלי ביקור קודם — כיבוי ההצתה כן קובע את שעת ההגעה (GREATEST/LEAST מתעלמים מ-NULL)
  const D = "8400005";
  await car(D, { motion: "parking", at: off(S2, 40), m: 651, events: [{ ...offEv, time_start: ilText(645) }] });
  await track(651);
  assert.equal(iso((await visits(D))[0].started_at), iso(T(645)), "בלי ביקור קודם — ההגעה היא כיבוי ההצתה");

  // E — חזרה לאותו אתר אחרי 20 דקות: ביקור חדש, לא פתיחה מחדש (הפתיחה מחדש — רק בתוך 15 דקות; נוסף אחרי שמוטציה שרדה)
  const E = "8400006";
  for (let m = 700; m <= 705; m++) { await car(E, { motion: "parking", at: off(S1, 30), m }); await track(m); }
  for (let m = 706; m <= 725; m++) { await car(E, { motion: "driving", at: off(S1, 3000), m, speed: 40 }); await track(m); }
  for (let m = 726; m <= 730; m++) { await car(E, { motion: "parking", at: off(S1, 30), m }); await track(m); }
  const ve = await visits(E);
  assert.equal(ve.length, 2, "חזרה אחרי 20 דקות — שני ביקורים");
  assert.equal(iso(ve[1].started_at), iso(T(726)));

  // F — S1, אחר כך S2, וחזרה ל-S1 בתוך 15 דקות: שלושה ביקורים, בסדר. פתיחה מחדש של הראשון הייתה חופפת לביקור ב-S2
  const F = "8400007";
  for (let m = 760; m <= 765; m++) { await car(F, { motion: "parking", at: off(S1, 30), m }); await track(m); }
  await car(F, { motion: "driving", at: off(S1, 3000), m: 766, speed: 40 });
  await track(766);
  for (let m = 767; m <= 771; m++) { await car(F, { motion: "parking", at: off(S2, 30), m }); await track(m); }
  await car(F, { motion: "driving", at: off(S1, 3000), m: 772, speed: 40 });
  await track(772);
  for (let m = 773; m <= 776; m++) { await car(F, { motion: "parking", at: off(S1, 30), m }); await track(m); }
  const vf = await visits(F);
  assert.deepEqual(vf.map((x) => x.site_code), ["VS1", "VS2", "VS1"], "ביקור באמצע — לא פותחים מחדש את הראשון");
  for (let i = 1; i < vf.length; i++) {
    assert.ok(Date.parse(vf[i].started_at) >= Date.parse(vf[i - 1].ended_at), `לא חופף: ${iso(vf[i - 1].ended_at)} → ${iso(vf[i].started_at)}`);
  }
});

test("בדיקת הבאגים (21/10): שם הטכנאי מלוח הרכז מגיע עם הרכב — לחיפוש, ל'צריכים טכנאי' ולמפה", { skip }, async () => {
  await sup(`INSERT INTO vehicles_live (license_plate, nickname, motion, synced_at) VALUES ('8500001', 'כינוי 8500001', 'parking', now()),
                                                                                       ('8500002', 'כינוי 8500002', 'parking', now())`);
  await sup(`INSERT INTO technicians (display_name, plate, is_active, created_by) VALUES ('דני כהן', '8500001', true, 'בדיקה'),
                                                                                      ('ישן', '8500002', false, 'בדיקה')`);
  try {
    const list = (await user(RO, `SELECT public.vehicles_live_list() j`))[0].j.vehicles;
    assert.equal(list.find((x) => x.plate === "8500001").tech, "דני כהן");
    assert.equal(list.find((x) => x.plate === "8500001").name, "כינוי 8500001", "הכינוי באיתוראן נשאר בנפרד");
    assert.equal(list.find((x) => x.plate === "8500002").tech, null, "טכנאי מושבת — בלי שם");
  } finally {
    await sup(`DELETE FROM technicians WHERE plate LIKE '85000%'`);
    await sup(`DELETE FROM vehicles_live WHERE license_plate LIKE '85000%'`);
  }
});

// 22/10/2026 — שני טכנאים צמודים לשני אתרים צמודים: באותו אתר (app.vehicle_site). כל זוג בזוג אתרים משלו, 50 מ' ביניהם,
// רחוק מהשאר, כדי שזוג אחד לא יהיה "שכן" של אחר.
test("שני טכנאים באותו אתר: צמודים — אותו אתר (מרכז / מי שהגיע ראשון / משימה פתוחה); רחוקים, נוסע, רכב משרד, בלי אתר בטווח — כל אחד לעצמו", { skip }, async () => {
  const now = new Date().toISOString();
  const site = async (code, p) => (await sup(`INSERT INTO sites (code, site_name, status, registered_at, lat, lon, geo_source, geo_precision, geo_set_at, geo_set_by)
      VALUES ($1, $2, 'ready', $3, $4, $5, 'geocoded', 'house', $3, 'בדיקה') RETURNING id`, [code, `אתר צמוד ${code}`, now, p.lat, p.lon]))[0].id;
  const pair = async (n, base) => {
    const a = base, b = off(base, 0, 50);           // שני אתרים, 50 מ' ביניהם
    await site(`TG${n}A`, a); await site(`TG${n}B`, b);
    return { a, b };
  };
  const show = (...plates) => sup(`INSERT INTO fleet_shown (license_plate) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`, [plates]);
  const openVisit = async (plate) => (await sup(`SELECT site_code FROM vehicle_visits WHERE license_plate = $1 AND ended_at IS NULL`, [plate]))[0]?.site_code ?? null;
  const own = async (p) => (await sup(`SELECT app.site_at($1, $2) ->> 'code' c`, [p.lat, p.lon]))[0].c;

  // 1 — באים יחד, בלי ביקור פתוח: האתר הקרוב למרכז ביניהם (15 מ' מ-A, 35 מ' מ-B) לשניהם
  const P1 = await pair(1, { lat: 32.3, lon: 34.95 });
  const a1 = off(P1.a, 0, -10), b1 = off(P1.a, 0, 40);          // 50 מ' ביניהם; a1 ליד A, b1 ליד B
  assert.deepEqual([await own(a1), await own(b1)], ["TG1A", "TG1B"], "בלי הכלל — כל אחד היה מקבל אתר אחר");
  await show("8700001", "8700002");
  // ⚠️ הרכב שליד B נכנס ראשון: הסנכרון עובר עליו קודם, וכך נבדק "הקרוב למרכז" ולא רק "מי שהגיע ראשון"
  await drove(["8700001", "8700002"], 899);
  await car("8700002", { motion: "parking", at: b1, m: 900 });
  await car("8700001", { motion: "parking", at: a1, m: 900 });
  await track(900);
  assert.deepEqual([await openVisit("8700001"), await openVisit("8700002")], ["TG1A", "TG1A"], "שניהם באותו אתר");
  for (const m of [901, 902, 903]) { await car("8700001", { motion: "parking", at: a1, m }); await car("8700002", { motion: "parking", at: b1, m }); await track(m); }
  assert.deepEqual([(await visits("8700001")).length, (await visits("8700002")).length], [1, 1], "יציב — ביקור אחד לכל אחד");
  // וגם במסך: at_site של שניהם
  const list = (await user(MGR, `SELECT public.vehicles_live_list() j`))[0].j.vehicles;
  assert.deepEqual(["8700001", "8700002"].map((p) => list.find((v) => v.plate === p).at_site?.code), ["TG1A", "TG1A"]);
  assert.ok(Math.abs(list.find((v) => v.plate === "8700002").at_site.m - 40) <= 2, "המרחק — מהרכב שלו לאתר שנבחר");

  // 2 — מי שהגיע ראשון קבע: C לבד ליד B; D מגיע אחריו ליד A — מצטרף ל-B
  const P2 = await pair(2, { lat: 32.33, lon: 34.95 });
  const c2 = off(P2.a, 0, 45), d2 = off(P2.a, 0, -5);
  await show("8700003", "8700004");
  await drove(["8700003"], 909);
  await car("8700003", { motion: "parking", at: c2, m: 910 });
  await track(910);
  assert.equal(await openVisit("8700003"), "TG2B", "לבד — האתר הקרוב אליו");
  await drove(["8700004"], 914);
  await car("8700003", { motion: "parking", at: c2, m: 915 });
  await car("8700004", { motion: "parking", at: d2, m: 915 });
  await track(915);
  assert.deepEqual([await openVisit("8700003"), await openVisit("8700004")], ["TG2B", "TG2B"], "השני מצטרף לאתר של הראשון");

  // 3 — משימה פתוחה קובעת לשניהם: E ליד A אבל נשלח ל-B; F ליד A בלי משימה — שניהם ב-B, בכל סדר שהסנכרון עובר
  const P3 = await pair(3, { lat: 32.36, lon: 34.95 });
  const e3 = off(P3.a, 0, -10), f3 = off(P3.a, 0, 5);
  await show("8700005", "8700006");
  const techE = (await sup(`INSERT INTO technicians (display_name, plate, is_active, created_by) VALUES ('טכנאי צמוד', '8700005', true, 'בדיקה') RETURNING id`))[0].id;
  const siteB = (await sup(`SELECT id, code, site_name FROM sites WHERE code = 'TG3B'`))[0];
  await sup(`INSERT INTO tech_dispatches (client_id, technician_id, site_id, site_code, site_name, created_by)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'רכז')`, [techE, siteB.id, siteB.code, siteB.site_name]);
  try {
    await drove(["8700005", "8700006"], 919);
    await car("8700006", { motion: "parking", at: f3, m: 920 });
    await car("8700005", { motion: "parking", at: e3, m: 920 });
    await track(920);
    assert.deepEqual([await openVisit("8700005"), await openVisit("8700006")], ["TG3B", "TG3B"], "המשימה של E קובעת גם ל-F");
    // 3ב — לבד, בלי שכן: ליד A, אבל נשלח ל-B — ב-B
    await car("8700006", { motion: "driving", at: HOME, m: 921, speed: 40 });
    await car("8700005", { motion: "parking", at: e3, m: 921 });
    await track(921);
    await sup(`UPDATE vehicle_visits SET ended_at = $1 WHERE license_plate = '8700005' AND ended_at IS NULL`, [T(921)]);
    await car("8700005", { motion: "parking", at: e3, m: 922 });
    await track(922);
    assert.equal(await openVisit("8700005"), "TG3B", "לבד — המשימה שלו קובעת");
  } finally {
    await sup(`DELETE FROM tech_dispatches WHERE technician_id = $1`, [techE]);
    await sup(`DELETE FROM technicians WHERE id = $1`, [techE]);
  }

  // 4 — רחוקים יותר מ-100 מ' — כל אחד לאתר הקרוב אליו
  const P4 = await pair(4, { lat: 32.39, lon: 34.95 });
  const g4 = off(P4.a, 0, -60), h4 = off(P4.a, 0, 60);          // 120 מ' ביניהם
  await show("8700007", "8700008");
  await drove(["8700007", "8700008"], 924);
  await car("8700007", { motion: "parking", at: g4, m: 925 });
  await car("8700008", { motion: "parking", at: h4, m: 925 });
  await track(925);
  assert.deepEqual([await openVisit("8700007"), await openVisit("8700008")], ["TG4A", "TG4B"], "120 מ' — לא 'צמודים'");

  // 5 — שכן שנוסע, ושכן שאינו ברשימת רכבי השירות — לא מושכים
  const P5 = await pair(5, { lat: 32.42, lon: 34.95 });
  // J ליד A (20 מ', B ב-30); I ו-K ליד B, 50–55 מ' מ-J. אילו נספרו — המרכז היה ליד B, ו-J היה עובר ל-B.
  const j5 = off(P5.a, 0, 20), i5 = off(P5.a, 0, 70), k5 = off(P5.a, 0, 75);
  await show("8700009", "8700010");
  await drove(["8700009"], 929);
  await car("8700009", { motion: "parking", at: i5, m: 930 });
  await track(930);                                              // I לבד ב-B
  await car("8700009", { motion: "driving", at: i5, m: 935, speed: 30 });     // I נוסע עכשיו
  await drove(["8700010", "8700011"], 934);                     // ⚠️ K נסע — רק הרשימה מוציאה אותו
  await car("8700010", { motion: "parking", at: j5, m: 935 });
  await car("8700011", { motion: "parking", at: k5, m: 935 });              // רכב משרד ליד J
  await sup(`DELETE FROM fleet_shown WHERE license_plate = '8700011'`);
  await track(935);
  assert.equal(await openVisit("8700010"), "TG5A", "שכן שנוסע — לא נחשב; רכב משרד — לא נחשב");

  // 7 — האתר שנבחר חייב להיות בטווח שלו: שני אתרים 260 מ' זה מזה, שני רכבים 90 מ' זה מזה, כל אחד בטווח של אתר אחר.
  // המרכז ביניהם קרוב יותר ל-C — אבל C מחוץ לטווח של Q, ולכן Q נשאר ב-A.
  const A7 = { lat: 32.48, lon: 34.95 };
  await site("TG7A", A7); await site("TG7C", off(A7, 0, -260));
  const q7 = off(A7, 0, -100), r7 = off(A7, 0, -190);
  await show("8700014", "8700015");
  await drove(["8700014", "8700015"], 944);
  await car("8700014", { motion: "parking", at: q7, m: 945 });
  await car("8700015", { motion: "parking", at: r7, m: 945 });
  await track(945);
  assert.deepEqual([await openVisit("8700014"), await openVisit("8700015")], ["TG7A", "TG7C"], "לא לאתר שמחוץ לטווח");

  // 6 — "האם באתר" לא משתנה: רכב בלי אתר בטווח שלו נשאר בלי אתר, גם כשהשכן באתר
  const P6 = await pair(6, { lat: 32.45, lon: 34.95 });
  const l6 = off(P6.a, 0, -100);                                 // 100 מ' מ-A — בטווח (150)
  await show("8700012", "8700013");
  await drove(["8700012", "8700013"], 939);
  await car("8700012", { motion: "parking", at: l6, m: 940 });
  await car("8700013", { motion: "parking", at: off(P6.a, 0, -170), m: 940 });   // 170 מ' מ-A (מחוץ ל-150), 70 מ' מ-L — שכן
  await track(940);
  assert.equal(await openVisit("8700013"), null, "בלי אתר בטווח — לא 'באתר', גם עם שכן באתר");

  // 8 — שכן שלא נסע היום אינו שכן (הוא גם לא "באתר"). Y ליד A (5 מ'); X חונה מהבוקר בלי לזוז, 95 מ' ממנו ליד B.
  // אילו X נספר — המרכז (42.5 מ' מ-A, 7.5 מ' מ-B) היה מעביר את Y ל-B.
  const P8 = await pair(8, { lat: 32.51, lon: 34.95 });
  const y8 = off(P8.a, 0, -5), x8 = off(P8.a, 0, 90);
  await show("8700016", "8700017");
  await drove(["8700016"], 949);
  await car("8700016", { motion: "parking", at: y8, m: 950 });
  await car("8700017", { motion: "parking", at: x8, m: 950 });
  await track(950);
  assert.deepEqual([await openVisit("8700016"), await openVisit("8700017")], ["TG8A", null], "שכן שלא נסע — לא מושך, וגם לא באתר");
});

// 22/10/2026 — הבעלת, על רכב שחנה ליד אתר מאז תחילת המעקב ונרשם "באתר" 22 שעות עם 0 ק"מ: "אם הוא לא נוסע — אל תכתוב שהוא
// באתר, כנראה הוא גר שם". באתר רק לרכב שנסע היום (app.vehicle_moved_today). הימים: 11/11 (דקות 960–2399) ו-12/11.
test("באתר רק לרכב שנסע היום: חונה מהבוקר — לא; מנוע דולק בלי לזוז — לא; מד מרחק שהתקדם — כן; בחצות — נסגר עד שזז", { skip }, async () => {
  const D1 = "2026-11-11";
  const onScreen = async (plate) => (await user(MGR, `SELECT public.vehicles_live_list() j`))[0].j.vehicles.find((x) => x.plate === plate);

  // A — חונה ליד VS1 מתחילת היום ולא זז: לא ביקור, ובמסך לא "באתר". נוסע ומגיע — כן.
  const A = "8800001";
  for (let m = 1000; m <= 1005; m++) { await car(A, { motion: "parking", at: off(S1, 20), m, odo: 500 }); await track(m); }
  assert.equal((await visits(A)).length, 0, "לא נסע היום — לא ביקור");
  assert.equal((await dayRow(A, D1)).last_kind, "park", "בציר — חונה, לא באתר");
  assert.equal((await onScreen(A)).at_site, null, "ובמסך לא 'באתר'");
  await car(A, { motion: "driving", at: HOME, m: 1006, speed: 30, odo: 500 });
  await track(1006);
  for (let m = 1007; m <= 1010; m++) { await car(A, { motion: "parking", at: off(S1, 20), m, odo: 500 }); await track(m); }
  const va = await visits(A);
  assert.deepEqual([va.length, va[0].site_code, iso(va[0].started_at), va[0].ended_at], [1, "VS1", iso(T(1007)), null], "נסע והגיע — ביקור");
  assert.equal((await onScreen(A)).at_site.code, "VS1");

  // B — מנוע דולק ליד האתר בלי לזוז (חימום מנוע בבית) ואז כיבוי: אינו "נסע היום", ואינו באתר
  const B = "8800002";
  for (let m = 1020; m <= 1025; m++) { await car(B, { motion: "idle", at: off(S1, 40), m, odo: 700 }); await track(m); }
  await car(B, { motion: "parking", at: off(S1, 40), m: 1026, odo: 700 });
  await track(1026);
  assert.equal((await visits(B)).length, 0, "מנוע דולק בלי לזוז — לא נסיעה, ולכן לא ביקור");
  assert.equal((await dayRow(B, D1)).max_speed, null);

  // C — הנסיעה נפלה בין שתי דגימות (בלי דגימה של "נוסע"), אבל מד המרחק התקדם: נסע
  const C = "8800003";
  await car(C, { motion: "parking", at: HOME, m: 1030, odo: 100 });
  await track(1030);
  await car(C, { motion: "parking", at: off(S1, 30), m: 1033, odo: 102 });
  await track(1033);
  assert.deepEqual((await visits(C)).map((x) => x.site_code), ["VS1"], "מד המרחק התקדם — נסע");

  // D — קריאת לילה: נסע ב-23:45, באתר מ-23:50. בחצות היום מתחלף והוא עוד לא זז — הביקור נסגר בדגימה האחרונה של אתמול,
  // ולא נפתח מחדש עד שהוא נוסע.
  const D = "8800004";
  await car(D, { motion: "driving", at: HOME, m: 2385, speed: 40, odo: 900 });
  await track(2385);
  for (let m = 2390; m <= 2399; m++) { await car(D, { motion: "parking", at: off(S1, 40), m, odo: 905 }); await track(m); }
  assert.equal((await visits(D)).filter((x) => !x.ended_at).length, 1, "לפני חצות — באתר");
  for (const m of [2401, 2405]) { await car(D, { motion: "parking", at: off(S1, 40), m, odo: 905 }); await track(m); }
  let vd = await visits(D);
  assert.deepEqual(vd.map((x) => [x.site_code, iso(x.ended_at)]), [["VS1", iso(T(2399))]], "אחרי חצות, בלי לזוז — נסגר");
  assert.equal((await onScreen(D)).at_site, null);
  // (אחרי יותר מ-15 דקות מסוף הביקור — אחרת החזרה פותחת מחדש את אותו ביקור, כרגיל)
  await car(D, { motion: "driving", at: HOME, m: 2420, speed: 40, odo: 905 });
  await track(2420);
  for (let m = 2422; m <= 2425; m++) { await car(D, { motion: "parking", at: off(S1, 40), m, odo: 910 }); await track(m); }
  vd = await visits(D);
  assert.deepEqual(vd.map((x) => [x.site_code, iso(x.started_at), x.ended_at && iso(x.ended_at)]),
    [["VS1", iso(T(2390)), iso(T(2399))], ["VS1", iso(T(2422)), null]], "נסע וחזר — ביקור חדש ביום החדש");
});

// 22/10/2026 — דוח הטכנאים: "היסטוריה של אתרים שבהם כל אחד ביקר, כמה שעות בממוצע נמצא טכנאי באתר, מי נוסע הכי מהר — כמה
// שיותר סטטיסטיקות". נתונים קבועים בדצמבר (חורף, +2), רחוק משאר הבדיקות. A עם שם מהלוח, B בלי, C רכב משרד (לא ברשימה).
test("דוח הטכנאים: לכל טכנאי, היסטוריה ולפי אתר — ימים, ק\"מ, מהירות, ביקורים וזמן באתר; גבולות יום בישראל; רק רכבי השירות", { skip }, async () => {
  const A = "8900001", B = "8900002", C = "8900003";
  const il = (t) => `('${t}'::timestamp AT TIME ZONE 'Asia/Jerusalem')`;
  for (const p of [A, B, C]) {
    await sup(`INSERT INTO vehicles_live (license_plate, nickname, motion, synced_at) VALUES ($1, $2, 'parking', now())
               ON CONFLICT (license_plate) DO NOTHING`, [p, `כינוי ${p}`]);
  }
  await sup(`DELETE FROM fleet_shown WHERE license_plate IN ($1, $2, $3)`, [A, B, C]);
  await sup(`INSERT INTO fleet_shown (license_plate) VALUES ($1), ($2)`, [A, B]);
  await sup(`INSERT INTO technicians (display_name, plate, created_by) VALUES ('טכנאי הדוח', $1, 'בדיקה')`, [A]);
  const day = (plate, d, o) => sup(`INSERT INTO vehicle_days (license_plate, day, first_seen, last_seen, first_move, last_move, odo_start,
        odo_last, drive_s, site_s, stops, max_speed, last_kind, segments)
      VALUES ($1, $2::date, now(), now(), ${o.first ? il(`${d} ${o.first}`) : "NULL"}, ${o.last ? il(`${d} ${o.last}`) : "NULL"},
              $3, $4, $5, $6, $7, $8, 'park', '[]')`, [plate, d, o.odo0 ?? null, o.odo1 ?? null, o.drive ?? 0, o.site ?? 0, o.stops ?? 0, o.max ?? null]);
  await day(A, "2026-12-01", { odo0: 1000, odo1: 1050, drive: 3600, site: 7200, stops: 3, max: 90, first: "07:30", last: "16:30" });
  await day(A, "2026-12-02", { odo0: 1050, odo1: 1080, drive: 1800, site: 3600, stops: 2, max: 110, first: "08:30", last: "15:30" });
  // מנוע דולק בלי לזוז (first_move נרשם, אבל לא נסע) — נספר כיום, לא כיום עבודה, ולא נכנס ליציאה הממוצעת
  await day(A, "2026-12-03", { odo0: 1080, odo1: 1080, first: "05:00", last: "05:10" });
  await day(A, "2026-11-30", { odo0: 900, odo1: 1000, drive: 9000, max: 140, first: "06:00", last: "20:00" });   // מחוץ לתקופה
  await day(B, "2026-12-01", { odo0: 10, odo1: 12, drive: 300, max: 40, first: "12:00", last: "12:05" });   // 2 ק"מ בחמש דקות
  await day(C, "2026-12-01", { odo0: 1, odo1: 500, drive: 30000, max: 180, first: "05:00", last: "23:00" });
  const visit = (plate, code, from, to, open = false) => sup(`INSERT INTO vehicle_visits (license_plate, site_code, site_name, started_at, last_at, ended_at)
      VALUES ($1, $2, 'שם ישן', ${il(from)}, ${il(to)}, ${open ? "NULL" : il(to)})`, [plate, code]);
  await visit(A, "VS1", "2026-12-01 08:00", "2026-12-01 09:00");
  await visit(A, "VS2", "2026-12-01 10:00", "2026-12-01 10:30");
  await visit(A, "VS1", "2026-12-02 09:00", "2026-12-02 11:00");
  await visit(A, "VS2", "2026-12-02 12:00", "2026-12-02 12:01");                 // דקה — לא ביקור
  await visit(A, "VS2", "2026-12-03 23:50", "2026-12-04 00:20");                 // התחיל ב-3/12 בישראל — בתקופה
  await visit(A, "VS1", "2026-11-30 23:30", "2026-12-01 00:30");                 // התחיל לפני התקופה
  await visit(A, "VS1", "2026-12-04 00:10", "2026-12-04 01:00");                 // אחרי התקופה
  await visit(B, "VS1", "2026-12-01 13:00", "2026-12-01 14:00", true);           // פתוח — עד הדגימה האחרונה
  await visit(C, "VS1", "2026-12-01 13:00", "2026-12-01 18:00");                 // רכב משרד

  const stats = async (uid, from, to) => (await userRaw(uid, `SELECT public.tech_stats($1::date, $2::date) j`, [from, to]))[0].j;
  const s = await stats(RO, "2026-12-01", "2026-12-03");
  const a = s.techs.find((t) => t.plate === A), b = s.techs.find((t) => t.plate === B);
  assert.equal(s.techs.find((t) => t.plate === C), undefined, "רכב משרד — לא בדוח");
  assert.deepEqual([s.from, s.to], ["2026-12-01", "2026-12-03"]);
  assert.deepEqual([a.tech, a.nickname, b.tech, b.nickname], ["טכנאי הדוח", `כינוי ${A}`, null, `כינוי ${B}`]);
  assert.deepEqual([a.tracked_days, a.work_days, a.km, a.drive_s, a.site_s, a.stops, a.max_speed, a.avg_speed],
    [3, 2, 80, 5400, 10800, 5, 110, 53], "ימים, ק\"מ, נסיעה, באתרים, עצירות, שיא, ממוצע (80 ק\"מ ב-1.5 שעות)");
  assert.deepEqual([a.first_min, a.last_min, a.workday_min], [480, 960, 480], "יציאה 08:00, סיום 16:00, יום של 8 שעות — רק בימים שנסע");
  assert.deepEqual([a.visits, a.sites, a.visit_total_s, a.visit_avg_s, a.visit_max_s], [4, 2, 14400, 3600, 7200]);
  assert.deepEqual(a.top_site, { code: "VS1", name: "שם ישן", n: 2 }, "שוויון בביקורים — לפי הזמן הכולל");
  assert.deepEqual([b.km, b.avg_speed, b.work_days, b.visits, b.visit_avg_s], [2, null, 1, 1, 3600], "פחות מעשר דקות נסיעה — בלי ממוצע (גם עם ק\"מ); ביקור פתוח נספר");
  assert.deepEqual(s.team, { km: 82, drive_s: 5700, site_s: 10800, work_days: 3, visits: 5, sites: 2, visit_avg_s: 3600, visit_total_s: 18000 });
  assert.ok(s.first_day <= "2026-11-30");
  // תקופה של יום אחד
  const d1 = (await stats(MGR, "2026-12-02", "2026-12-02")).techs.find((t) => t.plate === A);
  assert.deepEqual([d1.km, d1.visits, d1.max_speed, d1.first_min], [30, 1, 110, 510]);

  // היסטוריה של טכנאי
  const hist = async (uid, plate, from, to) => (await userRaw(uid, `SELECT public.tech_history($1, $2::date, $3::date) j`, [plate, from, to]))[0].j;
  const ha = await hist(RO, A, "2026-12-01", "2026-12-03");
  assert.deepEqual([ha.plate, ha.tech, ha.visits_total], [A, "טכנאי הדוח", 4]);
  assert.deepEqual(ha.days.map((x) => [x.day, x.km, x.visits, x.moved]),
    [["2026-12-03", 0, 1, false], ["2026-12-02", 30, 1, true], ["2026-12-01", 50, 2, true]], "החדש ראשון; הביקור של דקה לא נספר");
  assert.equal(ha.days[2].first_move, "2026-12-01T05:30:00Z");
  assert.deepEqual(ha.visits.map((x) => [x.code, x.dur_s, x.open]), [["VS2", 1800, false], ["VS1", 7200, false], ["VS2", 1800, false], ["VS1", 3600, false]]);
  assert.equal(ha.visits[0].name, "אתר בדיקה VS2", "השם הנוכחי של האתר, לא תמונת המצב");
  assert.deepEqual(ha.sites.map((x) => [x.code, x.n, x.total_s, x.avg_s, x.max_s]), [["VS1", 2, 10800, 5400, 7200], ["VS2", 2, 3600, 1800, 1800]]);
  await fails(hist(RO, C, "2026-12-01", "2026-12-03"), "PT404");
  await fails(hist(RO, "אין כזה", "2026-12-01", "2026-12-03"), "PT404");

  // לפי אתר
  const sites = (await userRaw(RO, `SELECT public.site_visit_stats('2026-12-01'::date, '2026-12-03'::date) j`))[0].j;
  assert.deepEqual(sites.map((x) => [x.code, x.visits, x.tech_count, x.total_s, x.avg_s]), [["VS1", 3, 2, 14400, 4800], ["VS2", 2, 1, 3600, 1800]]);
  assert.deepEqual(sites[0].techs.map((x) => [x.plate, x.tech, x.n, x.total_s]), [[A, "טכנאי הדוח", 2, 10800], [B, null, 1, 3600]]);
  assert.equal(sites[0].name, "אתר בדיקה VS1");

  // טווח: הפוך, יותר מ-400 יום — 22023; 400 — מותר
  await fails(stats(RO, "2026-12-03", "2026-12-01"), "22023");
  await fails(stats(RO, "2025-10-01", "2026-12-01"), "22023");
  assert.ok((await stats(RO, "2025-11-01", "2026-12-05")).techs.length >= 2);
  await fails(userRaw(RO, `SELECT public.site_visit_stats('2026-12-03'::date, '2026-12-01'::date)`), "22023");
  // הרשאות: כל מי שמחובר (גם בקר); לא סוכן, לא אנונימי
  const AGT = "f3000000-0000-0000-0000-000000000009";
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, site_id, created_at)
             VALUES ('site-vs1@parkomat.co.il', 'סוכן', 'agent', true, $1, (SELECT id FROM sites WHERE code = 'VS1'), now()::text)`, [AGT]);
  for (const sql of [`SELECT public.tech_stats('2026-12-01', '2026-12-03')`, `SELECT public.tech_history('${A}', '2026-12-01', '2026-12-03')`,
                     `SELECT public.site_visit_stats('2026-12-01', '2026-12-03')`]) {
    await fails(userRaw(AGT, sql), "42501");
    await fails(as("anon", {}, sql), "42501");
  }
});
