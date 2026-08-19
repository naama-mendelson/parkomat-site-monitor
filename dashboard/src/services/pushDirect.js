// services/pushDirect.js — הרשמה להתראות תקלה, ישירות מול Supabase.
//
// ============================================================
// מה זה עושה, ומה **לא**
// ============================================================
// רושם את המכשיר אצל שירות ה-push של הדפדפן, ושומר את המנוי ב-Postgres.
// **השליחה עצמה אינה כאן ואינה בשרת** — היא Edge Function, כי ה-master
// נופל, וזה בדיוק הרגע שבו התראה נחוצה.
//
// ⚠️ ההרשאה נשמרת ברמת הדפדפן ולא אצלנו. משתמשת שסירבה — הדפדפן זוכר,
// ו**אי אפשר לשאול אותה שוב**; רק היא יכולה לאפס בהגדרות האתר. לכן הבקשה
// נעשית מכפתור מפורש ואחרי הסבר, ולעולם לא בטעינת הדף.
import { supabase, isSupabaseConfigured } from "./supabase";

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY;

/** האם הדפדפן מסוגל בכלל. אייפון: רק כאפליקציה מותקנת, מ-iOS 16.4. */
export function pushSupported() {
  return typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
}

/**
 * מצב ההרשאה: 'granted' | 'denied' | 'default' | 'unsupported' | 'unconfigured'.
 *
 * ⚠️ 'denied' ו-'default' אינם אותו דבר, וזו ההבחנה שהמסך חייב להציג:
 * מ-'default' אפשר לבקש, מ-'denied' **לעולם לא** — שם הפתרון היחיד הוא
 * הגדרות הדפדפן. מסך שמציג להם אותו כפתור מבטיח הבטחה שלא תתקיים.
 */
export function pushPermission() {
  if (!pushSupported()) return "unsupported";
  if (!VAPID_PUBLIC) return "unconfigured";
  return Notification.permission;
}

// ⚠️ מפתח ה-VAPID מגיע כ-base64url, ו-PushManager דורש Uint8Array. בלי
// ההמרה הקריאה נכשלת ב-"InvalidCharacterError" שאינו מרמז על הסיבה.
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * מבקש הרשאה, נרשם, ושומר את המנוי. מחזיר את מצב ההרשאה בסוף.
 * זורק Error עם הודעה בעברית על כשל אמיתי.
 */
export async function enablePush() {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  if (!pushSupported()) throw new Error("הדפדפן הזה אינו תומך בהתראות");
  if (!VAPID_PUBLIC) throw new Error("מפתח ההתראות אינו מוגדר בבנייה (VITE_VAPID_PUBLIC_KEY)");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission;

  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  // ⚠️ getSubscription לפני subscribe: אותו דפדפן מחזיר את אותו endpoint,
  // וקריאה חוזרת ל-subscribe עם מפתח שונה זורקת. זה גם מה שהופך את
  // הכפתור לאידמפוטנטי — לחיצה שנייה אינה יוצרת מנוי כפול.
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || await reg.pushManager.subscribe({
    // ⚠️ חובה true. הדפדפנים דוחים מנוי שאינו userVisibleOnly — כלומר
    // כזה שיכול לקבל push בלי להציג דבר. זו הגנה מפני מעקב, לא הגדרה.
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
  });

  const json = sub.toJSON();

  // ⚠️ app_user_id נשלף מהמסד ולא מהאסימון: הוא המזהה המספרי שלנו, בעוד
  // האסימון נושא את ה-UUID של Supabase. מדיניות ה-RLS משווה מולו.
  // ⚠️ **דרך RPC, ולא select על app_users.** הגרסה הראשונה עשתה
  // .select("id").limit(1) — וזה מחזיר את **השורה הראשונה בטבלה**, לא את
  // המשתמש הנוכחי: app_users קריא לכל מחובר. התוצאה הייתה מזהה של מישהו
  // אחר, ומדיניות ה-INSERT דחתה ב-403 "violates row-level security" —
  // שגיאה שנראית כמו בעיית הרשאות ובאמת הייתה מזהה שגוי.
  const { data: myId, error: meErr } = await supabase.rpc("my_app_user_id");
  if (meErr) throw new Error(meErr.message || "לא ניתן לזהות את המשתמש");
  if (!myId) throw new Error("המשתמש אינו פעיל במערכת");

  // ⚠️ upsert על endpoint, ולא insert: אישור חוזר באותו מכשיר מחזיר את
  // אותו endpoint, ו-insert היה נכשל על אילוץ הייחודיות ומציג שגיאה על
  // פעולה שהצליחה בפועל.
  const { error } = await supabase.from("push_subscriptions").upsert({
    app_user_id: myId,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent.slice(0, 300),
    created_at: new Date().toISOString(),
  }, { onConflict: "endpoint" });

  if (error) throw new Error(error.message || "שמירת המנוי נכשלה");
  return "granted";
}

/** ביטול המנוי של המכשיר הזה. אינו נוגע במכשירים אחרים של אותה משתמשת. */
export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = reg && await reg.pushManager.getSubscription();
  if (!sub) return { removed: 0 };

  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});

  // ⚠️ המחיקה במסד גם אם unsubscribe נכשל: מנוי שנשאר בטבלה ימשיך לקבל
  // ניסיונות שליחה לנצח, וכל אחד מהם עולה זמן ב-Edge Function.
  const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) throw new Error(error.message || "ביטול המנוי נכשל");
  return { removed: 1 };
}

/**
 * האתרים שנבחרו. **מערך ריק = כל האתרים**, וזו ברירת המחדל.
 * ⚠️ ההבחנה הזו חייבת להגיע למסך: "ריק" אינו "אף אתר".
 */
export async function getPushSites() {
  const { data, error } = await supabase.from("push_user_sites").select("site_id");
  if (error) throw new Error(error.message || "שליפת ההעדפות נכשלה");
  return (data || []).map((r) => r.site_id);
}

/** קובע את רשימת האתרים. מערך ריק מחזיר ל"כל האתרים". */
export async function setPushSites(siteIds) {
  const { data: myId } = await supabase.rpc("my_app_user_id");
  if (!myId) throw new Error("המשתמש אינו פעיל במערכת");

  // ⚠️ מחיקה ואז הוספה, ולא diff: הרשימה קצרה (12 אתרים), והפרש שגוי
  // משאיר העדפה שאיש לא ביקש — כשל שקט שמתגלה רק כשהתראה לא מגיעה.
  const { error: delErr } = await supabase
    .from("push_user_sites").delete().eq("app_user_id", myId);
  if (delErr) throw new Error(delErr.message || "עדכון ההעדפות נכשל");

  if (!siteIds.length) return { sites: 0 };

  const { error } = await supabase.from("push_user_sites")
    .insert(siteIds.map((id) => ({ app_user_id: myId, site_id: id })));
  if (error) throw new Error(error.message || "עדכון ההעדפות נכשל");
  return { sites: siteIds.length };
}
