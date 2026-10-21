// services/techPush.js — "הפעלת צפצוף" בטלפון של הטכנאי (21/10/2026, שלב 4 של "צא ל:").
//
// Web Push דרך ה-Service Worker הקיים (public/sw.js, kind = "dispatch"), ומפתח ה-VAPID הקיים (VITE_VAPID_PUBLIC_KEY — אותו
// מפתח ש-notify-tech חותם בו). המנוי נשמר ב-tech_push_subs דרך tech_push_subscribe — לא ב-push_subscriptions של התראות
// התקלות (ראה technicians.postgres.sql).
// ⚠️ ההרשאה דורשת לחיצה: הדפדפן מסרב לבקש אותה בלי פעולה של המשתמש. לכן כפתור, ולא בקשה אוטומטית בכניסה.
// ⚠️ syncTechPush — בלי לבקש הרשאה: כשהיא כבר ניתנה, שולח למסד את המנוי הקיים (אחרי QR חדש המנויים של המשתמש הקודם
// נמחקו, והדפדפן עדיין מחזיק את אותו endpoint).
import { subscribeTechPush } from "./techniciansDirect";

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY;

function keyBytes(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** unsupported | default | granted | denied */
export function techPushState() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

async function subscription() {
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  return existing || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) });
}

async function save(sub) {
  const j = sub.toJSON();
  return subscribeTechPush(j.endpoint, j.keys?.p256dh, j.keys?.auth);
}

// ⚠️ שגיאות הדפדפן באנגלית (DOMException: "Registration failed - push service error") — לטכנאי בעברית
const SUBSCRIBE_FAILED = "ההרשמה לצפצוף נכשלה — כדאי לבדוק קליטה ולנסות שוב. אם זה חוזר, כנראה שהטלפון לא תומך בצפצוף מהדפדפן.";

/** הכפתור: מבקש הרשאה, נרשם ושומר. מחזיר את מצב ההרשאה; זורק Error בעברית על כשל אמיתי.
 *  fresh — מבטל קודם מנוי קיים ונרשם מחדש (המסד לא הכיר את הקודם: נמחק כשהשירות אמר שהוא כבר לא קיים). */
export async function enableTechPush({ fresh = false } = {}) {
  const st = techPushState();
  if (st === "unsupported") throw new Error("הטלפון הזה אינו תומך בצפצוף מהדפדפן — צריך טלפון אנדרואיד עם Chrome");
  if (!VAPID_PUBLIC) throw new Error("מפתח הצפצוף אינו מוגדר בבנייה");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission;
  try {
    if (fresh) await unsubscribeTechPush();
    await save(await subscription());
  } catch (e) {
    throw new Error(/[א-ת]/.test(e?.message || "") ? e.message : SUBSCRIBE_FAILED);
  }
  return "granted";
}

/** בלי לבקש: ההרשאה כבר ניתנה — לוודא שהמסד מכיר את המנוי. fresh — מנוי חדש. מחזיר true כשנשלח. */
export async function syncTechPush({ fresh = false } = {}) {
  if (techPushState() !== "granted" || !VAPID_PUBLIC) return false;
  if (fresh) await unsubscribeTechPush();
  await save(await subscription());
  return true;
}

/** ביטול ההרשמה לצפצוף בדפדפן הזה ("ניתוק הטלפון הזה", או לפני מנוי חדש). true = היה מנוי. */
export async function unsubscribeTechPush() {
  if (techPushState() === "unsupported") return false;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager?.getSubscription();
  if (!sub) return false;
  await sub.unsubscribe();
  return true;
}
