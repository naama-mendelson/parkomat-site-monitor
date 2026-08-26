// tests/cache-invalidation.test.js — הריקון שהתבטל בעצמו.
//
// ============================================================
// ⚠️ הכתיבה שבדרך דרסה את הביטול
// ============================================================
// המטמון מתרוקן בכל `siteUpdate`, וזה הכלל: נכונות קודמת למהירות. אבל
// הרצף האמיתי הוא:
//
//   בקשה נכנסת → החמצה → המסלול שולף (~115ms מהענן)
//   → באמצע מגיעה הודעה מאתר → siteUpdate → store.clear()
//   → res.json חוזר וכותב את הגוף שחושב **לפני** השינוי, עם TTL מלא
//
// כלומר הביטול המפורש בוטל בשקט, והמסך הראה 10 שניות את המצב שקדם
// לאירוע — בדיוק אחרי שה-SSE הודיע שהמצב השתנה. זה נראה כמו "הדשבורד
// לא התעדכן", הרענון הבא כבר מתקן, ולכן זה לא נחקר.
const test = require("node:test");
const assert = require("node:assert/strict");

const bus = require("../bus");
const { cache, clearCache, getCacheStats } = require("../api/cache.js");

// תגובה מזויפת שמספיקה ל-middleware: json, setHeader, statusCode, ואירועים.
function fakeRes() {
  const listeners = new Map();
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    json(b) { this.body = b; return this; },
    on(ev, fn) { listeners.set(ev, fn); return this; },
    emit(ev) { listeners.get(ev)?.(); },
  };
}
const fakeReq = (path, query = {}) => ({ method: "GET", path, query });

/** מריץ בקשה דרך ה-middleware ומחזיר את res אחרי שהמסלול ענה. */
function run(mw, req, res, handler) {
  return new Promise((resolve) => {
    mw(req, res, () => { handler(res); resolve(res); });
    if (res.headers["X-Cache"] === "HIT") resolve(res);
  });
}


test("⚠️ שינוי בזמן השליפה אינו נשמר במטמון", async () => {
  clearCache();
  const mw = cache(10_000);

  const r1 = fakeRes();
  await run(mw, fakeReq("/api/sites"), r1, (res) => {
    // בדיוק מה שקורה בשטח: הודעה מאתר נוחתת בזמן שהשאילתה רצה.
    bus.emit("siteUpdate", { code: "1284" });
    res.json({ v: "ישן" });
  });
  assert.equal(r1.headers["X-Cache"], "MISS");
  assert.deepEqual(r1.body, { v: "ישן" });

  // הבקשה הבאה **חייבת** לפנות למסלול מחדש. אם היא מקבלת HIT — הריקון בוטל.
  const r2 = fakeRes();
  let reachedHandler = false;
  await run(mw, fakeReq("/api/sites"), r2, (res) => {
    reachedHandler = true;
    res.json({ v: "חדש" });
  });

  assert.equal(r2.headers["X-Cache"], "MISS", "התשובה הישנה הוגשה אחרי הביטול");
  assert.ok(reachedHandler);
  assert.deepEqual(r2.body, { v: "חדש" });
});


test("בלי שינוי — המטמון עדיין עובד (התיקון לא כיבה אותו)", async () => {
  clearCache();
  const mw = cache(10_000);

  const r1 = fakeRes();
  await run(mw, fakeReq("/api/sites"), r1, (res) => res.json({ v: 1 }));
  assert.equal(r1.headers["X-Cache"], "MISS");

  const r2 = fakeRes();
  let reachedHandler = false;
  await run(mw, fakeReq("/api/sites"), r2, () => { reachedHandler = true; });

  assert.equal(r2.headers["X-Cache"], "HIT", "המטמון הפסיק לתפקד");
  assert.equal(reachedHandler, false, "המסלול רץ למרות פגיעה במטמון");
  assert.deepEqual(r2.body, { v: 1 });
});


test("⚠️ ניתוק לפני התשובה אינו תולה את המפתח לנצח", async () => {
  clearCache();
  const mw = cache(10_000);
  const before = getCacheStats();

  // בקשה ראשונה: המסלול לעולם לא קורא ל-json, והלקוח מנתק.
  const r1 = fakeRes();
  await new Promise((resolve) => {
    mw(fakeReq("/api/stats/supervisor"), r1, () => {
      r1.emit("close");            // ⚠️ close בלי finish — בדיוק סגירת לשונית
      resolve();
    });
  });

  // ============================================================
  // ⚠️ סינכרוני ולא מרוץ טיימר
  // ============================================================
  // כאן היה `Promise.race` מול 300ms. הוא **נפל אחת משלוש ריצות** תחת
  // עומס — לא כי הקוד שגוי אלא כי המכונה הייתה עסוקה. בדיקה שנופלת
  // תחת עומס גרועה מאין בדיקה: היא מאמנת להתעלם מאדום.
  //
  // וההבחנה אינה צריכה זמן בכלל: במסלול ההחמצה ה-middleware קורא
  // ל-next() **סינכרונית**, ובמסלול ההצטרפות הוא מחזיר `pending.then(…)`
  // ולא קורא לו כלל. דגל שנבדק מיד אחרי הקריאה מפריד ביניהם בוודאות.
  const r2 = fakeRes();
  let reached = false;
  mw(fakeReq("/api/stats/supervisor"), r2, () => { reached = true; });

  assert.equal(reached, true, "הבקשה נתלתה על inFlight שלעולם לא נפתר");
  assert.ok(getCacheStats().misses > before.misses);
});
