// check-direct-drops — הודעה שנדחתה במסלול הישיר משאירה עקבה.
//
// ============================================================
// ⚠️ למה השער הזה קיים: אפס מתוך 1,055
// ============================================================
// `ingest_drops` היא הטבלה היחידה שעונה על *"למה ההודעה הזו לא הגיעה"*.
// `db/ingest.postgres.sql` מזהיר בשוליו במפורש שהפונקציות מחזירות את
// הסיבה ב-`outcome` ומשאירות לקורא לרשום — והקורא, `public.ingest_batch`,
// רשם רק `unknown_kind`.
//
// ⚠️ **נמדד ב-08/09/2026 ולא הוסק מקריאת קוד:** מכל 1,055 השורות בטבלה,
// **אפס** נשאו topic שמתחיל ב-`direct/`. אתר 2438 היה על המסלול הישיר
// בלבד מאז 06/09, ובאותו יום התקבלה אצלו הודעת מצב-ללא-שינוי שבמסלול
// MQTT הייתה מייצרת שורת `state_no_change`.
//
// המשמעות אינה תיאורטית: ככל שאתרים עוברים, הטבלה מתרוקנת — לא מפני
// שפחות נזרק, אלא מפני שהזריקות מפסיקות להירשם. וזה בדיוק סוג הכשל
// שמתגלה חצי שנה מאוחר מדי, כשכבר אין מה לשחזר.
//
// ============================================================
// ⚠️ הבדיקה עוברת במסלול ההרשאות האמיתי, ואינה משאירה שארית
// ============================================================
// היא מתחזה לסוכן דרך `app.user_id` — הנפילה-לאחור של
// `app.current_actor()`, שקיימת בדיוק כדי שהמדיניות תרוץ גם על Postgres
// שאינו Supabase (כלל 2 ב-CLAUDE.md). כלומר `app.agent_site_id()` גוזרת
// את האתר בדיוק כפי שהיא עושה בייצור, ולא נעקפת.
//
// הכול בטרנזקציה שמתגלגלת חזרה, וההשוואה שלפני/אחרי היא חלק מהשער —
// אותה משמעת ש-check-no-residue אוכף.
//
//   node --env-file=.env tools/check-direct-drops.js

const db = require("../db/db");

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? "✅ " : "❌ ") + label + (detail ? `   ${detail}` : ""));
  if (!ok) failures++;
}

const SITE = "2438";

async function main() {
  const client = await db.pool.connect();
  try {
    const { rows: [agent] } = await client.query(`
      SELECT u.supabase_uid::text AS uid, u.site_id, s.status
        FROM app_users u JOIN sites s ON s.id = u.site_id
       WHERE s.code = $1 AND u.role = 'agent' AND u.is_active`, [SITE]);
    check(`נמצאה זהות סוכן לאתר ${SITE}`, !!agent);
    if (!agent) return;

    const countDirect = async (c) => Number((await c.query(
      "SELECT count(*)::int AS n FROM ingest_drops WHERE topic LIKE 'direct/%'")).rows[0].n);

    const before = await countDirect(client);

    await client.query("BEGIN");
    // ⚠️ רק שורות שנוצרו **בתוך** הבדיקה: אתרים אמיתיים כותבים לטבלה כל הזמן, ו"5 האחרונות" תפסו
    // ב-12/10 שורה אמיתית של 2438 מדקה לפני החלת השינוי — ודיווחו עליה כאילו הבדיקה יצרה אותה.
    const { rows: [{ m: fromId }] } = await client.query("SELECT COALESCE(max(id), 0) AS m FROM ingest_drops");
    await client.query("SELECT set_config('app.user_id', $1, true)", [agent.uid]);

    // ------------------------------------------------------------
    // 1. מצב שאינו משנה דבר
    // ------------------------------------------------------------
    // ⚠️ **זו ההודעה שנצפתה בשטח.** הפעלה מחדש של הסוכן משדרת את המצב
    // הנוכחי, וכשהוא זהה לזה שבמסד היא נדחית — ובמסלול MQTT זה נרשם.
    const now = () => new Date().toISOString();
    const st = await client.query(
      "SELECT * FROM public.ingest_batch($1::jsonb, $2)",
      [JSON.stringify([{ kind: "state", status: agent.status, occurred_at: now() }]), "gate"]);
    check("מצב זהה מוחזר כ-no_change", st.rows[0]?.outcome === "no_change",
      `outcome=${st.rows[0]?.outcome}`);

    // ------------------------------------------------------------
    // 2. תפעול כפול
    // ------------------------------------------------------------
    // ⚠️ **שווה יותר מהמצב.** תפעול הוא חד-פעמי — הגלאי מקדם את עצמו
    // מיד — ולכן כפילות פירושה שהסוכן שידר שוב אחרי שלא קיבל אישור.
    // זו עדות לגמגום רשת שאין לה שום ביטוי אחר בשום מקום.
    const op = {
      kind: "operation", start_end: "start", entry_exit: "entry",
      card: "gate-check", state: "operating", occurred_at: now(),
    };
    const first = await client.query(
      "SELECT * FROM public.ingest_batch($1::jsonb, $2)", [JSON.stringify([op]), "gate"]);
    const second = await client.query(
      "SELECT * FROM public.ingest_batch($1::jsonb, $2)", [JSON.stringify([op]), "gate"]);
    check("תפעול ראשון נקלט", first.rows[0]?.outcome === "applied",
      `outcome=${first.rows[0]?.outcome}`);
    check("⚠️ שידור חוזר של אותו תפעול אינו נכפל", second.rows[0]?.outcome === "duplicate",
      `outcome=${second.rows[0]?.outcome}`);

    // ------------------------------------------------------------
    // 3. מה נרשם
    // ------------------------------------------------------------
    const { rows: drops } = await client.query(
      `SELECT reason, topic, kind, detail FROM ingest_drops
        WHERE topic LIKE 'direct/%' AND id > $1 ORDER BY id DESC`, [fromId]);

    const noChange = drops.find((d) => d.reason === "state_no_change");
    const dup = drops.find((d) => d.reason === "operation_duplicate");

    // ⚠️ **"ללא שינוי" כבר אינו נרשם** (בעלת המוצר, 12/10/2026: "חבל על המקום") — זו אינה
    // דחייה, והיא נולדה כמעט בכל תפעול (85% מהטבלה). התוצאה עדיין חוזרת לסוכן (בדיקה 1).
    check("⚠️ מצב ללא שינוי — לא נרשם", !noChange, noChange ? `נרשם: ${noChange.detail}` : "");
    check("תפעול כפול נרשם", !!dup);

    // ⚠️ ה-topic מסומן direct/ — מי שיחקור בעוד חצי שנה חייב לדעת מאיזה
    // מסלול הגיעה השורה, אחרת שתי מערכות שונות נראות כאחת.
    check("ה-topic מסמן את המסלול", dup?.topic === `direct/${SITE}/operation`, dup?.topic);

    // ⚠️ בלי הפירוט השורה אומרת "נדחה" ולא אומרת למה.
    check("הפירוט נושא את התפעול והזמן",
      !!dup?.detail && dup.detail.includes("card=") && dup.detail.includes("occurredAt="),
      dup?.detail);

    await client.query("ROLLBACK");

    const after = await countDirect(client);
    check("הייצור חזר בדיוק למה שהיה", before === after, `לפני ${before}, אחרי ${after}`);
  } finally {
    client.release();
  }
}

main()
  .then(() => console.log(failures ? `\n❌ ${failures} כשלים` : "\n✅ הכל עבר"))
  .catch((e) => { console.error("❌", e.message); failures++; })
  .finally(async () => { await db.close(); process.exit(failures ? 1 : 0); });
