// check-dashboard-truth — האם המספרים שעל המסך נאמנים לנתונים הגולמיים.
//
// ============================================================
// ⚠️ למה השער הזה קיים
// ============================================================
// כל השערים האחרים בודקים שהמסלול **עובד**: שההודעה נקלטה, שהפעימה
// יצאה, שהזריקה נרשמה. אף אחד מהם אינו שואל את השאלה של מי שמסתכל
// על המסך: *"המספר שאני רואה — הוא נכון?"*
//
// ⚠️ **וזו לא שאלה תיאורטית.** נמדד ב-10/09/2026: אתרים הציגו **100%
// זמינות בזמן שהיו חשוכים 15 שעות**, כי no_comm מוחרג ממכנה הזמינות.
// זה אינו באג בחישוב — זו ההגדרה — אבל מספר נכון שנקרא שגוי הוא בדיוק
// כמו מספר שגוי. לכן חלק מהבדיקות כאן הן **אזהרות** ולא כשלים: הן
// מודדות פער בין מה שנכון לבין מה שמובן.
//
// השער **קורא בלבד** ואינו כותב דבר.
//
//   node --env-file=.env tools/check-dashboard-truth.js

const db = require("../db/db");

let failures = 0;
let warnings = 0;

function check(label, ok, detail) {
  console.log((ok ? "✅ " : "❌ ") + label + (detail ? `   ${detail}` : ""));
  if (!ok) failures++;
}

function warn(label, clean, detail) {
  console.log((clean ? "✅ " : "⚠️  ") + label + (detail ? `   ${detail}` : ""));
  if (!clean) warnings++;
}

const WINDOW_DAYS = 7;
const FAR_FUTURE = "9999-12-31T23:59:59.999Z";

async function main() {
  const c = await db.pool.connect();
  try {
    const to = new Date();
    const from = new Date(to.getTime() - WINDOW_DAYS * 86400e3);
    const iso = (d) => d.toISOString();

    console.log(`חלון הבדיקה: ${WINDOW_DAYS} ימים אחרונים\n`);

    // ------------------------------------------------------------
    // 1. הצ'יפ על הכרטיס מול המקטע הפתוח
    // ------------------------------------------------------------
    // ⚠️ sites.status הוא מה שהכרטיס מצייר; status_history הוא ממה
    // שהזמינות מחושבת. אם השניים נפרדים, המסך מראה מצב אחד והמדד מודד
    // אחר — ואין שום מסך שבו הפער הזה נראה.
    const { rows: mismatch } = await c.query(`
      SELECT s.code, s.status AS chip, h.status AS segment
        FROM sites s
        LEFT JOIN LATERAL (
          SELECT status FROM status_history
           WHERE site_id = s.id AND ended_at IS NULL
           ORDER BY started_at DESC LIMIT 1) h ON true
       WHERE h.status IS DISTINCT FROM s.status`);

    check("הצ'יפ על הכרטיס תואם את המקטע הפתוח בהיסטוריה",
      mismatch.length === 0,
      mismatch.map((r) => `${r.code}: צ'יפ=${r.chip} מקטע=${r.segment ?? "אין"}`).join(" · "));

    // ------------------------------------------------------------
    // 2. אתר שפועם ומוצג כמנותק
    // ------------------------------------------------------------
    // ⚠️ **זה קרה בשטח.** mark_silent_agents סימנה אתר בריא כ-no_comm
    // בכל דקה. אתר שפעם לפני פחות משלוש דקות ומוצג "אין תקשורת" הוא
    // סתירה מוחלטת — ושתי הצורות שלה גרועות: או שהסימון שגוי, או
    // שהפעימה אינה מבטלת אותו.
    const { rows: ghost } = await c.query(`
      SELECT s.code, round(extract(epoch from (now() - a.seen_at)))::int AS age_s
        FROM sites s JOIN alive a ON a.site_id = s.id
       WHERE s.status = 'no_comm' AND a.seen_at > now() - interval '3 minutes'`);

    check("אין אתר שפועם ומוצג כמנותק",
      ghost.length === 0,
      ghost.map((r) => `${r.code} (פעם לפני ${r.age_s}s)`).join(" · "));

    // ------------------------------------------------------------
    // 3. הכיסוי — הבעיה שבגללה "האמינות לא נכונה"
    // ------------------------------------------------------------
    // ⚠️ הזמינות מחושבת על **שעות נמדדות**, ו-no_comm מוחרג מהמכנה.
    // אתר שהיה חשוך 90% מהשבוע יכול להציג 100%. זה נכון לפי ההגדרה
    // ומטעה לחלוטין למי שקורא, והכיסוי הוא בדיוק המספר שחסר על המסך.
    const { rows: cov } = await c.query(`
      SELECT s.code,
             u.availability_percent AS uptime_percent,
             u.measured_hours,
             u.no_comm_hours,
             u.total_hours,
             -- ⚠️ הכיסוי נגזר מ-total_hours ולא מאורך החלון: אתר שנרשם
             -- באמצע השבוע לא נמדד לפני שנולד, וחלוקה באורך החלון הייתה
             -- מציגה אותו כחסר-כיסוי בלי שום סיבה.
             round((u.measured_hours / NULLIF(u.total_hours, 0) * 100)::numeric, 1)
               AS coverage_pct
        FROM site_uptime(NULL, $1, $2) u
        JOIN sites s ON s.id = u.site_id
       ORDER BY coverage_pct ASC`, [iso(from), iso(to)]);

    // ⚠️ **הבדיקה הזו מדדה קודם את הדבר הלא נכון.** היא התריעה על כיסוי
    // נמוך — אבל כיסוי חסר נובע גם מ**תחזוקה מתוכננת**, שמוחרגת בכוונה
    // ובצדק. אתר שהיה בתחזוקה יומיים אינו אתר שאיננו יודעים עליו דבר.
    //
    // מה שבאמת מטעה הוא **זמן חשוך**: שעות שבהן לא הגיע שום נתון,
    // שמוחרגות מהמכנה ולכן **אינן מורידות את הזמינות כלל**. אתר שהיה
    // חשוך 20 שעות ומציג 99.9% אינו משקר — הוא פשוט אינו מספר את
    // החלק שבו לא היה מי שיספר.
    const DARK_HOURS_LIMIT = 5;
    const dark = cov
      .filter((r) => Number(r.no_comm_hours) >= DARK_HOURS_LIMIT)
      .sort((a, b) => Number(b.no_comm_hours) - Number(a.no_comm_hours));

    warn(`אין אתר עם יותר מ-${DARK_HOURS_LIMIT} שעות חשוכות בשבוע`,
      dark.length === 0,
      dark.map((r) => `${r.code}: ${Number(r.no_comm_hours).toFixed(1)}ש חשוך אך מציג ${r.uptime_percent}%`).join(" · "));

    // ⚠️ והמקרה החריף: כמעט 100% זמינות על כיסוי דל. זה **בדיוק** מה
    // שנצפה בשטח, וזה הכשל שמצדיק את הבדיקה כולה.
    const lying = cov.filter(
      (r) => Number(r.uptime_percent) >= 99.9 && Number(r.coverage_pct) < 75);
    check("⚠️ אין אתר שמציג ~100% זמינות על פחות מ-75% כיסוי",
      lying.length === 0,
      lying.map((r) => `${r.code}: ${r.uptime_percent}% על ${r.coverage_pct}% כיסוי`).join(" · "));

    // ------------------------------------------------------------
    // 4. מקטעים חופפים
    // ------------------------------------------------------------
    // ⚠️ חפיפה פירושה שאתר היה בשני מצבים באותה שנייה — כלומר סכום
    // המשכים גדול מהזמן שחלף, והזמינות מחושבת על מכנה מנופח.
    const { rows: overlap } = await c.query(`
      SELECT s.code, count(*)::int AS n
        FROM status_history a
        JOIN status_history b
          ON b.site_id = a.site_id AND b.id > a.id
         AND b.started_at < COALESCE(a.ended_at, $2)
         AND COALESCE(b.ended_at, $2) > a.started_at
        JOIN sites s ON s.id = a.site_id
       WHERE a.started_at >= $1
       GROUP BY s.code`, [iso(from), FAR_FUTURE]);

    check("אין מקטעי מצב חופפים", overlap.length === 0,
      overlap.map((r) => `${r.code}: ${r.n}`).join(" · "));

    // ------------------------------------------------------------
    // 5. יותר ממקטע פתוח אחד
    // ------------------------------------------------------------
    // ⚠️ שני מקטעים פתוחים פירושם שסגירה נכשלה, ומאותו רגע כל חישוב
    // זמינות סופר את אותו זמן פעמיים.
    const { rows: open2 } = await c.query(`
      SELECT s.code, count(*)::int AS n
        FROM status_history h JOIN sites s ON s.id = h.site_id
       WHERE h.ended_at IS NULL GROUP BY s.code HAVING count(*) > 1`);

    check("לכל אתר מקטע פתוח אחד לכל היותר", open2.length === 0,
      open2.map((r) => `${r.code}: ${r.n}`).join(" · "));

    // ------------------------------------------------------------
    // 6. תפעולים יתומים
    // ------------------------------------------------------------
    // ⚠️ end בלי start תואם מנפח את ספירת הפעולות ומעוות את המשך
    // הממוצע. נצפה בשטח כשקריאה ראשונה נחתה באמצע מחזור.
    const { rows: orphans } = await c.query(`
      WITH ops AS (
        SELECT site_id, card_number, start_end, occurred_at,
               lag(start_end) OVER (
                 PARTITION BY site_id, card_number ORDER BY occurred_at) AS prev
          FROM operations WHERE occurred_at >= $1)
      SELECT s.code, count(*)::int AS n
        FROM ops JOIN sites s ON s.id = ops.site_id
       WHERE ops.start_end = 'end' AND (ops.prev IS NULL OR ops.prev <> 'start')
       GROUP BY s.code ORDER BY n DESC`, [iso(from)]);

    warn("אין תפעולי end בלי start תואם", orphans.length === 0,
      orphans.map((r) => `${r.code}: ${r.n}`).join(" · "));

    // ------------------------------------------------------------
    // 7. חותמי זמן מהעתיד
    // ------------------------------------------------------------
    // ⚠️ שעון אתר שמקדים מייצר אירועים "בעתיד", והם נופלים מחוץ לכל
    // חלון — כלומר נעלמים מהמסך בלי להיעלם מהמסד.
    const { rows: future } = await c.query(`
      SELECT s.code, count(*)::int AS n
        FROM operations o JOIN sites s ON s.id = o.site_id
       WHERE o.occurred_at > to_char(
             (now() + interval '2 minutes') AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       GROUP BY s.code`);

    check("אין תפעולים עם חותם מהעתיד", future.length === 0,
      future.map((r) => `${r.code}: ${r.n}`).join(" · "));

    // ------------------------------------------------------------
    // 8. מונה ה-PLC מול ספירת התפעולים שלנו
    // ------------------------------------------------------------
    // ⚠️ שני מקורות לאותה שאלה. cycle_total נגזר מדלתות של מונה הבקר;
    // ספירת השורות היא מה שהסוכן זיהה. הם לא חייבים להיות זהים (המונה
    // מצטבר מאז ומתמיד), אבל מונה שאינו זז בזמן שהתפעולים עולים מעיד
    // על רגיסטר שגוי — בדיוק מה שנמצא בפלורנטין.
    const { rows: cyc } = await c.query(`
      SELECT s.code, s.plc_cycle_last, s.cycle_total,
             (SELECT count(*)::int FROM operations o
               WHERE o.site_id = s.id AND o.start_end = 'start'
                 AND o.occurred_at >= $1) AS ops_week
        FROM sites s
       WHERE EXISTS (SELECT 1 FROM alive a WHERE a.site_id = s.id)
       ORDER BY s.code`, [iso(from)]);

    const stuck = cyc.filter((r) => r.ops_week > 5 && (r.plc_cycle_last ?? 0) === 0);
    warn("לכל אתר פעיל יש מונה PLC שנקרא", stuck.length === 0,
      stuck.map((r) => `${r.code}: ${r.ops_week} פעולות, מונה=${r.plc_cycle_last ?? "null"}`).join(" · "));

    // ------------------------------------------------------------
    // 9. תמונת מצב — הקשר, לא טענה
    // ------------------------------------------------------------
    const { rows: vers } = await c.query(`
      SELECT COALESCE(a.agent_version, '—') AS v, count(*)::int AS n
        FROM sites s LEFT JOIN alive a ON a.site_id = s.id
       GROUP BY 1 ORDER BY n DESC`);
    console.log("\nגרסאות בצי: " + vers.map((r) => `${r.v}×${r.n}`).join("  "));

    const { rows: silent } = await c.query(`
      SELECT s.code FROM sites s
       LEFT JOIN alive a ON a.site_id = s.id WHERE a.site_id IS NULL
       ORDER BY s.code`);
    console.log(`אתרים בלי פעימה כלל: ${silent.length}` +
      (silent.length ? "  " + silent.map((r) => r.code).join(", ") : ""));

    console.log("\nכיסוי לפי אתר (זמינות על כמה מהשבוע באמת נמדד):");
    for (const r of cov) {
      console.log(`  ${r.code}  ${String(r.uptime_percent).padStart(6)}%  ` +
        `כיסוי ${String(r.coverage_pct).padStart(5)}%  ` +
        `(נמדד ${Number(r.measured_hours).toFixed(1)}ש · ללא תקשורת ${Number(r.no_comm_hours).toFixed(1)}ש)`);
    }
  } finally {
    c.release();
    await db.pool.end();
  }

  console.log("");
  if (failures) console.log(`❌ ${failures} כשלי אמינות`);
  if (warnings) console.log(`⚠️  ${warnings} אזהרות (נכון לפי ההגדרה, מטעה למי שקורא)`);
  if (!failures && !warnings) console.log("✅ הכול נאמן");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
