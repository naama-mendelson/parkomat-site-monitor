// tests/service-links.test.js — סוג השירות על הכרטיס מתעדכן ברגע שמחברים אתר ברמזור.
//
// ============================================================
// מה נבדק, ולמה
// ============================================================
// בעלת המוצר (11/10/2026): "ברגע שמחברים אתר לשורת הסוג שירות שלו — שישתנה ישר הכיתוב
// 'לא חובר'". התג נגזר עד היום מ-site_uptime_service דרך site_card_metrics (cron כל 10
// דקות), ולכן חיבור לא שינה אותו. עכשיו:
//   1. `public.site_service_links()` — החיבור בלבד, זול מספיק לכל טעינה חיה.
//   2. טריגר על הלוח שולח אירוע 'service_link' — אחד לטרנזקציה — ו-App טוען מחדש.
//
// ⚠️ **הבדיקה החשובה היא ההשוואה.** הפונקציה החדשה משכפלת את ההתאמה של
// site_uptime_service (קוד ברשימה, רווחים, DISTINCT ON לפי position, id, הלוח הרובוטי
// בלבד). שתי העתקות של כלל אחד נפרדות בשקט — ואז התג אומר הסכם אחד והזמינות נמדדת לפי
// אחר. לכן אותו לוח, עם כל המקרים הקשים, נשאל דרך שתיהן והתשובות חייבות להיות זהות.
//
// רץ מול PGlite שמריץ את `db.init()` האמיתי — לא מול הייצור.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
let h;
const MGR = "88888888-8888-8888-8888-888888888888";
const ids = {};

const site = async (code) => {
  ids[code] = (await h.pg.query(
    `INSERT INTO sites (code, site_name, status, registered_at)
     VALUES ($1,$1,'ready','2026-01-01T00:00:00.000Z') RETURNING id`, [code])).rows[0].id;
};
const row = (cells, position, board = "robotic") => h.pg.query(
  `INSERT INTO traffic_light_rows (cells, position, board) VALUES ($1::jsonb, $2, $3) RETURNING id`,
  [JSON.stringify(cells), position, board]);
const linkEvents = async () => Number((await h.pg.query(
  `SELECT count(*) AS n FROM events WHERE type = 'service_link'`)).rows[0].n);
const mgr = (sql, args = []) => h.as("authenticated", MGR, (tx) => tx.query(sql, args));

before(async () => {
  if (skip) return;
  h = await local.boot();
  await h.pg.query(
    `INSERT INTO app_users (email, role, is_active, supabase_uid, created_at)
     VALUES ('mgr-links@parkomat.co.il','manager',true,$1,now())`, [MGR]);
  await h.pg.query(`INSERT INTO traffic_light_columns (key, label, kind, position) VALUES
    ('c_code','קוד אתר','text',1), ('c_plan','סוג הסכם שירות במקור','text',2), ('c_kind','להתייחס כ','text',3)
    ON CONFLICT (key) DO NOTHING`);
  // לוח המכפילים: "קוד אתר" נוצרת ב-traffic-light.postgres.sql (c_mx_site_code); "סוג הסכם שירות" כמו בייצור
  await h.pg.query(`INSERT INTO traffic_light_columns (key, label, kind, position, board) VALUES
    ('c_mx_plan','סוג הסכם שירות','status',2,'multipliers') ON CONFLICT (key) DO NOTHING`);
  for (const c of ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "U1", "U2"]) await site(c);
  // אתרים ללא בקר (מכפילים) — M1 בסיסי, M2 לא בשירות, M3 גם ברובוטי (הרובוטי גובר), M4 מכפיל בלי הסכם
  for (const c of ["M1", "M2", "M3", "M4"]) { await site(c); await h.pg.query(`UPDATE sites SET monitored = false WHERE code = $1`, [c]); }

  // רשימת קודים בתא, רווחים וטאב, אותיות גדולות ורווח בסוף
  await row({ c_code: "L1,  L2\t", c_kind: " VIP ", c_plan: "basic" }, 10);
  // שירות בלבד / מסלול בלבד
  await row({ c_code: "L3", c_kind: "ext" }, 11);
  await row({ c_code: "L4", c_plan: "vip" }, 12);
  // ⚠️ קוד בשתי שורות — המיקום הנמוך מנצח, לכל עמודה בנפרד
  await row({ c_code: "L5", c_kind: "basic" }, 20);
  await row({ c_code: "L5", c_kind: "vip", c_plan: "ext" }, 5);
  // ערכי מצב מהרמזור, וטקסט חופשי שאינו מוכר
  await row({ c_code: "L6", c_kind: "no_service" }, 13);
  await row({ c_code: "L7", c_kind: "משהו אחר" }, 14);
  // שתי שורות באותו מיקום — ה-id מכריע
  await row({ c_code: "L8", c_kind: "basic" }, 30);
  await row({ c_code: "L8", c_kind: "vip" }, 30);
  // ⚠️ לא מחובר: שורה בלי סוג, ושורה בלוח המכפילים תחת אותו מפתח
  await row({ c_code: "U1", c_kind: "  ", c_plan: "" }, 15);
  await row({ c_code: "U2", c_kind: "vip" }, 16, "multipliers");
  // ⚠️ אתר **מנוטר** בלוח המכפילים — עדיין לא חיבור (U3): המכפילים מזינים רק אתרים ללא בקר
  await site("U3");
  await row({ c_mx_site_code: "U3, M1", c_mx_plan: "בסיסי" }, 1, "multipliers");
  await row({ c_mx_site_code: "M2", c_mx_plan: " לא בשירות " }, 2, "multipliers");
  await row({ c_mx_site_code: "M3", c_mx_plan: "אין" }, 3, "multipliers");
  await row({ c_code: "M3", c_kind: "vip" }, 40);
  await row({ c_mx_site_code: "M4", c_mx_plan: "" }, 4, "multipliers");
});
after(async () => { if (h) await h.close(); });

test("⚠️ זהה ל-site_uptime_service — אותו אתר, אותו שירות, אותו מסלול", { skip }, async () => {
  const links = (await h.pg.query(
    `SELECT site_id, agreement, plan FROM public.site_service_links() ORDER BY site_id`)).rows;
  const svc = (await h.pg.query(
    `SELECT site_id, agreement, plan
       FROM public.site_uptime_service(NULL, '2026-09-06T00:00:00.000Z', '2026-09-07T00:00:00.000Z')
      ORDER BY site_id`)).rows;
  assert.ok(links.length >= 8, `רק ${links.length} שורות — הלוח לא נזרע`);
  // ⚠️ על אתרים מנוטרים — זהות. אתר ללא בקר מקבל גם מלוח המכפילים, ש-site_uptime_service אינה קוראת (בכוונה).
  const unmon = new Set([ids.M1, ids.M2, ids.M3, ids.M4]);
  assert.deepEqual(links.filter((r) => !unmon.has(r.site_id)), svc.filter((r) => !unmon.has(r.site_id)));
  assert.deepEqual(svc.filter((r) => unmon.has(r.site_id)).map((r) => r.site_id), [ids.M3], "site_uptime_service — רק הרובוטי");
});

test("מה כל אתר מקבל — הערכים עצמם, לא רק השוויון", { skip }, async () => {
  const by = new Map((await h.pg.query(`SELECT * FROM public.site_service_links()`)).rows
    .map((r) => [r.site_id, { agreement: r.agreement, plan: r.plan }]));
  const got = (c) => by.get(ids[c]) ?? null;
  assert.deepEqual(got("L1"), { agreement: "vip", plan: "basic" });
  assert.deepEqual(got("L2"), { agreement: "vip", plan: "basic" });
  assert.deepEqual(got("L3"), { agreement: "ext", plan: null });
  assert.deepEqual(got("L4"), { agreement: null, plan: "vip" });
  assert.deepEqual(got("L5"), { agreement: "vip", plan: "ext" });
  assert.deepEqual(got("L6"), { agreement: "no_service", plan: null });
  assert.deepEqual(got("L7"), { agreement: "משהו אחר", plan: null });
  assert.deepEqual(got("L8"), { agreement: "basic", plan: null });
  assert.equal(got("U1"), null, "שורה בלי סוג אינה חיבור");
  assert.equal(got("U2"), null, "שורה בלוח המכפילים אינה חיבור");
  // לוח המכפילים (15/10/2026) — אתרים ללא בקר בלבד, דרך "קוד אתר" ו"סוג הסכם שירות", מתורגם
  assert.equal(got("U3"), null, "אתר מנוטר בלוח המכפילים — לא חיבור");
  assert.deepEqual(got("M1"), { agreement: null, plan: "basic" });
  assert.deepEqual(got("M2"), { agreement: null, plan: "no_service" });
  assert.deepEqual(got("M3"), { agreement: "vip", plan: null }, "הרובוטי גובר על המכפילים");
  assert.equal(got("M4"), null, "מכפיל בלי הסכם — לא חובר");
});

test("חיבור נראה מיד — בלי cron ובלי טבלת מטמון", { skip }, async () => {
  await site("N1");
  const before = (await h.pg.query(`SELECT 1 FROM public.site_service_links() WHERE site_id = $1`, [ids.N1])).rows;
  assert.equal(before.length, 0);
  const rid = (await row({ c_code: "N1" }, 40)).rows[0].id;
  await mgr(`SELECT public.tl_set_cell($1, 'c_kind', '"vip"'::jsonb)`, [rid]);
  const after = (await h.pg.query(
    `SELECT agreement FROM public.site_service_links() WHERE site_id = $1`, [ids.N1])).rows;
  assert.deepEqual(after, [{ agreement: "vip" }]);
});

test("כתיבה בלוח דרך tl_set_cell שולחת אירוע 'service_link'", { skip }, async () => {
  const rid = (await row({ c_code: "L1" }, 50)).rows[0].id;
  const n0 = await linkEvents();
  await mgr(`SELECT public.tl_set_cell($1, 'c_plan', '"ext"'::jsonb)`, [rid]);
  assert.equal(await linkEvents(), n0 + 1);
  const ev = (await h.pg.query(
    `SELECT site_code, payload FROM events WHERE type = 'service_link' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(ev.site_code, "*");
  assert.equal(ev.payload.type, "service_link", "App מנתב לפי payload.type");
});

test("⚠️ אחד לטרנזקציה — הדבקה של כמה שורות היא אירוע אחד", { skip }, async () => {
  const n0 = await linkEvents();
  await mgr(`SELECT public.tl_paste_rows($1::jsonb, 'robotic')`,
    [JSON.stringify([{ c_code: "P1" }, { c_code: "P2" }, { c_code: "P3" }])]);
  assert.equal(await linkEvents(), n0 + 1, "tl_paste_rows מכניס שורה-שורה, וכל אחת הייתה אירוע");

  await h.pg.transaction(async (tx) => {
    await tx.query(`INSERT INTO traffic_light_rows (cells, position) VALUES ('{"c_code":"T1"}', 60)`);
    await tx.query(`UPDATE traffic_light_rows SET position = 61 WHERE cells ->> 'c_code' = 'T1'`);
    await tx.query(`DELETE FROM traffic_light_rows WHERE cells ->> 'c_code' = 'T1'`);
  });
  assert.equal(await linkEvents(), n0 + 2);

  // ⚠️ והדגל אינו נשאר דלוק אחרי הטרנזקציה — אחרת רק השינוי הראשון בחיבור היה מגיע.
  await h.pg.query(`UPDATE traffic_light_rows SET position = position WHERE cells ->> 'c_code' = 'L3'`);
  await h.pg.query(`UPDATE traffic_light_rows SET position = position WHERE cells ->> 'c_code' = 'L3'`);
  assert.equal(await linkEvents(), n0 + 4);
});

test("שינוי עמודה (למשל שם 'להתייחס כ') שולח אירוע — הוא משנה את החיבור של כולם", { skip }, async () => {
  const n0 = await linkEvents();
  await h.pg.query(`UPDATE traffic_light_columns SET width = width WHERE key = 'c_kind'`);
  assert.equal(await linkEvents(), n0 + 1);
});

test("הרשאות: משתמש מחובר קורא, אנונימי לא", { skip }, async () => {
  const p = (role) => h.pg.query(
    `SELECT has_function_privilege($1, 'public.site_service_links()', 'EXECUTE') AS ok`, [role]);
  assert.equal((await p("anon")).rows[0].ok, false);
  assert.equal((await p("authenticated")).rows[0].ok, true);
  // ⚠️ ובזהות האמיתית — בלי SECURITY DEFINER, ולכן הקריאה עוברת דרך ה-RLS של הלוח.
  const rows = (await mgr(`SELECT site_id FROM public.site_service_links()`)).rows;
  assert.ok(rows.some((r) => r.site_id === ids.L1));
});
