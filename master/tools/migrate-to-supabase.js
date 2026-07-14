// tools/migrate-to-supabase.js — מעביר את כל הנתונים מ-SQLite ל-Supabase.
//
// שימוש:
//   node --env-file=.env tools/migrate-to-supabase.js            (הרצה אמיתית)
//   node --env-file=.env tools/migrate-to-supabase.js --dry-run  (בדיקה בלבד)
//
// עקרונות:
//   • הסדר חשוב — sites קודם, כי כל השאר מצביעים אליו במפתח זר.
//   • המזהים המקוריים נשמרים, אחרת הקשרים בין הטבלאות נשברים.
//   • idempotent — ON CONFLICT DO NOTHING. אפשר להריץ שוב בלי לשכפל.
//   • אחרי ההעברה מסנכרנים את ה-SEQUENCE, אחרת ה-INSERT הבא יתנגש
//     במזהה קיים (הרצף מתחיל מ-1 ולא יודע על השורות שהוזרקו).
//   • הכול בטרנזקציה אחת: או שהכול עובר, או ששום דבר לא נוגע.

const path = require("path");
const Database = require("better-sqlite3");
const { Pool } = require("pg");

const DRY_RUN = process.argv.includes("--dry-run");
const SQLITE_PATH = process.env.SITEMONITOR_DB || path.join(__dirname, "..", "sitemonitor.db");

// סדר ההעברה + העמודות. sites ראשון (FK), monthly_summary אחרון.
const TABLES = [
  {
    name: "sites",
    columns: ["id", "code", "site_name", "status", "last_seen", "cycle_total",
      "plc_cycle_last", "cycle_last_ts", "is_new_site", "registered_at",
      "plc_type", "plc_ip", "site_ip"],
    conflict: "(id) DO NOTHING",
    hasSequence: true,
  },
  {
    name: "status_history",
    columns: ["id", "site_id", "status", "started_at", "ended_at"],
    conflict: "(id) DO NOTHING",
    hasSequence: true,
  },
  {
    name: "operations",
    columns: ["id", "site_id", "start_end", "entry_exit", "card_number", "state",
      "is_anomaly", "occurred_at", "received_at"],
    conflict: "(id) DO NOTHING",
    hasSequence: true,
  },
  {
    name: "maintenance_windows",
    columns: ["id", "site_id", "set_by_name", "set_by_role", "reason", "started_at",
      "duration_hours", "expires_at", "cancelled_at"],
    conflict: "(id) DO NOTHING",
    hasSequence: true,
  },
  {
    name: "monthly_summary",
    columns: ["id", "site_id", "year_month", "operations", "anomalies", "errors",
      "errors_in_maintenance", "failure_rate", "ready_hours", "operating_hours",
      "error_hours", "maintenance_hours", "no_comm_hours",
      "cycle_total_start", "cycle_total_end", "generated_at"],
    conflict: "(id) DO NOTHING",
    hasSequence: true,
  },
  {
    name: "settings",
    columns: ["key", "value", "updated_at"],
    conflict: "(key) DO NOTHING",
    hasSequence: false,
  },
];

async function main() {
  console.log(`\n=== הגירה: SQLite → Supabase ${DRY_RUN ? "(הרצה יבשה)" : ""} ===`);
  console.log(`מקור: ${SQLITE_PATH}\n`);

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  const report = [];

  try {
    await client.query("BEGIN");

    for (const table of TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM ${table.name}`).all();
      const cols = table.columns;
      let inserted = 0;

      for (const row of rows) {
        const values = cols.map((c) => row[c] ?? null);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

        const res = await client.query(
          `INSERT INTO ${table.name} (${cols.join(", ")})
           VALUES (${placeholders})
           ON CONFLICT ${table.conflict}`,
          values,
        );
        inserted += res.rowCount;
      }

      // סנכרון ה-SEQUENCE: בלי זה, ה-INSERT הבא היה מנסה id=1 ומתנגש.
      // setval עם המקסימום הקיים; אם הטבלה ריקה — מאתחלים ל-1 בלי לצרוך.
      if (table.hasSequence && !DRY_RUN) {
        await client.query(`
          SELECT setval(
            pg_get_serial_sequence('${table.name}', 'id'),
            COALESCE((SELECT MAX(id) FROM ${table.name}), 1),
            (SELECT MAX(id) IS NOT NULL FROM ${table.name})
          )
        `);
      }

      const after = await client.query(`SELECT COUNT(*) AS n FROM ${table.name}`);
      report.push({
        table: table.name,
        source: rows.length,
        inserted,
        target: Number(after.rows[0].n),
      });
    }

    if (DRY_RUN) {
      await client.query("ROLLBACK");
      console.log("הרצה יבשה — בוצע ROLLBACK, שום דבר לא נשמר.\n");
    } else {
      await client.query("COMMIT");
    }

    // --- דוח ---
    console.log("טבלה".padEnd(22) + "במקור".padStart(8) + "הוזרקו".padStart(10) + "ביעד".padStart(8));
    console.log("-".repeat(48));
    let ok = true;
    for (const r of report) {
      console.log(r.table.padEnd(22) + String(r.source).padStart(8) +
        String(r.inserted).padStart(10) + String(r.target).padStart(8));
      // ביעד חייב להיות לפחות כמו במקור (יכול להיות יותר אם היו נתונים קודמים)
      if (!DRY_RUN && r.target < r.source) ok = false;
    }
    console.log("-".repeat(48));
    console.log(ok ? "\n✅ כל השורות עברו" : "\n❌ חסרות שורות ביעד");
    if (!ok) process.exitCode = 1;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n❌ ההגירה נכשלה, בוצע ROLLBACK:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main();
