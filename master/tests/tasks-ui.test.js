// tests/tasks-ui.test.js — הצד של הדשבורד במשימות: תרגום, לא החלטה (utils/tasks.js).
//
// המצב (לביצוע / בתהליך / בוצעה) נקבע ב-SQL ונבדק ב-tasks.test.js. כאן: איך הפתוחות מתחלקות
// לשני החלקים בחלון, מה כתוב בשורת ההיסטוריה של משימה, השורה שבכותרת, והמספר שעל הכפתור בכרטיס.
// החלון עצמו נבדק בדפדפן (e2e/probe-tasks.mjs ב-scratchpad).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskState, splitOpen, historySteps, historyText, openSummary, countsBySite, taskNow, shortName, kindLabel,
  DEFAULT_TASKS_VIEW, sanitizeTasksView, tasksPillsShown, matchesTasksView, tasksFilterCounts, tasksViewActive,
  TASK_STATES, TASK_STATE_LABEL, TASK_STEP_LABEL, TASK_BADGE, TASK_KINDS, TASK_KIND_LABEL,
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
  assert.deepEqual(countsBySite(rows), {
    7: { open: 8, byKind: { customer: 2, technical: 1, none: 5 } },
    11: { open: 4, byKind: { technical: 4 } },
    12: { open: 3, byKind: { none: 3 } },
  });
  assert.deepEqual(countsBySite(null), {});
  // task_counts מחזיר 'none' (מחרוזת) לבלי סוג — אותו מפתח כמו NULL
  assert.deepEqual(countsBySite([{ kind: "none", site_id: 1, open: "5" }, { kind: null, site_id: 1, open: 1 }]),
    { 1: { open: 6, byKind: { none: 6 } } });
});

test("סינון משימות (18/10/2026): off כברירת מחדל, all בלי לסנן, open וסוג מסננים", () => {
  assert.equal(DEFAULT_TASKS_VIEW, "off");
  assert.equal(tasksPillsShown("off"), false);
  for (const v of ["all", "open", "customer", "technical", "call_center"]) assert.equal(tasksPillsShown(v), true, v);
  const c = { open: 3, byKind: { technical: 2, none: 1 } };
  assert.equal(matchesTasksView(undefined, "off"), true);
  assert.equal(matchesTasksView(undefined, "all"), true);
  assert.equal(matchesTasksView(undefined, "open"), false);
  assert.equal(matchesTasksView({ open: 0, byKind: {} }, "open"), false);
  assert.equal(matchesTasksView(c, "open"), true);
  assert.equal(matchesTasksView(c, "technical"), true);
  assert.equal(matchesTasksView(c, "customer"), false);
  assert.equal(matchesTasksView(c, "call_center"), false);
  // משימה בלי סוג נספרת ב"כל הפתוחות" ולא באף סוג
  assert.equal(matchesTasksView({ open: 1, byKind: { none: 1 } }, "open"), true);
  assert.equal(matchesTasksView({ open: 1, byKind: { none: 1 } }, "technical"), false);
  assert.equal(tasksViewActive("off"), 0);
  assert.equal(tasksViewActive("all"), 1);   // שונה מברירת המחדל — כמו "כל האתרים" ב"בודק מוסמך"
  assert.equal(tasksViewActive("open"), 1);
  assert.equal(tasksViewActive("call_center"), 1);
});

test("סינון משימות: ערך מהאחסון — מוכר נשאר, סוג שהוסר → all, שבור → off", () => {
  for (const v of ["off", "all", "open", "customer", "technical", "call_center"]) assert.equal(sanitizeTasksView(v), v);
  assert.equal(sanitizeTasksView("installation"), "all");
  assert.equal(sanitizeTasksView(""), "off");
  assert.equal(sanitizeTasksView(null), "off");
  assert.equal(sanitizeTasksView(7), "off");
  assert.equal(sanitizeTasksView({ open: true }), "off");
});

test("סינון משימות: ספירה לכל שורה מתוך האתרים שהלוח מראה", () => {
  // אתר 5 — בלוח ובלי רשומת ספירה בכלל. בלעדיו 4 אתרים בלוח ו-4 מפתחות במפה נתנו אותו מספר, ומוטציה שספרה את המפה שרדה (19/10/2026)
  const sites = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  const bySite = {
    1: { open: 2, byKind: { technical: 1, call_center: 1 } },
    2: { open: 1, byKind: { none: 1 } },
    3: { open: 0, byKind: {} },
    9: { open: 5, byKind: { customer: 5 } },   // אתר שאינו בלוח (למשל מכפיל מוסתר) — לא נספר
  };
  assert.deepEqual(tasksFilterCounts(sites, bySite), { all: 5, open: 2, customer: 0, technical: 1, call_center: 1 });
  assert.deepEqual(tasksFilterCounts([], null), { all: 0, open: 0, customer: 0, technical: 0, call_center: 0 });
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

test("סוגים (12/10/2026, ערב): שלושה, בסדר ובמילים שלה; kindLabel — בלי סוג ריק, לא מוכר — המפתח", () => {
  // ⚠️ הבורר בחלון נבנה מהרשימה הזו, וההודעה "יש לבחור סוג משימה — …" גם. T19 ב-tasks.test.js משווה אותה ל-SQL.
  assert.deepEqual(TASK_KINDS, ["customer", "technical", "call_center"]);
  assert.deepEqual(TASK_KINDS.map(kindLabel), ["קשרי לקוחות", "טכני", "מוקד"]);
  assert.deepEqual(Object.keys(TASK_KIND_LABEL).sort(), [...TASK_KINDS].sort(), "לכל סוג שם, ואין שם בלי סוג");
  // משימה בלי סוג (נפתחה בשעות שלא הייתה בחירה) — בלי תווית, לא "ללא סוג" ולא "null"
  for (const k of [null, undefined, ""]) assert.equal(kindLabel(k), "");
  // סוג שהמסך לא מכיר (מסד חדש מהחבילה) — המפתח, לא ריק: משימה לא נראית "בלי סוג" כשיש לה
  assert.equal(kindLabel("sales"), "sales");
});
