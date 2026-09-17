// tests/supervisor-shape.test.js — מסך המפקח: אותו מצב מוצג כמו ברשימת האתרים.
//
// ============================================================
// ⚠️ הבאג שנתפס כאן
// ============================================================
// `toSupervisorShape` חישב `displayStatus: worstOfSystems(g.systems) ?? status`
// — כלומר המערכות **החליפו** את מצב האתר. זה בדיוק הכלל ש-`displayStatusFor`
// נכתב כדי לבטל, ועם הנימוק המלא שם: פירוט ישן `[מוכן, תחזוקה]` הסתיר תקלה
// חיה, כי `תחזוקה` טובה מ`תקלה` בדירוג.
//
// ⚠️ והתוצאה במסך: הצ'יפ נצבע לפי `status` (אדום), אבל הסינון לפי
// `displayStatus` (תחזוקה) — כלומר בחירת "תקלה" **הסתירה** את השורה האדומה.
//
// הקובץ טהור ואינו מייבא React, ולכן נטען כאן ישירות ולא כעותק.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { toSupervisorShape } = require(
  path.join(__dirname, "..", "..", "dashboard", "src", "services", "supervisorShape.js"));

const shape = (siteStatus, systems) => toSupervisorShape({
  siteRows: [{ id: 1, code: "3468", site_name: "פלורנטין", status: siteStatus, tier: "basic" }],
  statsRows: [], uptimeRows: [], errorRows: [], maintRows: [],
  globalsRows: [{ site_id: 1, systems, systems_seen_at: "2026-09-14T22:58:33Z" }],
}).sites[0];

test("⚠️ תקלה חיה אינה נעלמת מאחורי פירוט ישן [מוכן, תחזוקה]", () => {
  const s = shape("error", [{ unit: 1, state: "ready" }, { unit: 2, state: "maintenance" }]);
  assert.equal(s.status, "error");
  assert.equal(s.displayStatus, "error");
});

test("מערכת בתחזוקה כן מופיעה כשהאתר עצמו מוכן", () => {
  const s = shape("ready", [{ unit: 1, state: "ready" }, { unit: 2, state: "maintenance" }]);
  assert.equal(s.displayStatus, "maintenance");
});

test("אין תקשורת — הפירוט הישן אינו גובר, גם כשהוא אומר תקלה", () => {
  const s = shape("no_comm", [{ unit: 1, state: "error" }, { unit: 2, state: "ready" }]);
  assert.equal(s.displayStatus, "no_comm");
});

test("אתר חד-מערכתי — המצב המוצג הוא מצב האתר", () => {
  assert.equal(shape("operating", null).displayStatus, "operating");
});
