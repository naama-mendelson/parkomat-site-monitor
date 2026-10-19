// tests/multipliers-view.test.js — "רובוטיים" / "מכפילים" בלוח (19/10/2026; עד אז מתג "מכפילים גלויים", 18/10),
// ו"תקלות חוזרות" (19/10/2026).
const { test } = require("node:test");
const assert = require("node:assert/strict");

let m, r;
test.before(async () => {
  m = await import("../../dashboard/src/utils/multipliers.js");
  r = await import("../../dashboard/src/utils/repeatFaults.js");
});

const live = { code: "1399", monitored: true }, mx = { code: "MX-007", monitored: false }, legacy = { code: "1102" };

test("מכפיל = monitored === false בלבד; אתר ישן בלי השדה הוא רובוטי", () => {
  assert.equal(m.isMultiplierSite(mx), true);
  assert.equal(m.isMultiplierSite(live), false);
  assert.equal(m.isMultiplierSite(legacy), false);
  assert.equal(m.isMultiplierSite(null), false);
  assert.equal(m.countMultipliers([live, mx, legacy, mx]), 2);
  assert.equal(m.countMultipliers(undefined), 0);
  assert.equal(m.countRobotic([live, mx, legacy, mx]), 2);
  assert.equal(m.countRobotic(null), 0);
});

// בעלת המוצר: "אם לוחצים על מכפילים — רואים רק מכפילים; אם מסירים מכפילים — הרובוטיים חוזרים; אם לוחצים על רובוטיים
// ומכפילים קיים — מכפילים נעלמים ורק רובוטיים נשאר"
test("⚠️ רובוטיים — רק אתרים עם בקר; מכפילים — רק בלי בקר; אין מצב של שניהם", () => {
  assert.equal(m.DEFAULT_SITE_KIND, "robotic", "רובוטיים — אוטומטית");
  for (const s of [live, legacy]) {
    assert.equal(m.matchesSiteKind(s, "robotic"), true);
    assert.equal(m.matchesSiteKind(s, "multipliers"), false);
  }
  assert.equal(m.matchesSiteKind(mx, "multipliers"), true);
  assert.equal(m.matchesSiteKind(mx, "robotic"), false);
  assert.equal(m.matchesSiteKind(mx, undefined), false, "בלי בחירה = רובוטיים");
  assert.equal(m.matchesSiteKind(mx, true), false, "ערך של המתג הישן אינו מכפילים");
});

test("⚠️ לחיצות: מכפילים ← רק מכפילים; שוב מכפילים ← רובוטיים; רובוטיים ← תמיד רובוטיים", () => {
  assert.equal(m.nextSiteKind("robotic", "multipliers"), "multipliers");
  assert.equal(m.nextSiteKind("multipliers", "multipliers"), "robotic", "מסירים מכפילים — הרובוטיים חוזרים");
  assert.equal(m.nextSiteKind("multipliers", "robotic"), "robotic", "לוחצים על רובוטיים כשמכפילים פעיל");
  assert.equal(m.nextSiteKind("robotic", "robotic"), "robotic", "רובוטיים לא נכבה — תמיד אחד פעיל");
  assert.equal(m.nextSiteKind(undefined, "multipliers"), "multipliers");
  assert.equal(m.nextSiteKind("multipliers", "שבור"), "robotic");
});

test("מהאחסון: רק 'multipliers' מחליף; חסר, שבור או ערך של המתג הישן (true) — רובוטיים", () => {
  assert.equal(m.sanitizeSiteKind("multipliers"), "multipliers");
  for (const v of ["robotic", true, "true", false, undefined, null, 0, "", "x", {}]) assert.equal(m.sanitizeSiteKind(v), "robotic", String(v));
});

test("⚠️ תקלות חוזרות: לחוץ — רק אתרים עם הסימון (מערך לא ריק, כמו התג בכרטיס); לא לחוץ — הכול", () => {
  const withRf = { repeatFaults: [{ text: "מעלית - X", n: 5 }] }, empty = { repeatFaults: [] }, none = { repeatFaults: null }, noField = {};
  assert.equal(r.DEFAULT_SHOW_REPEAT, false);
  assert.equal(r.hasRepeatFaults(withRf), true);
  for (const s of [empty, none, noField, null]) assert.equal(r.hasRepeatFaults(s), false);
  for (const s of [withRf, empty, none, noField]) assert.equal(r.matchesRepeatView(s, false), true, "לא לחוץ — עובר");
  assert.equal(r.matchesRepeatView(withRf, true), true);
  for (const s of [empty, none, noField]) assert.equal(r.matchesRepeatView(s, true), false);
  assert.equal(r.countRepeatSites([withRf, empty, none, withRf]), 2);
  assert.equal(r.countRepeatSites(undefined), 0);
  assert.equal(r.sanitizeShowRepeat(true), true);
  assert.equal(r.sanitizeShowRepeat("true"), true);
  for (const v of [false, "false", undefined, null, 1, "x"]) assert.equal(r.sanitizeShowRepeat(v), false, String(v));
});

// בעלת המוצר, 19/10/2026: "קריאות פתוחות שים אותם בתור סינון נפרד, ושלוחצים על זה זה שם את הקריאות הפתוחות גם של
// המכפילים וגם של הרובוטיים"
test("⚠️ \"קריאות פתוחות\" לחוץ — הסוג אינו חל: שני הסוגים; לא לחוץ — בדיוק כמו matchesSiteKind", () => {
  for (const kind of ["robotic", "multipliers", undefined, "junk"]) {
    for (const s of [live, mx, legacy]) {
      assert.equal(m.matchesBoardKind(s, kind, true), true, `${s.code} / ${kind} / לחוץ`);
      assert.equal(m.matchesBoardKind(s, kind, false), m.matchesSiteKind(s, kind), `${s.code} / ${kind} / לא לחוץ`);
      assert.equal(m.matchesBoardKind(s, kind, undefined), m.matchesSiteKind(s, kind), "רק true מדליק");
      assert.equal(m.matchesBoardKind(s, kind, "true"), m.matchesSiteKind(s, kind), "מחרוזת אינה true");
    }
  }
});

// בעלת המוצר, 19/10/2026: "תקלות חוזרות — מיין לפי המתקן עם המספר תקלות חוזרות הגבוה ביותר"
test("⚠️ \"תקלות חוזרות\" לחוץ — הגבוה ביותר קודם; תיקו — הסדר הרגיל", () => {
  const mk = (code, ns) => ({ code, repeatFaults: ns === null ? null : ns.map((n) => ({ text: "t" + n, n })) });
  assert.equal(r.repeatTop(mk("a", [4, 14])), 14, "מקסימום, לא האיבר הראשון");
  assert.equal(r.repeatTop(mk("a", [])), 0);
  assert.equal(r.repeatTop(mk("a", null)), 0);
  assert.equal(r.repeatTop({}), 0);
  assert.equal(r.repeatTop(mk("a", ["7", "x"])), 7, "מחרוזת מספרית נקראת, זבל = 0");
  // הסדר הרגיל כאן: לפי קוד
  const byCode = (a, b) => a.code.localeCompare(b.code);
  const sites = [mk("1001", [6]), mk("1002", [20]), mk("1003", [6, 5]), mk("1004", [14]), mk("1000", [4])];
  const got = [...sites].sort(r.compareByRepeat(byCode)).map((s) => s.code);
  assert.deepEqual(got, ["1002", "1004", "1001", "1003", "1000"], "20, 14, ואז שני ה-6 לפי הסדר הרגיל, ואז 4");
  // אתר בלי סימון (לא אמור להיות בלוח כשלחוץ, אבל לא נשבר) — בסוף
  assert.deepEqual([mk("x", null), mk("y", [5])].sort(r.compareByRepeat(byCode)).map((s) => s.code), ["y", "x"]);
});
