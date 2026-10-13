// services/tasksDirect.js — משימות של אתר (לביצוע → בטיפול → בוצעה), ישירות ל-PostgREST.
//
// כל הגישה דרך RPC (db/tasks.postgres.sql) — הטבלה סגורה. אין זרוע שרת: התכונה
// נולדה אחרי ש-master יצא משימוש, ובמצב שרת הכפתורים מוסתרים (App, SiteCard).
import { supabase, isSupabaseConfigured } from "./supabase";
import { countsBySite } from "../utils/tasks";

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
 * המשימות של אתר (הכפתור בכרטיס) — כל הסוגים יחד, אלא אם kind.
 * open = לביצוע ובטיפול (`state`), done = שבוצעו מהאחרונה, ולכל משימה `history` — כל המעברים שלה.
 * @param {{kind?: string|null, siteCode?: string|null, doneLimit?: number|null}} p — doneLimit null = כל שבוצעו
 * @returns {{open: object[], done: object[], doneTotal: number}}
 */
export async function fetchTasks({ kind = null, siteCode = null, doneLimit = 200 } = {}) {
  const j = await rpc("tasks_list", { p_kind: kind, p_site_code: siteCode, p_done_limit: doneLimit });
  return { open: j?.open ?? [], done: j?.done ?? [], doneTotal: Number(j?.done_total ?? 0) };
}

/**
 * מספרי המשימות הפתוחות (לביצוע + בטיפול) לכל אתר: `{ [siteId]: { open } }` — כל הסוגים יחד, וגם
 * משימות בלי סוג, למספר שעל הכפתור בכרטיס. ⚠️ מי שאינו צוות מקבל אפס — לא שגיאה
 * (task_counts אינו זורק).
 */
export async function fetchTaskCounts() {
  return { bySite: countsBySite(await rpc("task_counts", {})) };
}

/**
 * ⚠️ clientId נוצר אצל הקורא ונשלח שוב בניסיון חוזר — כך שליחה כפולה היא משימה אחת.
 * kind — אחד מ-TASK_KINDS (utils/tasks.js); החלון דורש בחירה. ⚠️ בלי סוג p_kind נשלח **null במפורש**:
 * ל-task_add אין ברירת מחדל ל-p_kind, ופרמטר שחסר בגוף הבקשה הוא חתימה אחרת בעיני PostgREST (404,
 * PGRST202).
 */
export async function addTask({ kind = null, body, siteCode, clientId }) {
  return Number(await rpc("task_add", { p_kind: kind ?? null, p_body: body, p_site_code: siteCode, p_client_id: clientId }));
}

/** לביצוע → בטיפול (מי ומתי). משימה שכבר בטיפול — נשארת אצל מי שלקח אותה. */
export async function startTask(id) {
  return rpc("task_start", { p_id: id });
}

/** בטיפול → לביצוע. ההיסטוריה זוכרת שהייתה בטיפול. */
export async function unstartTask(id) {
  return rpc("task_unstart", { p_id: id });
}

// ============================================================
// קוד המנהל — פותח V ו-X לכל איש צוות (12/10/2026)
// ============================================================
// ⚠️ בזיכרון בלבד, לא ב-sessionStorage: "הקוד עצמו אינו נשמר" (adminCodeDirect) — קוד שנשמר בדפדפן
// הוא קוד שדלף. רענון שוכח אותו. ההחלטה ב-SQL (app.task_code_ok); כאן רק מה נשלח.
// ⚠️ p_code נשלח רק כשיש קוד: בלעדיו הגוף { p_id } זהה למה שהיה, ועובד גם מול מסד שעוד לא קיבל את
// החתימה החדשה.
//
// ⚠️ **שייך למשתמש שהזין אותו, ונמחק בהתנתקות או בהחלפת משתמש** (נמצא בסקירה, 13/10/2026). המשתנה חי עם
// הלשונית, ובמסך משותף בחדר הבקרה: א' מזין קוד ומתנתק, ב' (בקר) מתחבר באותה לשונית — והחלון נפתח
// "פתוח", ו-ב' מסמן בוצע ומוחק בשם הקוד של א'. כל שינוי זהות (התנתקות, משתמש אחר) מוחק אותו.
let taskCode = null;
let currentUser = null;   // מזהה המשתמש המחובר, מעודכן מאירועי ההזדהות
let codeOwner = null;     // מי שהזין את הקוד
export const hasTaskCode = () => taskCode !== null && codeOwner === currentUser;
export function setTaskCode(code) {
  taskCode = code ? String(code) : null;
  codeOwner = taskCode ? currentUser : null;
}
try {
  supabase?.auth?.onAuthStateChange?.((event, session) => {
    const uid = session?.user?.id ?? null;
    if (event === "SIGNED_OUT" || uid !== currentUser) { taskCode = null; codeOwner = null; }
    currentUser = uid;
  });
} catch { /* Supabase לא מוגדר — אין משתמש ואין קוד */ }
const withCode = (args) => (hasTaskCode() ? { ...args, p_code: taskCode } : args);

export async function markTaskDone(id) {
  return rpc("task_done", withCode({ p_id: id }));
}

/**
 * "X" — מחיקה לגמרי: המשימה וכל ההיסטוריה שלה (12/10/2026). מנהל, sherut@, או מי שהזין את קוד המנהל.
 * מחזיר false כשהמשימה כבר איננה (לחיצה כפולה, מסך אחר) — לא שגיאה. משימה שבוצעה — PT409.
 */
export async function deleteTask(id) {
  return rpc("task_delete", withCode({ p_id: id }));
}
