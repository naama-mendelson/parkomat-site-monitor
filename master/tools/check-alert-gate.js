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
    const gated  = (code.match(/CASE\s+WHEN\s+v_sys_on\s+THEN\s+app\.send_push\s*\(/g) || []).length;

    check("ארבע ההתראות המערכתיות קיימות בייצור", calls === 4, `נמצאו ${calls}`);
    check("⚠️ כל אחת מהן עוברת דרך הדגל", calls > 0 && gated === calls,
      `${gated}/${calls} מגודרות`);

    // ------------------------------------------------------------
    // 2. הקובץ והייצור מסכימים
    // ------------------------------------------------------------
    const fs = require("fs");
    const path = require("path");
    const file = fs.readFileSync(path.join(__dirname, "..", "db", "cron.postgres.sql"), "utf8")
      .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const fileGated = (file.match(/CASE\s+WHEN\s+v_sys_on\s+THEN\s+app\.send_push\s*\(/g) || []).length;
    check("הקובץ ב-git זהה לייצור — עלייה הבאה של master לא תבטל את הדגל",
      fileGated === gated, `קובץ ${fileGated} · ייצור ${gated}`);

    // ------------------------------------------------------------
    // 3. הביטוי עצמו — נלקח מהייצור ומורץ, לא משוכתב
    // ------------------------------------------------------------
    // ⚠️ העתקת הביטוי לכאן הייתה בודקת את מה שכתבתי, לא את מה שרץ.
    const m = code.match(/v_sys_on\s+boolean\s*:=\s*([\s\S]*?);\s*\n/);
    check("הגדרת v_sys_on נמצאה בייצור", !!m);
    if (!m) return failures;
    const expr = m[1];

    const had = (await client.query("SELECT value FROM settings WHERE key = $1", [KEY])).rows[0];

    async function evalFlag() {
      const { rows: [r] } = await client.query(`SELECT (${expr}) AS on`);
      return r.on;
    }

    await client.query("DELETE FROM settings WHERE key = $1", [KEY]);
    check("בלי שורה בכלל — כבוי", (await evalFlag()) === false);

    await client.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1,'true', now()::text)
         ON CONFLICT (key) DO UPDATE SET value = 'true'`, [KEY]);
    check("⚠️ 'true' — דלוק (אחרת הדגל היה חוסם לנצח)", (await evalFlag()) === true);

    await client.query("UPDATE settings SET value = 'false' WHERE key = $1", [KEY]);
    check("'false' — כבוי", (await evalFlag()) === false);

    // החזרה למצב שהיה.
    await client.query("DELETE FROM settings WHERE key = $1", [KEY]);
    if (had) {
      await client.query(
        "INSERT INTO settings (key, value, updated_at) VALUES ($1,$2, now()::text)", [KEY, had.value]);
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
    // 6. המצב עכשיו
    // ------------------------------------------------------------
    const now = (await client.query("SELECT value FROM settings WHERE key = $1", [KEY])).rows[0];
    console.log("");
    console.log(`   ${KEY} = ${now ? now.value : "לא מוגדר"}  →  התראות מערכתיות ${
      now && now.value === "true" ? "דלוקות ⚠️" : "כבויות"}`);
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
