// utils/audio/alerts.js — התראות קוליות (Web Audio API, ללא קבצים חיצוניים)

let audioContext = null;
let unlocked = false; // האם המשתמש כבר אִפשר אודיו (אינטראקציה ראשונה)

// יצירת AudioContext עצלנית (נוצר רק בשימוש הראשון — דרישת דפדפן)
function getContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

// שחרור האודיו — חייב להיקרא מתוך אירוע אינטראקציה אמיתי (click/keydown).
// דפדפנים מתחילים את ה-AudioContext במצב 'suspended' עד שיש מחווה של המשתמש;
// בלי זה, ביפים שמופעלים מאירוע SSE לא יישמעו כלל.
export function unlockAudio() {
  if (unlocked) return;
  try {
    const ctx = getContext();
    if (ctx.state === "suspended") ctx.resume();
    unlocked = true;
  } catch {
    // דפדפן לא תומך — מתעלמים בשקט
  }
}

// ביפ בודד — תדר, משך, ועוצמה (עם עטיפת gain למניעת "פצפוץ")
function beep(frequency, durationMs, volume = 0.3) {
  try {
    const ctx = getContext();
    if (ctx.state === "suspended") ctx.resume(); // הגנה נוספת

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
