// utils/audio/alerts.js — התראות קוליות (Web Audio API, ללא קבצים חיצוניים)

let audioContext = null;
export let audioUnlocked = false; // האם המשתמש כבר אִפשר אודיו (אינטראקציה ראשונה)

// יצירת AudioContext עצלנית (נוצר רק בשימוש הראשון — דרישת דפדפן)
function getContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

// שחרור/החייאת האודיו — נקרא מתוך אירוע אינטראקציה אמיתי (click/keydown) *וגם*
// כשהטאב חוזר להיות גלוי. דפדפנים מתחילים את ה-AudioContext ב-'suspended' עד
// מחווה, ו*ממשיכים להשעות אותו* כשהטאב ברקע — לכן זה חייב לרוץ שוב ושוב, לא
// פעם אחת. בלי זה, ביפ שמופעל מאירוע SSE פשוט לא יישמע.
export function unlockAudio() {
  try {
    const ctx = getContext();
    if (ctx.state === "suspended") ctx.resume();   // *תמיד* מנסים להחיות, לא רק פעם ראשונה
    if (ctx.state === "running") audioUnlocked = true;
  } catch {
    // דפדפן לא תומך — מתעלמים בשקט
  }
}

// יצירת הצליל בפועל — נקרא רק כשה-context כבר 'running'.
function playTone(ctx, frequency, durationMs, volume) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.type = "sine";
  osc.frequency.value = frequency;

  const now = ctx.currentTime;
  const dur = durationMs / 1000;
  // עליה/ירידה רכה של עוצמה כדי להימנע מקליק
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  osc.start(now);
  osc.stop(now + dur);
}

// ביפ בודד — תדר, משך, ועוצמה (עם עטיפת gain למניעת "פצפוץ").
// אם ה-context מושעה, מנגנים *אחרי* שה-resume הושלם (הוא אסינכרוני) — אחרת
// האוסילטור מתוזמן על context ישן שעדיין לא רץ, והצליל אובד.
function beep(frequency, durationMs, volume = 0.3) {
  try {
    const ctx = getContext();
    if (ctx.state === "suspended") {
      ctx.resume().then(() => playTone(ctx, frequency, durationMs, volume)).catch(() => {});
    } else {
      playTone(ctx, frequency, durationMs, volume);
    }
  } catch {
    // דפדפן חסם אודיו — שקט
  }
}

// התראת תקלה — שני ביפים גבוהים דחופים (אתר עבר ל-error)
export function alertError() {
  beep(880, 180, 0.35);
  setTimeout(() => beep(880, 180, 0.35), 260);
}

// התראת אין תקשורת — ביפ נמוך עדין אחד (שימת לב)
export function alertNoComm() {
  beep(420, 380, 0.18);
}

// התראת תחזוקה הסתיימה — ביפ עולה (חיובי)
export function alertMaintenanceEnd() {
  beep(520, 150, 0.25);
  setTimeout(() => beep(720, 150, 0.25), 200);
}
