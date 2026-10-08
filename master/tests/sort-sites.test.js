// tests/sort-sites.test.js — סדר הדחיפות ברשת (dashboard/src/utils/sortSites.js).
//
// ⚠️ 07/10/2026: אתר בלי בקר מחובר נשאר במסד עם status='no_comm' (ברירת המחדל). בלי טיפול
// הוא היה מתמיין בין המנותקים האמיתיים — אתר שאין מה לעשות בו מעל אתרים שדורשים טיפול.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { compareSitesByPriority } = require(
  path.join(__dirname, "..", "..", "dashboard", "src", "utils", "sortSites.js"));

const order = (sites) => sites.slice().sort(compareSitesByPriority).map((s) => s.code);

test("תקלה, תחזוקה, נתק, בפעולה, מוכן — ואתר ללא בקר אחרון, גם אחרי 'מוכן'", () => {
  assert.deepEqual(order([
    { code: "shell", status: "no_comm", monitored: false },
    { code: "ready", status: "ready" },
    { code: "nocomm", status: "no_comm" },
    { code: "error", status: "error" },
    { code: "maint", status: "maintenance" },
    { code: "op", status: "operating" },
  ]), ["error", "maint", "nocomm", "op", "ready", "shell"]);
});

test("⚠️ ה-'no_comm' של אתר ללא בקר אינו מקדם אותו מעל אתר מנותק אמיתי", () => {
  assert.deepEqual(order([{ code: "shell", status: "no_comm", monitored: false }, { code: "real", status: "no_comm" }]),
    ["real", "shell"]);
});

test("monitored חסר (שורה מלפני 07/10/2026) — אתר רגיל לכל דבר", () => {
  assert.deepEqual(order([{ code: "ready", status: "ready" }, { code: "old", status: "no_comm" }]), ["old", "ready"]);
});
