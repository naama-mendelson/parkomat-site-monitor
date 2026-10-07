// services/tasksDirect.js — משימות (קשרי לקוחות / טכני), ישירות ל-PostgREST.
//
// כל הגישה דרך RPC (db/tasks.postgres.sql) — הטבלה סגורה. אין זרוע שרת: התכונה
// נולדה אחרי ש-master יצא משימוש, ובמצב שרת הכפתורים מוסתרים (App, SiteCard).
import { supabase, isSupabaseConfigured } from "./supabase";

export const TASK_KINDS = ["customer", "technical"];
export const TASK_KIND_LABEL = { customer: "קשרי לקוחות", technical: "טכני" };

const HEBREW = /[֐-׿]/;
const NET_RE = /failed to fetch|networkerror|network request failed|load failed|ERR_INTERNET|ERR_NETWORK|abort/i;

function toError(error) {
  const msg = error?.message || String(error || "");
  if (NET_RE.test(msg)) return new Error("אין חיבור לאינטרנט — נסה שוב");
  if (error?.code === "42501") return new Error(HEBREW.test(msg) ? msg : "אין הרשאה");
  // הודעות ה-RPC בעברית ("תיאור המשימה ריק", "אתר לא נמצא") — עוברות כמו שהן
  return new Error(HEBREW.test(msg) ? msg : "הפעולה נכשלה — נסה שוב");
}

async function rpc(name, args, ms = 20_000) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const { data, error } = await supabase.rpc(name, args).abortSignal(ctrl.signal);
    if (error) throw toError(error);
    return data;
  } catch (err) {
    throw err instanceof Error && HEBREW.test(err.message) ? err : toError(err);
  } finally {
    clearTimeout(t);
  }
}

/**
 * המשימות של אתר אחד מסוג אחד (כפתור בכרטיס).
 * @returns {{open: object[], done: object[], doneTotal: number}}
 */
export async function fetchTasks({ kind = null, siteCode = null } = {}) {
  const j = await rpc("tasks_list", { p_kind: kind, p_site_code: siteCode });
  return { open: j?.open ?? [], done: j?.done ?? [], doneTotal: Number(j?.done_total ?? 0) };
}

/**
 * מספרי המשימות הפתוחות לכל אתר: `{ [siteId]: { customer, technical } }` — לשני
 * הכפתורים בכרטיס. ⚠️ מי שאינו צוות מקבל אפס — לא שגיאה (task_counts אינו זורק).
 */
export async function fetchTaskCounts() {
  const rows = await rpc("task_counts", {});
  const bySite = {};
  for (const r of rows || []) {
    if (r.site_id == null || !r.kind) continue;
    (bySite[r.site_id] ??= { customer: 0, technical: 0 })[r.kind] = r.open;
  }
  return { bySite };
}

/** ⚠️ clientId נוצר אצל הקורא ונשלח שוב בניסיון חוזר — כך שליחה כפולה היא משימה אחת. */
export async function addTask({ kind, body, siteCode, clientId }) {
  return Number(await rpc("task_add", { p_kind: kind, p_body: body, p_site_code: siteCode, p_client_id: clientId }));
}

export async function markTaskDone(id) {
  return rpc("task_done", { p_id: id });
}
