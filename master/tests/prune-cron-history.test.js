// tests/prune-cron-history.test.js — היסטוריית הריצות של pg_cron נגרפת ל-14 יום (18/10/2026).
//
// cron.job_run_details גדלה 1,700 שורות ביום (זיהוי השתיקה רץ כל דקה) ואיש אינו מוחק אותה: 74 אלף שורות, 12 MB
// בחודשיים. app.prune_cron_history מוחקת ריצות שנגמרו לפני יותר מ-p_keep, ורשומה ב-pg_cron.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

let h;
before(async () => { if (!skip) h = await local.boot(); });
after(async () => { if (h) await h.close(); });

const D = 86400e3;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const run = (start, end, status = "succeeded") => h.pg.query(
  `INSERT INTO cron.job_run_details (jobid, status, start_time, end_time, return_message) VALUES (1, $1, $2, $3, 'x')`,
  [status, start, end]);
const count = async () => (await h.pg.query(`SELECT count(*)::int n FROM cron.job_run_details`)).rows[0].n;

test("14 יום: ישן נמחק, חדש נשאר, ריצה שעדיין פתוחה נמדדת לפי ההתחלה", { skip }, async () => {
  await run(ago(20 * D), ago(20 * D));                 // ישן — נמחק
  await run(ago(15 * D), ago(15 * D), "failed");       // ישן, גם כשל — נמחק (14 יום הם 14 יום)
  await run(ago(13 * D), ago(13 * D));                 // בתוך החלון — נשאר
  await run(ago(D), ago(D));                           // אתמול — נשאר
  await run(ago(16 * D), null, "running");             // בלי end_time — לפי start_time, ישן — נמחק
  await run(ago(2 * D), null, "running");              // בלי end_time, טרי — נשאר
  const before_ = await count();
  const n = (await h.pg.query(`SELECT app.prune_cron_history() AS n`)).rows[0].n;
  assert.equal(n, 3);
  assert.equal(await count(), before_ - 3);
  assert.equal((await h.pg.query(`SELECT app.prune_cron_history() AS n`)).rows[0].n, 0, "ריצה חוזרת — 0");
});

test("p_keep אחר — אותו כלל", { skip }, async () => {
  await h.pg.query(`DELETE FROM cron.job_run_details`);
  await run(ago(3 * D), ago(3 * D));
  await run(ago(8 * D), ago(8 * D));
  assert.equal((await h.pg.query(`SELECT app.prune_cron_history(interval '7 days') AS n`)).rows[0].n, 1);
  assert.equal(await count(), 1);
});

test("רשומה ב-pg_cron, יומית, דרך ensure_cron_job; לא נגישה ל-authenticated", { skip }, async () => {
  const job = (await h.pg.query(`SELECT schedule, command FROM cron.job WHERE jobname = 'parkomat-prune-cron-history'`)).rows[0];
  assert.ok(job, "המשימה קיימת");
  assert.equal(job.schedule, "27 4 * * *");
  assert.match(job.command, /app\.prune_cron_history\(interval '14 days'\)/);
  const r = await h.pg.query(`SELECT has_function_privilege('authenticated', 'app.prune_cron_history(interval)', 'EXECUTE') AS ok`);
  assert.equal(r.rows[0].ok, false);
});
