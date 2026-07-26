// tests/plausibility.test.js — C3: חותמי זמן, שתי דרגות (יישור מול דחייה).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyTimestamp,
  FUTURE_CLAMP_MAX_SECONDS,
  SKEW_WARN_SECONDS,
  REGISTRATION_GRACE_SECONDS,
} = require("../ingestion/plausibility");

// זמן קבוע — הבדיקות דטרמיניסטיות.
const NOW_MS = Date.parse("2026-07-26T12:00:00.000Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

// ===== מקבלים כמות שהוא =====

test("חותם נוכחי — accept, בלי אזהרה", () => {
  const v = classifyTimestamp(NOW_SEC, NOW_MS);
  assert.equal(v.action, "accept");
  assert.equal(v.effectiveSec, NOW_SEC);
  assert.equal(v.warn, false);
});

test("עבר קרוב — accept (זו הקליטה הרגילה: אחרי האירוע)", () => {
  const v = classifyTimestamp(NOW_SEC - 3, NOW_MS);
  assert.equal(v.action, "accept");
  assert.equal(v.effectiveSec, NOW_SEC - 3, "עבר לא מיושר — הוא נכון");
});

test("עבר רחוק (replay מהתור, 4 ימים) — accept ללא שינוי", () => {
  const past = sec("2026-07-22T13:25:23Z");
  const v = classifyTimestamp(past, NOW_MS, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(v.action, "accept");
  assert.equal(v.effectiveSec, past, "השלמה מהתור חייבת לשמור על זמן האירוע");
});

// ===== דרגה 1: מיישרים ומקבלים =====

test("C3: סחיפת אתר 1343 (+34s) — clamp לזמן השרת, לא נדחה", () => {
  const v = classifyTimestamp(NOW_SEC + 34, NOW_MS);
  assert.equal(v.action, "clamp", "דחייה הייתה מוחקת את כל הדיווח של האתר");
  assert.equal(v.effectiveSec, NOW_SEC, "מיושר לשנייה השלמה של השרת");
  assert.equal(v.skewSeconds, 34);
  assert.equal(v.warn, true, "וגלוי בלוג");
});

test("C3: סחיפת אתר 2439 (+70s) — clamp", () => {
  const v = classifyTimestamp(NOW_SEC + 70, NOW_MS);
  assert.equal(v.action, "clamp");
  assert.equal(v.effectiveSec, NOW_SEC);
});

test("C3: אתר 3513 (-20s) — בברירת המחדל *לא* מיושר (fail-safe)", () => {
  // ⚠️ זו ברירת המחדל הזהירה בלבד (allowPastClamp לא הועבר). התנהגות היישור
  // לאחור בשגרה נבדקת ב-drift-vs-backfill.test.js — שם הפיגור *כן* מיושר.
  const v = classifyTimestamp(NOW_SEC - 20, NOW_MS);
  assert.equal(v.action, "accept");
  assert.equal(v.effectiveSec, NOW_SEC - 20);
  assert.equal(v.warn, true);
});

test(`בדיוק על גבול היישור (${FUTURE_CLAMP_MAX_SECONDS}s) — עוד clamp`, () => {
  const v = classifyTimestamp(NOW_SEC + FUTURE_CLAMP_MAX_SECONDS, NOW_MS);
  assert.equal(v.action, "clamp");
});

test("שנייה אחת מעל הגבול — reject", () => {
  const v = classifyTimestamp(NOW_SEC + FUTURE_CLAMP_MAX_SECONDS + 1, NOW_MS);
  assert.equal(v.action, "reject");
  assert.match(v.reason, /בעתיד/);
});

test("היישור תמיד לשנייה שלמה (החוזה הוא unix-שניות)", () => {
  // "עכשיו" באמצע שנייה — התוצאה חייבת להיות שלמה, אחרת resync של הסוכן
  // ייראה מוקדם ממנה ויידחה כ-backfill.
  const v = classifyTimestamp(NOW_SEC + 10, NOW_MS + 456);
  assert.equal(Number.isInteger(v.effectiveSec), true);
  assert.equal(v.effectiveSec, NOW_SEC);
});

// ===== דרגה 2: דוחים =====

test("C3: אפוק-אפס (timestamp=0) — reject", () => {
  const v = classifyTimestamp(0, NOW_MS);
  assert.equal(v.action, "reject");
  assert.match(v.reason, /לפני 2020|לא מאותחל/);
});

test("C3: חותם 1970 — reject", () => {
  const v = classifyTimestamp(sec("1970-01-05T00:00:00Z"), NOW_MS);
  assert.equal(v.action, "reject");
});

test("C3: חותם במילישניות שנשלח בטעות — reject", () => {
  const v = classifyTimestamp(Date.now(), NOW_MS);   // ms במקום s
  assert.equal(v.action, "reject");
  assert.match(v.reason, /2100|מילישניות/);
});

test("C3: שעה בעתיד — reject", () => {
  assert.equal(classifyTimestamp(NOW_SEC + 3600, NOW_MS).action, "reject");
});

test("C3: שנה בעתיד — reject", () => {
  assert.equal(classifyTimestamp(sec("2027-07-26T12:00:00Z"), NOW_MS).action, "reject");
});

test("C3: לא מספר — reject", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(classifyTimestamp(bad, NOW_MS).action, "reject", `${bad}`);
  }
});

// ===== לפני רישום האתר =====

test("C3: חותם לפני רישום האתר — reject", () => {
  const v = classifyTimestamp(
    sec("2026-06-15T00:00:00Z"), NOW_MS, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(v.action, "reject");
  assert.match(v.reason, /לפני רישום/);
});

test("הדיווח הראשון של אתר טרי — עובר את מרווח החסד", () => {
  const registeredAt = Date.parse("2026-07-26T11:59:59Z");
  const v = classifyTimestamp(sec("2026-07-26T11:59:58Z"), NOW_MS, registeredAt);
  assert.equal(v.action, "accept", `מרווח של ${REGISTRATION_GRACE_SECONDS}s חייב לכסות`);
});

test("registeredAt חסר/פגום — לא חוסם", () => {
  assert.equal(classifyTimestamp(NOW_SEC, NOW_MS, null).action, "accept");
  assert.equal(classifyTimestamp(NOW_SEC, NOW_MS, NaN).action, "accept");
});

test(`סף האזהרה ${SKEW_WARN_SECONDS}s — לשני הכיוונים`, () => {
  assert.equal(classifyTimestamp(NOW_SEC + SKEW_WARN_SECONDS - 1, NOW_MS).warn, false);
  assert.equal(classifyTimestamp(NOW_SEC + SKEW_WARN_SECONDS, NOW_MS).warn, true);
  assert.equal(classifyTimestamp(NOW_SEC - SKEW_WARN_SECONDS, NOW_MS).warn, true);
});

// ===== האינטראקציה עם dedup — הסיבה שהיישור בטוח =====

test("C1×C3: יישור אינו יציב בין מסירות — ולכן dedup חייב להיות על החותם המקורי", () => {
  const reported = NOW_SEC + 34;

  // אותה הודעה, שתי מסירות, 70 שניות הפרש (בדיוק גודל הפער שנמדד בשטח).
  const first = classifyTimestamp(reported, NOW_MS);
  const second = classifyTimestamp(reported, NOW_MS + 70_000);

  assert.notEqual(first.effectiveSec, second.effectiveSec,
    "occurred_at המיושר *משתנה* בין מסירות — זו בדיוק הסיבה שאסור לו להיות המפתח");

  // מה שכן יציב: החותם המקורי. הוא זה שנכתב ל-reported_at ועליו האינדקס
  // ux_operations_dedup — ולכן המסירה השנייה נחסמת.
  assert.equal(reported, reported);
});
