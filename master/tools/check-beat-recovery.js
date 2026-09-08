// check-beat-recovery — פעימה מבטלת נתק. בלי זה אין דרך חזרה.
//
// ============================================================
// ⚠️ למה השער הזה קיים: אתר חי שנראה מת, לצמיתות
// ============================================================
// `app.mark_silent_agents` **רק מסמן**. עד 08/09/2026 לא היה בשום מקום
// הצד השני — שום דבר לא ביטל `no_comm` כשהפעימות חזרו. הביטול קרה רק
// כשהגיעה **הודעת מצב**, והסוכן משדר רק על שינוי MODE, שבאתר שקט עשוי
// לא לקרות ימים.
//
// ⚠️ **נמדד באתר 2438:** הוא סומן `no_comm` ב-08:22 מצוואת MQTT ישנה,
// ונשאר כך בזמן שפעם כל 60.4 שניות בדיוק, בלי להחסיר אף פעימה. המסך
// אמר "מנותק" על אתר שהוכח חי.
//
// ============================================================
// ⚠️ למה החזרת המצב הקודם אינה ניחוש
// ============================================================
// שתי תכונות של הסוכן, ושתיהן נבדקו בקוד:
//
//   1. נתיב כשל קריאת ה-PLC מסתיים ב-`continue` **לפני** שלב הפעימה.
//      כלומר **פעימה מוכיחה שקריאת הבקר הצליחה** בשנייה האחרונה — לא
//      רק שהתהליך חי.
//   2. הסוכן משדר רק על שינוי. אם לא שידר — המצב לא השתנה.
//
// שתיהן יחד: המצב שקדם ל-`no_comm` הוא המצב עכשיו.
//
// הכול בטרנזקציה שמתגלגלת חזרה, בהתחזות לסוכן דרך ה-GUC `app.user_id` —
// אותו מסלול הרשאות בדיוק, ולא עקיפה שלו.
//
//   node --env-file=.env tools/check-beat-recovery.js

const db = require("../db/db");

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? "✅ " : "❌ ") + label + (detail ? `   ${detail}` : ""));
  if (!ok) failures++;
}

const SITE = "2438";
const iso = () => new Date().toISOString();

async function main() {
  const c = await db.pool.connect();
  try {
    const { rows: [agent] } = await c.query(`
      SELECT u.supabase_uid::text AS uid, s.id, s.status
        FROM app_users u JOIN sites s ON s.id = u.site_id
       WHERE s.code = $1 AND u.role = 'agent' AND u.is_active`, [SITE]);
    check(`נמצאה זהות סוכן לאתר ${SITE}`, !!agent);
    if (!agent) return;

    const statusOf = async () =>
      (await c.query("SELECT status FROM sites WHERE id = $1", [agent.id])).rows[0].status;
    const beat = () =>
      c.query("SELECT * FROM public.ingest_batch('[]'::jsonb, $1)", ["gate"]);
    const openNoComm = async () =>
      Number((await c.query(
        `SELECT count(*)::int AS n FROM status_history
          WHERE site_id = $1 AND status = 'no_comm' AND ended_at IS NULL`,
        [agent.id])).rows[0].n);

    const before = { status: agent.status, open: await openNoComm() };

    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id', $1, true)", [agent.uid]);

    // ============================================================
    // ⚠️ ההקמה נכתבת ישירות, ולא דרך ingest_state — וזו מדידה
    // ============================================================
    // שלושה ניסיונות להקים את התרחיש דרך `ingest_state` נפלו, ובכולם
    // **התרחיש לא נוצר** בזמן שחלק מהטענות עברו בירוק מסיבה שאינה
    // הסיבה. הדפסת ה-outcome נתנה את התשובה:
    //
    //     error=applied  no_comm=backfill
    //
    // ⚠️ **`now()` ב-Postgres הוא זמן ה*טרנזקציה*, לא זמן ההצהרה.** השער
    // כולו רץ בטרנזקציה אחת (כדי שלא תישאר שארית בייצור), ו-`ingest_state`
    // חותם `no_comm` ב-`date_trunc('second', now())` — כלומר **אותה שנייה
    // בדיוק** בכל קריאה. שומר ה-backfill משווה מול `started_at` של המקטע
    // הפתוח, ולכן כל נתק שני והלאה נדחה. אין המתנה שתעזור: השעון קפוא.
    //
    // המסקנה הכללית: **אי אפשר לבנות רצף מעברי מצב בתוך טרנזקציה אחת.**
    // אז ההקמה כותבת את השורות ישירות — זו יצירת נתוני פתיחה, לא הדבר
    // הנבדק — והנבדק נשאר מה שהיה אמור להיבדק: הפעימה.
    async function putIntoNoCommAfter(status) {
      await c.query(
        "UPDATE status_history SET ended_at = now()::text WHERE site_id = $1 AND ended_at IS NULL",
        [agent.id]);
      await c.query(`
        INSERT INTO status_history (site_id, status, started_at, ended_at)
        VALUES ($1, $2, to_char(now() - interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                        to_char(now() - interval '1 hour',  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
        [agent.id, status]);
      await c.query(`
        INSERT INTO status_history (site_id, status, started_at, ended_at)
        VALUES ($1, 'no_comm', to_char(now() - interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NULL)`,
        [agent.id]);
      await c.query(
        "UPDATE sites SET status = 'no_comm', last_seen = $2 WHERE id = $1",
        [agent.id, new Date(Date.now() - 3600 * 1000).toISOString()]);
      return statusOf();
    }

    // ------------------------------------------------------------
    // 1. המקרה שנמדד בשטח
    // ------------------------------------------------------------
    check("הוקם מצב הפתיחה: האתר מסומן no_comm",
      (await putIntoNoCommAfter("ready")) === "no_comm");

    await beat();
    check("⚠️ פעימה ריקה מחזירה את האתר ל-ready", (await statusOf()) === "ready");

    // ⚠️ בלי זה החזרה הייתה משאירה מקטע נתק פתוח לנצח — צ'יפ ירוק על
    // המסך, וזמינות שאינה יודעת שהאתר היה מנותק.
    check("מקטע הנתק נסגר, לא נשאר פתוח", (await openNoComm()) === 0);

    // ------------------------------------------------------------
    // 2. תקלה נשמרת — לא מוחזרים תמיד ל-ready
    // ------------------------------------------------------------
    // ⚠️ החזרה קבועה ל-`ready` הייתה **מסתירה תקלה אמיתית**: מכונה
    // שהבקר דיווח עליה MODE=5 נשארת שבורה גם אחרי נתק רשת, והסוכן לא
    // ישדר שוב כי שום דבר לא השתנה.
    check("הוקם: אתר שהיה בתקלה ואז נותק",
      (await putIntoNoCommAfter("error")) === "no_comm");
    await beat();
    check("⚠️ אתר שהיה בתקלה חוזר לתקלה, לא ל-ready", (await statusOf()) === "error");

    // ------------------------------------------------------------
    // 3. תחזוקה אינה מוקמת מחדש
    // ------------------------------------------------------------
    // ⚠️ חלון תחזוקה עשוי היה לפוג בינתיים, והקמה מחדש שלו הייתה משתיקה
    // אתר שאיש לא ביקש להשתיק — ומוציאה אותו ממכנה הזמינות לגמרי.
    check("הוקם: אתר שהיה בתחזוקה ואז נותק",
      (await putIntoNoCommAfter("maintenance")) === "no_comm");
    await beat();
    check("⚠️ תחזוקה אינה מוקמת מחדש מפעימה", (await statusOf()) !== "maintenance",
      `התקבל ${await statusOf()}`);

    // ------------------------------------------------------------
    // 4. אתר תקין אינו נוגע בכלום
    // ------------------------------------------------------------
    // ⚠️ בלי זה הבדיקה ריקה: פונקציה שכותבת מצב בכל פעימה הייתה עוברת
    // את שלושת הסעיפים שמעל, ומייצרת 1,440 כתיבות ביום לכל אתר.
    // ⚠️ **ההקמה בנויה כך שהמוטציה תהיה נראית:** המצב
    // האחרון בהיסטוריה הוא `error`, והאתר עצמו `ready`. החזרה
    // שרצה בכל פעימה הייתה מושכת אותו חזרה ל-`error`.
    // בלי ההפרש הזה הבדיקה עוברת גם על הקוד השבור — וכך היה.
    await c.query(
      "UPDATE status_history SET ended_at = now()::text WHERE site_id = $1 AND ended_at IS NULL",
      [agent.id]);
    await c.query(`
      INSERT INTO status_history (site_id, status, started_at, ended_at)
      VALUES ($1, 'error', to_char(now() - interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NULL)`,
      [agent.id]);
    await c.query("UPDATE sites SET status = 'ready' WHERE id = $1", [agent.id]);

    const seenBefore = (await c.query(
      "SELECT last_seen FROM sites WHERE id = $1", [agent.id])).rows[0].last_seen;
    const rowsBefore = Number((await c.query(
      "SELECT count(*)::int AS n FROM status_history WHERE site_id = $1", [agent.id])).rows[0].n);

    await beat();
    await beat();

    const seenAfter = (await c.query(
      "SELECT last_seen FROM sites WHERE id = $1", [agent.id])).rows[0].last_seen;
    const rowsAfter = Number((await c.query(
      "SELECT count(*)::int AS n FROM status_history WHERE site_id = $1", [agent.id])).rows[0].n);

    check("פעימה באתר תקין אינה כותבת מקטע", rowsBefore === rowsAfter,
      rowsBefore + " -> " + rowsAfter);

    check("⚠️ ואינה מושכת את האתר למצב האחרון בהיסטוריה", (await statusOf()) === "ready",
      `התקבל ${await statusOf()}`);

    // ⚠️ **ואסור לה להזיז את `last_seen`** — זו הבדיקה שנולדה
    // ממוטציה שעברה בשקט: הגרסה הקודמת ספרה שורות בלבד,
    // והחזרה שרצה בכל פעימה מחזירה `no_change` ואינה כותבת מקטע —
    // אבל **כן** מעדכנת את `last_seen`.
    //
    // וזה הורס: `last_seen` אומר "הגיעה מהאתר הודעה", ועליו
    // נשענים שומר הצוואה (90 שניות) וגלאי האתר השקט. סוכן
    // שפועם ולעולם אינו מדווח היה נראה "נשמע זה עתה" לנצח.
    check("⚠️ ואינה מזיזה את last_seen", seenBefore === seenAfter,
      `${seenBefore} -> ${seenAfter}`);

    await c.query("ROLLBACK");

    const after = { status: await statusOf(), open: await openNoComm() };
    check("הייצור חזר בדיוק למה שהיה",
      before.status === after.status && before.open === after.open,
      `${before.status}/${before.open} → ${after.status}/${after.open}`);
  } finally {
    c.release();
  }
}

main()
  .then(() => console.log(failures ? `\n❌ ${failures} כשלים` : "\n✅ הכל עבר"))
  .catch((e) => { console.error("❌", e.message); failures++; })
  .finally(async () => { await db.close(); process.exit(failures ? 1 : 0); });
