// tests/tasks-ui.test.js — הצד של הדשבורד במשימות: תרגום, לא החלטה (utils/tasks.js).
//
// המצב (לביצוע / בתהליך / בוצעה) נקבע ב-SQL ונבדק ב-tasks.test.js. כאן: איך הפתוחות מתחלקות
// לשני החלקים בחלון, מה כתוב בשורת ההיסטוריה של משימה, השורה שבכותרת, והמספר שעל הכפתור בכרטיס.
// החלון עצמו נבדק בדפדפן (e2e/probe-tasks.mjs ב-scratchpad).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskState, splitOpen, historySteps, historyText, openSummary, countsBySite, taskNow, shortName,
  TASK_STATES, TASK_STATE_LABEL, TASK_STEP_LABEL, TASK_BADGE,
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

test("shortName: בלי @parkomat.co.il (כל המשתמשים בדומיין), שם מלא — כמו שהוא", () => {
  assert.equal(shortName("dana@parkomat.co.il"), "dana");
  assert.equal(shortName("NaamaM@Parkomat.co.il"), "NaamaM");
  assert.equal(shortName("דנה כהן"), "דנה כהן");
  assert.equal(shortName("x@gmail.com"), "x@gmail.com", "דומיין אחר — לא נוגעים");
  assert.equal(shortName(null), "");
});

test("taskNow: המצב עכשיו ומי קבע אותו — לא כל השרשרת (12/10/2026)", () => {
  const base = { created_by: "dana@parkomat.co.il", created_at: "2026-10-12T07:14:00.000Z" };
  // לביצוע — מי פתח
  let n = taskNow({ ...base, state: "todo" });
  assert.deepEqual({ s: n.state, l: n.label, by: n.by, when: n.when }, { s: "todo", l: "לביצוע", by: "dana", when: "12/10 10:14" });
  assert.deepEqual(n.opened, { by: "dana", when: "12/10 10:14" });
  // בתהליך — מי סימן ומתי (לא מי פתח)
  n = taskNow({ ...base, state: "in_progress", started_by: "naamam@parkomat.co.il", started_at: "2026-10-12T07:20:00.000Z" });
  assert.deepEqual({ l: n.label, by: n.by, when: n.when, opened: n.opened.by }, { l: "בתהליך", by: "naamam", when: "12/10 10:20", opened: "dana" });
  // בוצעה — מי סימן בוצע
  n = taskNow({ ...base, state: "done", started_by: "naamam@parkomat.co.il", started_at: "2026-10-12T07:20:00.000Z",
    done_by: "sherut@parkomat.co.il", done_at: "2026-10-12T08:00:00.000Z" });
  assert.deepEqual({ l: n.label, by: n.by, when: n.when }, { l: "בוצעה", by: "sherut", when: "12/10 11:00" });
  // ⚠️ "בתהליך" שהוסר: started_* מתאפסות — חוזרים ל"נפתחה ע״י", לא למי שהסיר
  n = taskNow({ ...base, state: "todo", started_by: null, started_at: null });
  assert.equal(n.by, "dana");
  // המצב — מ-state של ה-SQL, ובלעדיו מהעמודות
  assert.equal(taskNow({ ...base, done_at: "2026-10-12T08:00:00.000Z", done_by: "x" }).state, "done");
  assert.deepEqual(TASK_BADGE, { todo: "לביצוע", in_progress: "בתהליך", done: "בוצעה" });
});

test("historyText (הריחוף) — גם בו השמות מקוצרים", () => {
  const t = { history: [
    { action: "created", by: "dana@parkomat.co.il", at: "2026-10-12T07:14:00.000Z" },
    { action: "started", by: "naamam@parkomat.co.il", at: "2026-10-12T07:20:00.000Z" },
  ] };
  assert.equal(historyText(t), "נפתחה 12/10 10:14 ע״י dana ← בתהליך 12/10 10:20 ע״י naamam");
});
