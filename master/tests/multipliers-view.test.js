// tests/multipliers-view.test.js — מתג "מכפילים מוצגים / מוסתרים" בלוח (18/10/2026).
const { test } = require("node:test");
const assert = require("node:assert/strict");

let m;
test.before(async () => { m = await import("../../dashboard/src/utils/multipliers.js"); });

const live = { code: "1399", monitored: true }, mx = { code: "MX-007", monitored: false }, legacy = { code: "1102" };

test("מכפיל = monitored === false בלבד; אתר ישן בלי השדה הוא אתר חי", () => {
  assert.equal(m.isMultiplierSite(mx), true);
  assert.equal(m.isMultiplierSite(live), false);
  assert.equal(m.isMultiplierSite(legacy), false);
  assert.equal(m.isMultiplierSite(null), false);
  assert.equal(m.countMultipliers([live, mx, legacy, mx]), 2);
  assert.equal(m.countMultipliers(undefined), 0);
});

test("מוצגים — הכול עובר; מוסתרים — רק אתרים עם בקר", () => {
  for (const s of [live, mx, legacy]) assert.equal(m.matchesMultipliersView(s, true), true);
  assert.equal(m.matchesMultipliersView(mx, false), false);
  assert.equal(m.matchesMultipliersView(live, false), true);
  assert.equal(m.matchesMultipliersView(legacy, false), true);
  assert.equal(m.matchesMultipliersView(mx, undefined), false, "בלי בחירה = מוסתרים (ברירת המחדל)");
  assert.equal(m.DEFAULT_SHOW_MULTIPLIERS, false);
});

test("מהאחסון: רק true (או 'true') מציג; חסר, שבור או false — מוסתרים", () => {
  assert.equal(m.sanitizeShowMultipliers(true), true);
  assert.equal(m.sanitizeShowMultipliers("true"), true);
  for (const v of [false, "false", undefined, null, 0, "", "x", {}]) assert.equal(m.sanitizeShowMultipliers(v), false, String(v));
});
