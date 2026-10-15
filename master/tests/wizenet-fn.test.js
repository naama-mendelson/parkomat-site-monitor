// tests/wizenet-fn.test.js — הדלת לטוקן של ויזנט (supabase/functions/wizenet/handler.ts), ב-Node עם fetch מדומה.
//
// handler.ts נטען כמו שהוא (Node מריץ TypeScript בהסרת טיפוסים). אין כאן רשת: כל fetch נרשם, ומקבל תשובה לפי
// הכתובת — כך נבדק גם *מה נשלח לאן*, ולא רק מה חזר.
//
// ⚠️ 15/10/2026: הפונקציה אינה פונה עוד לוויזנט (חסום מחו"ל). היא מוסרת את הטוקן לממסר — מחשב באתר — ורק למי
// שהמסד אומר שהוא ממסר. הבדיקות של שינוי סטטוס ושל פענוח הרשימות עברו ל-wizenet-relay.test.js, עם הקוד.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../supabase/functions/wizenet/handler.ts");
const load = () => import(pathToFileURL(SRC).href);

const ENV = {
  supabaseUrl: "https://db.test", anonKey: "anon-key", wizenetBase: "https://wz.test/api",
  token: "WZ-SECRET-TOKEN", qryStatus: "Q-STATUS", qryType: "Q-TYPE",
};

// relayMe: התשובה של wizenet_relay_me — true / false / null (= 401 מ-PostgREST) / Error (= נזרק)
function fakeFetch({ relayMe = true } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const res = (status, body) => new Response(JSON.stringify(body), { status });
    if (!u.startsWith(ENV.supabaseUrl)) throw new Error(`פנייה לא צפויה: ${u}`);
    const fn = u.split("/rpc/")[1];
    if (fn !== "wizenet_relay_me") return res(404, { message: "no such function" });
    if (relayMe instanceof Error) throw relayMe;
    return relayMe === null ? res(401, { message: "jwt" }) : res(200, relayMe);
  };
  return { f, calls };
}
const req = (body, auth = "Bearer relay-jwt", method = "POST") =>
  new Request("https://fn.test/wizenet", { method, headers: { Authorization: auth, "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });
const run = async (h, r) => {
  const res = await h(r);
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};

test("ממסר: המסד נשאל בזהות הקורא, והטוקן, הכתובת ומזהי השאילתות נמסרים — בלי מטמון", async () => {
  const { makeHandler } = await load();
  const { f, calls } = fakeFetch();
  const r = await run(makeHandler(ENV, f), req({ action: "relay_config" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { token: "WZ-SECRET-TOKEN", base: "https://wz.test/api", vars: { qry_status: "Q-STATUS", qry_type: "Q-TYPE" } });
  assert.equal(r.headers.get("cache-control"), "no-store");
  // פנייה אחת בלבד: wizenet_relay_me, באסימון של הקורא ובמפתח הציבורי. ⚠️ לא לוויזנט, ולא בשום מפתח אחר.
  assert.deepEqual(calls.map((c) => c.url), ["https://db.test/rest/v1/rpc/wizenet_relay_me"]);
  assert.equal(calls[0].headers.Authorization, "Bearer relay-jwt");
  assert.equal(calls[0].headers.apikey, "anon-key");
  assert.ok(!JSON.stringify(calls).includes("WZ-SECRET-TOKEN"), "הטוקן יצא בבקשה");
});

test("מי שאינו ממסר — 403 בלי טוקן; אימות שנכשל — 401; בלי הזדהות — 401 בלי לפנות למסד", async () => {
  const { makeHandler } = await load();
  for (const [relayMe, status] of [[false, 403], [null, 401]]) {
    const { f } = fakeFetch({ relayMe });
    const r = await run(makeHandler(ENV, f), req({ action: "relay_config" }));
    assert.equal(r.status, status);
    assert.ok(!JSON.stringify(r.body).includes("WZ-SECRET-TOKEN"));
  }
  // ⚠️ רק true מפורש. "true" כמחרוזת, 1, אובייקט — אינם "כן"
  for (const relayMe of ["true", 1, { ok: true }]) {
    const { f } = fakeFetch({ relayMe });
    assert.equal((await run(makeHandler(ENV, f), req({ action: "relay_config" }))).status, 403, JSON.stringify(relayMe));
  }
  for (const auth of ["", "Basic x", "relay-jwt"]) {
    const { f, calls } = fakeFetch();
    const r = await run(makeHandler(ENV, f), req({ action: "relay_config" }, auth));
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  }
});

test("⚠️ שורה חדשה בסוף הסוד — נמסר נקי (נמדד בבדיקה חיה, 15/10/2026: 411 מוויזנט על כל פנייה מהממסר)", async () => {
  const { makeHandler } = await load();
  const { f } = fakeFetch();
  const r = await run(makeHandler({ ...ENV, token: "Bearer WZ-SECRET-TOKEN\n", wizenetBase: " https://wz.test/api\r\n",
    qryStatus: "Q-STATUS\n", qryType: " Q-TYPE " }, f), req({ action: "relay_config" }));
  assert.deepEqual(r.body, { token: "Bearer WZ-SECRET-TOKEN", base: "https://wz.test/api", vars: { qry_status: "Q-STATUS", qry_type: "Q-TYPE" } });
  // טוקן שהוא רק רווחים — אינו טוקן
  const { f: g } = fakeFetch();
  assert.equal((await run(makeHandler({ ...ENV, token: " \n" }, g), req({ action: "relay_config" }))).status, 503);
});

test("בלי טוקן מוגדר — 503; בלי מזהי שאילתות — נמסר בכל זאת (שינוי סטטוס אינו צריך אותם)", async () => {
  const { makeHandler } = await load();
  let { f } = fakeFetch();
  let r = await run(makeHandler({ ...ENV, token: "" }, f), req({ action: "relay_config" }));
  assert.equal(r.status, 503);
  ({ f } = fakeFetch());
  r = await run(makeHandler({ ...ENV, qryStatus: "", qryType: "" }, f), req({ action: "relay_config" }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.vars, { qry_status: "", qry_type: "" });
});

test("⚠️ הפעולות הקודמות (update, lookups) — 400, בלי פנייה לשום מקום; שיטה אחרת — 405; OPTIONS — ok", async () => {
  const { makeHandler } = await load();
  for (const body of [{ action: "update", field: "status", callid: "1", value: "1" }, { action: "lookups" }, {}, null]) {
    const { f, calls } = fakeFetch();
    const r = await run(makeHandler(ENV, f), req(body));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "פעולה לא מוכרת");
    assert.equal(calls.length, 0, JSON.stringify(body));
  }
  const { f } = fakeFetch();
  assert.equal((await makeHandler(ENV, f)(req(null, "Bearer x", "GET"))).status, 405);
  assert.equal((await makeHandler(ENV, f)(new Request("https://fn.test/wizenet", { method: "OPTIONS" }))).status, 200);
});

test("⚠️ קצב-זמן מול Supabase — בניסוח של Deno, ובשם בלבד — 504; כשל אחר — 500 עם הסיבה", async () => {
  const { makeHandler } = await load();
  // כך זה נראה ב-Deno (נמצא בפריסה הראשונה, 13/10): DOMException בשם TimeoutError, "Signal timed out."
  for (const err of [Object.assign(new Error("Signal timed out."), { name: "TimeoutError" }),
    Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" }), new Error("Signal timed out.")]) {
    const { f } = fakeFetch({ relayMe: err });
    const r = await run(makeHandler(ENV, f), req({ action: "relay_config" }));
    assert.equal(r.status, 504, err.message);
    assert.equal(r.body.error, "Supabase לא ענה בזמן");
  }
  const { f } = fakeFetch({ relayMe: new Error("connection refused") });
  const r = await run(makeHandler(ENV, f), req({ action: "relay_config" }));
  assert.equal(r.status, 500);
  assert.match(r.body.detail, /connection refused/);
});
