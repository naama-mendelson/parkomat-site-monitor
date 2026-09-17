// tests/backfill-control-system.test.js — התוכנית למילוי מערכת ההפעלה באתרים.
//
// ⚠️ הכלי כותב לייצור, ולכן ההחלטות שלו נבדקות כאן על נתונים מומצאים בצורת
// האמת — השמות, הגרשיים וסדר הטווח כפי שהם בדשבורד ובטבלה.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planControlSystems } from "../tools/lib/control-system-plan.mjs";

const TABLE = [
  { name: "גרוזנברג 7 ת\"א", robot: "xy", sys: "ביטנקם" },
  { name: "מגדל 1 ת\"א", robot: "xy", sys: "לולק" },
  { name: "דה האז 3 ת\"א", robot: "שאטל מצבט y מסובבת", sys: "לולק" },
  { name: "בארט 11-19", robot: "שאטל מצבט x קומתי", sys: "לולק" },
  { name: "עמינדב 16 ת\"א", robot: "מגדל", sys: "סוטפין" },
  { name: "הירקון180ת''א", robot: "מצבט", sys: "לולק" },
  { name: "כפול 1", robot: "xy", sys: "לולק" },
  { name: "כפול 1 ת\"א", robot: "xy", sys: "ביטנקם" },
];
const MAP = {
  ffSites: {
    b38: { name: "הירקון 38 ת\"א", system: "ביטנקם", profile: "ביטנקם xy", docs: 37 },
    dh3: { name: "דה האז 3 ת\"א", system: "לולק", profile: "שאטל מצבט y שמסובבת בשאטל", docs: 38 },
  },
  profiles: {},
  sites: {},
};
const site = (over) => ({ id: 1, code: "1", site_name: "?", plc_type: null, control_system: null, fixflow_profile: null, ...over });
const plan1 = (s) => planControlSystems([site(s)], TABLE, MAP)[0];

test("גרוזנברג — ביטנקם, מהטבלה", () => {
  const p = plan1({ site_name: "גרוזנברג 7, ת\"א", plc_type: "xy" });
  assert.equal(p.set.control_system, "ביטנקם");
  assert.match(p.systemSource, /טבלת האתרים/);
});

test("אתר שבטבלה כלולק — לולק, מהטבלה", () => {
  assert.equal(plan1({ site_name: "מגדל 1", plc_type: "xy" }).set.control_system, "לולק");
});

test("אתר שאינו בטבלה — לולק, לפי הנחיית המוצר, והמקור נאמר", () => {
  const p = plan1({ site_name: "הקונגרס", plc_type: "xy" });
  assert.equal(p.set.control_system, "לולק");
  assert.match(p.systemSource, /הנחיית המוצר/);
});

test("⚠️ ערך שכבר הוגדר — לא נדרס, גם כשהטבלה אומרת אחרת (ומדווח)", () => {
  const p = plan1({ site_name: "מגדל 1", control_system: "ביטנקם", plc_type: "xy" });
  assert.equal(p.set.control_system, undefined);
  assert.ok(p.notes.some((n) => /דורש בדיקה/.test(n)));
});

test("⚠️ דה האז — הסוג מתוקן לפי הטבלה (מצבט X → מצבט Y)", () => {
  const p = plan1({ site_name: "דה האז", plc_type: "matzbet-x" });
  assert.equal(p.set.plc_type, undefined, "השם 'דה האז' לבד אינו 'דה האז 3' — אין התאמה מדויקת");
  const q = plan1({ site_name: "דה האז 3, ת\"א", plc_type: "matzbet-x" });
  assert.equal(q.set.plc_type, "matzbet-y");
});

test("סדר טווח הפוך ('19-11') — אותו אתר", () => {
  const p = plan1({ site_name: "בארט 19-11, ת\"א", plc_type: "matzbet-x" });
  assert.equal(p.set.control_system, "לולק");
  assert.equal(p.set.plc_type, undefined, "matzbet-x כבר תואם");
});

test("סוג בטבלה בלי מקבילה בדשבורד — מדווח, לא מתורגם", () => {
  const p = plan1({ site_name: "הירקון180ת''א", plc_type: "matzbet-x" });
  assert.equal(p.set.plc_type, undefined);
  assert.ok(p.notes.some((n) => /אין לו מקבילה/.test(n)));
});

test("⚠️ שם שמתאים לשתי שורות — לא מותאם, ומדווח", () => {
  const p = plan1({ site_name: "כפול 1" });
  assert.equal(p.tableRow, null);
  assert.ok(p.notes.some((n) => /2 שורות/.test(n)));
});

test("⚠️ הירקון 224 — קישור ידני לביטנקם מתנקה כשהאתר לולק", () => {
  const p = plan1({ site_name: "הירקון 224, ת\"א", plc_type: "matzbet-x", fixflow_profile: "site:b38" });
  assert.equal(p.set.control_system, "לולק");
  assert.equal(p.set.fixflow_profile, "");
  assert.ok(p.notes.some((n) => /נוקה/.test(n)));
});

test("קישור ידני לאותו יצרן — נשאר", () => {
  const p = plan1({ site_name: "גרוזנברג 7, ת\"א", plc_type: "xy", fixflow_profile: "site:b38" });
  assert.equal(p.set.fixflow_profile, undefined);
});

test("סוטפין מהטבלה — נשמר כסוטפין, לא מוכנס ללולק", () => {
  const p = plan1({ site_name: "עמינדב 16, ת\"א" });
  assert.equal(p.set.control_system, "סוטפין");
});

test("⚠️ דה האז — מותאם דרך הקישור הידני ל-'דה האז 3', והסוג מתוקן לפי הטבלה", () => {
  const p = plan1({ site_name: "דה האז", plc_type: "matzbet-x", fixflow_profile: "site:dh3" });
  assert.equal(p.tableRow?.name, "דה האז 3 ת\"א");
  assert.equal(p.set.plc_type, "matzbet-y");
  assert.equal(p.set.fixflow_profile, undefined, "הקישור לאותו יצרן נשאר");
});

// ⚠️ הבדיקה שהייתה חסרה: בטבלה האמיתית "הירקון 38 ת"א" **כן קיים — כביטנקם**. אם
// הקישור הידני השגוי של הירקון 224 היה משמש מפתח התאמה, הוא היה קובע לו ביטנקם
// ומנציח את הטעות. מצבט הוא לולק בלבד — ולכן ההתאמה דרך הקישור נפסלת.
test("⚠️ קישור ידני שגוי אינו משמש ראיה נגד הסוג — הירקון 224 נשאר לולק", () => {
  const table = [...TABLE, { name: "הירקון 38 ת\"א", robot: "xy", sys: "ביטנקם" }];
  const [p] = planControlSystems([site({ site_name: "הירקון 224, ת\"א", plc_type: "matzbet-x", fixflow_profile: "site:b38" })], table, MAP);
  assert.equal(p.tableRow, null);
  assert.equal(p.set.control_system, "לולק");
  assert.equal(p.set.fixflow_profile, "");
  assert.equal(p.set.plc_type, undefined, "הסוג לא הוחלף ל-xy של הירקון 38");
});
