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

test("החלון אינו מתחיל ב-1 בחודש — זה היה הבאג", () => {
  const p = resolvePeriod("month");
  const from = new Date(p.range.from);

  // התנאי הזה נכשל בכל יום מ-2 בחודש והלאה תחת ההגדרה הישנה. הוא נשאר כאן
  // גם אם ההגדרה תשתנה שוב: מה שאסור הוא שהחלון יתחיל תמיד ב-1.
  const now = new Date();
  if (now.getDate() > 1) {
    assert.notEqual(from.getDate(), 1,
      "החלון מתחיל ב-1 בחודש — חזרנו להגדרה שגרמה ל'חודש' להציג ימים בודדים");
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
