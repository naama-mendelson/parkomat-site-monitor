// tests/tasks-direct.test.js — מה שכבת הנתונים של המשימות שולחת ל-PostgREST.
//
// ⚠️ משימה בלי סוג (נפתחה ב-12/10/2026, בשעות שלא הייתה בחירה — או מקורא שלא העביר סוג): addTask חייב
// לשלוח p_kind: null **במפורש**. ל-task_add אין ברירת מחדל ל-p_kind, ו-PostgREST בוחר פונקציה לפי המפתחות בגוף הבקשה — מפתח שחסר הוא חתימה אחרת,
// כלומר 404 (PGRST202) על כל הוספה. undefined נעלם ב-JSON.stringify, ולכן הבדיקה היא על הגוף
// כפי שהוא נשלח, לא על האובייקט.
// tasksDirect.js האמיתי, עם `./supabase` מדומה (כמו register-site-unmonitored.test.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../dashboard/src/services/tasksDirect.js");
const UTILS = path.join(__dirname, "../../dashboard/src/utils/tasks.js");

async function load() {
  let src = fs.readFileSync(SRC, "utf8");
  const stub = "data:text/javascript," + encodeURIComponent(
    "export const isSupabaseConfigured = true;" +
    "export const supabase = { rpc: (...a) => globalThis.__fake.rpc(...a) };");
  src = src.replace(`from "./supabase";`, `from ${JSON.stringify(stub)};`);
  src = src.replace(`from "../utils/tasks";`, `from ${JSON.stringify(pathToFileURL(UTILS).href)};`);
  assert.doesNotMatch(src, /from "\.{1,2}\//, "נשאר ייבוא יחסי — tasksDirect קיבל ייבוא חדש");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tasks-direct-")), "tasksDirect.mjs");
  fs.writeFileSync(tmp, src);
  return import(pathToFileURL(tmp).href);
}

function fake(data) {
  const calls = [];
  globalThis.__fake = {
    // supabase.rpc(name, args).abortSignal(signal) → { data, error }; הגוף נרשם כמו שהוא יוצא לרשת
    rpc(fn, args) {
      calls.push({ fn, args, body: JSON.stringify(args) });
      return { abortSignal: () => Promise.resolve({ data: typeof data === "function" ? data(fn) : data, error: null }) };
    },
  };
  return calls;
}

test("addTask בלי סוג: p_kind: null נשלח במפורש בגוף הבקשה", async () => {
  const m = await load();
  const calls = fake(41);
  const id = await m.addTask({ body: "לגרז שרשרת", siteCode: "2438", clientId: "c-1" });
  assert.equal(id, 41);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "task_add");
  assert.deepEqual(JSON.parse(calls[0].body),
    { p_kind: null, p_body: "לגרז שרשרת", p_site_code: "2438", p_client_id: "c-1" },
    "ארבעת המפתחות של task_add — p_kind כ-null, לא חסר");
  // ⚠️ גם kind: undefined מפורש (קורא שמעביר הלאה שדה ריק) — עדיין null בגוף
  await m.addTask({ kind: undefined, body: "x2", siteCode: "2438", clientId: "c-2" });
  assert.match(calls[1].body, /"p_kind":null/);
});

test("addTask עם סוג — כל אחד משלושת הסוגים עובר כמו שהוא (גם מוקד)", async () => {
  const m = await load();
  const { TASK_KINDS } = await import(pathToFileURL(UTILS).href);
  const calls = fake(7);
  for (const kind of TASK_KINDS) await m.addTask({ kind, body: "להתקשר ללקוח", siteCode: "1001", clientId: `c-${kind}` });
  assert.deepEqual(calls.map((c) => JSON.parse(c.body).p_kind), ["customer", "technical", "call_center"]);
});

test("fetchTaskCounts: שורה בלי סוג נספרת בכפתור", async () => {
  const m = await load();
  fake([{ kind: null, site_id: 5, open: 2 }, { kind: "technical", site_id: 5, open: 1 }, { kind: null, site_id: null, open: 9 }]);
  assert.deepEqual(await m.fetchTaskCounts(), { bySite: { 5: { open: 3 } } });
});

test("הסוגים — עותק אחד בדשבורד (utils/tasks.js), לא שני בשכבת הנתונים", async () => {
  // ⚠️ עד 12/10/2026 בבוקר TASK_KINDS ישב כאן. עותק שני היה יכול לסטות מזה שהבורר בונה ממנו, ו-T19
  // ב-tasks.test.js משווה ל-SQL רק את utils/tasks.js
  const m = await load();
  assert.equal(m.TASK_KINDS, undefined);
  assert.equal(m.TASK_KIND_LABEL, undefined);
});
