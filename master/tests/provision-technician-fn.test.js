// tests/provision-technician-fn.test.js — Edge Function ‏provision-technician (supabase/functions/provision-technician/
// handler.ts), ב-Node עם fetch מדומה. אין רשת: כל fetch נרשם ונענה לפי הכתובת — כך נבדק גם *מה נשלח לאן*.
//
// ⚠️ מה שהכי חשוב כאן: ההרשאה נקבעת במסד בזהות הקורא (tech_phone_begin) לפני שנוצר משהו; מפתח השירות נשלח רק
// ל-GoTrue ול-tech_phone_link; משתמש שנוצר ולא קושר — נמחק; והטלפון הקודם נמחק מ-GoTrue.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../supabase/functions/provision-technician/handler.ts");
const load = () => import(pathToFileURL(SRC).href);

const ENV = { supabaseUrl: "https://db.test", anonKey: "anon-key", serviceKey: "SERVICE-SECRET" };
const CALLER = "Bearer caller-token";
const NEW_UID = "7e000000-0000-0000-0000-000000000002";
const OLD_UID = "7e000000-0000-0000-0000-000000000001";
const BEGIN = { technician_id: 7, name: "טכנאי בדיקה", gen: 3, email: "tech-7-3@parkomat.co.il", old_uid: OLD_UID, actor: "רכזת" };

// begin / create / link / del: תשובות; null ב-begin = שגיאה מהמסד (beginErr)
function fakeFetch({ begin = BEGIN, beginErr = null, createStatus = 200, link = { ok: true, replaced: true, rev: 5 },
  linkErr = null, delStatus = 200 } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method, headers: init.headers ?? {}, body: init.body ? String(init.body) : null });
    const res = (status, b) => new Response(b === undefined ? "" : JSON.stringify(b), { status });
    if (u === "https://db.test/rest/v1/rpc/tech_phone_begin") return beginErr ? res(beginErr.status, beginErr.body) : res(200, begin);
    if (u === "https://db.test/auth/v1/admin/users" && init.method === "POST") {
      return createStatus === 200 ? res(200, { id: NEW_UID }) : res(createStatus, { msg: "nope" });
    }
    if (u === "https://db.test/rest/v1/rpc/tech_phone_link") return linkErr ? res(linkErr.status, linkErr.body) : res(200, link);
    if (u.startsWith("https://db.test/auth/v1/admin/users/") && init.method === "DELETE") return res(delStatus, {});
    throw new Error(`פנייה לא צפויה: ${init.method} ${u}`);
  };
  return { f, calls };
}
const req = (body = { technician_id: 7 }, auth = CALLER, method = "POST") =>
  new Request("https://fn.test/provision-technician", {
    method, headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
const run = async (h, r) => {
  const res = await h(r);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
};
const hdr = (c, k) => c.headers[k] ?? c.headers[k.toLowerCase()];

test("חיבור: begin בזהות הקורא, משתמש 'technician' במפתח השירות, link, ומחיקת הטלפון הקודם — הסיסמה חוזרת פעם אחת", async () => {
  const { makeHandler } = await load();
  const { f, calls } = fakeFetch();
  const r = await run(makeHandler(ENV, f), req());
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    "POST https://db.test/rest/v1/rpc/tech_phone_begin",
    "POST https://db.test/auth/v1/admin/users",
    "POST https://db.test/rest/v1/rpc/tech_phone_link",
    `DELETE https://db.test/auth/v1/admin/users/${OLD_UID}`,
  ]);
  // begin — בזהות הקורא, לא בשירות
  assert.equal(hdr(calls[0], "Authorization"), CALLER);
  assert.equal(hdr(calls[0], "apikey"), "anon-key");
  assert.deepEqual(JSON.parse(calls[0].body), { p_tech: 7 });
  // יצירה — האימייל מהמסד, התפקיד באפליקציה, מאומת
  const c = JSON.parse(calls[1].body);
  assert.equal(c.email, "tech-7-3@parkomat.co.il");
  assert.equal(c.email_confirm, true);
  assert.deepEqual(c.app_metadata, { parkomat_role: "technician", technician_id: 7 });
  assert.match(c.password, /^[A-Za-z0-9_-]{43}$/, "32 בתים, base64url");
  assert.equal(hdr(calls[1], "Authorization"), "Bearer SERVICE-SECRET");
  // link — מספר החיבור, המשתמש החדש, ומי ביקש
  assert.deepEqual(JSON.parse(calls[2].body), { p_tech: 7, p_gen: 3, p_uid: NEW_UID, p_actor: "רכזת" });
  assert.equal(hdr(calls[2], "Authorization"), "Bearer SERVICE-SECRET");
  // התשובה
  assert.equal(r.body.ok, true);
  assert.equal(r.body.email, "tech-7-3@parkomat.co.il");
  assert.equal(r.body.password, c.password, "הסיסמה שנוצרה — פעם אחת, ל-QR");
  assert.equal(r.body.replaced, true);
  assert.equal(r.body.name, "טכנאי בדיקה");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(!r.text.includes("SERVICE-SECRET"), "מפתח השירות לא חוזר לדפדפן");
  // ⚠️ מפתח השירות רק ל-GoTrue ול-link — לא ל-begin
  for (const k of calls) {
    if (JSON.stringify(k.headers).includes("SERVICE-SECRET")) {
      assert.ok(/\/auth\/v1\/admin\/users|\/rpc\/tech_phone_link$/.test(k.url), `מפתח השירות נשלח אל ${k.url}`);
    }
  }
});

test("חיבור ראשון (אין טלפון קודם) — בלי מחיקה; שתי סיסמאות שונות לשני חיבורים", async () => {
  const { makeHandler } = await load();
  const a = fakeFetch({ begin: { ...BEGIN, old_uid: null }, link: { ok: true, replaced: false, rev: 1 } });
  const r1 = await run(makeHandler(ENV, a.f), req());
  assert.equal(r1.status, 200);
  assert.ok(!a.calls.some((c) => c.method === "DELETE"));
  assert.equal(r1.body.replaced, false);
  const b = fakeFetch({ begin: { ...BEGIN, old_uid: null } });
  const r2 = await run(makeHandler(ENV, b.f), req());
  assert.notEqual(r1.body.password, r2.body.password);
});

test("המסד סירב (בקר, לא בפיילוט, טכנאי שאינו) — שום משתמש לא נוצר, וההודעה בעברית מהמסד", async () => {
  const { makeHandler } = await load();
  for (const [st, code, msg, want] of [
    [403, "42501", "בקר יכול רק לצפות — הפעולה מותרת לעורכים ולמנהלים", 403],
    [403, "42501", "לוח הטכנאים אינו פעיל לחשבון הזה", 403],
    [404, "PT404", "הטכנאי לא נמצא", 404],
    [400, "XX000", "internal: something", 400],
    [401, "PGRST301", "JWT expired", 401],
  ]) {
    const { f, calls } = fakeFetch({ beginErr: { status: st, body: { code, message: msg } } });
    const r = await run(makeHandler(ENV, f), req());
    assert.equal(r.status, want, `${code}: ${r.text}`);
    assert.equal(calls.length, 1, "רק begin");
    assert.equal(r.body.error, /[֐-׿]/.test(msg) ? msg : "הפעולה נכשלה — נסו שוב", "הודעה פנימית לא יוצאת");
  }
});

test("היצירה נכשלה — 502 בלי link; ה-link נכשל (QR חדש במקביל) — המשתמש שנוצר נמחק, 409", async () => {
  const { makeHandler } = await load();
  const a = fakeFetch({ createStatus: 422 });
  const r1 = await run(makeHandler(ENV, a.f), req());
  assert.equal(r1.status, 502);
  assert.ok(!a.calls.some((c) => /tech_phone_link/.test(c.url)));
  assert.ok(!("password" in r1.body), "בלי סיסמה בכשל");

  const b = fakeFetch({ linkErr: { status: 409, body: { code: "PT409", message: "נוצר בינתיים QR חדש לטכנאי הזה" } } });
  const r2 = await run(makeHandler(ENV, b.f), req());
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, "נוצר בינתיים QR חדש לטכנאי הזה");
  const dels = b.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
  assert.deepEqual(dels, [`https://db.test/auth/v1/admin/users/${NEW_UID}`], "החדש נמחק; הקודם — לא (החיבור לא קרה)");
  assert.ok(!("password" in r2.body));
});

test("מחיקת הטלפון הקודם נכשלה — החיבור הצליח, עם אזהרה", async () => {
  const { makeHandler } = await load();
  const { f } = fakeFetch({ delStatus: 500 });
  const r = await run(makeHandler(ENV, f), req());
  assert.equal(r.status, 200);
  assert.match(r.body.warning, /נותק במסד/);
  // 404 = כבר לא קיים — לא אזהרה
  const g = fakeFetch({ delStatus: 404 });
  assert.equal((await run(makeHandler(ENV, g.f), req())).body.warning, undefined);
});

test("בלי הזדהות / שיטה אחרת / בלי מזהה / תשובה משונה מהמסד / רשת שלא עונה", async () => {
  const { makeHandler } = await load();
  const { f, calls } = fakeFetch();
  const h = makeHandler(ENV, f);
  assert.equal((await run(h, req(undefined, null))).status, 401);
  assert.equal((await run(h, req(undefined, CALLER, "GET"))).status, 405);
  assert.equal((await run(h, req({}))).status, 400);
  assert.equal((await run(h, req({ technician_id: "7; drop" }))).status, 400);
  assert.equal(calls.length, 0);
  const odd = fakeFetch({ begin: { ...BEGIN, email: "someone@else.com" } });
  const r = await run(makeHandler(ENV, odd.f), req());
  assert.equal(r.status, 502);
  assert.equal(odd.calls.length, 1, "אימייל שאינו של טלפון — לא יוצרים משתמש");
  const slow = async () => { const e = new Error("Signal timed out."); e.name = "TimeoutError"; throw e; };
  const t = await run(makeHandler(ENV, slow), req());
  assert.equal(t.status, 502);
  assert.match(t.body.error, /לא ענו בזמן/);
  assert.equal((await run(makeHandler({ ...ENV, serviceKey: "" }, f), req())).status, 503);
});
