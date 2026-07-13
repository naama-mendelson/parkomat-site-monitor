// tools/inspect-db.js — כלי פיתוח: מציג את מבנה הטבלאות במסד

const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(__dirname, "..", "sitemonitor.db");
const db = new Database(dbPath, { readonly: true });

// שליפת רשימת הטבלאות מתוך הקטלוג הפנימי של SQLite
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all();

console.log(`\nנמצאו ${tables.length} טבלאות:\n`);

for (const t of tables) {
  console.log(`📋 טבלה: ${t.name}`);
  // שליפת העמודות של כל טבלה
  const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
  for (const c of cols) {
    const nn = c.notnull ? "NOT NULL" : "";
    const def = c.dflt_value !== null ? `DEFAULT ${c.dflt_value}` : "";
    console.log(`     - ${c.name} (${c.type}) ${nn} ${def}`.trimEnd());
  }
  console.log("");
}