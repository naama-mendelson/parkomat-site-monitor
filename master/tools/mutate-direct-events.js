// mutate-direct-events — לשבור את כתיבת האירועים, ולדרוש מהשער להאדים.
//
// ⚠️ המוטציה מוחלת על הייצור ומוחזרת מיד, ולא בטרנזקציה: השער פותח חיבור
// משלו, ולכן DDL שלא בוצע commit לא היה נראה לו — כלומר כל מוטציה הייתה
// "עוברת", וזה שער עיוור שמדווח על עצמו שהוא רואה.
//
//   node --env-file=.env tools/mutate-direct-events.js

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const db = require("../db/db");

const FILE = path.join(__dirname, "..", "db", "ingest.postgres.sql");

function fn(header) {
  const src = fs.readFileSync(FILE, "utf8");
  const from = src.indexOf(header);
  if (from < 0) throw new Error("לא נמצא: " + header);
  const end = src.indexOf("\n$fn$;", from);
  return src.slice(from, end + "\n$fn$;".length);
}

function gate() {
  try {
    execFileSync(process.execPath,
      ["--env-file=.env", path.join(__dirname, "check-direct-events.js")],
      { cwd: path.join(__dirname, ".."), stdio: "pipe" });
    return "green";
  } catch { return "red"; }
}

const STATE = "CREATE OR REPLACE FUNCTION app.ingest_state(";
const OP = "CREATE OR REPLACE FUNCTION app.ingest_operation(";

const MUTATIONS = [
  ["אירוע המצב לא נכתב", STATE,
    (s) => s.replace(/  INSERT INTO events[\s\S]*?FROM sites s WHERE s\.id = p_site_id;\n/, "")],
  ["אירוע התפעול לא נכתב", OP,
    (s) => s.replace(/  INSERT INTO events[\s\S]*?FROM sites s WHERE s\.id = p_site_id;\n/, "")],
  ["שדה faultText הושמט מהמצב", STATE,
    (s) => s.replace("           'faultText',  p_fault_text)", "           'faultText2', p_fault_text)")],
  ["שם השדה cardNumber שונה", OP,
    (s) => s.replace("'cardNumber',   v_card,", "'card',         v_card,")],
];

async function main() {
  const good = { [STATE]: fn(STATE), [OP]: fn(OP) };
  let bad = 0;
  try {
    for (const [label, header, mutate] of MUTATIONS) {
      const mutant = mutate(good[header]);
      if (mutant === good[header]) { console.log(`❌ ${label} — לא שינתה כלום`); bad++; continue; }
      try { await db.pool.query(mutant); }
      catch (e) { console.log(`❌ ${label} — אינה מתקמפלת: ${e.message}`); bad++; continue; }

      const res = gate();
      await db.pool.query(good[header]);

      console.log(res === "red" ? `✅ מוטציה נתפסה: ${label}`
                                : `❌ מוטציה עברה בשקט: ${label} — השער עיוור`);
      if (res !== "red") bad++;
    }
  } finally {
    await db.pool.query(good[STATE]);
    await db.pool.query(good[OP]);
  }

  console.log(`\nאחרי שחזור: ${gate()}`);
  await db.close();
  console.log(bad ? `\n❌ ${bad} בעיות` : "\n✅ כל המוטציות נתפסו");
  process.exit(bad ? 1 : 0);
}

main();
