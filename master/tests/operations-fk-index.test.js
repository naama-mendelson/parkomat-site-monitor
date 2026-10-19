// tests/operations-fk-index.test.js — אינדקס על operations.superseded_by (19/10/2026), על Postgres מקומי (PGlite).
//
// המפתח הזר superseded_by → operations(id) הוא ON DELETE SET NULL. על כל שורה שנמחקת, Postgres מריץ
// בדיקה בצורה `SELECT 1 FROM ONLY operations x WHERE superseded_by = $1 FOR KEY SHARE OF x`. בלי אינדקס
// על העמודה זו סריקה של כל הטבלה **לכל שורה**. נמדד בייצור 19/10/2026: 10ms לשורה על 50k שורות.
// הניקוי של 12 חודשים מוחק חודש שלם ב-1 לכל חודש (~40k שורות בקצב של היום) על טבלה של ~חצי מיליון,
// כלומר כשעה של סריקה רצופה במחשוב Micro. נבדק כאן: התוכנית הכללית של הבדיקה (זו ש-RI משתמש בה) עוברת
// דרך האינדקס, בלעדיו היא סריקה מלאה, וה-SET NULL עדיין מחזיר את הניסיון הראשון להיספר.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
let h;
before(async () => { if (!skip) h = await local.boot(); });
after(async () => { if (h) await h.close(); });

const q = async (sql, p = []) => (await h.pg.query(sql, p)).rows;

// התוכנית ש-RI מקבל: משפט מוכן עם פרמטר, בתוכנית כללית (לא מותאמת לערך).
// ⚠️ PGlite עולה עם enable_seqscan=off (מקור: command line). בלי להדליק אותו כאן, "עם אינדקס" היה עובר
// בכפייה ולא כי האינדקס זול יותר, וזו בדיוק ההכרעה שהבדיקה אמורה לראות.
async function riPlan() {
  await q(`SET enable_seqscan = on`);
  await q(`SET plan_cache_mode = force_generic_plan`);
  await q(`DEALLOCATE ALL`);
  await q(`PREPARE ri(int) AS SELECT 1 FROM ONLY public.operations x WHERE superseded_by = $1 FOR KEY SHARE OF x`);
  const [row] = await q(`EXPLAIN (FORMAT JSON) EXECUTE ri(7)`);
  await q(`DEALLOCATE ri`);
  await q(`RESET plan_cache_mode`);
  await q(`RESET enable_seqscan`);
  return JSON.stringify(row["QUERY PLAN"]);
}

test("האינדקס קיים, חלקי, על superseded_by בלבד", { skip }, async () => {
  const rows = await q(`SELECT indexdef FROM pg_indexes WHERE tablename = 'operations' AND indexname = 'idx_operations_superseded_by'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].indexdef, /[(]superseded_by[)] WHERE [(]superseded_by IS NOT NULL[)]/);
});

test("⚠️ בדיקת המפתח הזר עוברת דרך האינדקס, ובלעדיו — סריקה מלאה", { skip }, async () => {
  const [{ id: site }] = await q(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ('FKX','FKX','ready',now()::text) RETURNING id`);
  await q(`INSERT INTO operations (site_id, start_end, entry_exit, card_number, state, occurred_at, received_at)
           SELECT $1, 'end', 'entry', g::text, 'ready', to_char(now() - g * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), now()::text
           FROM generate_series(1, 20000) g`, [site]);
  // כ-2.5% מצביעות, כמו בייצור (1,241 מתוך 50,069)
  await q(`UPDATE operations SET superseded_by = id - 1 WHERE site_id = $1 AND id % 40 = 0`, [site]);
  await q(`ANALYZE operations`);

  const withIdx = await riPlan();
  assert.match(withIdx, /idx_operations_superseded_by/, withIdx);
  assert.doesNotMatch(withIdx, /Seq Scan/, withIdx);

  // ההוכחה שהבדיקה רגישה: בלי האינדקס אותה תוכנית סורקת את הטבלה
  await q(`BEGIN`);
  await q(`DROP INDEX idx_operations_superseded_by`);
  const without = await riPlan();
  await q(`ROLLBACK`);
  assert.match(without, /Seq Scan/, without);
});

test("ON DELETE SET NULL נשמר: מחיקת הפעולה המחליפה מחזירה את הראשונה להיספר", { skip }, async () => {
  const [{ id: site }] = await q(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ('FKY','FKY','ready',now()::text) RETURNING id`);
  const [{ id: second }] = await q(`INSERT INTO operations (site_id, start_end, entry_exit, card_number, state, occurred_at, received_at)
    VALUES ($1,'end','entry','b','ready','2026-10-01T10:05:00Z','2026-10-01T10:05:00Z') RETURNING id`, [site]);
  const [{ id: first }] = await q(`INSERT INTO operations (site_id, start_end, entry_exit, card_number, state, occurred_at, received_at, superseded_by)
    VALUES ($1,'end','entry','a','ready','2026-10-01T10:00:00Z','2026-10-01T10:00:00Z',$2) RETURNING id`, [site, second]);
  await q(`DELETE FROM operations WHERE id = $1`, [second]);
  const [row] = await q(`SELECT superseded_by FROM operations WHERE id = $1`, [first]);
  assert.equal(row.superseded_by, null);
});

test("האינדקס הכפול על suppressed_faults נמחק, והייחודי נשאר", { skip }, async () => {
  const names = (await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'suppressed_faults' ORDER BY 1`)).map((r) => r.indexname);
  assert.ok(names.includes("idx_suppressed_dedup"), names.join());
  assert.ok(!names.includes("idx_suppressed_site_time"), names.join());
});
