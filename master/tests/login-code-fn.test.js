// tests/login-code-fn.test.js — Edge Function ‏send-login-code (supabase/functions/send-login-code/handler.ts), ב-Node
// עם fetch מדומה. אין רשת: כל fetch נרשם ונענה לפי הכתובת — כך נבדק גם *מה נשלח לאן*, ולא רק מה חזר.
//
// ⚠️ מה שהכי חשוב כאן: הקוד יוצא רק במייל. הוא אינו חוזר לדפדפן, ואינו נשלח לשום כתובת חוץ מ-Graph.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../supabase/functions/send-login-code/handler.ts");
const load = () => import(pathToFileURL(SRC).href);

const SUB = "e1000000-0000-0000-0000-000000000001";
const SID = "5e550000-0000-0000-0000-000000000001";
const ENV = {
  supabaseUrl: "https://db.test", anonKey: "anon-key", serviceKey: "SERVICE-SECRET",
  tenantId: "tenant-1", clientId: "client-1", clientSecret: "GRAPH-SECRET", from: "dashboard@parkomat.co.il",
};
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64u({ alg: "HS256" })}.${b64u(claims)}.sig`;
const TOKEN = jwt({ sub: SUB, session_id: SID, role: "authenticated" });

const ISSUE_SEND = { status: "send", code: "0427", email: "lc-mgr@parkomat.co.il", name: "מנהלת <b>", ttl_min: 10 };

// issue: מה ש-login_code_issue מחזירה; user: תשובת GoTrue (null = 401); mail: סטטוסים של sendMail לפי הסדר
function fakeFetch({ issue = ISSUE_SEND, user = { id: SUB }, mail = [202], tokenStatus = 200 } = {}) {
  const calls = [];
  const mails = [...mail];
  const f = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? String(init.body) : null;
    calls.push({ url: u, method: init.method, headers: init.headers, body });
    const res = (status, b) => new Response(b === undefined ? "" : JSON.stringify(b), { status });
    if (u === "https://db.test/auth/v1/user") return user ? res(200, user) : res(401, { msg: "bad jwt" });
    if (u === "https://db.test/rest/v1/rpc/login_code_issue") return res(200, issue);
    if (u === "https://db.test/rest/v1/rpc/login_code_unsend") return res(204);
    if (u.startsWith("https://login.microsoftonline.com/")) {
      return tokenStatus === 200 ? res(200, { access_token: `GRAPH-TOKEN-${calls.length}`, expires_in: 3600 })
                                 : res(tokenStatus, { error: "invalid_client" });
    }
    if (u.startsWith("https://graph.microsoft.com/")) return res(mails.length ? mails.shift() : 202);
    throw new Error(`פנייה לא צפויה: ${u}`);
  };
  return { f, calls };
}
const req = (body = {}, auth = `Bearer ${TOKEN}`, method = "POST") =>
  new Request("https://fn.test/send-login-code", {
    method, headers: { Authorization: auth, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
const run = async (h, r) => {
  const res = await h(r);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
};
const urls = (calls) => calls.map((c) => c.url.replace(/\?.*$/, ""));

test("שליחה: GoTrue באסימון של הקורא, הנפקה במפתח השירות, ומייל מ-dashboard@ — והקוד לא חוזר לדפדפן", async () => {
  const { makeHandler } = await load();
  const { f, calls } = fakeFetch();
  const r = await run(makeHandler(ENV, f), req());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: "sent", email: "lc-mgr@parkomat.co.il", resend_in: 60 });
  assert.ok(!r.text.includes("0427"), "הקוד חזר לדפדפן");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(urls(calls), [
    "https://db.test/auth/v1/user",
    "https://db.test/rest/v1/rpc/login_code_issue",
    "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token",
    "https://graph.microsoft.com/v1.0/users/dashboard%40parkomat.co.il/sendMail",
  ]);
  // GoTrue — באסימון של הקורא ובמפתח הציבורי
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].headers.apikey, "anon-key");
  // ההנפקה — במפתח השירות, עם sub ו-session_id מהאסימון
  assert.equal(calls[1].headers.apikey, "SERVICE-SECRET");
  assert.equal(calls[1].headers.Authorization, "Bearer SERVICE-SECRET");
  assert.deepEqual(JSON.parse(calls[1].body), { p_user: SUB, p_session: SID, p_force: false });
  // Microsoft: client credentials
  const form = new URLSearchParams(calls[2].body);
  assert.equal(form.get("client_id"), "client-1");
  assert.equal(form.get("client_secret"), "GRAPH-SECRET");
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("scope"), "https://graph.microsoft.com/.default");
  // המייל: לנמען מהמסד, הקוד בנושא ובגוף, השם מוגן מ-HTML
  const mail = JSON.parse(calls[3].body);
  assert.equal(calls[3].headers.Authorization, "Bearer GRAPH-TOKEN-3");
  assert.deepEqual(mail.message.toRecipients, [{ emailAddress: { address: "lc-mgr@parkomat.co.il" } }]);
  assert.equal(mail.message.subject, "קוד הכניסה לדשבורד: 0427");
  assert.equal(mail.message.body.contentType, "HTML");
  assert.match(mail.message.body.content, /0427/);
  assert.match(mail.message.body.content, /מנהלת &lt;b&gt;/);
  assert.match(mail.message.body.content, /תקף ל-10 דקות/);
  assert.equal(mail.saveToSentItems, false);
  // סודות לא דולפים לכתובות שאינן שלהם
  for (const c of calls) {
    if (!c.url.startsWith("https://db.test/rest/")) assert.ok(!JSON.stringify(c).includes("SERVICE-SECRET"), `מפתח השירות יצא ל-${c.url}`);
    if (!c.url.startsWith("https://login.microsoftonline.com/")) assert.ok(!JSON.stringify(c).includes("GRAPH-SECRET"), `סוד Graph יצא ל-${c.url}`);
    if (!c.url.startsWith("https://graph.microsoft.com/")) assert.ok(!String(c.body ?? "").includes("0427"), `הקוד יצא ל-${c.url}`);
  }
});

test("אסימון Graph נשמר בין קריאות; 401 מ-sendMail — אסימון חדש פעם אחת", async () => {
  const { makeHandler } = await load();
  const { f, calls } = fakeFetch({ mail: [202, 202, 401, 202] });
  const h = makeHandler(ENV, f);
  assert.equal((await run(h, req())).status, 200);
  assert.equal((await run(h, req({ resend: true }))).status, 200);
  assert.equal(calls.filter((c) => c.url.includes("login.microsoftonline")).length, 1);
  assert.equal((await run(h, req())).status, 200);   // 401 → אסימון חדש → 202
  assert.equal(calls.filter((c) => c.url.includes("login.microsoftonline")).length, 2);
  assert.deepEqual(JSON.parse(calls.filter((c) => c.url.endsWith("login_code_issue"))[1].body).p_force, true);
});

test("אין צורך במייל: pending / wait / verified / not_required — בלי פנייה ל-Microsoft", async () => {
  const { makeHandler } = await load();
  for (const [issue, expect] of [
    [{ status: "pending", email: "a@parkomat.co.il", resend_in: 41 }, { status: "pending", email: "a@parkomat.co.il", resend_in: 41 }],
    [{ status: "wait", email: "a@parkomat.co.il", resend_in: 12 }, { status: "wait", email: "a@parkomat.co.il", resend_in: 12 }],
    [{ status: "verified" }, { status: "verified" }],
    [{ status: "not_required" }, { status: "not_required" }],
  ]) {
    const { f, calls } = fakeFetch({ issue });
    const r = await run(makeHandler(ENV, f), req());
    assert.equal(r.status, 200, issue.status);
    assert.deepEqual(r.body, expect);
    assert.ok(!calls.some((c) => /microsoft/.test(c.url)), `${issue.status}: פנה ל-Microsoft`);
  }
});

test("תקרה: 429 עם הסבר לשעה וליום; משתמש מושבת — 403", async () => {
  const { makeHandler } = await load();
  let r = await run(makeHandler(ENV, fakeFetch({ issue: { status: "limit", per: "hour", email: "a@p" } }).f), req());
  assert.equal(r.status, 429);
  assert.equal(r.body.per, "hour");
  assert.match(r.body.error, /בשעה האחרונה/);
  r = await run(makeHandler(ENV, fakeFetch({ issue: { status: "limit", per: "day", email: "a@p" } }).f), req());
  assert.equal(r.body.per, "day");
  assert.match(r.body.error, /היום/);
  r = await run(makeHandler(ENV, fakeFetch({ issue: { status: "no_user" } }).f), req());
  assert.equal(r.status, 403);
});

test("הזדהות: בלי אסימון, בלי session_id, או ש-GoTrue דוחה — 401, ואין הנפקה", async () => {
  const { makeHandler } = await load();
  for (const auth of ["", "Basic x", `Bearer ${jwt({ sub: SUB, role: "authenticated" })}`, `Bearer ${jwt({ session_id: SID })}`, "Bearer not.a.jwt"]) {
    const { f, calls } = fakeFetch();
    const r = await run(makeHandler(ENV, f), req({}, auth));
    assert.equal(r.status, 401, auth);
    assert.equal(calls.length, 0, `${auth}: פנה החוצה`);
  }
  for (const user of [null, { id: "e1000000-0000-0000-0000-000000000999" }]) {
    const { f, calls } = fakeFetch({ user });
    const r = await run(makeHandler(ENV, f), req());
    assert.equal(r.status, 401);
    assert.deepEqual(urls(calls), ["https://db.test/auth/v1/user"]);
  }
});

test("המייל לא יצא: הקוד נמחק (unsend) ו-502 בלי הקוד; בלי הגדרות Graph — 503 בלי להנפיק", async () => {
  const { makeHandler } = await load();
  for (const opts of [{ mail: [500] }, { tokenStatus: 401 }]) {
    const { f, calls } = fakeFetch(opts);
    const r = await run(makeHandler(ENV, f), req());
    assert.equal(r.status, 502);
    assert.match(r.body.error, /המייל לא נשלח/);
    assert.ok(!r.text.includes("0427"));
    const un = calls.find((c) => c.url.endsWith("login_code_unsend"));
    assert.ok(un, "unsend לא נקרא");
    assert.deepEqual(JSON.parse(un.body), { p_session: SID });
    assert.equal(un.headers.apikey, "SERVICE-SECRET");
  }
  for (const k of ["tenantId", "clientId", "clientSecret", "from", "serviceKey"]) {
    const { f, calls } = fakeFetch();
    const r = await run(makeHandler({ ...ENV, [k]: "" }, f), req());
    assert.equal(r.status, 503, k);
    assert.equal(calls.length, 0, `${k}: הונפק קוד שלא יישלח`);
  }
});

test("OPTIONS ו-GET", async () => {
  const { makeHandler } = await load();
  const h = makeHandler(ENV, fakeFetch().f);
  assert.equal((await h(req({}, "", "OPTIONS"))).status, 200);
  assert.equal((await h(req({}, `Bearer ${TOKEN}`, "GET"))).status, 405);
});
