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
const safety = require("./lib/mutation-safety");

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
  // ⚠️ העוגנים כאן **חייבים להיות ייחודיים**: ל-ingest_operation יש שתי
  // כתיבות ל-events — אחת בסנכרון הסטטוס ואחת בסוף — ורג'קס על
  // "INSERT INTO events" היה תופס את הראשונה בשני המקרים, כלומר מוטציה
  // אחת הייתה מורצת פעמיים ואחת לא נבדקת כלל.
  ["אירוע התפעול לא נכתב", OP,
    (s) => s.replace(/  INSERT INTO events \(site_id, site_code, type, payload, created_at\)\n  SELECT p_site_id, s\.code, 'operation'[\s\S]*?FROM sites s WHERE s\.id = p_site_id;\n/, "")],
  ["שדה faultText הושמט מהמצב", STATE,
    (s) => s.replace("           'faultText',  p_fault_text)", "           'faultText2', p_fault_text)")],
  ["הסנכרון אינו כותב אירוע מצב", OP,
    (s) => s.replace(/      INSERT INTO events[\s\S]*?FROM sites s WHERE s\.id = p_site_id;\n/, "")],
  ["שם השדה cardNumber שונה", OP,
    (s) => s.replace("'cardNumber',   v_card,", "'card',         v_card,")],
];

async function main() {
  const good = { [STATE]: fn(STATE), [OP]: fn(OP) };
  // ⚠️ צילום של מה שחי, ורק אם הוא זהה לקובץ — ראה tools/lib/mutation-safety.js.
  const snaps = await safety.snapshotMatchingFile(db.pool, [
    { regprocedure: "app.ingest_state(integer, text, text, text)", createSql: good[STATE] },
    { regprocedure: "app.ingest_operation(integer, text, text, text, text, text, text, integer)", createSql: good[OP] },
  ]);
  let bad = 0;
  try {
    for (const [label, header, mutate] of MUTATIONS) {
      const mutant = mutate(good[header]);
      if (mutant === good[header]) { console.log(`❌ ${label} — לא שינתה כלום`); bad++; continue; }
      try { await db.pool.query(mutant); }
      catch (e) { console.log(`❌ ${label} — אינה מתקמפלת: ${e.message}`); bad++; continue; }

      const res = gate();
      const restoreFailed = await safety.restoreAndVerify(db.pool, snaps);
      if (restoreFailed.length) { bad += safety.reportRestore(restoreFailed); break; }

      console.log(res === "red" ? `✅ מוטציה נתפסה: ${label}`
                                : `❌ מוטציה עברה בשקט: ${label} — השער עיוור`);
      if (res !== "red") bad++;
    }
  } finally {
    // ⚠️ כל פונקציה בנפרד: זריקה בהחזרת STATE דילגה כאן על OP.
    bad += safety.reportRestore(await safety.restoreAndVerify(db.pool, snaps));
  }

  // ⚠️ שער אדום אחרי השחזור הוא **כשל**, ולא שורת דיווח. ראה ההסבר המלא
  // ב-`mutate-direct-drops.js`; `mutate-alert-gate.js` כבר עשה זאת נכון.
  const after = gate();
  console.log(`\nאחרי שחזור: ${after}`);
  if (after !== "green") {
    console.log("❌ הייצור נשאר מקולקל — השחזור לא החזיר את המצב הירוק");
    bad++;
  }
  await db.close();
  console.log(bad ? `\n❌ ${bad} בעיות` : "\n✅ כל המוטציות נתפסו");
  process.exit(bad ? 1 : 0);
}

// ⚠️ דחייה לא מטופלת הייתה יוצאת בלי שורה שאומרת מה קרה לייצור.
main().catch((e) => { console.log(`
⛔ הכלי נפל: ${e.message}`); process.exit(1); });
