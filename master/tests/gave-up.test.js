// tests/gave-up.test.js — נטישה אחרי ניסיונות חוזרים משאירה עקבות.
//
// ============================================================
// ⚠️ מסלול האובדן האמיתי, וכל האחרים רעש לידו
// ============================================================
// `handleMessage` מנסה חמש פעמים ואז עושה **`return`** — לא `throw`.
// ובכוונה: הודעה תקולה שתיזרק שוב תחזור בכל חיבור מחדש ותחסום את התור.
//
// אבל התוצאה היא שהמנוי נכנס לענף ה**הצלחה**, שולח PUBACK, וההודעה נמחקת
// מ-HiveMQ לתמיד — בזמן שהוא כלל לא ידע שמשהו נכשל. ולכן `recordIngestDrop`
// שהוסף במנוי לא כיסה את זה: הוא תלוי בזריקה, וכאן אין זריקה.
//
// ⚠️ **נמדד ב-23.08:** שתי הודעות בהפרש שתי מילישניות, אחת נקלטה והשנייה
// נעלמה. הפער בין השידור לרישום היה 7.13 שניות — וסך ה-backoff של חמישה
// ניסיונות (3.75ש') בתוספת חמש כתיבות למסד נותן 4.2–15.7 שניות.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const QUERIES = require.resolve("../db/queries");
const DISPATCHER = require.resolve("../ingestion/dispatcher");
const STATE_H = require.resolve("../ingestion/state-handler");
const OP_H = require.resolve("../ingestion/operation-handler");
const BRIDGE_H = require.resolve("../ingestion/bridge-handler");

const stub = (filename, exports) => {
  require.cache[filename] = {
    id: filename, filename, path: path.dirname(filename),
    loaded: true, children: [], paths: [], exports,
  };
};

function load({ failForever }) {
  const drops = [];
  stub(QUERIES, {
    findSiteByCode: async () => ({ id: 7, code: "1284", status: "operating", registered_at: "2026-01-01T00:00:00.000Z" }),
    recordIngestDrop: (row) => { drops.push(row); },
  });
  // ⚠️ המטפל נכשל **תמיד** — מדמה ECONNRESET מתמשך, שהוא בדיוק מה שנמדד.
  stub(STATE_H, { handleState: async () => { if (failForever) throw new Error("ECONNRESET"); } });
  stub(OP_H, { handleOperation: async () => {} });
  stub(BRIDGE_H, { handleBridgeState: async () => {} });
  delete require.cache[DISPATCHER];
  return { ...require(DISPATCHER), drops };
}

const PAYLOAD = JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), state: "error" });

test("⚠️ נטישה אחרי 5 ניסיונות — נרשמת, עם המטען", async () => {
  const { handleMessage, drops } = load({ failForever: true });

  // ⚠️ **הפונקציה נפתרת בהצלחה** — זו כל הבעיה. המנוי יאשר ל-HiveMQ.
  await assert.doesNotReject(() => handleMessage("sites/1284/state", PAYLOAD));

  const gaveUp = drops.filter((d) => d.reason === "gave_up_after_retries");
  assert.equal(gaveUp.length, 1, "הנטישה לא נרשמה — ההודעה נעלמת בלי עקבות");
  assert.equal(gaveUp[0].payload, PAYLOAD, "המטען לא נשמר — אין מה להשוות ואין מה לשדר מחדש");
  assert.equal(gaveUp[0].siteCode, "1284");
  assert.match(gaveUp[0].detail, /ECONNRESET/, "הסיבה המקורית אבדה");
});

test("הודעה שעברה — אינה נרשמת כזריקה", async () => {
  const { handleMessage, drops } = load({ failForever: false });
  await handleMessage("sites/1284/state", PAYLOAD);
  assert.equal(drops.filter((d) => d.reason === "gave_up_after_retries").length, 0,
    "הודעה שהצליחה נרשמה כזריקה — התראות שווא");
});

test("⚠️ כשל ברישום אינו הופך דחייה לסערת ניסיונות", async () => {
  // ============================================================
  // הכלל שנאכף כאן, ואיך הוא נתגלה
  // ============================================================
  // `recordIngestDrop` נקרא מתוך ה-try של dispatch. כל זריקה ממנו מתפשטת
  // ל-handleMessage, שמפרש אותה כשגיאת **עיבוד** — מנסה חמש פעמים עם
  // backoff (3.75ש') ואז רושם "נטישה". כלומר דחייה נקייה ומכוונת הופכת
  // לסערת ניסיונות ולדיווח שגוי על אובדן.
  //
  // ⚠️ **נתפס בפועל:** שמונה בדיקות דיספאצ'ר שעברו קודם התחילו לקחת
  // 3,780ms כל אחת — בדיוק ה-backoff — כי ה-stub שלהן לא כלל את הפונקציה.
  // זו הייתה הפרה של כלל שהוצהר בהערה ולא נאכף בקוד.
  const drops = [];
  stub(QUERIES, {
    findSiteByCode: async () => undefined,   // אתר לא רשום → מסלול דחייה
    recordIngestDrop: () => { throw new Error("המסד לא זמין"); },
  });
  stub(STATE_H, { handleState: async () => {} });
  stub(OP_H, { handleOperation: async () => {} });
  stub(BRIDGE_H, { handleBridgeState: async () => {} });
  delete require.cache[DISPATCHER];
  const { handleMessage } = require(DISPATCHER);

  const started = Date.now();
  await handleMessage("sites/9999/state", PAYLOAD);
  const elapsed = Date.now() - started;

  // ⚠️ הסף הוא הראיה: 3,750ms הוא סך ה-backoff של חמישה ניסיונות. כל דבר
  // מתחת לשנייה אומר שהדחייה נשארה דחייה.
  assert.ok(elapsed < 1000,
    `הדחייה לקחה ${elapsed}ms — כשל ברישום גרר ניסיונות חוזרים`);
  assert.equal(drops.length, 0, "ה-stub הזורק לא היה אמור לרשום דבר");
});
