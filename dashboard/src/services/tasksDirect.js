// services/tasksDirect.js — משימות של אתר (לביצוע → בטיפול → בוצעה; קשרי לקוחות / טכני), ישירות ל-PostgREST.
//
// כל הגישה דרך RPC (db/tasks.postgres.sql) — הטבלה סגורה. אין זרוע שרת: התכונה
// נולדה אחרי ש-master יצא משימוש, ובמצב שרת הכפתורים מוסתרים (App, SiteCard).
import { supabase, isSupabaseConfigured } from "./supabase";
import { countsBySite } from "../utils/tasks";

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
 * המשימות של אתר (הכפתור בכרטיס) — שני הסוגים יחד, אלא אם kind.
 * open = לביצוע ובטיפול (`state`), done = שבוצעו מהאחרונה, ולכל משימה `history` — כל המעברים שלה.
 * @param {{kind?: string|null, siteCode?: string|null, doneLimit?: number|null}} p — doneLimit null = כל שבוצעו
 * @returns {{open: object[], done: object[], doneTotal: number}}
 */
export async function fetchTasks({ kind = null, siteCode = null, doneLimit = 200 } = {}) {
  const j = await rpc("tasks_list", { p_kind: kind, p_site_code: siteCode, p_done_limit: doneLimit });
  return { open: j?.open ?? [], done: j?.done ?? [], doneTotal: Number(j?.done_total ?? 0) };
}

/**
 * מספרי המשימות הפתוחות (לביצוע + בטיפול) לכל אתר: `{ [siteId]: { customer, technical, open } }` —
 * open הוא שני הסוגים יחד, למספר שעל הכפתור בכרטיס. ⚠️ מי שאינו צוות מקבל אפס — לא שגיאה
 * (task_counts אינו זורק).
 */
export async function fetchTaskCounts() {
  return { bySite: countsBySite(await rpc("task_counts", {})) };
}

/** ⚠️ clientId נוצר אצל הקורא ונשלח שוב בניסיון חוזר — כך שליחה כפולה היא משימה אחת. */
export async function addTask({ kind, body, siteCode, clientId }) {
  return Number(await rpc("task_add", { p_kind: kind, p_body: body, p_site_code: siteCode, p_client_id: clientId }));
}

/** לביצוע → בטיפול (מי ומתי). משימה שכבר בטיפול — נשארת אצל מי שלקח אותה. */
export async function startTask(id) {
  return rpc("task_start", { p_id: id });
}

/** בטיפול → לביצוע. ההיסטוריה זוכרת שהייתה בטיפול. */
export async function unstartTask(id) {
  return rpc("task_unstart", { p_id: id });
}

export async function markTaskDone(id) {
  return rpc("task_done", { p_id: id });
}
