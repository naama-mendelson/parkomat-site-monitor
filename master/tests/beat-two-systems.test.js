// tests/beat-two-systems.test.js — טקסט התקלה של מערכת אחת (סוכן 1.0.58), מהגוף של הסוכן עד השורה בכרטיס.
//
// ⚠️ הגוף הוא shared/contracts/beat-two-systems.sample.json — הקובץ שהסוכן מייצר בדיוק
// (TwoSystemFaultPipelineTests.TheAgentProducesExactlyTheSharedContract). כאן הוא נשלח ל-ingest_batch כמו
// שהוא, נקרא חזרה מ-site_globals כמו שהדשבורד קורא, ועובר דרך הפונקציה שהכרטיס מריץ (systemFaultText).
// אף שדה לא מתורגם בדרך — ומי שיסנן את systems לשדות מוכרים בצד אחד ישבור את זה כאן.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
let h;
before(async () => { if (!skip) h = await local.boot(); });
after(async () => { if (h) await h.close(); });

const AGENT = "e1000000-0000-0000-0000-000000000001";
const BODY = JSON.parse(fs.readFileSync(path.join(__dirname, "../../shared/contracts/beat-two-systems.sample.json"), "utf8"));
const SYS = pathToFileURL(path.join(__dirname, "../../shared/site-systems.mjs")).href;

test("הפעימה של סוכן 1.0.58 → alive.systems → site_globals → השורה בכרטיס: 'מערכת 2: <הטקסט>'", { skip }, async () => {
  const now = Date.now();
  const id = (await h.pg.query(`INSERT INTO sites (code, site_name, status, registered_at, last_seen) VALUES ('3999','דו-מערכתי','ready',$1,$1) RETURNING id`,
    [new Date(now - 86400e3).toISOString()])).rows[0].id;
  await h.pg.query(`INSERT INTO status_history (site_id, status, started_at) VALUES ($1,'ready',$2)`, [id, new Date(now - 3600e3).toISOString()]);
  await h.pg.query(`INSERT INTO app_users (email, role, is_active, supabase_uid, site_id, created_at) VALUES ('site-3999@parkomat.co.il','agent',true,$1,$2,$3)`,
    [AGENT, id, new Date().toISOString()]);

  await h.as("authenticated", AGENT, (tx) => tx.query(`SELECT * FROM public.ingest_batch($1::jsonb, $2, $3::jsonb)`,
    [JSON.stringify(BODY.p_messages), BODY.p_version, JSON.stringify(BODY.p_systems)]));

  const alive = (await h.pg.query(`SELECT systems FROM alive WHERE site_id = $1`, [id])).rows[0].systems;
  assert.deepEqual(alive, BODY.p_systems, "alive.systems נשמר כמו שנשלח — כולל fault");

  const g = (await h.pg.query(`SELECT systems FROM public.site_globals(ARRAY[$1::int])`, [id])).rows[0];
  assert.equal(g.systems[1].fault, "מנהל דולים - דלתות חניון פתוחות:");

  const { systemFaultText } = await import(SYS);
  assert.equal(systemFaultText(g.systems), "מערכת 2: מנהל דולים - דלתות חניון פתוחות:");
  // ⚠️ מצב האתר לא זז: 'מוכן' — זו הצגה בלבד, בלי מקטע תקלה ובלי אחוז כשל
  assert.equal((await h.pg.query(`SELECT status FROM sites WHERE id=$1`, [id])).rows[0].status, "ready");
  assert.equal((await h.pg.query(`SELECT count(*)::int n FROM status_history WHERE site_id=$1 AND status='error'`, [id])).rows[0].n, 0);
});

test("systemFaultText — רק מערכת שבתקלה ויש לה טקסט; כמה מערכות — מחוברות; קלט חסר — ריק", { skip: false }, async () => {
  const { systemFaultText } = await import(SYS);
  assert.equal(systemFaultText(null), "");
  assert.equal(systemFaultText([{ unit: 1, state: "ready", fault: "שארית" }]), "", "טקסט על מערכת שחזרה אינו תקלה עכשיו");
  assert.equal(systemFaultText([{ unit: 2, state: "error" }]), "", "תקלה בלי טקסט — לא ממציאים שורה");
  assert.equal(systemFaultText([{ unit: 1, state: "error", fault: " א " }, { unit: 2, state: "error", fault: "ב" }]), "מערכת 1: א · מערכת 2: ב");
});
