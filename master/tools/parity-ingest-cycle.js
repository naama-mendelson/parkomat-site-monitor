// tools/parity-ingest-cycle.js — decideCycleUpdate: JS מול SQL, ערך מול ערך.
//
// ============================================================
// ⚠️ הפרוסה הראשונה של הקליטה, ולמה דווקא היא
// ============================================================
// `decideCycleUpdate` היא **טהורה בשני הצדדים** — אין בה קריאה למסד ואין
// לה תופעות לוואי. לכן אפשר להשוות אותה ישירות על אלפי מקרים, בלי לגעת
// בשום נתון. כל שאר הקליטה כותבת, וההשוואה שלה יקרה בהרבה.
//
// ⚠️ **ולמה זו הפונקציה שהכי מסוכן לפספס בה.** היא היחידה שמזיזה את
// `cycle_total` — מונה הבלאי המצטבר של המכונה. ניפוח שלו הוא **קבוע
// ובלתי הפיך**: אין דרך לדעת בדיעבד כמה מחזורים היו אמיתיים. שגיאה כאן
// אינה מספר שגוי על מסך אלא נתון שנהרס.
//
// ============================================================
// ⚠️ מקרי הייצור לבדם אינם מספיקים — וזה נמדד בפרויקט הזה שוב ושוב
// ============================================================
// `site_globals` נבדק בארבע מוטציות ורק אחת נתפסה, לא כי ה-SQL היה נכון
// אלא כי לנתונים אין מקרים כאלה. לכן כאן: כל שבעת המצבים **מיוצרים
// במפורש**, ובנוסף רשת אקראית רחבה שתופסת צירופים שאיש לא חשב עליהם.
const db = require("../db/db");
const { decideCycleUpdate, RESET_PLAUSIBLE_MAX, MAX_CYCLES_PER_MINUTE, JUMP_FLOOR } =
  require("../db/cycle-rules");

let checks = 0, diffs = 0;
const seenModes = new Set();

const iso = (ms) => new Date(ms).toISOString();

async function compare(label, input) {
  checks++;
  const js = decideCycleUpdate(input);
  seenModes.add(js.mode);

  const sql = await db.prepare(
    "SELECT * FROM app.decide_cycle_update(?, ?, ?, ?, ?, ?)"
  ).get(input.last, input.lastTs, input.total, input.isNewSite, input.current, input.occurredAt);

  // ⚠️ מושווים **כל** השדות ולא רק ה-mode. פונקציה שמחזירה את השם הנכון
  // עם total שגוי היא בדיוק הכשל שהורס את המונה בשקט.
  const same =
    js.mode === sql.mode &&
    (js.total ?? null) === (sql.total ?? null) &&
    (js.nextLast ?? null) === (sql.next_last ?? null) &&
    Boolean(js.write) === Boolean(sql.do_write) &&
    (js.ignoredAmount ?? 0) === (sql.ignored_amount ?? 0);

  if (!same) {
    diffs++;
    console.log(`  ❌ ${label}`);
    console.log(`     קלט : ${JSON.stringify(input)}`);
    console.log(`     JS  : ${JSON.stringify(js)}`);
    console.log(`     SQL : ${JSON.stringify(sql)}`);
  }
  return same;
}

(async () => {
  console.log("=== parity-ingest-cycle ===\n");
  await db.init();

  const T = Date.parse("2026-08-01T10:00:00.000Z");

  // ---------- שבעת המצבים, מיוצרים במפורש ----------
  console.log("── שבעת המצבים ──");
  const cases = [
    ["invalid — NULL",            { last: 100, lastTs: iso(T), total: 500, isNewSite: 1, current: null, occurredAt: iso(T + 60000) }],
    ["invalid — שלילי",           { last: 100, lastTs: iso(T), total: 500, isNewSite: 1, current: -3, occurredAt: iso(T + 60000) }],
    ["first — אתר חדש",           { last: null, lastTs: null, total: 0, isNewSite: 1, current: 1376, occurredAt: iso(T) }],
    ["first — אתר ותיק",          { last: null, lastTs: null, total: 0, isNewSite: 0, current: 1376000, occurredAt: iso(T) }],
    ["backfill",                  { last: 100, lastTs: iso(T), total: 500, isNewSite: 1, current: 105, occurredAt: iso(T - 60000) }],
    ["normal",                    { last: 100, lastTs: iso(T), total: 500, isNewSite: 1, current: 103, occurredAt: iso(T + 120000) }],
    ["normal — בדיוק על הרצפה",   { last: 100, lastTs: iso(T), total: 500, isNewSite: 1, current: 100 + JUMP_FLOOR, occurredAt: iso(T + 1000) }],
    ["jump_suspect — 65535",      { last: 100, lastTs: iso(T), total: 500, isNewSite: 1, current: 65535, occurredAt: iso(T + 60000) }],
    ["jump_suspect — צעד אחד מעל", { last: 100, lastTs: iso(T), total: 500, isNewSite: 1, current: 100 + JUMP_FLOOR + 1, occurredAt: iso(T + 1000) }],
    ["reset — אתחול בקר",         { last: 5000, lastTs: iso(T), total: 9000, isNewSite: 1, current: 3, occurredAt: iso(T + 60000) }],
    ["reset — בדיוק על הגבול",    { last: 5000, lastTs: iso(T), total: 9000, isNewSite: 1, current: RESET_PLAUSIBLE_MAX, occurredAt: iso(T + 60000) }],
    ["reset_suspect — מעל הגבול", { last: 5000, lastTs: iso(T), total: 9000, isNewSite: 1, current: RESET_PLAUSIBLE_MAX + 1, occurredAt: iso(T + 60000) }],
    // ⚠️ אין חותם קודם — התקרה היא אינסוף, וכל קפיצה חוקית.
    ["ללא lastTs — אין תקרה",     { last: 100, lastTs: null, total: 500, isNewSite: 1, current: 60000, occurredAt: iso(T) }],
    // ⚠️ אותה שנייה בדיוק: elapsed=0, ורק הרצפה מונעת חשד שווא.
    ["אותה שנייה",                { last: 100, lastTs: iso(T), total: 500, isNewSite: 1, current: 108, occurredAt: iso(T) }],
    // ⚠️ ניתוק ארוך — delta גדול שהוא אמיתי לגמרי.
    ["ניתוק שבועיים",             { last: 100, lastTs: iso(T), total: 500, isNewSite: 1, current: 40000, occurredAt: iso(T + 14 * 86400000) }],
  ];

  for (const [label, input] of cases) {
    const okc = await compare(label, input);
    if (okc) console.log(`  ✅ ${label.padEnd(28)} → ${decideCycleUpdate(input).mode}`);
  }

  // ---------- רשת אקראית ----------
  console.log("\n── רשת אקראית ──");
  const rnd = (n) => Math.floor(Math.random() * n);
  for (let i = 0; i < 600; i++) {
    const hasLast = Math.random() > 0.15;
    const hasTs = hasLast && Math.random() > 0.15;
    const gapMs = (rnd(20000) - 5000) * 1000;
    await compare(`אקראי ${i}`, {
      last: hasLast ? rnd(66000) : null,
      lastTs: hasTs ? iso(T) : null,
      total: rnd(2000000),
      isNewSite: rnd(2),
      current: Math.random() > 0.05 ? rnd(66000) : (Math.random() > 0.5 ? null : -rnd(10)),
      occurredAt: iso(T + gapMs),
    });
  }
  console.log(`  ${diffs === 0 ? "✅" : "❌"} 600 מקרים אקראיים`);

  // ⚠️ "עברו" בלי לגעת בכל המצבים אינו אישור — הוא אומר שלא נבדק כלום.
  const ALL = ["invalid", "first", "backfill", "normal", "jump_suspect", "reset", "reset_suspect"];
  const missing = ALL.filter((m) => !seenModes.has(m));
  console.log("");
  if (missing.length) {
    diffs++;
    console.log(`  ❌ מצבים שלא נבדקו כלל: ${missing.join(", ")}`);
  } else {
    console.log(`  ✅ כל שבעת המצבים נבדקו`);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(diffs === 0
    ? `✅ נקי — ${checks} השוואות, 0 הבדלים`
    : `❌ ${diffs} הבדלים מתוך ${checks} השוואות`);
  process.exit(diffs === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
