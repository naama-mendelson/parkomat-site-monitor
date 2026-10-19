// tests/pm-profiles.test.js — פרופילי תחזוקה, "כמו ברמזור" (13/10/2026).
//
// בעלת המוצר: "כיון שיש תחזוקה שמתאימה להרבה אתרים אותו דבר — שנקשר את האתר לתחזוקה שמתאימה
// לו כמו ברמזור". פרופיל = שם + רשימות + אתרים; אתר בפרופיל אחד. ⚠️ מה שחייב להישאר: אתר בלי
// פרופיל מקבל בדיוק מה שקיבל קודם (שיוך ישן, או ברירת המחדל), וביקור פתוח אינו משתנה.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "c2000000-0000-0000-0000-000000000001";
const OPR = "c2000000-0000-0000-0000-000000000002";   // 19/10/2026: עורך
const RO = "c2000000-0000-0000-0000-000000000003";    // בקר — צפייה בלבד

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
  const code = `PPF${++seq}`;
  await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready','2026-01-01T00:00:00.000Z')`, [code]);
  return code;
}
const tplItems = (id = null) => one(MGR, `SELECT public.pm_template($1) j`, [id]).then((r) => r.j);
const token = async (id) => (await tplItems(id)).reduce((m, i) => (i.updated_at > m ? i.updated_at : m), "");
const saveList = async (items, id) => one(MGR, `SELECT public.pm_template_save($1::jsonb, $2, $3) n`, [JSON.stringify(items), await token(id), id]);
const createList = (name) => one(MGR, `SELECT public.pm_template_create($1) id`, [name]).then((r) => r.id);
const listing = (uid = MGR) => one(uid, `SELECT public.pm_profiles_list() j`).then((r) => r.j);
const prof = (name) => listing().then((l) => l.profiles.find((p) => p.name === name));
const saveProfile = (id, name, ids, expected = null, uid = MGR) =>
  one(uid, `SELECT public.pm_profile_save($1, $2, $3::int[], $4) id`, [id, name, ids, expected]).then((r) => r.id);
const setSites = (id, codes, uid = MGR) => one(uid, `SELECT public.pm_profile_sites_set($1, $2::text[]) n`, [id, codes]).then((r) => r.n);
const setSiteProfile = (code, id, uid = MGR) => rpc(uid, `SELECT public.pm_site_profile_set($1, $2)`, [code, id]);
const delProfile = (id, uid = MGR, expected = null) =>
  one(uid, `SELECT public.pm_profile_delete($1, $2) n`, [id, expected]).then((r) => r.n);
const site = (code) => one(OPR, `SELECT public.pm_site($1) j`, [code]).then((r) => r.j);
const listNames = async (code) => (await site(code)).templates.map((t) => t.name);
const check = (label) => ({ label, kind: "check", required: true });
const photo = (label, n) => ({ label, kind: "photo", required: true, min_photos: n });

let BASE, HYD, DOLLY, DEF;
before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
      ('ppf-mgr@parkomat.co.il','מנהלת פרופילים','manager',true,$1,$3),
      ('ppf-op@parkomat.co.il','טכנאי','editor',true,$2,$3),
      ('ppf-ro@parkomat.co.il','בקר','operator',true,$4,$3)`, [MGR, OPR, now, RO]);
  DEF = (await sup(`SELECT id FROM pm_templates WHERE is_default`))[0].id;
  await saveList([check("ברירת מחדל 1")], DEF);
  BASE = await createList("בסיס פרקומט");
  await saveList([check("לובי"), check("חשמל")], BASE);
  HYD = await createList("מעלית הידראולית");
  await saveList([check("שמן"), check("בוכנה")], HYD);
  DOLLY = await createList("דולי");
  await saveList([check("גלגלים")], DOLLY);
});
after(async () => { if (h) await h.close(); });

test("הטבלאות החדשות סגורות — אין קריאה ישירה, גם לא למשתמש פעיל", { skip }, async () => {
  for (const t of ["pm_profiles", "pm_profile_templates", "pm_profile_sites"]) {
    await fails(h.as("authenticated", OPR, (tx) => tx.query(`SELECT * FROM ${t}`)), "42501");
    await fails(h.as("anon", null, (tx) => tx.query(`SELECT * FROM ${t}`)), "42501");
  }
});

test("אתר בפרופיל מקבל את רשימות הפרופיל, לפי הסדר שלהן; אתר בלי פרופיל — כמו קודם", { skip }, async () => {
  const a = await newSite(), b = await newSite(), c = await newSite();
  const id = await saveProfile(null, "פרקומט – הידראולית + דולי", [DOLLY, HYD, BASE]);
  assert.equal(await setSites(id, [a, b]), 2);
  assert.deepEqual(await listNames(a), ["בסיס פרקומט", "מעלית הידראולית", "דולי"], "סדר הרשימות (seq), לא סדר הבחירה");
  const s = await site(a);
  assert.deepEqual(s.profile, { id, name: "פרקומט – הידראולית + דולי" });
  assert.equal(s.templates_assigned, true);
  assert.equal(s.template_count, 5);
  // בלי פרופיל — ברירת המחדל, בדיוק כמו לפני הפרופילים
  const sc = await site(c);
  assert.equal(sc.profile, null);
  assert.deepEqual(sc.templates.map((t) => t.name), ["משותף"]);
  assert.equal(sc.templates_assigned, false);
  // ביקור שנפתח מצלם את רשימות הפרופיל
  const v = await one(OPR, `SELECT visit_id::int FROM public.pm_visit_start($1)`, [a]);
  const labels = (await sup(`SELECT label FROM pm_visit_items WHERE visit_id = $1 ORDER BY seq`, [v.visit_id])).map((r) => r.label);
  assert.deepEqual(labels, ["לובי", "חשמל", "שמן", "בוכנה", "גלגלים"]);
});

test("⚠️ שינוי רשימה בפרופיל חל מיד על כל האתרים שבו — וביקור פתוח אינו משתנה", { skip }, async () => {
  const a = await newSite(), b = await newSite();
  const id = await saveProfile(null, "פרופיל משתנה", [BASE]);
  await setSites(id, [a, b]);
  const v = await one(OPR, `SELECT visit_id::int FROM public.pm_visit_start($1)`, [a]);
  const p = await prof("פרופיל משתנה");
  await saveProfile(id, "פרופיל משתנה", [BASE, DOLLY], p.updated_at);
  assert.deepEqual(await listNames(a), ["בסיס פרקומט", "דולי"]);
  assert.deepEqual(await listNames(b), ["בסיס פרקומט", "דולי"]);
  const n = (await sup(`SELECT count(*)::int n FROM pm_visit_items WHERE visit_id = $1`, [v.visit_id]))[0].n;
  assert.equal(n, 2, "הביקור הפתוח נשאר עם מה שצולם בפתיחה");
});

test("⚠️ שיוך ידני לאתר גובר על הפרופיל (15/10/2026 — עד אז הפרופיל גבר); ניקוי הידני מחזיר את הפרופיל", { skip }, async () => {
  // בעלת המוצר: "מלכתחילה תשים לכל אתר את מה שמתאים לו, ואפשר יהיה להוסיף ולשנות" — השינוי באתר הוא ההחלטה האחרונה
  const a = await newSite();
  await rpc(MGR, `SELECT public.pm_site_templates_set($1, $2::int[])`, [a, [HYD]]);
  assert.deepEqual(await listNames(a), ["מעלית הידראולית"]);
  const id = await saveProfile(null, "גובר על ישן", [BASE]);
  await setSiteProfile(a, id);
  assert.deepEqual(await listNames(a), ["מעלית הידראולית"], "הידני נשאר גם אחרי שיוך לפרופיל");
  assert.equal((await site(a)).templates_source, "explicit");
  await rpc(MGR, `SELECT public.pm_site_templates_set($1, $2::int[])`, [a, []]);
  assert.deepEqual(await listNames(a), ["בסיס פרקומט"], "בלי ידני — הפרופיל");
  assert.equal((await site(a)).templates_source, "profile");
  await setSiteProfile(a, null);
  assert.deepEqual(await listNames(a), ["משותף"], "בלי פרופיל — רשימת ברירת המחדל (בקובץ הזה שמה 'משותף')");
  assert.equal((await site(a)).templates_source, "default");
  assert.equal((await site(a)).profile, null);
});

test("אתר בפרופיל אחד: הוספה לפרופיל אחר מעבירה אותו; הסרה מחזירה לברירת המחדל", { skip }, async () => {
  const a = await newSite(), b = await newSite();
  const p1 = await saveProfile(null, "ראשון", [BASE]);
  const p2 = await saveProfile(null, "שני", [HYD]);
  await setSites(p1, [a, b]);
  await setSites(p2, [a]);                                     // a עובר
  const l = await listing();
  assert.deepEqual(l.profiles.find((p) => p.id === p1).sites.map((s) => s.code), [b]);
  assert.deepEqual(l.profiles.find((p) => p.id === p2).sites.map((s) => s.code), [a]);
  assert.deepEqual(await listNames(a), ["מעלית הידראולית"]);
  await setSites(p1, []);                                      // b יוצא
  assert.deepEqual(await listNames(b), ["משותף"]);
  assert.ok((await listing()).unassigned.some((s) => s.code === b), "b בשורה 'בלי פרופיל'");
  assert.ok(!(await listing()).unassigned.some((s) => s.code === a));
  // אותו אתר פעמיים, רווחים, וקוד ריק — אתר אחד
  assert.equal(await setSites(p1, [` ${b} `, b, ""]), 1);
});

test("קוד אתר לא קיים — PT404, ושום דבר לא נכתב", { skip }, async () => {
  const a = await newSite();
  const id = await saveProfile(null, "קוד שגוי", [BASE]);
  await setSites(id, [a]);
  await fails(setSites(id, [a, "NOPE-1"]), "PT404", /NOPE-1/);
  assert.deepEqual((await prof("קוד שגוי")).sites.map((s) => s.code), [a]);
  await fails(setSiteProfile("NOPE-2", id), "PT404");
  await fails(setSiteProfile(a, 999999), "PT404", /הפרופיל/);
  await fails(setSites(999999, [a]), "PT404", /הפרופיל/);
});

test("מחיקת פרופיל: האתרים חוזרים לברירת המחדל, והרשימות עצמן נשארות", { skip }, async () => {
  const a = await newSite(), b = await newSite();
  const id = await saveProfile(null, "למחיקה", [BASE, HYD]);
  await setSites(id, [a, b]);
  assert.equal(await delProfile(id), 2);
  assert.deepEqual(await listNames(a), ["משותף"]);
  assert.equal(await prof("למחיקה"), undefined);
  assert.equal((await tplItems(BASE)).length, 2, "הרשימה עצמה לא נמחקה");
  await fails(delProfile(id), "PT404");
});

test("שמירה: שם ייחודי (בלי הבדל אותיות/רווחים), לפחות רשימה אחת, ושמירה ישנה נדחית", { skip }, async () => {
  const id = await saveProfile(null, "Sotefin R&P", [BASE]);
  await fails(saveProfile(null, "  sotefin r&p ", [HYD]), "PT409", /כבר קיים/);
  await fails(saveProfile(null, "ריק", []), "23514", /לפחות רשימה/);
  await fails(saveProfile(null, "x", [BASE]), "23514", /2 ל-60/);
  await fails(saveProfile(null, "רשימה חסרה", [BASE, 999999]), "PT404");
  const p = await prof("Sotefin R&P");
  await saveProfile(id, "Sotefin R&P", [BASE, HYD], p.updated_at);
  await fails(saveProfile(id, "Sotefin R&P", [BASE], p.updated_at), "PT409", /עודכן בינתיים/);
  // שינוי שם לשם של עצמו (באותיות אחרות) — מותר
  const p2 = await prof("Sotefin R&P");
  await saveProfile(id, "SOTEFIN R&P", [BASE, HYD], p2.updated_at);
  assert.ok(await prof("SOTEFIN R&P"));
  await fails(saveProfile(424242, "לא קיים", [BASE]), "PT404");
});

test("תקרת 40 התמונות — לכל הרשימות של הפרופיל יחד", { skip }, async () => {
  const L1 = await createList("צילומים א");
  await saveList([photo("א1", 6), photo("א2", 6), photo("א3", 6), photo("א4", 6)], L1);   // 24
  const L2 = await createList("צילומים ב");
  await saveList([photo("ב1", 6), photo("ב2", 6), photo("ב3", 6)], L2);                   // 18
  await fails(saveProfile(null, "יותר מדי תמונות", [L1, L2]), "23514", /40/);
  const id = await saveProfile(null, "בדיוק מספיק", [L1, BASE]);
  assert.equal((await prof("בדיוק מספיק")).photo_count, 24);
  assert.ok(id);
});

test("הרשאות (19/10/2026): בקר קורא את הלוח ואינו כותב; עורך כותב; אנונימי — כלום", { skip }, async () => {
  const a = await newSite();
  const id = await saveProfile(null, "הרשאות", [BASE]);
  assert.ok((await listing(RO)).profiles.length > 0);
  await fails(saveProfile(null, "של בקר", [BASE], null, RO), "42501");
  await fails(setSites(id, [a], RO), "42501");
  await fails(setSiteProfile(a, id, RO), "42501");
  await fails(delProfile(id, RO), "42501");
  // עורך — "עריכה של הכל"
  const mine = await saveProfile(null, "של עורך", [BASE], null, OPR);
  await setSiteProfile(a, mine, OPR);
  await setSiteProfile(a, null, OPR);
  await delProfile(mine, OPR);
  await fails(h.as("anon", null, (tx) => tx.query(`SELECT public.pm_profiles_list()`)), "42501");
});

test("ביקורת: audit_log עם מזהים בלבד; היסטוריה ואירוע לכל אתר שהשתנה", { skip }, async () => {
  const a = await newSite(), b = await newSite();
  const id = await saveProfile(null, "שם שלא ייכתב ל-audit", [BASE]);
  const ev0 = (await sup(`SELECT count(*)::int n FROM events WHERE type = 'compliance'`))[0].n;
  await setSites(id, [a, b]);
  const ev1 = (await sup(`SELECT count(*)::int n FROM events WHERE type = 'compliance'`))[0].n;
  assert.equal(ev1 - ev0, 2, "אירוע לכל אתר שנכנס");
  await setSites(id, [a, b]);                                   // אין שינוי — אין אירועים
  assert.equal((await sup(`SELECT count(*)::int n FROM events WHERE type = 'compliance'`))[0].n, ev1);
  await setSiteProfile(a, id);                                  // אותו פרופיל — אין רישום
  const audits = await sup(`SELECT action, details::text d FROM audit_log WHERE action LIKE 'pm.profile%' OR action = 'pm.site_profile_set'`);
  assert.ok(audits.some((r) => r.action === "pm.profile_save"));
  assert.ok(audits.some((r) => r.action === "pm.profile_sites_set"));
  assert.ok(audits.every((r) => !r.d.includes("שם שלא ייכתב")), "D22: בלי שמות ב-audit");
  const hist = await sup(`SELECT action FROM compliance_history WHERE area = 'pm' AND entity LIKE 'profile%' AND entity_id = $1`, [id]);
  assert.ok(hist.some((r) => r.action === "create") && hist.some((r) => r.action === "set"));
});

test("pm_templates_list: מספר האתרים סופר גם אתרים שמקבלים את הרשימה דרך פרופיל", { skip }, async () => {
  const L = await createList("נספרת דרך פרופיל");
  await saveList([check("x1")], L);
  const a = await newSite(), b = await newSite();
  const id = await saveProfile(null, "סופר אתרים", [L]);
  await setSites(id, [a]);
  await rpc(MGR, `SELECT public.pm_site_templates_set($1, $2::int[])`, [b, [L]]);
  const row = (await one(MGR, `SELECT public.pm_templates_list() j`)).j.find((t) => t.id === L);
  assert.equal(row.site_count, 2);
});

test("רשימה שהושבתה יוצאת מהפרופיל; כשכל רשימות הפרופיל מושבתות — ברירת המחדל", { skip }, async () => {
  const L1 = await createList("תושבת א");
  await saveList([check("ת1")], L1);
  const L2 = await createList("תושבת ב");
  await saveList([check("ת2")], L2);
  const a = await newSite();
  const id = await saveProfile(null, "עם רשימה מושבתת", [L1, L2]);
  await setSites(id, [a]);
  await sup(`UPDATE pm_templates SET active = false WHERE id = $1`, [L1]);
  assert.deepEqual(await listNames(a), ["תושבת ב"]);
  await sup(`UPDATE pm_templates SET active = false WHERE id = $1`, [L2]);
  assert.deepEqual(await listNames(a), ["משותף"]);
});

test("אותו פרופיל שוב לאתר — אין רישום, אין אירוע", { skip }, async () => {
  const a = await newSite();
  const id = await saveProfile(null, "בלי כפילות ברישום", [BASE]);
  await setSiteProfile(a, id);
  const count = async () => ({
    hist: (await sup(`SELECT count(*)::int n FROM compliance_history WHERE entity = 'site_profile' AND site_code = $1`, [a]))[0].n,
    ev: (await sup(`SELECT count(*)::int n FROM events WHERE type = 'compliance' AND payload->>'code' = $1`, [a]))[0].n,
  });
  const before = await count();
  assert.equal(before.hist, 1);
  await setSiteProfile(a, id);
  assert.deepEqual(await count(), before);
  await setSiteProfile(a, null);
  assert.equal((await count()).hist, 2);
  await setSiteProfile(a, null);
  assert.equal((await count()).hist, 2);
});

// ============================================================
// פריט "ערך" — מד השרשרת ("להזין כמה אחוזים תוצאת המדידה", מעל 2% לדווח)
// ============================================================
test("פריט ערך: נשמר עם יחידה וסף, מצולם לביקור, ויחידה/סף נמחקים בסוג אחר", { skip }, async () => {
  const L = await createList("מדידות");
  await saveList([
    { label: "מד שרשרת", kind: "value", required: true, unit: "%", warn_above: 2 },
    { label: "סימון רגיל", kind: "check", required: true, unit: "%", warn_above: 5 },   // נמחקים
  ], L);
  const items = await tplItems(L);
  assert.equal(items[0].kind, "value");
  assert.equal(items[0].unit, "%");
  assert.equal(Number(items[0].warn_above), 2);
  assert.equal(items[0].min_photos, 0);
  assert.equal(items[1].unit, null);
  assert.equal(items[1].warn_above, null);
  // יחידה ארוכה מדי — נדחית; סף שאינו מספר — נדחה
  await fails(saveList([{ label: "מד", kind: "value", required: true, unit: "אחוזים-ארוך" }], L), "23514", /10/);
  await fails(saveList([{ label: "מד", kind: "value", required: true, warn_above: "הרבה" }], L), "23514");
  // ⚠️ גם INSERT ישיר: ה-CHECK אוכף את הצורה, לא רק ה-RPC
  await fails(sup(`INSERT INTO pm_checklist_items (template_id, seq, label, kind, required, min_photos, unit, updated_at, updated_by)
                   VALUES ($1, 9, 'בדיקה', 'check', true, 0, '%', 'x', 'x')`, [L]), "23514");
  await fails(sup(`INSERT INTO pm_checklist_items (template_id, seq, label, kind, required, min_photos, updated_at, updated_by)
                   VALUES ($1, 9, 'בדיקה', 'value', true, 1, 'x', 'x')`, [L]), "23514");
  // הביקור מצלם יחידה וסף
  const a = await newSite();
  const id = await saveProfile(null, "עם מדידה", [L]);
  await setSites(id, [a]);
  const v = await one(OPR, `SELECT visit_id::int FROM public.pm_visit_start($1)`, [a]);
  const draft = (await site(a)).draft;
  const m = draft.items.find((i) => i.kind === "value");
  assert.equal(m.unit, "%");
  assert.equal(Number(m.warn_above), 2);
  assert.ok(v.visit_id);
});

test("פריט ערך חובה: הגשה נחסמת עד שנמדד מספר; '2,5' ו-'3' נחשבים, 'תקין' לא", { skip }, async () => {
  const L = await createList("מדידה להגשה");
  await saveList([{ label: "מד שרשרת", kind: "value", required: true, unit: "%", warn_above: 2 }], L);
  const a = await newSite();
  const id = await saveProfile(null, "הגשה עם מדידה", [L]);
  await setSites(id, [a]);
  const { visit_id } = await one(OPR, `SELECT visit_id::int FROM public.pm_visit_start($1)`, [a]);
  const itemId = (await sup(`SELECT id FROM pm_visit_items WHERE visit_id = $1`, [visit_id]))[0].id;
  const sig = { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" };
  const submit = (req) => rpc(OPR, `SELECT * FROM public.pm_visit_submit($1, 'טכנאי', $2::jsonb, NULL, NULL, $3)`,
    [visit_id, JSON.stringify(sig), req]);
  await fails(submit("00000000-0000-0000-0000-0000000000a1"), "23514", /מד שרשרת/);
  await rpc(OPR, `SELECT public.pm_visit_item_note($1, 'תקין')`, [itemId]);
  await fails(submit("00000000-0000-0000-0000-0000000000a2"), "23514", /מד שרשרת/);
  await rpc(OPR, `SELECT public.pm_visit_item_note($1, '2,5')`, [itemId]);
  await submit("00000000-0000-0000-0000-0000000000a3");
  const done = (await site(a)).visits[0];
  assert.equal(done.items_done, 1, "ערך שנמדד נספר כבוצע");
  assert.equal((await sup(`SELECT app.pm_value_num('2,5') n`))[0].n, "2.5");
  for (const [t, ok] of [["3", true], [" -1 ", true], ["2.", false], ["1e3", false], ["", false], [null, false]]) {
    assert.equal((await sup(`SELECT app.pm_value_num($1) IS NOT NULL ok`, [t]))[0].ok, ok, String(t));
  }
});

// ============================================================
// מהסקירה (13/10/2026)
// ============================================================
const saveWithSites = (id, name, ids, expected, codes, uid = MGR) =>
  one(uid, `SELECT public.pm_profile_save($1, $2, $3::int[], $4, $5::text[]) id`, [id, name, ids, expected, codes]).then((r) => r.id);

test("⚠️ לוח ישן אינו מחזיר אתר שמנהל אחר שייך בינתיים — שינוי אתרים מקדם את updated_at", { skip }, async () => {
  const a = await newSite(), b = await newSite(), c = await newSite();
  const id = await saveProfile(null, "לוח ישן", [BASE]);
  await setSites(id, [a, b]);
  const loaded = (await prof("לוח ישן")).updated_at;
  await new Promise((r) => setTimeout(r, 5));
  await setSiteProfile(c, id);                                    // מנהל אחר, מהלשונית של c
  await fails(saveWithSites(id, "לוח ישן — שם חדש", [BASE], loaded, [a, b]), "PT409", /עודכן בינתיים/);
  const p = await prof("לוח ישן");
  assert.deepEqual(p.sites.map((s) => s.code).sort(), [a, b, c].sort(), "c נשאר בפרופיל");
  // גם מעבר של אתר לפרופיל אחר מקדם את הפרופיל שהוא יצא ממנו
  const other = await saveProfile(null, "לוח ישן — אחר", [HYD]);
  const before = (await prof("לוח ישן")).updated_at;
  await new Promise((r) => setTimeout(r, 5));
  await setSites(other, [c]);
  assert.notEqual((await prof("לוח ישן")).updated_at, before, "הפרופיל שאיבד אתר זז");
  await fails(one(MGR, `SELECT public.pm_profile_sites_set($1, $2::text[], $3) n`, [id, [a], before]), "PT409");
});

test("שמירה עם אתרים — טרנזקציה אחת: קוד שגוי לא משאיר שם חדש; NULL לא נוגע באתרים", { skip }, async () => {
  const a = await newSite(), b = await newSite();
  const id = await saveWithSites(null, "שמירה אחת", [BASE], null, [a]);
  assert.deepEqual((await prof("שמירה אחת")).sites.map((s) => s.code), [a]);
  const t0 = (await prof("שמירה אחת")).updated_at;
  await fails(saveWithSites(id, "שם שלא יישמר", [BASE, HYD], t0, [a, "NOPE-9"]), "PT404", /NOPE-9/);
  const p = await prof("שמירה אחת");
  assert.ok(p, "השם לא השתנה");
  assert.deepEqual(p.template_ids, [BASE], "גם הרשימות לא");
  await saveWithSites(id, "שמירה אחת", [BASE, HYD], p.updated_at, null);   // שינוי רשימות בלבד
  assert.deepEqual((await prof("שמירה אחת")).sites.map((s) => s.code), [a], "האתרים לא נגעו");
  const p2 = await prof("שמירה אחת");
  await saveWithSites(id, "שמירה אחת", [BASE, HYD], p2.updated_at, [b]);
  assert.deepEqual((await prof("שמירה אחת")).sites.map((s) => s.code), [b]);
});

test("⚠️ הגדלת רשימה שמעבירה פרופיל מעל 40 תמונות — נדחית, עם שם הפרופיל", { skip }, async () => {
  const L1 = await createList("ארבעים א");
  await saveList([photo("ק1", 6), photo("ק2", 6), photo("ק3", 6), photo("ק4", 6), photo("ק5", 6)], L1);  // 30
  const L2 = await createList("ארבעים ב");
  await saveList([photo("ל1", 5)], L2);                                                                  // 5
  await saveProfile(null, "פרופיל ארבעים", [L1, L2]);
  await fails(saveList([photo("ל1", 6), photo("ל2", 6)], L2), "23514", /פרופיל ארבעים/);                 // 42
  assert.equal((await tplItems(L2)).length, 1, "הרשימה לא נשמרה");
  await saveList([photo("ל1", 6), photo("ל2", 4)], L2);                                                  // 40 — מותר
});

test("פריט ערך: סף לפי אותו כלל כמו מדידה; גיזום זהה ל-JS (רווח/טאב/שורה — לא רווח קשיח)", { skip }, async () => {
  const L = await createList("ספים");
  for (const bad of ["1e3", "0x10", "NaN", "Infinity", "2.", "אחוז"]) {
    await fails(saveList([{ label: "מד", kind: "value", required: true, warn_above: bad }], L), "23514", /הסף/);
  }
  await saveList([{ label: "מד", kind: "value", required: true, warn_above: "2,5" }], L);
  assert.equal(Number((await tplItems(L))[0].warn_above), 2.5);
  const num = async (t) => (await sup(`SELECT app.pm_value_num($1) n`, [t]))[0].n;
  assert.equal(await num("\t3\n"), "3");
  assert.equal(await num(" 3 "), "3");
  assert.equal(await num("3 "), null, "רווח קשיח — לא מדידה, כמו ב-JS");
});

// ⚠️ המחיקה הייתה הכותב היחיד בלי בדיקת התיישנות (סקירה, 14/10/2026): לוח ישן נדחה בשמירה ב-PT409
// ומחק בלי לשאול — כולל פרופיל שמנהל אחר בדיוק מילא באתרים.
test("⚠️ מחיקת פרופיל מלוח ישן — PT409; עם הערך הנכון, ובלי ערך (בנייה ישנה) — נמחק", { skip }, async () => {
  const a = await newSite();
  const id = await saveProfile(null, "מחיקה מלוח ישן", [BASE]);
  const stale = (await prof("מחיקה מלוח ישן")).updated_at;
  await setSites(id, [a]);                                  // מנהל אחר מילא אתרים — updated_at זז
  const fresh = (await prof("מחיקה מלוח ישן")).updated_at;
  assert.notEqual(fresh, stale, "שינוי אתרים חייב להזיז את updated_at");
  await fails(delProfile(id, MGR, stale), "PT409", /עודכן בינתיים/);
  assert.ok(await prof("מחיקה מלוח ישן"), "אחרי PT409 הפרופיל עדיין קיים");
  assert.equal(await delProfile(id, MGR, fresh), 1);
  assert.equal(await prof("מחיקה מלוח ישן"), undefined);
  const id2 = await saveProfile(null, "מחיקה בלי ערך", [BASE]);
  assert.equal(await delProfile(id2), 0, "בנייה ישנה שולחת p_id בלבד — עדיין עובד");
});

// ⚠️ בפריט "ערך" וי אינו "בוצע" — רק מדידה. לפני התיקון (14/10/2026) pm_visit_item_check קיבל כל
// סוג, ו-items_done ספר i.checked לכל סוג; פריט מדידה רשות שסומן וי נראה "בוצע" בלי שנמדד דבר.
test("⚠️ פריט ערך: אי אפשר לסמן בו וי, ו-items_done סופר מדידה בלבד", { skip }, async () => {
  const L = await createList("מדידה וי");
  await saveList([check("בדיקה רגילה"), { label: "מד שרשרת", kind: "value", required: false, unit: "%" }], L);
  const a = await newSite();
  const id = await saveProfile(null, "ערך ו-וי", [L]);
  await setSites(id, [a]);
  const { visit_id } = await one(OPR, `SELECT visit_id::int FROM public.pm_visit_start($1)`, [a]);
  const items = await sup(`SELECT id, kind FROM pm_visit_items WHERE visit_id = $1 ORDER BY seq`, [visit_id]);
  const chk = items.find((i) => i.kind === "check"), val = items.find((i) => i.kind === "value");
  await fails(rpc(OPR, `SELECT public.pm_visit_item_check($1, true)`, [val.id]), "23514", /מדידה/);
  await rpc(OPR, `SELECT public.pm_visit_item_check($1, true)`, [chk.id]);
  // כותב כלשהו שעקף את הדלת (בנייה ישנה, כלי) — הספירה עדיין לא קוראת לזה "בוצע"
  await sup(`UPDATE pm_visit_items SET checked = true WHERE id = $1`, [val.id]);
  const sig = { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" };
  await rpc(OPR, `SELECT * FROM public.pm_visit_submit($1, 'טכנאי', $2::jsonb, NULL, NULL, $3)`,
    [visit_id, JSON.stringify(sig), "00000000-0000-0000-0000-0000000000b1"]);
  const v1 = (await site(a)).visits[0];
  assert.deepEqual({ total: v1.items_total, done: v1.items_done }, { total: 2, done: 1 }, "וי על פריט ערך אינו 'בוצע'");
  // ואותו ביקור בדיוק, כשנמדד כהלכה — נספר. (אתר שני: pm_child_guard חוסם כתיבה לביקור שהוגש.)
  const b = await newSite();
  await setSites(id, [a, b]);
  const v2id = (await one(OPR, `SELECT visit_id::int FROM public.pm_visit_start($1)`, [b])).visit_id;
  const bItems = await sup(`SELECT id, kind FROM pm_visit_items WHERE visit_id = $1 ORDER BY seq`, [v2id]);
  await rpc(OPR, `SELECT public.pm_visit_item_check($1, true)`, [bItems.find((i) => i.kind === "check").id]);
  await rpc(OPR, `SELECT public.pm_visit_item_note($1, '2,5')`, [bItems.find((i) => i.kind === "value").id]);
  await rpc(OPR, `SELECT * FROM public.pm_visit_submit($1, 'טכנאי', $2::jsonb, NULL, NULL, $3)`,
    [v2id, JSON.stringify(sig), "00000000-0000-0000-0000-0000000000b2"]);
  assert.equal((await site(b)).visits[0].items_done, 2, "אחרי שנמדד — נספר");
});

test("⚠️ אתר שנמחק יוצא מהפרופיל בלי להשאיר שורה", { skip }, async () => {
  const a = await newSite();
  const id = await saveProfile(null, "אתר נמחק", [BASE]);
  await setSites(id, [a]);
  await sup(`DELETE FROM sites WHERE code = $1`, [a]);
  assert.deepEqual((await prof("אתר נמחק")).sites, []);
});
