// tests/cycle-counter.test.js — C2: מונה המחזורים לא ינופח ולא ייספר פעמיים.
//
// cycle_total הוא סכום רץ שלא מחושב מחדש מהנתונים הגולמיים, ולכן כל טעות בו
// היא קבועה. הבדיקות כאן עוברות על כל הענפים: קריאה ראשונה (אתר חדש/ותיק),
// delta רגיל, מסירה חוזרת, אתחול בקר אמיתי, נפילה חשודה, וקלט פסול.

const test = require("node:test");
const assert = require("node:assert/strict");

// נטען מהמודול הטהור ישירות — בלי db.js, בלי DATABASE_URL, בלי סיכון
// לגעת במסד אמיתי מתוך בדיקה.
const { decideCycleUpdate, RESET_PLAUSIBLE_MAX } = require("../db/cycle-rules");

const T1 = "2026-07-26T12:00:00.000Z";
const T2 = "2026-07-26T12:00:30.000Z";
const T3 = "2026-07-26T12:01:00.000Z";

// ===== קריאה ראשונה =====

test("קריאה ראשונה באתר חדש — המונה נשאר 0, הערך רק בסיס", () => {
  const d = decideCycleUpdate({
    last: null, lastTs: null, total: 0, isNewSite: 1, current: 1376, occurredAt: T1,
  });
  assert.equal(d.mode, "first");
  assert.equal(d.total, 0, "אתר חדש לא מאמץ את מונה המפעל");
  assert.equal(d.nextLast, 1376);
  assert.equal(d.write, true);
});

test("קריאה ראשונה באתר ותיק — מאמץ את המונה ההיסטורי", () => {
  const d = decideCycleUpdate({
    last: null, lastTs: null, total: 0, isNewSite: 0, current: 1376000, occurredAt: T1,
  });
  assert.equal(d.mode, "first");
  assert.equal(d.total, 1376000);
});

// ===== delta רגיל =====

test("התקדמות רגילה — מוסיף את ההפרש בלבד", () => {
  const d = decideCycleUpdate({
    last: 1500, lastTs: T1, total: 50, isNewSite: 1, current: 1503, occurredAt: T2,
  });
  assert.equal(d.mode, "normal");
  assert.equal(d.total, 53);
  assert.equal(d.nextLast, 1503);
});

test("אותו ערך מונה (המונה לא זז) — מוסיף 0", () => {
  const d = decideCycleUpdate({
    last: 1503, lastTs: T1, total: 53, isNewSite: 1, current: 1503, occurredAt: T2,
  });
  assert.equal(d.mode, "normal");
  assert.equal(d.total, 53);
});

// ===== C1/C2: מסירה חוזרת =====

test("הודעה מאוחרת (occurredAt < cycle_last_ts) — לא נוגעת במונה", () => {
  const d = decideCycleUpdate({
    last: 1503, lastTs: T3, total: 53, isNewSite: 1, current: 1501, occurredAt: T1,
  });
  assert.equal(d.mode, "backfill");
  assert.equal(d.total, 53, "המונה חייב להישאר כפי שהיה");
  assert.equal(d.write, false, "וגם הבסיס לא זז");
});

test("replay של אותה הודעה בדיוק (אותו חותם) — נחסם כ-backfill ולא נספר שוב", () => {
  const first = decideCycleUpdate({
    last: 1500, lastTs: T1, total: 50, isNewSite: 1, current: 1503, occurredAt: T2,
  });
  assert.equal(first.total, 53);

  // אותה הודעה שוב, על המצב שנוצר ממנה. החותם כבר לא *מוקדם* מ-lastTs אלא שווה
  // לו — ולכן היא נופלת לענף ה-delta ומוסיפה 0. גם זה בטוח.
  const replay = decideCycleUpdate({
    last: first.nextLast, lastTs: T2, total: first.total, isNewSite: 1,
    current: 1503, occurredAt: T2,
  });
  assert.equal(replay.total, 53, "מסירה חוזרת לא מנפחת את המונה");
});

// ===== אתחול בקר =====

test("אתחול בקר אמיתי (המונה חזר ל-2) — מוסיף רק את הערך הקטן", () => {
  const d = decideCycleUpdate({
    last: 12249, lastTs: T1, total: 47, isNewSite: 1, current: 2, occurredAt: T2,
  });
  assert.equal(d.mode, "reset");
  assert.equal(d.total, 49);
  assert.equal(d.nextLast, 2);
});

test(`אתחול על גבול הסבירות (${RESET_PLAUSIBLE_MAX}) — עדיין אתחול`, () => {
  const d = decideCycleUpdate({
    last: 12249, lastTs: T1, total: 47, isNewSite: 1,
    current: RESET_PLAUSIBLE_MAX, occurredAt: T2,
  });
  assert.equal(d.mode, "reset");
  assert.equal(d.total, 47 + RESET_PLAUSIBLE_MAX);
});

// ===== הבאג שנסגר: נפילה חשודה =====

test("נפילה לערך גבוה (12249 → 1000) — לא מנפחת את המונה", () => {
  const d = decideCycleUpdate({
    last: 12249, lastTs: T1, total: 47, isNewSite: 1, current: 1000, occurredAt: T2,
  });
  assert.equal(d.mode, "reset_suspect");
  assert.equal(d.total, 47, "בהתנהגות הקודמת זה היה הופך ל-1047 — לצמיתות");
  assert.equal(d.ignoredAmount, 1000);
  assert.equal(d.nextLast, 1000, "הבסיס כן זז, אחרת כל הודעה הבאה תיראה כנפילה");
});

test("אחרי נפילה חשודה — הספירה ממשיכה נכון מהבסיס החדש", () => {
  const suspect = decideCycleUpdate({
    last: 12249, lastTs: T1, total: 47, isNewSite: 1, current: 1000, occurredAt: T2,
  });
  const next = decideCycleUpdate({
    last: suspect.nextLast, lastTs: T2, total: suspect.total, isNewSite: 1,
    current: 1003, occurredAt: T3,
  });
  assert.equal(next.mode, "normal");
  assert.equal(next.total, 50, "3 מחזורים אמיתיים נוספו, בלי שאריות מהנפילה");
});

// ===== קלט פסול =====

test("מונה שלילי — נדחה בלי לגעת בכלום", () => {
  const d = decideCycleUpdate({
    last: 1500, lastTs: T1, total: 50, isNewSite: 1, current: -5, occurredAt: T2,
  });
  assert.equal(d.mode, "invalid");
  assert.equal(d.total, 50);
  assert.equal(d.write, false);
});

test("מונה לא-שלם — נדחה", () => {
  for (const bad of [1.5, NaN, Infinity, null, undefined, "1503"]) {
    const d = decideCycleUpdate({
      last: 1500, lastTs: T1, total: 50, isNewSite: 1, current: bad, occurredAt: T2,
    });
    assert.equal(d.mode, "invalid", `${bad} היה אמור להיפסל`);
    assert.equal(d.write, false);
  }
});

// ===== רגרסיה: הנתונים האמיתיים שנצפו =====

test("רגרסיה: המקטע האמיתי של אתר 2439 מתנהג בדיוק כמו קודם", () => {
  // מתוך ה-DB: plc_cycle_last עלה 1514 → 1517 בזמן ש-cycle_total עלה 51 → 54.
  let state = { last: 1514, lastTs: T1, total: 51 };
  for (const [current, ts] of [[1515, T2], [1516, T3], [1517, "2026-07-26T12:01:30.000Z"]]) {
    const d = decideCycleUpdate({ ...state, isNewSite: 1, current, occurredAt: ts });
    assert.equal(d.mode, "normal");
    state = { last: d.nextLast, lastTs: ts, total: d.total };
  }
  assert.equal(state.total, 54, "נתונים תקינים נספרים בדיוק כמו לפני השינוי");
});
