// tests/lift-types.test.js — סוג המעלית והקונזול (11/10/2026): הרשימה המשותפת מול ה-SQL.
//
// אותה רשימה כתובה בשלושה מקומות: shared/lift-types.mjs (הטפסים), app.check_lift_type /
// app.check_lift_console (writes.postgres.sql — הרישום והעריכה), וה-CHECK sites_lift_shape
// (schema.postgres.sql — הטבלה). סוג שנוסף רק לאחד מהם היה מופיע בטופס ונדחה בשמירה, או נשמר
// דרך SQL ונשבר במסך. כאן — ששלושתם אומרים אותו דבר, וגם אילו סוגים פותחים את שאלת הקונזול.
// סטטי: קורא את קבצי ה-SQL, בלי מסד.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SHARED = path.join(__dirname, "../../shared/lift-types.mjs");
const WRITES = fs.readFileSync(path.join(__dirname, "../db/writes.postgres.sql"), "utf8");
const SCHEMA = fs.readFileSync(path.join(__dirname, "../db/schema.postgres.sql"), "utf8");
const load = () => import(pathToFileURL(SHARED).href);

// גוף פונקציה ב-SQL, מה-CREATE עד ה-$fn$; שאחריו
function fnBody(sql, name) {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.ok(i >= 0, `${name} לא נמצאה`);
  const j = sql.indexOf("$fn$;", i);
  return sql.slice(i, j);
}
// הרשימה הראשונה בסוגריים אחרי העוגן: 'a', 'b', …
function listAfter(text, anchor) {
  const i = text.indexOf(anchor);
  assert.ok(i >= 0, `עוגן לא נמצא: ${anchor}`);
  const open = text.indexOf("(", i + anchor.length - 1);
  const close = text.indexOf(")", open);
  return [...text.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
const same = (a, b) => [...a].sort().join("|") === [...b].sort().join("|");

test("הסוגים — זהים ברשימה המשותפת, ב-check_lift_type וב-CHECK של הטבלה", async () => {
  const { LIFT_TYPE_KEYS } = await load();
  const check = fnBody(WRITES, "app.check_lift_type");
  const inFn = listAfter(check, "IF v NOT IN (");
  const shape = SCHEMA.slice(SCHEMA.indexOf("ADD CONSTRAINT sites_lift_shape"));
  const inChk = listAfter(shape, "lift_type IN (");
  assert.equal(LIFT_TYPE_KEYS.length, 6);
  assert.ok(same(LIFT_TYPE_KEYS, inFn), `check_lift_type: ${inFn}`);
  assert.ok(same(LIFT_TYPE_KEYS, inChk), `sites_lift_shape: ${inChk}`);
});

test("הקונזולים ומי פותח את השאלה — זהים בשלושת המקומות (1, 2, 6)", async () => {
  const { LIFT_TYPES, LIFT_CONSOLE_KEYS } = await load();
  const withConsole = LIFT_TYPES.filter((t) => t.console).map((t) => t.key);
  assert.deepEqual(withConsole, ["hydraulic-piston-1", "hydraulic-piston-2", "electric"]);
  const fn = fnBody(WRITES, "app.check_lift_console");
  assert.ok(same(withConsole, listAfter(fn, "p_type NOT IN (")), "check_lift_console: מי פותח את השאלה");
  assert.ok(same(LIFT_CONSOLE_KEYS, listAfter(fn, "IF v NOT IN (")), "check_lift_console: הקונזולים");
  const shape = SCHEMA.slice(SCHEMA.indexOf("ADD CONSTRAINT sites_lift_shape"));
  assert.ok(same(LIFT_CONSOLE_KEYS, listAfter(shape, "lift_console IN (")), "sites_lift_shape: הקונזולים");
  assert.ok(same(withConsole, listAfter(shape, "COALESCE(lift_type IN (")), "sites_lift_shape: מי חייב קונזול");
});

test("התוויות — כמו שבעלת המוצר כתבה, ובאותו סדר", async () => {
  const { LIFT_TYPES, LIFT_CONSOLES } = await load();
  assert.deepEqual(LIFT_TYPES.map((t) => t.label),
    ["הידראולית בוכנה 1", "הידראולית בוכנה 2", "4 עמודים 18 KW", "4 עמודים 11 KW", "סרפיד", "חשמלי"]);
  assert.deepEqual(LIFT_CONSOLES.map((c) => c.label), ["קונזול אורכי", "קונזול רוחבי"]);
});

test("liftProblem / liftLabel / liftNeedsConsole — אותו כלל כמו השרת", async () => {
  const { liftProblem, liftLabel, liftNeedsConsole } = await load();
  assert.equal(liftProblem("", ""), "יש לבחור סוג מעלית");
  assert.equal(liftProblem("", "", { required: false }), null, "אתר ישן בעריכה — מותר להשאיר ריק");
  assert.equal(liftProblem("escalator", ""), "סוג מעלית לא תקין");
  assert.equal(liftProblem("electric", ""), "יש לבחור קונזול אורכי או קונזול רוחבי");
  assert.equal(liftProblem("electric", "diagonal"), "יש לבחור קונזול אורכי או קונזול רוחבי");
  assert.equal(liftProblem("electric", "transverse"), null);
  assert.equal(liftProblem("serapid", ""), null, "סוג בלי קונזול — אין שאלה");
  assert.equal(liftNeedsConsole("hydraulic-piston-2"), true);
  assert.equal(liftNeedsConsole("four-post-18kw"), false);
  assert.equal(liftNeedsConsole(""), false);
  assert.equal(liftLabel("hydraulic-piston-1", "longitudinal"), "הידראולית בוכנה 1 · קונזול אורכי");
  assert.equal(liftLabel("serapid", "longitudinal"), "סרפיד", "קונזול שאינו שייך לסוג — לא מוצג");
  assert.equal(liftLabel(null, null), "לא הוגדר");
});
