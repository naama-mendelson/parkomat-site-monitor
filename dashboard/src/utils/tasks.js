// utils/tasks.js — משימות: חלוקה לשלושת המצבים ושורת ההיסטוריה של משימה. טהור, בלי DOM.
//
// ⚠️ המצב נקבע ב-SQL (`state` ב-tasks_list, נגזר מ-done_at / started_at) — כאן רק מתרגמים.
// ⚠️ ".js" בייבוא: Node (master/tests/tasks-ui.test.js) לא משלים סיומות, Vite כן.
import { formatStampIL } from "./compliance.js";

export const TASK_STATES = ["todo", "in_progress", "done"];

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
    .map((s) => ({ action: s.action, label: TASK_STEP_LABEL[s.action], by: s.by || "", when: formatStampIL(s.at) }));
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
 * ⚠️ שורה בלי סוג **נספרת**: מאז 12/10/2026 אין בחירת סוג, וכל משימה חדשה היא kind = NULL. הגרסה
 * הקודמת דילגה עליה — כלומר כל משימה חדשה הייתה נעלמת מהמספר.
 */
export function countsBySite(rows = []) {
  const bySite = {};
  for (const r of rows || []) {
    if (r?.site_id == null) continue;
    const s = (bySite[r.site_id] ??= { open: 0 });
    s.open += Number(r.open) || 0;
  }
  return bySite;
}

/** שורת המשנה בכותרת החלון: "2 לביצוע · 1 בתהליך", או "אין משימות פתוחות". */
export function openSummary({ todo = [], inProgress = [] } = {}) {
  const parts = [];
  if (todo.length) parts.push(`${todo.length} ${TASK_STATE_LABEL.todo}`);
  if (inProgress.length) parts.push(`${inProgress.length} ${TASK_STATE_LABEL.in_progress}`);
  return parts.length ? parts.join(" · ") : "אין משימות פתוחות";
}
