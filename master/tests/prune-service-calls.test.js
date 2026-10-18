// tests/prune-service-calls.test.js — קריאה סגורה נמחקת 30 יום אחרי האירוע האחרון שלה (18/10/2026).
//
// בעלת המוצר: "אין צורך שישמרו". app.prune_service_calls: פתוחה נשמרת בכל גיל, סטטוס לא מוכר = פתוח ולא נמחק,
// הגיל נמדד מהאירוע האחרון (שורה מוויזנט או שינוי מהדשבורד), הכרטיס נמחק על כל שורותיו ושינוייו, שורה בלי
// מספר כרטיס לפי גיל בלבד. אותו db.init() כמו בייצור (tests/helpers/local-pg.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const MGR = "c2000000-0000-0000-0000-000000000001";
const AGT = "c2000000-0000-0000-0000-000000000003";
const INT = "c2000000-0000-0000-0000-000000000004";

let h;
const sup = async (sql, params = []) => (await h.pg.query(sql, params)).rows;
const sys = async (sql, params = []) => (await h.as("postgres", AGT, (tx) => tx.query(sql, params))).rows;
const D = 86400e3;
const ago = (days) => new Date(Date.now() - days * D).toISOString();

// שורה כמו שוויזנט שולחים — בזהות הקולט, עם שעת הגעה נתונה
async function call(p, receivedAt) {
  const raw = JSON.stringify(p);
  await h.as("authenticated", INT, (tx) => tx.query(
    `INSERT INTO service_calls (raw, payload, source, received_at) VALUES ($1, $3::jsonb, 'wizenet', $2)`,
    [raw, receivedAt, raw]));
}
// גוף שאינו JSON — payload ריק, בלי מספר כרטיס
const junk = (receivedAt) => h.as("authenticated", INT, (tx) => tx.query(
  `INSERT INTO service_calls (raw, payload, source, received_at) VALUES ('not json', NULL, 'wizenet', $1)`, [receivedAt]));
// שינוי מהדשבורד, עם חותמת נתונה (העמודה נכתבת ב-now(); הבדיקה מזיזה אותה אחורה)
async function change(ticket, value, changedAt) {
  await sys(`SELECT app.service_call_store_change($1, 'status', $2, 'מנהלת', NULL)`, [ticket, value]);
  await sup(`UPDATE service_call_changes SET changed_at = $2 WHERE ticket = $1 AND id = (SELECT max(id) FROM service_call_changes WHERE ticket = $1)`,
    [ticket, changedAt]);
}
const prune = async (keep) => (await sup(keep ? `SELECT app.prune_service_calls(interval '${keep}') AS n` : `SELECT app.prune_service_calls() AS n`))[0].n;
const tickets = async () => (await sup(`SELECT DISTINCT btrim(payload ->> 'ticket_number') t FROM service_calls WHERE payload IS NOT NULL ORDER BY 1`)).map((r) => r.t);
const rowsOf = async (t) => (await sup(`SELECT count(*)::int n FROM service_calls WHERE btrim(payload ->> 'ticket_number') = $1`, [t]))[0].n;
const changesOf = async (t) => (await sup(`SELECT count(*)::int n FROM service_call_changes WHERE ticket = $1`, [t]))[0].n;

before(async () => {
  if (skip) return;
  h = await local.boot({ supabaseDefaults: true });
  const now = new Date().toISOString();
  await sup(`INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, created_at) VALUES
      ('pr-mgr@parkomat.co.il','מנהלת','manager',true,$1,$3),
      ('pr-intake@parkomat.co.il',NULL,'operator',true,$2,$3)`, [MGR, INT, now]);
  const sid = (await sup(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ('7901','7901','ready','2026-01-01T00:00:00.000Z') RETURNING id`))[0].id;
  await sup(`INSERT INTO app_users (email, role, is_active, supabase_uid, site_id, created_at) VALUES ('site-pr@parkomat.co.il','agent',true,$1,$2,$3)`, [AGT, sid, now]);
  await sup(`INSERT INTO settings (key, value, updated_at) VALUES ('intake_user_id', $1, 'x') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [INT]);
  await sup(`DELETE FROM wizenet_lookups`);
  await sup(`INSERT INTO wizenet_lookups (kind, id, name, closed) VALUES ('status','148','פתוחה',false), ('status','150','סגורה',true), ('status','151','בטיפול',false)`);
});
after(async () => { if (h) await h.close(); });

test("P1 · סגורה ישנה נמחקת על כל שורותיה ושינוייה; פתוחה ישנה, סגורה טרייה וסטטוס לא מוכר נשארים", { skip }, async () => {
  // סגורה, האירוע האחרון לפני 40 יום — נמחקת, כולל שורת הפתיחה בת 60 הימים והשינוי שלה
  await call({ ticket_number: "P1-old", parking_code: "7901", status: "148" }, ago(60));
  await change("P1-old", "151", ago(50));
  await call({ ticket_number: "P1-old", parking_code: "7901", status: "150" }, ago(40));
  // פתוחה בת 90 יום — נשארת בכל גיל
  await call({ ticket_number: "P1-open", parking_code: "7901", status: "148" }, ago(90));
  // סגורה לפני 10 ימים — בתוך החלון
  await call({ ticket_number: "P1-new", parking_code: "7901", status: "150" }, ago(10));
  // סטטוס שאינו ברשימה, בן 90 יום — נחשב פתוח, לעולם לא נמחק
  await call({ ticket_number: "P1-unk", parking_code: "7901", status: "777" }, ago(90));
  // בדיוק על הגבול — 30 יום פחות שעה נשארת, 30 יום ועוד שעה נמחקת
  await call({ ticket_number: "P1-edge-in", parking_code: "7901", status: "150" }, new Date(Date.now() - 30 * D + 3600e3).toISOString());
  await call({ ticket_number: "P1-edge-out", parking_code: "7901", status: "150" }, new Date(Date.now() - 30 * D - 3600e3).toISOString());

  const n = await prune();
  assert.equal(n, 3, "P1-old: 2 שורות + P1-edge-out: 1");
  assert.deepEqual(await tickets(), ["P1-edge-in", "P1-new", "P1-open", "P1-unk"]);
  assert.equal(await rowsOf("P1-old"), 0);
  assert.equal(await changesOf("P1-old"), 0, "השינויים של כרטיס שנמחק נמחקים איתו");
  assert.equal(await prune(), 0, "ריצה חוזרת — 0");
});

test("P2 · הגיל נמדד מהאירוע האחרון: עדכון טרי מוויזנט או שינוי טרי מהדשבורד מאריכים; שינוי מהדשבורד קובע את המצב", { skip }, async () => {
  await sup(`DELETE FROM service_call_changes`); await sup(`DELETE FROM service_calls`);
  // נסגרה לפני 60 יום, וויזנט שלחו עליה עוד שורה (סגורה) לפני 5 ימים — נשארת
  await call({ ticket_number: "P2-a", parking_code: "7901", status: "150" }, ago(60));
  await call({ ticket_number: "P2-a", parking_code: "7901", status: "150" }, ago(5));
  // נסגרה לפני 60 יום, ומישהו שינה לה סטטוס מהדשבורד לפני 5 ימים (עדיין סגור) — נשארת
  await call({ ticket_number: "P2-b", parking_code: "7901", status: "150" }, ago(60));
  await change("P2-b", "150", ago(5));
  // ויזנט אומרים פתוחה (לפני 60 יום), הדשבורד סגר אותה לפני 45 יום — המצב הוא הדשבורד: סגורה וישנה — נמחקת
  await call({ ticket_number: "P2-c", parking_code: "7901", status: "148" }, ago(60));
  await change("P2-c", "150", ago(45));
  // ויזנט סגרו לפני 60 יום, הדשבורד **פתח** מחדש לפני 45 יום — פתוחה, נשארת
  await call({ ticket_number: "P2-d", parking_code: "7901", status: "150" }, ago(60));
  await change("P2-d", "148", ago(45));
  // שינוי מהדשבורד **ישן** מהשורה האחרונה של ויזנט — השורה של ויזנט קובעת: סגורה לפני 45 יום — נמחקת
  await call({ ticket_number: "P2-e", parking_code: "7901", status: "148" }, ago(60));
  await change("P2-e", "148", ago(50));
  await call({ ticket_number: "P2-e", parking_code: "7901", status: "150" }, ago(45));

  assert.equal(await prune(), 3, "P2-c (שורה אחת) + P2-e (שתי שורות)");
  assert.deepEqual(await tickets(), ["P2-a", "P2-b", "P2-d"]);
  assert.equal(await changesOf("P2-c"), 0);
  assert.equal(await changesOf("P2-e"), 0);
  assert.equal(await changesOf("P2-b"), 1, "השינוי של כרטיס שנשאר — נשאר");
});

test("P3 · בלי מספר כרטיס — לפי גיל בלבד; p_keep אחר — אותו כלל", { skip }, async () => {
  await sup(`DELETE FROM service_call_changes`); await sup(`DELETE FROM service_calls`);
  await junk(ago(40));                                                             // ישנה — נמחקת
  await junk(ago(2));                                                              // טרייה — נשארת
  await call({ parking_code: "7901", status: "148" }, ago(40));                     // JSON בלי ticket_number, ישן — נמחק
  await call({ ticket_number: "P3-a", parking_code: "7901", status: "150" }, ago(8)); // סגורה בת 8 ימים
  assert.equal(await prune(), 2);
  assert.equal((await sup(`SELECT count(*)::int n FROM service_calls`))[0].n, 2);
  assert.equal(await prune("7 days"), 1, "עם 7 ימים — גם P3-a");
  assert.equal(await prune("1 day"), 1, "ועם יום — גם השורה בלי כרטיס מלפני יומיים");
  assert.equal((await sup(`SELECT count(*)::int n FROM service_calls`))[0].n, 0);
});

test("P4 · רשומה ב-pg_cron, יומית, דרך ensure_cron_job; לא נגישה ל-authenticated", { skip }, async () => {
  const job = (await sup(`SELECT schedule, command FROM cron.job WHERE jobname = 'parkomat-prune-service-calls'`))[0];
  assert.ok(job, "המשימה קיימת");
  assert.equal(job.schedule, "17 4 * * *");
  assert.match(job.command, /app\.prune_service_calls\(interval '30 days'\)/);
  const r = await sup(`SELECT has_function_privilege('authenticated', 'app.prune_service_calls(interval)', 'EXECUTE') AS ok`);
  assert.equal(r[0].ok, false);
});
