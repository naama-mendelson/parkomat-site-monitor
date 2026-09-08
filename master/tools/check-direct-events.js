// check-direct-events — המסלול הישיר כותב אירועים, ובאותו מבנה.
//
// ============================================================
// ⚠️ למה השער הזה קיים: מסך שלא זז
// ============================================================
// `events` הוא **חוזה האירועים** של המערכת (כלל 8 ב-CLAUDE.md): ה-SSE
// ו-Realtime קוראים ממנו, ומשם מגיע גם ה-replay אחרי שטאב התנתק.
// המסלול של master כותב שורה בכל שינוי (`bus.publish`). המסלול הישיר
// **לא כתב כלל**.
//
// ⚠️ **נמדד ב-08/09/2026:** שלושה משינויי המצב של 2438 היו ב-
// `status_history` בלי שורת `events`, מול 5 מתוך 5 עם באתר שעל MQTT.
// הנתונים נכונים — אבל הכרטיס לא זז עד רענון, וזה נראה בדיוק כמו אתר
// תקוע. עם אתר אחד זה מטרד; כשעשרה יעברו, זה חצי מהמסך.
//
// ⚠️ **והטענה החשובה כאן היא "אותו מבנה", לא "יש שורה".** הדשבורד קורא
// את אותם שדות משני המקורות. שדה שחסר רק בצד אחד מופיע כערך ריק על
// הכרטיס באתרים מסוימים בלבד — הבדל שאי אפשר לראות בלי להשוות שדה מול
// שדה, וזה מה שנעשה כאן מול אירוע אמיתי שנכתב על ידי master.
//
//   node --env-file=.env tools/check-direct-events.js

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

    // ⚠️ הצד השני של ההשוואה: אירוע אמיתי שנכתב על ידי master, מאתר
    // שעל MQTT. לא רשימת שדות שאני מקליד — רשימה שאי אפשר לטעות בה.
    const ref = async (type) => (await c.query(
      `SELECT payload FROM events
        WHERE type = $1 AND site_code <> $2 ORDER BY id DESC LIMIT 1`, [type, SITE])).rows[0];

    const refState = await ref("state");
    const refOp = await ref("operation");
    check("נמצא אירוע ייחוס שנכתב על ידי master", !!refState && !!refOp);
    if (!refState || !refOp) return;

    const statusOf = async () =>
      (await c.query("SELECT status FROM sites WHERE id = $1", [agent.id])).rows[0].status;
    const countEvents = async () => Number((await c.query(
      "SELECT count(*)::int AS n FROM events WHERE site_code = $1", [SITE])).rows[0].n);
    const before = await countEvents();

    // ⚠️ **הגבול הזה הוא כל הבדיקה.** הגרסה הראשונה קראה "האירוע
    // האחרון של האתר", ולאתר יש אירועים ישנים שנכתבו בזמנו
    // דרך master — כך שמוטציה שביטלה את הכתיבה לגמרי **עברה בשקט**:
    // השער מצא אירוע מ-03/09 והיה מרוצה. אותה מלכודת היעדר
    // בדיוק שהפילה היום את כלי מחיקת הצוואות, פעמיים.
    const maxId = Number((await c.query(
      "SELECT COALESCE(MAX(id),0)::bigint AS n FROM events")).rows[0].n);

    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id', $1, true)", [agent.uid]);

    // ⚠️ **לא `operating`**: התפעול שבהמשך מסנכרן ל-`operating` רק אם
    // הסטטוס **שונה** ממנו. הגרסה הקודמת העבירה ל-`operating`
    // מראש, ואז לא היה מה לסנכרן — כלומר התרחיש לא נוצר.
    const other = agent.status === "error" ? "ready" : "error";
    await c.query("SELECT app.ingest_state($1, $2, $3, NULL)", [agent.id, other, iso()]);

    const { rows: [gotState] } = await c.query(
      `SELECT payload FROM events WHERE site_code = $1 AND type = 'state'
         AND id > $2 ORDER BY id DESC LIMIT 1`, [SITE, maxId]);
    check("שינוי מצב במסלול הישיר יוצר אירוע", !!gotState);

    // ⚠️ **גבול שני, והוא נולד ממוטציה שעברה בשקט.** בדיקת
    // המצב שלמעלה כבר יצרה אירוע עם `newStatus=operating`, והבדיקה
    // של הזוג מצאה **אותו** — כך שהסרת הכתיבה מהסנכרון
    // לא שינתה דבר בתוצאה. שלוש פעמים היום, אותה מלכודת היעדר.
    // משאירים את האתר ב-`ready`, כדי שהתפעול יהיה שינוי אמיתי.
    await c.query("SELECT app.ingest_state($1, 'ready', $2, NULL)", [agent.id, iso()]);

    const maxId2 = Number((await c.query(
      "SELECT COALESCE(MAX(id),0)::bigint AS n FROM events")).rows[0].n);

    await c.query(`SELECT app.ingest_operation($1,'start','entry','gate-ev','operating',$2,$2,$3)`,
      [agent.id, iso(), 999]);
    const { rows: [gotOp] } = await c.query(
      `SELECT payload FROM events WHERE site_code = $1 AND type = 'operation'
         AND id > $2 ORDER BY id DESC LIMIT 1`, [SITE, maxId]);
    check("תפעול במסלול הישיר יוצר אירוע", !!gotOp);

    // ============================================================
    // ⚠️ ותפעול שמזיז את הסטטוס חייב לכתוב **גם** אירוע מצב
    // ============================================================
    // נמדד על התפעול הראשון שעבר במסלול הישיר: נוצרה שורת
    // `operation` אבל לא שורת `state`, בעוד שבאתר על MQTT כל תפעול
    // מלווה בזוג. הכרטיס עבר ל"בפעולה" רק ברענון.
    const { rows: [pairState] } = await c.query(
      `SELECT payload FROM events WHERE site_code = $1 AND type = 'state'
         AND id > $2 ORDER BY id DESC LIMIT 1`, [SITE, maxId2]);
    check("⚠️ תפעול שמזיז את הסטטוס כותב גם אירוע מצב",
      !!pairState && pairState.payload.newStatus === "operating",
      pairState ? `newStatus=${pairState.payload.newStatus}` : "אין אירוע מצב");

    // ⚠️ השוואת **קבוצת השדות**, לא הערכים: הערכים שונים בין אתרים, המבנה
    // חייב להיות זהה. חסר או עודף — שניהם נכשלים.
    const keys = (o) => Object.keys(o || {}).sort().join(",");
    if (gotState) {
      check("⚠️ מבנה אירוע המצב זהה לזה של master",
        keys(gotState.payload) === keys(refState.payload),
        `ישיר=[${keys(gotState.payload)}] master=[${keys(refState.payload)}]`);
    }
    if (gotOp) {
      check("⚠️ מבנה אירוע התפעול זהה לזה של master",
        keys(gotOp.payload) === keys(refOp.payload),
        `ישיר=[${keys(gotOp.payload)}] master=[${keys(refOp.payload)}]`);
    }

    // ⚠️ בלי זה השער עובר גם על פונקציה שכותבת אירוע בכל קריאה, כולל
    // כשלא השתנה דבר — כלומר 1,440 שורות ביום לכל אתר בטבלה שנקראת
    // ב-Realtime, ורעש על המסך במקום מידע.
    // ⚠️ שולחים את המצב **הנוכחי**, ולא קבוע מראש: התפעול
    // שלמעלה הזיז את הסטטוס, וערך שנקבע לפניו הופך לשינוי אמיתי.
    const cur = await statusOf();
    const n1 = await countEvents();
    await c.query("SELECT app.ingest_state($1, $2, $3, NULL)", [agent.id, cur, iso()]);
    const n2 = await countEvents();
    check("מצב שלא השתנה אינו יוצר אירוע", n1 === n2, `${n1} → ${n2}`);

    await c.query("ROLLBACK");
    check("הייצור חזר בדיוק למה שהיה", (await countEvents()) === before);
  } finally {
    c.release();
  }
}

main()
  .then(() => console.log(failures ? `\n❌ ${failures} כשלים` : "\n✅ הכל עבר"))
  .catch((e) => { console.error("❌", e.message); failures++; })
  .finally(async () => { await db.close(); process.exit(failures ? 1 : 0); });
