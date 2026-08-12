// tools/parity-activity.js — שער האימוץ ללוג הפעילות בקריאה ישירה.
//
//   node --env-file=.env tools/parity-activity.js
//
// ============================================================
// מה באמת מסוכן כאן — וזה לא החישוב
// ============================================================
// שתי הזרועות מריצות את **אותה פונקציה**: buildActivityLog מ-shared/timeline.mjs.
// אין פורט ואין תרגום, ולכן אין סיכון שהחישוב יסטה — זה לא "שני מימושים
// שצריך להשוות" אלא אותו קוד בשני זמני ריצה.
//
// מה שכן שונה הוא **מי שלף את השורות ובאיזה מבנה**:
//
//     השרת     — JOIN, ולכן site_name חוזר כעמודה שטוחה
//     PostgREST — מחזיר את הטבלה המקושרת כאובייקט מקונן: sites.site_name
//
// buildActivityLog קוראת את השטוח. אם ההשטחה ב-activityDirect.js תישבר, שם
// האתר ייעלם מהלוג המצרף **בשקט** — בלי שגיאה ובלי שורה חסרה, רק עמודה
// ריקה שנראית כמו נתון שלא הגיע. זה מה שנבדק כאן.
//
// ============================================================
// ⚠️ צילום מצב אחד — ולמה ההקפאה הראשונה לא הספיקה
// ============================================================
// הגרסה הראשונה השוותה שליפה מול שליפה, ונפלה: 803 מול 802. לא באג —
// **הודעה נקלטה בין שתי השאילתות.**
//
// הניסיון הראשון לתקן היה להקפיא את קצה החלון שתי דקות אחורה, ו**נמדד
// שהוא לא מספיק**: HiveMQ מחזיק תור כשהשרת למטה ומוסר אותו עם **החותמים
// המקוריים** (נמדד בפרויקט הזה: 15 שעות, 240 הודעות). כלומר שורה שנכתבת
// עכשיו יכולה לשאת occurred_at מלפני שעות ולנחות בתוך חלון שכבר נשלף.
// שום הקפאת קצה לא סוגרת את זה.
//
// REPEATABLE READ מבטיח ששתי השליפות רואות בדיוק אותן שורות, ולכן כל הבדל
// שנותר הוא הבדל בקוד. שער שנצבע אדום כי הנתונים זזו הוא שער שלומדים
// להתעלם ממנו.

const db = require("../db/db");
const { buildActivityLog } = require("../../shared/timeline.mjs");
const { resolvePeriod } = require("../api/periods");

let checks = 0, failures = 0;
const fails = [];

function compare(label, server, direct) {
  checks++;
  const a = JSON.stringify(server ?? null);
  const b = JSON.stringify(direct ?? null);
  if (a === b) return;
  failures++;
  fails.push(`${label}:\n      שרת = ${a.slice(0, 200)}\n      ישיר = ${b.slice(0, 200)}`);
}

/**
 * שני מבני השורות, מצילום מצב אחד.
 *   srv — כפי שהשרת שולף: JOIN, site_name שטוח
 *   pg  — כפי ש-PostgREST מחזיר: sites מקונן
 */
async function snapshot(from, to) {
  // db.transaction אינו מוסר client — הוא עוקב אחריו דרך AsyncLocalStorage,
  // ולכן db.prepare שבתוכו רץ אוטומטית על אותו חיבור ואותה טרנזקציה.
  return db.transaction(async () => {
    // ⚠️ בלי זה הבידוד הוא READ COMMITTED, ואז **כל שאילתה מקבלת צילום משלה**
    // — כלומר שלוש השליפות עדיין יכולות לראות נתונים שונים, וזה בדיוק המרוץ
    // שהשער הזה בא לסלק. REPEATABLE READ מקבע צילום אחד לכל הטרנזקציה.
    await db.prepare("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ").run();

    // ⚠️ בטור ולא ב-Promise.all: לחיבור Postgres יש ערוץ פרוטוקול אחד, ו-pg
    // נופל על "client is already executing a query" (ראה runOn ב-db.js).
    const ops = await db.prepare(
      `SELECT o.site_id, o.start_end, o.entry_exit, o.card_number, o.is_anomaly,
              o.superseded_by, o.state, o.occurred_at, s.site_name
         FROM operations o JOIN sites s ON s.id = o.site_id
        WHERE o.occurred_at >= ? AND o.occurred_at < ?
        ORDER BY o.occurred_at DESC`
    ).all(from, to);

    const states = await db.prepare(
      `SELECT h.site_id, h.status, h.started_at, h.ended_at, s.site_name
         FROM status_history h JOIN sites s ON s.id = h.site_id
        WHERE h.started_at >= ? AND h.started_at < ?
        ORDER BY h.started_at DESC`
    ).all(from, to);

    const maint = await db.prepare(
      `SELECT w.site_id, w.set_by_name, w.set_by_role, w.reason, w.started_at,
              w.duration_hours, w.expires_at, w.cancelled_at, s.site_name
         FROM maintenance_windows w JOIN sites s ON s.id = w.site_id
        WHERE w.started_at >= ? AND w.started_at < ?
        ORDER BY w.started_at DESC`
    ).all(from, to);

    // אותן שורות בדיוק, בקינון של PostgREST. הקינון נבנה מהשורה שכבר נשלפה
    // ולא בשאילתה שנייה — אחרת שוב שתי קריאות ושוב אותו מרוץ.
    const nest = (rows) => rows.map(({ site_name, ...rest }) => ({
      ...rest, sites: { site_name },
    }));

    return {
      srv: { ops, states, maint },
      pg: { ops: nest(ops), states: nest(states), maint: nest(maint) },
    };
  });
}

// אותה השטחה בדיוק כמו ב-activityDirect.js.
const flat = (rows) => (rows || []).map((r) => ({ ...r, site_name: r.sites?.site_name ?? null }));

const FILTERS = ["all", "operation", "error", "maintenance", "entry", "exit", "no_comm", "status"];

(async () => {
  await db.init();

  const site = await db.prepare("SELECT id, code FROM sites ORDER BY code LIMIT 1").get();

  for (const period of ["week", "month"]) {
    const { range } = resolvePeriod(period);
    const to = new Date().toISOString();
    console.log(`\n=== לוג הפעילות — ${period} ===`);

    const { srv, pg } = await snapshot(range.from, to);
    const pgFlat = { ops: flat(pg.ops), states: flat(pg.states), maint: flat(pg.maint) };

    const run = (rows, opts) => buildActivityLog({
      ops: rows.ops, states: rows.states, maint: rows.maint,
      limit: 300, offset: 0, filter: "all", card: null, ...opts,
    });

    for (const filter of FILTERS) {
      const a = run(srv, { filter });
      const b = run(pgFlat, { filter });
      compare(`${period}/${filter}.total`, a.total, b.total);
      compare(`${period}/${filter}.counts`, a.counts, b.counts);
      compare(`${period}/${filter}.entries`, a.entries, b.entries);
    }

    // דפדוף — העמוד השני חייב להיות זהה גם הוא
    compare(`${period}/עמוד2`, run(srv, { offset: 300 }).entries, run(pgFlat, { offset: 300 }).entries);

    // חיפוש כרטיס — מצמצם גם את המונים, ולכן נבדק בנפרד
    compare(`${period}/כרטיס`, run(srv, { card: "7" }).counts, run(pgFlat, { card: "7" }).counts);

    // אתר בודד — בדפדפן זה מסלול שליפה אחר (eq על site_id)
    const only = (r) => ({
      ops: r.ops.filter((x) => x.site_id === site.id),
      states: r.states.filter((x) => x.site_id === site.id),
      maint: r.maint.filter((x) => x.site_id === site.id),
    });
    compare(`${period}/אתר ${site.code}`, run(only(srv), {}).entries, run(only(pgFlat), {}).entries);

    console.log(`  ${srv.ops.length} פעולות · ${srv.states.length} מצבים · ${srv.maint.length} תחזוקות`);
  }

  console.log(`\n${"=".repeat(60)}`);
  if (failures) {
    console.log(`❌ ${failures} הבדלים מתוך ${checks} השוואות\n`);
    fails.slice(0, 10).forEach((f) => console.log("   " + f));
    process.exit(1);
  }
  console.log(`✅ שתי הזרועות זהות — ${checks} השוואות, 0 הבדלים`);
  process.exit(0);
})().catch((e) => { console.error("parity-activity: נפל —", e.message); process.exit(1); });
