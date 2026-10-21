// tests/notify-tech-fn.test.js — Edge Function ‏notify-tech (supabase/functions/notify-tech/handler.ts), ב-Node עם fetch ושולח
// מדומים: הסוד, מה המסד החליט, מה נשלח לכל מכשיר, ומה דווח בחזרה (כמה הגיע, ואילו מנויים למחוק).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../supabase/functions/notify-tech/handler.ts");
const load = () => import(pathToFileURL(SRC).href);
const ENV = { supabaseUrl: "https://db.test", serviceKey: "SERVICE-SECRET", callerSecret: "push-secret-123" };
const SUBS = [
  { id: 11, endpoint: "https://fcm.googleapis.com/fcm/send/a", p256dh: "P1", auth: "A1" },
  { id: 12, endpoint: "https://fcm.googleapis.com/fcm/send/b", p256dh: "P2", auth: "A2" },
];
const CLAIM = { send: true, n: 1, dispatch_id: 7, title: "משימה חדשה: הרצל 50, ת\"א · 1227", body: "מעלית 2 תקועה", tag: "dispatch-7", subs: SUBS };

function fakes({ claim = CLAIM, claimStatus = 200, fail = {} } = {}) {
  const calls = [];
  const pushes = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers, body: init.body ? JSON.parse(String(init.body)) : null });
    const res = (status, b) => new Response(b === undefined ? "" : JSON.stringify(b), { status });
    if (u === "https://db.test/rest/v1/rpc/tech_push_claim") return res(claimStatus, claim);
    if (u === "https://db.test/rest/v1/rpc/tech_push_result") return res(200, { ok: true });
    throw new Error(`פנייה לא צפויה: ${u}`);
  };
  const send = async (s, payload) => {
    pushes.push({ id: s.id, endpoint: s.endpoint, payload: JSON.parse(payload) });
    const st = fail[s.id];
    if (st) { const e = new Error(); e.response = new Response("", { status: st }); throw e; }
  };
  return { f, send, calls, pushes };
}
const req = (body = { dispatch_id: 7 }, secret = "push-secret-123", method = "POST") =>
  new Request("https://fn.test/notify-tech", {
    method, headers: { "Content-Type": "application/json", ...(secret ? { "x-parkomat-push-secret": secret } : {}) },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
const run = async (h, r) => { const res = await h(r); const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null }; };

test("שליחה: claim במפתח השירות, Web Push לכל מכשיר עם מה שהמסד כתב, ודיווח בחזרה", async () => {
  const { makeHandler } = await load();
  const k = fakes();
  const r = await run(makeHandler(ENV, k.f, k.send), req());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { sent: 2, removed: 0, n: 1 });
  assert.equal(k.calls[0].url, "https://db.test/rest/v1/rpc/tech_push_claim");
  assert.deepEqual(k.calls[0].body, { p_dispatch: 7 });
  assert.equal(k.calls[0].headers.Authorization, "Bearer SERVICE-SECRET");
  assert.deepEqual(k.pushes.map((p) => p.id).sort(), [11, 12]);
  assert.deepEqual(k.pushes[0].payload, { kind: "dispatch", id: 7, n: 1, title: CLAIM.title, body: "מעלית 2 תקועה", tag: "dispatch-7", url: "/" });
  assert.deepEqual(k.calls[1].body, { p_dispatch: 7, p_sent: 2, p_dead: [], p_error: null });
});

test("מכשיר שנעלם (410/404) — נמחק; סירוב אחר — לא נמחק, ונרשם למה; אחד הגיע — אין שגיאה", async () => {
  const { makeHandler } = await load();
  let k = fakes({ fail: { 11: 410 } });
  let r = await run(makeHandler(ENV, k.f, k.send), req());
  assert.deepEqual(r.body, { sent: 1, removed: 1, n: 1 });
  assert.deepEqual(k.calls[1].body, { p_dispatch: 7, p_sent: 1, p_dead: [11], p_error: null });
  k = fakes({ fail: { 11: 404, 12: 500 } });
  r = await run(makeHandler(ENV, k.f, k.send), req());
  assert.deepEqual(r.body, { sent: 0, removed: 1, n: 1 });
  assert.deepEqual(k.calls[1].body, { p_dispatch: 7, p_sent: 0, p_dead: [11], p_error: "שירות ההתראות סירב (500)" });
  k = fakes({ fail: { 11: 410, 12: 410 } });
  await run(makeHandler(ENV, k.f, k.send), req());
  assert.match(k.calls[1].body.p_error, /הטלפון הסיר את ההרשמה/);
});

test("המסד אמר לא לשלוח (אושר / הסתיים / 3 צפצופים / אין טלפון) — אין Web Push ואין דיווח", async () => {
  const { makeHandler } = await load();
  for (const reason of ["acked", "ended", "max", "recent", "no_phone", "gone"]) {
    const k = fakes({ claim: { send: false, reason } });
    const r = await run(makeHandler(ENV, k.f, k.send), req());
    assert.deepEqual(r.body, { sent: 0, reason });
    assert.equal(k.pushes.length, 0);
    assert.equal(k.calls.length, 1, "רק claim");
  }
});

test("הסוד: חסר / שגוי — 401 בלי לגעת במסד; לא מוגדר — 503; בלי מזהה — 400; claim נכשל — 502", async () => {
  const { makeHandler } = await load();
  const k = fakes();
  const h = makeHandler(ENV, k.f, k.send);
  assert.equal((await run(h, req(undefined, null))).status, 401);
  assert.equal((await run(h, req(undefined, "push-secret-124"))).status, 401);
  assert.equal((await run(h, req(undefined, "push-secret-12"))).status, 401, "אורך שונה");
  assert.equal((await run(h, req(undefined, ENV.callerSecret, "GET"))).status, 405);
  assert.equal((await run(h, req({}))).status, 400);
  assert.equal(k.calls.length, 0);
  assert.equal((await run(makeHandler({ ...ENV, callerSecret: "" }, k.f, k.send), req(undefined, ""))).status, 503);
  const bad = fakes({ claimStatus: 500 });
  assert.equal((await run(makeHandler(ENV, bad.f, bad.send), req())).status, 502);
  assert.equal(bad.pushes.length, 0);
});

test("pushStatus: response.status, status, או מספר בטקסט", async () => {
  const { pushStatus } = await load();
  const e1 = new Error(); e1.response = { status: 410 };
  assert.equal(pushStatus(e1), 410);
  assert.equal(pushStatus({ status: 404 }), 404);
  assert.equal(pushStatus(new Error("pushing message failed: 403 Forbidden")), 403);
  assert.equal(pushStatus(new Error("network down")), null);
});
