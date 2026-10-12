// tests/lift-types.test.js — סוג המעלית והקונזול (11/10/2026), ועד שתי מעליות (12/10/2026): הרשימה
// המשותפת מול ה-SQL.
//
// אותה רשימה כתובה בארבעה מקומות: shared/lift-types.mjs (הטפסים), app.check_lift_type /
// app.check_lift_console (writes.postgres.sql — הרישום והעריכה), וה-CHECK של הטבלה — לכל מעלית אחד:
// sites_lift_shape ו-sites_lift2_shape (schema.postgres.sql). סוג שנוסף רק לאחד מהם היה מופיע בטופס
// ונדחה בשמירה, או נשמר דרך SQL ונשבר במסך. כאן — שכולם אומרים אותו דבר, וגם אילו סוגים פותחים את
// שאלת הקונזול. סטטי: קורא את קבצי ה-SQL, בלי מסד.
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
// האילוץ של כל מעלית: [שם, הקידומת של העמודות]
const SHAPES = [["sites_lift_shape", "lift"], ["sites_lift2_shape", "lift2"]];
const shapeOf = (name) => {
  const i = SCHEMA.indexOf(`ADD CONSTRAINT ${name}`);
  assert.ok(i >= 0, `${name} לא נמצא`);
  return SCHEMA.slice(i, SCHEMA.indexOf("NOT VALID;", i));
};

test("הסוגים — זהים ברשימה המשותפת, ב-check_lift_type ובשני ה-CHECK של הטבלה", async () => {
  const { LIFT_TYPE_KEYS } = await load();
  const check = fnBody(WRITES, "app.check_lift_type");
  const inFn = listAfter(check, "IF v NOT IN (");
  assert.equal(LIFT_TYPE_KEYS.length, 7);
  assert.ok(same(LIFT_TYPE_KEYS, inFn), `check_lift_type: ${inFn}`);
  for (const [name, col] of SHAPES) {
    const inChk = listAfter(shapeOf(name), `${col}_type IN (`);
    assert.ok(same(LIFT_TYPE_KEYS, inChk), `${name}: ${inChk}`);
  }
});

test("הקונזולים ומי פותח את השאלה — זהים בכל המקומות (1, 2, 6; המספריים — לא)", async () => {
  const { LIFT_TYPES, LIFT_CONSOLE_KEYS } = await load();
  const withConsole = LIFT_TYPES.filter((t) => t.console).map((t) => t.key);
  assert.deepEqual(withConsole, ["hydraulic-piston-1", "hydraulic-piston-2", "electric"]);
  const fn = fnBody(WRITES, "app.check_lift_console");
  assert.ok(same(withConsole, listAfter(fn, "p_type NOT IN (")), "check_lift_console: מי פותח את השאלה");
  assert.ok(same(LIFT_CONSOLE_KEYS, listAfter(fn, "IF v NOT IN (")), "check_lift_console: הקונזולים");
  for (const [name, col] of SHAPES) {
    const shape = shapeOf(name);
    assert.ok(same(LIFT_CONSOLE_KEYS, listAfter(shape, `${col}_console IN (`)), `${name}: הקונזולים`);
    assert.ok(same(withConsole, listAfter(shape, `COALESCE(${col}_type IN (`)), `${name}: מי חייב קונזול`);
  }
});

test("⚠️ אין מעלית שנייה בלי ראשונה — בשני ה-CHECK של הטבלה ולא רק בטופס", () => {
  assert.match(shapeOf("sites_lift2_shape"), /lift2_type IS NULL OR lift_type IS NOT NULL/);
});

test("התוויות — כמו שבעלת המוצר כתבה, ובאותו סדר; המספריים בסוף (12/10/2026)", async () => {
  const { LIFT_TYPES, LIFT_CONSOLES, MAX_LIFTS } = await load();
  assert.deepEqual(LIFT_TYPES.map((t) => t.label),
    ["הידראולית בוכנה 1", "הידראולית בוכנה 2", "4 עמודים 18 KW", "4 עמודים 11 KW", "סרפיד", "חשמלי", "מספריים הידראולית"]);
  assert.deepEqual(LIFT_CONSOLES.map((c) => c.label), ["קונזול אורכי", "קונזול רוחבי"]);
  assert.equal(MAX_LIFTS, 2, "עד שתיים");
});

test("liftProblem / liftLabel / liftNeedsConsole — אותו כלל כמו השרת", async () => {
  const { liftProblem, liftLabel, liftNeedsConsole } = await load();
  assert.equal(liftProblem("", ""), "יש לבחור סוג מעלית");
  assert.equal(liftProblem("", "", { required: false }), null, "לא חובה — מותר להשאיר ריק");
  assert.equal(liftProblem("escalator", ""), "סוג מעלית לא תקין");
  assert.equal(liftProblem("electric", ""), "יש לבחור קונזול אורכי או קונזול רוחבי");
  assert.equal(liftProblem("electric", "diagonal"), "יש לבחור קונזול אורכי או קונזול רוחבי");
  assert.equal(liftProblem("electric", "transverse"), null);
  assert.equal(liftProblem("serapid", ""), null, "סוג בלי קונזול — אין שאלה");
  assert.equal(liftProblem("hydraulic-scissors", ""), null, "המספריים — בלי קונזול");
  assert.equal(liftNeedsConsole("hydraulic-piston-2"), true);
  assert.equal(liftNeedsConsole("four-post-18kw"), false);
  assert.equal(liftNeedsConsole("hydraulic-scissors"), false);
  assert.equal(liftNeedsConsole(""), false);
  assert.equal(liftLabel("hydraulic-piston-1", "longitudinal"), "הידראולית בוכנה 1 · קונזול אורכי");
  assert.equal(liftLabel("serapid", "longitudinal"), "סרפיד", "קונזול שאינו שייך לסוג — לא מוצג");
  assert.equal(liftLabel(null, null), "לא הוגדר");
});

test("siteLifts / liftsLabel — מהעמודות, אחת או שתיים, מחוברות ב-'+'", async () => {
  const { siteLifts, liftsLabel } = await load();
  assert.deepEqual(siteLifts({}), []);
  assert.deepEqual(siteLifts({ lift_type: "serapid", lift_console: null }), [{ type: "serapid", console: null }]);
  const two = siteLifts({ lift_type: "electric", lift_console: "transverse", lift2_type: "hydraulic-scissors", lift2_console: null });
  assert.deepEqual(two, [{ type: "electric", console: "transverse" }, { type: "hydraulic-scissors", console: null }]);
  assert.equal(liftsLabel(two), "חשמלי · קונזול רוחבי + מספריים הידראולית");
  assert.equal(liftsLabel([]), "לא הוגדר");
  assert.equal(liftsLabel([{ type: "", console: "" }]), "לא הוגדר", "שורה ריקה בטופס — כמו בלי מעלית");
});

test("liftsProblem — הראשונה לפי required, השנייה חייבת סוג, ולא בלי ראשונה", async () => {
  const { liftsProblem } = await load();
  const L = (type, c = "") => ({ type, console: c });
  // בלי מעלית בכלל — תקין כשאינה חובה (מאז 12/10/2026 בערב: "שלא יהיה חייבים לבחור")
  assert.equal(liftsProblem([L("")], { required: false }), null);
  assert.equal(liftsProblem([L("")]), "יש לבחור סוג מעלית", "ברירת המחדל עדיין חובה — הקורא מחליט");
  assert.equal(liftsProblem([L("serapid")]), null);
  assert.equal(liftsProblem([L("electric")]), "יש לבחור קונזול אורכי או קונזול רוחבי", "אחת — בלי 'מעלית 1:'");
  // שתיים
  assert.equal(liftsProblem([L("electric", "transverse"), L("hydraulic-scissors")]), null);
  assert.equal(liftsProblem([L("electric"), L("serapid")]), "מעלית 1: יש לבחור קונזול אורכי או קונזול רוחבי");
  assert.equal(liftsProblem([L("serapid"), L("")]), "יש לבחור סוג למעלית השנייה, או להסיר אותה");
  assert.equal(liftsProblem([L("serapid"), L("hydraulic-piston-1")]), "מעלית 2: יש לבחור קונזול אורכי או קונזול רוחבי");
  assert.equal(liftsProblem([L(""), L("serapid")], { required: false }), "יש לבחור קודם את המעלית הראשונה");
  assert.equal(liftsProblem([L("serapid"), L("serapid"), L("serapid")]), "אפשר לרשום עד 2 מעליות");
});

test("⚠️ update_site נועל את השורה לפני שהוא קורא את המעליות (FOR UPDATE)", () => {
  // ה-UPDATE של המעליות כותב את שתיהן — גם את זו שלא נשלחה, מהערך שנקרא בתחילת הפונקציה. בלי נעילה לפני
  // הקריאה, שני מנהלים שערכו את אותו אתר באותו רגע היו מחזירים זה לזה את הערך הישן (נמצא בסקירה, 12/10/2026).
  // ב-PGlite אין שני חיבורים במקביל, ולכן הבדיקה כאן מבנית: הקריאה הראשונה בפונקציה נועלת.
  const body = fnBody(WRITES, "public.update_site");
  const sel = body.slice(body.indexOf("SELECT s.id, s.code, s.site_name"));
  assert.match(sel.slice(0, sel.indexOf(";")), /FOR UPDATE\s*$/);
});
