// tests/register-site-unmonitored.test.js — רישום אתר בלי בקר מחובר (07/10/2026).
//
// אתר כזה (מתקני סוטפין) קיים בשביל הבודק, התחזוקה והמשימות בלבד. אין בו מחשב, ולכן:
//   • register_site מקבל p_monitored=false — ורק אז (רישום רגיל אינו שולח את המפתח, כדי
//     שלא יהיה תלוי בכך שהמסד כבר מכיר אותו).
//   • אין הנפקת זהות סוכן: זהות שנוצרת לחינם הייתה נראית ב"זהויות האתרים" כסוכן
//     שמעולם לא התחבר — בדיוק מה שמחפשים שם כתקלה.
// sitesWriteDirect.js האמיתי, עם `./supabase` מדומה.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../dashboard/src/services/sitesWriteDirect.js");

async function load() {
  let src = fs.readFileSync(SRC, "utf8");
  const stub = "data:text/javascript," + encodeURIComponent(
    "export const isSupabaseConfigured = true;" +
    "export const supabase = { rpc: (...a) => globalThis.__fake.rpc(...a), from: (...a) => globalThis.__fake.from(...a)," +
    " auth: { getSession: (...a) => globalThis.__fake.getSession(...a) } };");
  src = src.replace(`from "./supabase";`, `from ${JSON.stringify(stub)};`);
  assert.doesNotMatch(src, /from "\.{1,2}\//, "נשאר ייבוא יחסי — sitesWriteDirect קיבל ייבוא חדש");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sites-write-")), "sitesWriteDirect.mjs");
  fs.writeFileSync(tmp, src);
  return import(pathToFileURL(tmp).href);
}

function fake() {
  const calls = { rpc: [], session: 0 };
  globalThis.__fake = {
    rpc(fn, args) { calls.rpc.push({ fn, args }); return Promise.resolve({ data: [{ id: 77, code: args.p_code, site_name: args.p_site_name }], error: null }); },
    from() { throw new Error("לא צפוי"); },
    // ⚠️ הנפקת הזהות מתחילה כאן — ספירת הקריאות היא "האם ניסו להנפיק"
    getSession() { calls.session++; return Promise.resolve({ data: { session: null } }); },
  };
  return calls;
}

test("⚠️ אתר ללא בקר: p_monitored=false נשלח, ואין שום ניסיון להנפיק זהות סוכן", async () => {
  const { registerSiteDirect } = await load();
  const calls = fake();
  const res = await registerSiteDirect({ code: "9001", site_name: "קפלן 8", control_system: "סוטפין", monitored: false });
  assert.equal(calls.rpc.length, 1);
  assert.equal(calls.rpc[0].fn, "register_site");
  assert.equal(calls.rpc[0].args.p_monitored, false);
  assert.equal(calls.session, 0, "ניסו להנפיק זהות לאתר בלי מחשב");
  assert.deepEqual([res.ok, res.agent, res.agentError], [true, null, null]);
});

test("רישום רגיל: בלי המפתח p_monitored, והזהות כן מונפקת (כאן — נכשלת בלי שרת, ומדווחת)", async () => {
  const { registerSiteDirect } = await load();
  const calls = fake();
  const res = await registerSiteDirect({ code: "1500", site_name: "אתר מחובר" });
  assert.ok(!("p_monitored" in calls.rpc[0].args), "רישום רגיל שולח מפתח שהמסד אולי עוד לא מכיר");
  assert.equal(calls.session, 1, "לא ניסו להנפיק זהות לאתר מחובר");
  assert.ok(res.agentError, "כישלון ההנפקה מדווח ואינו מבטל את הרישום");
});
