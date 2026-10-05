// tests/service-merge.test.js — כשל בשעות השירות: הערך האחרון הידוע (dashboard/src/utils/serviceMerge.js).
//
// ⚠️ נמדד בייצור (05/10/2026): site_uptime_service חוצה לפעמים את תקרת 8 השניות,
// ולדקה הדרגות נפלו ל"בסיסי" והזמינות ל-24/7. הבדיקות כאן מצמידות את הכלל.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keepLastService, SERVICE_FIELDS } from "../../dashboard/src/utils/serviceMerge.js";

const good = (code, over = {}) => ({
  code, status: "ready", tier: "vip", uptime: 99.1, failureRate: 2.5, serviceAgreement: "vip",
  servicePlan: "ext", serviceHours: 80, serviceOperations: 40, serviceErrors: 1, serviceStale: false, ...over,
});
// כך sitesDirect בונה אתר כשהקריאה נכשלה: ברירות מחדל + serviceStale
const failed = (code, over = {}) => ({
  code, status: "error", tier: "basic", uptime: 97.0, failureRate: 9.9, serviceAgreement: null,
  servicePlan: null, serviceHours: null, serviceOperations: null, serviceErrors: null, serviceStale: true, ...over,
});

test("בלי כשל — הרשימה החדשה כמו שהיא (אותו מערך)", () => {
  const next = [good("1"), good("2")];
  assert.equal(keepLastService([good("1")], next), next);
});

test("כשל — שדות השירות מהשליפה הקודמת, וכל השאר מהחדשה", () => {
  const out = keepLastService([good("1")], [failed("1")]);
  for (const f of SERVICE_FIELDS) assert.deepEqual(out[0][f], good("1")[f], f);
  assert.equal(out[0].status, "error", "המצב החי לא נדרס");
  assert.equal(out[0].serviceKept, true);
});

test("⚠️ כשלים רצופים — הערך שהועבר נשמר שוב, לא חוזרים ל'בסיסי' בכשל השני", () => {
  const first = keepLastService([good("1")], [failed("1")]);
  const second = keepLastService(first, [failed("1")]);
  assert.equal(second[0].tier, "vip");
  assert.equal(second[0].uptime, 99.1);
});

test("אין ערך ידוע (טעינה ראשונה שנכשלה, או אתר חדש) — ברירת המחדל נשארת", () => {
  assert.equal(keepLastService([], [failed("1")])[0].tier, "basic");
  assert.equal(keepLastService(null, [failed("1")])[0].tier, "basic");
  assert.equal(keepLastService([good("2")], [failed("1")])[0].tier, "basic");
  // כשל קודם בלי ערך שהועבר אינו "ערך ידוע". ⚠️ ברירת מחדל *שונה* בשליפה
  // הקודמת (הדרגה הידנית שונתה בינתיים) — אחרת העתקה בטעות לא הייתה נראית,
  // כי שתי ברירות המחדל זהות. מוטציה שהפכה את התנאי ל-false עברה ירוק כך.
  assert.equal(keepLastService([failed("1", { tier: "extended" })], [failed("1")])[0].tier, "basic");
});

test("שליפה תקינה אחרי כשל — הערכים החדשים, לא הישנים", () => {
  const kept = keepLastService([good("1")], [failed("1")]);
  const fresh = [good("1", { tier: "extended", uptime: 98 })];
  assert.equal(keepLastService(kept, fresh)[0].tier, "extended");
});

test("⚠️ כל שדה ש-sitesDirect גוזר מ-svc נמצא ב-SERVICE_FIELDS", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "../../dashboard/src/services/sitesDirect.js"), "utf8");
  // שורות בצורה `שדה: ...svc...` בתוך האובייקט שנבנה לכל אתר (svcRes אינו svc)
  const derived = new Set();
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s{6}(\w+):(.*)$/.exec(line);
    if (m && /\bsvc\b/.test(m[2])) derived.add(m[1]);
  }
  assert.ok(derived.size >= 6, `נמצאו רק ${derived.size} שדות — הסריקה עצמה שבורה`);
  for (const f of derived) assert.ok(SERVICE_FIELDS.includes(f), `${f} נגזר מ-svc ואינו ב-SERVICE_FIELDS`);
});
