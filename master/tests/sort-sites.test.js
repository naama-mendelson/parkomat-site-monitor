// tests/sort-sites.test.js — סדר הדחיפות ברשת (dashboard/src/utils/sortSites.js).
//
// ⚠️ 07/10/2026: אתר בלי בקר מחובר נשאר במסד עם status='no_comm' (ברירת המחדל). בלי טיפול
// הוא היה מתמיין בין המנותקים האמיתיים — אתר שאין מה לעשות בו מעל אתרים שדורשים טיפול.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { compareSitesByPriority, makeCompareSites } = require(
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

// ============================================================
// ⚠️ קריאה פתוחה בוויזנט — הדרגה השנייה (14/10/2026)
// ============================================================
// בעלת המוצר: "המיון השני אחרי הראשון צריך להיות אם יש קריאה פתוחה".
const openOf = (map) => (site) => map[site.code] ?? 0;
const orderWith = (map, sites) => sites.slice().sort(makeCompareSites(openOf(map))).map((s) => s.code);

test("קריאה פתוחה מקדמת — אבל **רק בתוך אותו מצב**, לא מעליו", () => {
  // תקלה בלי קריאה עדיין לפני 'מוכן' עם קריאה: המצב הוא הדרגה הראשונה
  assert.deepEqual(orderWith({ ready: 3 }, [
    { code: "ready", status: "ready" },
    { code: "error", status: "error" },
  ]), ["error", "ready"]);
});

test("בתוך אותו מצב — מי שיש לו קריאה פתוחה קודם, גם אם הדרגה שלו נמוכה", () => {
  // ⚠️ זה בדיוק מה שהשינוי עושה: basic עם קריאה לפני vip בלי קריאה
  assert.deepEqual(orderWith({ b: 1 }, [
    { code: "v", status: "ready", tier: "vip", failureRate: 0 },
    { code: "b", status: "ready", tier: "basic", failureRate: 0 },
  ]), ["b", "v"]);
});

test("בינארי: שלוש קריאות אינן קודמות לאחת — הדרגה ואחוז הכשל ממשיכים להחליט", () => {
  assert.deepEqual(orderWith({ one: 1, three: 3 }, [
    { code: "three", status: "ready", tier: "basic", failureRate: 0 },
    { code: "one", status: "ready", tier: "vip", failureRate: 0 },
  ]), ["one", "three"]);
  // ובתוך אותה דרגה — אחוז הכשל
  assert.deepEqual(orderWith({ lo: 2, hi: 1 }, [
    { code: "lo", status: "ready", tier: "vip", failureRate: 1 },
    { code: "hi", status: "ready", tier: "vip", failureRate: 9 },
  ]), ["hi", "lo"]);
});

test("⚠️ בלי פונקציית קריאות (התכונה כבויה, או שהספירה עוד לא נטענה) — הסדר הקודם בדיוק", () => {
  const sites = [
    { code: "b", status: "ready", tier: "basic", failureRate: 9 },
    { code: "v", status: "ready", tier: "vip", failureRate: 0 },
    { code: "e", status: "error", tier: "basic", failureRate: 0 },
  ];
  const was = sites.slice().sort(compareSitesByPriority).map((s) => s.code);
  assert.deepEqual(was, ["e", "v", "b"]);
  assert.deepEqual(sites.slice().sort(makeCompareSites(null)).map((s) => s.code), was);
  assert.deepEqual(sites.slice().sort(makeCompareSites(() => 0)).map((s) => s.code), was);
});

test("אתר ללא בקר מחובר עם קריאה פתוחה — מיד אחרי התקלות; בלי קריאה — אחרון (15/10/2026)", () => {
  // בעלת המוצר: "הם תמיד יהיו בסוף המסך אלא אם כן יש קריאה, ואז הם נמצאים במיון אחרי התקלה".
  // ⚠️ עד 15/10 הכלל היה הפוך: "נשאר אחרון גם כשיש לו קריאה פתוחה".
  assert.deepEqual(orderWith({ shell: 2 }, [
    { code: "ready", status: "ready" },
    { code: "shell", status: "no_comm", monitored: false },
    { code: "maint", status: "maintenance" },
    { code: "nocomm", status: "no_comm" },
    { code: "err", status: "error" },
  ]), ["err", "shell", "maint", "nocomm", "ready"]);
  // תקלה עם קריאה ובלי — שתיהן לפני האתר ללא בקר: המצב קודם לקריאה
  assert.deepEqual(orderWith({ shell: 1, errc: 1 }, [
    { code: "shell", status: "no_comm", monitored: false },
    { code: "err", status: "error" },
    { code: "errc", status: "error" },
  ]), ["errc", "err", "shell"]);
  // בלי קריאה — אחרון, גם אחרי "מוכן"; ובלי פונקציית חיפוש — הסדר הישן
  assert.deepEqual(orderWith({ shell: 0 }, [
    { code: "shell", status: "no_comm", monitored: false },
    { code: "ready", status: "ready" },
  ]), ["ready", "shell"]);
  assert.deepEqual([{ code: "shell", status: "no_comm", monitored: false }, { code: "ready", status: "ready" }]
    .sort(makeCompareSites(null)).map((s) => s.code), ["ready", "shell"]);
});
