// utils/audio/alerts.js — התראה קולית על תקלה חדשה (Web Audio, ללא קבצים).
//
// ==========================================================
// מה התפקיד של הצליל, ומה *לא*
// ==========================================================
// הדשבורד רץ על מסך קיר בחדר בקרה, פתוח כל היום, ואיש אינו נוגע בו. תפקיד
// הצליל הוא אחד בלבד: לגרום למפעיל **להסתכל על המסך**. הוא אינו סופר תקלות
// ואינו מתאר אותן — המסך כבר עושה את זה, וטוב ממנו.
//
// מכאן נגזרות שתי החלטות שנראות מנוגדות לאינטואיציה:
//
//   1. **צליל אחד לאירוע, לא צליל לאתר.** נפילת רשת מפילה עשרים אתרים בבת
//      אחת. עשרים צלילים חופפים אינם "יותר דחוף" — הם רעש שאי אפשר לפרש,
//      והם גם נשמעים כמו תקלה במערכת עצמה. חלון קיבוץ קצר הופך את כולם
//      לצלצול אחד.
//
//   2. **תקלה בלבד, לא no_comm.** נמדד על הנתונים: בשבוע אחד נרשמו 15
//      מעברים ל-error מול 164 ל-no_comm — ומתוך אלה 162 נמשכו פחות משתי
//      דקות. כלומר no_comm הוא כמעט תמיד ריצוד ולא נתק אמיתי. צלצול על 23
//      אירועים ביום היה מאמן את המפעילים להתעלם מהצליל, ובכך הורג אותו גם
//      עבור שתי התקלות האמיתיות. (התראה על no_comm *מתמשך* היא רעיון טוב
//      ונפרד — היא הייתה מצלצלת פעמיים בשבוע במקום 164.)

const STORAGE_KEY = "parkomat.alerts.muted";

/**
 * חלון הקיבוץ. תקלה ראשונה מצלצלת **מיד** (מפעיל צריך להסתכל עכשיו, לא בעוד
 * ארבע שניות), וכל מה שנופל בתוך החלון מתקבץ אליה בשקט. אחרי שהחלון נסגר,
 * תקלה חדשה באמת מצלצלת שוב.
 */
export const COALESCE_MS = 4000;

/** כל כמה זמן נבדק שה-context לא הושעה מתחתינו. ראה noteHealthy למטה. */
const WATCHDOG_MS = 15000;

let ctx = null;
let master = null;
let unsupported = false;
let everRunning = false;      // האם הצלחנו אי-פעם להגיע ל-'running'
let muted = readStored();
let windowUntil = 0;
let ringCount = 0;
let watchdog = null;
const listeners = new Set();

// ===== העדפת ההשתקה =====
// אחסון חסום (גלישה פרטית) לא יפיל את האפליקציה — נופלים לברירת מחדל.
function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStored(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* אחסון חסום — הבחירה תחיה עד לרענון */
  }
}

// ===== מנוי על המצב (עבור ה-UI) =====
function notify() {
  for (const listener of listeners) listener();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * מצב ההתראות כמחרוזת אחת — בכוונה פרימיטיב, כדי ש-useSyncExternalStore
 * לא ייכנס ללולאת render על אובייקט חדש בכל קריאה.
 *
 *   'unsupported' — אין Web Audio בדפדפן הזה
 *   'muted'       — המשתמש השתיק ביודעין
 *   'locked'      — הדפדפן חוסם/השעה אודיו. **זה המצב המסוכן** (ראה למטה)
 *   'ready'       — חמוש ויצלצל
 */
export function getAlertState() {
  if (unsupported) return "unsupported";
  if (muted) return "muted";
  if (!ctx) return "locked";
  return ctx.state === "running" ? "ready" : "locked";
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = !!value;
  writeStored(muted);
  notify();
}

export function toggleMute() {
  setMuted(!muted);
}

/** לאבחון: כמה צלצולים בפועל הושמעו מאז טעינת העמוד. */
export function getRingCount() {
  return ringCount;
}

// ===== ה-AudioContext =====
function ensureContext() {
  // context שנסגר (קורה בכיבוי טאב אגרסיבי) אינו ניתן להחייאה — בונים חדש.
  if (ctx && ctx.state === "closed") {
    ctx = null;
    master = null;
  }
  if (ctx || unsupported) return ctx;

  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) {
    unsupported = true;
    return null;
  }

  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    // הדפדפן משעה מיוזמתו (טאב ברקע, חיסכון בסוללה). זה המקור האמין ביותר
    // לדעת שהמצב השתנה, ובלעדיו המחוון על המסך היה משקר.
    ctx.onstatechange = () => {
      if (ctx && ctx.state === "running") everRunning = true;
      notify();
    };
  } catch {
    unsupported = true;
    ctx = null;
  }
  return ctx;
}

/**
 * מנסה להחיות את האודיו.
 *
 * ⚠️ ה-.catch כאן אינו קוסמטי: resume() **דוחה** promise כשמדיניות ה-autoplay
 * חוסמת, וקריאה בלי catch ייצרה unhandled rejection בכל ניסיון. על מסך קיר
 * שמנסה להתאושש כל 15 שניות זה זרם קבוע של שגיאות בקונסול, שמסתיר שגיאות
 * אמיתיות.
 *
 * @param fromGesture האם הקריאה מגיעה ממחווה אמיתית של המשתמש. לפני המחווה
 *   הראשונה אין טעם לקרוא ל-resume — הדפדפן ידחה אותה בוודאות — ולכן ה-
 *   watchdog לא מנסה עד שהצלחנו לפחות פעם אחת.
 */
export function unlockAudio(fromGesture = false) {
  const c = ensureContext();
  if (!c) return;

  if (c.state === "running") {
    everRunning = true;
    notify();
    return;
  }

  if (!fromGesture && !everRunning) return;

  try {
    const result = c.resume();
    if (result && typeof result.then === "function") {
      result.then(notify).catch(() => notify());
    } else {
      notify();
    }
  } catch {
    notify();
  }
}

/**
 * מפעיל את ה-watchdog. נקרא פעם אחת מהאפליקציה.
 *
 * למה בכלל: העמוד פתוח ימים. דפדפנים משעים AudioContext של טאב שרץ זמן רב,
 * ובלי בדיקה תקופתית האתר היה שקט ביום השלישי בלי ששום דבר יראה שונה.
 * ה-interval יחיד ומודולרי — אין כאן צבירה של טיימרים.
 */
export function startAudioWatchdog() {
  ensureContext();
  if (watchdog !== null) return () => {};

  watchdog = setInterval(() => {
    unlockAudio(false);   // ינסה resume רק אם כבר היינו פעם running
    notify();             // מרענן את המחוון גם אם ההשעיה נמשכת
  }, WATCHDOG_MS);

  return () => {
    clearInterval(watchdog);
    watchdog = null;
  };
}

// ===== הצליל =====
//
// שלושה צלילים עולים (רה–לה–רה באוקטבה) ביחס 2:3:4. למה כך:
//   - **נשמע בחדר**: כל צליל הוא משולש + הרמוניה עליונה, ולא סינוס טהור.
//     סינוס בודד "נבלע" ברעש רקע של מזגן ומאווררים; ספקטרום עשיר חותך אותו.
//   - **מובחן**: תבנית עולה של שלושה צלילים אינה נשמעת כמו טלפון, התראת
//     מייל או צפצוף של מכשיר אחר בחדר.
//   - **לא מבהיל**: העלייה רכה (12ms) ולא נעיצה, והעוצמה יורדת אקספוננציאלית.
//   - **קצר**: ~0.5 שניות בסך הכל.
const NOTES = [
  { freq: 660, dur: 0.17, gain: 0.28 },
  { freq: 990, dur: 0.17, gain: 0.30 },
  { freq: 1320, dur: 0.34, gain: 0.32 },
];
const NOTE_GAP = 0.13;
const ATTACK = 0.012;

function scheduleNote(c, when, { freq, dur, gain }) {
  const osc = c.createOscillator();
  const harmonic = c.createOscillator();
  const harmonicGain = c.createGain();
  const envelope = c.createGain();

  osc.type = "triangle";
  osc.frequency.value = freq;
  harmonic.type = "sine";
  harmonic.frequency.value = freq * 2;
  harmonicGain.gain.value = 0.3;

  osc.connect(envelope);
  harmonic.connect(harmonicGain);
  harmonicGain.connect(envelope);
  envelope.connect(master);

  // exponentialRamp אינו יכול לגעת באפס — מתחילים ומסיימים בערך זעיר.
  envelope.gain.setValueAtTime(0.0001, when);
  envelope.gain.exponentialRampToValueAtTime(gain, when + ATTACK);
  envelope.gain.exponentialRampToValueAtTime(0.0001, when + dur);

  osc.start(when);
  harmonic.start(when);
  osc.stop(when + dur);
  harmonic.stop(when + dur);

  // ניתוק מפורש כשהצליל נגמר. בלי זה הצמתים נשארים מחוברים לגרף עד שה-GC
  // יגיע אליהם, ובעמוד שפתוח ימים זו צבירה אמיתית.
  osc.onended = () => {
    try {
      osc.disconnect();
      harmonic.disconnect();
      harmonicGain.disconnect();
      envelope.disconnect();
    } catch {
      /* כבר מנותק */
    }
  };
}

/** מנגן את הצליל. מחזיר false אם האודיו חסום — ואז שום דבר לא נשמע. */
function playChime() {
  const c = ensureContext();
  if (!c || c.state !== "running") return false;

  try {
    const start = c.currentTime + 0.02;
    NOTES.forEach((note, i) => scheduleNote(c, start + i * NOTE_GAP, note));
    ringCount++;
    return true;
  } catch {
    return false;
  }
}

/**
 * מדווח על תקלות חדשות. **זו נקודת הכניסה היחידה** מהאפליקציה.
 *
 * @param codes קודי האתרים שנכנסו *עכשיו* לתקלה (רק המעבר, לא מצב קיים)
 * @returns 'rang' | 'coalesced' | 'muted' | 'blocked' | 'none' — לאבחון ולבדיקות
 */
export function notifyFaults(codes) {
  if (!codes || codes.length === 0) return "none";
  if (muted) return "muted";

  const now = Date.now();
  if (now < windowUntil) return "coalesced";

  // החלון נפתח בין אם הצלחנו להשמיע ובין אם לא, כדי שהתנהגות הקיבוץ תהיה
  // זהה גם כשהאודיו חסום — אחרת שחרור החסימה באמצע סערת תקלות היה מתפרץ.
  windowUntil = now + COALESCE_MS;

  return playChime() ? "rang" : "blocked";
}

/** לבדיקות ידניות מהקונסול. */
export function testAlert() {
  unlockAudio(true);
  return playChime();
}
