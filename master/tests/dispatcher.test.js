// tests/dispatcher.test.js — C1 + C4 + C3 מקצה לקצה בשכבת הניתוב.
//
// ה-dispatcher נטען כאן עם מודולים מזויפים במקום שכבת ה-DB והמטפלים, כדי לבדוק
// את *ההחלטות* שלו בלי מסד נתונים: מי נדחה, מי עובר, ובאיזה חותם זמן.
// ההזרקה נעשית דרך require.cache — בלי שום תלות חדשה.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const DISPATCHER = require.resolve("../ingestion/dispatcher");
const QUERIES = require.resolve("../db/queries");
const STATE_HANDLER = require.resolve("../ingestion/state-handler");
const OPERATION_HANDLER = require.resolve("../ingestion/operation-handler");
const BRIDGE_HANDLER = require.resolve("../ingestion/bridge-handler");
const { resetClampMemo } = require("../ingestion/clamp-memo");

const stub = (filename, exports) => {
  require.cache[filename] = {
    id: filename, filename, path: path.dirname(filename),
    loaded: true, children: [], paths: [], exports,
  };
};

/**
 * טוען dispatcher טרי מעל שכבות מזויפות, ומחזיר את מה שנקלט בפועל.
 * sites = מפה מקוד-אתר לאובייקט אתר; קוד שאינו במפה = אתר לא רשום.
 */
function loadDispatcher(sites) {
  const calls = { state: [], operation: [], bridge: [] };
  const logs = [];

  stub(QUERIES, { findSiteByCode: async (code) => sites[code] ?? undefined });
  stub(STATE_HANDLER, { handleState: async (site, data) => calls.state.push({ site, data }) });
  stub(OPERATION_HANDLER, { handleOperation: async (site, data) => calls.operation.push({ site, data }) });
  stub(BRIDGE_HANDLER, { handleBridgeState: async (site, raw) => calls.bridge.push({ site, raw }) });

  delete require.cache[DISPATCHER];
  const { handleMessage } = require(DISPATCHER);

  // ⚠️ בידוד: זיכרון החלטות היישור (clamp-memo) הוא מצב ברמת המודול, והוא
  // *לא* נמחק עם ה-require.cache של ה-dispatcher. בלי האיפוס, שתי בדיקות
  // שמשתמשות באותו (אתר, חותם מדווח) — וזה קורה, כי כולן רצות באותה שנייה
  // עם אותו SITE — היו נראות כאילו השנייה לא יושרה, בזמן שהיא רק קיבלה את
  // ההחלטה שנזכרה מהראשונה. זו התנהגות נכונה בייצור ורעש בבדיקות.
  resetClampMemo();

  // לוכדים את הלוג כדי לאמת שדחייה **נרשמת** ולא נעלמת בשקט.
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"]) {
    console[level] = (...args) => logs.push(args.join(" "));
  }
  const restore = () => Object.assign(console, original);

  return { handleMessage, calls, logs, restore };
}

const SITE = {
  id: 7, code: "2439", site_name: "אילת 4",
  status: "ready", registered_at: "2026-07-01T00:00:00.000Z",
};

const nowSec = () => Math.floor(Date.now() / 1000);

const opPayload = (over = {}) => JSON.stringify({
  timestamp: nowSec(), start_end: "end", entry_exit: "exit",
  user: "12", cycle_counter: 1517, state: "operating", ...over,
});

// ============================================================
// C4 — אתר שאינו רשום נדחה, ולא נתלה על אתר אחר
// ============================================================

test("C4: operation מקוד אתר שאינו רשום — נדחה ונרשם", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    await d.handleMessage("sites/9999/operation", opPayload());
    assert.equal(d.calls.operation.length, 0, "אסור שהפעולה תיקלט");
    assert.ok(
      d.logs.some((l) => l.includes("9999") && l.includes("לא רשום")),
      "הדחייה חייבת להירשם בלוג");
  } finally { d.restore(); }
});

test("C4: אותם קודים שנצפו בשטח (1122/1234/0/ריק) — כולם נדחים", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    for (const code of ["1122", "1234", "0"]) {
      await d.handleMessage(`sites/${code}/operation`, opPayload());
      await d.handleMessage(`sites/${code}/bridge`, "0");
    }
    // topic עם קוד ריק אינו תקין כלל
    await d.handleMessage("sites//bridge", "0");

    assert.equal(d.calls.operation.length, 0);
    assert.equal(d.calls.bridge.length, 0);
  } finally { d.restore(); }
});

test("C4: אתר רשום — נקלט, ותמיד עם אובייקט האתר הנכון", async () => {
  const other = { ...SITE, id: 99, code: "3452" };
  const d = loadDispatcher({ 2439: SITE, 3452: other });
  try {
    await d.handleMessage("sites/2439/operation", opPayload());
    await d.handleMessage("sites/3452/operation", opPayload());

    assert.equal(d.calls.operation.length, 2);
    assert.equal(d.calls.operation[0].site.id, 7);
    assert.equal(d.calls.operation[1].site.id, 99, "אסור לערבב בין אתרים");
  } finally { d.restore(); }
});

// ============================================================
// C1 — מפתח ה-dedup יציב על פני מסירה חוזרת
// ============================================================

test("C1: אותה הודעה שנמסרת פעמיים — מפתח ה-dedup זהה בשתי הפעמים", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    // אותו payload בדיוק — כך נראית מסירה חוזרת של QoS-1, וכך נראה גם
    // ניסיון חוזר של הסוכן (pendingOps שומר את ההודעה עם החותם המקורי).
    const payload = opPayload({ timestamp: nowSec() - 10 });

    await d.handleMessage("sites/2439/operation", payload);
    await d.handleMessage("sites/2439/operation", payload);

    assert.equal(d.calls.operation.length, 2, "שתיהן מגיעות למטפל");
    const [a, b] = d.calls.operation;

    // אלה השדות שמרכיבים את ux_operations_dedup. אם הם זהים — האינדקס יחסום
    // את השנייה. reported_timestamp הוא הזמן, והוא חייב להיות יציב.
    for (const field of ["reported_timestamp", "start_end", "entry_exit", "user"]) {
      assert.equal(a.data[field], b.data[field], `${field} חייב להיות יציב`);
    }
  } finally { d.restore(); }
});

test("C1×C3: גם כשהחותם מיושר — reported_timestamp נשאר המקורי ויציב", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    // שעון שמקדים ב-34s: occurred_at יושר, אבל מפתח ה-dedup לא.
    const reported = nowSec() + 34;
    await d.handleMessage("sites/2439/operation", opPayload({ timestamp: reported }));

    assert.equal(d.calls.operation.length, 1, "מיושר ומקובל — לא נדחה");
    const op = d.calls.operation[0].data;

    assert.equal(op.reported_timestamp, reported, "המקור נשמר — זהו מפתח ה-dedup");
    assert.notEqual(op.timestamp, reported, "והזמן שנשמר כ-occurred_at יושר");
    assert.ok(Math.abs(op.timestamp - nowSec()) <= 1, "יושר לזמן השרת");
  } finally { d.restore(); }
});

test("C1: השרת אינו מחליף את החותם בזמן הקליטה", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    // חותם מלפני 4 ימים — replay מהתור של HiveMQ אחרי נפילת שרת.
    const past = Math.floor(Date.parse("2026-07-22T13:25:23Z") / 1000);
    await d.handleMessage("sites/2439/operation", opPayload({ timestamp: past }));

    assert.equal(d.calls.operation.length, 1);
    assert.equal(d.calls.operation[0].data.timestamp, past,
      "השלמה מהתור חייבת לשמור על הזמן שבו האירוע *קרה*");
  } finally { d.restore(); }
});

// ============================================================
// C3 — חותמי זמן בלתי-אפשריים
// ============================================================

test("C3: חותם שעה בעתיד — נדחה ונרשם", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    await d.handleMessage("sites/2439/operation", opPayload({ timestamp: nowSec() + 3600 }));
    assert.equal(d.calls.operation.length, 0);
    assert.ok(d.logs.some((l) => l.includes("בעתיד")), "חייב להירשם");
  } finally { d.restore(); }
});

test("C3: סחיפה של 34s (אתר 1343) — מיושרת ונקלטת, עם אזהרה", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    await d.handleMessage("sites/2439/operation", opPayload({ timestamp: nowSec() + 34 }));
    assert.equal(d.calls.operation.length, 1, "אסור לדחות — זה היה משתיק את האתר");
    assert.ok(d.logs.some((l) => l.includes("יושר") || l.includes("מקדים")));
  } finally { d.restore(); }
});

test("C3: אפוק-אפס בהודעת operation — נדחה", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    await d.handleMessage("sites/2439/operation", opPayload({ timestamp: 0 }));
    assert.equal(d.calls.operation.length, 0);
  } finally { d.restore(); }
});

test("C3: אפוק-אפס בהודעת state שאינה no_comm — נדחה", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    await d.handleMessage("sites/2439/state",
      JSON.stringify({ timestamp: 0, state: "ready" }));
    assert.equal(d.calls.state.length, 0, "רק no_comm פטורה מהבדיקה");
  } finally { d.restore(); }
});

test("C3: חותם לפני רישום האתר — נדחה", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    const before = Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000);
    await d.handleMessage("sites/2439/operation", opPayload({ timestamp: before }));
    assert.equal(d.calls.operation.length, 0);
    assert.ok(d.logs.some((l) => l.includes("לפני רישום")));
  } finally { d.restore(); }
});

test("C3: הודעת state עתידית נדחית גם היא", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    await d.handleMessage("sites/2439/state",
      JSON.stringify({ timestamp: nowSec() + 86400, state: "ready" }));
    assert.equal(d.calls.state.length, 0);
  } finally { d.restore(); }
});

test("C3: LWT של no_comm (timestamp=0) פטור — הוא נוצר בברוקר", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    await d.handleMessage("sites/2439/state",
      JSON.stringify({ timestamp: 0, state: "no_comm" }));
    assert.equal(d.calls.state.length, 1, "הצוואה חייבת לעבור — היא מזהה נתק");
  } finally { d.restore(); }
});

// ============================================================
// רגרסיה — מה שהיה תקין נשאר תקין
// ============================================================

test("רגרסיה: הודעות תקינות (state + operation + bridge) נקלטות כרגיל", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    await d.handleMessage("sites/2439/state",
      JSON.stringify({ timestamp: nowSec(), state: "operating" }));
    await d.handleMessage("sites/2439/operation",
      opPayload({ start_end: "start", cycle_counter: 1517 }));
    await d.handleMessage("sites/2439/operation", opPayload());
    await d.handleMessage("sites/2439/bridge", "1");

    assert.equal(d.calls.state.length, 1);
    assert.equal(d.calls.operation.length, 2);
    assert.equal(d.calls.bridge.length, 1);
  } finally { d.restore(); }
});

test("רגרסיה: הולידציות הקיימות עדיין חוסמות", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    await d.handleMessage("sites/2439/operation", "not json");
    await d.handleMessage("sites/2439/operation", opPayload({ state: "bogus" }));
    await d.handleMessage("sites/2439/operation", opPayload({ start_end: "middle" }));
    await d.handleMessage("sites/2439/operation", opPayload({ entry_exit: "sideways" }));
    await d.handleMessage("sites/2439/operation", opPayload({ cycle_counter: 1.5 }));
    await d.handleMessage("sites/2439/operation", opPayload({ timestamp: 0 }));
    assert.equal(d.calls.operation.length, 0);
  } finally { d.restore(); }
});

test("רגרסיה: user=null מנורמל ל-\"\" (חלק ממפתח ה-dedup)", async () => {
  const d = loadDispatcher({ 2439: SITE });
  try {
    await d.handleMessage("sites/2439/operation", opPayload({ user: null }));
    assert.equal(d.calls.operation.length, 1);
    assert.equal(d.calls.operation[0].data.user, "");
  } finally { d.restore(); }
});
