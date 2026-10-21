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

test("רשימת רכבי השירות: fetchFleet קורא fleet_list; saveFleet שולח את כל הרשימה ואת מה שנראה; מסך ישן מסומן", async () => {
  const m = await load();
  let calls = fake({ vehicles: [{ plate: "8600001", nickname: "א 8600001", shown: true }], shown: ["8600001", "8600009"] });
  const fl = await m.fetchFleet();
  assert.equal(calls[0].fn, "fleet_list");
  assert.deepEqual(fl.shown, ["8600001", "8600009"]);
  assert.equal(fl.vehicles.length, 1);

  calls = fake({ changed: true, shown: ["8600001", "8600002"] });
  const r = await m.saveFleet(["8600001", "8600002"], ["8600001"]);
  assert.equal(calls[0].fn, "fleet_shown_set");
  assert.equal(calls[0].body, JSON.stringify({ p_plates: ["8600001", "8600002"], p_seen: ["8600001"] }));
  assert.equal(r.changed, true);
  // בלי seen — null במפורש (המפתח נשלח: PostgREST בוחר פונקציה לפי המפתחות)
  calls = fake({ changed: false, shown: [] });
  await m.saveFleet([]);
  assert.equal(calls[0].body, JSON.stringify({ p_plates: [], p_seen: null }));

  fake({ error: { code: "PT409", message: "רשימת הרכבים השתנתה בינתיים — יש לרענן ולנסות שוב" } });
  await assert.rejects(m.saveFleet(["8600001"], []), (e) => e.stale === true && /השתנתה/.test(e.message));
  fake({ error: { code: "PT404", message: "הרכב 9999999 לא נמצא באיתוראן" } });
  await assert.rejects(m.saveFleet(["9999999"], []), (e) => e.stale === false && /9999999/.test(e.message));
});
