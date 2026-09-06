// שני אינווריאנטים שהיו **מתועדים ולא מכוסים**, ונמצאו בסריקת מוטציות.
//
// ⚠️ בשניהם CLAUDE.md מסביר באריכות למה זה חשוב — ובאחד מהם מתוארת תקלה
// שקרתה בייצור — ואף בדיקה לא אכפה אותם. שבירה של כל אחד השאירה את 448
// הבדיקות ירוקות.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// ============================================================
// 1. חותם זמן שנוצר בשרת — שניות שלמות, תמיד
// ============================================================
// ⚠️ מ-master/CLAUDE.md, ותקלה שקרתה: "חוזה הסוכן הוא שניות. חותם
// במילישניות שנכתב בשרת תמיד נראה 'חדש' יותר מה-resync של הסוכן, שומר
// ה-backfill דוחה את ה-resync, ו**האתר נשאר תקוע ב-no_comm לנצח** אחרי
// שכבר התאושש."
//
// שתי הנקודות שמייצרות חותם בשרת הן state-handler ו-bridge-handler.
// בדיקה מבנית, כי הפונקציות קוראות ל-Date.now() בתוכן ואין לאן להזריק.
const FLOORED = /new Date\(Math\.floor\(Date\.now\(\) \/ 1000\) \* 1000\)/;

for (const file of ["ingestion/state-handler.js", "ingestion/bridge-handler.js"]) {
  test(`⚠️ ${file} מרצף את החותם לשניות שלמות`, () => {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");

    // ⚠️ שתי טענות, ולא אחת. "נמצא הריצוף" לבדו היה עובר גם אם מישהו
    // מוסיף לצדו השמה שנייה שאינה מרוצפת; ו"אין השמה לא-מרוצפת" לבדו היה
    // עובר גם אם הריצוף נמחק והקובץ נשאר בלי שום חותם.
    assert.match(src, FLOORED,
      "אין ריצוף לשניות שלמות — האתר עלול להיתקע ב-no_comm לנצח");

    // ⚠️ **רק השמות ל-occurredAt.** הכלל נוגע לחותם שנכנס להיסטוריה
    // ונשפט מול שומר ה-backfill — לא לכל תאריך בקובץ. `bridge_seen_at`,
    // למשל, הוא שדה אבחון ואינו מרוצף בכוונה; בדיקה שהייתה פוסלת גם
    // אותו הייתה נכשלת על קוד תקין, וזה הסוג שמלמדים להתעלם ממנו.
    const assignments = src.split("\n").filter((l) => /\boccurredAt\s*=/.test(l));
    assert.ok(assignments.length >= 1, "לא נמצאה השמה ל-occurredAt — האם הקובץ השתנה?");

    for (const line of assignments) {
      // ⚠️ **רק `Date.now()`** — כלומר חותם שהשרת מייצר. השמה מחותם הסוכן
      // (`new Date(data.timestamp * 1000)`) היא כבר שניות שלמות לפי החוזה,
      // ובדיקה שפוסלת גם אותה נכשלת על קוד תקין.
      if (!/Date\.now\(\)/.test(line)) continue;
      assert.match(line.trim(), FLOORED,
        `חותם שרת בלי ריצוף: ${line.trim()} — שומר ה-backfill ידחה את ה-resync`);
    }
  });
}

test("⚠️ הריצוף באמת מייצר מילישניות אפס", () => {
  // הצד ההתנהגותי של אותו כלל: לא רק שהביטוי קיים, אלא שהוא עושה
  // את מה שהוא אמור. לולאה כדי לא לתלות את התוצאה ברגע מקרי.
  for (let i = 0; i < 50; i++) {
    const iso = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    assert.ok(iso.endsWith(".000Z"), `חותם עם מילישניות: ${iso}`);
  }
});

// ============================================================
// 2. דיוק הזמינות — שתי ספרות אחרי הנקודה
// ============================================================
// ⚠️ זהו **המדד הראשי** במערכת, והוא מוצג בכרטיס, בדוחות ובמסך המנהל.
// `tests/availability.test.js` מקבע את ההגדרה (מי בְּמונה ומי במכנה) —
// ולא את הדיוק. שינוי מ-‎*10000/100 ל-‎*100 מעגל לאחוז שלם, מזיז כל מספר
// במערכת, ולא מפיל שום בדיקה.
test("⚠️ הזמינות מעוגלת לשתי ספרות, לא לאחוז שלם", async () => {
  // ⚠️ pathToFileURL ולא בנייה ידנית של "file://" + נתיב: בחלונות הנתיב
  // מכיל בקסלאשים, ו-import() דורש URL תקין. גם חוסך regex שנוטה להישבר
  // בדיוק בתו הזה.
  const { pathToFileURL } = require("node:url");
  const { availabilityFrom } = await import(
    pathToFileURL(path.resolve(ROOT, "..", "shared", "executive.mjs")).href);

  // 2 מתוך 3 = 66.666…% — מספר שמבחין בין שתי ספרות לאחוז שלם.
  const r = availabilityFrom({ ready: 2000, error: 1000 });
  assert.strictEqual(r.availabilityPercent, 66.67);
  assert.strictEqual(r.measuredMs, 3000);

  // ⚠️ ומקרה שני שמבדיל גם בין שתי ספרות לספרה אחת: 1/3.
  assert.strictEqual(availabilityFrom({ ready: 1000, error: 2000 }).availabilityPercent, 33.33);

  // ואפס נמדד → אפס, ולא 100. "לא נמדד" אינו "מושלם".
  assert.strictEqual(availabilityFrom({}).availabilityPercent, 0);
  assert.strictEqual(availabilityFrom({}).measuredMs, 0);
});
