// services/techDevice.js — הטלפון של הטכנאי, בצד הטלפון (21/10/2026, שלב 2 של "צא ל:").
//
// הטלפון מתחבר פעם אחת, מסריקת ה-QR שבכרטיס, ונשאר מחובר:
//   • pairThisDevice — התחברות בפרטים שב-QR, ומיד **החלפת הסיסמה** בסיסמה שרק הטלפון יודע. כך QR שצולם, או קישור
//     שנשלח בטעות, אינם פותחים דבר אחרי הסריקה. החלפה שנכשלה אינה כשל בחיבור — הטלפון ממשיך עם הסיסמה מה-QR.
//   • הפרטים נשמרים במכשיר (localStorage), כדי להתחבר שוב לבד: ה-sessions נגרפים אחרי יממה בלי שימוש
//     (app.prune_auth_sessions), וטלפון שלא פתח את האפליקציה בסוף שבוע היה מגיע למסך התחברות שהטכנאי לא יודע מה לכתוב בו.
//   • forgetDevice — "ניתוק הטלפון הזה": מוחק את הפרטים ויוצא.
// ⚠️ מה שהפרטים פותחים: את המשימה של הטכנאי הזה בלבד (tech_me) — לא את הדשבורד. ניתוק מהכרטיס סוגר את המשתמש במסד מיד.
import { supabase, isSupabaseConfigured } from "./supabase";
import { signIn, signOut } from "./auth";

const KEY = "parkomat.techDevice";

function randomPassword() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** הפרטים השמורים במכשיר, או null. */
export function readDevice() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || "null");
    return o?.email && o?.password ? { email: String(o.email), password: String(o.password) } : null;
  } catch {
    return null;
  }
}

function saveDevice(cred) {
  try { localStorage.setItem(KEY, JSON.stringify(cred)); } catch { /* חסום — הטלפון יבקש QR חדש בפעם הבאה */ }
}

/**
 * חיבור הטלפון מה-QR. מחזיר { ok: true } או { ok: false, error }.
 * ⚠️ ההתחברות מחליפה כל משתמש שהיה מחובר בדפדפן הזה — המסך שואל לפני כן (PairScreen).
 */
export async function pairThisDevice({ email, password }) {
  if (!isSupabaseConfigured) return { ok: false, error: "האימות אינו מוגדר" };
  const { user, error } = await signIn(email, password);
  if (error || !user) {
    // ⚠️ "פרטים שגויים" כאן = ה-QR כבר נסרק (הסיסמה הוחלפה) או שנוצר QR חדש אחריו
    return { ok: false, error: "ה-QR הזה כבר שימש, או שנוצר אחריו QR חדש — יש לבקש מהרכז QR חדש" };
  }
  let kept = password;
  try {
    const next = randomPassword();
    const { error: upErr } = await supabase.auth.updateUser({ password: next });
    if (!upErr) kept = next;
  } catch { /* נשארים עם הסיסמה מה-QR */ }
  saveDevice({ email, password: kept });
  return { ok: true };
}

/** התחברות שקטה מהפרטים השמורים, כשה-session אבד. true = התחבר. */
export async function resumeDevice() {
  const d = readDevice();
  if (!d || !isSupabaseConfigured) return false;
  const { user, error } = await signIn(d.email, d.password);
  return Boolean(user) && !error;
}

/** "ניתוק הטלפון הזה": מוחק את הפרטים מהמכשיר ויוצא. */
export async function forgetDevice() {
  try { localStorage.removeItem(KEY); } catch { /* */ }
  await signOut();
}
