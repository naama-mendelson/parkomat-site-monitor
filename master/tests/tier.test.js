// tests/tier.test.js — איזו דרגה מוצגת לאתר (dashboard/src/utils/tier.js).
//
// ⚠️ המקרה שהקובץ הזה קיים בשבילו הוא הרביעי: כשל בקריאה ל-site_uptime_service
// משאיר את הרשימה בלי שורה לאף אתר, ו"אין שורה" היה צובע את כל האתרים
// "לא חובר" בגלל תקלת רשת.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveTier } from "../../dashboard/src/utils/tier.js";
import { TIER_UNLINKED, TIER_LABELS, TIER_OPTIONS, TIER_COLORS, TIER_BOARD_STATES } from "../../dashboard/src/utils/constants.js";

test("שורה ברמזור קובעת את הדרגה — וגוברת על sites.tier", () => {
  assert.equal(effectiveTier({ agreement: "vip" }, false, "basic"), "vip");
  assert.equal(effectiveTier({ agreement: "basic" }, false, "extended"), "basic");
});

test("אוצר המילים של הלוח מתורגם: ext → extended, ורווחים/רישיות לא משנים", () => {
  assert.equal(effectiveTier({ agreement: "ext" }, false, "basic"), "extended");
  assert.equal(effectiveTier({ agreement: " VIP " }, false, "basic"), "vip");
});

test("אתר בלי שורה ברמזור הוא 'לא חובר' — לא 'בסיסי' של ברירת המחדל במסד", () => {
  assert.equal(effectiveTier(null, false, "basic"), TIER_UNLINKED);
  assert.equal(effectiveTier(undefined, false, "vip"), TIER_UNLINKED);
});

test("⚠️ כשל בקריאה אינו הופך אתר ל'לא חובר' — נשארים על הדרגה מהמסד", () => {
  assert.equal(effectiveTier(null, true, "basic"), "basic");
  assert.equal(effectiveTier(null, true, "vip"), "vip");
});

test("'להתייחס כ' ריק ו'במקור' מלא — התג לפי המסלול (שלפיו נמדד), לא ברירת המחדל במסד", () => {
  assert.equal(effectiveTier({ agreement: null, plan: "vip" }, false, "basic"), "vip");
  assert.equal(effectiveTier({ agreement: "  ", plan: "ext" }, false, "basic"), "extended");
});

test("השירות גובר על המסלול כששניהם מלאים (זלטופולסקי: נחתם בסיסי, מטופל VIP)", () => {
  assert.equal(effectiveTier({ agreement: "vip", plan: "basic" }, false, "basic"), "vip");
});

test("⚠️ 'לא בשירות' / 'תחזוקה בלבד' ברמזור — מוצגים כמו שהם, לעולם לא 'בסיסי'", () => {
  assert.equal(effectiveTier({ agreement: "no_service", plan: "no_service" }, false, "basic"), "no_service");
  assert.equal(effectiveTier({ agreement: "maintenance_only", plan: "vip" }, false, "basic"), "maintenance_only");
  assert.equal(effectiveTier({ agreement: null, plan: "none" }, false, "basic"), "none");
});

test("טקסט חופשי שאינו מוכר בשירות אינו עוצר את הנפילה למסלול", () => {
  assert.equal(effectiveTier({ agreement: "משהו אחר", plan: "vip" }, false, "basic"), "vip");
});

test("שורה ששני התאים בה אינם מוכרים — הדרגה מהמסד (מחובר, ולכן לא 'לא חובר')", () => {
  assert.equal(effectiveTier({ agreement: "xyz", plan: null }, false, "extended"), "extended");
});

test("'לא חובר' ומצבי הרמזור מוצגים בעברית — ואינם אפשרות בבוררים שבהם קובעים דרגה", () => {
  assert.equal(TIER_LABELS[TIER_UNLINKED], "לא חובר");
  assert.equal(TIER_LABELS.no_service, "לא בשירות");
  assert.equal(TIER_LABELS.maintenance_only, "תחזוקה בלבד");
  assert.equal(TIER_LABELS.none, "ללא הסכם");
  for (const t of [TIER_UNLINKED, ...TIER_BOARD_STATES]) {
    assert.ok(!TIER_OPTIONS.includes(t), `${t} אינו אפשרות לקביעת דרגה`);
    assert.ok(TIER_COLORS[t], `${t} יש לו צבע`);
  }
});
