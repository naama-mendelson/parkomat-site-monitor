// services/techDevice.js — הטלפון של הטכנאי, בצד הטלפון (21/10/2026, שלב 2 של "צא ל:").
//
// הטלפון מתחבר פעם אחת, מסריקת ה-QR שבכרטיס, ונשאר מחובר:
//   • pairThisDevice — התחברות בפרטים שב-QR, ומיד **החלפת הסיסמה** בסיסמה שרק הטלפון יודע. כך QR שצולם, או קישור
//     שנשלח בטעות, אינם פותחים דבר אחרי הסריקה. החלפה שנכשלה אינה כשל בחיבור — הטלפון ממשיך עם הסיסמה מה-QR.
//   • הפרטים נשמרים במכשיר (localStorage), כדי להתחבר שוב לבד: ה-sessions נגרפים אחרי יממה בלי שימוש
//     (app.prune_auth_sessions), וטלפון שלא פתח את האפליקציה בסוף שבוע היה מגיע למסך התחברות שהטכנאי לא יודע מה לכתוב בו.
//   • 22/10/2026: "ניתוק הטלפון הזה" (forgetDevice) הוסר מהטלפון לבקשת הבעלת — ניתוק רק מהכרטיס אצל הרכז. ‏tech_self_unpair
//     נשאר במסד, בלי קורא בדשבורד.
// ⚠️ מה שהפרטים פותחים: את המשימה של הטכנאי הזה בלבד (tech_me) — לא את הדשבורד. ניתוק מהכרטיס סוגר את המשתמש במסד מיד.
//
// ⚠️ תיקונים מבדיקת הבאגים (21/10/2026):
//   • הסיסמה נשמרת **מיד אחרי ההתחברות**, והחדשה נשמרת כ"ממתינה" לפני ההחלפה. עד אז נשמרה רק בסוף: תשובה שאבדה בחניון
//     (ההחלפה בוצעה בשרת, התשובה לא הגיעה) השאירה במכשיר את הסיסמה הישנה, המתה — והטלפון מת יום אחר כך.
//   • "ה-QR כבר שימש" רק כשהפרטים באמת שגויים. אין קליטה — "נסו שוב", וה-QR נשאר בתוקף.
//   • התחברות שקטה אומרת למה נכשלה: פרטים שגויים (הטלפון נותק — QR חדש מחק את המשתמש) או אין חיבור (ננסה שוב).
//   • ניתוק מהטלפון באמת מנתק: עד אז רק מחק את הפרטים, והטלפון המשיך לצפצף על כל משימה.
import { supabase, isSupabaseConfigured } from "./supabase";
import { signIn } from "./auth";

const KEY = "parkomat.techDevice";

function randomPassword() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readRaw() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
}

/** הפרטים השמורים במכשיר, או null. pending — סיסמה חדשה שאולי כבר הוחלפה בשרת (התשובה לא הגיעה). */
export function readDevice() {
  const o = readRaw();
  if (!o?.email || !o?.password) return null;
  return { email: String(o.email), password: String(o.password), pending: o.pending ? String(o.pending) : null };
}

/** האם זה טלפון של טכנאי שנותק (הפרטים נמחקו כי כבר לא עבדו) — כדי להסביר, ולא להציג טופס מייל וסיסמה. */
export function wasDisconnected() {
  return readRaw()?.off === true;
}

function saveDevice(cred) {
  try { localStorage.setItem(KEY, JSON.stringify(cred)); } catch { /* חסום — הטלפון יבקש QR חדש בפעם הבאה */ }
}

function markDisconnected() {
  try { localStorage.setItem(KEY, JSON.stringify({ off: true })); } catch { /* */ }
}

/** שוכח גם את סימן "נותק" — אדם רוצה להתחבר בטלפון הזה כמשתמש רגיל. */
export function clearDeviceMark() {
  try { localStorage.removeItem(KEY); } catch { /* */ }
}

// "פרטים שגויים" מ-signIn (services/auth.js מתרגם את Invalid login credentials); כל שגיאה אחרת — רשת / שרת.
const isInvalid = (error) => /שגויים|invalid login credentials/i.test(String(error ?? ""));

/**
 * חיבור הטלפון מה-QR. מחזיר { ok: true } או { ok: false, error, retry } — retry = אין קליטה, אפשר לנסות שוב עם אותו QR.
 * ⚠️ ההתחברות מחליפה כל משתמש שהיה מחובר בדפדפן הזה — המסך שואל לפני כן (PairScreen).
 */
export async function pairThisDevice({ email, password }) {
  if (!isSupabaseConfigured) return { ok: false, error: "האימות אינו מוגדר" };
  const { user, error } = await signIn(email, password);
  if (error || !user) {
    // ⚠️ "פרטים שגויים" כאן = ה-QR כבר נסרק (הסיסמה הוחלפה) או שנוצר QR חדש אחריו
    if (isInvalid(error)) return { ok: false, error: "ה-QR הזה כבר שימש, או שנוצר אחריו QR חדש — יש לבקש מהרכז QR חדש" };
    return { ok: false, retry: true, error: "אין חיבור כרגע — כדאי לבדוק קליטה ולנסות שוב. ה-QR עדיין בתוקף." };
  }
  // קודם שומרים את מה שעובד עכשיו, ואת החדשה כ"ממתינה" — כדי שכשל באמצע לא ישאיר את הטלפון בלי פרטים
  const next = randomPassword();
  saveDevice({ email, password, pending: next });
  try {
    const { error: upErr } = await supabase.auth.updateUser({ password: next });
    if (!upErr) saveDevice({ email, password: next });
  } catch { /* נשארים עם הסיסמה מה-QR, והחדשה ממתינה — ההתחברות הבאה תבדוק את שתיהן */ }
  return { ok: true };
}

/**
 * התחברות שקטה מהפרטים השמורים, כשה-session אבד.
 * { ok: true } · { ok: false, reason: "none" } (אין פרטים) · "invalid" (הטלפון נותק — הפרטים נמחקים) · "network" (ננסה שוב)
 */
export async function resumeDevice() {
  const d = readDevice();
  if (!d || !isSupabaseConfigured) return { ok: false, reason: "none" };
  let invalid = 0;
  for (const pw of [d.password, d.pending].filter(Boolean)) {
    const { user, error } = await signIn(d.email, pw);
    if (user && !error) {
      if (pw !== d.password || d.pending) saveDevice({ email: d.email, password: pw });   // החדשה היא שעבדה — היא הנשמרת
      return { ok: true };
    }
    if (isInvalid(error)) invalid++;
    else return { ok: false, reason: "network" };
  }
  markDisconnected();
  return { ok: false, reason: invalid ? "invalid" : "none" };
}
