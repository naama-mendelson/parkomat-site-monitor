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
// ⚠️ 15/10/2026: הרישום אינו ציבורי עוד — רק הממסר מגיע אליו, אחרי שוויזנט ענו (wizenet-relay.test.js). כאן
// הפונקציות הפנימיות נקראות ישירות, בשם ובמשתמש של מי שלחץ — בדיוק מה ש-app.wizenet_complete מעביר להן.
// ⚠️ בזהות הסוכן ובתפקיד postgres — כמו בתוך app.wizenet_complete (SECURITY DEFINER, שנקרא מהממסר). דרך `sup` בלי
// זהות, התביעות שבדיקה קודמת השאירה ריקות ('') שוברות את current_actor על ''::json.
const sys = async (sql, params = []) => (await h.as("postgres", AGT, (tx) => tx.query(sql, params))).rows;
const who = async (uid) => (await sup(`SELECT id, COALESCE(NULLIF(btrim(full_name), ''), email) AS name FROM app_users WHERE supabase_uid = $1`, [uid]))[0];
const save = async (uid, kind, items) => (await sys(`SELECT app.wizenet_lookups_store($1, $2::jsonb, $3) AS n`,
  [kind, JSON.stringify(items), (await who(uid)).name]))[0];
const change = async (uid, ticket, field, value) => {
  const u = await who(uid);
  const r = (await sys(`SELECT app.service_call_store_change($1, $2, $3, $4, $5) AS at`, [ticket, field, value, u.name, u.id]))[0];
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
  await fails(sys(`SELECT app.wizenet_lookups_store('status', '{"a":1}'::jsonb, 'x')`), "23514", /רשימה לא תקינה/);
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

// ⚠️ 15/10/2026: עד היום כל איש צוות יכול היה לרשום מהדפדפן "שינוי שוויזנט אישרו" ולטעון "רשימה מוויזנט"
// בלי שאיש פנה לוויזנט. הפונקציות הציבוריות נמחקו, והפנימיות אינן ניתנות לקריאה — לא למנהל ולא לבקר.
test("S5א · הרישום והרשימות — לא מהדפדפן: הפונקציות הציבוריות אינן, והפנימיות חסומות לכולם", { skip }, async () => {
  const gone = await sup(`SELECT proname FROM pg_proc WHERE proname IN ('wizenet_lookups_save', 'service_call_record_change')`);
  assert.deepEqual(gone, []);
  for (const uid of [MGR, OPR, AGT]) {
    await fails(rpc(uid, `SELECT app.wizenet_lookups_store('status', '[]'::jsonb, 'x')`), "42501");
    await fails(rpc(uid, `SELECT app.service_call_store_change('1', 'status', '1', 'x', NULL)`), "42501");
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

test("S11 · כפילות: אותו אדם, אותו טקסט, אותו רגע — שורה אחת; והקבוצה פתוחה אם אחת מהן פתוחה", { skip }, async () => {
  const s = await newSite();
  await save(MGR, "status", [{ id: "1", name: "פתוחה" }, { id: "9", name: "סגורה" }]);
  await sup(`UPDATE wizenet_lookups SET closed = true WHERE kind = 'status' AND id = '9'`);
  const T = "2026-10-14T12:00:";
  const dup = (t, sec, extra = {}) => call({
    ticket_number: t, parking_code: s.code, status: "1", phone: "054-0000001",
    first_name: "ישראל", last_name: "ישראלי", customer_complaint: "המתקן לא מגיב",
    opened_at: `${T}${String(sec).padStart(2, "0")}Z`, ...extra,
  });

  // שמונה קריאות נפרדות בפערים של 2–3 שניות, כמו באתר 1312
  for (const [i, sec] of [21, 24, 26, 28, 30, 32, 35, 37].entries()) await dup(`D${i}`, sec);
  let j = (await one(OPR, `SELECT public.service_calls_open($1) AS j`, [s.code])).j;
  assert.equal(j.length, 1, "שמונה קריאות זהות — שורה אחת");
  assert.equal(j[0].dup_n, 8);
  assert.equal(j[0].ticket, "D0", "הנציגה היא הוותיקה");
  assert.equal((await counts(OPR)).find((r) => r.site_id === s.id).open, 1, "והספירה על הכרטיס — אחת");

  // ⚠️ פער גדול מהחלון — פנייה חוזרת אמיתית, ולא כפילות
  await dup("D-later", 0, { opened_at: "2026-10-14T12:05:00Z" });
  j = (await one(OPR, `SELECT public.service_calls_open($1) AS j`, [s.code])).j;
  assert.deepEqual(j.map((x) => [x.ticket, x.dup_n]).sort(), [["D-later", 1], ["D0", 8]]);

  // טקסט אחר באותו רגע — שתי קריאות
  await dup("D-other", 22, { customer_complaint: "משהו אחר לגמרי" });
  assert.equal((await one(OPR, `SELECT public.service_calls_open($1) AS j`, [s.code])).j.length, 3);

  // ⚠️ אחת מהצרור נסגרה — הקבוצה עדיין פתוחה, והנציגה היא פתוחה
  await dup("D0", 21, { status: "9" });
  j = (await one(OPR, `SELECT public.service_calls_open($1) AS j`, [s.code])).j;
  const grp = j.find((x) => x.dup_n === 8);
  assert.equal(grp.open, true, "אחת נסגרה — הקבוצה פתוחה");
  assert.notEqual(grp.ticket, "D0", "הנציגה התחלפה לפתוחה");
  assert.equal(grp.status_id, "1", "והמצב המוצג הוא של הקריאה הפתוחה");

  // כולן נסגרו — הקבוצה סגורה, ויורדת מהפתוחות אבל נשארת בספירת היום
  for (const [i, sec] of [21, 24, 26, 28, 30, 32, 35, 37].entries()) await dup(`D${i}`, sec, { status: "9" });
  const row = (await counts(OPR)).find((r) => r.site_id === s.id);
  assert.equal(row.open, 2, "נשארו החוזרת והאחרת");
  assert.equal(row.recent, 3, "וביום — שלוש שורות, לא עשר");
  assert.equal((await one(OPR, `SELECT public.service_calls_recent(24) AS j`, [])).j
    .filter((x) => x.site_code === s.code).length, 3, "וגם 'קריאות היום' מאוחד");
});

test("S12 · מה מפריד בין קריאות: אדם, טקסט ואתר — וכשאין טקסט בכלל, אין איחוד", { skip }, async () => {
  const s = await newSite();
  await save(MGR, "status", [{ id: "1", name: "פתוחה" }]);
  const list = async (code) => (await one(OPR, `SELECT public.service_calls_open($1) AS j`, [code ?? s.code])).j;
  const put = (t, p) => call({ ticket_number: t, parking_code: s.code, status: "1", ...p });

  // ⚠️ אותו טלפון, אותו רגע, **בלי טקסט בכלל** — שתי קריאות. זו ההגנה היחידה שנשארה:
  // בלי טקסט אין במה להשוות, ומוקד שמתקשר בלי לכתוב דבר היה מאבד קריאות.
  await put("E1", { phone: "050-1111111", opened_at: "2026-10-14T12:00:00Z" });
  await put("E2", { phone: "050-1111111", opened_at: "2026-10-14T12:00:02Z" });
  assert.deepEqual((await list()).map((x) => [x.ticket, x.dup_n]).sort(), [["E1", 1], ["E2", 1]],
    "בלי טקסט — אין איחוד");

  // שני אנשים **שונים**, אותו אתר, אותו טקסט, אותה שנייה — שתי קריאות
  await put("W1", { phone: "050-2222222", customer_complaint: "המתקן לא מגיב", opened_at: "2026-10-14T12:10:00Z" });
  await put("W2", { phone: "050-3333333", customer_complaint: "המתקן לא מגיב", opened_at: "2026-10-14T12:10:01Z" });
  const two = (await list()).filter((x) => x.ticket.startsWith("W"));
  assert.deepEqual(two.map((x) => x.dup_n), [1, 1], "שני אנשים אינם כפילות");

  // אותו אדם, אותו טקסט, אותו רגע — אחת. וטלפון באותו מספר בכתיב אחר הוא אותו אדם.
  await put("F1", { phone: "052-000-0002", customer_complaint: "בירור", opened_at: "2026-10-14T12:20:00Z" });
  await put("F2", { phone: "0520000002", customer_complaint: "בירור", opened_at: "2026-10-14T12:20:03Z" });
  const ph = (await list()).filter((x) => x.ticket.startsWith("F"));
  assert.deepEqual(ph.map((x) => [x.ticket, x.dup_n]), [["F1", 2]], "מקפים אינם אדם אחר");

  // בלי טלפון — מזהים לפי השם
  const byName = (t, sec) => put(t, { first_name: "דמות", last_name: "לבדיקה",
    customer_complaint: "טכנאי", opened_at: `2026-10-14T12:30:0${sec}Z` });
  await byName("M1", 1); await byName("M2", 4);
  assert.deepEqual((await list()).filter((x) => x.ticket.startsWith("M")).map((x) => [x.ticket, x.dup_n]),
    [["M1", 2]], "אותו שם, אותו טקסט, אותו רגע");

  // ⚠️ **אנונימי — כן מתאחד.** בלי טלפון ובלי שם, אבל עם אותו טקסט באותו רגע ובאותו אתר: זו אותה
  // תקלה אחת, וזו בדיוק הכפילות שנתבקשה. ההחלטה מתועדת כאן כדי שלא תשתנה בשקט.
  await put("A1", { customer_complaint: "דלת תקועה", opened_at: "2026-10-14T12:40:00Z" });
  await put("A2", { customer_complaint: "דלת תקועה", opened_at: "2026-10-14T12:40:02Z" });
  assert.deepEqual((await list()).filter((x) => x.ticket.startsWith("A")).map((x) => [x.ticket, x.dup_n]),
    [["A1", 2]], "שתי פניות אנונימיות זהות — אחת");

  // ⚠️ **הקיבוץ הוא לפי זמן, לא לפי מספר הקריאה.** שלוש קריאות שבהן סדר המספרים הפוך מסדר
  // הפתיחה: Z ב-12:50:00, A ב-12:50:02, M ב-12:55:00. לפי זמן — Z ו-A הן אחת, M נפרדת. לפי
  // מספר הקריאה היו יוצאות שלוש. ⚠️ מספרי הקריאה של ויזנט אכן עולים עם הזמן, ולכן הטעות הזו
  // לא הייתה נראית בייצור — עד לקריאה אחת שתוזן באיחור.
  const ooo = (t, mmss) => put(t, { phone: "050-9999999", customer_complaint: "סדר",
    opened_at: `2026-10-14T12:${mmss}Z` });
  await ooo("Z", "50:00"); await ooo("A", "50:02"); await ooo("M", "55:00");
  assert.deepEqual((await list()).filter((x) => ["Z", "A", "M"].includes(x.ticket))
    .map((x) => [x.ticket, x.dup_n]).sort(), [["M", 1], ["Z", 2]], "מקבצים לפי זמן ולא לפי מספר");

  // ⚠️ **ההשוואה היא על השורה הראשונה.** נמדד בייצור: 48 מתוך 76 הקריאות שינו את הטקסט בין
  // השורה הראשונה לאחרונה — ויזנט מקודדים את אותה הערה פעם `<br>`, פעם `<br />` ופעם מוברחת
  // כ-`&lt;br /&gt;`. לפי השורה האחרונה הצרור הזה היה מתפצל, וכך באמת קרה באתר 1376 (3 במקום 4).
  const NOTE0 = "0500000003<br>שורה שנייה <br>";
  await put("G1", { phone: "050-8888888", customer_complaint: "טכנאי", notes: NOTE0,
    opened_at: "2026-10-14T13:00:00Z" });
  await put("G2", { phone: "050-8888888", customer_complaint: "טכנאי", notes: NOTE0,
    opened_at: "2026-10-14T13:00:03Z" });
  // ועכשיו עדכון על G1 שבו אותה הערה מוברחת — הטקסט האחרון שונה, הראשון זהה
  await put("G1", { phone: "050-8888888", customer_complaint: "טכנאי",
    notes: "0500000003&lt;br /&gt; שורה שנייה", opened_at: "2026-10-14T13:00:00Z" });
  assert.deepEqual((await list()).filter((x) => x.ticket.startsWith("G")).map((x) => [x.ticket, x.dup_n]),
    [["G1", 2]], "קידוד HTML שהשתנה בשורה מאוחרת אינו מפצל את הצרור");

  // ⚠️ רווחים בלבד אינם טקסט אחר
  await put("S1a", { phone: "050-7777777", customer_complaint: "דלת   תקועה", notes: " \n ",
    opened_at: "2026-10-14T13:10:00Z" });
  await put("S1b", { phone: "050-7777777", customer_complaint: "דלת תקועה", notes: "",
    opened_at: "2026-10-14T13:10:02Z" });
  assert.deepEqual((await list()).filter((x) => x.ticket.startsWith("S1")).map((x) => [x.ticket, x.dup_n]),
    [["S1a", 2]], "רווחים כפולים ושורה חדשה אינם טקסט אחר");

  // ⚠️ וגם זמן הקיבוץ מהשורה הראשונה: עדכון שמגיע עם opened_at אחר אינו מזיז את הקריאה לקבוצה
  // אחרת. בייצור opened_at זהה בכל שורות הקריאה, ולכן טעות כאן לא הייתה נראית.
  await put("H1", { phone: "050-6666666", customer_complaint: "זמן", opened_at: "2026-10-14T13:20:00Z" });
  await put("H2", { phone: "050-6666666", customer_complaint: "זמן", opened_at: "2026-10-14T13:20:02Z" });
  await put("H1", { phone: "050-6666666", customer_complaint: "זמן", opened_at: "2026-10-14T13:40:00Z" });
  assert.deepEqual((await list()).filter((x) => x.ticket.startsWith("H")).map((x) => [x.ticket, x.dup_n]),
    [["H1", 2]], "הקיבוץ לפי זמן הפתיחה הראשון");

  // ⚠️ אותו אדם ואותו טקסט אבל **אתר אחר** — שתי קריאות
  const s2 = await newSite();
  await call({ ticket_number: "X1", parking_code: s2.code, status: "1", phone: "052-000-0002",
    customer_complaint: "בירור", opened_at: "2026-10-14T12:20:01Z" });
  assert.deepEqual((await list(s2.code)).map((x) => [x.ticket, x.dup_n]), [["X1", 1]], "אתר אחר — קריאה אחרת");
});

test("S7 · הקובץ אידמפוטנטי — החלה שנייה לא נכשלת ולא מכפילה טריגר", { skip }, async () => {
  const fs = require("node:fs"), path = require("node:path");
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "service-calls-board.postgres.sql"), "utf8");
  await h.pg.exec(sql);
  await h.pg.exec(sql);
  const trg = await sup(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'service_calls_event'`);
  assert.equal(trg[0].n, 1);
});

// ============================================================
// 15/10/2026 — מהכרטיס: רק פתוחות, ו"להיסטוריה"; ובכותרת: כמה פתוחות
// ============================================================
// בעלת המוצר: "כשלוחצים על כרטיס כדי לראות את הקריאות — יראו רק קריאות פתוחות, ויהיה כפתור 'להיסטוריה'",
// ועל האריח "קריאות היום": "שיהיה כתוב כמה פתוחות".
async function callAt(p, receivedIso) {
  const raw = JSON.stringify(p);
  await h.as("authenticated", INT, (tx) => tx.query(`INSERT INTO service_calls (raw, payload, source, received_at) VALUES ($1, $3::jsonb, 'wizenet', $2)`,
    [raw, receivedIso, raw]));
  await sleep(5);
}
const historyOf = async (uid, code, limit) =>
  (await one(uid, limit == null ? `SELECT public.service_calls_history($1) AS j` : `SELECT public.service_calls_history($1, $2) AS j`,
    limit == null ? [code] : [code, limit])).j;

test("S13 · מהכרטיס רק פתוחות; 'להיסטוריה' — רק הסגורות, החדשה למעלה, עם total ותקרה; ואותה צורה בדיוק", { skip }, async () => {
  const s = await newSite(), other = await newSite();
  await save(MGR, "status", [{ id: "1", name: "פתוחה" }, { id: "9", name: "סגורה" }]);
  await call({ ticket_number: "S13-o1", parking_code: s.code, status: "1", opened_at: "2026-10-10T08:00:00Z", customer_complaint: "פתוחה ישנה" });
  await call({ ticket_number: "S13-o2", parking_code: s.code, status: "1", opened_at: "2026-10-12T08:00:00Z", customer_complaint: "פתוחה" });
  await call({ ticket_number: "S13-c1", parking_code: s.code, status: "9", opened_at: "2026-10-11T08:00:00Z", customer_complaint: "סגורה א" });
  await call({ ticket_number: "S13-c2", parking_code: s.code, status: "9", opened_at: "2026-10-13T08:00:00Z", customer_complaint: "סגורה ב" });
  await call({ ticket_number: "S13-c3", parking_code: s.code, status: "9", opened_at: "2026-10-12T09:00:00Z", customer_complaint: "סגורה ג" });
  await call({ ticket_number: "S13-x", parking_code: other.code, status: "9", opened_at: "2026-10-14T08:00:00Z", customer_complaint: "אתר אחר" });
  // ⚠️ בלי opened_at: הרגע שלה הוא ההגעה אלינו — 12/10 07:30 UTC. c3 נפתחה 12/10 "09:00Z" בשעון הקיר של ויזנט,
  // כלומר 06:00 UTC — **לפני** c4. השוואת הטקסטים ("07:30" < "09:00") שמה את c4 אחריה (סקירה, 15/10/2026).
  await callAt({ ticket_number: "S13-c4", parking_code: s.code, status: "9", customer_complaint: "סגורה בלי מועד פתיחה" },
    "2026-10-12T07:30:00.000Z");

  // מהכרטיס (בלי שעות): רק פתוחות — גם סגורה שנסגרה היום אינה כאן
  assert.deepEqual((await openOf(OPR, s.code)).map((c) => c.ticket), ["S13-o1", "S13-o2"]);
  // בנייה ישנה ששולחת p_hours — מקבלת בדיוק את מה שקיבלה (פתוחות קודם, ואז מה שנסגר בחלון)
  assert.deepEqual((await one(OPR, `SELECT public.service_calls_open($1, 24) AS j`, [s.code])).j.map((c) => c.ticket),
    ["S13-o1", "S13-o2", "S13-c1", "S13-c3", "S13-c2"]);

  // היסטוריה: רק הסגורות, החדשה למעלה לפי **הרגע האמיתי** של הפתיחה; לא של אתר אחר; total = כמה יש בכלל
  const hist = await historyOf(OPR, s.code);
  assert.deepEqual(hist.calls.map((c) => c.ticket), ["S13-c2", "S13-c4", "S13-c3", "S13-c1"]);
  assert.equal(hist.total, 4);
  assert.ok(hist.calls.every((c) => c.open === false && c.status_name === "סגורה"));
  // תקרה: 2 — שתי החדשות, ו-total עדיין 4 (החלון אומר "מוצגות 2 מתוך 4")
  const lim = await historyOf(OPR, s.code, 2);
  assert.deepEqual([lim.calls.map((c) => c.ticket), lim.total], [["S13-c2", "S13-c4"], 4]);
  // תקרה לא הגיונית — נחתכת לטווח, לא נכשלת
  assert.equal((await historyOf(OPR, s.code, 0)).calls.length, 1);
  assert.equal((await historyOf(OPR, s.code, 100000)).calls.length, 4);
  // ⚠️ אותה צורה בדיוק בשתי הרשימות — בונה אחד. שדה שנוסף לאחת בלבד היה נראה רק בה.
  const open = await openOf(OPR, s.code);
  assert.deepEqual(Object.keys(open[0]).sort(), Object.keys(hist.calls[0]).sort());
  // קוד עם רווחים (הדבקה) — אותו אתר, בשתי הרשימות
  assert.deepEqual((await historyOf(OPR, ` ${s.code} `)).calls.map((c) => c.ticket), ["S13-c2", "S13-c4", "S13-c3", "S13-c1"]);
  assert.deepEqual((await openOf(OPR, ` ${s.code} `)).map((c) => c.ticket), ["S13-o1", "S13-o2"]);
  // אתר בלי סגורות — רשימה ריקה ו-0, לא null
  assert.deepEqual(await historyOf(OPR, (await newSite()).code), { calls: [], total: 0 });
  // רק צוות
  for (const uid of [AGT, INT]) await fails(historyOf(uid, s.code), "42501");
});

test("S14 · 'קריאות היום': סופר את היום; 'פתוחות' — כל הפתוחות; הרשימה — שתיהן, והאריח והרשימה מסכימים", { skip }, async () => {
  const s = await newSite();
  await save(MGR, "status", [{ id: "1", name: "פתוחה" }, { id: "9", name: "סגורה" }]);
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  // פתוחה שלא עודכנה שלושה ימים — ברשימה (כי פתוחה), אבל **לא** "של היום"; סגורה ישנה — בכלל לא
  await callAt({ ticket_number: "S14-old-open", parking_code: s.code, status: "1", customer_complaint: "פתוחה ישנה" }, old);
  await callAt({ ticket_number: "S14-old-closed", parking_code: s.code, status: "9", customer_complaint: "סגורה ישנה" }, old);
  await call({ ticket_number: "S14-new-open", parking_code: s.code, status: "1", customer_complaint: "פתוחה חדשה" });
  await call({ ticket_number: "S14-new-closed", parking_code: s.code, status: "9", customer_complaint: "סגורה חדשה" });

  const listOf = async () => (await one(OPR, `SELECT public.service_calls_recent(24) AS j`)).j;
  const sumOf = async () => (await one(OPR, `SELECT public.service_calls_recent_summary(24) AS j`)).j;
  const mineOf = (list) => Object.fromEntries(list.filter((c) => c.site_code === s.code).map((c) => [c.ticket, c.in_window]));
  // ⚠️ האריח והרשימה — אותן שורות ואותו תנאי: total = השורות שבחלון, open = השורות הפתוחות
  const agree = (list, sum, why) => {
    assert.equal(sum.total, list.filter((c) => c.in_window).length, `${why}: total = שורות "היום" ברשימה`);
    assert.equal(sum.open, list.filter((c) => c.open).length, `${why}: open = הפתוחות ברשימה`);
  };

  let list = await listOf();
  assert.deepEqual(mineOf(list), { "S14-new-closed": true, "S14-new-open": true, "S14-old-open": false });
  let sum = await sumOf();
  agree(list, sum, "לפני");
  // הישנה (בנייה קודמת) — אותו total, כלומר **היום** בלבד, כמו שהיה מ-14/10
  assert.equal((await one(OPR, `SELECT public.service_calls_recent_count(24) AS n`)).n, sum.total);
  const before = sum;

  // ⚠️ סגירה **היום** של הקריאה הישנה — דרך הרישום של הממסר. היא נשארת ברשימה (סגורה, ועכשיו "של היום"), ולא נעלמת:
  // השינוי שלנו הוא הדבר האחרון שקרה לה (סקירה, 15/10/2026)
  await change(MGR, "S14-old-open", "status", "9");
  list = await listOf();
  assert.deepEqual(mineOf(list), { "S14-new-closed": true, "S14-new-open": true, "S14-old-open": true });
  assert.equal(list.find((c) => c.ticket === "S14-old-open").open, false);
  sum = await sumOf();
  agree(list, sum, "אחרי");
  assert.deepEqual([sum.total - before.total, sum.open - before.open], [1, -1]);
  // וכך גם הספירה על הכרטיס ("היום" של האתר), והחלון מהכרטיס של בנייה ישנה (p_hours) — אותו חלון
  const card = (await counts(OPR)).find((r) => r.site_id === s.id);
  assert.deepEqual([card.open, card.recent], [1, 3]);
  assert.ok((await one(OPR, `SELECT public.service_calls_open($1, 24) AS j`, [s.code])).j.some((c) => c.ticket === "S14-old-open"),
    "בנייה ישנה: הקריאה שנסגרה היום נשארת בחלון מהכרטיס, מסומנת סגורה");

  // מי שאינו צוות — אפסים, לא שגיאה (נטען עם הלוח)
  assert.deepEqual((await one(AGT, `SELECT public.service_calls_recent_summary(24) AS j`)).j, { total: 0, open: 0 });
  assert.equal((await one(AGT, `SELECT public.service_calls_recent_count(24) AS n`)).n, 0);
});

// ⚠️ התקרה עצמה — עם יותר קריאות סגורות ממנה. בלי זה, "ברירת מחדל 100" ו"לכל היותר 500" שרדו מוטציה: ב-S13 יש שלוש.
test("S15 · היסטוריה ארוכה: ברירת המחדל 100 החדשות, לכל היותר 500, ו-total — כולן", { skip }, async () => {
  const s = await newSite();
  await save(MGR, "status", [{ id: "1", name: "פתוחה" }, { id: "9", name: "סגורה" }]);
  // 501 סגורות בפקודה אחת, בזהות הקולט (כמו call()); טקסט שונה לכל אחת — אחרת הן מתאחדות ככפילות
  await h.as("authenticated", INT, (tx) => tx.query(`
    INSERT INTO service_calls (raw, payload, source, received_at)
    SELECT x.p::text, x.p, 'wizenet', to_char(now() - make_interval(secs => g), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM generate_series(1, 501) g,
           LATERAL (SELECT jsonb_build_object('ticket_number', 'S15-' || g, 'parking_code', $1::text, 'status', '9',
                     'opened_at', to_char(timestamp '2026-01-01' + make_interval(mins => g), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                     'customer_complaint', 'סגורה ' || g) AS p) x`, [s.code]));

  const def = await historyOf(OPR, s.code);
  assert.equal(def.calls.length, 100, "בלי p_limit — 100");
  assert.equal(def.total, 501);
  assert.deepEqual([def.calls[0].ticket, def.calls[99].ticket], ["S15-501", "S15-402"], "החדשות למעלה");
  // NULL מפורש (לקוח ששולח p_limit: null) — כמו בלי הפרמטר. ⚠️ ה-DEFAULT בחתימה אינו חל על NULL שנשלח
  assert.equal((await one(OPR, `SELECT public.service_calls_history($1, NULL) AS j`, [s.code])).j.calls.length, 100);
  const max = await historyOf(OPR, s.code, 1000);
  assert.equal(max.calls.length, 500, "תקרה גבוהה מדי — נחתכת ל-500");
  assert.equal(max.total, 501);
});

test("S16 · service_calls_board — הכרטיסים והכותרת בקריאה אחת, שורה-לשורה כמו שתי הישנות; לא-צוות — לוח ריק בלי לזרוק", { skip }, async () => {
  const s = await newSite();
  await save(MGR, "status", [{ id: "1", name: "פתוחה" }, { id: "9", name: "סגורה" }]);
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  await callAt({ ticket_number: "S16-old-open", parking_code: s.code, status: "1", customer_complaint: "ישנה פתוחה" }, old);
  await callAt({ ticket_number: "S16-old-closed", parking_code: s.code, status: "9", customer_complaint: "ישנה סגורה" }, old);
  await call({ ticket_number: "S16-new-open", parking_code: s.code, status: "1", customer_complaint: "חדשה" });
  await call({ ticket_number: "S16-new-closed", parking_code: s.code, status: "9", customer_complaint: "חדשה סגורה" });
  await call({ ticket_number: "S16-nosite", parking_code: "9999-1-01", status: "1" });   // בלי אתר — בכותרת, לא בכרטיסים

  const board = (await one(OPR, `SELECT public.service_calls_board(24) AS j`)).j;
  const counts = await rpc(OPR, `SELECT site_id, open, recent, oldest_open FROM public.service_call_counts(24) ORDER BY site_id`);
  const sum = (await one(OPR, `SELECT public.service_calls_recent_summary(24) AS j`)).j;
  // ⚠️ מ-19/10/2026 ללוח יש גם age / age_hours (S17); השדות המשותפים — זהים
  const shared = board.sites.map(({ site_id, open, recent, oldest_open }) => ({ site_id, open, recent, oldest_open }));
  assert.deepEqual(shared, counts, "אותן שורות, אותו סדר, אותם שדות — כולל oldest_open");
  assert.ok(board.sites.every((r) => Number.isInteger(r.age) && r.age >= 0 && r.age <= 4), "age לכל שורה");
  assert.deepEqual(board.summary, sum, "אותה כותרת");
  const mine = board.sites.find((r) => r.site_id === s.id);
  assert.deepEqual({ open: mine.open, recent: mine.recent }, { open: 2, recent: 2 });
  assert.ok(mine.oldest_open, "סטופר — מהפתוחה הוותיקה");
  // לא-צוות: לוח ריק, לא שגיאה (נטען עם הלוח; כשל כאן לא מפיל אותו)
  assert.deepEqual((await one(AGT, `SELECT public.service_calls_board(24) AS j`)).j, { sites: [], summary: { total: 0, open: 0 } });
  // ברירת המחדל — 24 שעות
  assert.deepEqual((await one(OPR, `SELECT public.service_calls_board() AS j`)).j, board);
});

// ============================================================
// S17 — החמרה של קריאה פתוחה שלא טופלה (19/10/2026)
// ============================================================
// בעלת המוצר: מכפיל מחמיר כל 24 שעות שירות, רובוטי כל שעת שירות; זמן מחוץ לשעות השירות לא נספר; לבן → צהוב →
// כתום → אדום → שחור (0..4); אתר בלי שעות שירות — נשאר לבן.
test("S17 · שעות שירות בין שני רגעים — שעון ישראל, רק בתוך החלונות; סוג בלי שעות — אפס", { skip }, async () => {
  const secs = async (kind, from, to) => Number((await sup(`SELECT app.service_seconds($1, $2::timestamptz, $3::timestamptz) AS s`, [kind, from, to]))[0].s);
  // יום ב' 19/10/2026: בסיסי 08:00–17:00 (שעון ישראל, UTC+3)
  assert.equal(await secs("basic", "2026-10-19T06:00:00+03:00", "2026-10-19T20:00:00+03:00"), 9 * 3600, "יום עבודה אחד");
  assert.equal(await secs("basic", "2026-10-19T16:30:00+03:00", "2026-10-20T09:00:00+03:00"), 1.5 * 3600, "חצי שעה בערב + שעה בבוקר");
  assert.equal(await secs("BASIC ", "2026-10-19T08:00:00+03:00", "2026-10-19T09:00:00+03:00"), 3600, "אותיות ורווח — מנורמל");
  // שישי-שבת: בסיסי — כלום; מורחב — שישי 08:00–13:00; VIP — שבת 08:00–22:00
  assert.equal(await secs("basic", "2026-10-23T00:00:00+03:00", "2026-10-25T00:00:00+03:00"), 0, "סוף שבוע בבסיסי");
  assert.equal(await secs("ext", "2026-10-23T00:00:00+03:00", "2026-10-24T00:00:00+03:00"), 5 * 3600, "שישי במורחב");
  assert.equal(await secs("vip", "2026-10-24T00:00:00+03:00", "2026-10-25T00:00:00+03:00"), 14 * 3600, "שבת ב-VIP");
  for (const k of ["no_service", "none", "maintenance_only", null, ""]) {
    assert.equal(await secs(k, "2026-10-19T00:00:00+03:00", "2026-10-26T00:00:00+03:00"), 0, `בלי שעות שירות: ${k}`);
  }
  assert.equal(await secs("basic", "2026-10-20T10:00:00+03:00", "2026-10-19T10:00:00+03:00"), 0, "טווח הפוך — אפס, לא שלילי");
});

test("S17 · השלב: רובוטי — כל שעת שירות, מכפיל — כל 24 שעות שירות, עד 4 (שחור)", { skip }, async () => {
  const lvl = async (s, m) => (await sup(`SELECT app.call_age_level($1, $2) AS l`, [s, m]))[0].l;
  const H = 3600;
  assert.deepEqual([await lvl(0, true), await lvl(H - 1, true), await lvl(H, true), await lvl(2 * H, true), await lvl(3 * H, true), await lvl(4 * H, true), await lvl(30 * H, true)],
    [0, 0, 1, 2, 3, 4, 4], "רובוטי");
  assert.deepEqual([await lvl(23 * H, false), await lvl(24 * H, false), await lvl(48 * H, false), await lvl(72 * H, false), await lvl(96 * H, false), await lvl(500 * H, false)],
    [0, 1, 2, 3, 4, 4], "מכפיל");
  assert.equal(await lvl(null, true), 0);
  assert.equal(await lvl(-50, true), 0, "שלילי — 0");
  assert.equal(await lvl(5 * H, null), 4, "בלי ערך monitored — כמו אתר עם בקר");
});

test("S17 · בלוח: הקריאה הוותיקה, סוג השירות מהרמזור (למכפיל — לוח המכפילים), בלי שעות שירות — 0", { skip }, async () => {
  await save(MGR, "status", [{ id: "1", name: "פתוחה" }, { id: "9", name: "סגורה" }]);
  await sup(`INSERT INTO traffic_light_columns (key, label, kind, position) VALUES
    ('c_code','קוד אתר','text',1), ('c_kind','להתייחס כ','text',3) ON CONFLICT (key) DO NOTHING`);
  await sup(`INSERT INTO traffic_light_columns (key, label, kind, position, board) VALUES
    ('c_mx_plan','סוג הסכם שירות','status',2,'multipliers') ON CONFLICT (key) DO NOTHING`);
  const robot = await newSite();            // רובוטי, VIP
  const robotNone = await newSite();        // רובוטי, לא חובר לרמזור
  const mx = await newSite();               // מכפיל, בסיסי (מלוח המכפילים)
  const mxOff = await newSite();            // מכפיל, "לא בשירות"
  await sup(`UPDATE sites SET monitored = false WHERE id = ANY($1)`, [[mx.id, mxOff.id]]);
  await sup(`INSERT INTO traffic_light_rows (cells, position, board) VALUES ($1::jsonb, 1, 'robotic')`, [JSON.stringify({ c_code: robot.code, c_kind: "vip" })]);
  await sup(`INSERT INTO traffic_light_rows (cells, position, board) VALUES ($1::jsonb, 2, 'multipliers'), ($2::jsonb, 3, 'multipliers')`,
    [JSON.stringify({ c_mx_site_code: mx.code, c_mx_plan: "בסיסי" }), JSON.stringify({ c_mx_site_code: mxOff.code, c_mx_plan: "לא בשירות" })]);
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  // שתי קריאות פתוחות ברובוטי — הוותיקה (10 ימים) קובעת; וסגורה ישנה עוד יותר — לא נספרת
  await callAt({ ticket_number: "S17-r-new", parking_code: robot.code, status: "1", customer_complaint: "חדשה" }, ago(0.01));
  await callAt({ ticket_number: "S17-r-old", parking_code: robot.code, status: "1", customer_complaint: "ותיקה" }, ago(10));
  await callAt({ ticket_number: "S17-r-closed", parking_code: robot.code, status: "9", customer_complaint: "סגורה" }, ago(30));
  await callAt({ ticket_number: "S17-rn", parking_code: robotNone.code, status: "1", customer_complaint: "לא חובר" }, ago(10));
  await callAt({ ticket_number: "S17-mx", parking_code: mx.code, status: "1", customer_complaint: "מכפיל" }, ago(30));
  await callAt({ ticket_number: "S17-mxoff", parking_code: mxOff.code, status: "1", customer_complaint: "לא בשירות" }, ago(30));
  const board = (await one(OPR, `SELECT public.service_calls_board(24) AS j`)).j;
  const row = (s) => board.sites.find((r) => r.site_id === s.id);
  // עשרה ימים ב-VIP הם 103×10/7 ≈ 147 שעות שירות → שחור; ב-30 ימים בבסיסי ~190 שעות שירות → 7 שלבים → שחור (4)
  assert.equal(row(robot).age, 4, "רובוטי VIP, 10 ימים — שחור");
  assert.ok(row(robot).age_hours > 100, `שעות שירות: ${row(robot).age_hours}`);
  assert.equal(row(robotNone).age, 0, "לא חובר לרמזור — לבן");
  assert.equal(row(robotNone).age_hours, 0);
  assert.equal(row(mx).age, 4, "מכפיל בסיסי, 30 ימים — שחור");
  assert.equal(row(mxOff).age, 0, "מכפיל 'לא בשירות' — לבן");
  // השעות נספרות מהוותיקה: יותר מהקריאה החדשה (דקות)
  const fresh = await newSite();
  await sup(`INSERT INTO traffic_light_rows (cells, position, board) VALUES ($1::jsonb, 4, 'robotic')`, [JSON.stringify({ c_code: fresh.code, c_kind: "vip" })]);
  await callAt({ ticket_number: "S17-fresh", parking_code: fresh.code, status: "1", customer_complaint: "רק נפתחה" }, ago(0.0005));
  const b2 = (await one(OPR, `SELECT public.service_calls_board(24) AS j`)).j;
  assert.equal(b2.sites.find((r) => r.site_id === fresh.id).age, 0, "נפתחה לפני דקה — לבן");
  // ⚠️ סוג השירות: "להתייחס כ" גובר על "סוג הסכם במקור", כמו על הכרטיס (effectiveTier)
  await sup(`INSERT INTO traffic_light_columns (key, label, kind, position) VALUES ('c_plan','סוג הסכם שירות במקור','text',2) ON CONFLICT (key) DO NOTHING`);
  const served = await newSite();
  await sup(`INSERT INTO traffic_light_rows (cells, position, board) VALUES ($1::jsonb, 5, 'robotic')`, [JSON.stringify({ c_code: served.code, c_kind: "no_service", c_plan: "vip" })]);
  await callAt({ ticket_number: "S17-served", parking_code: served.code, status: "1", customer_complaint: "מתייחסים כלא בשירות" }, ago(10));
  // ⚠️ רק קריאות פתוחות קובעות את הוותיקה: סגורה בת 30 יום לצד פתוחה טרייה — לבן
  const mixed = await newSite();
  await sup(`INSERT INTO traffic_light_rows (cells, position, board) VALUES ($1::jsonb, 6, 'robotic')`, [JSON.stringify({ c_code: mixed.code, c_kind: "vip" })]);
  await callAt({ ticket_number: "S17-m-closed", parking_code: mixed.code, status: "9", customer_complaint: "סגורה ישנה" }, ago(30));
  await callAt({ ticket_number: "S17-m-open", parking_code: mixed.code, status: "1", customer_complaint: "פתוחה טרייה" }, ago(0.0005));
  // ⚠️ הקצב לפי סוג האתר: מכפיל VIP שפתוח יממה — 14–15 שעות שירות (כל יממה ב-VIP), כלומר מכפיל עדיין 0 ורובוטי היה 4
  const mxVip = await newSite();
  await sup(`UPDATE sites SET monitored = false WHERE id = $1`, [mxVip.id]);
  await sup(`INSERT INTO traffic_light_rows (cells, position, board) VALUES ($1::jsonb, 7, 'multipliers')`, [JSON.stringify({ c_mx_site_code: mxVip.code, c_mx_plan: "VIP" })]);
  await callAt({ ticket_number: "S17-mxvip", parking_code: mxVip.code, status: "1", customer_complaint: "יממה" }, ago(1));
  const b4 = (await one(OPR, `SELECT public.service_calls_board(24) AS j`)).j;
  const r4 = (s) => b4.sites.find((r) => r.site_id === s.id);
  assert.equal(r4(served).age, 0, "להתייחס כ 'לא בשירות' — לבן, גם כשבמקור VIP");
  assert.equal(r4(mixed).age, 0, "הסגורה הישנה לא נספרת");
  assert.ok(r4(mxVip).age_hours >= 13.9 && r4(mxVip).age_hours <= 15.1, `יממה ב-VIP: ${r4(mxVip).age_hours} שעות שירות`);
  assert.equal(r4(mxVip).age, 0, "מכפיל: פחות מ-24 שעות שירות — עדיין לבן");
  // אתר בלי קריאה פתוחה (רק סגורה ב-24 השעות) — 0
  const closedOnly = await newSite();
  await call({ ticket_number: "S17-c-only", parking_code: closedOnly.code, status: "9", customer_complaint: "נסגרה" });
  const b3 = (await one(OPR, `SELECT public.service_calls_board(24) AS j`)).j;
  const c = b3.sites.find((r) => r.site_id === closedOnly.id);
  assert.deepEqual({ open: c.open, age: c.age, oldest_open: c.oldest_open }, { open: 0, age: 0, oldest_open: null });
});
