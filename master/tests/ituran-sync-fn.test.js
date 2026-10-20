// tests/ituran-sync-fn.test.js — Edge Function ‏ituran-sync (supabase/functions/ituran-sync/handler.ts), ב-Node עם fetch
// מדומה: מי רשאי לקרוא, הטוקן (שמירה, חידוש, 401), דפדוף, מה עובר למסד, וכשלים. אין רשת.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../supabase/functions/ituran-sync/handler.ts");
const load = () => import(pathToFileURL(SRC).href);

const ENV = {
  supabaseUrl: "https://db.test", serviceKey: "SERVICE-SECRET", callerSecret: "CALLER-SECRET",
  ituranBase: "https://it.test", username: "user-x", password: "PW-SECRET",
};
const car = (plate) => ({ license_plate: plate, motion_status: "parking" });

// pages: מערך של מערכי רכבים לכל עמוד; vehicleStatus: סטטוסים לפי הסדר (ברירת מחדל 200); token: תשובות לבקשות טוקן
function fakeFetch({ pages = [[car("1"), car("2")]], vehicleStatus = [], token = [], ingest = 2 } = {}) {
  const calls = [];
  const vs = [...vehicleStatus];
  const ts = [...token];
  let issued = 0;
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const res = (status, b) => new Response(b === undefined ? "" : JSON.stringify(b), { status });
    if (u === "https://it.test/api/v1/oauth/token") {
      const t = ts.length ? ts.shift() : 200;
      if (t !== 200) return res(t, { error_code: String(t) });
      issued++;
      return res(200, { access_token: `TOK-${issued}`, refresh_token: `REF-${issued}`, expires_in: 1440, token_type: "bearer" });
    }
    if (u.startsWith("https://it.test/api/v2/vehicles?")) {
      const s = vs.length ? vs.shift() : 200;
      if (s !== 200) return res(s, { error: "x" });
      const page = Number(new URL(u).searchParams.get("page_number"));
      return res(200, { metadata: { pagination: { page_number: page, page_size: 100, page_count: pages.length } }, vehicles: pages[page - 1] || [] });
    }
    if (u === "https://db.test/rest/v1/rpc/ituran_ingest") return res(200, ingest);
    if (u === "https://db.test/rest/v1/rpc/ituran_sync_failed") return res(204);
    throw new Error(`פנייה לא צפויה: ${u}`);
  };
  return { f, calls };
}
const req = (secret = "CALLER-SECRET", method = "POST") =>
  new Request("https://fn.test/ituran-sync", { method, headers: secret ? { "x-parkomat-ituran-secret": secret } : {}, body: method === "POST" ? "{}" : undefined });
const run = async (h, r) => { const res = await h(r); const text = await res.text(); return { status: res.status, text, body: text ? JSON.parse(text) : null }; };
const of = (calls, part) => calls.filter((c) => c.url.includes(part));

test("סנכרון: טוקן בשם משתמש, רשימת הרכבים עם מיקום/נהג/מקומות, והמערך כמות שהוא למסד במפתח השירות", async () => {
  const { makeHandler } = await load();
  const { f, calls } = fakeFetch();
  const r = await run(makeHandler(ENV, f), req());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, vehicles: 2, complete: true });
  const [tokenCall] = of(calls, "/oauth/token");
  assert.deepEqual(tokenCall.body, { grant_type: "password", username: "user-x", password: "PW-SECRET" });
  const [v] = of(calls, "/api/v2/vehicles");
  const q = new URL(v.url).searchParams;
  assert.deepEqual(q.getAll("realtime_fields"), ["LastLocation", "Driver", "Places"]);
  assert.equal(q.get("page_size"), "100");
  assert.equal(v.headers.Authorization, "Bearer TOK-1");
  const [ing] = of(calls, "rpc/ituran_ingest");
  assert.equal(ing.headers.apikey, "SERVICE-SECRET");
  assert.deepEqual(ing.body.p_vehicles, [car("1"), car("2")]);
  assert.equal(ing.body.p_meta.complete, true);
  assert.equal(ing.body.p_meta.token_fresh, true);
  // סודות לא דולפים: הסיסמה רק לאיתוראן, מפתח השירות רק למסד, ושום דבר מהם לא חוזר בתשובה
  for (const c of calls) {
    if (!c.url.endsWith("/oauth/token")) assert.ok(!JSON.stringify(c).includes("PW-SECRET"), `הסיסמה יצאה ל-${c.url}`);
    if (!c.url.startsWith("https://db.test/")) assert.ok(!JSON.stringify(c).includes("SERVICE-SECRET"), `מפתח השירות יצא ל-${c.url}`);
  }
  for (const s of ["PW-SECRET", "SERVICE-SECRET", "TOK-1", "REF-1"]) assert.ok(!r.text.includes(s), `${s} בתשובה`);
});

test("הטוקן נשמר בין קריאות; חידוש ב-refresh_token לפני שפג; חידוש שנכשל — שם משתמש וסיסמה", async () => {
  const { makeHandler } = await load();
  let t = 1_000_000;
  const { f, calls } = fakeFetch({ token: [200, 200, 401, 200] });
  const h = makeHandler(ENV, f, () => t);
  await run(h, req());
  t += 60 * 60_000;                       // שעה אחרי — אותו טוקן
  await run(h, req());
  assert.equal(of(calls, "/oauth/token").length, 1);
  assert.equal(of(calls, "rpc/ituran_ingest")[1].body.p_meta.token_fresh, false);
  t += 23 * 60 * 60_000 - 4 * 60_000;      // 4 דקות לפני שפג — חידוש
  await run(h, req());
  assert.deepEqual(of(calls, "/oauth/token")[1].body, { grant_type: "refresh_token", refresh_token: "REF-1" });
  t += 24 * 60 * 60_000;                   // שוב — החידוש נדחה (401) ← שם משתמש וסיסמה
  await run(h, req());
  const tk = of(calls, "/oauth/token");
  assert.equal(tk[2].body.grant_type, "refresh_token");
  assert.equal(tk[3].body.grant_type, "password");
  assert.equal(of(calls, "/api/v2/vehicles").at(-1).headers.Authorization, "Bearer TOK-3");
});

test("401 מרשימת הרכבים: טוקן חדש בשם משתמש, פעם אחת; עדיין 401 — כשל שנרשם", async () => {
  const { makeHandler } = await load();
  let { f, calls } = fakeFetch({ vehicleStatus: [401, 200] });
  let r = await run(makeHandler(ENV, f), req());
  assert.equal(r.status, 200);
  assert.deepEqual(of(calls, "/oauth/token").map((c) => c.body.grant_type), ["password", "password"]);
  assert.equal(of(calls, "rpc/ituran_ingest")[0].body.p_meta.token_fresh, true);

  ({ f, calls } = fakeFetch({ vehicleStatus: [401, 401] }));
  r = await run(makeHandler(ENV, f), req());
  assert.equal(r.status, 502);
  assert.match(of(calls, "rpc/ituran_sync_failed")[0].body.p_error, /דחו את הטוקן/);
  assert.equal(of(calls, "rpc/ituran_ingest").length, 0);
});

test("דפדוף: כל העמודים נאספים; complete רק כשהגענו לעמוד האחרון", async () => {
  const { makeHandler } = await load();
  const { f, calls } = fakeFetch({ pages: [[car("1")], [car("2")], [car("3")]] });
  await run(makeHandler(ENV, f), req());
  assert.equal(of(calls, "/api/v2/vehicles").length, 3);
  const ing = of(calls, "rpc/ituran_ingest")[0].body;
  assert.deepEqual(ing.p_vehicles.map((v) => v.license_plate), ["1", "2", "3"]);
  assert.equal(ing.p_meta.complete, true);
  assert.equal(ing.p_meta.pages, 3);
});

test("כשלים: איתוראן לא מחברים / מחזירים 500 / פרטים חסרים — נרשם במסד, 502, ושום דבר לא נקלט", async () => {
  const { makeHandler } = await load();
  for (const [opts, env, re] of [
    [{ token: [400] }, ENV, /סירבו להתחבר \(400\)/],
    [{ vehicleStatus: [500] }, ENV, /500/],
    [{}, { ...ENV, password: "" }, /לא הוגדרו/],
  ]) {
    const { f, calls } = fakeFetch(opts);
    const r = await run(makeHandler(env, f), req());
    assert.equal(r.status, 502);
    assert.match(of(calls, "rpc/ituran_sync_failed")[0].body.p_error, re);
    assert.equal(of(calls, "rpc/ituran_ingest").length, 0);
  }
});

test("מי רשאי: בלי סוד / סוד שגוי — 401 בלי שום פנייה; בלי סוד מוגדר — 503; רק POST", async () => {
  const { makeHandler } = await load();
  for (const s of ["", "WRONG", "CALLER-SECRE", "CALLER-SECRET-"]) {
    const { f, calls } = fakeFetch();
    const r = await run(makeHandler(ENV, f), req(s));
    assert.equal(r.status, 401, s);
    assert.equal(calls.length, 0);
  }
  const { f, calls } = fakeFetch();
  assert.equal((await run(makeHandler({ ...ENV, callerSecret: "" }, f), req(""))).status, 503);
  assert.equal(calls.length, 0);
  assert.equal((await run(makeHandler(ENV, f), req("CALLER-SECRET", "GET"))).status, 405);
});
