// tests/service-calls-direct.test.js — מה שכבת הנתונים של קריאות ויזנט שולחת, ואיך היא מחכה לממסר (15/10/2026).
//
// serviceCallsDirect.js האמיתי, עם `./supabase` מדומה (כמו tasks-direct.test.js). אין כאן ממסר ולא מסד: כל קריאת
// RPC נרשמת, ומקבלת תשובה לפי השם — כך נבדק מה יוצא לרשת, ושהשאלות נעצרות כשהבקשה נסגרת.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../dashboard/src/services/serviceCallsDirect.js");
const UTILS = path.join(__dirname, "../../dashboard/src/utils/serviceCalls.js");

async function load() {
  let src = fs.readFileSync(SRC, "utf8");
  const stub = "data:text/javascript," + encodeURIComponent(
    "export const isSupabaseConfigured = true;" +
    "export const supabase = { rpc: (...a) => globalThis.__fake.rpc(...a) };");
  src = src.replace(`from "./supabase";`, `from ${JSON.stringify(stub)};`);
  src = src.replace(`from "../utils/serviceCalls";`, `from ${JSON.stringify(pathToFileURL(UTILS).href)};`);
  assert.doesNotMatch(src, /from "\.{1,2}\//, "נשאר ייבוא יחסי — serviceCallsDirect קיבל ייבוא חדש");
  assert.doesNotMatch(src, /functions\/v1|FUNCTIONS_URL/, "הדפדפן אינו פונה עוד לפונקציית ה-Edge");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sc-direct-")), "serviceCallsDirect.mjs");
  fs.writeFileSync(tmp, src);
  return import(pathToFileURL(tmp).href);
}

// answers: { [rpc]: value | (args, n) => value | Error }. n — מספר הקריאה לאותה פונקציה (מ-1)
function fake(answers) {
  const calls = [];
  const count = {};
  globalThis.__fake = {
    rpc(fn, args) {
      calls.push({ fn, body: JSON.stringify(args) });
      count[fn] = (count[fn] || 0) + 1;
      const a = answers[fn];
      const v = typeof a === "function" ? a(args, count[fn]) : a;
      if (v instanceof Error) return Promise.resolve({ data: null, error: { message: v.message, code: v.code } });
      if (v === "THROW") return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ data: v, error: null });
    },
  };
  return calls;
}
const noSleep = { sleep: () => Promise.resolve() };
const pendingThen = (final) => (args, n) => (n < 3 ? { id: args.p_id, state: n === 1 ? "pending" : "claimed" } : final);

test("שינוי: נכנס לתור עם מחרוזות, שואל עד שהבקשה נסגרת — ולא שאלה אחת יותר", async () => {
  const m = await load();
  const calls = fake({
    wizenet_request_update: 41,
    wizenet_request_status: pendingThen({ id: 41, state: "done", result: "עודכן בוויזנט" }),
  });
  assert.deepEqual(await m.updateServiceCall(774526, "status", 151, noSleep), { ok: true });
  assert.deepEqual(calls.map((c) => [c.fn, c.body]), [
    ["wizenet_request_update", JSON.stringify({ p_ticket: "774526", p_field: "status", p_value: "151" })],
    ["wizenet_request_status", '{"p_id":41}'], ["wizenet_request_status", '{"p_id":41}'], ["wizenet_request_status", '{"p_id":41}'],
  ]);
});

test("עודכן בוויזנט אבל לא נרשם אצלנו — אינו כשל, חוזר כאזהרה", async () => {
  const m = await load();
  fake({ wizenet_request_update: 7, wizenet_request_status: { id: 7, state: "done", result: "עודכן בוויזנט, אבל לא נרשם אצלנו" } });
  assert.deepEqual(await m.updateServiceCall("1", "type", "2", noSleep), { ok: true, warning: "עודכן בוויזנט, אבל לא נרשם אצלנו" });
});

test("כשל ופקיעה — נזרקים עם ההסבר מהמסד; סירוב בכניסה לתור — בלי לשאול אחריו", async () => {
  const m = await load();
  fake({ wizenet_request_update: 8, wizenet_request_status: { id: 8, state: "failed", result: "הקריאה לא נמצאה בוויזנט" } });
  await assert.rejects(m.updateServiceCall("1", "status", "1", noSleep), /הקריאה לא נמצאה בוויזנט/);
  fake({ wizenet_request_update: 9, wizenet_request_status: { id: 9, state: "expired", result: "לא נשלח לוויזנט — אף ממסר לא לקח" } });
  await assert.rejects(m.updateServiceCall("1", "status", "1", noSleep), /אף ממסר לא לקח/);
  const calls = fake({ wizenet_request_update: new Error("אין כרגע ממסר פעיל לוויזנט — השינוי לא נשלח") });
  await assert.rejects(m.updateServiceCall("1", "status", "1", noSleep), /אין כרגע ממסר פעיל/);
  assert.deepEqual(calls.map((c) => c.fn), ["wizenet_request_update"]);
});

test("⚠️ רשת הביטחון: בקשה שלא נסגרת — עוצרים בתקרה, ואומרים שלא ידוע (לא 'נשמר')", async () => {
  const m = await load();
  const calls = fake({ wizenet_request_update: 10, wizenet_request_status: { id: 10, state: "claimed" } });
  await assert.rejects(m.updateServiceCall("1", "status", "1", { ...noSleep, maxMs: -1 }), /לא ידוע אם השינוי נשמר/);
  assert.equal(calls.filter((c) => c.fn === "wizenet_request_status").length, 1);
});

test("⚠️ שאלה שנכשלה (רשת) אינה כשל של הבקשה — ממשיכים לשאול; רק 'לא נמצאה' סופית", async () => {
  const m = await load();
  // כשל רשת כ-error, ואחר כך כזריקה — ושתיהן ממשיכות; בפעם הרביעית הבקשה נסגרה
  let calls = fake({
    wizenet_request_update: 21,
    wizenet_request_status: (args, n) => n === 1 ? new Error("Failed to fetch") : n === 2 ? "THROW" : n === 3 ? { id: 21, state: "claimed" }
      : { id: 21, state: "done", result: "עודכן בוויזנט" },
  });
  assert.deepEqual(await m.updateServiceCall("1", "status", "1", noSleep), { ok: true });
  assert.equal(calls.filter((c) => c.fn === "wizenet_request_status").length, 4);
  // הבקשה נמחקה (או מספר שגוי) — אין מה לחכות לו
  calls = fake({ wizenet_request_update: 22, wizenet_request_status: Object.assign(new Error("הבקשה לא נמצאה"), { code: "PT404" }) });
  await assert.rejects(m.updateServiceCall("1", "status", "1", noSleep), /הבקשה לא נמצאה/);
  assert.equal(calls.filter((c) => c.fn === "wizenet_request_status").length, 1);
});

test("רענון רשימות: נכנס לתור, מחכה, ומחזיר את ההסבר מהמסד; כשל — נזרק", async () => {
  const m = await load();
  let calls = fake({ wizenet_request_lookups: 12, wizenet_request_status: pendingThen({ id: 12, state: "done", result: "נטענו 20 סטטוסים ו-11 סוגי קריאה" }) });
  assert.deepEqual(await m.refreshServiceCallLookups(noSleep), { result: "נטענו 20 סטטוסים ו-11 סוגי קריאה" });
  assert.deepEqual(calls[0], { fn: "wizenet_request_lookups", body: "{}" });
  calls = fake({ wizenet_request_lookups: 13, wizenet_request_status: { id: 13, state: "failed", result: "לא הצלחנו לקרוא את הרשימה מוויזנט" } });
  await assert.rejects(m.refreshServiceCallLookups(noSleep), /לא הצלחנו לקרוא/);
});

test("מצב הממסרים — כפי שהוא; תשובה ריקה — 0 חיים", async () => {
  const m = await load();
  fake({ wizenet_relays_status: { alive: 2, enabled: 3 } });
  assert.deepEqual(await m.fetchWizenetRelayStatus(), { alive: 2, enabled: 3 });
  fake({ wizenet_relays_status: null });
  assert.deepEqual(await m.fetchWizenetRelayStatus(), { alive: 0, enabled: 0 });
});
