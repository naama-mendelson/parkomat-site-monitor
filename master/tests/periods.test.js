// tests/periods.test.js — הגדרת התקופות.
//
// ============================================================
// למה זה נכתב
// ============================================================
// 'חודש' היה מוגדר כ"מה-1 בחודש הנוכחי עד עכשיו", וזו הייתה תקלת תצוגה
// אמיתית: ב-3 בחודש המסך הראה **שלושה ימים** תחת הכותרת "חודש". בתחילת כל
// חודש כל המדדים קרסו לכמעט-אפס נתונים ואז תפחו לאורכו, בלי ששום דבר קרה
// בשטח. עכשיו זה חלון מתגלגל של 30 יום, כמו ש'שבוע' הוא 7 מתגלגלים.
//
// resolvePeriod הוא מקור אמת יחיד — הדשבורד, ה-API ועוזר ה-AI כולם עוברים
// דרכו (זו כל הסיבה שהוא מודול נפרד). לכן טסט כאן מגן על שלושתם.

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolvePeriod } = require("../api/periods");

const DAY = 24 * 3600 * 1000;
const spanDays = (r) => (Date.parse(r.to) - Date.parse(r.from)) / DAY;

test("חודש = 30 ימים קלנדריים כולל היום", () => {
  const p = resolvePeriod("month");

  // מחצות לפני 30 יום ועד *עכשיו*, ולכן המדידה נופלת בין 29 ל-30 —
  // בדיוק כמו בשבוע (7 ימים קלנדריים נמדדים כ-6.x).
  const span = spanDays(p.range);
  assert.ok(span > 29 && span <= 30, `אורך החלון ${span} — מצופה בין 29 ל-30`);
});

// ============================================================
// ⚠️ שתי גרסאות קודמות של הבדיקה הזו היו שגויות — וזה מלמד משהו
// ============================================================
// **הראשונה** בדקה `from.getDate() !== 1`. אבל החלון הוא חצות לפני 29
// יום, והתאריך הזה נופל על ה-1 בחודש פעם בכל חודש. ב-30/08/2026 היא
// האדימה בלי ששום דבר נשבר.
//
// **השנייה** (שלי) בדקה את ההגדרה הנכונה — אבל על התאריך של היום בלבד,
// וב-30/08 ההגדרה הנכונה והשגויה **מתלכדות**. בדיקת מוטציה חשפה את זה:
// החזרתי את הבאג הישן, והבדיקה עברה.
//
// המסקנה שמשותפת לשתיהן: בדיקה שרצה רק על "היום" בודקת יום אחד מתוך
// 365, ואי אפשר לדעת מראש איזה. לכן `resolvePeriod` מקבל עכשיו `now`,
// והבדיקה סורקת שנה שלמה.
//
// ⚠️ והתכונה שנבדקת היא **אורך קבוע**, לא תאריך ההתחלה: זה בדיוק מה
// שהבאג הישן הפר — ב-2 בחודש הוא נתן חלון של יום אחד תחת הכותרת "חודש".
test("אורך החלון קבוע בכל יום בשנה — זה היה הבאג", () => {
  const start = new Date(2026, 0, 1, 12, 0, 0);

  for (let i = 0; i < 365; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12, 0, 0);
    const p = resolvePeriod("month", day);
    const span = spanDays(p.range);

    assert.ok(span > 29 && span <= 30,
      `ב-${day.toDateString()} אורך החלון ${span.toFixed(2)} — מצופה בין 29 ל-30`);

    const expected = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 29);
    assert.equal(new Date(p.range.from).getTime(), expected.getTime(),
      `ב-${day.toDateString()} החלון מתחיל ב-${p.range.from} ולא בחצות של לפני 29 יום`);
  }
});

test("התקופה הקודמת באותו אורך, וצמודה לנוכחית", () => {
  const p = resolvePeriod("month");

  // 30 מלאים: prev נמדד בין שתי חצות, בלי ה'עכשיו' החלקי.
  assert.equal(spanDays(p.prev), 30);

  // בלי חפיפה ובלי חור — סוף הקודמת הוא תחילת הנוכחית.
  assert.equal(p.prev.to, p.range.from);
});

test("שבוע נשאר 7 ימים מתגלגלים", () => {
  const p = resolvePeriod("week");
  const span = spanDays(p.range);
  assert.ok(span > 6 && span <= 7, `אורך החלון ${span} — מצופה בין 6 ל-7`);
  assert.equal(spanDays(p.prev), 7);
  assert.equal(p.prev.to, p.range.from);
});

test("שני החלונות מיושרים לחצות מקומית", () => {
  // חלון שמתחיל בשעה שרירותית יוצר ימים חלקיים בשני הקצוות, והדלי של היום
  // נופל מחוץ לסדרה. זה כבר קרה, ולכן זה מקובע.
  for (const period of ["week", "month"]) {
    const from = new Date(resolvePeriod(period).range.from);
    assert.equal(from.getHours(), 0, `${period}: לא מיושר לחצות`);
    assert.equal(from.getMinutes(), 0, `${period}: לא מיושר לחצות`);
    assert.equal(from.getSeconds(), 0, `${period}: לא מיושר לחצות`);
  }
});

test("התוויות מתארות חלון מתגלגל, לא חודש קלנדרי", () => {
  const p = resolvePeriod("month");

  // התווית הישנה הייתה שם החודש ("אוגוסט 2026") — היא תיארה משהו אחר לגמרי
  // ממה שהמסך מציג, וזה בדיוק סוג הפרט שגורם לא להאמין למספרים.
  assert.match(p.label, /30/);
  assert.match(p.comparisonLabel, /30/);
});

test("granularity יומית — 30 נקודות, לא נקודה לחודש", () => {
  assert.equal(resolvePeriod("month").granularity, "day");
});

test("שנה לא נגעה — עדיין מ-1 בינואר", () => {
  // 'שנה' היא כן קלנדרית במהותה (דוחות שנתיים), ולכן היא לא השתנתה.
  const p = resolvePeriod("year");
  const from = new Date(p.range.from);
  assert.equal(from.getMonth(), 0);
  assert.equal(from.getDate(), 1);
  assert.equal(p.granularity, "month");
});

test("ערך לא מוכר נופל לשבוע", () => {
  for (const bad of [undefined, null, "", "quarter", "yesterday"]) {
    assert.equal(resolvePeriod(bad).period, "week");
  }
});
