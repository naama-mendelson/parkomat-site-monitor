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
  assert.ok(o.every((x) => /^(lift|floor):[A-Za-z0-9_-]+$/.test(x.value)), "אותה צורה ש-pm_template_meta_set מקבל");
  assert.equal(new Set(o.map((x) => x.value)).size, o.length, "בלי כפילויות");
  assert.equal(m.typeKeyLabel("floor:doli"), "מתקן: דולי");
  assert.equal(m.typeKeyLabel("lift:electric"), "מעלית: חשמלי");
  assert.equal(m.typeKeyLabel("lift:unknown"), "lift:unknown", "מפתח לא מוכר — כמו שהוא, לא נופל");
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
