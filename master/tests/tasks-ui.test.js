// tests/tasks-ui.test.js — הצד של הדשבורד במשימות: תרגום, לא החלטה (utils/tasks.js).
//
// המצב (לביצוע / בתהליך / בוצעה) נקבע ב-SQL ונבדק ב-tasks.test.js. כאן: איך הפתוחות מתחלקות
// לשני החלקים בחלון, מה כתוב בשורת ההיסטוריה של משימה, השורה שבכותרת, והמספר שעל הכפתור בכרטיס.
// החלון עצמו נבדק בדפדפן (e2e/probe-tasks.mjs ב-scratchpad).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskState, splitOpen, historySteps, historyText, openSummary, countsBySite,
  TASK_STATES, TASK_STATE_LABEL, TASK_STEP_LABEL,
} from "../../dashboard/src/utils/tasks.js";

const task = (over = {}) => ({
  id: 1, kind: "technical", body: "לגרז שרשרת", state: "todo",
  created_by: "דנה", created_at: "2026-10-01T08:00:00.000Z",
  started_at: null, started_by: null, done_at: null, done_by: null, history: [], ...over,
});

test("taskState: מה שה-SQL אמר; ובלי state מוכר — מהעמודות, לא 'לביצוע' עיוור", () => {
  for (const s of TASK_STATES) assert.equal(taskState(task({ state: s })), s);
  assert.equal(taskState(task({ state: undefined })), "todo");
  assert.equal(taskState(task({ state: undefined, started_at: "2026-10-02T08:00:00.000Z" })), "in_progress");
  assert.equal(taskState(task({ state: "weird", started_at: "x", done_at: "y" })), "done");
  assert.equal(taskState(null), "todo");
});

test("splitOpen: לביצוע ובתהליך, כל אחד בסדר שהגיע (מהוותיקה לחדשה)", () => {
  const open = [task({ id: 1 }), task({ id: 2, state: "in_progress" }), task({ id: 3 }), task({ id: 4, state: "in_progress" })];
  const { todo, inProgress } = splitOpen(open);
  assert.deepEqual(todo.map((t) => t.id), [1, 3]);
  assert.deepEqual(inProgress.map((t) => t.id), [2, 4]);
  assert.deepEqual(splitOpen(), { todo: [], inProgress: [] });
});

test("historySteps / historyText: כל המעברים, בשעון ישראל, עם מי — מהראשון לאחרון", () => {
  const t = task({
    state: "done",
    history: [
      { action: "created", by: "דנה", at: "2026-10-01T08:00:00.000Z" },
      { action: "started", by: "יוסי", at: "2026-10-02T05:30:00.000Z" },
      { action: "unstarted", by: "יוסי", at: "2026-10-02T06:00:00.000Z" },
      { action: "started", by: "משה", at: "2026-10-03T07:00:00.000Z" },
      { action: "done", by: "משה", at: "2026-10-03T21:15:00.000Z" },      // 00:15 למחרת בישראל
    ],
  });
  assert.deepEqual(historySteps(t).map((s) => [s.label, s.when, s.by]), [
    ["נפתחה", "01/10 11:00", "דנה"],
    ["בתהליך", "02/10 08:30", "יוסי"],
    ["הוסר 'בתהליך'", "02/10 09:00", "יוסי"],
    ["בתהליך", "03/10 10:00", "משה"],
    ["בוצעה", "04/10 00:15", "משה"],
  ]);
  assert.equal(historyText(task({ history: t.history.slice(0, 2) })),
    "נפתחה 01/10 11:00 ע״י דנה ← בתהליך 02/10 08:30 ע״י יוסי");
  // פעולה לא מוכרת — לא שורה ריקה עם שם בלי מילה
  assert.deepEqual(historySteps(task({ history: [{ action: "created", by: "דנה", at: t.history[0].at }, { action: "x", by: "?", at: "z" }] }))
    .map((s) => s.action), ["created"]);
  // בלי "מי" — בלי "ע״י"
  assert.equal(historyText(task({ history: [{ action: "created", by: "", at: t.history[0].at }] })), "נפתחה 01/10 11:00");
  for (const a of ["created", "started", "unstarted", "done"]) assert.ok(TASK_STEP_LABEL[a], a);
});

test("historySteps: בלי היסטוריה — מה שהעמודות יודעות, ולא שורה ריקה", () => {
  assert.deepEqual(historySteps(task()).map((s) => [s.action, s.by]), [["created", "דנה"]]);
  const t = task({ history: undefined, started_at: "2026-10-02T05:30:00.000Z", started_by: "יוסי",
    done_at: "2026-10-03T08:00:00.000Z", done_by: "משה" });
  assert.deepEqual(historySteps(t).map((s) => [s.action, s.by, s.when]),
    [["created", "דנה", "01/10 11:00"], ["started", "יוסי", "02/10 08:30"], ["done", "משה", "03/10 11:00"]]);
});

test("openSummary: מה שבכותרת החלון", () => {
  const two = [task(), task()];
  assert.equal(openSummary({ todo: two, inProgress: [task()] }), "2 לביצוע · 1 בתהליך");
  assert.equal(openSummary({ todo: two, inProgress: [] }), "2 לביצוע");
  assert.equal(openSummary({ todo: [], inProgress: two }), "2 בתהליך");
  assert.equal(openSummary({}), "אין משימות פתוחות");
  assert.deepEqual(TASK_STATE_LABEL, { todo: "לביצוע", in_progress: "בתהליך", done: "בוצעו" });
});

test("countsBySite: כל הפתוחות של האתר על הכפתור — גם בלי סוג; אתר שנמחק — מדולג", () => {
  const rows = [
    { kind: "customer", site_id: 7, open: 2 },
    { kind: "technical", site_id: 7, open: 1 },
    { kind: null, site_id: 7, open: 5 },            // ⚠️ מאז 12/10 כל משימה חדשה בלי סוג — נספרת
    { kind: "technical", site_id: 11, open: 4 },
    { kind: "technical", site_id: null, open: 9 },  // אתר שנמחק
    { kind: null, site_id: 12, open: 3 },
  ];
  assert.deepEqual(countsBySite(rows), { 7: { open: 8 }, 11: { open: 4 }, 12: { open: 3 } });
  assert.deepEqual(countsBySite(null), {});
  assert.deepEqual(countsBySite([{ kind: null, site_id: 1, open: "5" }]), { 1: { open: 5 } });
});
