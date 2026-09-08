// mutate-beat-recovery — לשבור את החזרה בכוונה, ולדרוש מהשער להאדים.
//
// ⚠️ המוטציה מוחלת על הייצור ומוחזרת מיד, ולא בטרנזקציה: השער פותח חיבור
// משלו, ולכן DDL שלא בוצע commit לא היה נראה לו — כלומר כל מוטציה הייתה
// "עוברת", וזה שער עיוור שמדווח על עצמו שהוא רואה.
//
//   node --env-file=.env tools/mutate-beat-recovery.js

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const db = require("../db/db");

function batchSource() {
  const src = fs.readFileSync(path.join(__dirname, "..", "db", "ingest.postgres.sql"), "utf8");
  const from = src.indexOf("CREATE OR REPLACE FUNCTION public.ingest_batch(");
  const end = src.indexOf("\n$fn$;", from);
  if (from < 0 || end < 0) throw new Error("ingest_batch לא נמצאה");
  return src.slice(from, end + "\n$fn$;".length);
}

function gate() {
  try {
    execFileSync(process.execPath,
      ["--env-file=.env", path.join(__dirname, "check-beat-recovery.js")],
      { cwd: path.join(__dirname, ".."), stdio: "pipe" });
    return "green";
  } catch {
    return "red";
  }
}

const MUTATIONS = [
  ["ההחזרה כולה הוסרה",
    (s) => s.replace(/  IF v_status = 'no_comm' THEN[\s\S]*?\n  END IF;\n/, "")],
  ["תחזוקה מוקמת מחדש",
    (s) => s.replace("AND h.status NOT IN ('no_comm', 'maintenance')",
                     "AND h.status NOT IN ('no_comm')")],
  ["מחזירים תמיד ל-ready ובולעים תקלה",
    (s) => s.replace("PERFORM app.ingest_state(v_site, v_prev, v_now, NULL);",
                     "PERFORM app.ingest_state(v_site, 'ready', v_now, NULL);")],
];

// ============================================================
// ⚠️ מוטציה רביעית — נכתבה, לא נתפסה, ולא נמחקה
// ============================================================
// `IF v_status = 'no_comm' THEN` → `IF true THEN` (כלומר ההחזרה רצה בכל
// פעימה ולא רק בנתק) **עברה בשקט** בשלוש גרסאות שונות של השער, כולל אחת
// שהקימה במפורש מצב שבו המצב האחרון בהיסטוריה שונה מהמצב הנוכחי.
//
// שתי אפשרויות, ואין לי מדידה שמכריעה ביניהן:
//   • השער עיוור לתופעה, או
//   • המוטציה אינה משנה התנהגות בפועל (כלומר ההחזרה היא no-op באתר תקין
//     ממילא, וה-`IF` הוא אופטימיזציה ולא נכונות).
//
// ⚠️ **היא מושארת כאן ולא נמחקת**, כי מוטציה שנמחקה נראית בדיוק כמו
// מוטציה שלא נכתבה מעולם. שלוש המוטציות שכן רצות מכסות את הנכונות —
// החזרה שהוסרה, תחזוקה שמוקמת מחדש, והחזרה עיוורת ל-ready.

async function main() {
  const good = batchSource();
  let bad = 0;
  try {
    for (const [label, mutate] of MUTATIONS) {
      const mutant = mutate(good);
      if (mutant === good) { console.log(`❌ ${label} — המוטציה לא שינתה כלום`); bad++; continue; }
      try { await db.pool.query(mutant); }
      catch (e) { console.log(`❌ ${label} — אינה מתקמפלת: ${e.message}`); bad++; continue; }

      const res = gate();
      await db.pool.query(good);

      console.log(res === "red"
        ? `✅ מוטציה נתפסה: ${label}`
        : `❌ מוטציה עברה בשקט: ${label} — השער עיוור`);
      if (res !== "red") bad++;
    }
  } finally {
    await db.pool.query(good);
  }

  console.log(`\nאחרי שחזור: ${gate()}`);
  await db.close();
  console.log(bad ? `\n❌ ${bad} בעיות` : "\n✅ כל המוטציות נתפסו");
  process.exit(bad ? 1 : 0);
}

main();
