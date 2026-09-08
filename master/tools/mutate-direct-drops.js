// mutate-direct-drops — לשבור את הרישום בכוונה, ולדרוש מהשער להאדים.
//
// ⚠️ **המוטציה מוחלת על הייצור ומוחזרת מיד**, ולא בטרנזקציה: השער פותח
// חיבור משלו, ולכן DDL שלא בוצע commit לא היה נראה לו כלל — כלומר
// המוטציה הייתה "עוברת" תמיד, וזה שער עיוור שמדווח על עצמו שהוא רואה.
// חלון החשיפה הוא שניות, וההתנהגות בו היא בדיוק זו שהייתה עד היום.
//
//   node --env-file=.env tools/mutate-direct-drops.js

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const db = require("../db/db");

const FILE = path.join(__dirname, "..", "db", "ingest.postgres.sql");

function batchSource(src) {
  const from = src.indexOf("CREATE OR REPLACE FUNCTION public.ingest_batch(");
  if (from < 0) throw new Error("ingest_batch לא נמצאה");
  const end = src.indexOf("\n$fn$;", from);
  if (end < 0) throw new Error("סוף הפונקציה לא נמצא");
  return src.slice(from, end + "\n$fn$;".length);
}

// מריץ את השער בתהליך נפרד — כלומר בחיבור אחר, כמו בייצור.
function gate() {
  try {
    execFileSync(process.execPath,
      ["--env-file=.env", path.join(__dirname, "check-direct-drops.js")],
      { cwd: path.join(__dirname, ".."), stdio: "pipe" });
    return "green";
  } catch {
    return "red";
  }
}

const MUTATIONS = [
  ["רישום המצב שנדחה הוסר",
    (s) => s.replace(/IF NOT v_res\.applied THEN[\s\S]*?END IF;\n/, "")],
  ["רישום התפעול הכפול הוסר",
    (s) => s.replace(/IF NOT v_res\.inserted THEN[\s\S]*?END IF;\n/, "")],
  ["שם הסיבה נותק מזה של מסלול MQTT",
    (s) => s.replace("'state_' || v_res.outcome", "'direct_state_' || v_res.outcome")],
  ["הפירוט התרוקן",
    (s) => s.replace(/format\('outcome=%s · status=%s · occurredAt=%s',[\s\S]*?'\(חסר\)'\)\),\n/, "'נדחה',\n")],
];

async function main() {
  const src = fs.readFileSync(FILE, "utf8");
  const good = batchSource(src);

  let bad = 0;
  try {
    for (const [label, mutate] of MUTATIONS) {
      const mutant = mutate(good);
      if (mutant === good) { console.log(`❌ ${label} — המוטציה לא שינתה כלום`); bad++; continue; }

      try {
        await db.pool.query(mutant);
      } catch (e) {
        console.log(`❌ ${label} — המוטציה אינה מתקמפלת: ${e.message}`);
        bad++;
        continue;
      }
      const res = gate();
      await db.pool.query(good);          // מחזירים מיד, לפני ההדפסה

      console.log(res === "red"
        ? `✅ מוטציה נתפסה: ${label}`
        : `❌ מוטציה עברה בשקט: ${label} — השער עיוור`);
      if (res !== "red") bad++;
    }
  } finally {
    await db.pool.query(good);            // גם אם משהו זרק באמצע
  }

  console.log(`\nאחרי שחזור: ${gate()}`);
  await db.close();
  console.log(bad ? `\n❌ ${bad} בעיות` : "\n✅ כל המוטציות נתפסו");
  process.exit(bad ? 1 : 0);
}

main();
