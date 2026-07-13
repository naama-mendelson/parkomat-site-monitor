// db/db.js — פותח את מסד הנתונים וטוען את הסכמה

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// נתיב קובץ מסד הנתונים — בתוך תיקיית master (רמה אחת מעל db/).
// ניתן לעקוף עם משתנה הסביבה SITEMONITOR_DB (למשל לבדיקות על DB זמני נפרד).
const dbPath = process.env.SITEMONITOR_DB || path.join(__dirname, "..", "sitemonitor.db");

// פתיחה (או יצירה אם לא קיים)
const db = new Database(dbPath);

// טעינת הסכמה מקובץ schema.sql והרצתה
const schemaPath = path.join(__dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");
db.exec(schema);

// מיגרציות עמודות — schema.sql משתמש ב-CREATE TABLE IF NOT EXISTS, ולכן עמודה
// שנוספת לטבלה קיימת *לא* תיווצר במסד ותיק. כאן מוסיפים אותה בפועל.
// ההוספה idempotent: בודקים מה כבר קיים לפני ALTER.
function addMissingColumns(table, columns) {
  const existing = new Set(db.pragma(`table_info(${table})`).map((c) => c.name));

  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      console.log(`db: נוספה עמודה ${table}.${name}`);
    }
  }
}

addMissingColumns("sites", {
  plc_type: "TEXT",
  plc_ip: "TEXT",
  site_ip: "TEXT",
  is_new_site: "INTEGER NOT NULL DEFAULT 1",
});

console.log("db: ready at", dbPath);

// חושפים את החיבור לשימוש מבחוץ
module.exports = db;