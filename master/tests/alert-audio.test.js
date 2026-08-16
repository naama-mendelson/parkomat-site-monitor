// tests/alert-audio.test.js — ההתראה הקולית על תקלה.
//
// ============================================================
// שני כשלים אמיתיים שדווחו מהשטח, ושניהם נעולים כאן
// ============================================================
//   1. **"לא תמיד נשמע צליל תקלה."** תקלה שהגיעה בזמן שהדפדפן חוסם אודיו
//      אבדה לגמרי: notifyFaults החזיר "blocked", פתח את חלון הקיבוץ, וזהו.
//      במסך קיר שאיש אינו נוגע בו זה לא מקרה קצה — זו ברירת המחדל.
//
//   2. **"אני לא רוצה ללחוץ על כלום."** הקוד לא ניסה resume לפני מחווה,
//      בהנחה שהדפדפן "ידחה בוודאות". ההנחה שגויה — Chrome מתיר אודיו
//      כשיש Media Engagement, הרשאת Sound, או התקנה כ-PWA.
//
// ⚠️ נבדק דרך AudioContext מדומה ולא דרך jsdom: כל מה שמעניין כאן הוא
// **מתי** נקרא resume ומתי מושמע צליל, וזו לוגיקה טהורה. דפדפן אמיתי היה
// מוסיף שכבה שלא ניתן לשלוט בה בדיוק בנקודה שנבדקת.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODULE = pathToFileURL(
  path.join(__dirname, "..", "..", "dashboard", "src", "utils", "audio", "alerts.js")
).href;

/** AudioContext מדומה עם שליטה מלאה על המצב. */
function stubAudio({ startState = "suspended", resumeSucceeds = true } = {}) {
  const calls = { resume: 0, notes: 0 };
  let onstatechange = null;

  class FakeContext {
    constructor() {
      this.state = startState;
      this.currentTime = 0;
      this.sampleRate = 48000;
      Object.defineProperty(this, "onstatechange", {
        get: () => onstatechange, set: (fn) => { onstatechange = fn; },
      });
    }
    createGain() {
      // ⚠️ **לא נספר כאן.** ensureContext בונה gain אחד ל-master, ולכן
      // ספירת gain-ים ערבבה "נוצר context" עם "הושמע צליל" — והבדיקה
      // "שחרור אינו מצלצל סתם" נפלה על מונה שגוי, לא על קוד שגוי.
      return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {},
                       exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }
    createOscillator() {
      calls.notes++;   // אוסילטור נוצר **רק** לצליל. זה המונה הישיר.
      return { type: "", frequency: { setValueAtTime() {}, value: 0 },
               connect() {}, start() {}, stop() {}, disconnect() {} };
    }
    resume() {
      calls.resume++;
      if (!resumeSucceeds) return Promise.reject(new Error("blocked"));
      this.state = "running";
      if (onstatechange) onstatechange();
      return Promise.resolve();
    }
    get destination() { return {}; }
  }

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  globalThis.window = { AudioContext: FakeContext };
  return calls;
}

/** טוען עותק טרי של המודול — מצב המודול הוא גלובלי ובלעדיו הבדיקות נדבקות. */
const freshImport = () => import(`${MODULE}?v=${Math.random()}`);

test("⚠️ מנסים resume כבר בעלייה — בלי שום מחווה", async () => {
  // זה החצי של "לא רוצה ללחוץ על כלום": אם הדפדפן מתיר, אין מה ללחוץ.
  const calls = stubAudio({ resumeSucceeds: true });
  const { unlockAudio, getAlertState } = await freshImport();

  unlockAudio(false);
  assert.equal(calls.resume, 1, "חייב להיות ניסיון אחד בלי מחווה");
  assert.equal(getAlertState(), "ready");
});

test("⚠️ אבל **פעם אחת בלבד** — ולא בכל טיק של ה-watchdog", async () => {
  // זו הסיבה שהשומר נכתב מלכתחילה: resume נדחה כשהמדיניות חוסמת, וניסיון
  // כל 15 שניות היה מציף את הקונסול בשגיאות שמסתירות שגיאות אמיתיות.
  const calls = stubAudio({ resumeSucceeds: false });
  const { unlockAudio } = await freshImport();

  unlockAudio(false);
  unlockAudio(false);
  unlockAudio(false);
  assert.equal(calls.resume, 1, "ניסיון יחיד, למרות שלוש קריאות");
});

test("מחווה אמיתית תמיד מנסה — גם אחרי שהניסיון הראשון נכשל", async () => {
  const calls = stubAudio({ resumeSucceeds: false });
  const { unlockAudio } = await freshImport();

  unlockAudio(false);          // הניסיון היחיד ללא מחווה
  unlockAudio(true);           // מחווה
  unlockAudio(true);           // ועוד אחת
  assert.equal(calls.resume, 3);
});

test("⚠️ תקלה בזמן חסימה אינה אובדת — היא מצלצלת בשחרור", async () => {
  // **הכשל המרכזי שדווח.** לפני התיקון: notifyFaults מחזיר "blocked",
  // והתקלה נעלמת. הצליל היחיד שהמפעיל היה שומע הוא של התקלה **הבאה**.
  const calls = stubAudio({ startState: "suspended", resumeSucceeds: false });
  // ⚠️ **אותו מופע מודול לשתי הפעולות.** גרסה קודמת של הבדיקה טענה את
  // המודול שוב ב-import נפרד — כלומר עותק שני עם מצב נקי, שבו הדגל
  // pendingBlocked כבר לא היה דלוק. הבדיקה נפלה על עצמה, לא על הקוד.
  const mod = await freshImport();

  assert.equal(mod.notifyFaults(["2438"]), "blocked");
  const beforeUnlock = calls.notes;

  // עכשיו הדפדפן מתיר — מדמים מחווה מוצלחת.
  globalThis.window.AudioContext.prototype.resume = function () {
    this.state = "running";
    if (this.onstatechange) this.onstatechange();
    return Promise.resolve();
  };
  mod.unlockAudio(true);

  assert.ok(calls.notes > beforeUnlock, "התקלה שהמתינה חייבת לצלצל");
});

test("בלי תקלה ממתינה — שחרור אינו מצלצל סתם", async () => {
  // ⚠️ בלי הדגל, כל מחווה על המסך הייתה מייצרת צליל תקלה מדומה.
  const calls = stubAudio({ resumeSucceeds: true });
  const { unlockAudio } = await freshImport();

  const before = calls.notes;
  unlockAudio(true);
  assert.equal(calls.notes, before, "אין תקלה — אין צליל");
});

test("מושתק — אין צליל, וגם אין תקלה שממתינה", async () => {
  // ⚠️ השתקה היא בחירה מפורשת. שמירת התקלה הייתה גורמת לה להתפרץ ברגע
  // שמבטלים את ההשתקה — כלומר צליל על אירוע שכבר נגמר.
  stubAudio({ resumeSucceeds: true });
  const { notifyFaults, setMuted } = await freshImport();

  setMuted(true);
  assert.equal(notifyFaults(["2438"]), "muted");
});
