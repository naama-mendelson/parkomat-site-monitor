// רצפת הסבירות למשך פעולה, והמונים של מה שהוחרג.
//
// ============================================================
// ⚠️ למה זה קיים: 0.2% מהנתונים קבעו 100% מהמספר שמוצג
// ============================================================
// למשכים הייתה תקרה (4 שעות) ולא הייתה רצפה. נמדד על הצי, 30 יום:
// **8 משכים בלתי סבירים מתוך 3,642** — 0.2%, שנראה זניח.
//
// ⚠️ אבל המסך מציג את ה**מינימום**, ולכן שמונת הערכים האלה היו *תמיד*
// מה שהופיע כ"הפעולה הקצרה ביותר". הרעש הנדיר ביותר קיבל כותרת, ואז
// סתר את "הכרטיס המהיר" שלידו — שנבנה מממוצעים ולכן הראה 339 שניות.
// זו הסתירה שנצפתה על המסך באתר עמנואל הרומי.
//
// ⚠️ **וזו אינה מכונית מהירה אלא חתימה.** שמונת הערכים הם *בדיוק* שנייה
// אחת, ואחריהם פער ואז 6, 7, 9. הסוכן דוגם את ה-PLC כל 1000ms, ולכן
// MODE שמהבהב למחזור דגימה יחיד מייצר start ו-end במרחק שנייה בדיוק.
const test = require("node:test");
const assert = require("node:assert");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const mod = () => import(
  pathToFileURL(path.resolve(__dirname, "..", "..", "shared", "insights.mjs")).href);

const op = (at, startEnd, dir, card) => ({
  site_id: 1, occurred_at: at, start_end: startEnd,
  entry_exit: dir, card_number: card, is_anomaly: 0,
});

const run = async (ops) => {
  const { computeInsights } = await mod();
  return computeInsights({
    ops, errorRows: [], maintRows: [], windows: [],
    from: "2026-09-01", to: "2026-09-02",
    siteNames: new Map([[1, "בדיקה"]]), allRows: ops,
  });
};

test("⚠️ ריצוד MODE של שנייה אינו נספר כפעולה", async () => {
  const r = await run([
    op("2026-09-01T10:00:00.000Z", "start", "entry", "5"),
    op("2026-09-01T10:00:01.000Z", "end", "entry", "5"),     // מחזור דגימה אחד
    op("2026-09-01T12:00:00.000Z", "start", "entry", "9"),
    op("2026-09-01T12:05:00.000Z", "end", "entry", "9"),     // 300ש — אמיתי
  ]);

  assert.strictEqual(r.durations.samples, 1, "הריצוד נספר כפעולה");
  assert.strictEqual(r.durations.shortestSeconds, 300,
    "המינימום עדיין מציג את הריצוד — זו בדיוק הבעיה שנצפתה על המסך");
  assert.strictEqual(r.excluded.flickerOps, 1);
});

test("⚠️ ההחרגה נספרת ואינה שקטה", async () => {
  // סינון שאיש אינו רואה הוא איך מספר שגוי הופך למספר שנעלם: אי אפשר
  // להבדיל בין "האתר נקי" לבין "המסנן עובד קשה".
  const r = await run([
    op("2026-09-01T10:00:00.000Z", "start", "entry", "5"),
    op("2026-09-01T10:00:01.000Z", "end", "entry", "5"),
  ]);
  assert.strictEqual(r.excluded.flickerOps, 1);
  // ⚠️ null ולא אובייקט עם samples:0 — זו התנהגות מכוונת של statsOf,
  // כדי שהמסך יאמר "אין נתון" ולא יציג "0 שניות", שנקרא כמדידה.
  assert.strictEqual(r.durations, null);
});

test("⚠️ התחלה שנדרסה נספרת — היא הודעת end שאבדה", async () => {
  // ⚠️ ודווקא **לא** מוחרגת: אם ה-end של הפעולה הראשונה אבד, הזיווג של
  // השנייה נכון לגמרי. מה שאבד הוא פעולה שלמה, לא מדידה מקולקלת —
  // ולכן התגובה היא לספור, לא לזרוק.
  const r = await run([
    op("2026-09-01T11:00:00.000Z", "start", "entry", "7"),
    op("2026-09-01T11:02:00.000Z", "start", "entry", "7"),   // דורסת
    op("2026-09-01T11:07:00.000Z", "end", "entry", "7"),
  ]);

  assert.strictEqual(r.excluded.discardedStarts, 1);
  assert.strictEqual(r.durations.samples, 1);
  assert.strictEqual(r.durations.shortestSeconds, 300, "נמדד מההתחלה השנייה, וזה הנכון");
});

test("⚠️ הרצפה אינה בולעת משכים אמיתיים קצרים", async () => {
  // גבול: 2 שניות בדיוק **כן** נספרות. רצפה שתגדל בשקט תתחיל למחוק
  // נתונים אמיתיים, וזה בדיוק הכשל ההפוך.
  const r = await run([
    op("2026-09-01T10:00:00.000Z", "start", "exit", "5"),
    op("2026-09-01T10:00:02.000Z", "end", "exit", "5"),
  ]);
  assert.strictEqual(r.durations.samples, 1);
  assert.strictEqual(r.excluded.flickerOps, 0);
});

test("התקרה של 4 שעות נשארה", async () => {
  const r = await run([
    op("2026-09-01T00:00:00.000Z", "start", "entry", "5"),
    op("2026-09-01T05:00:00.000Z", "end", "entry", "5"),
  ]);
  assert.strictEqual(r.durations, null, "משך מעל 4 שעות נספר");
});
