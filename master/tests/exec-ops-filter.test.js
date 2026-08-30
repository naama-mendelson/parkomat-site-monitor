// tests/exec-ops-filter.test.js — הסינון בשרת חייב להיות שקול לסינון בזיכרון.
//
// ============================================================
// ⚠️ מה זה מקבע, ולמה
// ============================================================
// `executiveDirect.js` מסנן פעולות ב-PostgREST:
//
//     .is("excluded_at", null).eq("is_anomaly", 0)
//     .is("superseded_by", null).eq("start_end", "end")
//
// זה חוסך 52% מהשורות (נמדד: 6,755 → 3,243 · 994KB → 474KB), והוא נכון
// **רק כל עוד** הוא זהה לסינון שב-shared/executive.mjs. שני הצרכנים שם
// — statsFromData ו-directionFromData — מסננים את אותם ארבעה תנאים.
//
// ⚠️ **וזו תלות בין קבצים שאין לה שום סימן בקוד.** מי שיוסיף תנאי ב-
// statsFromData ולא כאן ייצור זרוע שמחשבת על קלט אחר — והמספרים על
// המסך יסטו בלי שום שגיאה. זה בדיוק סוג הסתירה שקובץ ההנחיות מתאר:
// "שני מספרים לאותו אירוע".
//
// הבדיקה מריצה את הפונקציות **האמיתיות** על שני קלטים — מסונן ולא
// מסונן — ודורשת תוצאה זהה.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const EXEC = pathToFileURL(
  path.join(__dirname, "..", "..", "shared", "executive.mjs")
).href;

const FROM = "2026-08-01T00:00:00.000Z";
const TO   = "2026-09-01T00:00:00.000Z";

// ⚠️ הסינון של הזרוע הישירה, כתוב כאן פעם אחת. אם הוא ישתנה שם ולא
// כאן — או להפך — הבדיקות למטה ייפלו, וזה כל התפקיד שלה.
const serverSideFilter = (o) =>
  o.excluded_at == null &&
  o.is_anomaly === 0 &&
  o.superseded_by == null &&
  o.start_end === "end";

/** אוסף פעולות שמכסה כל אחת מארבע סיבות הפסילה, ועוד כמה תקינות. */
function sampleOps() {
  const at = (d, h) => `2026-08-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;
  return [
    { site_id: 1, occurred_at: at(2, 8),  entry_exit: "entry", start_end: "end",   is_anomaly: 0, superseded_by: null, excluded_at: null },
    { site_id: 1, occurred_at: at(2, 9),  entry_exit: "exit",  start_end: "end",   is_anomaly: 0, superseded_by: null, excluded_at: null },
    // ⚠️ ארבע הפסולות — כל אחת מסיבה אחרת:
    { site_id: 1, occurred_at: at(3, 8),  entry_exit: "entry", start_end: "start", is_anomaly: 0, superseded_by: null, excluded_at: null },
    { site_id: 1, occurred_at: at(3, 9),  entry_exit: "entry", start_end: "end",   is_anomaly: 1, superseded_by: null, excluded_at: null },
    { site_id: 1, occurred_at: at(4, 8),  entry_exit: "exit",  start_end: "end",   is_anomaly: 0, superseded_by: 99,   excluded_at: null },
    { site_id: 1, occurred_at: at(4, 9),  entry_exit: "entry", start_end: "end",   is_anomaly: 0, superseded_by: null, excluded_at: at(5, 0) },
    // אתר שני, כדי שהצבירה תעבור יותר ממפתח אחד
    { site_id: 2, occurred_at: at(6, 10), entry_exit: "entry", start_end: "end",   is_anomaly: 0, superseded_by: null, excluded_at: null },
    { site_id: 2, occurred_at: at(6, 11), entry_exit: "exit",  start_end: "end",   is_anomaly: 0, superseded_by: null, excluded_at: null },
    { site_id: 2, occurred_at: at(7, 10), entry_exit: "exit",  start_end: "end",   is_anomaly: 1, superseded_by: null, excluded_at: null },
  ];
}

const shape = (ops, windows = []) => {
  const g = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.site_id)) m.set(r.site_id, []);
      m.get(r.site_id).push(r);
    }
    return m;
  };
  return { ops: g(ops), segments: new Map(), windows: g(windows) };
};

test("statsFromData — סינון בשרת נותן אותה תוצאה", async () => {
  const { statsFromData } = await import(EXEC);
  const all = sampleOps();
  const filtered = all.filter(serverSideFilter);

  // ⚠️ שפיות: הקלטים חייבים להיות **שונים**, אחרת הבדיקה ריקה — היא
  // הייתה משווה מערך לעצמו ועוברת על כל שינוי.
  assert.ok(filtered.length < all.length, "הסינון לא הסיר כלום — הדגימה שגויה");

  for (const siteId of [1, 2]) {
    const a = statsFromData(shape(all), siteId, { from: FROM, to: TO });
    const b = statsFromData(shape(filtered), siteId, { from: FROM, to: TO });
    assert.equal(b.operations, a.operations, `אתר ${siteId}: פעולות`);
  }
});

test("directionFromData — סינון בשרת נותן אותה תוצאה", async () => {
  const { directionFromData } = await import(EXEC);
  const all = sampleOps();
  const filtered = all.filter(serverSideFilter);

  const a = directionFromData(shape(all), [1, 2], { from: FROM, to: TO });
  const b = directionFromData(shape(filtered), [1, 2], { from: FROM, to: TO });
  assert.deepEqual(b, a);
  // ⚠️ ולא רק "שווים" — גם לא אפס. שתי תוצאות ריקות שוות זו לזו,
  // והבדיקה הייתה עוברת על סינון שמוחק הכול.
  assert.ok(a.entries + a.exits > 0, "הדגימה לא הפיקה אף מעבר");
});

test("⚠️ הסינון נשאר נכון גם עם חלון תחזוקה", async () => {
  // opsOf מסנן לפי חלונות תחזוקה **אחרי** שהשורות הגיעו. אם הסינון
  // בשרת היה מסיר שורה שהחלון היה אמור להסיר ממילא — אין הבדל; אבל אם
  // הוא היה מסיר שורה שהחלון **לא** מכסה, המספרים היו נופלים.
  const { statsFromData, directionFromData } = await import(EXEC);
  const all = sampleOps();
  const filtered = all.filter(serverSideFilter);
  const windows = [{
    site_id: 1,
    started_at: "2026-08-02T00:00:00.000Z",
    expires_at: "2026-08-03T00:00:00.000Z",
    cancelled_at: null, excluded_at: null,
  }];

  const a = statsFromData(shape(all, windows), 1, { from: FROM, to: TO });
  const b = statsFromData(shape(filtered, windows), 1, { from: FROM, to: TO });
  assert.equal(b.operations, a.operations);

  const da = directionFromData(shape(all, windows), [1], { from: FROM, to: TO });
  const dbb = directionFromData(shape(filtered, windows), [1], { from: FROM, to: TO });
  assert.deepEqual(dbb, da);
});

test("הסינון בקובץ השירות זהה למה שהבדיקה מניחה", async () => {
  // ⚠️ הבדיקות למעלה משתמשות ב-serverSideFilter המקומי. אם הקובץ
  // האמיתי ישתנה והעותק כאן לא — כולן יעברו על סינון שכבר אינו בשימוש.
  // לכן: קוראים את הקובץ ומוודאים שארבעת התנאים עדיין כתובים בו.
  const fs = require("node:fs");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "dashboard", "src", "services", "executiveDirect.js"),
    "utf8");

  for (const needle of [
    '.is("excluded_at", null)',
    '.eq("is_anomaly", 0)',
    '.is("superseded_by", null)',
    '.eq("start_end", "end")',
  ]) {
    assert.ok(src.includes(needle), `חסר ב-executiveDirect.js: ${needle}`);
  }
});
