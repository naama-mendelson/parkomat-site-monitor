// tests/lwt-order.test.js — C5/C6: צוואה מאוחרת לא דורסת מצב טרי.

const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldApplyNoComm, LWT_MIN_SILENCE_SECONDS } = require("../ingestion/lwt-order");

const NOW_MS = Date.parse("2026-07-26T12:00:00.000Z");
const agoSeconds = (s) => new Date(NOW_MS - s * 1000).toISOString();

// ===== התרחיש שהתבקש: צוואה מאוחרת אחרי מצב חדש יותר =====

test("C5: האתר דיווח לפני 5 שניות — צוואה מאוחרת נדחית", () => {
  const v = shouldApplyNoComm(agoSeconds(5), NOW_MS);
  assert.equal(v.apply, false, "אסור לסמן no_comm אתר שדיווח לפני רגע");
  assert.match(v.reason, /מאוחרת/);
  assert.equal(v.silenceSeconds, 5);
});

test("C5: האתר דיווח לפני 30 שניות — עדיין בתוך חלון ה-keepalive, נדחית", () => {
  assert.equal(shouldApplyNoComm(agoSeconds(30), NOW_MS).apply, false);
});

test(`C5: שנייה אחת לפני הגבול (${LWT_MIN_SILENCE_SECONDS}s) — עדיין נדחית`, () => {
  const v = shouldApplyNoComm(agoSeconds(LWT_MIN_SILENCE_SECONDS - 1), NOW_MS);
  assert.equal(v.apply, false);
});

// ===== נתק אמיתי חייב לעבור =====

test(`C5: שתיקה של ${LWT_MIN_SILENCE_SECONDS}s בדיוק — נתק אמיתי, מוחל`, () => {
  const v = shouldApplyNoComm(agoSeconds(LWT_MIN_SILENCE_SECONDS), NOW_MS);
  assert.equal(v.apply, true, "1.5 × keepalive — זה בדיוק מתי שהברוקר מכריז על מוות");
});

test("C5: שתיקה של 5 דקות — מוחל", () => {
  assert.equal(shouldApplyNoComm(agoSeconds(300), NOW_MS).apply, true);
});

test("C5: שתיקה של 4 ימים (הנפילה האמיתית של 22-26/07) — מוחל", () => {
  assert.equal(shouldApplyNoComm("2026-07-22T13:25:50.000Z", NOW_MS).apply, true);
});

test("C5: אתר שמעולם לא נשמע — מוחל (אין ידיעה טרייה שסותרת)", () => {
  assert.equal(shouldApplyNoComm(null, NOW_MS).apply, true);
  assert.equal(shouldApplyNoComm(undefined, NOW_MS).apply, true);
});

test("C5: last_seen פגום — לא חוסם נתק", () => {
  assert.equal(shouldApplyNoComm("not-a-date", NOW_MS).apply, true);
});

// ===== last_seen עתידי (שריד מסחיפת שעון לפני היישור) =====

test("C5: last_seen בעתיד — חוסם זמנית, ולא לנצח", () => {
  const future = new Date(NOW_MS + 34_000).toISOString();
  assert.equal(shouldApplyNoComm(future, NOW_MS).apply, false,
    "נראה כמו 'נשמע עכשיו' — חוסם");

  // אבל ברגע שהזמן עבר את הסטייה, נתק אמיתי כן עובר.
  assert.equal(shouldApplyNoComm(future, NOW_MS + 200_000).apply, true,
    "אחרי שהזמן השיג את החותם, הנתק מוחל — אין נעילה קבועה");
});

// ===== העיקרון =====

test("C5: הכלל סימטרי — רק אורך השתיקה קובע, לא זהות האתר", () => {
  for (const s of [0, 1, 89]) {
    assert.equal(shouldApplyNoComm(agoSeconds(s), NOW_MS).apply, false, `${s}s`);
  }
  for (const s of [90, 91, 3600]) {
    assert.equal(shouldApplyNoComm(agoSeconds(s), NOW_MS).apply, true, `${s}s`);
  }
});
