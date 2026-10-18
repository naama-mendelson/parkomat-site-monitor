// tests/coalesce.test.js — רענון מתאחד: פרץ = קריאה אחת, לשונית מוסתרת = כלום (18/10/2026).
//
// נמדד בייצור: 29 מסכים, כל אירוע קריאת ויזנט → 2 RPC בכל אחד, גם במוסתרים — 56% מזמן המסד בחלון של 10 דקות.
// utils/coalesce.js מקבל שעון מוזרק, ולכן נבדק כאן בלי DOM ובלי המתנה אמיתית.
const { test } = require("node:test");
const assert = require("node:assert/strict");

let m;
test.before(async () => { m = await import("../../dashboard/src/utils/coalesce.js"); });

// שעון מזויף: טיימרים נשמרים ומופעלים ביד
function clock() {
  const timers = new Map(); let next = 1;
  return {
    setTimer: (cb, ms) => { const id = next++; timers.set(id, { cb, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    fire: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.cb(); } },
    count: () => timers.size,
    delays: () => [...timers.values()].map((t) => t.ms),
  };
}

test("פרץ של 8 בקשות — הפעלה אחת, אחרי החלון, ולא לפניו", () => {
  const c = clock(); let runs = 0;
  const r = m.makeCoalesced(() => runs++, { delayMs: 1500, isHidden: () => false, setTimer: c.setTimer, clearTimer: c.clearTimer });
  for (let i = 0; i < 8; i++) r.request();
  assert.equal(runs, 0, "לא רץ מיד — גם לא בבקשה הראשונה");
  assert.equal(c.count(), 1, "טיימר אחד בלבד ממתין");
  assert.deepEqual(c.delays(), [1500]);
  assert.equal(r.pending(), true);
  c.fire();
  assert.equal(runs, 1);
  assert.equal(r.pending(), false);
  // אחרי שנרגע — בקשה חדשה היא סבב חדש
  r.request(); c.fire();
  assert.equal(runs, 2);
});

test("לשונית מוסתרת — כלום: לא טיימר ולא הפעלה; גלויה שוב — רגיל", () => {
  const c = clock(); let runs = 0; let hidden = true;
  const r = m.makeCoalesced(() => runs++, { isHidden: () => hidden, setTimer: c.setTimer, clearTimer: c.clearTimer });
  r.request(); r.request();
  assert.equal(c.count(), 0); assert.equal(r.pending(), false);
  c.fire(); assert.equal(runs, 0);
  hidden = false;
  r.request(); c.fire();
  assert.equal(runs, 1);
});

test("cancel מבטל בקשה ממתינה; ברירות המחדל: 1500 אלפיות, ובלי document — גלוי", () => {
  const c = clock(); let runs = 0;
  const r = m.makeCoalesced(() => runs++, { setTimer: c.setTimer, clearTimer: c.clearTimer });
  r.request();
  assert.deepEqual(c.delays(), [1500], "ברירת המחדל");
  r.cancel();
  assert.equal(c.count(), 0); assert.equal(r.pending(), false);
  c.fire(); assert.equal(runs, 0);
  r.request(); c.fire(); assert.equal(runs, 1, "בלי document (node) — נחשב גלוי");
});

test("unlessHidden — טיימר תקופתי רץ רק כשגלוי", () => {
  let hidden = true, runs = 0;
  const f = m.unlessHidden(() => runs++, () => hidden);
  f(); assert.equal(runs, 0);
  hidden = false; f(); assert.equal(runs, 1);
  assert.equal(typeof m.unlessHidden(() => {}), "function", "ברירת מחדל בלי document — לא זורק");
  m.unlessHidden(() => runs++)(); assert.equal(runs, 2);
});
