// tools/merge-retries.js — מאחד ניסיון שנקטע עם הניסיון החוזר שהחליף אותו.
//
//   node --env-file=.env tools/merge-retries.js          ← הרצה יבשה (ברירת מחדל)
//   node --env-file=.env tools/merge-retries.js --apply  ← כותב באמת
//
// ============================================================
// מעבר פיזי אחד = פעולה אחת
// ============================================================
// רכב מתחיל כניסה. תוך כדי קורית תקלה והוא נתקע. המצב חוזר ל'מוכן', ואותו
// כרטיס מנסה שוב — ומצליח. עד עכשיו זה נספר כ**שתי** פעולות חניה, למרות
// שהרכב עבר פעם אחת.
//
// הכלל: הניסיון הראשון מצביע על השני (superseded_by), ומוחרג מכל מדד. השורה
// עצמה נשארת — היא זו שבגללה קרתה התקלה, ובלעדיה מאבדים את מי שהיה בפנים.
//
// ============================================================
// מה הכלי **לא** עושה — והמקרה השני שנשאר בכוונה
// ============================================================
// כשאחרי התקלה באה **תחזוקה**, ההנחה היא שהרכב הושלם בטיפול. אבל אז אין מה
// לאחד: הפעולה נספרת פעם אחת בין כה וכה, ורק ה**תווית** משתנה מ"נקטעה"
// ל"הושלמה בתחזוקה". זה נגזר בזמן קריאה (buildTimeline) ולא נכתב לטבלה —
// כלל שנשמר כנתון קופא ברגע שמתקנים אותו, וכאן אין מה להקפיא.
//
// ============================================================
// שלוש הגנות מפני איחוד שגוי
// ============================================================
// איחוד שגוי גרוע מאי-איחוד: הוא מעלים פעולה אמיתית מהספירה בשקט.
//   1. **הפעולה נקטעה בתקלה** — end.occurred_at == error.started_at בדיוק.
//      מעבר MODE אחד מייצר את שתי ההודעות באותו סבב ועם אותו חותם.
//   2. **אותו אתר, אותו כרטיס, אותו כיוון.** נהג אחר אינו ניסיון חוזר.
//   3. **חלון של 30 דקות.** נמדד: 5 ניסיונות תוך 10 דקות, 9 תוך 30, 10 תוך
//      שעה — ואז שטוח לחלוטין עד 4 שעות. 30 תופס 9 מ-10 ואינו רגיש להזזה;
//      חלון פתוח היה מחבר את הכניסה של הבוקר לזו של אחר הצהריים.

const db = require("../db/db");

const APPLY = process.argv.includes("--apply");

// ⚠️ משוכפל במכוון ב-ingestion/operation-handler.js ולא מיובא ממנו: אם מישהו
// ישנה את החלון בקליטה, ריצה חוזרת של הכלי לא תשנה רטרואקטיבית נתונים שכבר
// אושרו לפי הכלל הישן. אותו שיקול כמו ב-backfill-cards.js.
const RETRY_WINDOW = "30 minutes";

const MATCH = `
  SELECT cut.id            AS cut_id,
         cut.site_id,
         cut.entry_exit,
         cut.card_number,
         cut.occurred_at   AS cut_at,
         retry.id          AS retry_id,
         retry.occurred_at AS retry_at,
         s.code, s.site_name
  FROM operations cut
  -- הגנה 1: הפעולה נקטעה בתקלה. ההשוואה על המחרוזת ולא על timestamptz —
  -- שני החותמים נולדו מאותו מקור ובאותו פורמט, וסבילות זמן כאן הייתה מסמנת
  -- גם תקלה שהתחילה סמוך לסיום תקין.
  JOIN status_history err
    ON err.site_id = cut.site_id AND err.started_at = cut.occurred_at
   AND err.status = 'error'
  JOIN sites s ON s.id = cut.site_id
  JOIN LATERAL (
    SELECT r.id, r.occurred_at
    FROM operations r
    WHERE r.site_id    = cut.site_id          -- הגנה 2
      AND r.card_number = cut.card_number
      AND r.entry_exit  = cut.entry_exit
      AND r.start_end   = 'start'
      AND r.is_anomaly  = 0
      AND r.occurred_at > cut.occurred_at
      -- הגנה 3: החלון. הסינון לקסיקלי על TEXT כדי לשמור על האינדקס —
      -- r.occurred_at::timestamptz היה מבטל את idx_operations_site_time.
      AND r.occurred_at <= to_char(
            (cut.occurred_at::timestamptz + interval '${RETRY_WINDOW}') AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ORDER BY r.occurred_at ASC, r.id ASC
    LIMIT 1
  ) retry ON TRUE
  WHERE cut.start_end = 'end'
    AND cut.is_anomaly = 0
    AND cut.card_number <> ''      -- בלי כרטיס אין דרך לדעת שזה אותו רכב
    AND cut.superseded_by IS NULL  -- מגן מפני ריצה כפולה
  ORDER BY cut.occurred_at
`;

(async () => {
  await db.init();

  const matches = await db.prepare(MATCH).all();

  console.log(`ניסיונות שנקטעו ונמצא להם ניסיון חוזר: ${matches.length}`);

  if (matches.length) {
    const bySite = new Map();
    for (const m of matches) {
      const k = `${m.code} ${m.site_name || ""}`.trim();
      bySite.set(k, (bySite.get(k) || 0) + 1);
    }
    console.log("\nלפי אתר:");
    for (const [name, n] of [...bySite].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${name}`);
    }

    console.log("\nכל השורות שיוחרגו מהספירה:");
    for (const m of matches) {
      const gapMin = Math.round((Date.parse(m.retry_at) - Date.parse(m.cut_at)) / 60000);
      const dir = m.entry_exit === "entry" ? "כניסה" : "יציאה";
      console.log(
        `  ${m.cut_at.slice(0, 16).replace("T", " ")}  ` +
        `${(m.code + "").padEnd(6)} ${dir}  כרטיס ${String(m.card_number).padEnd(3)}  ` +
        `-> ניסיון חוזר אחרי ${gapMin} דק'`
      );
    }
  }

  // ההשפעה המדויקת על המדד, לפני ואחרי — כי זה שינוי **רטרואקטיבי** במספרים
  // שכבר נראו על המסך, ומספר שמשתנה בלי הסבר שוחק את האמון במסך כולו.
  const before = (await db.prepare(
    "SELECT COUNT(*)::int n FROM operations WHERE is_anomaly = 0 AND start_end = 'end'"
  ).get()).n;

  console.log(`\nספירת הפעולות: ${before} -> ${before - matches.length}  (${matches.length}-)`);

  if (!APPLY) {
    console.log("\n=== הרצה יבשה — שום דבר לא נכתב. הוסיפו --apply כדי לבצע. ===");
    process.exit(0);
  }

  let updated = 0;
  await db.transaction(async () => {
    for (const m of matches) {
      // התנאי `superseded_by IS NULL` נשמר גם כאן — הגנה מפני ריצה כפולה
      // ומפני עדכון מקביל מהקליטה בזמן שהכלי רץ.
      const r = await db.prepare(
        "UPDATE operations SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL"
      ).run(m.retry_id, m.cut_id);
      if (r.changes ?? 1) updated++;
    }
  });

  // אימות: הרצה חוזרת של אותה שאילתה חייבת להחזיר אפס.
  const remaining = (await db.prepare(MATCH).all()).length;

  console.log(`\n=== בוצע ===`);
  console.log(`  שורות שסומנו:      ${updated}`);
  console.log(`  התאמות שנותרו:     ${remaining}${remaining ? "  ⚠️" : "  ✔"}`);
  process.exit(0);
})().catch((e) => { console.error("נכשל —", e.message); process.exit(1); });
