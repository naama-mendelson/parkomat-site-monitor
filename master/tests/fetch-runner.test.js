// tests/fetch-runner.test.js — שליפה אחת בכל רגע, בלי לאבד רענון.
//
// ============================================================
// ⚠️ מה נמדד, ולמה זה נבדק
// ============================================================
// בדפדפן, על הייצור: **כל שליפה של מסך המנהל הכללי רצה פעמיים.**
//
//     site_stats        1.58s  ו-  1.15s
//     site_uptime       1.71s  ו-   629ms
//     executive_series  2.44s  ו-  2.35s
//
// המסך נטען, ותוך שניות מגיעה הודעת SSE, `dataVersion` עולה, והשליפה
// מתחילה שוב בזמן שהראשונה באוויר. שתים-עשרה בקשות מקבילות מאיטות זו
// את זו.
//
// ⚠️ **והכשל של התיקון עצמו שקט**: אם הריצה הממתינה תיזרק, המסך יציג
// נתון ישן בלי שום סימן. גרסה ראשונה של התיקון עשתה בדיוק את זה — היא
// בדקה דגל `cancelled` של ה-effect שכבר בוטל. לכן הבדיקה כאן מכסה את
// **שני** הכיוונים: לא שתי שליפות במקביל, וגם לא רענון שנעלם.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MOD = pathToFileURL(
  path.join(__dirname, "..", "..", "dashboard", "src", "services", "..", "hooks", "fetchRunner.js")
).href;

/** בונה סביבה מזויפת: שולט מתי כל שליפה נפתרת. */
function harness(initialKey) {
  let latest = initialKey;
  const calls = [];
  const resolvers = [];
  const seen = { data: [], error: [], loading: [] };

  const fetcher = (key) => {
    calls.push(key);
    return new Promise((resolve, reject) => resolvers.push({ key, resolve, reject }));
  };

  return {
    // ⚠️ fetcher חייב להיות כאן. בגרסה הראשונה הוא נשכח, וכל הבדיקות
    // רצו על undefined — כלומר עברו בלי לבדוק כלום. בדיוק סוג הבדיקה
    // הריקה שהיום הזה כבר נתקל בה פעמיים.
    fetcher,
    calls, resolvers, seen,
    setLatest: (k) => { latest = k; },
    getLatest: () => latest,
    on: {
      data: (v) => seen.data.push(v),
      error: (v) => seen.error.push(v),
      loading: (v) => seen.loading.push(v),
    },
    /** פותר את השליפה שבאוויר וממתין שהמיקרו-תור יתרוקן. */
    settle: async (value) => {
      const r = resolvers.shift();
      r.resolve(value ?? `תוצאה:${r.key}`);
      await new Promise((res) => setImmediate(res));
      await new Promise((res) => setImmediate(res));
    },
  };
}

test("שתי קריאות באותו רגע — רק אחת יוצאת לרשת", async () => {
  const h = harness("A");
  const { createRunner } = await import(MOD);
  const r = createRunner({ fetcher: h.fetcher, getLatest: h.getLatest, on: h.on });

  r.run("A");
  r.run("A");   // ⚠️ זו שהגיעה בזמן שליפה — היא לא אמורה לפתוח בקשה
  assert.equal(h.calls.length, 1, `יצאו ${h.calls.length} בקשות במקום 1`);
});

test("⚠️ והממתינה כן רצה בסוף — הרענון אינו נעלם", async () => {
  const h = harness("A");
  const { createRunner } = await import(MOD);
  const r = createRunner({ fetcher: h.fetcher, getLatest: h.getLatest, on: h.on });

  r.run("A");
  r.run("A");
  await h.settle("ראשונה");

  // ⚠️ הבדיקה שתופסת את הבאג שהיה בגרסה הראשונה שלי: הריצה הממתינה
  // נזרקה, והמסך נשאר עם נתון ישן בלי סימן.
  assert.equal(h.calls.length, 2, "הריצה הממתינה לא רצה — הרענון נעלם");
  await h.settle("שנייה");
  assert.deepEqual(h.seen.data, ["ראשונה", "שנייה"]);
});

test("תוצאה של בקשה שהתיישנה אינה נכתבת למסך", async () => {
  const h = harness("A");
  const { createRunner } = await import(MOD);
  const r = createRunner({ fetcher: h.fetcher, getLatest: h.getLatest, on: h.on });

  r.run("A");
  h.setLatest("B");         // המשתמשת שינתה פילטר בזמן שהשליפה באוויר
  await h.settle("ישן");

  assert.deepEqual(h.seen.data, [], "תוצאה מיושנת נכתבה — המסך היה מציג פילטר אחר");
});

test("ממתינה שהתיישנה אינה רצה בכלל", async () => {
  const h = harness("A");
  const { createRunner } = await import(MOD);
  const r = createRunner({ fetcher: h.fetcher, getLatest: h.getLatest, on: h.on });

  r.run("A");
  r.run("A");
  h.setLatest("B");         // הפילטר השתנה לפני שהראשונה נחתה
  await h.settle("ישן");

  // ⚠️ שליפה כבדה עבור פילטר שכבר נעזב היא בזבוז — ובמסך הזה היא
  // 12 בקשות ו-2.4 שניות.
  assert.equal(h.calls.length, 1, "רצה שליפה עבור פילטר שהמשתמשת עזבה");
});

test("שגיאה אינה נבלעת, ואינה חוסמת את הבאה", async () => {
  const h = harness("A");
  const { createRunner } = await import(MOD);
  const r = createRunner({ fetcher: h.fetcher, getLatest: h.getLatest, on: h.on });

  r.run("A");
  const bad = h.resolvers.shift();
  bad.reject(new Error("נפל"));
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));

  assert.deepEqual(h.seen.error.filter(Boolean), ["נפל"]);

  // ⚠️ ואחרי כישלון אפשר לנסות שוב: דגל inFlight שנתקע על true היה
  // מקפיא את המסך לנצח, וזה כשל גרוע יותר מהשגיאה שגרמה לו.
  r.run("A");
  assert.equal(h.calls.length, 2, "אחרי שגיאה השליפה הבאה לא יצאה — הדגל נתקע");
});

test("loading נדלק ונכבה, ולא נשאר דלוק", async () => {
  const h = harness("A");
  const { createRunner } = await import(MOD);
  const r = createRunner({ fetcher: h.fetcher, getLatest: h.getLatest, on: h.on });

  r.run("A");
  assert.equal(h.seen.loading.at(-1), true);
  await h.settle();
  assert.equal(h.seen.loading.at(-1), false, "המסך נשאר במצב טעינה");
});
