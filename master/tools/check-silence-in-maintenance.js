// check-silence-in-maintenance — אתר שנפל בזמן ש-MODE 0 חייב להיספר כמנותק.
//
// ============================================================
// ⚠️ הכשל שנמדד: המצב הקפוא הגן על עצמו מלהיות מזוהה
// ============================================================
// `app.mark_silent_agents` דילגה על כל אתר ש-`sites.status = 'maintenance'`,
// בנימוק *"אתר שמישהו הכניס לתחזוקה אמור להיות שקט"*. הנימוק נכון — והוא
// מתאר **חלון תחזוקה שנפתח מהדשבורד**, לא את מה שהתנאי בדק בפועל.
//
// `sites.status = 'maintenance'` פירושו **הבקר דיווח MODE 0**. איש לא ביקש
// שקט, והפעימה אינה תלויה ב-MODE כלל: סוכן של בקר בתחזוקה פועם כל 60 שניות
// בדיוק כמו כל סוכן אחר.
//
// **מגדל 1 (2438), 15/09/2026:**
//
//     05:15  הבקר דיווח MODE 0 → מקטע `maintenance` נפתח
//     05:31  הודעה אמיתית אחרונה
//     06:06  הפעימה נעצרה (הזהות נמחקה). ו-MQTT כבוי באתר הזה.
//
// מ-06:06 האתר חשוך לחלוטין. הסריקה דילגה עליו כל דקה במשך שבע שעות, כי
// הסטטוס שקפא הוא בדיוק זה שפוטר אותו מהבדיקה. המפעילה החזירה את הבקר
// לאוטומט, והכרטיס המשיך לומר "בתחזוקה".
//
// ⚠️ והנזק אינו בתצוגה בלבד: מקטע `maintenance` מוחרג ממכנה הזמינות ומשתיק
// ספירת תקלות. אתר שחשך תוך כדי MODE 0 יוצא מהמדידה לנצח.
//
// הכול בטרנזקציה שמתגלגלת חזרה.
//
//   node --env-file=.env tools/check-silence-in-maintenance.js

const db = require("../db/db");

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? "✅ " : "❌ ") + label + (detail ? `   ${detail}` : ""));
  if (!ok) failures++;
}

const SITE = "2438";

async function main() {
  const c = await db.pool.connect();
  try {
    const { rows: [site] } = await c.query(
      `SELECT s.id, s.status FROM sites s
         JOIN app_users u ON u.site_id = s.id AND u.role = 'agent' AND u.is_active
        WHERE s.code = $1`, [SITE]);
    check(`נמצא אתר ${SITE} עם זהות סוכן פעילה`, !!site);
    if (!site) return;

    const before = site.status;
    await c.query("BEGIN");

    // ⚠️ ההקמה כותבת ישירות ולא דרך `ingest_state`, מאותה סיבה שמתועדת
    // ב-`check-beat-recovery`: `now()` ב-Postgres הוא זמן ה**טרנזקציה**,
    // ולכן אי אפשר לבנות רצף מעברי מצב בתוך טרנזקציה אחת.
    //
    // ⚠️ ו-`last_seen` נקבע **לפני** `seen_at` במכוון: זה התנאי שאומר
    // "שום דבר לא הגיע מאז שהפעימה נעצרה", כלומר שני המסלולים שותקים.
    // בלעדיו הבדיקה הייתה מודדת אתר שמדווח יפה ב-MQTT.
    async function setup(status) {
      await c.query(
        `UPDATE alive SET seen_at = now() - interval '1 hour' WHERE site_id = $1`, [site.id]);
      await c.query(
        `UPDATE sites SET status = $2,
                last_seen = to_char(now() - interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          WHERE id = $1`, [site.id, status]);
    }
    const scanned = async () =>
      (await c.query(`SELECT site_code FROM app.mark_silent_agents(3)`)).rows
        .some((r) => r.site_code === SITE);

    // ------------------------------------------------------------
    // 1. בקרה — בלעדיה הבדיקה יכולה לעבור מסיבה שאינה הסיבה
    // ------------------------------------------------------------
    // ⚠️ אם ההקמה שבורה, "לא סומן" בסעיפים הבאים ייראה כמו התנהגות נכונה.
    // הסעיף הזה מוכיח שהסריקה בכלל רואה את האתר במצב שהוקם.
    await setup("ready");
    check("אתר שקט במצב ready מסומן מנותק (בקרה)", await scanned());

    // ------------------------------------------------------------
    // 2. הכשל עצמו
    // ------------------------------------------------------------
    await setup("maintenance");
    check("⚠️ אתר חשוך שהבקר בו ב-MODE 0 מסומן מנותק", await scanned(),
      "זה הכשל של מגדל 1 — הסטטוס הקפוא פטר את עצמו מהבדיקה");

    // ------------------------------------------------------------
    // 3. וחלון תחזוקה ידני עדיין גובר
    // ------------------------------------------------------------
    // ⚠️ בלי הסעיף הזה התיקון מבטל את הכלל המקורי במקום לצמצם אותו: בזמן
    // חלון פתוח מישהו עומד פיזית באתר ועשוי לכבות את המחשב, והתראה עליו
    // היא רעש על עבודה מתוכננת.
    await setup("ready");
    await c.query(
      `INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at)
       VALUES ($1, 'gate', to_char(now() - interval '10 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               2, to_char(now() + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
      [site.id]);
    check("⚠️ חלון תחזוקה פעיל מהדשבורד עדיין משתיק את הסימון", !(await scanned()));

    // ------------------------------------------------------------
    // 4. וחלון שבוטל אינו משתיק
    // ------------------------------------------------------------
    // ⚠️ `COALESCE(cancelled_at, expires_at)` הוא מה שמבחין. בלעדיו חלון
    // שבוטל לפני חודש היה ממשיך להשתיק עד שעת הפקיעה המקורית שלו.
    await c.query(
      `UPDATE maintenance_windows SET cancelled_at = to_char(now() - interval '5 minutes',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE site_id = $1 AND set_by_name = 'gate'`, [site.id]);
    await setup("ready");
    check("⚠️ חלון שבוטל אינו משתיק", await scanned());

    await c.query("ROLLBACK");

    const { rows: [after] } = await c.query("SELECT status FROM sites WHERE id = $1", [site.id]);
    check("הייצור חזר בדיוק למה שהיה", before === after.status, `${before} → ${after.status}`);
  } finally {
    c.release();
  }
}

main()
  .then(() => console.log(failures ? `\n❌ ${failures} כשלים` : "\n✅ הכל עבר"))
  .catch((e) => { console.error("❌", e.message); failures++; })
  .finally(async () => { await db.close(); process.exit(failures ? 1 : 0); });
