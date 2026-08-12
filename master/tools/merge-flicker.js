// tools/merge-flicker.js — מאחד פעולה שנקטעה בריצוד MODE ומיד נפתחה מחדש.
//
//   node --env-file=.env tools/merge-flicker.js          ← הרצה יבשה (ברירת מחדל)
//   node --env-file=.env tools/merge-flicker.js --apply  ← כותב באמת
//
// ============================================================
// מה זה, ואיך זה נמצא
// ============================================================
// חקירה של חוסר איזון בין כניסות ליציאות הובילה לרצף הזה (אתר 2438, כרטיס 7):
//
//     07-31 11:10:59 → 11:15:45   יציאה
//     07-31 11:16:05 → 11:22:11   יציאה   ← **20 שניות אחרי** הקודמת
//
// ורצף כזה (אתר 1343, כרטיס 6):
//
//     05:56:16  יציאה/סגירה
//     05:56:17  יציאה/פתיחה      ← שנייה אחת
//
// הסוכן מזהה פעולה לפי **שינוי** ב-MODE. כשהרגיסטר יוצא ממצב הפעולה וחוזר
// אליו תוך שניות — ריצוד — הוא סוגר פעולה ופותח חדשה. **מעבר פיזי אחד נרשם
// כשתיים.**
//
// ============================================================
// ⚠️ וההטיה אינה סימטרית — זה מה שהופך אותה לבאג ולא לרעש
// ============================================================
// נמדד על כל הנתונים:
//
//     חלון    כניסות   יציאות   הטיה נטו
//      5s        5       15        +10
//     15s       12       21         +9
//     60s       29       31         +2
//    180s       37       41         +4
//
// הריצוד פוגע ביציאות פי שניים מבכניסות, ולכן הוא **מנפח את היציאות בשיטתיות**
// — בדיוק התסמין שנראה על המסך: תפוסה שלילית, וכרטיס עם 10 יציאות מול 7
// כניסות.
//
// ============================================================
// למה 15 שניות, ולא יותר
// ============================================================
// זה לא מספר שנבחר בנוחות. מעבר ל-15 שניות **ההטיה מתהפכת**: בטווח 15–60
// שניות יש 17 כניסות מול 10 יציאות. כלומר מה שקורה שם הוא תופעה אחרת —
// פעולות אמיתיות שחוזרות — ולא ריצוד. חלון רחב יותר היה מוחק פעולות אמיתיות.
//
// ⚠️ והוא רחוק מ-OP_PAIR_TOLERANCE_SECONDS (5 שניות, הצמדת state לפעולה):
// שני הכללים לא נוגעים זה בזה.
//
// ============================================================
// אותו מנגנון בדיוק כמו merge-retries
// ============================================================
// הכלל זהה — **מעבר פיזי אחד = פעולה אחת** — ולכן גם העמודה זהה:
// superseded_by. הפעולה הראשונה מצביעה על השנייה ומוחרגת מכל מדד; השורה
// עצמה נשארת, כי היא עדיין תיעוד של מה שהבקר דיווח.
//
// ⚠️ **זה מטפל בסימפטום.** השורש הוא בבקר או בסוכן — רגיסטר MODE שמרצד.
// תיקון שם היה מונע את הרישום הכפול מלכתחילה, אבל הוא דורש עדכון גרסה
// ב-12 אתרים. הקליטה מטפלת בזה מעכשיו (operation-handler), כך שהכלי הזה
// נדרש רק להיסטוריה.

const db = require("../db/db");

const APPLY = process.argv.includes("--apply");

// ⚠️ משוכפל במכוון ב-ingestion/operation-handler.js — ראה merge-retries.js.
const FLICKER_WINDOW_SECONDS = 15;

const MATCH = `
  WITH seq AS (
    SELECT o.id, o.site_id, o.card_number, o.entry_exit, o.start_end, o.occurred_at,
           LAG(o.id)          OVER w AS prev_id,
           LAG(o.entry_exit)  OVER w AS prev_dir,
           LAG(o.start_end)   OVER w AS prev_se,
           LAG(o.occurred_at) OVER w AS prev_at
      FROM operations o
     WHERE o.is_anomaly = 0 AND o.superseded_by IS NULL
    WINDOW w AS (PARTITION BY o.site_id ORDER BY o.occurred_at, o.id)
  )
  SELECT seq.prev_id       AS cut_id,      -- הסגירה שנקטעה בריצוד
         seq.id            AS resume_id,   -- הפתיחה שחידשה אותה
         seq.site_id, seq.entry_exit, seq.card_number,
         seq.prev_at       AS cut_at,
         seq.occurred_at   AS resume_at,
         s.code, s.site_name
    FROM seq JOIN sites s ON s.id = seq.site_id
   WHERE seq.start_end = 'start'
     AND seq.prev_se   = 'end'
     AND seq.prev_dir  = seq.entry_exit     -- אותו כיוון: זה חידוש, לא פעולה חדשה
     AND EXTRACT(EPOCH FROM (
           seq.occurred_at::timestamptz - seq.prev_at::timestamptz)) <= ${FLICKER_WINDOW_SECONDS}
   ORDER BY seq.prev_at
`;

(async () => {
  await db.init();

  const matches = await db.prepare(MATCH).all();
  console.log(`פעולות שנקטעו בריצוד MODE ונפתחו מחדש: ${matches.length}`);

  if (matches.length) {
    const byDir = { entry: 0, exit: 0 };
    const bySite = new Map();
    for (const m of matches) {
      byDir[m.entry_exit]++;
      const k = `${m.code} ${m.site_name || ""}`.trim();
      bySite.set(k, (bySite.get(k) || 0) + 1);
    }
    console.log(`  כניסות: ${byDir.entry}   יציאות: ${byDir.exit}   ` +
                `הטיה נטו לטובת יציאות: ${byDir.exit - byDir.entry}`);

    console.log("\nלפי אתר:");
    for (const [name, n] of [...bySite].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${name}`);
    }

    console.log("\nכל השורות שיוחרגו:");
    for (const m of matches) {
      const gap = Math.round((Date.parse(m.resume_at) - Date.parse(m.cut_at)) / 1000);
      console.log(
        `  ${m.cut_at.slice(0, 19).replace("T", " ")}  ${String(m.code).padEnd(6)} ` +
        `${m.entry_exit === "entry" ? "כניסה" : "יציאה"}  כרטיס ${String(m.card_number || "—").padEnd(3)} ` +
        `-> נפתחה מחדש אחרי ${gap}s`
      );
    }
  }

  // ההשפעה על האיזון — זה המספר שהחקירה התחילה ממנו.
  const before = await db.prepare(
    `SELECT COUNT(*) FILTER (WHERE entry_exit = 'entry')::int e,
            COUNT(*) FILTER (WHERE entry_exit = 'exit')::int x
       FROM operations
      WHERE start_end = 'end' AND is_anomaly = 0 AND superseded_by IS NULL`
  ).get();

  const cutE = matches.filter((m) => m.entry_exit === "entry").length;
  const cutX = matches.filter((m) => m.entry_exit === "exit").length;

  console.log(`\nאיזון כניסות/יציאות:`);
  console.log(`  לפני:  ${before.e} / ${before.x}   הפרש ${before.x - before.e}`);
  console.log(`  אחרי:  ${before.e - cutE} / ${before.x - cutX}   הפרש ${(before.x - cutX) - (before.e - cutE)}`);

  if (!APPLY) {
    console.log("\n=== הרצה יבשה — שום דבר לא נכתב. הוסיפו --apply כדי לבצע. ===");
    process.exit(0);
  }

  let updated = 0;
  await db.transaction(async () => {
    for (const m of matches) {
      const r = await db.prepare(
        "UPDATE operations SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL"
      ).run(m.resume_id, m.cut_id);
      if (r.changes ?? 1) updated++;
    }
  });

  const remaining = (await db.prepare(MATCH).all()).length;
  console.log(`\n=== בוצע ===`);
  console.log(`  שורות שסומנו:      ${updated}`);
  console.log(`  התאמות שנותרו:     ${remaining}${remaining ? "  ⚠️" : "  ✔"}`);
  process.exit(0);
})().catch((e) => { console.error("נכשל —", e.message); process.exit(1); });
