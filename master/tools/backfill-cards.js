// tools/backfill-cards.js — משלים כרטיסים שאבדו בסגירת פעולה, בנתונים היסטוריים.
//
//   node --env-file=.env tools/backfill-cards.js          ← הרצה יבשה (ברירת מחדל)
//   node --env-file=.env tools/backfill-cards.js --apply  ← כותב באמת
//
// ============================================================
// למה זה קיים
// ============================================================
// בחלק מהבקרים רגיסטר הכרטיס מתאפס לפני שה-MODE יוצא ממצב הפעולה, וזה קורה
// ביציאה. נמדד: exit/start נושא כרטיס ב-100% מהמקרים, exit/end רק ב-67%.
// באתרים שמריצים סוכן ישן האובדן שיטתי — 0% עד 8.5%.
//
// הקליטה כבר מתקנת את זה קדימה (inheritCardFromStart ב-queries.js). הכלי הזה
// מטפל במה שכבר נכתב: **המידע קיים על שורת ה-start**, והוא ניתן לשחזור.
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
    AND e.card_number = ''
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

  const before = await db.prepare(
    "SELECT COUNT(*)::int n FROM operations WHERE start_end='end' AND card_number='' AND is_anomaly=0"
  ).get();

  const matches = await db.prepare(MATCH).all();

  console.log(`שורות סגירה בלי כרטיס:        ${before.n}`);
  console.log(`מתוכן ניתנות לשחזור:          ${matches.length}`);
  console.log(`נשארות בלי כרטיס (אין start): ${before.n - matches.length}`);

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
                `${m.start_at.slice(11, 19)} -> ${m.end_at.slice(11, 19)}  ` +
                `(${gap}s)  כרטיס '${m.card}'`);
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
        "UPDATE operations SET card_number = ? WHERE id = ? AND card_number = ''"
      ).run(m.card, m.end_id);
      if (r.changes ?? 1) updated++;
    }
  });

  const after = await db.prepare(
    "SELECT COUNT(*)::int n FROM operations WHERE start_end='end' AND card_number='' AND is_anomaly=0"
  ).get();

  console.log(`\n=== בוצע ===`);
  console.log(`  שורות שעודכנו: ${updated}`);
  console.log(`  לפני: ${before.n} בלי כרטיס  ->  אחרי: ${after.n}`);
  process.exit(0);
})().catch((e) => { console.error("נכשל —", e.message); process.exit(1); });
