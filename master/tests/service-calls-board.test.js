// tests/service-calls-board.test.js — קריאות ויזנט על כרטיס האתר (13/10/2026), על Postgres 17 מקומי.
//
// db.init() האמיתי (tests/helpers/local-pg.js). הקריאות נכנסות כמו בייצור — בזהות הקולט, דרך
// מדיניות ה-INSERT — ולא ישירות לטבלה.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "c1000000-0000-0000-0000-000000000001";
const OPR = "c1000000-0000-0000-0000-000000000002";
const AGT = "c1000000-0000-0000-0000-000000000003";
const INT = "c1000000-0000-0000-0000-000000000004";

let h;
let seq = 0;
const sup = async (sql, params = []) => (await h.pg.query(sql, params)).rows;
const rpc = async (uid, sql, params = []) => (await h.as("authenticated", uid, (tx) => tx.query(sql, params))).rows;
const one = async (uid, sql, params = []) => (await rpc(uid, sql, params))[0];
async function fails(p, code, re) {
  await assert.rejects(p, (e) => {
    if (code) assert.equal(e.code, code, `ציפיתי ל-${code}, התקבל ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
}
// קוד אתר בן 4 ספרות, כמו קוד פרויקט בוויזנט
async function newSite() {
  const code = String(7000 + ++seq);
  const id = (await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready','2026-01-01T00:00:00.000Z') RETURNING id`,
    [code]))[0].id;
  return { id, code };
}
// קריאה כמו שוויזנט שולחים — בזהות הקולט
// ⚠️ שעת ההגעה — השעון האמיתי, כמו בייצור (ברירת המחדל של העמודה): שינוי מהדשבורד נחתם ב-now() של המסד,
// והסדר בין השניים הוא כל מה שהבדיקות כאן שואלות. רווח קטן — כדי ששני צעדים לא ייפלו על אותה מילישנייה.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(p) {
  const raw = JSON.stringify(p);
  await h.as("authenticated", INT, (tx) => tx.query(`INSERT INTO service_calls (raw, payload, source, received_at) VALUES ($1, $3::jsonb, 'wizenet', $2)`,
    [raw, new Date().toISOString(), raw]));
  await sleep(5);
}
const counts = async (uid) => rpc(uid, `SELECT site_id, open, recent, oldest_open FROM public.service_call_counts() ORDER BY site_id`);
const openOf = async (uid, code) => (await one(uid, `SELECT public.service_calls_open($1) AS j`, [code])).j;
const save = (uid, kind, items) => one(uid, `SELECT public.wizenet_lookups_save($1, $2::jsonb) AS n`, [kind, JSON.stringify(items)]);
const change = async (uid, ticket, field, value) => {
  const r = await one(uid, `SELECT public.service_call_record_change($1, $2, $3) AS at`, [ticket, field, value]);
  await sleep(5);
  return r;
};

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
      ('sc-mgr@parkomat.co.il','מנהלת קריאות','manager',true,$1,$4),
      ('sc-op@parkomat.co.il','בקר קריאות','operator',true,$2,$4),
      ('sc-intake@parkomat.co.il',NULL,'operator',true,$3,$4)`, [MGR, OPR, INT, now]);
  const s = await newSite();
  await sup(`INSERT INTO app_users (email, role, is_active, supabase_uid, site_id, created_at) VALUES ('site-sc@parkomat.co.il','agent',true,$1,$2,$3)`,
    [AGT, s.id, now]);
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('intake_user_id', $1, 'x')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [INT]);
});
after(async () => { if (h) await h.close(); });

test("S1 · קריאה לאתר לפי קוד הפרויקט (parking_code '1226-1-02' → 1226), וקריאה בלי אתר — לא נספרת", { skip }, async () => {
  const s = await newSite();
  await call({ ticket_number: "S1-a", parking_code: `${s.code}-1-02`, status: "148", ticket_type: "1", first_name: "דנה" });
  await call({ ticket_number: "S1-b", parking_code: s.code, status: "148" });
  await call({ ticket_number: "S1-c", parking_code: "9999-1-01", status: "148" });           // אין אתר כזה
  await call({ ticket_number: "S1-d", project_code: s.code, parking_code: "", status: "148" }); // שדה ייעודי, אם יגיע
  const c = await counts(OPR);
  assert.deepEqual(c.filter((r) => r.site_id === s.id).map(({ site_id, open, recent }) => ({ site_id, open, recent })),
    [{ site_id: s.id, open: 3, recent: 3 }]);
  const j = await openOf(OPR, s.code);
  assert.deepEqual(j.map((x) => x.ticket).sort(), ["S1-a", "S1-b", "S1-d"]);
  assert.equal(j.find((x) => x.ticket === "S1-a").first_name, "דנה");
});

test("S2 · שורה לכל אירוע: המצב הוא השורה האחרונה; סטטוס סגור — יורד מהפתוחות ונשאר בספירת היום", { skip }, async () => {
  const s = await newSite();
  await save(MGR, "status", [{ id: "148", name: "פתוחה" }, { id: "150", name: "סגורה" }, { id: "151", name: "בטיפול" }]);
  await call({ ticket_number: "S2-a", parking_code: s.code, status: "148" });
  await call({ ticket_number: "S2-a", parking_code: s.code, status: "151" });
  assert.deepEqual((await openOf(OPR, s.code)).map((x) => [x.ticket, x.status_id, x.status_name]), [["S2-a", "151", "בטיפול"]]);
  await call({ ticket_number: "S2-a", parking_code: s.code, status: "150" });                  // נסגרה בוויזנט
  assert.deepEqual(await openOf(OPR, s.code), []);
  // ⚠️ 14/10/2026: הכרטיס אינו מתרוקן ביום שבו נפתחו ונסגרו קריאות. open יורד ל-0, ו-recent סופר
  // את מה שהיה היום (בעלת המוצר: "שזה יהיה על הכרטיס שמתאים לפי הקוד").
  const row2 = (await counts(OPR)).find((r) => r.site_id === s.id);
  assert.deepEqual([row2.open, row2.recent], [0, 1]);
  assert.equal(row2.oldest_open, null, "אין פתוחה — אין ממה להתחיל סטופר");
  // ועם p_hours — החלון מהכרטיס מראה גם את מה שנסגר היום, פתוחות קודם
  assert.deepEqual((await one(OPR, `SELECT public.service_calls_open($1, 24) AS j`, [s.code])).j.map((x) => [x.ticket, x.open]),
    [["S2-a", false]]);
  // סטטוס שאינו ברשימה — נשאר פתוח (עדיף להציג קריאה שאולי נסגרה מאשר להעלים פתוחה)
  await call({ ticket_number: "S2-b", parking_code: s.code, status: "777" });
  assert.deepEqual((await openOf(OPR, s.code)).map((x) => [x.ticket, x.status_name]), [["S2-b", null]]);
});

test("S3 · שמירת רשימה: closed מנוחש לפי השם בשורה חדשה, ולא נדרס בטעינה הבאה; סוג/רשימה לא מוכרים — נדחים", { skip }, async () => {
  await sup(`DELETE FROM wizenet_lookups`);
  assert.equal((await save(OPR, "status", [{ id: "1", name: "חדשה" }, { id: "2", name: "נסגרה" }, { id: " ", name: "ריק" }])).n, 2);
  const st = async () => (await sup(`SELECT id, name, closed FROM wizenet_lookups WHERE kind = 'status' ORDER BY id`));
  assert.deepEqual(await st(), [{ id: "1", name: "חדשה", closed: false }, { id: "2", name: "נסגרה", closed: true }]);
  // מישהו סימן "חדשה" כסגורה ביד — טעינה חוזרת מעדכנת שם ולא נוגעת בסימון
  await sup(`UPDATE wizenet_lookups SET closed = true WHERE kind = 'status' AND id = '1'`);
  await save(OPR, "status", [{ id: "1", name: "חדשה (עודכן)" }]);
  assert.deepEqual((await st())[0], { id: "1", name: "חדשה (עודכן)", closed: true });
  // סוגים — אף פעם לא "סגור"
  await save(OPR, "type", [{ id: "9", name: "תקלה שטופלה" }]);
  assert.equal((await sup(`SELECT closed FROM wizenet_lookups WHERE kind = 'type' AND id = '9'`))[0].closed, false);
  await fails(save(OPR, "priority", []), "23514", /סוג רשימה/);
  await fails(one(OPR, `SELECT public.wizenet_lookups_save('status', '{"a":1}'::jsonb)`), "23514", /רשימה לא תקינה/);
  const lists = (await one(OPR, `SELECT public.wizenet_lookups_list() AS j`)).j;
  assert.deepEqual(lists.type, [{ id: "9", name: "תקלה שטופלה" }]);
  assert.equal(lists.status.length, 2);
});

test("S4 · שינוי מהדשבורד: גובר על השורה של ויזנט עד שמגיעה חדשה ממנו; נרשם מי; ערך לא מוכר — נדחה", { skip }, async () => {
  const s = await newSite();
  await sup(`DELETE FROM wizenet_lookups`);
  await save(MGR, "status", [{ id: "148", name: "פתוחה" }, { id: "150", name: "סגורה" }, { id: "151", name: "בטיפול" }]);
  await save(MGR, "type", [{ id: "1", name: "תקלה" }, { id: "2", name: "בירור" }]);
  await call({ ticket_number: "S4-a", parking_code: s.code, status: "148", ticket_type: "1" });
  await change(OPR, "S4-a", "type", "2");
  await change(OPR, "S4-a", "status", "151");
  const [a] = await openOf(OPR, s.code);
  assert.deepEqual([a.status_id, a.status_name, a.type_id, a.type_name, a.changed_by], ["151", "בטיפול", "2", "בירור", "בקר קריאות"]);
  // סגירה מהדשבורד — יורדת מהכרטיס מיד
  await change(MGR, "S4-a", "status", "150");
  assert.deepEqual(await openOf(OPR, s.code), []);
  // ויזנט שולחים אחר כך שורה חדשה — היא הקובעת (נפתחה מחדש אצלם)
  await call({ ticket_number: "S4-a", parking_code: s.code, status: "148", ticket_type: "1" });
  const [b] = await openOf(OPR, s.code);
  assert.deepEqual([b.status_id, b.type_id, b.changed_by], ["148", "1", null]);
  await fails(change(OPR, "S4-a", "status", "999"), "23514", /ערך לא מוכר/);
  await fails(change(OPR, "S4-a", "priority", "1"), "23514", /שדה לא מוכר/);
  await fails(change(OPR, "אין-כזו", "status", "148"), "PT404", /לא נמצאה/);
  await fails(change(OPR, "", "status", "148"), "23514");
  const audit = await sup(`SELECT action FROM audit_log WHERE target_id = 'S4-a' ORDER BY id`);
  assert.deepEqual(audit.map((r) => r.action), ["service_call.type", "service_call.status", "service_call.status"]);
});

test("S5 · הרשאות: סוכן וקולט — אין; anon — אין; הספירה לעולם לא זורקת; הטבלאות סגורות", { skip }, async () => {
  for (const uid of [AGT, INT]) {
    await fails(openOf(uid, "1"), "42501");
    await fails(save(uid, "status", []), "42501");
    await fails(change(uid, "x", "status", "1"), "42501");
    await fails(one(uid, `SELECT public.wizenet_lookups_list()`), "42501");
    assert.deepEqual(await counts(uid), [], "הסימון נטען עם רשימת האתרים — שגיאה כאן הייתה מפילה אותה");
  }
  const fns = await sup(`SELECT p.oid::regprocedure::text sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND (p.proname LIKE 'service_call%' OR p.proname LIKE 'wizenet%')
       AND has_function_privilege('anon', p.oid, 'EXECUTE')`);
  assert.deepEqual(fns, []);
  for (const uid of [MGR, OPR]) {
    for (const t of ["wizenet_lookups", "service_call_changes"]) {
      await fails(rpc(uid, `SELECT * FROM ${t}`), "42501", /permission denied/);
    }
  }
});

test("S6 · קריאה שהגיעה מוויזנט מפרסמת אירוע (גם כשאין לה אתר), וכך גם שינוי מהדשבורד", { skip }, async () => {
  const s = await newSite();
  const before = Number((await sup(`SELECT COALESCE(max(id), 0) m FROM events`))[0].m);
  await call({ ticket_number: "S6-a", parking_code: `${s.code}-2-07`, status: "148" });
  await call({ ticket_number: "S6-b", parking_code: "0000", status: "148" });
  await sup(`DELETE FROM wizenet_lookups`);
  await change(OPR, "S6-a", "status", "151");
  const ev = await sup(`SELECT type, site_code, payload FROM events WHERE id > $1 ORDER BY id`, [before]);
  assert.deepEqual(ev.map((e) => [e.type, e.payload.code, e.payload.action]),
    [["service_calls", s.code, "received"], ["service_calls", null, "received"], ["service_calls", s.code, "status"]]);
});

// ⚠️ "קריאות היום" (14/10/2026): הסימון על הכרטיס מראה רק פתוחות ורק לאתר שמוכר לנו. ביום הראשון
// זה היה 1 מתוך 22 — 18 כבר סגורות ו-3 לקודים שאין להם אתר. הרשימה הזו היא מה שהיה.
test("S8 · service_calls_recent — גם סגורות, וגם קוד שאין לו אתר; החדשה ראשונה", { skip }, async () => {
  const s = await newSite();
  await save(MGR, "status", [{ id: "9", name: "נסגרה" }, { id: "1", name: "בטיפול" }]);
  await sup(`UPDATE wizenet_lookups SET closed = true WHERE kind = 'status' AND id = '9'`);
  await call({ ticket_number: "R-1", parking_code: `${s.code}-1-02`, status: "1", customer_complaint: "פתוחה אצלנו" });
  await call({ ticket_number: "R-2", parking_code: `${s.code}-1-02`, status: "9", customer_complaint: "נסגרה" });
  await call({ ticket_number: "R-3", parking_code: "9999", status: "1", customer_complaint: "קוד בלי אתר" });

  const j = await one(OPR, `SELECT public.service_calls_recent(24) AS j`);
  const rows = j.j.filter((x) => String(x.ticket).startsWith("R-"));
  assert.equal(rows.length, 3, "כל השלוש — פתוחה, סגורה, ובלי אתר");
  assert.deepEqual(rows.map((x) => x.ticket), ["R-3", "R-2", "R-1"], "החדשה למעלה");
  const byT = Object.fromEntries(rows.map((x) => [x.ticket, x]));
  assert.deepEqual([byT["R-1"].open, byT["R-2"].open, byT["R-3"].open], [true, false, true]);
  assert.equal(byT["R-2"].status_name, "נסגרה", "שם הסטטוס ולא מספר");
  assert.deepEqual([byT["R-1"].site_code, byT["R-1"].site_name], [s.code, s.code]);
  assert.deepEqual([byT["R-3"].site_code, byT["R-3"].project], [null, "9999"], "קוד בלי אתר — נשאר ברשימה, בלי אתר");
  // ⚠️ הסימון על הכרטיס לא השתנה: שם נספרות רק פתוחות של אתר מוכר (שאר האתרים — מבדיקות קודמות)
  assert.equal((await counts(OPR)).find((c) => c.site_id === s.id)?.open, 1);

  const n = await one(OPR, `SELECT public.service_calls_recent_count(24) AS n`);
  assert.equal(n.n, j.j.length, "המספר על הכפתור זהה לאורך הרשימה");
  const old = await one(OPR, `SELECT public.service_calls_recent(1) AS j`);
  assert.ok(old.j.length >= 3, "טווח קצר עדיין כולל את מה שנכנס עכשיו");
  // טווח חורג — נחתך ל-168 שעות ולא נכשל, ואפס/שלילי אינם מרוקנים את הרשימה
  for (const h2 of [0, -5, 100000]) {
    assert.ok((await one(OPR, `SELECT public.service_calls_recent($1) AS j`, [h2])).j.length >= 3, `p_hours=${h2}`);
  }
  await fails(rpc(AGT, `SELECT public.service_calls_recent(24)`), "42501");
});

// ⚠️ "אני רוצה שיהיה כזה סטופר לפני כמה זמן נפתחה הפניה" (בעלת המוצר, 14/10/2026). הסטופר מתקתק
// מול השעון האמיתי, ולכן השעה של ויזנט — שהיא שעון ישראל עם סיומת Z — חייבת לעבור המרה נכונה,
// ובאזור זמן ולא בהחסרה קבועה (ישראל היא +3 בקיץ ו-+2 בחורף).
test("S9 · שעון ויזנט → זמן אמיתי, ו-oldest_open לסטופר שעל הכרטיס", { skip }, async () => {
  // ⚠️ שאילתה ישירה (superuser) לבדיקת הפונקציה הטהורה; קריאה ל-RPC חייבת לעבור בזהות משתמש,
  // אחרת require_staff נשבר על request.jwt.claims ריק ומחזיר "invalid input syntax for type json".
  const plain = async (sql, p = []) => (await sup(sql, p))[0];
  // קיץ: 14/10 הוא עדיין שעון קיץ בישראל (+3)
  assert.equal((await plain(`SELECT to_char(app.wizenet_ts('2026-10-14T12:40:46Z') AT TIME ZONE 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS') t`)).t, "2026-10-14T09:40:46");
  // ⚠️ חורף: אותה שעת קיר ב-01/02 היא +2 — החסרה קבועה של 3 שעות הייתה טועה כאן בשעה
  assert.equal((await plain(`SELECT to_char(app.wizenet_ts('2026-02-01T12:40:46Z') AT TIME ZONE 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS') t`)).t, "2026-02-01T10:40:46");
  assert.equal((await plain(`SELECT app.wizenet_ts('לא תאריך') t`)).t, null);
  assert.equal((await plain(`SELECT app.wizenet_ts(NULL) t`)).t, null);

  const s = await newSite();
  await save(MGR, "status", [{ id: "1", name: "פתוחה" }, { id: "9", name: "סגורה" }]);
  await sup(`UPDATE wizenet_lookups SET closed = true WHERE kind = 'status' AND id = '9'`);
  await call({ ticket_number: "T-old", parking_code: s.code, status: "1", opened_at: "2026-10-14T08:00:00Z" });
  await call({ ticket_number: "T-new", parking_code: s.code, status: "1", opened_at: "2026-10-14T11:00:00Z" });
  await call({ ticket_number: "T-shut", parking_code: s.code, status: "9", opened_at: "2026-10-14T06:00:00Z" });
  const row = (await counts(OPR)).find((c) => c.site_id === s.id);
  assert.deepEqual([row.open, row.recent], [2, 3]);
  // הוותיקה מבין ה**פתוחות** — לא הסגורה שלפניה
  assert.equal(row.oldest_open, "2026-10-14T05:00:00Z", "08:00 שעון ישראל = 05:00 UTC");
  // ובכל קריאה ברשימה — אותו זמן אמיתי, לסטופר שבחלון
  const j = (await one(OPR, `SELECT public.service_calls_open($1, 24) AS j`, [s.code])).j;
  assert.equal(j.find((x) => x.ticket === "T-old").opened_utc, "2026-10-14T05:00:00Z");
  assert.equal(j.find((x) => x.ticket === "T-old").opened_at, "2026-10-14T08:00:00Z", "המקור נשאר כמו שהגיע");
  // ⚠️ בלי opened_at — נופל לשעת ההגעה, ולא ל-NULL שהיה מאפס את הסטופר
  await call({ ticket_number: "T-none", parking_code: s.code, status: "1" });
  const j2 = (await one(OPR, `SELECT public.service_calls_open($1, 24) AS j`, [s.code])).j;
  assert.ok(j2.find((x) => x.ticket === "T-none").opened_utc, "נופל לשעת ההגעה");
});

test("S10 · שתי העמודות הקריאות: שעת הפתיחה כמו שוויזנט כתבו, ושעת ההגעה בשעון ישראל — בשני צדי מעבר השעון", { skip }, async () => {
  const s = await newSite();
  // ⚠️ מכניס **בזהות הקולט**, כמו בייצור. טריגר שאינו SECURITY DEFINER היה נופל כאן על
  // permission denied ל-app.wizenet_ts (נשללה מ-PUBLIC), כלומר כל קריאה חדשה היתה נדחית.
  const put = async (p, receivedAt) => {
    const raw = JSON.stringify(p);
    await h.as("authenticated", INT, (tx) => tx.query(
      `INSERT INTO service_calls (raw, payload, source, received_at) VALUES ($1, $3::jsonb, 'wizenet', $2)`,
      [raw, receivedAt, raw]));
    return (await sup(`SELECT opened_il, received_il FROM service_calls WHERE payload->>'ticket_number' = $1`,
      [p.ticket_number]))[0];
  };

  // קיץ (+3): ההודעה הגיעה ב-09:40:49 UTC, כלומר 12:40:49 בישראל — שלוש שניות אחרי הפתיחה
  let r = await put({ ticket_number: "S10-a", parking_code: s.code, status: "1", opened_at: "2026-10-14T12:40:46Z" },
    "2026-10-14T09:40:49.000Z");
  assert.equal(r.opened_il, "14/10/2026 12:40:46", "שעת הפתיחה — כמו שוויזנט כתבו, בלי שום הזזה");
  assert.equal(r.received_il, "14/10/2026 12:40:49", "שעת ההגעה — UTC מומר ל-+3");

  // ⚠️ חורף (+2): אותה שעת UTC היא 11:40 בישראל ולא 12:40. הזזה קבועה של 3 שעות טועה כאן בשעה,
  // ובמקביל שעת הפתיחה **אינה** זזה — שתי העמודות נבדקות יחד בדיוק כדי להבדיל בין השתיים.
  r = await put({ ticket_number: "S10-b", parking_code: s.code, status: "1", opened_at: "2026-02-01T12:40:46Z" },
    "2026-02-01T09:40:49.000Z");
  assert.equal(r.opened_il, "01/02/2026 12:40:46");
  assert.equal(r.received_il, "01/02/2026 11:40:49", "בחורף ישראל היא +2");

  // הודעה בלי opened_at — שעת פתיחה ריקה, ולא שעת ההגעה במסווה
  r = await put({ ticket_number: "S10-c", parking_code: s.code, status: "1" }, "2026-10-14T09:00:00.000Z");
  assert.equal(r.opened_il, null);
  assert.equal(r.received_il, "14/10/2026 12:00:00");

  // המילוי החד־פעמי: שורה שהעמודות שלה ריקות (כמו כל 90 השורות שקדמו לשינוי) מתמלאת בהחלה,
  // ושורה שכבר מולאה אינה נכתבת שוב — אחרת כל החלה היתה כותבת מחדש את הטבלה כולה.
  await sup(`UPDATE service_calls SET opened_il = NULL, received_il = NULL WHERE payload->>'ticket_number' = 'S10-a'`);
  await sup(`UPDATE service_calls SET received_il = 'שומר' WHERE payload->>'ticket_number' IN ('S10-b','S10-c')`);
  const fs = require("node:fs"), path = require("node:path");
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "service-calls.postgres.sql"), "utf8");
  await h.pg.exec(sql);
  await h.pg.exec(sql);                      // ⚠️ אידמפוטנטי — הקובץ הזה לא נבדק בהחלה כפולה עד כה
  const after = await sup(`SELECT opened_il, received_il FROM service_calls
                            WHERE payload->>'ticket_number' IN ('S10-a','S10-b','S10-c')
                            ORDER BY payload->>'ticket_number'`);
  assert.equal(after[0].opened_il, "14/10/2026 12:40:46", "התמלאה בהחלה");
  assert.equal(after[0].received_il, "14/10/2026 12:40:49");
  assert.equal(after[1].received_il, "שומר", "שורה שמולאה אינה נכתבת שוב");
  // ⚠️ וגם שורה שאין לה opened_at: התנאי הוא received_il דווקא כדי שהיא לא תיכתב מחדש בכל החלה
  assert.equal(after[2].received_il, "שומר", "גם שורה בלי שעת פתיחה אינה נכתבת שוב");
  // ⚠️ והטריגר הוא BEFORE INSERT בלבד: שתי ה-UPDATE למעלה שרדו, ולא "תוקנו" חזרה.
  assert.equal((await sup(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'service_calls_local'`))[0].n, 1);
});

test("S7 · הקובץ אידמפוטנטי — החלה שנייה לא נכשלת ולא מכפילה טריגר", { skip }, async () => {
  const fs = require("node:fs"), path = require("node:path");
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "service-calls-board.postgres.sql"), "utf8");
  await h.pg.exec(sql);
  await h.pg.exec(sql);
  const trg = await sup(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'service_calls_event'`);
  assert.equal(trg[0].n, 1);
});
