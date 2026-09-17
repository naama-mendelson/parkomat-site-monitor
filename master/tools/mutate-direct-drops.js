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
const safety = require("./lib/mutation-safety");

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
  // ⚠️ צילום של מה שחי, ורק אם הוא זהה לקובץ — ראה tools/lib/mutation-safety.js.
  const snaps = await safety.snapshotMatchingFile(db.pool,
    [{ regprocedure: "public.ingest_batch(jsonb, text, jsonb)", createSql: good }]);

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
      // מחזירים מיד, לפני ההדפסה — ומאמתים. החזרה שנכשלה עוצרת את הלולאה.
      const restoreFailed = await safety.restoreAndVerify(db.pool, snaps);
      if (restoreFailed.length) { bad += safety.reportRestore(restoreFailed); break; }

      console.log(res === "red"
        ? `✅ מוטציה נתפסה: ${label}`
        : `❌ מוטציה עברה בשקט: ${label} — השער עיוור`);
      if (res !== "red") bad++;
    }
  } finally {
    // גם אם משהו זרק באמצע
    bad += safety.reportRestore(await safety.restoreAndVerify(db.pool, snaps));
  }

  // ============================================================
  // ⚠️ שער אדום אחרי השחזור הוא **כשל**, ולא שורת דיווח
  // ============================================================
  // הגרסה הקודמת הדפיסה `אחרי שחזור: red` ואז `✅ כל המוטציות נתפסו`, ויצאה
  // באפס. מי שקורא את שתי השורות האחרונות רואה הצלחה — בזמן שהייצור נשאר
  // מקולקל.
  //
  // ⚠️ **וזה לא תיאורטי: זה קרה.** ב-17/09/2026 סקריפט מוטציה דיווח "כל
  // המוטציות נתפסו" והשאיר את השינוי בקובץ, ומיד אחריו רצה החלה על מסד חי
  // עם קוד מומט. `mutate-alert-gate.js` כבר עשה את זה נכון (`if (!ok) bad++`)
  // — הדפוס היה ידוע, הוא פשוט לא הוחל בכל הכלים.
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
