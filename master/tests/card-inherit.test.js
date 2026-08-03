// tests/card-inherit.test.js — השלמת כרטיס שאבד בין ה-start ל-end.
//
// ============================================================
// למה זה קיים
// ============================================================
// בחלק מהבקרים רגיסטר הכרטיס מתאפס לפני שה-MODE יוצא ממצב הפעולה, וזה קורה
// ביציאה. נמדד על נתוני אמת: exit/start נושא כרטיס ב-100% מהמקרים, ואילו
// exit/end רק ב-67%. בשלושה אתרים האובדן שיטתי — 0%, 7.5% ו-8.5%.
//
// כלומר המידע קיים תמיד; הוא פשוט על השורה השנייה. הסוכן המעודכן נושא אותו
// בעצמו, אבל השרת אינו יכול לכפות עדכון גרסה על אתר בשטח.
//
// ⚠️ הסכנה כאן היא שיוך שגוי — כרטיס שנדבק ליציאה של רכב אחר. הטסטים האלה
// קיימים בעיקר בשביל זה, ולא בשביל המקרה המוצלח.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const QUERIES = require.resolve("../db/queries");
const DB = require.resolve("../db/db");

const stub = (filename, exports) => {
  require.cache[filename] = {
    id: filename, filename, path: path.dirname(filename),
    loaded: true, children: [], paths: [], exports,
  };
};

/**
 * טוען את queries מעל שכבת DB מזויפת. rows = שורות operations פיקטיביות;
 * ה-stub מממש את שתי השאילתות שהפונקציה מריצה.
 */
function load(rows) {
  stub(DB, {
    prepare(sql) {
      return {
        async get(...args) {
          if (sql.includes("start_end = 'start'")) {
            const [siteId, dir, upTo, since] = args;
            const found = rows
              .filter((r) => r.site_id === siteId && r.entry_exit === dir
                && r.start_end === "start" && r.card_number !== ""
                && r.occurred_at <= upTo && r.occurred_at >= since)
              .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))[0];
            return found ? { card_number: found.card_number, occurred_at: found.occurred_at } : undefined;
          }
          // בדיקת "האם ה-start כבר נסגר"
          const [siteId, dir, after, before] = args;
          const closed = rows.find((r) => r.site_id === siteId && r.entry_exit === dir
            && r.start_end === "end" && r.occurred_at > after && r.occurred_at < before);
          return closed ? { "?column?": 1 } : undefined;
        },
      };
    },
  });

  delete require.cache[QUERIES];
  return require(QUERIES).inheritCardFromStart;
}

const T = (min) => new Date(Date.UTC(2026, 7, 3, 10, min, 0)).toISOString();

test("כרטיס מושלם מה-start התואם", async () => {
  const inherit = load([
    { site_id: 1, entry_exit: "exit", start_end: "start", card_number: "77", occurred_at: T(0) },
  ]);
  assert.equal(await inherit(1, "exit", T(4)), "77");
});

test("start שכבר נסגר ב-end אחר — לא יורשים ממנו", async () => {
  // בלי ההגנה הזו הכרטיס היה נדבק ליציאה של הרכב הבא.
  const inherit = load([
    { site_id: 1, entry_exit: "exit", start_end: "start", card_number: "77", occurred_at: T(0) },
    { site_id: 1, entry_exit: "exit", start_end: "end",   card_number: "77", occurred_at: T(3) },
  ]);
  assert.equal(await inherit(1, "exit", T(9)), "");
});

test("הפתיחה הקרובה ביותר נבחרת, לא הישנה", async () => {
  const inherit = load([
    { site_id: 1, entry_exit: "exit", start_end: "start", card_number: "11", occurred_at: T(0) },
    { site_id: 1, entry_exit: "exit", start_end: "end",   card_number: "11", occurred_at: T(2) },
    { site_id: 1, entry_exit: "exit", start_end: "start", card_number: "22", occurred_at: T(5) },
  ]);
  assert.equal(await inherit(1, "exit", T(8)), "22");
});

test("כיוון אחר אינו נחשב — כניסה לא מזינה יציאה", async () => {
  const inherit = load([
    { site_id: 1, entry_exit: "entry", start_end: "start", card_number: "99", occurred_at: T(0) },
  ]);
  assert.equal(await inherit(1, "exit", T(3)), "");
});

test("אתר אחר אינו נחשב", async () => {
  const inherit = load([
    { site_id: 2, entry_exit: "exit", start_end: "start", card_number: "55", occurred_at: T(0) },
  ]);
  assert.equal(await inherit(1, "exit", T(3)), "");
});

test("start ישן מדי — מחוץ לחלון, לא יורשים", async () => {
  // פעולה נמשכת דקות. פתיחה מלפני שעות שייכת לרכב אחר לגמרי.
  const old = new Date(Date.UTC(2026, 7, 3, 5, 0, 0)).toISOString();   // 5 שעות קודם
  const inherit = load([
    { site_id: 1, entry_exit: "exit", start_end: "start", card_number: "77", occurred_at: old },
  ]);
  assert.equal(await inherit(1, "exit", T(0)), "");
});

test("start בלי כרטיס — אין ממה לרשת", async () => {
  // הבקר לא קרא כרטיס. זה מידע אמיתי, ואסור להמציא לו ערך.
  const inherit = load([
    { site_id: 1, entry_exit: "exit", start_end: "start", card_number: "", occurred_at: T(0) },
  ]);
  assert.equal(await inherit(1, "exit", T(3)), "");
});

test("אין שום פתיחה — מחזיר ריק ולא נופל", async () => {
  const inherit = load([]);
  assert.equal(await inherit(1, "exit", T(3)), "");
});

test("start אחרי הסגירה אינו נחשב", async () => {
  // סדר הפוך (backfill) — פתיחה שמאוחרת מהסגירה אינה שייכת לה.
  const inherit = load([
    { site_id: 1, entry_exit: "exit", start_end: "start", card_number: "77", occurred_at: T(9) },
  ]);
  assert.equal(await inherit(1, "exit", T(3)), "");
});
