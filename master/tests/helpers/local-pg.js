// tests/helpers/local-pg.js — Postgres 17 אמיתי בתוך תהליך הבדיקה, בלי ייצור.
//
// ============================================================
// ⚠️ למה זה קיים
// ============================================================
// כל בדיקה של SQL בפרויקט הזה רצה עד היום **מול הייצור**: השערים ב-tools/
// מתחברים ל-Supabase, ולכן כל הרצה עולה egress (6.03 GB מתוך 5 ב-03/09) ויוצרת
// משתמש חד-פעמי שנספר ב-MAU. התוצאה המעשית היא כלל התנהגותי — "אל תריצו שוב" —
// כלומר SQL שנבדק פעם אחת ואז לא נבדק שוב.
//
// PGlite הוא Postgres 17 מקומפל ל-WASM. השרת כאן מדבר את פרוטוקול Postgres, ולכן
// הבדיקות מריצות את **`db.init()` האמיתי** של master — אותו סדר, אותם קבצים —
// ולא עותק שלו. כך נמצא גם באג שלא היה נראה בייצור: `functions.postgres.sql` השתמש
// בסכמה `app` לפני שנוצרה, ומסד חדש לא עלה בכלל.
//
// ⚠️ מה **אינו** כאן: pg_cron ו-pg_net הם תחליפים (הם מאפשרים לקובץ להיטען ולבדוק
// מה נשלח), ו-auth של Supabase הוא מינימום. הרשאות, RLS, SECURITY DEFINER ו-plpgsql
// הם של Postgres אמיתי.
const net = require("node:net");
const path = require("node:path");

const MASTER = path.join(__dirname, "..", "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** האם PGlite מותקן. בלעדיו (npm ci --omit=dev) הבדיקות מדלגות ולא נופלות. */
function available() {
  try {
    require.resolve("@electric-sql/pglite");
    require.resolve("@electric-sql/pglite-socket");
    return true;
  } catch {
    return false;
  }
}

async function boot() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");

  const pg = await PGlite.create();

  // תפקידי Supabase, auth מינימלי, ותחליפים ל-pg_cron / pg_net.
  await pg.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text, raw_app_meta_data jsonb, last_sign_in_at timestamptz);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $f$ SELECT nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid $f$;

    CREATE SCHEMA IF NOT EXISTS cron;
    CREATE TABLE IF NOT EXISTS cron.job (jobid serial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
    CREATE OR REPLACE FUNCTION cron.schedule(n text, s text, c text) RETURNS bigint LANGUAGE sql AS
      $f$ INSERT INTO cron.job(jobname, schedule, command) VALUES (n, s, c)
          ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
          RETURNING jobid::bigint $f$;
    CREATE OR REPLACE FUNCTION cron.unschedule(n text) RETURNS boolean LANGUAGE sql AS
      $f$ WITH d AS (DELETE FROM cron.job WHERE jobname = n RETURNING 1) SELECT EXISTS (SELECT 1 FROM d) $f$;

    CREATE SCHEMA IF NOT EXISTS net;
    CREATE TABLE IF NOT EXISTS net.http_request_queue (id bigserial PRIMARY KEY, url text, headers jsonb, body jsonb);
    CREATE TABLE IF NOT EXISTS net._http_response (id bigint, status_code int, created timestamptz DEFAULT now(), content text);
    CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}',
      headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql AS
      $f$ INSERT INTO net.http_request_queue(url, headers, body) VALUES (url, headers, body) RETURNING id $f$;
  `);

  const port = await freePort();
  const server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1", maxConnections: 20 });
  await server.start();

  // ⚠️ DATABASE_URL נקבע **לפני** טעינת db.js, ל-127.0.0.1 בלבד. sslmode=disable
  // גובר על ה-ssl שב-db.js (פרמטרים ממחרוזת החיבור דורסים את התצורה ב-pg).
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  const db = require(path.join(MASTER, "db", "db.js"));
  await db.init();

  /** פעולה בזהות מסוימת, כמו ש-PostgREST עושה: SET ROLE + תביעות JWT. */
  async function as(role, sub, fn) {
    return pg.transaction(async (tx) => {
      await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify(sub ? { sub, role } : { role })]);
      await tx.query(`SET LOCAL ROLE ${role}`);
      return fn(tx);
    });
  }

  async function close() {
    try { await db.close?.(); } catch { /* המסד נסגר ממילא */ }
    await server.stop();
    await pg.close();
  }

  return { pg, db, as, close, MASTER };
}

module.exports = { boot, available };
