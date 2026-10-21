// tests/sw-dispatch.test.js — ה-Service Worker (dashboard/public/sw.js) מול צפצוף לטכנאי (21/10/2026, שלב 4 של "צא ל:"):
// kind = "dispatch" מציג התראה שנשארת ורוטטת, tag אחד לכל משימה (התזכורת מחליפה ומצפצפת שוב), ומודיע לחלון פתוח לטעון
// מיד. ושהתראות התקלה לא השתנו. הקובץ רץ כמו שהוא, בארגז חול של vm עם self מזויף.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SRC = fs.readFileSync(new URL("../../dashboard/public/sw.js", import.meta.url), "utf8");

function worker({ clients = 2 } = {}) {
  const handlers = {};
  const shown = [];
  const posted = [];
  const wins = Array.from({ length: clients }, (_, i) => ({ url: `https://x.test/${i}`, postMessage: (m) => posted.push({ i, m }) }));
  const self = {
    addEventListener: (t, f) => { handlers[t] = f; },
    skipWaiting: () => {},
    registration: { showNotification: async (title, opts) => { shown.push({ title, opts }); } },
    clients: { matchAll: async () => wins, claim: async () => {}, openWindow: async () => {} },
    location: { origin: "https://x.test" },
  };
  vm.runInNewContext(SRC, { self, URL, Promise, Date });
  async function push(data) {
    let wait = null;
    const event = {
      data: data === undefined ? null : { json: () => (typeof data === "string" ? JSON.parse(data) : data) },
      waitUntil: (p) => { wait = p; },
    };
    handlers.push(event);
    await wait;
  }
  return { push, shown, posted };
}

test("משימה: התראה שנשארת, רוטטת, עם tag של המשימה — ומודיעה לכל חלון פתוח", async () => {
  const w = worker({ clients: 2 });
  await w.push({ kind: "dispatch", id: 42, n: 1, title: "משימה חדשה: הרצל 50", body: "מעלית תקועה", tag: "dispatch-42", url: "/" });
  assert.equal(w.shown.length, 1);
  const { title, opts } = w.shown[0];
  assert.equal(title, "משימה חדשה: הרצל 50");
  assert.equal(opts.body, "מעלית תקועה");
  assert.equal(opts.tag, "dispatch-42");
  assert.equal(opts.renotify, true, "תזכורת באותו tag — מצפצפת שוב");
  assert.equal(opts.requireInteraction, true, "נשארת עד שנוגעים");
  assert.equal(opts.silent, false);
  assert.deepEqual([...opts.vibrate], [400, 150, 400, 150, 800]);
  assert.equal(opts.dir, "rtl");
  assert.equal(opts.data.url, "/");
  assert.deepEqual(w.posted.map((p) => p.i), [0, 1], "כל חלון פתוח מקבל הודעה");
  assert.deepEqual(JSON.parse(JSON.stringify(w.posted[0].m)), { type: "dispatch", id: 42 });
});

test("משימה בלי tag / כותרת — ברירות מחדל, ולא נופלת לנתיב של תקלה", async () => {
  const w = worker({ clients: 0 });
  await w.push({ kind: "dispatch", id: 7 });
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, "משימה חדשה");
  assert.equal(w.shown[0].opts.tag, "dispatch-7");
  assert.equal(w.shown[0].opts.body, "");
  assert.ok(!/תקלה/.test(w.shown[0].title));
});

test("התראות התקלה לא השתנו: כותרת · אתר, tag לפי סוג וקוד, ולא נשלחת הודעה לחלונות", async () => {
  const w = worker();
  await w.push({ kind: "fault", title: "תקלה", siteName: "הרצל 50", code: "1227", faultText: "מעלית - זמן מקסימלי" });
  assert.equal(w.shown[0].title, "תקלה · הרצל 50");
  assert.equal(w.shown[0].opts.tag, "fault-1227");
  assert.equal(w.shown[0].opts.body, "מעלית - זמן מקסימלי");
  assert.equal(w.shown[0].opts.vibrate, undefined, "רטט המשימה לא דלף להתראות תקלה");
  assert.equal(w.posted.length, 0);
});

test("push פגום או ריק — עדיין מוצגת התראה (גנרית), בלי חריגה", async () => {
  const w = worker();
  await w.push("{not json");
  await w.push(undefined);
  assert.equal(w.shown.length, 2);
  assert.equal(w.shown[0].title, "תקלה · אתר");
  assert.equal(w.posted.length, 0);
});
