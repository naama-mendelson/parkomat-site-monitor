// services/serviceCallsDirect.js — קריאות השירות של ויזנט: הספירה לכרטיס, הרשימה לאתר, ושינוי סטטוס/סוג.
//
// הקריאה — RPC (db/service-calls-board.postgres.sql). השינוי — דרך פונקציית ה-Edge "wizenet", כי ה-API של ויזנט
// דורש טוקן שאסור שיגיע לדפדפן. ⚠️ אין כאן החלטה על הרשאה: הפונקציה בודקת my_role() מול המסד, והמסד אוכף
// את הרישום (app.require_staff).
import { supabase, isSupabaseConfigured } from "./supabase";
import { countsBySite } from "../utils/serviceCalls";

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

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

/** כמה קריאות היו ב-N השעות — למספר על הכפתור בכותרת */
export async function fetchRecentServiceCallCount(hours = 24) {
  return Number(await rpc("service_calls_recent_count", { p_hours: hours })) || 0;
}

/** רשימות הסטטוסים והסוגים של ויזנט: { status: [{id,name,closed}], type: [{id,name}] } */
export async function fetchServiceCallLookups() {
  return (await rpc("wizenet_lookups_list", {})) ?? { status: [], type: [] };
}

async function callWizenet(body) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("נדרשת התחברות מחדש");
  const res = await fetch(`${FUNCTIONS_URL}/wizenet`, {
    method: "POST",
    headers: {
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "הפעולה מול ויזנט נכשלה");
  return out;
}

/** שינוי סטטוס או סוג של קריאה — אצל ויזנט, ואחרי האישור שלהם גם אצלנו. field: "status" | "type" */
export async function updateServiceCall(ticket, field, value) {
  return callWizenet({ action: "update", field, callid: String(ticket), value: String(value) });
}

/** טעינת הרשימות מוויזנט אל המסד (חד-פעמי, ואחרי שינוי אצלם) */
export async function refreshServiceCallLookups() {
  return callWizenet({ action: "lookups" });
}
