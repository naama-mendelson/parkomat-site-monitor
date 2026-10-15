// tests/pm-auto.test.js — רשימות תחזוקה לפי סוג האתר (15/10/2026).
//
// בעלת המוצר: "אני רוצה שתסווג לפי מה שמסומן הסוג של האתר. אם יש שתי סוגי מעליות אז שיהיה את התחזוקה גם של זה
// וגם של זה… אבל מלכתחילה תשים לכל אתר את מה שמתאים לו, ואפשר יהיה להוסיף ולשנות".
//   - pm_template_meta_set: קטגוריה + auto_for (מפתחות lift:/floor:), מנהל בלבד, ברירת המחדל בלי סיווג.
//   - app.pm_auto_template_ids: הבסיס + כל רשימה שחלה על אחד ממפתחות הסוג של האתר; שתי מעליות = שתי רשימות.
//   - הסדר: ידני לאתר → לפי הסוג → פרופיל → ברירת המחדל; pm_site אומר מאיפה (templates_source).
//   - שינוי סוג האתר (update_site) משנה את הרשימות מיד; שינוי auto_for משנה לכל האתרים שנגזרים מהסוג.
// רץ מול PGlite עם db.init() האמיתי.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
let h;
const MGR = "c3000000-0000-0000-0000-000000000001";
const OPR = "c3000000-0000-0000-0000-000000000002";
let seq = 0;
const rpc = async (uid, sql, p = []) => (await h.as("authenticated", uid, (tx) => tx.query(sql, p))).rows;
const one = async (uid, sql, p = []) => (await rpc(uid, sql, p))[0];
const site = (code) => one(OPR, `SELECT public.pm_site($1) j`, [code]).then((r) => r.j);
const names = async (code) => (await site(code)).templates.map((t) => t.name);
const createList = (name) => one(MGR, `SELECT public.pm_template_create($1) id`, [name]).then((r) => r.id);
const saveItems = (id, items) => rpc(MGR, `SELECT public.pm_template_save($1::jsonb, NULL, $2)`, [JSON.stringify(items), id]);
const meta = (id, cat, keys, uid = MGR) => rpc(uid, `SELECT public.pm_template_meta_set($1, $2, $3::text[])`, [id, cat, keys]);
const lists = () => one(MGR, `SELECT public.pm_templates_list() j`).then((r) => r.j);
// קונזול אוטומטי לסוגים שדורשים אותו (1, 2, 6) — הבדיקה כאן היא על הרשימות, לא על הקונזול
const CONSOLE = new Set(["hydraulic-piston-1", "hydraulic-piston-2", "electric"]);
const con = (t) => (t && CONSOLE.has(t) ? "longitudinal" : null);
const newSite = async (plc = null, lift = null, lift2 = null) => {
  const code = `PAU${++seq}`;
  await rpc(MGR, `SELECT public.register_site($1, $2, $3, 'basic', true, NULL, NULL, true, $4, $5, $6, $7)`,
    [code, `אתר ${code}`, plc, lift, con(lift), lift2, con(lift2)]);
  return code;
};
let BASE, HYD, ELE, XY, XORY, DOLI;

before(async () => {
  if (skip) return;
  h = await local.boot();
  await h.pg.query(`INSERT INTO app_users (email, role, is_active, supabase_uid, created_at) VALUES
    ('mgr-auto@parkomat.co.il','manager',true,$1,now()), ('opr-auto@parkomat.co.il','operator',true,$2,now())`, [MGR, OPR]);
  BASE = (await h.pg.query(`SELECT id FROM pm_templates WHERE is_default`)).rows[0].id;
  await rpc(MGR, `SELECT public.pm_template_rename($1, 'בסיס פרקומט')`, [BASE]);
  await saveItems(BASE, [{ label: "בסיס", kind: "check", required: true }]);
  HYD = await createList("מעלית הידראולית"); await saveItems(HYD, [{ label: "הידראולית", kind: "check", required: true }]);
  ELE = await createList("מעלית חשמלית"); await saveItems(ELE, [{ label: "חשמלית", kind: "check", required: true }]);
  XY = await createList("מיטת XY"); await saveItems(XY, [{ label: "מיטת XY", kind: "check", required: true }]);
  XORY = await createList("מיטת X או Y"); await saveItems(XORY, [{ label: "מיטת X", kind: "check", required: true }]);
  DOLI = await createList("דולי"); await saveItems(DOLI, [{ label: "דולי", kind: "check", required: true }]);
  await meta(HYD, "lift", ["lift:hydraulic-piston-1", "lift:hydraulic-piston-2"]);
  await meta(ELE, "lift", ["lift:electric", "lift:four-post-18kw", "lift:four-post-11kw"]);
  await meta(XY, "floor", ["floor:xy"]);
  await meta(XORY, "floor", ["floor:x", "floor:y", "floor:matzbet-x", "floor:matzbet-y"]);
  await meta(DOLI, "floor", ["floor:doli"]);
});
after(async () => { if (h) await h.close(); });

test("הרשימות נגזרות מסוג המתקן ומסוג המעלית — הבסיס תמיד, ושתי מעליות = שתי רשימות", { skip }, async () => {
  assert.deepEqual(await names(await newSite("doli", "hydraulic-piston-1")), ["בסיס פרקומט", "מעלית הידראולית", "דולי"]);
  assert.deepEqual(await names(await newSite("matzbet-x", "four-post-11kw")), ["בסיס פרקומט", "מעלית חשמלית", "מיטת X או Y"]);
  assert.deepEqual(await names(await newSite("xy", "electric")), ["בסיס פרקומט", "מעלית חשמלית", "מיטת XY"]);
  // שתי מעליות מסוגים שונים — שתי הרשימות; מאותו סוג — רשימה אחת, לא כפולה
  assert.deepEqual(await names(await newSite("xy", "hydraulic-piston-1", "electric", "longitudinal")),
    ["בסיס פרקומט", "מעלית הידראולית", "מעלית חשמלית", "מיטת XY"]);
  assert.deepEqual(await names(await newSite("doli", "hydraulic-piston-1", "hydraulic-piston-2", "longitudinal")), ["בסיס פרקומט", "מעלית הידראולית", "דולי"]);
  const a = await newSite("xy", "hydraulic-piston-1");
  const j = await site(a);
  assert.equal(j.templates_source, "auto");
  assert.deepEqual(j.type_keys, ["floor:xy", "lift:hydraulic-piston-1"]);
  assert.deepEqual(j.auto_template_ids, [BASE, HYD, XY]);
});

test("אתר בלי סוג, או עם סוג שאין לו רשימה — לא 'אוטומטי': נופל לפרופיל או לברירת המחדל", { skip }, async () => {
  const none = await newSite();
  assert.equal((await site(none)).templates_source, "default");
  assert.deepEqual(await names(none), ["בסיס פרקומט"]);
  const scissors = await newSite("shuttle-x", "hydraulic-scissors");   // אין רשימה למספריים ולשאטל
  assert.equal((await site(scissors)).templates_source, "default");
  assert.deepEqual(await names(scissors), ["בסיס פרקומט"]);
  // פרופיל לאתר בלי סוג (כמו המכפילים) — הפרופיל, לא "בסיס בלבד"
  const pid = (await one(MGR, `SELECT public.pm_profile_save(NULL, 'מכפילים (בדיקה)', $1::int[], NULL, $2::text[]) id`, [[BASE, DOLI], [none]])).id;
  assert.ok(pid);
  assert.equal((await site(none)).templates_source, "profile");
  assert.deepEqual(await names(none), ["בסיס פרקומט", "דולי"]);
});

test("הסדר: ידני → לפי הסוג → פרופיל; ניקוי הידני מחזיר לאוטומטי", { skip }, async () => {
  const a = await newSite("doli", "hydraulic-piston-1");
  assert.deepEqual(await names(a), ["בסיס פרקומט", "מעלית הידראולית", "דולי"]);
  // פרופיל אינו גובר על הסוג (אתר מנוטר עם סוג) — כך 1343 "הידראולית + דולי" נשאר נכון גם בלי הפרופיל
  const pid = (await one(MGR, `SELECT public.pm_profile_save(NULL, 'פרופיל ישן', $1::int[], NULL, $2::text[]) id`, [[BASE, ELE], [a]])).id;
  assert.ok(pid);
  assert.equal((await site(a)).templates_source, "auto");
  assert.deepEqual(await names(a), ["בסיס פרקומט", "מעלית הידראולית", "דולי"]);
  // ידני: הוספת רשימה (1384 — גם במת מעלית XY)
  await rpc(MGR, `SELECT public.pm_site_templates_set($1, $2::int[])`, [a, [BASE, HYD, DOLI, XY]]);
  assert.equal((await site(a)).templates_source, "explicit");
  assert.deepEqual(await names(a), ["בסיס פרקומט", "מעלית הידראולית", "מיטת XY", "דולי"]);
  // ידני: הורדת רשימה שהסוג היה נותן
  await rpc(MGR, `SELECT public.pm_site_templates_set($1, $2::int[])`, [a, [BASE, DOLI]]);
  assert.deepEqual(await names(a), ["בסיס פרקומט", "דולי"]);
  // ניקוי — חזרה לאוטומטי, לא לפרופיל
  await rpc(MGR, `SELECT public.pm_site_templates_set($1, $2::int[])`, [a, []]);
  assert.equal((await site(a)).templates_source, "auto");
  assert.deepEqual(await names(a), ["בסיס פרקומט", "מעלית הידראולית", "דולי"]);
});

test("שינוי סוג האתר משנה את הרשימות מיד; שינוי auto_for של רשימה משנה לכל האתרים שנגזרים מהסוג", { skip }, async () => {
  const a = await newSite("doli", "hydraulic-piston-1");
  await rpc(MGR, `SELECT public.update_site($1, NULL, NULL, NULL, 'xy', NULL, NULL, 'electric', 'transverse', NULL, NULL)`, [a]);
  assert.deepEqual(await names(a), ["בסיס פרקומט", "מעלית חשמלית", "מיטת XY"]);
  // סרפיד מקבל את רשימת החשמלית — מעכשיו
  const b = await newSite("xy", "serapid");
  assert.deepEqual(await names(b), ["בסיס פרקומט", "מיטת XY"]);
  await meta(ELE, "lift", ["lift:electric", "lift:four-post-18kw", "lift:four-post-11kw", "lift:serapid"]);
  assert.deepEqual(await names(b), ["בסיס פרקומט", "מעלית חשמלית", "מיטת XY"]);
  const l = (await lists()).find((t) => t.id === ELE);
  assert.equal(l.category, "lift");
  assert.deepEqual(l.auto_for, ["lift:electric", "lift:four-post-11kw", "lift:four-post-18kw", "lift:serapid"], "ממוין וייחודי");
  // אירוע לאתרים שנגזרים מהסוג
  const ev = (await h.pg.query(`SELECT count(*)::int n FROM events WHERE type = 'compliance' AND payload::text LIKE '%template_meta%'`)).rows[0].n;
  assert.ok(ev >= 2, `אירועים: ${ev}`);
});

test("pm_template_meta_set — ולידציה: קטגוריה, צורת המפתחות, ברירת המחדל בלי סיווג, בקר לא", { skip }, async () => {
  await assert.rejects(meta(HYD, "lifts", []), /קטגוריה לא מוכרת/);
  await assert.rejects(meta(HYD, "lift", ["hydraulic-piston-1"]), /מפתח סוג לא תקין/);
  await assert.rejects(meta(HYD, "lift", ["lift:bad key"]), /מפתח סוג לא תקין/);
  await assert.rejects(meta(BASE, "lift", []), /ברירת המחדל/);
  await assert.rejects(meta(BASE, "base", ["floor:xy"]), /ברירת המחדל/);
  await rpc(MGR, `SELECT public.pm_template_meta_set($1, 'base', '{}'::text[])`, [BASE]);   // מותר: base בלי מפתחות
  await assert.rejects(meta(HYD, "lift", ["lift:electric"], OPR), /מנהל/);
  await assert.rejects(meta(999999, "lift", []), /לא נמצאה/);
  // הטיפוס נשאר כמו שהיה
  assert.deepEqual((await lists()).find((t) => t.id === HYD).auto_for, ["lift:hydraulic-piston-1", "lift:hydraulic-piston-2"]);
});

test("הקובץ אידמפוטנטי — העמודות והאילוץ שורדים החלה שנייה", { skip }, async () => {
  const fs = require("node:fs"), path = require("node:path");
  await h.pg.exec(fs.readFileSync(path.join(__dirname, "..", "db", "compliance.postgres.sql"), "utf8"));
  const cols = (await h.pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'pm_templates' AND column_name IN ('category','auto_for')`)).rows;
  assert.equal(cols.length, 2);
  assert.deepEqual((await lists()).find((t) => t.id === XY).auto_for, ["floor:xy"]);
});
