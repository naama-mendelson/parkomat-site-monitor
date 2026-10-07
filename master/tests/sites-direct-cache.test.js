// tests/sites-direct-cache.test.js — הכרטיסים קוראים את הסטטיסטיקות מ-site_card_metrics.
//
// ⚠️ 07/10/2026: כל מסך הריץ בעצמו site_stats ×2, site_uptime, site_uptime_service (~12 שניות
// מסד לטעינה), וזה גמר את הקרדיטים של המעבד. עכשיו pg_cron מחשב פעם ב-10 דקות לטבלה,
// והמסך קורא שורה לכל אתר. הבדיקה מריצה את sitesDirect.js **האמיתי** — רק `./supabase`
// מוחלף בלקוח מדומה — ושואלת שני דברים: שאף אחת מארבע הפונקציות אינה נקראת מהמסך, ושכל
// עמודה בטבלה נוחתת על אותו שדה בכרטיס שעליו נחתה תשובת ה-RPC עד היום.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../dashboard/src/services/sitesDirect.js");

// sitesDirect.js עם `./supabase` מדומה, וייבוא יחסי → כתובת מוחלטת
async function load() {
  const dir = path.dirname(SRC);
  const abs = (rel, ext = "") => pathToFileURL(path.resolve(dir, rel + ext)).href;
  let src = fs.readFileSync(SRC, "utf8");
  const stub = "data:text/javascript," + encodeURIComponent(
    "export const isSupabaseConfigured = true;" +
    "export const supabase = { from: (...a) => globalThis.__fake.from(...a), rpc: (...a) => globalThis.__fake.rpc(...a) };");
  src = src
    .replace(`from "./supabase";`, `from ${JSON.stringify(stub)};`)
    .replace(`from "../../../shared/executive.mjs";`, `from ${JSON.stringify(abs("../../../shared/executive.mjs"))};`)
    .replace(`from "../../../shared/site-systems.mjs";`, `from ${JSON.stringify(abs("../../../shared/site-systems.mjs"))};`)
    .replace(`from "../utils/compliance";`, `from ${JSON.stringify(abs("../utils/compliance", ".js"))};`)
    .replace(`from "../utils/tier";`, `from ${JSON.stringify(abs("../utils/tier", ".js"))};`);
  assert.doesNotMatch(src, /from "\.{1,2}\//, "נשאר ייבוא יחסי — sitesDirect קיבל ייבוא חדש");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sites-direct-")), "sitesDirect.mjs");
  fs.writeFileSync(tmp, src);
  return import(pathToFileURL(tmp).href);
}

// לקוח מדומה: מה שנקרא, ומה שחוזר
function fake(over = {}) {
  const calls = [];
  const data = {
    sites: [
      { id: 1, code: "2438", site_name: "א", status: "ready", tier: "basic" },
      { id: 2, code: "1343", site_name: "ב", status: "error", tier: "basic" },
    ],
    site_card_metrics: [{
      site_id: 1, computed_at: "2026-10-07T09:30:00.000Z",
      stats: { site_id: 1, operations: 120, errors: 3, failure_rate: 2.5, avg_repair_minutes: 12.5,
               median_repair_minutes: 4, long_repair_count: 1, long_repair_percent: 33,
               quick_repair_count: 1, medium_repair_count: 1, repair_minutes: [1, 4, 70] },
      prev: { site_id: 1, operations: 100, failure_rate: 5 },
      uptime: { site_id: 1, availability_percent: 97.5, measured_hours: 168 },
      svc: { site_id: 1, agreement: "vip", plan: "vip", availability_percent: 99.1, measured_hours: 60,
             failure_rate: 1.2, operations: 80, errors: 1, service_hours: 60 },
    }],
    site_globals: [{ site_id: 1, last_fault_at: null }, { site_id: 2, last_fault_at: null }],
    site_compliance: [],
    ...over,
  };
  globalThis.__fake = {
    from(t) { return { select(cols) { calls.push(`from:${t}`); return Promise.resolve(data[t] instanceof Error ? { data: null, error: data[t] } : { data: data[t], error: null }); } }; },
    rpc(fn) { calls.push(`rpc:${fn}`); return Promise.resolve({ data: data[fn] ?? [], error: null }); },
  };
  return calls;
}

test("⚠️ טעינה עם סטטיסטיקות — טבלה אחת, ואף אחת מארבע הפונקציות", async () => {
  const { fetchSitesDirect } = await load();
  const calls = fake();
  await fetchSitesDirect("x", "y", "z", { withStats: true, withCompliance: true });
  assert.deepEqual(calls.sort(), ["from:site_card_metrics", "from:sites", "rpc:site_compliance", "rpc:site_globals"]);
  for (const fn of ["site_stats", "site_uptime", "site_uptime_service"]) {
    assert.ok(!calls.includes(`rpc:${fn}`), `${fn} נקראה מהמסך`);
  }
});

test("כל עמודה בטבלה נוחתת על השדה שלה בכרטיס", async () => {
  const { fetchSitesDirect } = await load();
  const { effectiveTier } = await import(pathToFileURL(path.join(__dirname, "../../dashboard/src/utils/tier.js")).href);
  fake();
  const [a] = await fetchSitesDirect("x", "y", "z", { withStats: true });
  assert.equal(a.statsSkipped, false);
  assert.equal(a.statsAt, Date.parse("2026-10-07T09:30:00.000Z"), "statsAt הוא computed_at, לא שעון המסך");
  assert.equal(a.operations, 120);
  assert.equal(a.errors, 3);
  assert.equal(a.avgRepairMinutes, 12.5);
  assert.deepEqual(a.repairSeries, [1, 4, 70]);
  // אתר שחובר ברמזור — הזמינות ואחוז הכשל של שעות השירות, והדרגה מההסכם
  assert.equal(a.uptime, 99.1);
  assert.equal(a.failureRate, 1.2);
  assert.equal(a.serviceOperations, 80);
  assert.equal(a.tier, effectiveTier({ agreement: "vip", plan: "vip" }, false, "basic"));
  assert.notEqual(a.tier, effectiveTier(null, false, "basic"), "הדרגה נפלה ל'לא חובר'");
  // המגמה מהתקופה הקודמת — 5% → 2.5%
  assert.ok(a.trend && a.trend.direction, JSON.stringify(a.trend));
  assert.equal(a.trend.previous, 5);
});

test("אתר בלי שורה בטבלה (חדש, לפני ה-cron) — ברירת מחדל, ו-statsAt ריק", async () => {
  const { fetchSitesDirect } = await load();
  fake();
  const [, b] = await fetchSitesDirect("x", "y", "z", { withStats: true });
  assert.equal(b.operations, 0);
  assert.equal(b.uptime, null, "זמינות '—' ולא 0%");
  assert.equal(b.statsAt, null);
});

test("טעינה חיה — הטבלה אינה נקראת כלל", async () => {
  const { fetchSitesDirect } = await load();
  const calls = fake();
  const [a] = await fetchSitesDirect("x", "y", "z", { withStats: false, withCompliance: false });
  assert.ok(!calls.includes("from:site_card_metrics"));
  assert.equal(a.statsSkipped, true);
});

test("⚠️ כשל בקריאת הטבלה — שגיאה גלויה, לא '0 פעולות' שקט", async () => {
  const { fetchSitesDirect } = await load();
  fake({ site_card_metrics: Object.assign(new Error("relation does not exist"), { code: "42P01" }) });
  await assert.rejects(fetchSitesDirect("x", "y", "z", { withStats: true }), /relation does not exist/);
});
