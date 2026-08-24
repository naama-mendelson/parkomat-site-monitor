// tests/skipped-write.test.js — כתיבה שנחסמה לא מדווחת ולא משודרת.
//
// ============================================================
// ⚠️ הבאג שזה מקבע, ואיך הוא נמצא
// ============================================================
// `applyStateChange` מחזיר `{skipped:"backfill"}` או `{skipped:"no_change"}`
// כשגארד בתוך הטרנזקציה חוסם את הכתיבה. הערך הזה **הוזנח** ב-state-handler
// וב-operation-handler, ולכן שניהם:
//
//   1. הדפיסו "(שינוי נרשם)" כשלא נרשם דבר — **הלוג שיקר**;
//   2. שידרו ב-`bus.publish` מצב שאינו במסד — הכרטיס במסך התהפך, וברענון
//      חזר לאחור. מסך ומסד עם שני מצבים שונים לאותו אתר.
//
// ⚠️ **וזה נמצא בזמן חקירה של תקלה אמיתית שאבדה.** אתר היה בתקלה שלוש
// שעות והמסך הראה "בפעולה"; הלוג היה הכלי לאבחון, והוא לא היה ראוי לאמון.
//
// ⚠️ ו-`bridge-handler.js` **כן** בדק את התוצאה מאז ומתמיד, עם הערה
// שמסבירה למה זה חובה. מקום אחד למד את הלקח ושניים לא — וזה מה שנבדק כאן.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const QUERIES = require.resolve("../db/queries");
const BUS = require.resolve("../bus");
const STATE_HANDLER = require.resolve("../ingestion/state-handler");

const stub = (filename, exports) => {
  require.cache[filename] = {
    id: filename, filename, path: path.dirname(filename),
    loaded: true, children: [], paths: [], exports,
  };
};

/**
 * טוען state-handler טרי מעל שכבת מסד מזויפת.
 * `applyResult` הוא מה ש-applyStateChange יחזיר.
 */
function loadHandler(applyResult) {
  const published = [];
  const calls = { applyStateChange: 0, lastSeen: 0 };

  stub(QUERIES, {
    updateLastSeenIfNewer: async () => { calls.lastSeen++; },
    applyStateChange: async () => { calls.applyStateChange++; return applyResult; },
    // מקטע פתוch מוקדם יותר — כדי שגארד ה-backfill שבמטפל עצמו לא יחסום.
    getOpenStatusStartedAt: async () => "2026-01-01T00:00:00.000Z",
    getActiveMaintenance: async () => null,
    insertSuppressedFault: async () => {},
  });
  stub(BUS, { publish: (msg) => published.push(msg) });
  delete require.cache[STATE_HANDLER];
  const { handleState } = require(STATE_HANDLER);

  return { handleState, published, calls };
}

const SITE = { id: 7, code: "1284", status: "operating" };
const ERROR_MSG = { state: "error", timestamp: 1787481855 };

test("⚠️ כתיבה שנחסמה (backfill) — לא משודרת לדשבורד", async () => {
  const { handleState, published, calls } = loadHandler({ skipped: "backfill" });
  await handleState(SITE, ERROR_MSG);

  assert.equal(calls.applyStateChange, 1, "applyStateChange לא נקרא בכלל");
  // ⚠️ זו השורה שנפלה לפני התיקון: המצב שודר למרות שלא נכתב.
  assert.deepEqual(published, [], "שודר אירוע על מצב שלא נכתב למסד");
});

test("⚠️ כתיבה שנחסמה (no_change) — לא משודרת לדשבורד", async () => {
  const { handleState, published } = loadHandler({ skipped: "no_change" });
  await handleState(SITE, ERROR_MSG);
  assert.deepEqual(published, [], "שודר אירוע על מצב שלא נכתב למסד");
});

test("כתיבה שהצליחה — כן משודרת, ועם המצב הנכון", async () => {
  const { handleState, published } = loadHandler({ applied: true });
  await handleState(SITE, ERROR_MSG);

  assert.equal(published.length, 1, "כתיבה שהצליחה חייבת להישדר");
  assert.equal(published[0].type, "state");
  assert.equal(published[0].newStatus, "error");
  assert.equal(published[0].code, "1284");
});

test("⚠️ תקלה עם טקסט — הטקסט נכלל בשידור", () => {
  // ⚠️ לא רק ב-DB: הכרטיס במסך מתעדכן מה-SSE/Realtime בלי רענון, ובלי
  // השדה הזה התקלה הייתה מופיעה מיד והתיאור שלה רק ברענון הבא.
  const { handleState, published } = loadHandler({ applied: true });
  return handleState(SITE, { state: "error", timestamp: 1787481855, faultText: "מעלית - תקלה" })
    .then(() => {
      assert.equal(published.length, 1);
      assert.equal(published[0].faultText, "מעלית - תקלה");
    });
});

test("⚠️ שלושת הקוראים של applyStateChange בודקים את התוצאה", () => {
  // ============================================================
  // בדיקה מבנית, ובכוונה
  // ============================================================
  // הבדיקות למעלה מכסות את state-handler. operation-handler מסנכרן מצב
  // מהודעת `start` ובלע את אותה תוצאה בדיוק, ובניית תרחיש התנהגותי לו
  // דורשת חצי שכבת המסד. סריקת הטקסט תופסת בזול את הרגרסיה האמיתית:
  // מישהו שמחזיר `await applyStateChange(...)` בלי לבדוק.
  const fs = require("node:fs");
  for (const file of ["state-handler.js", "operation-handler.js", "bridge-handler.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "ingestion", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    const bare = /(?<![\w.])await applyStateChange\(/.test(src)
      && !/=\s*await applyStateChange\(/.test(src);
    assert.equal(bare, false, `${file}: קורא ל-applyStateChange בלי לבדוק את התוצאה`);
    assert.match(src, /skipped/, `${file}: אינו מתייחס ל-skipped בכלל`);
  }
});
