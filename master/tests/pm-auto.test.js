// tests/pm-auto.test.js — רשימות התחזוקה של אתר: מה שנבחר לו, ובסיס לרובוטי (20/10/2026).
//
// בעלת המוצר: "יש כמובן בסיס — זה נמצא לכל האתרים. ואז צריך לבחור XY וכו' (בחירה מרובה), ואז מעליות (בחירה מרובה).
// עד שלא בוחרים אין כלום עדיין". ובתשובותיה: כל האתרים מתחילים מאפס, והבסיס לרובוטיים בלבד.
//   - app.pm_site_template_ids: רובוטי = הבסיס + מה שנבחר; מכפיל = רק מה שנבחר. הסוג והפרופיל אינם קובעים.
//   - pm_site_templates_set: הבסיס אינו נשמר גם אם נשלח; בתקרת התמונות הוא נספר לרובוטי.
//   - pm_visit_start: מכפיל בלי בחירה — הודעה שאומרת מה לעשות.
//   - הסיווג לפי סוג (pm_template_meta_set, auto_for) נשאר כרמז: type_coverage, auto_template_ids.
// ⚠️ עד 20/10 הקובץ בדק "לפי הסוג" (15/10/2026): הרשימות נגזרו מסוג המתקן והמעלית, ואחריהן פרופיל. זה בוטל.
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
const choose = (code, ids, uid = MGR) => rpc(uid, `SELECT public.pm_site_templates_set($1, $2::int[])`, [code, ids]);
const start = (code) => one(MGR, `SELECT visit_id::int FROM public.pm_visit_start($1)`, [code]);
const stored = async (code) => (await h.pg.query(
  `SELECT st.template_id FROM pm_site_templates st JOIN sites s ON s.id = st.site_id WHERE s.code = $1 ORDER BY 1`, [code])).rows.map((r) => r.template_id);
// קונזול אוטומטי לסוגים שדורשים אותו (1, 2, 6) — הבדיקה כאן היא על הרשימות, לא על הקונזול
const CONSOLE = new Set(["hydraulic-piston-1", "hydraulic-piston-2", "electric"]);
const con = (t) => (t && CONSOLE.has(t) ? "longitudinal" : null);
const newSite = async (plc = null, lift = null, lift2 = null, { system = null, monitored = true } = {}) => {
  const code = `PAU${++seq}`;
  await rpc(MGR, `SELECT public.register_site($1, $2, $3, 'basic', true, NULL, $4, $5, $6, $7, $8, $9)`,
    [code, `אתר ${code}`, plc, system, monitored, lift, con(lift), lift2, con(lift2)]);
  return code;
};
const newShell = () => newSite(null, null, null, { monitored: false });   // מכפיל / סוטפין — בלי בקר
let BASE, HYD, ELE, XY, XORY, DOLI, MX;

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
  MX = await createList("מכפילים"); await saveItems(MX, [{ label: "מכפיל", kind: "check", required: true }]);
  await meta(HYD, "lift", ["lift:hydraulic-piston-1", "lift:hydraulic-piston-2"]);
  await meta(ELE, "lift", ["lift:electric", "lift:four-post-18kw", "lift:four-post-11kw"]);
  await meta(XY, "floor", ["floor:xy"]);
  await meta(XORY, "floor", ["floor:x", "floor:y", "floor:matzbet-x", "floor:matzbet-y"]);
  await meta(DOLI, "floor", ["floor:doli"]);
  await meta(MX, "other", []);
});
after(async () => { if (h) await h.close(); });

test("עד שלא בוחרים: רובוטי — הבסיס בלבד, גם עם סוג; מכפיל — כלום, ואין ביקור", { skip }, async () => {
  const a = await newSite("doli", "hydraulic-piston-1");
  const j = await site(a);
  assert.deepEqual(j.templates.map((t) => t.name), ["בסיס פרקומט"], "הסוג אינו מביא רשימות");
  assert.equal(j.templates_source, "base");
  assert.equal(j.templates_assigned, false);
  assert.equal(j.site.monitored, true);
  assert.equal(j.template_count, 1);
  // הרמז נשאר: מה שמתאים לסוג, ומפתחות הסוג בסדר התג
  assert.deepEqual(j.auto_template_ids, [BASE, HYD, DOLI]);
  assert.deepEqual(j.type_keys, ["floor:doli", "lift:hydraulic-piston-1", "console:longitudinal"]);
  assert.ok((await start(a)).visit_id, "רובוטי פותח ביקור על הבסיס");
  const m = await newShell();
  const jm = await site(m);
  assert.deepEqual([jm.templates, jm.templates_source, jm.template_count, jm.site.monitored], [[], "none", 0, false]);
  await assert.rejects(start(m), (e) => e.code === "23514" && /לא נבחרה תחזוקה לאתר/.test(e.message));
});

test("בחירה: רובוטי — הבסיס + מה שנבחר, בסדר הרשימות; הבסיס אינו נשמר ואינו יורד", { skip }, async () => {
  const a = await newSite("xy", "hydraulic-piston-1", "electric");
  await choose(a, [XY, ELE, HYD]);   // הסדר שנשלח אינו קובע — סדר הרשימות כן
  assert.deepEqual(await names(a), ["בסיס פרקומט", "מעלית הידראולית", "מעלית חשמלית", "מיטת XY"]);
  assert.equal((await site(a)).templates_source, "explicit");
  assert.equal((await site(a)).templates_assigned, true);
  // הבסיס שנשלח — אינו נשמר, והאתר עדיין מקבל אותו
  await choose(a, [BASE, DOLI, DOLI]);
  assert.deepEqual(await stored(a), [DOLI], "בלי הבסיס ובלי כפילות");
  assert.deepEqual(await names(a), ["בסיס פרקומט", "דולי"]);
  // "לבטל הכול" — חזרה לבסיס בלבד
  await choose(a, []);
  assert.deepEqual([await names(a), (await site(a)).templates_source], [["בסיס פרקומט"], "base"]);
  // שורת בסיס ישנה (לפני 20/10) אינה קובעת — וגם אינה נספרת כ"נבחר"
  await h.pg.query(`INSERT INTO pm_site_templates (site_id, template_id) SELECT id, $2 FROM sites WHERE code = $1`, [a, BASE]);
  assert.equal((await site(a)).templates_source, "base");
  assert.equal((await site(a)).templates_assigned, false);
});

test("מכפיל: רק מה שנבחר — הבסיס לא, גם אם נשלח, וגם משורה ישנה", { skip }, async () => {
  const m = await newShell();
  await choose(m, [BASE, MX]);
  assert.deepEqual(await names(m), ["מכפילים"]);
  assert.deepEqual(await stored(m), [MX]);
  assert.equal((await site(m)).templates_source, "explicit");
  const v = await start(m);
  const labels = (await h.pg.query(`SELECT label FROM pm_visit_items WHERE visit_id = $1 ORDER BY seq`, [v.visit_id])).rows.map((r) => r.label);
  assert.deepEqual(labels, ["מכפיל"]);
  // שורת בסיס שנכתבה ידנית (כמו 1206 בייצור) — הפותר מתעלם ממנה
  await h.pg.query(`INSERT INTO pm_site_templates (site_id, template_id) SELECT id, $2 FROM sites WHERE code = $1`, [m, BASE]);
  assert.deepEqual(await names(m), ["מכפילים"]);
  await choose(m, []);
  assert.deepEqual([await names(m), (await site(m)).templates_source], [[], "none"]);
});

test("הסוג והפרופיל אינם קובעים עוד: שינוי סוג, שינוי סיווג ופרופיל — הרשימות לא זזות, ואין אירועי סיווג", { skip }, async () => {
  const a = await newSite("doli", "hydraulic-piston-1");
  await rpc(MGR, `SELECT public.update_site($1, NULL, NULL, NULL, 'xy', NULL, NULL, 'electric', 'transverse', NULL, NULL)`, [a]);
  assert.deepEqual(await names(a), ["בסיס פרקומט"]);
  assert.deepEqual((await site(a)).auto_template_ids, [BASE, ELE, XY], "הרמז עוקב אחרי הסוג");
  const ev0 = (await h.pg.query(`SELECT count(*)::int n FROM events WHERE type = 'compliance'`)).rows[0].n;
  await meta(ELE, "lift", ["lift:electric", "lift:four-post-18kw", "lift:four-post-11kw", "lift:serapid"]);
  assert.equal((await h.pg.query(`SELECT count(*)::int n FROM events WHERE type = 'compliance'`)).rows[0].n, ev0,
    "הסיווג כבר אינו משנה למי הרשימה מגיעה — בלי אירוע לכל אתר");
  const l = (await lists()).find((t) => t.id === ELE);
  assert.deepEqual(l.auto_for, ["lift:electric", "lift:four-post-11kw", "lift:four-post-18kw", "lift:serapid"], "ממוין וייחודי");
  const pid = (await one(MGR, `SELECT public.pm_profile_save(NULL, 'פרופיל ישן', $1::int[], NULL, $2::text[]) id`, [[BASE, ELE, DOLI], [a]])).id;
  assert.ok(pid);
  assert.deepEqual(await names(a), ["בסיס פרקומט"], "פרופיל — לא");
});

test("pm_template_meta_set — ולידציה: קטגוריה, צורת המפתחות, ברירת המחדל בלי סיווג, בקר לא", { skip }, async () => {
  await assert.rejects(meta(HYD, "lifts", []), /קטגוריה לא מוכרת/);
  await assert.rejects(meta(HYD, "lift", ["hydraulic-piston-1"]), /מפתח סוג לא תקין/);
  await assert.rejects(meta(HYD, "lift", ["lift:bad key"]), /מפתח סוג לא תקין/);
  await assert.rejects(meta(BASE, "lift", []), /ברירת המחדל/);
  await assert.rejects(meta(BASE, "base", ["floor:xy"]), /ברירת המחדל/);
  await rpc(MGR, `SELECT public.pm_template_meta_set($1, 'base', '{}'::text[])`, [BASE]);   // מותר: base בלי מפתחות
  await assert.rejects(meta(HYD, "lift", ["lift:electric"], OPR), /בקר יכול רק לצפות/);
  await assert.rejects(meta(999999, "lift", []), /לא נמצאה/);
  assert.deepEqual((await lists()).find((t) => t.id === HYD).auto_for, ["lift:hydraulic-piston-1", "lift:hydraulic-piston-2"]);
  await assert.rejects(choose(await newSite(), [HYD], OPR), /בקר יכול רק לצפות/);
});

// 19/10/2026: בעלת המוצר, על התג "XY · ביטנקם · הידראולית בוכנה 1 · קונזול אורכי" — "צריך בתחזוקה לראות שיש מענה גם
// לביטנקם… קונזול אורכי". המערכת והקונזול הם מפתחות סוג; type_coverage אומר לכל מאפיין איזו רשימה מתאימה ואם נבחרה.
test("מערכת וקונזול: מפתחות סוג בסדר התג, וכיסוי לכל מאפיין — assigned לפי מה שנבחר", { skip }, async () => {
  const a = await newSite("xy", "hydraulic-piston-1", null, { system: "ביטנקם" });
  let j = await site(a);
  assert.deepEqual(j.type_keys, ["floor:xy", "system:ביטנקם", "lift:hydraulic-piston-1", "console:longitudinal"]);
  const cover = (x) => x.type_coverage.map((c) => [c.key, c.lists.map((l) => `${l.name}${l.assigned ? "" : "×"}`)]);
  // לא נבחר כלום — הרשימות המתאימות מוצגות, ולא משויכות
  assert.deepEqual(cover(j), [
    ["floor:xy", ["מיטת XY×"]],
    ["system:ביטנקם", []],
    ["lift:hydraulic-piston-1", ["מעלית הידראולית×"]],
    ["console:longitudinal", []],
  ]);
  await choose(a, [HYD, XY]);
  j = await site(a);
  assert.deepEqual(cover(j)[0], ["floor:xy", ["מיטת XY"]]);
  assert.deepEqual(cover(j)[2], ["lift:hydraulic-piston-1", ["מעלית הידראולית"]]);
  // שתי מעליות עם אותו קונזול — שורה אחת לקונזול, וסדר המופע הראשון
  const two = await newSite("doli", "hydraulic-piston-1", "electric", { system: "לולק" });
  j = await site(two);
  assert.deepEqual(j.type_keys, ["floor:doli", "system:לולק", "lift:hydraulic-piston-1", "console:longitudinal", "lift:electric", "console:longitudinal"]);
  assert.deepEqual(j.type_coverage.map((c) => c.key), ["floor:doli", "system:לולק", "lift:hydraulic-piston-1", "console:longitudinal", "lift:electric"]);
  // רשימה שמסווגת למערכת מופיעה ברמז — ולא מגיעה מעצמה
  const BIT = await createList("ביטנקם — בקר"); await saveItems(BIT, [{ label: "בקר ביטנקם", kind: "check", required: true }]);
  await meta(BIT, "other", ["system:ביטנקם", "console:longitudinal"]);
  assert.deepEqual(await names(a), ["בסיס פרקומט", "מעלית הידראולית", "מיטת XY"], "הסיווג אינו מוסיף רשימה");
  j = await site(a);
  assert.deepEqual(j.type_coverage.find((c) => c.key === "system:ביטנקם").lists.map((l) => [l.name, l.assigned]), [["ביטנקם — בקר", false]]);
  await choose(a, [HYD, XY, BIT]);
  j = await site(a);
  assert.deepEqual(j.type_coverage.find((c) => c.key === "system:ביטנקם").lists.map((l) => [l.name, l.assigned]), [["ביטנקם — בקר", true]]);
  // ולידציה: מערכת בעברית מותרת; ריק, רווח, נקודתיים, או קונזול בעברית — לא
  await assert.rejects(meta(BIT, "other", ["system:"]), /מפתח סוג לא תקין/);
  await assert.rejects(meta(BIT, "other", ["system:ביט נקם"]), /מפתח סוג לא תקין/);
  await assert.rejects(meta(BIT, "other", ["system:a:b"]), /מפתח סוג לא תקין/);
  await assert.rejects(meta(BIT, "other", ["console:אורכי"]), /מפתח סוג לא תקין/);
  await assert.rejects(meta(BIT, "other", ["model:xy"]), /מפתח סוג לא תקין/);
  await meta(BIT, "other", ["system:סוטפין-לולק"]);
  assert.deepEqual((await lists()).find((t) => t.id === BIT).auto_for, ["system:סוטפין-לולק"]);
  await meta(BIT, "other", []);
});

test("pm_templates_list.site_count — האתרים שהרשימה נבחרה להם, והבסיס — לכל רובוטי", { skip }, async () => {
  const count = async () => Object.fromEntries((await lists()).map((t) => [t.id, t.site_count]));
  const before = await count();
  const a = await newSite("xy", "hydraulic-piston-1");
  const m = await newShell();
  let now = await count();
  assert.equal(now[BASE], before[BASE] + 1, "הבסיס: הרובוטי נספר, המכפיל לא");
  assert.equal(now[HYD], before[HYD], "הידראולית: הסוג לבדו אינו נספר");
  await choose(a, [HYD]);
  await choose(m, [MX]);
  now = await count();
  assert.equal(now[HYD], before[HYD] + 1);
  assert.equal(now[MX], before[MX] + 1);
  // ובדיקה מול הפותר עצמו, לכל רשימה
  const real = (await h.pg.query(`SELECT x.tid, count(*)::int n FROM sites s, unnest(app.pm_site_template_ids(s.id)) x(tid) GROUP BY x.tid`)).rows;
  for (const t of await lists()) assert.equal(t.site_count, real.find((r) => r.tid === t.id)?.n ?? 0, t.name);
  // ⚠️ הפותר רץ פעם אחת לכל אתר — לא לכל אתר × רשימה (בלי MATERIALIZED: 4.0 שניות במקום 0.4 בייצור, 19/10/2026)
  const oid = (await h.pg.query(`SELECT 'app.pm_site_template_ids(integer)'::regprocedure::oid o`)).rows[0].o;
  const nSites = (await h.pg.query(`SELECT count(*)::int n FROM sites`)).rows[0].n;
  const nLists = (await lists()).length;
  await h.pg.exec(`SET track_functions = 'all'`);
  try {
    const calls = await h.as("authenticated", MGR, async (tx) => {
      const q = `SELECT COALESCE(pg_stat_get_xact_function_calls($1), 0)::int c`;
      const b = (await tx.query(q, [oid])).rows[0].c;
      await tx.query(`SELECT public.pm_templates_list()`);
      return (await tx.query(q, [oid])).rows[0].c - b;
    });
    assert.ok(nLists > 2 && calls === nSites, `pm_site_template_ids: ${calls} קריאות ל-${nSites} אתרים ו-${nLists} רשימות`);
  } finally {
    await h.pg.exec(`RESET track_functions`);
  }
});

test("תקרת 40 התמונות: הבסיס נספר לרובוטי ולא למכפיל — בבחירה ובשמירת הבסיס", { skip }, async () => {
  const photos = (n, last) => Array.from({ length: n }, (_, i) => ({ label: `צילום ${i + 1}`, kind: "photo", required: true, min_photos: 6 }))
    .concat(last ? [{ label: "צילום אחרון", kind: "photo", required: true, min_photos: last }] : []);
  const P = await createList("צילומים 40"); await saveItems(P, photos(6, 4));    // 40
  const Q = await createList("צילומים 39"); await saveItems(Q, photos(6, 3));    // 39
  const base = (n) => saveItems(BASE, [{ label: "בסיס", kind: "check", required: true }]
    .concat(n ? [{ label: "צילום לובי", kind: "photo", required: true, min_photos: n }] : []));
  await base(1);
  const m = await newShell(), r = await newSite();
  try {
    await assert.rejects(choose(await newSite(), [P]), (e) => e.code === "23514" && /41/.test(e.message), "רובוטי: 40 + הבסיס");
    await choose(m, [P]);   // מכפיל: 40 בדיוק — מותר, כי אין לו בסיס
    assert.deepEqual(await names(m), ["צילומים 40"]);
    await choose(r, [Q]);   // רובוטי: 39 + 1 = 40 — מותר
    // הגדלת הבסיס מעבירה את r את 40 — השמירה נדחית בשמו; המכפיל, בלי בסיס, אינו נפגע
    await assert.rejects(base(2), (e) => e.code === "23514" && e.message.includes(`משויכת לאתר ${r}`));
  } finally {
    await choose(m, []); await choose(r, []);
    await base(0);
  }
});

test("הקובץ אידמפוטנטי — העמודות והאילוץ שורדים החלה שנייה", { skip }, async () => {
  const fs = require("node:fs"), path = require("node:path");
  await h.pg.exec(fs.readFileSync(path.join(__dirname, "..", "db", "compliance.postgres.sql"), "utf8"));
  const cols = (await h.pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'pm_templates' AND column_name IN ('category','auto_for')`)).rows;
  assert.equal(cols.length, 2);
  assert.deepEqual((await lists()).find((t) => t.id === XY).auto_for, ["floor:xy"]);
});
