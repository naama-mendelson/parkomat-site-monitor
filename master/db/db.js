// db/db.js — חיבור ל-PostgreSQL (Supabase) + שכבת תאימות דקה.
//
// ============================================================
// למה יש כאן שכבת תאימות ולא pool.query גולמי בכל מקום
// ============================================================
// queries.js הוא 1,700 שורות עם ~200 שאילתות בדפוס אחיד:
//     db.prepare(sql).get(a, b)   /   .all(...)   /   .run(...)
// המעבר ל-pg דורש שני שינויים מכניים בכל אחת מהן: '?' → '$1,$2', ואיסוף
// התוצאה מ-rows. לעשות את זה ידנית 200 פעם = 200 הזדמנויות לטעות — במיוחד
// בשאילתות שנבנות דינמית, שבהן מספר ה-placeholders משתנה בזמן ריצה
// (getExecutiveStatsFiltered בונה IN (...) לפי כמות האתרים שנבחרו).
//
// לכן ההמרה נעשית *במקום אחד*: prepare() מקבל SQL עם '?', ממיר ל-$n, ומריץ.
// queries.js שומר על אותו מבנה בדיוק — רק הופך ל-async. פחות קוד שהשתנה =
// פחות סיכון, וההיגיון העסקי לא נגע כלל.
//
// ההבדל האמיתי שכן חוצה את הגבול: get/all/run מחזירים Promise. כל קורא חייב await.
// ============================================================

const { Pool, Client, types } = require("pg");
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");

// ============================================================
// קריטי: COUNT(*) ו-SUM(int) ב-Postgres מחזירים BIGINT, ו-pg מחזיר BIGINT
// כ*מחרוזת* (כדי לא לאבד דיוק מעל 2^53). בלי השורה הזו getSiteStats היה
// מחזיר operations: "16" במקום 16 — ואז `operations === 0` נכשל בשקט,
// והדשבורד היה מקבל מחרוזות במקום מספרים. המספרים כאן רחוקים מהגבול.
// 20 = ה-OID של int8 (BIGINT).
// ============================================================
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("db: חסר DATABASE_URL בסביבה (.env)");
}

const pool = new Pool({
  connectionString,
  // Supabase מחייב SSL. rejectUnauthorized: false — התעבורה עדיין מוצפנת.
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

// שגיאה על חיבור סרק לא אמורה להפיל את התהליך
pool.on("error", (err) => {
  console.error("db: שגיאה על חיבור סרק —", err.message);
});

// ============================================================
// טרנזקציות
// ============================================================
// applyStateChange חייב להיות אטומי: סגירת המצב הקודם + פתיחת החדש + עדכון
// האתר. הפונקציות הפנימיות (closeOpenStatus וכו') לא מקבלות client כפרמטר,
// ולכן משתמשים ב-AsyncLocalStorage: בתוך transaction() כל קריאה ל-db רצה על
// אותו client — בלי לשנות אף חתימה של פונקציה.
const txStore = new AsyncLocalStorage();

// היעד לשאילתה: ה-client של הטרנזקציה אם אנחנו בתוכה, אחרת ה-pool
const executor = () => txStore.getStore() || pool;

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await txStore.run(client, fn);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("db: ROLLBACK נכשל —", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================
// המרת '?' ל-'$1, $2, ...'
// ============================================================
// מדלגים על סימני שאלה שבתוך מחרוזת ('...'), כדי לא להשחית SQL תקין.
// אין כרגע '?' בתוך מחרוזות בקוד, אבל ההגנה זולה והתקלה הייתה שקטה.
function toPositional(sql) {
  let out = "";
  let i = 0;
  let n = 0;
  let inString = false;

  while (i < sql.length) {
    const ch = sql[i];

    if (inString) {
      out += ch;
      if (ch === "'" && sql[i + 1] === "'") {
        out += sql[++i];          // '' = גרש בורח, לא סוף מחרוזת
      } else if (ch === "'") {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === "'") { inString = true; out += ch; i++; continue; }
    if (ch === "?") { out += `$${++n}`; i++; continue; }

    out += ch;
    i++;
  }

  return out;
}

// ============================================================
// ה-API התואם ל-better-sqlite3 — אבל אסינכרוני
// ============================================================
// ============================================================
// מונה שאילתות — הכלי שמאתר N+1
// ============================================================
// מול SQLite מקומי שאילתה עלתה מיקרו-שניות, ולכן "שאילתה לכל אתר" לא הורגשה.
// מול Postgres מרוחק כל שאילתה היא סיבוב רשת שלם (~50-150ms), ו-100 שאילתות
// הן 10 שניות. המונה הזה הופך את זה למדיד במקום לניחוש.
const counters = { queries: 0, ms: 0 };

function getQueryStats() {
  return { ...counters };
}

function resetQueryStats() {
  counters.queries = 0;
  counters.ms = 0;
}

async function runQuery(text, params) {
  const started = process.hrtime.bigint();
  try {
    return await executor().query(text, params);
  } finally {
    counters.queries++;
    counters.ms += Number(process.hrtime.bigint() - started) / 1e6;
  }
}

function prepare(sql) {
  const text = toPositional(sql);

  return {
    /** שורה אחת, או undefined אם אין (כמו .get של better-sqlite3) */
    async get(...params) {
      const res = await runQuery(text, params);
      return res.rows[0];
    },

    /** כל השורות */
    async all(...params) {
      const res = await runQuery(text, params);
      return res.rows;
    },

    /**
     * INSERT / UPDATE / DELETE.
     * מחזיר את אותם שדות ש-better-sqlite3 החזיר:
     *   changes         — כמה שורות הושפעו
     *   lastInsertRowid — ה-id של השורה החדשה (רק אם ה-SQL כולל RETURNING id)
     */
    async run(...params) {
      const res = await runQuery(text, params);
      return {
        changes: res.rowCount,
        lastInsertRowid: res.rows[0]?.id,
      };
    },
  };
}

// הרצת SQL גולמי (DDL)
async function exec(sql) {
  await executor().query(sql);
}

// ============================================================
// אתחול: יצירת הסכמה + השלמת עמודות חסרות
// ============================================================
// schema.postgres.sql משתמש ב-CREATE TABLE IF NOT EXISTS, ולכן עמודה שנוספה
// לטבלה *קיימת* לא תיווצר. ב-Postgres יש ADD COLUMN IF NOT EXISTS — פשוט
// ובטוח יותר מהבדיקה שהייתה ב-SQLite (PRAGMA table_info).
// נקרא גם מ-master.js (לפני MQTT) וגם מ-startApiServer (לשימוש עצמאי).
// שומרים את ה-Promise כדי שהאתחול ירוץ *פעם אחת* גם אם קראו לו פעמיים.
let initPromise = null;

function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const schema = fs.readFileSync(path.join(__dirname, "schema.postgres.sql"), "utf8");

    // ה-transaction pooler (6543) מנתק את החיבור כשמריצים סקריפט עם כמה
    // פקודות SQL (ECONNRESET) — הוא נועד לשאילתות בודדות. הסכמה היא סקריפט
    // DDL שלם, ולכן היא רצה פעם אחת דרך חיבור session (5432), שתומך בזה.
    // אחרי האתחול הכול חוזר לרוץ על ה-pool המהיר.
    const sessionUrl = connectionString.replace(":6543/", ":5432/");
    const setup = new Client({ connectionString: sessionUrl, ssl: { rejectUnauthorized: false } });

    await setup.connect();
    try {
      await setup.query(schema);
      await setup.query(`
        ALTER TABLE sites ADD COLUMN IF NOT EXISTS plc_type    TEXT;
        ALTER TABLE sites ADD COLUMN IF NOT EXISTS plc_ip      TEXT;
        ALTER TABLE sites ADD COLUMN IF NOT EXISTS site_ip     TEXT;
        ALTER TABLE sites ADD COLUMN IF NOT EXISTS is_new_site INTEGER NOT NULL DEFAULT 1;
      `);
    } finally {
      await setup.end();
    }

    const { rows } = await pool.query("SELECT current_database() AS db");
    console.log(`db: ready — PostgreSQL (${rows[0].db})`);
  })();

  return initPromise;
}

async function close() {
  await pool.end();
}

module.exports = { prepare, exec, transaction, init, close, pool, getQueryStats, resetQueryStats };
