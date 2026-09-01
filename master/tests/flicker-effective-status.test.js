// tests/flicker-effective-status.test.js — הקיפול קורא את הסטטוס האפקטיבי.
//
// ============================================================
// ⚠️ באג ייצור, שנתפס רק אחרי שמישהו סיווג מחדש בפועל
// ============================================================
// `reclassified_to` הוא שכבה מעל `status`, והכלל בתיעוד חד: **כל** קריאה
// של status_history עוברת דרך `COALESCE(reclassified_to, status)`.
// `collapseNoCommFlicker` לא עשתה זאת.
//
// ⚠️ **נמדד באתר 3456 (חולדה 4).** מנהל סיווג שני מקטעי `error`
// ל-`maintenance`, וכך נוצר הרצף האפקטיבי maintenance→maintenance.
// ה-SQL קיפל אותם; ה-JS ראה error→maintenance, החליט שזה שינוי מצב,
// ושמר את שניהם. `npm run parity` דיווח 61 מול 59.
//
// ⚠️ **ולמה שני השערים הקיימים לא תפסו:**
//   • `check-effective-status` סורק `status = '…'` בקבצי SQL וב-queries.js.
//     כאן ההשוואה היא בין שני **משתנים** ב-JS, בקובץ אחר — מחוץ לטווח.
//   • `npm run parity` כן תפס, אבל **רק ביום שבו הסיווג מחדש קרה בפועל**.
//     עד אז שתי הזרועות הסכימו בשלמות, כי לנתונים לא היה מקרה כזה.
//
// זו בדיוק הסיבה שהבדיקה הזו קיימת: היא אינה תלויה בכך שמישהו יסווג
// מקטע מחדש בייצור בדיוק ביום שהשער רץ.
const test = require("node:test");
const assert = require("node:assert/strict");

let collapseNoCommFlicker;
test.before(async () => {
  ({ collapseNoCommFlicker } = await import("../../shared/insights.mjs"));
});

const seg = (id, status, reclassified_to = null) => ({
  id, status, reclassified_to,
  started_at: `2026-09-01T10:0${id}:00.000Z`,
  ended_at: `2026-09-01T10:0${id + 1}:00.000Z`,
});

test("⚠️ מקטע שסווג מחדש מתקפל מול המקטע שאחריו", () => {
  // הרצף מהייצור: error שסווג ל-maintenance, ואחריו maintenance אמיתי.
  const out = collapseNoCommFlicker([
    seg(1, "ready"),
    seg(2, "error", "maintenance"),   // אפקטיבית: maintenance
    seg(3, "maintenance"),            // אותו מצב — צריך להתקפל
  ]);

  assert.deepEqual(out.map((s) => s.id), [1, 2],
    "המקטע השלישי לא התקפל — הקיפול קורא status גולמי");
});

test("⚠️ בלי סיווג מחדש ההתנהגות אינה משתנה", () => {
  // אותו רצף בדיוק, בלי הסיווג: error ו-maintenance הם שני מצבים שונים.
  const out = collapseNoCommFlicker([
    seg(1, "ready"),
    seg(2, "error"),
    seg(3, "maintenance"),
  ]);

  assert.deepEqual(out.map((s) => s.id), [1, 2, 3],
    "התיקון שינה את המקרה שאינו מסווג — זו רגרסיה");
});

test("⚠️ המקטע המוחזר נשאר המקורי — הסטטוס הגולמי אינו נמחק", () => {
  // ההחלטה משתמשת בסטטוס האפקטיבי, אבל מה שחוזר הוא האובייקט כפי שהוא.
  // צרכן במורד הזרם חייב להמשיך לראות את `status` המקורי ואת
  // `reclassified_to` לצידו — הצגה של "התקלה המקורית" נשענת על זה.
  const input = seg(2, "error", "maintenance");
  const out = collapseNoCommFlicker([input]);

  assert.equal(out[0], input, "הוחזר עותק ולא המקטע עצמו");
  assert.equal(out[0].status, "error", "הסטטוס המקורי נדרס");
  assert.equal(out[0].reclassified_to, "maintenance");
});

test("no_comm נשמר תמיד, גם בין שני מצבים זהים", () => {
  // ⚠️ נתק אינו מאפס את המצב שקדם לו — הוא מסתיר אותו. לכן שני מקטעי
  // ready משני צדדיו הם עדיין **אותו** מצב, והשני מתקפל.
  const out = collapseNoCommFlicker([
    seg(1, "ready"),
    seg(2, "no_comm"),
    seg(3, "ready"),
  ]);

  assert.deepEqual(out.map((s) => s.id), [1, 2],
    "או שה-no_comm נזרק, או שהוא איפס את המצב הקודם");
});

test("⚠️ גם no_comm שסווג מחדש נקרא אפקטיבית", () => {
  // הכלל אחיד ולא מותנה: אם אי-פעם יתאפשר לסווג no_comm, ההחלטה כאן
  // חייבת ללכת אחרי הסיווג ולא אחרי הגולמי. כלל שחל על חלק מהמצבים הוא
  // כלל שמישהו ישבור בלי לשים לב.
  const out = collapseNoCommFlicker([
    seg(1, "ready"),
    seg(2, "no_comm", "ready"),   // אפקטיבית ready — אותו מצב
  ]);

  assert.deepEqual(out.map((s) => s.id), [1],
    "המקטע השני נשמר — ההחלטה קראה no_comm הגולמי");
});
