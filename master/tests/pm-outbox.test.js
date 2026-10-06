// tests/pm-outbox.test.js — תיבת היוצאים של ביקור התחזוקה המונעת (dashboard/src/utils/pmOutbox.js).
//
// ============================================================
// ⚠️ מה נבדק כאן
// ============================================================
// הלוגיקה הטהורה של התיבה — סדר השליחה, סיווג שגיאות, בעלות, שכבת "אושר"
// וביטולי תמונה — בלי דפדפן ובלי רשת. השולחים הם פונקציות מזויפות שסופרות
// קריאות. localStorage מזויף (Map); IndexedDB אינו קיים ב-node, כך שתמונות
// חיות בזיכרון של המודול — אותו מסלול שהתיבה לוקחת בגלישה פרטית.
//
// ⚠️ כל בדיקה טוענת **עותק טרי** של המודול (query string שונה): המצב של
// התיבה (retryState, אינדקס התמונות, dropped) הוא ברמת המודול, ובדיקה אחת
// הייתה זולגת לבאה. localStorage המזויף מתרוקן בין בדיקות מאותה סיבה.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dashboard", "src", "utils", "pmOutbox.js");

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  },
  addEventListener() {},
};

let n = 0;
const fresh = () => import(`${pathToFileURL(SRC).href}?t=${++n}`);
beforeEach(() => store.clear());

const JPEG = { mime: "image/jpeg", data: "/9j/xx", thumb: "/9j/t" };
// בדיוק מה ש-complianceDirect.outboxCall זורק כש-AbortSignal.timeout(60s) פוקע:
// postgrest-js מחזיר {error:{message:"TimeoutError: signal timed out"}, status:0} ואינו זורק.
const timeout = (ob) => ob.sendError({ message: "TimeoutError: signal timed out", code: "" }, 0, "החיבור איטי — נסה שוב");
const offline = (ob) => ob.sendError({ message: "TypeError: Failed to fetch", code: "" }, 0, "אין חיבור לאינטרנט — נסה שוב");

function counting(over = {}) {
  const calls = { check: [], note: [], photo: [], photoUndo: [] };
  const senders = {
    check: async (...a) => { calls.check.push(a); return over.check?.(...a); },
    note: async (...a) => { calls.note.push(a); return over.note?.(...a); },
    photo: async (...a) => { calls.photo.push(a); return over.photo ? over.photo(...a) : { id: 500 + calls.photo.length }; },
    photoUndo: async (...a) => { calls.photoUndo.push(a); return over.photoUndo?.(...a); },
  };
  return { calls, senders };
}

test("sendError: זמן קצוב (status 0 / TimeoutError) הוא network וגם timeout; Failed to fetch — network בלבד", async () => {
  const ob = await fresh();
  const t = timeout(ob);
  assert.equal(t.network, true);
  assert.equal(t.timeout, true);
  const f = offline(ob);
  assert.equal(f.network, true);
  assert.equal(!!f.timeout, false);
});

test("⚠️ תמונה שתם זמנה אינה חוסמת את הווי וההערות של הביקור, ומקבלת השהיה — לא עוד העלאה כל 15 שניות", async () => {
  const ob = await fresh();
  ob.setOwner("u1");
  const { calls, senders } = counting({ photo: async () => { throw timeout(ob); } });
  await ob.enqueuePhoto(600, 701, "cid-1", JPEG);
  ob.enqueueCheck(600, "700", true);
  ob.enqueueNote(600, "703", "שמן תקין");
  await ob.drain(senders);
  assert.equal(calls.check.length, 1, "הווי נשלח למרות התמונה");
  assert.equal(calls.note.length, 1, "ההערה נשלחה למרות התמונה");
  assert.equal(calls.photo.length, 1);
  for (let i = 0; i < 4; i++) await ob.drain(senders);
  assert.equal(calls.photo.length, 1, "התמונה בהשהיה — לא נשלחת שוב בכל סבב");
  const p = ob.pendingFor(600);
  assert.equal(p.stuck.length, 0, "זמן קצוב אינו 'השרת דחה'");
  assert.equal(p.photos.length, 1, "התמונה עדיין בתור");
  assert.equal(ob.pendingCount(600), 1);
  await ob.drain(senders, { force: true });
  assert.equal(calls.photo.length, 2, "'סנכרון עכשיו' מנסה מיד");
});

test("אין רשת בכלל (Failed to fetch) — הסבב נעצר, ושום רשומה לא נספרת כניסיון", async () => {
  const ob = await fresh();
  const { calls, senders } = counting({ check: async () => { throw offline(ob); } });
  ob.enqueueCheck(601, "700", true);
  await ob.enqueuePhoto(601, 701, "cid-2", JPEG);
  await ob.drain(senders);
  assert.equal(calls.check.length, 1);
  assert.equal(calls.photo.length, 0, "הסבב נעצר ולא ניסה להעלות תמונה בלי רשת");
  await ob.drain(senders);
  assert.equal(calls.check.length, 2, "בלי השהיה: הרשומה עצמה תקינה");
});

test("⚠️ בעלות לכל שדה: B שמסמן וי בפריט עם הערה ממתינה של A אינו שולח את ההערה בשמו", async () => {
  const ob = await fresh();
  ob.setOwner("A");
  ob.enqueueNote(602, "703", "הערה של A");
  ob.setOwner("B");
  let snap;
  const stop = ob.subscribe((s) => { snap = s; });
  assert.equal(snap.foreign, 1);
  ob.enqueueCheck(602, "703", true);
  assert.equal(snap.foreign, 1, "ההערה של A נשארת זרה");
  assert.deepEqual(ob.pendingFor(602).items, { 703: { checked: true } }, "B רואה רק את הווי שלו");
  const { calls, senders } = counting();
  await ob.drain(senders);
  assert.equal(calls.check.length, 1);
  assert.equal(calls.note.length, 0, "ההערה של A לא נשלחה בזהות של B");
  // B מוחק את מה שזר — הווי שלו (שכבר נשלח) אינו מושפע, וההערה של A יורדת
  await ob.discardForeign();
  assert.equal(ob.pendingCount(602), 0);
  ob.setOwner("A");
  assert.equal(ob.pendingCount(602), 0, "ההערה של A נמחקה במכוון");
  stop();
});

test("רשומה ישנה עם `by` אחד לפריט: הבעלות של השדה השני נשמרת כשמשתמש אחר כותב", async () => {
  const ob = await fresh();
  store.set("pm.outbox.603", JSON.stringify({ 703: { note: "ישנה של A", seq: 1, rev: 1, by: "A" } }));
  ob.setOwner("B");
  ob.enqueueCheck(603, "703", true);
  const { calls, senders } = counting();
  await ob.drain(senders);
  assert.equal(calls.note.length, 0);
  ob.setOwner("A");
  assert.deepEqual(ob.pendingFor(603).items, { 703: { note: "ישנה של A" } });
});

test("⚠️ שכבת 'אושר': וי ותמונה שהשרת אישר נשארים גלויים עד תשובת שרת שהתחילה אחריהם", async () => {
  const ob = await fresh();
  const { senders } = counting({ photo: async () => ({ id: 9001 }) });
  ob.enqueueCheck(604, "703", true);
  await ob.enqueuePhoto(604, 701, "cid-4", JPEG);
  const t0 = Date.now();
  await ob.drain(senders);
  assert.equal(ob.pendingCount(604), 0, "יצא מהתיבה");
  const a = ob.ackedFor(604);
  assert.equal(a.items[703].checked.value, true);
  assert.ok(a.items[703].checked.at >= t0);
  assert.deepEqual(a.photos.map((p) => [p.clientId, p.itemId, p.fileId]), [["cid-4", "701", 9001]]);
  assert.equal(ob.thumbFor("cid-4"), JPEG.thumb, "הממוזערת נשמרת — המסך לא צריך לשלוף אותה");
  // ⚠️ השכבה ב-localStorage — שורדת טופס חדש ורענון (עותק טרי של המודול)
  const ob2 = await fresh();
  assert.equal(ob2.ackedFor(604).items[703].checked.value, true);
  // תשובת שרת שהשליפה שלה התחילה **לפני** האישור אינה מכסה אותו
  ob2.pruneAcked(604, t0 - 1);
  assert.equal(ob2.ackedFor(604).photos.length, 1);
  ob2.pruneAcked(604, Date.now() + 1);
  assert.deepEqual(ob2.ackedFor(604), { items: {}, photos: [] });
});

test("clearVisit מנקה גם את שכבת 'אושר' וגם את מה שנזרק", async () => {
  const ob = await fresh();
  const { senders } = counting();
  ob.enqueueCheck(605, "703", true);
  await ob.drain(senders);
  assert.equal(Object.keys(ob.ackedFor(605).items).length, 1);
  await ob.clearVisit(605);
  assert.deepEqual(ob.ackedFor(605), { items: {}, photos: [] });
});

test("droppedCount: שינוי שנזרק כי הביקור כבר לא פתוח נספר — עד clearVisit", async () => {
  const ob = await fresh();
  const gone = () => { const e = new Error("הפריט לא נמצא"); e.permanent = true; throw e; };
  const { senders } = counting({ check: gone, note: gone });
  ob.enqueueCheck(606, "703", true);
  ob.enqueueNote(606, "704", "x");
  await ob.drain(senders);
  assert.equal(ob.pendingCount(606), 0);
  assert.equal(ob.droppedCount(606), 2);
  assert.deepEqual(ob.ackedFor(606), { items: {}, photos: [] }, "מה שנזרק אינו 'אושר'");
  await ob.clearVisit(606);
  assert.equal(ob.droppedCount(606), 0);
});

test("⚠️ הסרת תמונה **בזמן** שהיא נשלחת: נרשם ביטול שממתין, ונמחק בשרת לפי ה-id שחזר", async () => {
  const ob = await fresh();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { calls, senders } = counting({ photo: async () => { await gate; return { id: 77 }; } });
  await ob.enqueuePhoto(607, 704, "cid-7", JPEG);
  const run = ob.drain(senders);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.photo.length, 1, "ההעלאה בדרך");
  await ob.removePhoto("cid-7");
  assert.equal(ob.pendingCount(607), 1, "הביטול נספר — ההגשה והסגירה מחכות לו");
  assert.deepEqual(ob.pendingFor(607).undo, [{ clientId: "cid-7", itemId: "704" }]);
  release();
  await run;
  await ob.drain(senders);
  assert.deepEqual(calls.photoUndo.map((a) => [String(a[0]), a[1], a[2], a[3]]), [["607", "704", "cid-7", 77]]);
  assert.equal(ob.pendingCount(607), 0);
  assert.deepEqual(ob.ackedFor(607).photos, [], "תמונה שהוסרה אינה נרשמת כ'אושרה'");
});

test("הסרת תמונה שנשלחה ותם זמנה (אולי בשרת): ביטול בלי id — השולח שואל את השרת", async () => {
  const ob = await fresh();
  const { calls, senders } = counting({ photo: async () => { throw timeout(ob); } });
  await ob.enqueuePhoto(608, 704, "cid-8", JPEG);
  await ob.drain(senders);
  await ob.removePhoto("cid-8");
  assert.equal(ob.pendingCount(608), 1);
  await ob.drain(senders);
  assert.equal(calls.photo.length, 1, "התמונה עצמה לא נשלחת שוב");
  assert.deepEqual(calls.photoUndo.map((a) => a[3]), [null]);
  assert.equal(ob.pendingCount(608), 0);
});

test("הסרת תמונה שמעולם לא נשלחה — מקומית בלבד, בלי ביטול ובלי פנייה לשרת", async () => {
  const ob = await fresh();
  await ob.enqueuePhoto(609, 704, "cid-9", JPEG);
  await ob.removePhoto("cid-9");
  assert.equal(ob.pendingCount(609), 0);
  const { calls, senders } = counting();
  await ob.drain(senders);
  assert.equal(calls.photoUndo.length + calls.photo.length, 0);
});

test("pendingFor().waiting אינו סופר מה שהשרת דחה — 'ממתין לסנכרון' ו'נדחה' הם שני דברים", async () => {
  const ob = await fresh();
  const reject = () => { throw ob.sendError({ message: "אפשר לצרף עד 6 תמונות לפריט", code: "23514" }, 400); };
  const { senders } = counting({ photo: reject });
  await ob.enqueuePhoto(610, 704, "cid-10", JPEG);
  ob.enqueueCheck(610, "700", true);
  await ob.drain(senders);
  const p = ob.pendingFor(610);
  assert.equal(p.stuck.length, 1);
  assert.equal(p.stuck[0].clientId, "cid-10");
  assert.equal(p.waiting, 0, "הווי נשלח; התמונה תקועה — אין 'ממתין'");
  assert.equal(ob.pendingCount(610), 1);
  await ob.discardStuck(p.stuck[0].key);
  assert.equal(ob.pendingCount(610), 0);
});

test("⚠️ תמונה שתם זמנה בקישור חלש: ההשהיה מוגבלת לדקה — טכנאי שעלה לרחוב לא מחכה דקות", async () => {
  const ob = await fresh();
  const realNow = Date.now;
  let now = Date.UTC(2026, 9, 4, 9, 0, 0);
  Date.now = () => now;
  try {
    let weak = true;
    const sent = [];
    const { senders } = counting({
      photo: async (v, item, cid) => {
        if (weak) { now += 60_000; throw timeout(ob); }      // AbortSignal.timeout(60s) פקע
        sent.push(now);
        return { id: 1 };
      },
    });
    await ob.enqueuePhoto(611, 704, "cid-11", JPEG);
    // עשר דקות במרתף, סבב אוטומטי כל 15 שניות
    const t0 = now;
    while (now - t0 < 10 * 60_000) { await ob.drain(senders); now += 15_000; }
    weak = false;
    const good = now;
    for (let i = 0; i < 80 && !sent.length; i++) { await ob.drain(senders); if (!sent.length) now += 15_000; }
    assert.equal(sent.length, 1, "התמונה עלתה");
    assert.ok(sent[0] - good <= 75_000, `עלתה ${Math.round((sent[0] - good) / 1000)} שניות אחרי שהקליטה חזרה`);
  } finally {
    Date.now = realNow;
  }
});

test("wakeTimedOut: חזרת קליטה / חזרה לדף — תמונה שתם זמנה מנסה מיד, ותמונה שהשרת דחה — לא", async () => {
  const ob = await fresh();
  let mode = "timeout";
  const { calls, senders } = counting({
    photo: async (v, item, cid) => {
      if (cid === "cid-13") throw ob.sendError({ message: "אפשר לצרף עד 6 תמונות לפריט", code: "23514" }, 400);
      if (mode === "timeout") throw timeout(ob);
      return { id: 9 };
    },
  });
  await ob.enqueuePhoto(612, 704, "cid-12", JPEG);
  await ob.enqueuePhoto(612, 704, "cid-13", JPEG);
  await ob.drain(senders);
  assert.equal(calls.photo.length, 2);
  await ob.drain(senders);
  assert.equal(calls.photo.length, 2, "בהשהיה");
  mode = "ok";
  assert.equal(ob.wakeTimedOut(), 1, "רק זו שתם זמנה");
  await ob.drain(senders);
  assert.deepEqual(calls.photo.map((a) => a[2]), ["cid-12", "cid-13", "cid-12"], "נשלחה מיד, בלי force; הנדחית לא");
  assert.equal(ob.pendingFor(612).stuck.length, 1);
});

test("⚠️ שתי לשוניות: לשונית אחרת הסירה את התמונה בזמן שהיא עולה מכאן — ה-ack רושם ביטול עם ה-id, לא 'אושרה'", async () => {
  const ob = await fresh();
  const stop = ob.subscribe(() => {});                 // פותח את ה-BroadcastChannel של "הלשונית" הזו
  let release;
  const gate = new Promise((r) => { release = r; });
  const { calls, senders } = counting({ photo: async () => { await gate; return { id: 77 }; } });
  await ob.enqueuePhoto(613, 704, "cid-14", JPEG);
  const run = ob.drain(senders);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.photo.length, 1, "ההעלאה בדרך");
  // הלשונית האחרת: הטכנאי לחץ × — היא מחקה את הרשומה והודיעה
  const other = new BroadcastChannel("parkomat-pm");
  other.postMessage({ t: "del", clientId: "cid-14" });
  await new Promise((r) => setTimeout(r, 30));
  other.close();
  release();
  await run;
  assert.deepEqual(ob.ackedFor(613).photos, [], "לא נרשמה כ'אושרה'");
  assert.deepEqual(calls.photoUndo.map((a) => [String(a[0]), a[2], a[3]]), [["613", "cid-14", 77]], "נמחקה בשרת לפי ה-id שחזר");
  assert.equal(ob.pendingCount(613), 0);
  stop();
});
