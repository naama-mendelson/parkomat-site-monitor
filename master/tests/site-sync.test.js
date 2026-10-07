// tests/site-sync.test.js — הבדיקה הזולה של כל דקה (dashboard/src/utils/siteSync.js).
//
// ⚠️ 07/10/2026: כל מסך פתוח הריץ את כל הסטטיסטיקות של כל האתרים בכל דקה, וזה הפיל את
// השרת. מאז — טעינה מלאה פעם ב-5 דקות, ובכל דקה רק השוואה של מצבי האתרים. ההשוואה
// הזו היא רשת הביטחון של הסטטוס: אם היא אומרת "תואם" כשאינו — המסך משקר עד 5 דקות.
//
// ⚠️ ובאותו יום, בהמשך: הסטטיסטיקות (פעולות, זמינות, מגמה) — רק בכניסה לדף. הטעינה
// של כל 5 דקות היא חיה בלבד, ושדות הסטטיסטיקה נשמרים בה מהרשימה שעל המסך
// (keepLastStats). אם השמירה נכשלת — כל כרטיס מציג "0 פעולות" כל 5 דקות.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  statusesMatch, fullReloadDue, FULL_RELOAD_EVERY_MS, STATUS_CHECK_EVERY_MS,
  statsDueOnReturn, STATS_ON_RETURN_MIN_MS, STATS_FIELDS, keepLastStats, statsMissing,
} from "../../dashboard/src/utils/siteSync.js";

const screen = () => [
  { id: 1, code: "2438", status: "ready", inMaintenance: false },
  { id: 2, code: "1343", status: "error", inMaintenance: false },
  { id: 3, code: "1001", status: "maintenance", inMaintenance: true },
];
const db = () => [
  { id: 1, code: "2438", status: "ready" },
  { id: 2, code: "1343", status: "error" },
  { id: 3, code: "1001", status: "ready" },          // בחלון תחזוקה — המסך מציג "בתחזוקה" בכל מקרה
];

test("תואם → אין טעינה מלאה", () => {
  assert.equal(statusesMatch(screen(), db()), true);
});

test("⚠️ מצב שהשתנה בלי שהגיעה הודעה (ערוץ חי שמת בשקט) → טעינה מלאה", () => {
  const d = db(); d[0].status = "error";
  assert.equal(statusesMatch(screen(), d), false);
});

test("אתר בחלון תחזוקה — לא משווים את המצב שלו (סוף החלון נתפס בטעינה המלאה)", () => {
  const d = db(); d[2].status = "no_comm";
  assert.equal(statusesMatch(screen(), d), true);
});

test("אתר שנוסף, נמחק או שינה קוד → טעינה מלאה", () => {
  assert.equal(statusesMatch(screen(), [...db(), { id: 4, code: "9999", status: "ready" }]), false, "נוסף");
  assert.equal(statusesMatch(screen(), db().slice(0, 2)), false, "נמחק");
  const d = db(); d[1].code = "1344";
  assert.equal(statusesMatch(screen(), d), false, "שינה קוד");
  const e = db(); e[1].id = 99;
  assert.equal(statusesMatch(screen(), e), false, "id אחר");
});

test("אין בדיקה זולה (מצב שרת, null) → לא מכריעים כאן; רשימה ריקה מול מסד מלא → טעינה", () => {
  assert.equal(statusesMatch(screen(), null), true);
  assert.equal(statusesMatch([], db()), false);
});

test("⚠️ הקצב שנבחר: טעינה מלאה כל 5 דקות, בדיקה זולה כל דקה", () => {
  assert.equal(FULL_RELOAD_EVERY_MS, 5 * 60_000);
  assert.equal(STATUS_CHECK_EVERY_MS, 60_000);
});

test("⚠️ הטעינה המלאה בדקה החמישית — לא בשישית (מרווח של חצי בדיקה)", () => {
  const MIN = 60_000;
  assert.equal(fullReloadDue(0, 4 * MIN), false, "ארבע דקות — עוד לא");
  assert.equal(fullReloadDue(0, 5 * MIN - 20), true, "הבדיקה של הדקה החמישית, 20ms לפני — כבר כן");
  assert.equal(fullReloadDue(0, 4.5 * MIN), true);
  assert.equal(fullReloadDue(0, 4.5 * MIN - 1), false);
});

// ============================================================
// הסטטיסטיקות — רק בכניסה לדף
// ============================================================
const MIN = 60_000;

test("חזרה ללשונית: סטטיסטיקות רק אם החישוב הקודם בן 5 דקות לפחות", () => {
  assert.equal(STATS_ON_RETURN_MIN_MS, 5 * MIN);
  assert.equal(statsDueOnReturn(0, 5 * MIN - 1), false, "4:59 — לא");
  assert.equal(statsDueOnReturn(0, 5 * MIN), true, "5:00 — כן");
});

// שורה מטעינה עם סטטיסטיקות, ושורה מטעינה חיה (ברירות המחדל של sitesDirect)
const withStats = (over = {}) => ({
  id: 7, code: "2438", site_name: "מגדל 1", status: "ready", statsSkipped: false, statsAt: 1000,
  tier: "vip", failureRate: 4.2, serviceOperations: 90, serviceErrors: 4, operations: 120, errors: 5,
  avgRepairMinutes: 12, medianRepairMinutes: 3, longRepairCount: 1, longRepairPercent: 20,
  quickRepairCount: 3, mediumRepairCount: 1, repairSeries: [1, 2, 3], uptime: 97.5,
  serviceAgreement: "vip", servicePlan: "vip", serviceHours: 100, serviceStale: false, serviceKept: undefined,
  trend: { direction: "up" }, ...over,
});
const live = (over = {}) => ({
  id: 7, code: "2438", site_name: "מגדל 1", status: "error", statsSkipped: true, statsAt: null,
  tier: "unconnected", failureRate: 0, serviceOperations: null, serviceErrors: null, operations: 0, errors: 0,
  avgRepairMinutes: null, medianRepairMinutes: null, longRepairCount: null, longRepairPercent: null,
  quickRepairCount: null, mediumRepairCount: null, repairSeries: null, uptime: null,
  serviceAgreement: null, servicePlan: null, serviceHours: null, serviceStale: false,
  trend: null, ...over,
});

test("⚠️ טעינה חיה שומרת את כל שדות הסטטיסטיקה מהמסך — והחי מתעדכן", () => {
  const [out] = keepLastStats([withStats()], [live()]);
  for (const f of STATS_FIELDS) assert.deepEqual(out[f], withStats()[f], f);
  assert.equal(out.status, "error", "המצב מהטעינה החיה, לא מהמסך");
});

test("טעינה עם סטטיסטיקות — נשארת כמות שהיא", () => {
  const next = [withStats({ operations: 999 })];
  assert.equal(keepLastStats([withStats()], next), next);
});

test("אתר חדש, או כזה שעוד לא חושבו לו — ברירת המחדל נשארת (ו-useSites מבקש חישוב)", () => {
  assert.equal(keepLastStats([], [live()])[0].operations, 0);
  assert.equal(keepLastStats([live()], [live()])[0].operations, 0, "גם המסך עצמו בלי statsAt");
  assert.equal(statsMissing([live()], new Set([7])), false);
  assert.equal(statsMissing([live(), live({ id: 8, code: "9999" })], new Set([7])), true);
});

test("⚠️ שתי טעינות חיות ברצף — הערכים עדיין מהחישוב (לא נשחקים לברירת מחדל)", () => {
  const once = keepLastStats([withStats()], [live()]);
  const twice = keepLastStats(once, [live({ status: "ready" })]);
  assert.equal(twice[0].operations, 120);
  assert.equal(twice[0].statsAt, 1000);
});

test("⚠️ כל שדה ש-sitesDirect גוזר מהסטטיסטיקות נמצא ב-STATS_FIELDS", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "../../dashboard/src/services/sitesDirect.js"), "utf8")
    .replace(/\r\n/g, "\n");   // checkout עם CRLF — אחרת indexOf לא מוצא והסריקה ריקה
  // האובייקט שנבנה לכל אתר: שדה בהזחה של 6, והביטוי שלו עד השדה הבא (גם רב-שורתי — trend)
  const body = src.slice(src.indexOf("return {\n      ...site,"), src.indexOf("\n    };", src.indexOf("return {\n      ...site,")));
  assert.ok(body.length > 0, "האובייקט לא נמצא — הסריקה עצמה שבורה");
  const exprs = new Map();
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s{6}(\w+):(.*)$/.exec(line);
    if (m) { cur = m[1]; exprs.set(cur, m[2]); continue; }
    if (cur && /^\s{7,}\S/.test(line)) exprs.set(cur, exprs.get(cur) + " " + line);
  }
  const derived = [...exprs].filter(([f, e]) =>
    f !== "statsSkipped" && /\b(st|up|svc|svcRes|prevById|statsAt)\b/.test(e.replace(/\/\/.*$/gm, ""))
  ).map(([f]) => f);
  assert.ok(derived.length >= 15, `נמצאו רק ${derived.length} שדות — הסריקה עצמה שבורה`);
  for (const f of derived) assert.ok(STATS_FIELDS.includes(f), `${f} נגזר מהסטטיסטיקות ואינו ב-STATS_FIELDS`);
});
