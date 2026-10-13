// tests/wizenet-fn.test.js — הממסר לוויזנט (supabase/functions/wizenet/handler.ts), ב-Node עם fetch מדומה.
//
// handler.ts נטען כמו שהוא (Node מריץ TypeScript בהסרת טיפוסים). אין כאן רשת: כל fetch נרשם, ומקבל תשובה לפי
// הכתובת — כך נבדק גם *מה נשלח לאן*, ולא רק מה חזר.
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

function fakeFetch({ role = "operator", wz = {}, rpcFail = {} } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const res = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    if (u.startsWith(ENV.supabaseUrl)) {
      const fn = u.split("/rpc/")[1];
      if (rpcFail[fn]) return res(rpcFail[fn], { message: "denied" });
      if (fn === "my_role") return role === null ? res(401, { message: "jwt" }) : res(200, role);
      return res(200, fn === "wizenet_lookups_save" ? 2 : "2026-10-13T08:00:00.000Z");
    }
    const func = new URL(u).searchParams.get("func");
    const r = typeof wz === "function" ? wz(func, JSON.parse(init.body)) : wz[func];
    if (r instanceof Error) throw r;
    return res(r?.status ?? 200, r?.body ?? "");
  };
  return { f, calls };
}
const req = (body, auth = "Bearer user-jwt", method = "POST") =>
  new Request("https://fn.test/wizenet", { method, headers: { Authorization: auth, "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });
const run = async (h, r) => { const res = await h(r); return { status: res.status, body: await res.json().catch(() => null) }; };

test("עדכון סטטוס: ההרשאה נבדקת קודם; לוויזנט — הטוקן שלהם בלבד; אצלנו — בזהות הקורא; ואז נרשם", async () => {
  const { makeHandler } = await load();
  const { f, calls } = fakeFetch({ wz: { wizeApp_updateCallStatus: { body: '{"Status":"1","message":"update successfully"}' } } });
  const r = await run(makeHandler(ENV, f), req({ action: "update", field: "status", callid: "123", value: "151" }));
  assert.deepEqual(r, { status: 200, body: { ok: true, recorded: true } });
  assert.deepEqual(calls.map((c) => c.url.replace(/\?.*/, "").split("/").pop()), ["my_role", "api", "service_call_record_change"]);
  const wz = calls[1];
  assert.equal(new URL(wz.url).searchParams.get("func"), "wizeApp_updateCallStatus");
  assert.deepEqual(wz.body, { callid: "123", callstatusid: "151" });
  assert.equal(wz.headers.Authorization, "WZ-SECRET-TOKEN");
  // ⚠️ הטוקן של ויזנט לעולם לא יוצא ל-Supabase, ואסימון המשתמש לעולם לא יוצא לוויזנט
  for (const c of calls.filter((c) => c.url.startsWith(ENV.supabaseUrl))) {
    assert.equal(c.headers.Authorization, "Bearer user-jwt");
    assert.ok(!JSON.stringify(c).includes("WZ-SECRET-TOKEN"));
  }
  assert.ok(!JSON.stringify(wz).includes("user-jwt"));
  assert.deepEqual(calls[2].body, { p_ticket: "123", p_field: "status", p_value: "151" });
});

test("עדכון סוג — הפונקציה והשדה של סוג", async () => {
  const { makeHandler } = await load();
  const { f, calls } = fakeFetch({ wz: { wizeApp_updateCallType: { body: "update successfully" } } });
  const r = await run(makeHandler(ENV, f), req({ action: "update", field: "type", callid: "77", value: "2" }));
  assert.equal(r.status, 200);
  assert.deepEqual(calls[1].body, { callid: "77", calltypeid: "2" });
  assert.deepEqual(calls[2].body, { p_ticket: "77", p_field: "type", p_value: "2" });
});

test("⚠️ 200 עם שגיאה בגוף אינו הצלחה — ולא נרשם אצלנו; השגיאות בעברית", async () => {
  const { makeHandler } = await load();
  for (const [text, re] of [["call not found", /הקריאה לא נמצאה/], ["callstatusid not found", /אינו קיים בוויזנט/],
                            ["problem_occur_go_to_wizenet", /שגיאה במערכת של ויזנט/], ["something odd", /ויזנט החזירו שגיאה: something odd/]]) {
    const { f, calls } = fakeFetch({ wz: { wizeApp_updateCallStatus: { status: 200, body: text } } });
    const r = await run(makeHandler(ENV, f), req({ action: "update", field: "status", callid: "5", value: "1" }));
    assert.equal(r.status, 502, text);
    assert.match(r.body.error, re);
    assert.equal(calls.filter((c) => c.url.includes("service_call_record_change")).length, 0, "נרשם למרות שוויזנט לא אישרו");
  }
});

test("מי שאינו צוות, או בלי הזדהות — נדחה לפני שפונים לוויזנט", async () => {
  const { makeHandler } = await load();
  for (const [opts, auth, status] of [[{ role: "agent" }, "Bearer x", 403], [{ role: null }, "Bearer x", 401], [{}, "", 401]]) {
    const { f, calls } = fakeFetch({ ...opts, wz: { wizeApp_updateCallStatus: { body: "update successfully" } } });
    const r = await run(makeHandler(ENV, f), req({ action: "update", field: "status", callid: "1", value: "1" }, auth));
    assert.equal(r.status, status);
    assert.equal(calls.filter((c) => c.url.startsWith("https://wz.test")).length, 0, "פנה לוויזנט בלי הרשאה");
  }
});

test("קלט לא תקין — 400 בלי לפנות לוויזנט; בלי טוקן — 503", async () => {
  const { makeHandler } = await load();
  for (const body of [{ action: "update", field: "priority", callid: "1", value: "1" }, { action: "update", field: "status", callid: "0", value: "1" },
                      { action: "update", field: "status", callid: "12a", value: "1" }, { action: "update", field: "status", callid: "5", value: "" },
                      { action: "nope" }]) {
    const { f, calls } = fakeFetch();
    const r = await run(makeHandler(ENV, f), req(body));
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(calls.filter((c) => c.url.startsWith("https://wz.test")).length, 0);
  }
  const { f } = fakeFetch();
  assert.equal((await run(makeHandler({ ...ENV, token: "" }, f), req({ action: "update", field: "status", callid: "1", value: "1" }))).status, 503);
});

test("שינוי שוויזנט אישרו אבל לא נרשם אצלנו — ok, עם אזהרה (השינוי כבר קרה אצלם)", async () => {
  const { makeHandler } = await load();
  const { f } = fakeFetch({ wz: { wizeApp_updateCallStatus: { body: "update successfully" } }, rpcFail: { service_call_record_change: 400 } });
  const r = await run(makeHandler(ENV, f), req({ action: "update", field: "status", callid: "9", value: "1" }));
  assert.deepEqual(r.body, { ok: true, recorded: false, warning: "השינוי נשמר בוויזנט, אבל לא נרשם אצלנו" });
});

test("רשימות: שתי שאילתות עם ה-QRYID שלהן, פענוח, ושמירה בזהות הקורא; רשימה שלא פוענחה — קטע מהתשובה", async () => {
  const { makeHandler } = await load();
  const { f, calls } = fakeFetch({ wz: (func, body) => ({ body: body.QRYID === "Q-STATUS"
    ? [{ CallStatusID: 148, CallStatusName: "פתוחה" }, { CallStatusID: 150, CallStatusName: "סגורה" }]
    : { data: [{ id: "1", name: "תקלה" }] } }) });
  const r = await run(makeHandler(ENV, f), req({ action: "lookups" }));
  assert.deepEqual(r, { status: 200, body: { ok: true, status: 2, type: 1 } });
  const saves = calls.filter((c) => c.url.endsWith("/wizenet_lookups_save"));
  assert.deepEqual(saves.map((c) => c.body), [
    { p_kind: "status", p_items: [{ id: "148", name: "פתוחה" }, { id: "150", name: "סגורה" }] },
    { p_kind: "type", p_items: [{ id: "1", name: "תקלה" }] }]);
  const { f: f2 } = fakeFetch({ wz: () => ({ body: "<html>login</html>" }) });
  const bad = await run(makeHandler(ENV, f2), req({ action: "lookups" }));
  assert.equal(bad.status, 502);
  assert.equal(bad.body.sample, "<html>login</html>");
  const { f: f3, calls: c3 } = fakeFetch();
  assert.equal((await run(makeHandler({ ...ENV, qryType: "" }, f3), req({ action: "lookups" }))).status, 503);
  assert.equal(c3.filter((c) => c.url.startsWith("https://wz.test")).length, 0, "פנה לוויזנט עם רשימה אחת בלבד");
});

test("parseLookup — צורות סבירות של תשובה, ושורות בלי id או שם נזרקות", async () => {
  const { parseLookup } = await load();
  assert.deepEqual(parseLookup([{ ID: 1, Name: "א" }, { foo: 1 }, { id: "", name: "ריק" }]), [{ id: "1", name: "א" }]);
  assert.deepEqual(parseLookup({ Table: [{ StatusId: "5", StatusDesc: "ב" }] }), [{ id: "5", name: "ב" }]);
  assert.deepEqual(parseLookup([{ "קוד": 3, "שם": "ג" }]), [{ id: "3", name: "ג" }]);
  assert.deepEqual(parseLookup([{ typeid: 7, x: "ד" }]), [{ id: "7", name: "ד" }]);
  assert.deepEqual(parseLookup("text"), []);
  assert.deepEqual(parseLookup(null), []);
});

test("ויזנט לא עונים — 504, ולא נרשם דבר", async () => {
  const { makeHandler } = await load();
  const err = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const { f, calls } = fakeFetch({ wz: { wizeApp_updateCallStatus: err } });
  const r = await run(makeHandler(ENV, f), req({ action: "update", field: "status", callid: "1", value: "1" }));
  assert.equal(r.status, 504);
  assert.equal(r.body.error, "ויזנט לא ענו בזמן");
  assert.equal(calls.filter((c) => c.url.includes("service_call_record_change")).length, 0);
});

test("⚠️ קצב-זמן בניסוח של Deno, וכשל חיבור — מזוהים לפי המקור (ויזנט / Supabase)", async () => {
  const { makeHandler } = await load();
  // כך זה נראה ב-Deno (נמצא בפריסה הראשונה): DOMException בשם TimeoutError, "Signal timed out."
  const deno = () => Object.assign(new Error("Signal timed out."), { name: "TimeoutError" });
  let { f } = fakeFetch({ wz: { wizeApp_getBIReportQuery: deno() } });
  let r = await run(makeHandler(ENV, f), req({ action: "lookups" }));
  assert.equal(r.status, 504);
  assert.equal(r.body.error, "ויזנט לא ענו בזמן");
  // השם לבדו מספיק, גם כשההודעה אינה אומרת "זמן"
  ({ f } = fakeFetch({ wz: { wizeApp_getBIReportQuery: Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" }) } }));
  r = await run(makeHandler(ENV, f), req({ action: "lookups" }));
  assert.equal(r.status, 504);
  // שם אחר, אותה הודעה — עדיין קצב-זמן
  ({ f } = fakeFetch({ wz: { wizeApp_getBIReportQuery: new Error("Signal timed out.") } }));
  r = await run(makeHandler(ENV, f), req({ action: "lookups" }));
  assert.equal(r.status, 504);
  // כשל חיבור לוויזנט שאינו קצב-זמן — 502 עם הסיבה
  ({ f } = fakeFetch({ wz: { wizeApp_getBIReportQuery: new Error("connection refused") } }));
  r = await run(makeHandler(ENV, f), req({ action: "lookups" }));
  assert.equal(r.status, 502);
  const b = r.body;
  assert.equal(b.error, "אין חיבור לוויזנט");
  assert.match(b.detail, /connection refused/);
  // קצב-זמן בדרך ל-Supabase — לא מאשימים את ויזנט
  const g = async (url, init) => {
    if (String(url).includes("/rpc/wizenet_lookups_save")) throw deno();
    return f(url, init);
  };
  ({ f } = fakeFetch({ wz: { wizeApp_getBIReportQuery: { body: JSON.stringify([{ callstatusid: "1", callstatusname: "חדש" }]) } } }));
  r = await run(makeHandler(ENV, g), req({ action: "lookups" }));
  assert.equal(r.status, 504);
  assert.equal(r.body.error, "Supabase לא ענה בזמן");
});
