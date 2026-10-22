// tests/technicians-direct.test.js — מה שכבת הנתונים של הטכנאים שולחת ל-PostgREST: המשימה הבאה (21/10/2026).
//
// ⚠️ PostgREST בוחר פונקציה לפי המפתחות בגוף הבקשה — מפתח שחסר הוא חתימה אחרת (404). לכן נבדק הגוף כמו שהוא יוצא לרשת,
// כולל ה-null-ים. techniciansDirect.js האמיתי, עם ./supabase מדומה (כמו tasks-direct.test.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../dashboard/src/services/techniciansDirect.js");

async function load() {
  let src = fs.readFileSync(SRC, "utf8");
  const stub = "data:text/javascript," + encodeURIComponent(
    "export const isSupabaseConfigured = true;" +
    "export const supabase = { rpc: (...a) => globalThis.__fake.rpc(...a), auth: { getSession: async () => ({ data: { session: null } }) } };");
  src = src.replace(`from "./supabase";`, `from ${JSON.stringify(stub)};`);
  assert.doesNotMatch(src, /from "\.{1,2}\//, "נשאר ייבוא יחסי — techniciansDirect קיבל ייבוא חדש");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "technicians-direct-")), "techniciansDirect.mjs");
  fs.writeFileSync(tmp, src);
  return import(pathToFileURL(tmp).href);
}

function fake(answer) {
  const calls = [];
  globalThis.__fake = {
    rpc(fn, args) {
      calls.push({ fn, body: JSON.stringify(args) });
      const r = typeof answer === "function" ? answer(fn, args) : answer;
      return { abortSignal: () => Promise.resolve(r?.error ? { data: null, error: r.error } : { data: r, error: null }) };
    },
  };
  return calls;
}

test("המשימה הבאה: queueNextTask שולח את כל המפתחות של tech_next_set (null במפורש); clearNextTask; לוח ישן מסומן", async () => {
  const m = await load();
  let calls = fake({ id: 7, rev: 4, changed: true, replaced: false });
  const r = await m.queueNextTask({ id: 7, siteCode: "1227", details: "להחליף נורה", clientId: "c-1", rev: 3 });
  assert.equal(calls[0].fn, "tech_next_set");
  assert.equal(calls[0].body, JSON.stringify({
    p_tech: 7, p_site_code: "1227", p_place: null, p_details: "להחליף נורה", p_ticket: null, p_client_id: "c-1", p_rev: 3,
  }));
  assert.equal(r.changed, true);
  // מקום שאינו אתר; בלי פרטים ובלי rev
  calls = fake({ changed: true });
  await m.queueNextTask({ id: 7, place: "המחסן", clientId: "c-2" });
  assert.equal(calls[0].body, JSON.stringify({
    p_tech: 7, p_site_code: null, p_place: "המחסן", p_details: null, p_ticket: null, p_client_id: "c-2", p_rev: null,
  }));

  calls = fake({ changed: true });
  await m.clearNextTask(7, 5);
  assert.equal(calls[0].fn, "tech_next_clear");
  assert.equal(calls[0].body, JSON.stringify({ p_tech: 7, p_rev: 5 }));
  calls = fake({ changed: false });
  await m.clearNextTask(7);
  assert.equal(calls[0].body, JSON.stringify({ p_tech: 7, p_rev: null }));

  fake({ error: { code: "PT409", message: "אין לטכנאי משימה פתוחה — אפשר לשלוח אותו ישר" } });
  await assert.rejects(m.queueNextTask({ id: 7, siteCode: "1227", clientId: "c-3" }),
    (e) => e.stale === true && /אין לטכנאי משימה פתוחה/.test(e.message));
});
