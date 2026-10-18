// utils/tasks.js — משימות: חלוקה לשלושת המצבים ושורת ההיסטוריה של משימה. טהור, בלי DOM.
//
// ⚠️ המצב נקבע ב-SQL (`state` ב-tasks_list, נגזר מ-done_at / started_at) — כאן רק מתרגמים.
// ⚠️ ".js" בייבוא: Node (master/tests/tasks-ui.test.js) לא משלים סיומות, Vite כן.
import { formatStampIL } from "./compliance.js";

export const TASK_STATES = ["todo", "in_progress", "done"];

/**
 * סוגי המשימות, בסדר ובמילים שלה (12/10/2026, ערב: "שיהיה: קשרי לקוחות / טכני / מוקד"). הבחירה הוסרה
 * בבוקר אותו יום וחזרה עם "מוקד". ⚠️ עותק של app.task_kinds() ושל האילוץ tasks_kind_chk ב-SQL —
 * tasks.test.js (T19) משווה את שלושתם. משימה בלי סוג (נפתחה כשלא הייתה בחירה) — kind = null.
 */
export const TASK_KINDS = ["customer", "technical", "call_center"];
export const TASK_KIND_LABEL = { customer: "קשרי לקוחות", technical: "טכני", call_center: "מוקד" };

/** שם הסוג להצגה. בלי סוג — "" (לא "ללא סוג": שורה בלי תווית אומרת את זה בלי רעש). לא מוכר — המפתח. */
export function kindLabel(kind) {
  if (!kind) return "";
  return TASK_KIND_LABEL[kind] ?? String(kind);
}

/**
 * כותרות שלושת המצבים — המילים של בעלת המוצר: "צריך לעשות", "בתהליך", "נעשתה".
 * ⚠️ "בטיפול" הפך ל"בתהליך" ב-12/10/2026 — המילה שלה כשביקשה "סימון של בתהליך" ליד כל משימה.
 */
export const TASK_STATE_LABEL = { todo: "לביצוע", in_progress: "בתהליך", done: "בוצעו" };

/** שם כל מעבר בשורת ההיסטוריה. */
export const TASK_STEP_LABEL = {
  created: "נפתחה",
  started: "בתהליך",
  unstarted: "הוסר 'בתהליך'",
  done: "בוצעה",
};

/** התווית של המצב **עכשיו**, ליד משימה — ביחיד ("בוצעה"), לא "בוצעו" שבכותרת החלק. */
export const TASK_BADGE = { todo: "לביצוע", in_progress: "בתהליך", done: "בוצעה" };

/**
 * שם להצגה, בלי "@parkomat.co.il". ⚠️ כל המשתמשים בדומיין הזה (נאכף ב-SQL, app.allowed_email_domains),
 * כך שהקיצור אינו מאבד מידע — ו-"dana@parkomat.co.il" שלוש פעמים בשורה היה עיקר הרעש (12/10/2026).
 * שם מלא, כשיוגדר, עובר כמו שהוא.
 */
export function shortName(name) {
  return String(name ?? "").replace(/@parkomat\.co\.il$/i, "");
}

/**
 * המצב עכשיו ומי קבע אותו — במקום כל השרשרת (בעלת המוצר, 12/10/2026: "לא רוצה לראות את הלוג אלא מה
 * המצב עכשיו. ומי עשה את זה"). מהעמודות ולא מההיסטוריה: הן "איפה המשימה עכשיו" (started_* מתאפסות
 * כשמסירים את "בתהליך"). `opened` — מי פתח ומתי. השרשרת המלאה נשארת ב-historyText (ריחוף).
 * @returns {{state: string, label: string, by: string, when: string, opened: {by: string, when: string}}}
 */
export function taskNow(t) {
  const state = taskState(t);
  const [by, at] = state === "done" ? [t?.done_by, t?.done_at]
    : state === "in_progress" ? [t?.started_by, t?.started_at]
    : [t?.created_by, t?.created_at];
  return {
    state, label: TASK_BADGE[state], by: shortName(by), when: formatStampIL(at),
    opened: { by: shortName(t?.created_by), when: formatStampIL(t?.created_at) },
  };
}

/** המצב של משימה. ⚠️ state לא מוכר נקרא מהעמודות — לא "לביצוע" עיוור. */
export function taskState(t) {
  if (TASK_STATES.includes(t?.state)) return t.state;
  if (t?.done_at) return "done";
  if (t?.started_at) return "in_progress";
  return "todo";
}

/** הפתוחות (כמו שהגיעו — מהוותיקה לחדשה) → לביצוע ובתהליך. */
export function splitOpen(open = []) {
  const todo = [];
  const inProgress = [];
  for (const t of open) (taskState(t) === "in_progress" ? inProgress : todo).push(t);
  return { todo, inProgress };
}

/**
 * המעברים של משימה, מהראשון לאחרון: `[{action, label, by, when}]`.
 * ⚠️ בלי `history` (לא אמור לקרות — כל משימה נרשמת ביומן כשהיא נפתחת) — מה שהעמודות יודעות,
 * ולא שורה ריקה: משימה בלי "מי ומתי" נראית כאילו איש לא פתח אותה.
 */
export function historySteps(t) {
  let h = Array.isArray(t?.history) && t.history.length ? t.history : null;
  if (!h) {
    h = [{ action: "created", by: t?.created_by, at: t?.created_at }];
    if (t?.started_at) h.push({ action: "started", by: t.started_by, at: t.started_at });
    if (t?.done_at) h.push({ action: "done", by: t.done_by, at: t.done_at });
  }
  return h
    .filter((s) => TASK_STEP_LABEL[s?.action])
    .map((s) => ({ action: s.action, label: TASK_STEP_LABEL[s.action], by: shortName(s.by || ""), when: formatStampIL(s.at) }));
}

/** אותה שורה כטקסט: "נפתחה 01/10 11:00 ע״י דנה ← בתהליך 02/10 08:00 ע״י יוסי". */
export function historyText(t) {
  return historySteps(t)
    .map((s) => [s.label, s.when, s.by && `ע״י ${s.by}`].filter(Boolean).join(" "))
    .join(" ← ");
}

/**
 * שורות task_counts (אתר×סוג) → `{ [siteId]: { open } }` — המספר על כפתור המשימות בכרטיס: כל
 * הפתוחות של האתר. שורה בלי אתר (אתר שנמחק) — מדולגת.
 * ⚠️ שורה בלי סוג **נספרת**: משימות שנפתחו ב-12/10/2026, בשעות שלא הייתה בחירת סוג, הן kind = NULL
 * (ומה-SQL — 'none'). גרסה קודמת דילגה על שורה כזו, כלומר משימה כזו הייתה נעלמת מהמספר.
 */
export function countsBySite(rows = []) {
  const bySite = {};
  for (const r of rows || []) {
    if (r?.site_id == null) continue;
    const s = (bySite[r.site_id] ??= { open: 0, byKind: {} });
    const n = Number(r.open) || 0;
    s.open += n;
    // לפי סוג — לסינון "משימות" שבכותרת (18/10/2026). בלי סוג — 'none' (כך task_counts מחזיר NULL).
    const k = r.kind || "none";
    s.byKind[k] = (s.byKind[k] || 0) + n;
  }
  return bySite;
}

// ============================================================
// "משימות" בסינון שבכותרת (בעלת המוצר, 18/10/2026)
// ============================================================
// "להסתיר כשאין משימות פתוחות, ושיהיה סינון מסוג משימות — מלכתחילה שלא יוצגו", ובחרה "לפי סוג משימה". ערך אחד:
//   "off"  — ברירת המחדל: בלי סימון משימות על הכרטיסים המכווצים (הכפתור "משימות" בכרטיס הפרוש נשאר תמיד);
//   "all"  — הסימון מופיע באתרים שיש בהם משימה פתוחה, בלי לסנן;
//   "open" — רק אתרים עם משימה פתוחה; ומפתח סוג (TASK_KINDS) — רק אתרים עם משימה פתוחה מהסוג הזה.
export const TASKS_VIEW_OFF = "off";
export const TASKS_VIEW_ALL = "all";
export const TASKS_VIEW_OPEN = "open";
export const DEFAULT_TASKS_VIEW = TASKS_VIEW_OFF;

/** ערך שנקרא מהאחסון: מוכר — כמו שהוא; סוג שהוסר — "all" (לא לסנן את הלוח לאפס בלי הסבר); שבור — ברירת המחדל. */
export function sanitizeTasksView(v) {
  if (v === TASKS_VIEW_OFF || v === TASKS_VIEW_ALL || v === TASKS_VIEW_OPEN || TASK_KINDS.includes(v)) return v;
  return typeof v === "string" && v ? TASKS_VIEW_ALL : DEFAULT_TASKS_VIEW;
}

/** האם הסינון מראה סימון משימות על הכרטיסים (כל מה שאינו "off"). */
export const tasksPillsShown = (view) => view !== TASKS_VIEW_OFF;

/** counts — tasks.bySite[site.id] (או undefined). off / all — הכול עובר. */
export function matchesTasksView(counts, view) {
  if (view === TASKS_VIEW_OPEN) return (counts?.open ?? 0) > 0;
  if (TASK_KINDS.includes(view)) return (counts?.byKind?.[view] ?? 0) > 0;
  return true;
}

/** כמה אתרים בכל שורה של הרשימה — מתוך האתרים שהלוח מראה. */
export function tasksFilterCounts(sites = [], bySite = {}) {
  const out = { [TASKS_VIEW_ALL]: (sites || []).length, [TASKS_VIEW_OPEN]: 0 };
  for (const k of TASK_KINDS) out[k] = 0;
  for (const s of sites || []) {
    const c = bySite?.[s.id];
    if ((c?.open ?? 0) > 0) out[TASKS_VIEW_OPEN]++;
    for (const k of TASK_KINDS) if ((c?.byKind?.[k] ?? 0) > 0) out[k]++;
  }
  return out;
}

/** נספר כמסנן פעיל רק כשהוא באמת מסנן את הלוח ("open" או סוג). */
export const tasksViewActive = (view) => (view === TASKS_VIEW_OPEN || TASK_KINDS.includes(view) ? 1 : 0);

/** שורת המשנה בכותרת החלון: "2 לביצוע · 1 בתהליך", או "אין משימות פתוחות". */
export function openSummary({ todo = [], inProgress = [] } = {}) {
  const parts = [];
  if (todo.length) parts.push(`${todo.length} ${TASK_STATE_LABEL.todo}`);
  if (inProgress.length) parts.push(`${inProgress.length} ${TASK_STATE_LABEL.in_progress}`);
  return parts.length ? parts.join(" · ") : "אין משימות פתוחות";
}
