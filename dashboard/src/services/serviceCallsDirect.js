// services/serviceCallsDirect.js — קריאות השירות של ויזנט: הספירה לכרטיס, הרשימה לאתר, ושינוי סטטוס/סוג.
//
// הקריאה — RPC (db/service-calls-board.postgres.sql). השינוי — תור במסד שמחשב באתר מבצע (db/wizenet-relay.postgres.sql):
// ה-API של ויזנט דורש טוקן שאסור שיגיע לדפדפן, ועונה רק לפניות מישראל. ⚠️ אין כאן החלטה על הרשאה: המסד אוכף
// (app.require_staff), ורושם את השינוי רק אחרי שוויזנט ענו.
import { supabase, isSupabaseConfigured } from "./supabase";
import { countsBySite } from "../utils/serviceCalls";

async function rpc(name, args) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(/[֐-׿]/.test(error.message || "") ? error.message : "הפעולה נכשלה — נסה שוב");
  return data;
}

/** מספר הקריאות הפתוחות לכל אתר: { bySite: { [siteId]: { open } } } */
export async function fetchServiceCallCounts() {
  return { bySite: countsBySite(await rpc("service_call_counts", {})) };
}

/**
 * הקריאות של אתר: הפתוחות (בכל גיל), ועם hours — גם מה שנסגר בחלון הזה. פתוחות קודם.
 * ⚠️ hours נשלח רק כשהוא ניתן: קריאה בלי הפרמטר נפתרת גם מול מסד ישן.
 */
export async function fetchServiceCalls(siteCode, hours = null) {
  const args = hours == null ? { p_site_code: siteCode } : { p_site_code: siteCode, p_hours: hours };
  return (await rpc("service_calls_open", args)) ?? [];
}

// ⚠️ "קריאות היום" (14/10/2026): הסימון על הכרטיס מראה רק **פתוחות** ורק לאתר שמוכר לנו, וביום
// הראשון זה היה 1 מתוך 22. כאן הכול — כולל סגורות וכולל קודים שאין להם אתר, שאחרת אינם נראים בשום מקום.
/** כל הקריאות מ-N השעות האחרונות, החדשה ראשונה */
export async function fetchRecentServiceCalls(hours = 24) {
  return (await rpc("service_calls_recent", { p_hours: hours })) ?? [];
}

/**
 * לאריח "קריאות היום" בכותרת: { total, open } — כמה בכלל, וכמה מהן פתוחות (15/10/2026, בעלת המוצר: "שיהיה כתוב
 * כמה פתוחות"). ⚠️ אותה קבוצה בדיוק כמו fetchRecentServiceCalls — כולל פתוחות בכל גיל — כדי שהמספר והרשימה
 * שנפתחת ממנו לא ייפרדו.
 */
export async function fetchRecentServiceCallSummary(hours = 24) {
  const r = await rpc("service_calls_recent_summary", { p_hours: hours });
  return { total: Number(r?.total) || 0, open: Number(r?.open) || 0 };
}

/**
 * "להיסטוריה" (15/10/2026): הקריאות של אתר שכבר נסגרו, החדשה למעלה — { calls, total }. total הוא כמה יש בכלל;
 * המסד מחזיר עד 100 (ראו service_calls_history), והחלון אומר כשיש יותר.
 */
export async function fetchServiceCallHistory(siteCode) {
  const r = await rpc("service_calls_history", { p_site_code: siteCode });
  return { calls: r?.calls ?? [], total: Number(r?.total) || 0 };
}

/** רשימות הסטטוסים והסוגים של ויזנט: { status: [{id,name,closed}], type: [{id,name}] } */
export async function fetchServiceCallLookups() {
  return (await rpc("wizenet_lookups_list", {})) ?? { status: [], type: [] };
}

// ============================================================
// שינוי בוויזנט — דרך ממסר (מחשב באתר), 15/10/2026
// ============================================================
// ⚠️ ויזנט עונים רק לפניות מישראל, ולכן הפנייה יוצאת ממחשב באתר (db/wizenet-relay.postgres.sql). הדפדפן לא מדבר
// עם ויזנט ולא עם הממסר: הוא מכניס בקשה לתור, ושואל מה קרה לה עד שהיא נסגרת — הצלחה, כשל, או פקיעה. המסד הוא
// שקובע מתי בקשה נסגרת (2 דקות בלי ממסר; דקה נוספת לממסר שלקח ולא חזר), ולכן כאן אין טיימר "הצלחה מדומה".
// ⚠️ שאלה כל שנייה ולא Realtime: אירוע שפוספס היה משאיר את החלון על "נשלח…" לנצח (Realtime אינו שולח שוב),
// ובקשה היא דבר של שניות — עשרות שאלות קטנות לכל היותר.
const FINAL = new Set(["done", "failed", "expired"]);

/**
 * מחכה שבקשה לממסר תיסגר. ⚠️ התקרה כאן (5 דקות) היא רשת ביטחון בלבד: המסד סוגר כל בקשה תוך 4 לכל היותר
 * (2 דקות בלי ממסר, ועוד חכירה של 2 לממסר שלקח ולא חזר).
 * ⚠️ שאלה שנכשלה (רשת בטלפון, הפסקה רגעית) **אינה** כשל של הבקשה — היא עדיין בתור, והממסר יבצע אותה. "הפעולה נכשלה"
 * כאן היה שולח את המשתמש ללחוץ שוב, ושינוי אחד היה נשלח פעמיים (סקירה, 15/10/2026). ממשיכים לשאול עד התקרה; רק
 * "הבקשה לא נמצאה" (PT404) סופית.
 * @returns {Promise<{state:string, result:string}>}
 */
export async function waitForWizenet(id, { intervalMs = 1000, maxMs = 300_000, sleep } = {}) {
  const pause = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const until = Date.now() + maxMs;
  for (;;) {
    // supabase-js מחזיר כשל רשת כ-error, אבל לא מבטיח שלא יזרוק — שני המקרים הם "לשאול שוב"
    const { data: st, error } = await supabase.rpc("wizenet_request_status", { p_id: id })
      .then((r) => r, (e) => ({ data: null, error: { message: String(e?.message ?? e) } }));
    if (error?.code === "PT404") throw new Error(error.message || "הבקשה לא נמצאה");
    if (!error && FINAL.has(st?.state)) return st;
    if (Date.now() > until) return { state: "expired", result: "אין תשובה מוויזנט — לא ידוע אם השינוי נשמר" };
    await pause(intervalMs);
  }
}

/** האם יש היום ממסר חי: { alive, enabled } */
export async function fetchWizenetRelayStatus() {
  return (await rpc("wizenet_relays_status", {})) ?? { alive: 0, enabled: 0 };
}

/**
 * שינוי סטטוס או סוג של קריאה — אצל ויזנט (דרך הממסר), ואחרי האישור שלהם גם אצלנו. field: "status" | "type"
 * ⚠️ נזרק על כשל ועל פקיעה, עם ההסבר מהמסד בעברית. "עודכן בוויזנט אבל לא נרשם אצלנו" אינו כשל — השינוי קרה —
 * ולכן הוא חוזר כ-warning, כמו קודם.
 */
export async function updateServiceCall(ticket, field, value, opts) {
  const id = await rpc("wizenet_request_update", { p_ticket: String(ticket), p_field: field, p_value: String(value) });
  const st = await waitForWizenet(id, opts);
  if (st.state !== "done") throw new Error(st.result || "השינוי לא נשמר בוויזנט");
  return st.result && st.result !== "עודכן בוויזנט" ? { ok: true, warning: st.result } : { ok: true };
}

/** טעינת הרשימות מוויזנט אל המסד (דרך הממסר). מחזיר { result } — "נטענו N סטטוסים ו-M סוגי קריאה" */
export async function refreshServiceCallLookups(opts) {
  const id = await rpc("wizenet_request_lookups", {});
  const st = await waitForWizenet(id, opts);
  if (st.state !== "done") throw new Error(st.result || "טעינת הרשימות נכשלה");
  return { result: st.result };
}
