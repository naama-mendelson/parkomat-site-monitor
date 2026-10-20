// tests/pm-lists-ui.test.js — רשימות לפי סוג האתר, הצד הטהור של הדשבורד (utils/pmLists.js), 15/10/2026.
const { test } = require("node:test");
const assert = require("node:assert/strict");

let m;
test.before(async () => { m = await import("../../dashboard/src/utils/pmLists.js"); });

test("הקטגוריות — ארבע, בסדר הזה, ומפתחות כמו pm_templates.category", () => {
  assert.deepEqual(m.PM_CATEGORIES.map((c) => c.key), ["base", "lift", "floor", "other"]);
  assert.equal(m.categoryLabel("floor"), "רצפה ומרתף");
  assert.equal(m.categoryLabel("nope"), "אחר", "קטגוריה לא מוכרת — 'אחר', לא ריק");
});

test("templateCategory — ברירת המחדל תמיד בסיס; רשימה ישנה בלי קטגוריה — אחר", () => {
  assert.equal(m.templateCategory({ is_default: true, category: "lift" }), "base");
  assert.equal(m.templateCategory({ category: "lift" }), "lift");
  assert.equal(m.templateCategory({}), "other");
  assert.equal(m.templateCategory({ category: "weird" }), "other");
});

test("groupTemplates — לפי הקטגוריה ואז seq, ברירת המחדל ראשונה בבסיס, קבוצות ריקות מושמטות", () => {
  const g = m.groupTemplates([
    { id: 5, name: "XY", category: "floor", seq: 4 },
    { id: 2, name: "הידראולית", category: "lift", seq: 1 },
    { id: 9, name: "ישנה", seq: 9 },
    { id: 1, name: "בסיס", is_default: true, seq: 0 },
    { id: 3, name: "חשמלית", category: "lift", seq: 2 },
    { id: 7, name: "בסיס שני?", category: "base", seq: 3 },
  ]);
  assert.deepEqual(g.map((x) => x.key), ["base", "lift", "floor", "other"]);
  assert.deepEqual(g[0].templates.map((t) => t.id), [1, 7]);
  assert.deepEqual(g[1].templates.map((t) => t.id), [2, 3]);
  assert.deepEqual(g[3].templates.map((t) => t.id), [9]);
  assert.deepEqual(m.groupTemplates([{ id: 1, is_default: true }]).map((x) => x.key), ["base"], "רק קבוצות שיש בהן משהו");
});

test("typeKeyOptions — כל סוגי המעלית והמתקן, בצורת lift:/floor:, עם תווית; typeKeyLabel", () => {
  const o = m.typeKeyOptions();
  assert.ok(o.some((x) => x.value === "lift:hydraulic-piston-1" && x.group === "lift"));
  assert.ok(o.some((x) => x.value === "floor:matzbet-x" && x.group === "floor"));
  // אותן שתי צורות ש-pm_template_meta_set מקבל (19/10/2026: גם system: בעברית ו-console:)
  assert.ok(o.every((x) => /^(lift|floor|console):[A-Za-z0-9_-]{1,40}$/.test(x.value) || /^system:[^\s:]{1,40}$/.test(x.value)),
    o.filter((x) => !/^(lift|floor|console|system):/.test(x.value)).map((x) => x.value).join(","));
  assert.equal(new Set(o.map((x) => x.value)).size, o.length, "בלי כפילויות");
  assert.equal(m.typeKeyLabel("floor:doli"), "מתקן: דולי");
  assert.equal(m.typeKeyLabel("lift:electric"), "מעלית: חשמלי");
  assert.equal(m.typeKeyLabel("lift:unknown"), "lift:unknown", "מפתח לא מוכר — כמו שהוא, לא נופל");
  // מערכת וקונזול — כל ארבע המערכות ושני הקונזולים, מהרשימות המשותפות
  for (const s of ["לולק", "ביטנקם", "סוטפין", "סוטפין-לולק"]) assert.ok(o.some((x) => x.value === `system:${s}` && x.group === "system"), s);
  assert.equal(m.typeKeyLabel("system:ביטנקם"), "מערכת: ביטנקם");
  assert.equal(m.typeKeyLabel("console:longitudinal"), "קונזול אורכי", "בלי 'קונזול: קונזול'");
  assert.equal(m.typeKeyLabel("console:transverse"), "קונזול רוחבי");
});

test("sharedLabel — כמה אתרים חולקים רשימה, לכותרת שלה בעורך", () => {
  assert.equal(m.sharedLabel({ site_count: 52 }), "משותפת ל-52 אתרים — שינוי כאן חל על כולם");
  assert.equal(m.sharedLabel({ site_count: 1 }), "רק באתר הזה");
  assert.equal(m.sharedLabel({ site_count: 0 }), "רק באתר הזה", "0 = האתר עוד לא נספר (רשימה שזה עתה שויכה)");
  assert.equal(m.sharedLabel({}), "", "בלי מספר — בלי משפט");
  assert.equal(m.sharedLabel(null), "");
  assert.equal(m.sharedLabel({ site_count: "x" }), "");
});

test("coverageRows — מכוסה / ברשימות הכלליות / יש רשימה שלא משויכת; מסד ישן בלי השדה — אין שורות", () => {
  const rows = m.coverageRows([
    { key: "floor:xy", lists: [{ id: 5, name: "מיטת XY במרתף", assigned: true }] },
    { key: "system:ביטנקם", lists: [] },
    { key: "lift:hydraulic-piston-1", lists: [{ id: 2, name: "מעלית הידראולית", assigned: false }] },
    { key: "console:longitudinal", lists: [{ id: 9, name: "א", assigned: true }, { id: 10, name: "ב", assigned: false }] },
  ]);
  assert.deepEqual(rows.map((r) => [r.label, r.state, r.assigned, r.unassigned]), [
    ["מתקן: XY", "covered", ["מיטת XY במרתף"], []],
    ["מערכת: ביטנקם", "general", [], []],
    ["מעלית: הידראולית בוכנה 1", "unassigned", [], ["מעלית הידראולית"]],
    ["קונזול אורכי", "covered", ["א"], ["ב"]],
  ]);
  assert.deepEqual(m.coverageRows(undefined), []);
  assert.deepEqual(m.coverageRows(null), []);
  assert.deepEqual(m.coverageRows([{ key: "floor:doli" }]).map((r) => r.state), ["general"], "בלי lists — כללי, לא קריסה");
});

test("sourceLabel — ארבעת המקורות במילים, ולא מוכר = ברירת המחדל", () => {
  assert.equal(m.sourceLabel("explicit"), "נבחרו ידנית");
  assert.equal(m.sourceLabel("auto"), "אוטומטי לפי סוג האתר");
  assert.equal(m.sourceLabel("profile"), "מפרופיל התחזוקה");
  assert.equal(m.sourceLabel("default"), "ברירת המחדל");
  assert.equal(m.sourceLabel(undefined), "ברירת המחדל");
});

test("initialSelection / lockedIds — מסמנים את מה שיש עכשיו; הבסיס נעול", () => {
  assert.deepEqual([...m.initialSelection([{ id: 1 }, { id: 5 }])], [1, 5]);
  assert.deepEqual([...m.initialSelection(null)], []);
  assert.deepEqual([...m.lockedIds([{ id: 1, is_default: true }, { id: 2 }])], [1]);
});
