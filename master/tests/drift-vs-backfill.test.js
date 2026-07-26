// tests/drift-vs-backfill.test.js — שכבה 2: יישור דו-כיווני מול backfill אמיתי.
//
// זו הבדיקה החשובה בקבוצה: היא מקבעת את הגבול שבו השרת מפסיק "לתקן" ומתחיל
// לשמר. אם מישהו יעלה את PAST_CLAMP_MAX_SECONDS מדי, הבדיקות של ה-backfill
// ייכשלו — וזו בדיוק המטרה.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyTimestamp,
  FUTURE_CLAMP_MAX_SECONDS,
  PAST_CLAMP_MAX_SECONDS,
  PAST_CLAMP_MIN_SECONDS,
} = require("../ingestion/plausibility");
const replay = require("../ingestion/replay-window");

const NOW_MS = Date.parse("2026-07-26T12:00:00.000Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);
const REGISTERED = Date.parse("2026-07-01T00:00:00Z");

// בשגרה (לא בחלון פריקה) — כאן יישור-לאחור מותר.
const steady = { allowPastClamp: true };
// בחלון פריקה — כאן הוא אסור.
const draining = { allowPastClamp: false };

// ============================================================
// שעון שמפגר — המקרה של אתר 2439
// ============================================================

test("שכבה 2: אתר 2439 מפגר ב-235s — מיושר בשגרה", () => {
  const v = classifyTimestamp(NOW_SEC - 235, NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "clamp", "פיגור של 235s חייב להיות מתוקן — זה כל הפואנטה");
  assert.equal(v.classification, "drift_past");
  assert.equal(v.effectiveSec, NOW_SEC, "יושר לזמן השרת");
  assert.equal(v.skewSeconds, -235);
});

// ===== רצפת היישור: השהיית מסלול איננה סחיפה =====
// נתפס על תנועה אמיתית: הגרסה הראשונה יישרה פיגור של שנייה אחת באתר 3513,
// כלומר החליפה זמן אירוע *נכון* בזמן ההגעה. זה הוריד דיוק בכל הודעה מכל אתר
// תקין. הבדיקות האלה מקבעות את הרצפה כדי שזה לא יחזור.

test("רצפה: פיגור של 1s (השהיית מסלול נורמלית) — לא מיושר", () => {
  const v = classifyTimestamp(NOW_SEC - 1, NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "accept", "החותם המקורי מדויק יותר מזמן ההגעה");
  assert.equal(v.effectiveSec, NOW_SEC - 1);
  assert.equal(v.classification, "ok");
});

test("רצפה: פיגור של 6s (המקסימום שנמדד באתרים תקינים) — לא מיושר", () => {
  const v = classifyTimestamp(NOW_SEC - 6, NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "accept");
  assert.equal(v.effectiveSec, NOW_SEC - 6);
});

test(`רצפה: בדיוק על הרצפה (${PAST_CLAMP_MIN_SECONDS}s) — עוד לא מיושר`, () => {
  const v = classifyTimestamp(NOW_SEC - PAST_CLAMP_MIN_SECONDS, NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "accept");
});

test(`רצפה: שנייה אחת מעל הרצפה (${PAST_CLAMP_MIN_SECONDS + 1}s) — מיושר`, () => {
  const v = classifyTimestamp(NOW_SEC - (PAST_CLAMP_MIN_SECONDS + 1), NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "clamp");
  assert.equal(v.classification, "drift_past");
});

test("שכבה 2: פיגור מינימלי של אתר 2439 (62s) — מיושר", () => {
  const v = classifyTimestamp(NOW_SEC - 62, NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "clamp");
});

test(`שכבה 2: בדיוק על תקרת העבר (${PAST_CLAMP_MAX_SECONDS}s) — עוד מיושר`, () => {
  const v = classifyTimestamp(NOW_SEC - PAST_CLAMP_MAX_SECONDS, NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "clamp");
});

// ============================================================
// שעון שמקדים — ללא שינוי מהתנהגות קודמת
// ============================================================

test("שכבה 2: אתר 1343 מקדים ב-34s — מיושר (גם בחלון פריקה)", () => {
  for (const opts of [steady, draining]) {
    const v = classifyTimestamp(NOW_SEC + 34, NOW_MS, REGISTERED, opts);
    assert.equal(v.action, "clamp", "עתיד חד-משמעי — תמיד בטוח ליישר");
    assert.equal(v.classification, "drift_future");
    assert.equal(v.effectiveSec, NOW_SEC);
  }
});

test(`שכבה 2: מעל תקרת העתיד (${FUTURE_CLAMP_MAX_SECONDS}s) — נדחה`, () => {
  const v = classifyTimestamp(NOW_SEC + FUTURE_CLAMP_MAX_SECONDS + 1, NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "reject");
});

// ============================================================
// backfill אמיתי — חייב לשרוד בלי נגיעה
// ============================================================

test("backfill: גל השלמה אמיתי של 14.5 שעות — נשמר בדיוק, גם בשגרה", () => {
  const occurred = Math.floor(Date.parse("2026-07-25T21:30:00Z") / 1000);
  const v = classifyTimestamp(occurred, NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "accept", "אסור לגעת — זה זמן ההתרחשות האמיתי");
  assert.equal(v.classification, "backfill");
  assert.equal(v.effectiveSec, occurred, "החותם יוצא בדיוק כפי שנכנס");
});

test("backfill: הנפילה האמיתית של 3.6 ימים — נשמר", () => {
  const occurred = Math.floor(Date.parse("2026-07-22T13:25:23Z") / 1000);
  const v = classifyTimestamp(occurred, NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "accept");
  assert.equal(v.effectiveSec, occurred);
});

test(`backfill: שנייה אחת מעל תקרת העבר (${PAST_CLAMP_MAX_SECONDS + 1}s) — נשמר`, () => {
  const occurred = NOW_SEC - (PAST_CLAMP_MAX_SECONDS + 1);
  const v = classifyTimestamp(occurred, NOW_MS, REGISTERED, steady);
  assert.equal(v.action, "accept");
  assert.equal(v.classification, "backfill");
  assert.equal(v.effectiveSec, occurred, "הגבול הוא הגבול — מכאן לא נוגעים");
});

test("backfill: בחלון פריקה גם עבר *רדוד* נשמר — זו ההגנה על גל קצר", () => {
  const occurred = NOW_SEC - 45;   // מתחת לתקרה, כלומר היה מיושר בשגרה
  const steadyV = classifyTimestamp(occurred, NOW_MS, REGISTERED, steady);
  const drainV = classifyTimestamp(occurred, NOW_MS, REGISTERED, draining);

  assert.equal(steadyV.action, "clamp", "בשגרה — סחיפה, מיישרים");
  assert.equal(drainV.action, "accept", "בפריקה — backfill, משמרים");
  assert.equal(drainV.effectiveSec, occurred);
});

// ============================================================
// אבסורדי — נדחה בשני המצבים
// ============================================================

test("אבסורדי: אפוק-אפס / שנה בעתיד / לפני רישום — נדחים בשני המצבים", () => {
  const cases = [
    ["אפוק-אפס", 0],
    ["שנה בעתיד", Math.floor(Date.parse("2027-07-26T12:00:00Z") / 1000)],
    ["לפני רישום", Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000)],
  ];
  for (const [label, ts] of cases) {
    for (const opts of [steady, draining]) {
      assert.equal(classifyTimestamp(ts, NOW_MS, REGISTERED, opts).action, "reject", label);
    }
  }
});

// ============================================================
// ברירת המחדל חייבת להיות הזהירה
// ============================================================

test("ברירת מחדל (בלי opts) אינה מיישרת לאחור — fail-safe", () => {
  const v = classifyTimestamp(NOW_SEC - 100, NOW_MS, REGISTERED);
  assert.equal(v.action, "accept",
    "קורא ששוכח להעביר allowPastClamp לא אמור לשכתב זמנים בשוגג");
});

// ============================================================
// חלון הפריקה עצמו
// ============================================================

test("חלון פריקה: לפני שהיה חיבור בכלל — נחשב פריקה (זהיר)", () => {
  replay._reset();
  assert.equal(replay.isLikelyReplay(NOW_MS), true);
});

test("חלון פריקה: מיד אחרי חיבור — פריקה", () => {
  replay._reset();
  replay.markBrokerConnected(NOW_MS);
  assert.equal(replay.isLikelyReplay(NOW_MS), true);
  assert.equal(replay.isLikelyReplay(NOW_MS + 1000), true);
});

test(`חלון פריקה: אחרי ${replay.REPLAY_GRACE_SECONDS}s — שגרה`, () => {
  replay._reset();
  replay.markBrokerConnected(NOW_MS);
  const after = NOW_MS + replay.REPLAY_GRACE_SECONDS * 1000;
  assert.equal(replay.isLikelyReplay(after - 1), true);
  assert.equal(replay.isLikelyReplay(after), false, "מכאן חותם ישן = סחיפה");
});

test("חלון פריקה: חיבור-מחדש פותח אותו שוב", () => {
  replay._reset();
  replay.markBrokerConnected(NOW_MS);
  const later = NOW_MS + 10 * 60 * 1000;
  assert.equal(replay.isLikelyReplay(later), false);
  replay.markBrokerConnected(later);              // נפילה וחיבור מחדש
  assert.equal(replay.isLikelyReplay(later), true, "הגל הבא מוגן שוב");
});
