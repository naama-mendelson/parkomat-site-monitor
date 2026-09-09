// check-alert-gate — ההחלטה "רק תקלה באתר" מוחזקת בקוד, לא בתיעוד.
//
// ============================================================
// ⚠️ למה השער הזה קיים
// ============================================================
// בעלת המוצר בחרה במפורש: **רק תקלה באתר בודד.** ארבע ההתראות
// המערכתיות ב-`app.check_ingestion_health` — שרת שחדל לדווח, הודעות
// שנזרקות, חשכה כללית, ואתר שקט — נמדדו כ-4–6 בשבוע, וזה יותר ממה
// שהוחלט לקבל.
//
// ⚠️ **וההחלטה הזאת שברירית במיוחד, כי היא כבויה בגלל דבר שכבר תוקן.**
// תיקון ה-`site_id: 0` ב-`notify-fault` נמצא בריפו ונדחף. כל מי שירוץ
// `supabase functions deploy notify-fault` **מסיבה אחרת לגמרי** — תיקון
// עתידי כלשהו באותה פונקציה — היה מדליק את ארבעתן בשקט, בלי שאיש החליט.
// הערה בתיעוד לא הייתה מונעת את זה.
//
// לכן ההחלטה יושבת על דגל אחד, `settings.system_alerts_enabled`, והשער
// הזה בודק שהדגל **באמת חוסם** ולא רק קיים.
//
// ============================================================
// ⚠️ ומה שנבדק כאן הוא הפונקציה שבייצור, לא הקובץ
// ============================================================
// `db.init()` מחיל את `cron.postgres.sql` בכל עלייה של master, אבל
// פונקציה שהוחלה ידנית ממחשב פיתוח יכולה להקדים אותו. שער שקורא את
// הקובץ בלבד היה ירוק על ייצור שכבר סטה. לכן המקור נקרא מ-
// `pg_get_functiondef` — ורק אחר כך מושווה לקובץ.
//
//   node --env-file=.env tools/check-alert-gate.js

const db = require("../db/db");

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? "✅ " : "❌ ") + label + (detail ? `   ${detail}` : ""));
  if (!ok) failures++;
}

const KEY = "system_alerts_enabled";
const SILENT_KEY = "silent_site_alerts_enabled";

// ⚠️ הבדיקות מקבלות `client` ומיוצאות, כדי ש-`mutate-alert-gate` יוכל
// להריץ **בדיוק אותן** מול גרסה מקולקלת. העתקה שלהן לתסריט המוטציה
// הייתה בודקת את ההעתק — כלומר שער שאין דרך לדעת אם הוא רואה משהו.
async function run(client) {
  failures = 0;
  {
    // ------------------------------------------------------------
    // 1. המקור שבייצור
    // ------------------------------------------------------------
    const { rows: [{ src }] } = await client.query(
      "SELECT pg_get_functiondef('app.check_ingestion_health'::regproc) AS src");

    // ⚠️ ההערות מוסרות לפני הספירה. בלעדיהן השער היה נצבע ירוק מהמילים
    // שכתבתי *על* המנגנון — טעות שכבר נעשתה שלוש פעמים בשערים אחרים.
    const code = src.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

    const calls  = (code.match(/app\.send_push\s*\(/g) || []).length;
    const bySys  = (code.match(/CASE\s+WHEN\s+v_sys_on\s+THEN\s+app\.send_push\s*\(/g) || []).length;
    const bySite = (code.match(/CASE\s+WHEN\s+v_silent_on\s+THEN\s+app\.send_push\s*\(/g) || []).length;

    check("ארבע ההתראות קיימות בייצור", calls === 4, `נמצאו ${calls}`);
    check("⚠️ כל אחת מהן עוברת דרך דגל כלשהו", calls > 0 && bySys + bySite === calls,
      `${bySys} מערכת + ${bySite} אתר = ${bySys + bySite} מתוך ${calls}`);

    // ============================================================
    // ⚠️ שני דגלים ולא אחד — וזו הטענה החשובה כאן
    // ============================================================
    // שלוש ההתראות הראשונות הן על **המערכת שלנו** (השרת חדל לדווח,
    // הודעות נזרקות, חשכה כללית), נמדדו כ-4–6 בשבוע, והוחלט לא לקבל
    // אותן. הרביעית שואלת שאלה אחרת לגמרי: **אתר של לקוח מנותק שעות.**
    //
    // ⚠️ **נמדד ב-09/09/2026, והמחיר היה קונקרטי:** שישה אתרים היו
    // מנותקים 9–15.5 שעות אחרי אתחול של עדכון Windows, ומה שגילה את זה
    // היה מבט מקרי במסך. חמישה מהם היו חוצים את סף שש השעות ומייצרים
    // התראה שעתיים קודם. דגל אחד לשתי השאלות פירושו שכיבוי הרעש מכבה
    // גם את זה.
    check("⚠️ שלוש המערכתיות מגודרות בדגל המערכת", bySys === 3, `${bySys}`);
    check("⚠️ והאתר השקט בדגל **נפרד**", bySite === 1, `${bySite}`);

    // ------------------------------------------------------------
    // 2. הקובץ והייצור מסכימים
    // ------------------------------------------------------------
    const fs = require("fs");
    const path = require("path");
    const file = fs.readFileSync(path.join(__dirname, "..", "db", "cron.postgres.sql"), "utf8")
      .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const fileSys  = (file.match(/CASE\s+WHEN\s+v_sys_on\s+THEN\s+app\.send_push\s*\(/g) || []).length;
    const fileSite = (file.match(/CASE\s+WHEN\s+v_silent_on\s+THEN\s+app\.send_push\s*\(/g) || []).length;
    check("הקובץ ב-git זהה לייצור — עלייה הבאה של master לא תבטל את הדגלים",
      fileSys === bySys && fileSite === bySite,
      `קובץ ${fileSys}/${fileSite} · ייצור ${bySys}/${bySite}`);

    // ------------------------------------------------------------
    // 3. הביטוי עצמו — נלקח מהייצור ומורץ, לא משוכתב
    // ------------------------------------------------------------
    // ⚠️ העתקת הביטוי לכאן הייתה בודקת את מה שכתבתי, לא את מה שרץ.
    // ⚠️ **שני הדגלים נבדקים, ולא רק הראשון.** דגל שני שנוסף ואינו
    // נבדק הוא בדיוק המצב שבו מישהו כותב שם 'True' או 'yes' ומגלה
    // חודשיים אחר כך שההתראה מעולם לא יצאה.
    for (const [name, key] of [["v_sys_on", KEY], ["v_silent_on", SILENT_KEY]]) {
      const m = code.match(new RegExp(`${name}\\s+boolean\\s*:=\\s*([\\s\\S]*?);\\s*\\n`));
      check(`הגדרת ${name} נמצאה בייצור`, !!m);
      if (!m) { failures++; continue; }
      const expr = m[1];

      const had = (await client.query(
        "SELECT value FROM settings WHERE key = $1", [key])).rows[0];

      const evalFlag = async () =>
        (await client.query(`SELECT (${expr}) AS on`)).rows[0].on;

      await client.query("DELETE FROM settings WHERE key = $1", [key]);
      check(`  ${key}: בלי שורה בכלל — כבוי`, (await evalFlag()) === false);

      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1,'true', now()::text)
           ON CONFLICT (key) DO UPDATE SET value = 'true'`, [key]);
      check(`  ⚠️ ${key}: 'true' — דלוק (אחרת הדגל חוסם לנצח)`, (await evalFlag()) === true);

      await client.query("UPDATE settings SET value = 'false' WHERE key = $1", [key]);
      check(`  ${key}: 'false' — כבוי`, (await evalFlag()) === false);

      // החזרה למצב שהיה.
      await client.query("DELETE FROM settings WHERE key = $1", [key]);
      if (had) {
        await client.query(
          "INSERT INTO settings (key, value, updated_at) VALUES ($1,$2, now()::text)",
          [key, had.value]);
      }
    }

    // ------------------------------------------------------------
    // 4. ⚠️ ש-CASE באמת אינו מפעיל את הענף שלא נבחר
    // ------------------------------------------------------------
    // זו ההנחה היחידה שעליה הכול תלוי, והיא **אינה מובנת מאליה**:
    // Postgres מותר לו לקפל תת-ביטוי קבוע בזמן תכנון. פונקציה IMMUTABLE
    // בתוך THEN הייתה יכולה להתבצע גם כשהתנאי false. `app.send_push`
    // היא VOLATILE ולכן אמורה להיות מוגנת — אבל "אמורה" אינו מדידה.
    // ⚠️ החיבור מגיע מ-pool ונשאר חי בין ריצות, ולכן אובייקטים זמניים
    // שורדים ריצה קודמת. בלי הניקוי הזה השער נופל על עצמו בפעם השנייה.
    await client.query(`
      DROP FUNCTION IF EXISTS pg_temp.probe();
      DROP TABLE IF EXISTS _probe;
      CREATE TEMP TABLE _probe (n int);
      CREATE FUNCTION pg_temp.probe() RETURNS int LANGUAGE plpgsql AS $f$
        BEGIN INSERT INTO _probe VALUES (1); RETURN 1; END $f$;
    `);
    await client.query("DO $d$ DECLARE v int; f boolean := false; BEGIN v := CASE WHEN f THEN pg_temp.probe() END; END $d$");
    const off = (await client.query("SELECT count(*)::int AS n FROM _probe")).rows[0].n;
    await client.query("DO $d$ DECLARE v int; f boolean := true;  BEGIN v := CASE WHEN f THEN pg_temp.probe() END; END $d$");
    const on = (await client.query("SELECT count(*)::int AS n FROM _probe")).rows[0].n;

    check("⚠️ CASE כבוי אינו מפעיל את הענף — כלומר השליחה באמת לא קורית", off === 0);
    check("...ו-CASE דלוק כן מפעיל אותו — כלומר הבדיקה עצמה לא ריקה", on === 1);

    // ------------------------------------------------------------
    // 5. הדה-דופ נרשם רק כשנשלח
    // ------------------------------------------------------------
    // ⚠️ אחרת כיבוי היה מרעיל את המצב: `alert_last_heartbeat` היה נכתב
    // בכל הרצה, וביום שבו ידליקו את הדגל ההתראה הראשונה הייתה נבלעת.
    const dedupWrites = (code.match(/IF\s+v_req\s+IS\s+NOT\s+NULL\s+THEN/g) || []).length;
    check("רישום הדה-דופ תלוי בשליחה בפועל", dedupWrites >= 3,
      `${dedupWrites} מקומות`);

    // ------------------------------------------------------------
    // 6. ⚠️ הזיהוי עצמו עדיין רץ
    // ------------------------------------------------------------
    // ההחלטה הייתה **"הזיהוי ממשיך לדווח, רק השליחה מושבתת"**. שער
    // שבודק רק את הדגל היה ירוק גם כשהפונקציה אינה מורצת בכלל —
    // וזה בדיוק מה שקרה: החלה ידנית של פרוסה מהקובץ סחפה איתה את
    // ה-`DO` שמבצע `cron.unschedule('parkomat-ingestion-health')`,
    // בלי ה-`cron.schedule` שאחריו. המשימה נעלמה מהלוח ל-22 דקות,
    // והשומר על "התראות כבויות" לא הרגיש דבר.
    const JOBS = ["parkomat-ingestion-health", "parkomat-agent-silence",
                  "parkomat-prune-events", "parkomat-cleanup-old",
                  "parkomat-prune-ingest-drops"];
    const jobs = (await client.query(
      "SELECT jobname, active FROM cron.job")).rows;
    for (const j of JOBS) {
      const row = jobs.find((r) => r.jobname === j);
      check(`משימת cron קיימת ופעילה: ${j}`, !!row && row.active === true,
        row ? "" : "לא מתוזמנת");
    }

    // ⚠️ "מתוזמנת" אינה "רצה". משימה יכולה להיות בלוח ולהיכשל בכל הרצה.
    const { rows: [hr] } = await client.query(`
      SELECT max(end_time) AS last, count(*) FILTER (WHERE status <> 'succeeded') AS bad
        FROM cron.job_run_details d JOIN cron.job j USING (jobid)
       WHERE j.jobname = 'parkomat-ingestion-health'
         AND d.start_time > now() - interval '2 hours'`);
    check("...והיא באמת רצה בשעתיים האחרונות", !!hr.last,
      hr.last ? `אחרונה ${new Date(hr.last).toISOString()}` : "אף הרצה");
    check("...בלי כשלים", Number(hr.bad) === 0, `${hr.bad} כשלים`);

    // ------------------------------------------------------------
    // 7. המצב עכשיו
    // ------------------------------------------------------------
    const state = async (k) =>
      (await client.query("SELECT value FROM settings WHERE key = $1", [k])).rows[0];
    const sys = await state(KEY);
    const sil = await state(SILENT_KEY);
    const say = (r) => (r && r.value === "true" ? "דלוקות ⚠️" : "כבויות");

    console.log("");
    console.log(`   ${KEY} = ${sys ? sys.value : "לא מוגדר"}  →  התראות מערכת ${say(sys)}`);
    console.log(`   ${SILENT_KEY} = ${sil ? sil.value : "לא מוגדר"}  →  אתר מנותק שעות ${say(sil)}`);
    console.log("   תקלת אתר בודד עוברת במסלול אחר (ingestion → notify-fault) ואינה מושפעת.");
  }
  return failures;
}

module.exports = { run };

async function main() {
  const client = await db.pool.connect();
  try { await run(client); } finally { client.release(); }
}

if (require.main === module) main()
  .then(() => { console.log(failures ? `\n❌ ${failures} כשלים` : "\n✅ הכל עבר"); })
  .catch((e) => { console.error("❌", e.message); failures++; })
  .finally(async () => { await db.close(); process.exit(failures ? 1 : 0); });
