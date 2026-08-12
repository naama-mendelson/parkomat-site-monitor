// tools/backfill-cards.js — מיישר כרטיסים בסגירת פעולה לפי הפתיחה, בהיסטוריה.
//
//   node --env-file=.env tools/backfill-cards.js          ← הרצה יבשה (ברירת מחדל)
//   node --env-file=.env tools/backfill-cards.js --apply  ← כותב באמת
//
// ============================================================
// שני כשלים, אותו תיקון
// ============================================================
// 1. **סגירה ריקה.** בחלק מהבקרים רגיסטר הכרטיס מתאפס לפני שה-MODE יוצא
//    ממצב הפעולה. נמדד: exit/start נשא כרטיס ב-100%, exit/end רק ב-67%.
//
// 2. **סגירה עם הכרטיס של הרכב הבא.** חמור יותר, כי הוא לא נראה כחסר אלא
//    כנתון תקין — ולכן שרד. הסוכן אימץ כל כרטיס לא-ריק שנראה לאורך הפעולה,
//    ולכן נהג שהעביר כרטיס בזמן שהפעולה הקודמת עוד רצה גנב אותה. נמדד: 86
//    מתוך 1,013 זוגות (8.5%), ובחולדה 4 לבדה 66. התסמין בדשבורד היה מאזן
//    בלתי אפשרי לכרטיס בודד — למשל 6 כניסות מול 3 יציאות.
//
// שניהם תוקנו במקור (OperationDetector בסוכן) ובקליטה (operation-handler),
// אבל מה שכבר נכתב נשאר שגוי. הכלי הזה מטפל בו: **המידע הנכון קיים על שורת
// ה-start**, כי היא נלכדת ברגע שהרכב התחיל לעבור.
//
// ============================================================
// אותם כללים בדיוק כמו בקליטה — ולא כללים "דומים"
// ============================================================
// שיוך שגוי כאן גרוע מחוסר: כרטיס שנדבק ליציאה של רכב אחר הוא נתון שקרי
// שנראה אמין. לכן שלוש ההגנות זהות לאלה שבזמן אמת:
//   1. חלון של שעתיים — start ישן מכדי להיות שייך נפסל.
//   2. אותו אתר ואותו כיוון.
//   3. **ה-start חייב להיות פתוח** — אם נסגר ב-end אחר בין לבין, הוא שייך
//      לרכב אחר.
//
// ⚠️ הכלי אינו נוגע בשורות start ריקות. start בלי כרטיס אומר שהבקר לא קרא
// כרטיס — זה מידע אמיתי, ולא חסר.

const db = require("../db/db");

const APPLY = process.argv.includes("--apply");

// אותו חלון כמו CARD_INHERIT_WINDOW_MS ב-queries.js. משוכפל כאן במכוון ולא
// מיובא: אם מישהו ישנה את החלון בקליטה, ריצה חוזרת של הכלי לא תשנה
// רטרואקטיבית נתונים שכבר אושרו לפי הכלל הישן.
const WINDOW = "2 hours";

// ה-start המתאים לכל end ריק. אותה לוגיקה כמו inheritCardFromStart, בשאילתה
// אחת על פני כל השורות.
const MATCH = `
  SELECT e.id            AS end_id,
         e.site_id,
         e.entry_exit,
         e.occurred_at   AS end_at,
         e.card_number   AS end_card,
         st.card_number  AS card,
         st.occurred_at  AS start_at
  FROM operations e
  JOIN LATERAL (
    SELECT s.card_number, s.occurred_at
    FROM operations s
    WHERE s.site_id = e.site_id
      AND s.entry_exit = e.entry_exit
      AND s.start_end = 'start'
      AND s.card_number <> ''
      AND s.occurred_at <= e.occurred_at
      AND s.occurred_at >= to_char(
            (e.occurred_at::timestamptz - interval '${WINDOW}') AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ORDER BY s.occurred_at DESC, s.id DESC
    LIMIT 1
  ) st ON TRUE
  WHERE e.start_end = 'end'
    -- ==========================================================
    -- גם ריק וגם **שגוי**
    -- ==========================================================
    -- הריצה הראשונה טיפלה רק בסגירות ריקות. אחר כך התגלה כשל שני, חמור
    -- יותר כי הוא נראה תקין: הסוכן אימץ כל כרטיס לא-ריק שנראה לאורך הפעולה,
    -- ולכן נהג שהעביר כרטיס בזמן שהפעולה הקודמת עוד רצה — גנב אותה.
    -- נמדד: 86 מתוך 1,013 זוגות (8.5%), ובחולדה 4 לבדה 66.
    --
    -- הכלל בשני המקרים זהה: **הפתיחה קובעת.** היא נלכדת ברגע שהרכב התחיל
    -- לעבור, ואין רגע מדויק ממנו.
    AND e.card_number IS DISTINCT FROM st.card_number
    AND e.is_anomaly = 0
    -- ה-start עדיין פתוח: אין סגירה אחרת בין לבין
    AND NOT EXISTS (
      SELECT 1 FROM operations mid
      WHERE mid.site_id = e.site_id
        AND mid.entry_exit = e.entry_exit
        AND mid.start_end = 'end'
        AND mid.occurred_at > st.occurred_at
        AND mid.occurred_at < e.occurred_at)
`;

(async () => {
  await db.init();

  const matches = await db.prepare(MATCH).all();
  const empty = matches.filter((m) => !m.end_card).length;

  console.log(`סגירות שאינן תואמות לפתיחה: ${matches.length}`);
  console.log(`  מהן ריקות לגמרי:          ${empty}`);
  console.log(`  מהן עם כרטיס **שגוי**:    ${matches.length - empty}`);

  const bySite = new Map();
  for (const m of matches) bySite.set(m.site_id, (bySite.get(m.site_id) || 0) + 1);
  const sites = await db.prepare("SELECT id, code, site_name FROM sites").all();
  const nameOf = new Map(sites.map((s) => [s.id, `${s.code} ${s.site_name || ""}`.trim()]));

  console.log("\nלפי אתר:");
  for (const [id, n] of [...bySite].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${nameOf.get(id) || id}`);
  }

  console.log("\nדוגמאות (5 ראשונות):");
  for (const m of matches.slice(0, 5)) {
    const gap = Math.round((Date.parse(m.end_at) - Date.parse(m.start_at)) / 1000);
    console.log(`  ${nameOf.get(m.site_id)}  ${m.entry_exit}  ` +
                `${m.start_at.slice(11, 19)} -> ${m.end_at.slice(11, 19)}  (${gap}s)  ` +
                `'${m.end_card || "(ריק)"}' -> '${m.card}'`);
  }

  if (!APPLY) {
    console.log("\n=== הרצה יבשה — שום דבר לא נכתב. הוסיפו --apply כדי לבצע. ===");
    process.exit(0);
  }

  // כתיבה בטרנזקציה אחת: או שהכול נכנס או שכלום.
  let updated = 0;
  await db.transaction(async () => {
    for (const m of matches) {
      // התנאי על card_number='' נשמר גם כאן — הגנה מפני ריצה כפולה, ומפני
      // מצב שבו הקליטה החיה עדכנה את השורה בזמן שהכלי רץ.
      const r = await db.prepare(
        // ⚠️ התנאי הוא 'שונה מהיעד' ולא 'ריק': הריצה הזו מתקנת גם כרטיס
        // שגוי. הוא עדיין מגן מפני ריצה כפולה ומפני עדכון מקביל מהקליטה.
        "UPDATE operations SET card_number = ? WHERE id = ? AND card_number IS DISTINCT FROM ?"
      ).run(m.card, m.end_id, m.card);
      if (r.changes ?? 1) updated++;
    }
  });

  // אימות: הרצה חוזרת של אותה שאילתה חייבת להחזיר אפס.
  const remaining = (await db.prepare(MATCH).all()).length;

  console.log(`\n=== בוצע ===`);
  console.log(`  שורות שעודכנו:        ${updated}`);
  console.log(`  אי-התאמות שנותרו:     ${remaining}${remaining ? "  ⚠️" : "  ✔"}`);
  process.exit(0);
})().catch((e) => { console.error("נכשל —", e.message); process.exit(1); });
