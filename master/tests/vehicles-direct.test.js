// tests/vehicles-direct.test.js — מה שכבת הנתונים של הרכבים מעבירה למסך, ומה היא שולחת ל-PostgREST (21/10/2026).
//
// ⚠️ נכתבה אחרי שנמצא ש-fetchVehicles לא העבירה את alerts: הפס "צריכים טכנאי עכשיו" לא הופיע בייצור בכלל, והבדיקות
// בדפדפן לא ראו — הרתמה מחליפה את השכבה הזו במוק שמחזיר alerts ישירות. כאן vehiclesDirect.js האמיתי, עם ./supabase מדומה
// (כמו tasks-direct.test.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../dashboard/src/services/vehiclesDirect.js");

async function load() {
  let src = fs.readFileSync(SRC, "utf8");
  const stub = "data:text/javascript," + encodeURIComponent(
    "export const isSupabaseConfigured = true;" +
    "export const supabase = { rpc: (...a) => globalThis.__fake.rpc(...a) };");
  src = src.replace(`from "./supabase";`, `from ${JSON.stringify(stub)};`);
  assert.doesNotMatch(src, /from "\.{1,2}\//, "נשאר ייבוא יחסי — vehiclesDirect קיבל ייבוא חדש");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vehicles-direct-")), "vehiclesDirect.mjs");
  fs.writeFileSync(tmp, src);
  return import(pathToFileURL(tmp).href);
}

function fake(answer) {
  const calls = [];
  globalThis.__fake = {
    rpc(fn, args) {
      calls.push({ fn, args, body: JSON.stringify(args ?? null) });
      const r = typeof answer === "function" ? answer(fn, args) : answer;
      return Promise.resolve(r.error ? { data: null, error: r.error } : { data: r, error: null });
    },
  };
  return calls;
}

test("fetchVehicles מעביר את 'צריכים טכנאי עכשיו' (alerts) — ובמסד ישן בלי השדה, undefined", async () => {
  const m = await load();
  const alerts = [{ code: "1227", fault: true, calls: 0, on_site: [], nearest: [{ plate: "8600001", m: 120 }] }];
  fake({ vehicles: [{ plate: "8600001" }], alerts, sync: { last_ok_at: "2026-10-21T12:00:00Z" }, now: "2026-10-21T12:00:30Z" });
  const r = await m.fetchVehicles();
  assert.deepEqual(r.alerts, alerts, "הפס מגיע למסך");
  assert.deepEqual(r.vehicles, [{ plate: "8600001" }]);
  assert.equal(r.now, "2026-10-21T12:00:30Z");
  fake({ vehicles: [], sync: null, now: "2026-10-21T12:00:30Z" });
  assert.equal((await m.fetchVehicles()).alerts, undefined, "מסד ישן — בלי הפס, לא שגיאה");
  fake({ error: { message: "boom" } });
  await assert.rejects(m.fetchVehicles(), /boom/);
});

test("ניהול הטכנאים: tech_roster / tech_roster_set / tech_roster_remove — מה נשלח ומה חוזר", async () => {
  const m = await load();
  let calls = fake({ techs: [{ plate: "8600001", name: "דני" }], available: [{ plate: "8600002" }] });
  const r = await m.fetchRoster();
  assert.equal(calls[0].fn, "tech_roster");
  assert.deepEqual([r.techs.length, r.available.length], [1, 1]);
  fake({});
  assert.deepEqual(await m.fetchRoster(), { techs: [], available: [] }, "תשובה בלי השדות — רשימות ריקות");

  calls = fake({ tech_id: 7, changed: true, created: true });
  assert.equal((await m.saveRosterTech("8600002", "יוסי לוי")).tech_id, 7);
  assert.equal(calls[0].fn, "tech_roster_set");
  assert.equal(calls[0].body, JSON.stringify({ p_plate: "8600002", p_name: "יוסי לוי" }));
  calls = fake({ changed: true, tech_id: 7 });
  await m.removeRosterTech("8600002");
  assert.equal(calls[0].fn, "tech_roster_remove");
  assert.equal(calls[0].body, JSON.stringify({ p_plate: "8600002" }));
  fake({ error: { code: "PT409", message: "יש לטכנאי משימה פתוחה — לסיים או לבטל אותה קודם" } });
  await assert.rejects(m.removeRosterTech("8600001"), /משימה פתוחה/);
  fake({ error: { code: "42501", message: "רק מנהל" } });
  await assert.rejects(m.saveRosterTech("8600001", "x"), /רק מנהל/);
});

test("דוח הטכנאים: tech_stats / tech_history / site_visit_stats — הטווח נשלח כמו שהוא; שדות חסרים — רשימות ריקות", async () => {
  const m = await load();
  let calls = fake({ from: "2026-10-16", to: "2026-10-22", team: { km: 5 }, techs: [{ plate: "8600001" }] });
  const s = await m.fetchTechStats("2026-10-16", "2026-10-22");
  assert.equal(calls[0].fn, "tech_stats");
  assert.equal(calls[0].body, JSON.stringify({ p_from: "2026-10-16", p_to: "2026-10-22" }));
  assert.deepEqual([s.team.km, s.techs.length], [5, 1]);
  fake({ from: "x" });
  assert.deepEqual((await m.fetchTechStats("a", "b")).techs, []);

  calls = fake({ plate: "8600001", days: [{ day: "2026-10-22" }] });
  const h = await m.fetchTechHistory("8600001", "2026-10-01", "2026-10-22");
  assert.equal(calls[0].fn, "tech_history");
  assert.equal(calls[0].body, JSON.stringify({ p_plate: "8600001", p_from: "2026-10-01", p_to: "2026-10-22" }));
  assert.deepEqual([h.days.length, h.visits, h.sites], [1, [], []]);

  calls = fake([{ code: "1227", visits: 3 }]);
  assert.equal((await m.fetchSiteVisitStats("2026-10-01", "2026-10-22")).length, 1);
  assert.equal(calls[0].fn, "site_visit_stats");
  fake({ error: { message: "טווח תאריכים לא תקין (עד 400 יום)" } });
  await assert.rejects(m.fetchSiteVisitStats("2026-10-22", "2026-10-01"), /טווח/);
  await assert.rejects(m.fetchTechStats("2026-10-22", "2026-10-01"), /טווח/);
});
