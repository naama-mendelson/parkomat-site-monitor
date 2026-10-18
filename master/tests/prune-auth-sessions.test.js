// tests/prune-auth-sessions.test.js — גריפת ההתחברויות של Supabase Auth: יממה, ולא יותר (18/10/2026).
//
// בעלת המוצר: "זה לא מעניין אותי בכלל מה התחבר! מצידי תשמור רק את של אותו יום". הסוכנים מתחברים בסיסמה כל
// שעה ו-Supabase לא מנקים — 45 אלף sessions ו-36 MB בחודש. app.prune_auth_sessions מוחקת session שלא היה
// בשימוש יממה, יחד עם refresh_tokens ו-mfa_amr_claims שלו, ורשומה ב-pg_cron.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

let h;
before(async () => { if (!skip) h = await local.boot(); });
after(async () => { if (h) await h.close(); });

const H = 3600e3;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
let seq = 0;
async function session({ created, updated = null, refreshed = null, tokens = 1 }) {
  const id = `00000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`;
  await h.pg.query(
    `INSERT INTO auth.sessions (id, user_id, created_at, updated_at, refreshed_at) VALUES ($1, gen_random_uuid(), $2, $3, $4)`,
    [id, created, updated ?? created, refreshed]);
  for (let i = 0; i < tokens; i++) await h.pg.query(`INSERT INTO auth.refresh_tokens (session_id, token) VALUES ($1, $2)`, [id, `t${seq}-${i}`]);
  await h.pg.query(`INSERT INTO auth.mfa_amr_claims (session_id) VALUES ($1)`, [id]);
  return id;
}
const wipe = async () => { for (const t of ["refresh_tokens", "mfa_amr_claims", "sessions"]) await h.pg.query(`DELETE FROM auth.${t}`); };
const ids = async (t) => (await h.pg.query(`SELECT ${t === "sessions" ? "id" : "session_id"}::text AS id FROM auth.${t} ORDER BY 1`)).rows.map((r) => r.id);

test("יממה: ישן נמחק עם האסימונים שלו, מה שהיה בשימוש היום נשאר", { skip }, async () => {
  const oldAgent = await session({ created: ago(30 * H), tokens: 2 });            // סוכן מלפני יום ורבע — נמחק
  const oldButRefreshed = await session({ created: ago(10 * 24 * H), refreshed: ago(2 * H).replace("Z", "") }); // נוצר לפני שבוע, רוענן לפני שעתיים — נשאר
  const fresh = await session({ created: ago(H) });                                 // נוצר לפני שעה — נשאר
  const edge = await session({ created: ago(23 * H) });                             // 23 שעות — עדיין "היום"
  const staleRefreshed = await session({ created: ago(5 * 24 * H), refreshed: ago(26 * H).replace("Z", "") }); // רוענן לפני 26 שעות — נמחק
  const updatedOnly = await session({ created: ago(3 * 24 * H), updated: ago(3 * H) }); // בלי refreshed_at, updated היום — נשאר

  const n = (await h.pg.query(`SELECT app.prune_auth_sessions() AS n`)).rows[0].n;
  assert.equal(n, 2, "בדיוק שני sessions נמחקו");
  const left = await ids("sessions");
  assert.deepEqual(left, [oldButRefreshed, fresh, edge, updatedOnly].sort());
  assert.ok(!left.includes(oldAgent) && !left.includes(staleRefreshed));
  // האסימונים והטענות של הנמחקים נעלמו איתם, ושל הנשארים לא נגעו
  assert.deepEqual(await ids("refresh_tokens"), [oldButRefreshed, fresh, edge, updatedOnly].sort());
  assert.deepEqual(await ids("mfa_amr_claims"), [oldButRefreshed, fresh, edge, updatedOnly].sort());
});

test("p_keep אחר — אותו כלל, חלון אחר; ריצה חוזרת מוחקת 0", { skip }, async () => {
  await wipe();
  await session({ created: ago(3 * H) });
  await session({ created: ago(10 * H) });
  assert.equal((await h.pg.query(`SELECT app.prune_auth_sessions(interval '5 hours') AS n`)).rows[0].n, 1);
  assert.equal((await h.pg.query(`SELECT app.prune_auth_sessions(interval '5 hours') AS n`)).rows[0].n, 0);
  assert.equal((await ids("sessions")).length, 1);
});

test("⚠️ refreshed_at הוא UTC בלי אזור זמן — מושווה כ-UTC", { skip }, async () => {
  await wipe();
  // רוענן לפני 23.5 שעות (UTC). פירוש שגוי לפי אזור זמן של +3 היה הופך אותו ל-26.5 שעות ומוחק אותו.
  await h.pg.query(`SET LOCAL TIME ZONE 'Asia/Jerusalem'`).catch(() => {});
  await session({ created: ago(5 * 24 * H), refreshed: ago(23.5 * H).replace("Z", "") });
  assert.equal((await h.pg.query(`SELECT app.prune_auth_sessions() AS n`)).rows[0].n, 0);
});

test("רשומה ב-pg_cron, יומית, דרך ensure_cron_job — ולא cron.schedule ישיר", { skip }, async () => {
  const job = (await h.pg.query(`SELECT schedule, command, active FROM cron.job WHERE jobname = 'parkomat-prune-auth-sessions'`)).rows[0];
  assert.ok(job, "המשימה קיימת");
  assert.equal(job.schedule, "57 3 * * *");
  assert.match(job.command, /app\.prune_auth_sessions\(interval '1 day'\)/);
  const src = fs.readFileSync(path.join(__dirname, "..", "db", "cron.postgres.sql"), "utf8");
  assert.match(src, /ensure_cron_job\('parkomat-prune-auth-sessions'/);
});

test("לא נגיש ל-authenticated — רק הבעלים ו-pg_cron", { skip }, async () => {
  const r = await h.pg.query(`SELECT has_function_privilege('authenticated', 'app.prune_auth_sessions(interval)', 'EXECUTE') AS ok`);
  assert.equal(r.rows[0].ok, false);
});
