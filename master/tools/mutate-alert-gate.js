// mutate-alert-gate — לשבור את הדגל בכוונה, ולדרוש מהשער להאדים.
//
// ⚠️ **המוטציה מוחלת בתוך טרנזקציה שמתגלגלת חזרה.** DDL שלא בוצע commit
// אינו נראה לאף סשן אחר, ולכן `pg_cron` שיריץ את הפונקציה באותן שניות
// יריץ את **הגרסה התקינה**. בלי זה הבדיקה עצמה הייתה עלולה לשלוח את
// ההתראות שהיא באה לוודא שאינן נשלחות.
//
//   node --env-file=.env tools/mutate-alert-gate.js

const db = require("../db/db");
const gate = require("./check-alert-gate");

const MUTATIONS = [
  ["ההגדרה של v_sys_on הוסרה",
    (s) => s.replace(/v_sys_on\s+boolean\s*:=[\s\S]*?;\s*\n/, "v_sys_on boolean := true;\n")],
  ["גידור אחד מארבעה הוסר",
    (s) => s.replace(/CASE WHEN v_sys_on THEN (app\.send_push\([\s\S]*?\)) END/, "$1")],
  ["הדגל הפך לתמיד-דלוק",
    (s) => s.replace(/=\s*'true';\s*\n\s*BEGIN/, "= 'true' OR true;\nBEGIN")],
];

async function main() {
  const client = await db.pool.connect();
  let bad = 0;
  try {
    const { rows: [{ src }] } = await client.query(
      "SELECT pg_get_functiondef('app.check_ingestion_health'::regproc) AS src");

    for (const [label, mutate] of MUTATIONS) {
      const mutant = mutate(src);
      if (mutant === src) { console.log(`❌ ${label} — המוטציה לא שינתה כלום`); bad++; continue; }

      await client.query("BEGIN");
      await client.query(mutant);
      const failures = await gate.run(client);
      await client.query("ROLLBACK");

      console.log(failures > 0
        ? `\n✅ מוטציה נתפסה: ${label}  (${failures} כשלים)\n`
        : `\n❌ מוטציה עברה בשקט: ${label} — השער עיוור\n`);
      if (failures === 0) bad++;
    }

    // ------------------------------------------------------------
    // ⚠️ מוטציה רביעית: המשימה עצמה נעלמת מהלוח
    // ------------------------------------------------------------
    // זו לא מוטציה תיאורטית — היא **קרתה**. החלה ידנית של פרוסה מהקובץ
    // סחפה איתה את ה-`DO` שמבצע `cron.unschedule`, בלי ה-`cron.schedule`
    // שאחריו, והמשימה נעלמה מהלוח. `cron.job` היא טבלה רגילה, ולכן
    // גם המוטציה הזו מתגלגלת חזרה.
    await client.query("BEGIN");
    await client.query("SELECT cron.unschedule('parkomat-ingestion-health')");
    const f4 = await gate.run(client);
    await client.query("ROLLBACK");
    console.log(f4 > 0
      ? `\n✅ מוטציה נתפסה: המשימה הוסרה מהלוח  (${f4} כשלים)\n`
      : "\n❌ מוטציה עברה בשקט: המשימה הוסרה מהלוח — השער עיוור\n");
    if (f4 === 0) bad++;

    // המקור חזר לקדמותו?
    const { rows: [{ ok }] } = await client.query(
      "SELECT position('v_sys_on' in pg_get_functiondef('app.check_ingestion_health'::regproc)) > 0 AS ok");
    console.log(ok ? "✅ הייצור חזר לגרסה המגודרת" : "❌ הייצור נשאר מקולקל");
    if (!ok) bad++;
  } finally {
    client.release();
  }
  await db.close();
  console.log(bad ? `\n❌ ${bad} בעיות` : "\n✅ כל המוטציות נתפסו");
  process.exit(bad ? 1 : 0);
}

main();
