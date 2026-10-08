// tests/pm-templates.test.js — רשימות תחזוקה: משותפת, לפי סוג מתקן, לסוטפין — ושיוך לאתר (07/10/2026).
//
// בעלת המוצר: "יש דברים שמשותפים כמעט לכל האתרים, ויש פעולות תחזוקה שרלוונטיות לסוג המתקן",
// ולאתר חדש — "כמו פרויקט אחר". ⚠️ הדבר החשוב ביותר כאן הוא מה **שלא** השתנה: אתר בלי
// שיוך מקבל את רשימת ברירת המחדל, שהיא בדיוק הרשימה הגלובלית של קודם.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "c1000000-0000-0000-0000-000000000001";
const OPR = "c1000000-0000-0000-0000-000000000002";
const OFF = "c1000000-0000-0000-0000-000000000003";

let h;
let seq = 0;
const sup = async (sql, p = []) => (await h.pg.query(sql, p)).rows;
const rpc = async (uid, sql, p = []) => (await h.as("authenticated", uid, (tx) => tx.query(sql, p))).rows;
const one = async (uid, sql, p = []) => (await rpc(uid, sql, p))[0];
async function fails(p, code, re) {
  await assert.rejects(p, (e) => {
    if (code) assert.equal(e.code, code, `ציפיתי ל-${code}, התקבל ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
}
async function newSite() {
  const code = `PMT${++seq}`;
  await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready','2026-01-01T00:00:00.000Z')`, [code]);
  return code;
}
const list = () => one(MGR, `SELECT public.pm_templates_list() j`).then((r) => r.j);
const tpl = (id = null) => one(MGR, `SELECT public.pm_template($1) j`, [id]).then((r) => r.j);
const token = async (id = null) => {
  const items = await tpl(id);
  return items.reduce((m, i) => (i.updated_at > m ? i.updated_at : m), "");
};
const save = async (items, id = null, uid = MGR) =>
  (await one(uid, `SELECT public.pm_template_save($1::jsonb, $2, $3) n`, [JSON.stringify(items), await token(id), id])).n;
const create = (name, uid = MGR) => one(uid, `SELECT public.pm_template_create($1) id`, [name]).then((r) => r.id);
const assign = (code, ids, uid = MGR) => one(uid, `SELECT public.pm_site_templates_set($1, $2::int[]) n`, [code, ids]);
const site = (code) => one(OPR, `SELECT public.pm_site($1) j`, [code]).then((r) => r.j);
const start = (code, restart = false) =>
  one(OPR, `SELECT visit_id::int, created FROM public.pm_visit_start($1, $2)`, [code, restart]);
const items = (visitId) => sup(`SELECT seq, label FROM pm_visit_items WHERE visit_id = $1 ORDER BY seq`, [visitId]);
const check = (label) => ({ label, kind: "check", required: true });
const photo = (label, n) => ({ label, kind: "photo", required: true, min_photos: n });

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
      ('pmt-mgr@parkomat.co.il','מנהלת רשימות','manager',true,$1,$4),
      ('pmt-op@parkomat.co.il','טכנאי','operator',true,$2,$4),
      ('pmt-off@parkomat.co.il','מושבת','operator',false,$3,$4)`, [MGR, OPR, OFF, now]);
});
after(async () => { if (h) await h.close(); });

test("הטבלאות החדשות סגורות — אין קריאה ישירה, גם לא למשתמש פעיל", { skip }, async () => {
  for (const t of ["pm_templates", "pm_site_templates"]) {
    await fails(h.as("authenticated", OPR, (tx) => tx.query(`SELECT * FROM ${t}`)), "42501");
    await fails(h.as("anon", null, (tx) => tx.query(`SELECT * FROM ${t}`)), "42501");
  }
});

test("⚠️ בלי שיוך — בדיוק כמו קודם: רשימה אחת, 'משותף', וכל האתרים מקבלים אותה", { skip }, async () => {
  const l = await list();
  assert.equal(l.length, 1);
  assert.deepEqual([l[0].name, l[0].is_default], ["משותף", true]);
  // הקריאות הישנות, בלי מזהה רשימה, עובדות על ברירת המחדל
  assert.equal((await one(MGR, `SELECT public.pm_template_save($1::jsonb) n`,
    [JSON.stringify([check("בדיקת שמן"), check("ניקוי מסילות")])])).n, 2);
  assert.equal((await one(MGR, `SELECT jsonb_array_length(public.pm_template()) n`)).n, 2);
  const code = await newSite();
  const s = await site(code);
  assert.deepEqual(s.templates.map((t) => t.name), ["משותף"]);
  assert.equal(s.templates_assigned, false);
  assert.equal(s.template_count, 2);
  const v = await start(code);
  assert.deepEqual((await items(v.visit_id)).map((i) => [i.seq, i.label]), [[1, "בדיקת שמן"], [2, "ניקוי מסילות"]]);
});

test("רשימה לכל סוג: שמירה של אחת אינה נוגעת באחרת, ופריט מרשימה אחרת נדחה", { skip }, async () => {
  const doli = await create("דולי");
  const sot = await create("סוטפין");
  assert.equal(await save([check("שימון שרשרת דולי"), photo("צילום מנוע דולי", 1)], doli), 2);
  assert.equal(await save([check("בדיקת לוח סוטפין")], sot), 1);
  assert.equal((await tpl()).length, 2, "רשימת ברירת המחדל לא השתנתה");
  // פריט של 'דולי' שנשלח לשמירה של 'סוטפין' — לא עובר אליה בשקט
  const foreign = (await tpl(doli))[0];
  await fails(one(MGR, `SELECT public.pm_template_save($1::jsonb, NULL, $2) n`,
    [JSON.stringify([{ ...foreign }]), sot]), "PT404", /ברשימה הזו/);
  const l = await list();
  assert.deepEqual(l.map((t) => [t.name, t.item_count]), [["משותף", 2], ["דולי", 2], ["סוטפין", 1]]);
});

test("⚠️ גרסה ישנה נדחית — לכל רשימה בנפרד", { skip }, async () => {
  const doli = (await list()).find((t) => t.name === "דולי").id;
  const stale = await token(doli);
  await save([check("שימון שרשרת דולי"), photo("צילום מנוע דולי", 1), check("בדיקת חיישן")], doli);
  await fails(one(MGR, `SELECT public.pm_template_save($1::jsonb, $2, $3) n`,
    [JSON.stringify([check("x x")]), stale, doli]), "PT409");
  // שמירה של רשימה אחרת עם הטוקן **שלה** — עוברת, גם אחרי ששמרו את 'דולי'
  assert.equal(await save([check("בדיקת שמן"), check("ניקוי מסילות")]), 2);
});

test("שמות: ייחודיים בלי רגישות לרווחים, ושינוי שם", { skip }, async () => {
  await fails(create("  סוטפין "), "PT409");
  const id = await create("שאטל");
  await one(MGR, `SELECT public.pm_template_rename($1, $2)`, [id, "שאטל X"]);
  assert.ok((await list()).some((t) => t.name === "שאטל X"));
  await fails(one(MGR, `SELECT public.pm_template_rename($1, $2)`, [id, "דולי"]), "PT409");
  await fails(create("א"), "23514");
});

test("⚠️ שיוך: האתר מקבל משותף + דולי, בסדר הרשימות, ממוספר ברצף — ואתר אחר לא מושפע", { skip }, async () => {
  const l = await list();
  const common = l.find((t) => t.is_default).id;
  const doli = l.find((t) => t.name === "דולי").id;
  const a = await newSite();
  const b = await newSite();
  await assign(a, [doli, common]);   // הסדר שנשלח לא קובע — הסדר של הרשימות כן
  const s = await site(a);
  assert.deepEqual(s.templates.map((t) => t.name), ["משותף", "דולי"]);
  assert.equal(s.templates_assigned, true);
  assert.equal(s.template_count, 5);
  const v = await start(a);
  assert.deepEqual((await items(v.visit_id)).map((i) => [i.seq, i.label]), [
    [1, "בדיקת שמן"], [2, "ניקוי מסילות"],
    [3, "שימון שרשרת דולי"], [4, "צילום מנוע דולי"], [5, "בדיקת חיישן"]]);
  assert.deepEqual((await site(b)).templates.map((t) => t.name), ["משותף"], "האתר השני — עדיין רק ברירת המחדל");
});

test("'כמו אתר אחר': קוראים את הרשימות שלו ושולחים — וריק מחזיר לברירת המחדל", { skip }, async () => {
  const l = await list();
  const sot = l.find((t) => t.name === "סוטפין").id;
  const src = await newSite();
  const dst = await newSite();
  await assign(src, [sot]);
  const ids = (await site(src)).templates.map((t) => t.id);
  await assign(dst, ids);
  assert.deepEqual((await site(dst)).templates.map((t) => t.name), ["סוטפין"]);
  await assign(dst, []);
  const back = await site(dst);
  assert.deepEqual([back.templates.map((t) => t.name), back.templates_assigned], [["משותף"], false]);
});

test("⚠️ ביקור שכבר נפתח אינו משתנה כשמשנים את השיוך", { skip }, async () => {
  const l = await list();
  const sot = l.find((t) => t.name === "סוטפין").id;
  const code = await newSite();
  const v = await start(code);
  const before = await items(v.visit_id);
  await assign(code, [sot]);
  assert.deepEqual(await items(v.visit_id), before);
  const again = await start(code);
  assert.equal(again.created, false, "אותה טיוטה");
});

test("תקרת 40 תמונות — על כל הרשימות של האתר יחד, בשיוך ובפתיחה", { skip }, async () => {
  const big = await create("צילום רב");
  const extra = await create("צילום נוסף");
  await save(Array.from({ length: 6 }, (_, i) => photo(`צילום ${i + 1}`, 6)), big);   // 36
  await save([photo("צילום א", 3)], extra);                                         // 3 → 39
  const code = await newSite();
  await assign(code, [big, extra]);
  await save([photo("צילום א", 6)], extra);   // כל רשימה ≤ 40, אבל יחד 42
  await fails(start(code), "23514", /40/);
  await fails(assign(await newSite(), [big, extra]), "23514", /40/);
});

test("הרשאות: בקר קורא ואינו משנה; משתמש מושבת — לא כלום", { skip }, async () => {
  const code = await newSite();
  const anyId = (await list())[0].id;
  assert.ok(Array.isArray((await one(OPR, `SELECT public.pm_templates_list() j`)).j));
  assert.ok(Array.isArray((await one(OPR, `SELECT public.pm_template($1) j`, [anyId])).j));
  await fails(create("ניסיון", OPR), "42501");
  await fails(one(OPR, `SELECT public.pm_template_rename($1, 'שם אחר')`, [anyId]), "42501");
  await fails(one(OPR, `SELECT public.pm_template_save('[]'::jsonb, NULL, $1)`, [anyId]), "42501");
  await fails(assign(code, [anyId], OPR), "42501");
  await fails(one(OFF, `SELECT public.pm_templates_list() j`), "42501");
});

test("רשימה שלא קיימת — PT404 בכל מקום", { skip }, async () => {
  await fails(tpl(99999), "PT404");
  await fails(one(MGR, `SELECT public.pm_template_save('[]'::jsonb, NULL, 99999)`), "PT404");
  await fails(one(MGR, `SELECT public.pm_template_rename(99999, 'שם')`), "PT404");
  await fails(assign(await newSite(), [99999]), "PT404");
});

test("יומן הפעולות הכללי — מזהים וספירות בלבד, בלי שמות רשימות (D22)", { skip }, async () => {
  const rows = await sup(`SELECT details::text d FROM audit_log WHERE action LIKE 'pm.template%' OR action = 'pm.site_templates_set'`);
  assert.ok(rows.length >= 5, `נרשמו ${rows.length}`);
  for (const r of rows) for (const name of ["דולי", "סוטפין", "שאטל", "משותף", "צילום"]) {
    assert.ok(!r.d.includes(name), `השם "${name}" ביומן: ${r.d}`);
  }
});

// ---------------- קבוצות בתוך רשימה (07/10/2026) ----------------
// במסמך סוטפין: "4 שורות לביצוע הטכנאי — מעלית, שאטל, דולי, לובי… אם ביצע את כולם השורה
// ירוקה". הקבוצה היא שדה של הפריט; ביקור מצלם אותה, ופריט בלי קבוצה מקבל את שם הרשימה.
const sec = (label, section) => ({ ...check(label), section });

test("קבוצות: נשמרות ונקראות; רווחים בלבד = בלי קבוצה; ארוכה מ-60 נדחית", { skip }, async () => {
  const id = await create("קבוצות");
  await save([sec("בדיקת לחץ", "  יחידת כוח "), sec("נזילות", "יחידת כוח"), sec("חבקים", "בוכנה"), sec("כללי", "   ")], id);
  assert.deepEqual((await tpl(id)).map((t) => [t.label, t.section]),
    [["בדיקת לחץ", "יחידת כוח"], ["נזילות", "יחידת כוח"], ["חבקים", "בוכנה"], ["כללי", null]]);
  await fails(save([sec("ארוכה", "א".repeat(61))], id), "23514", /קבוצה/);
  assert.equal((await tpl(id)).length, 4, "השמירה שנדחתה לא נגעה ברשימה");
  // גם כתיבה שעוקפת את הפונקציה נעצרת ב-CHECK — קבוצה ריקה אינה קבוצה
  await fails(sup(`INSERT INTO pm_checklist_items (template_id, seq, label, kind, required, min_photos, section, updated_at, updated_by)
                   VALUES ($1, 9, 'עקיפה', 'check', true, 0, '  ', 'x', 'x')`, [id]), "23514");
});

test("⚠️ ביקור: כל פריט בקבוצה — שלו, או שם הרשימה; שינוי אחר כך אינו מזיז ביקור פתוח", { skip }, async () => {
  const l = await list();
  const def = l.find((t) => t.is_default);
  const id = l.find((t) => t.name === "קבוצות").id;
  const defItems = await tpl(null);
  const code = await newSite();
  await assign(code, [def.id, id]);
  const v = await start(code);
  const want = [...defItems.map((i) => [i.label, def.name]),
    ["בדיקת לחץ", "יחידת כוח"], ["נזילות", "יחידת כוח"], ["חבקים", "בוכנה"], ["כללי", "קבוצות"]];
  const snap = () => sup(`SELECT label, section FROM pm_visit_items WHERE visit_id = $1 ORDER BY seq`, [v.visit_id]);
  assert.deepEqual((await snap()).map((r) => [r.label, r.section]), want);
  // מה שהדפדפן מקבל — בטיוטה (pm_site) ובפירוט (pm_visit_detail)
  assert.deepEqual((await site(code)).draft.items.map((i) => [i.label, i.section]), want);
  const d = (await one(OPR, `SELECT public.pm_visit_detail($1) j`, [v.visit_id])).j;
  assert.deepEqual(d.items.map((i) => [i.label, i.section]), want);
  // שינוי שם קבוצה ושם רשימה אחרי הפתיחה — הביקור הפתוח נשאר כמו שצולם
  const cur = await tpl(id);
  await save(cur.map((t) => ({ id: t.id, label: t.label, kind: t.kind, required: t.required, section: t.section && `${t.section} חדש` })), id);
  await one(MGR, `SELECT public.pm_template_rename($1, $2)`, [id, "קבוצות 2"]);
  assert.deepEqual((await snap()).map((r) => [r.label, r.section]), want);
  // וביקור חדש כבר רואה את השמות החדשים
  const v2 = await start(code, true);
  const got = await sup(`SELECT section FROM pm_visit_items WHERE visit_id = $1 ORDER BY seq`, [v2.visit_id]);
  assert.deepEqual(got.slice(-4).map((r) => r.section), ["יחידת כוח חדש", "יחידת כוח חדש", "בוכנה חדש", "קבוצות 2"]);
});
