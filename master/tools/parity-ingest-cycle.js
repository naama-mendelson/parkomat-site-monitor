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

  // ============================================================
  // classifyTimestamp — הפונקציה הטהורה השנייה
  // ============================================================
  // ⚠️ **המדד שהיא שומרת עליו הוא כל השאר.** חותם זמן שגוי אינו טועה
  // בשדה אחד — הוא מזיז מקטע, ולכן מזיז זמינות, שיעור תקלות וכל דוח.
  // ולכן היא נבדקת באותה קפדנות: כל חמשת הסיווגים במפורש, ואחריהם רשת.
  const { classifyTimestamp } = require("../ingestion/plausibility");
  const seenClass = new Set();

  async function cmpTs(label, ts, nowMs, regMs, allowPast) {
    checks++;
    const js = classifyTimestamp(ts, nowMs, regMs, { allowPastClamp: allowPast });
    seenClass.add(js.classification);

    const sql = await db.prepare(
      "SELECT * FROM app.classify_timestamp(?, ?, ?, ?)"
    ).get(ts, nowMs, regMs, allowPast);

    // ⚠️ ה-`reason` מושווה גם הוא. הוא מה שנרשם ל-ingest_drops, וזה מה
    // שמישהו יקרא בעוד חצי שנה כשינסה להבין למה הודעה נעלמה.
    const same =
      js.action === sql.action &&
      (js.effectiveSec ?? null) === (sql.effective_sec ?? null) &&
      (js.reason ?? null) === (sql.reason ?? null) &&
      Number(js.skewSeconds) === Number(sql.skew_seconds) &&
      Boolean(js.warn) === Boolean(sql.warn) &&
      js.classification === sql.classification;

    if (!same) {
      diffs++;
      console.log(`  ❌ ${label}`);
      console.log(`     JS  : ${JSON.stringify(js)}`);
      console.log(`     SQL : ${JSON.stringify(sql)}`);
    }
    return same;
  }

  console.log("\n── classifyTimestamp: חמשת הסיווגים ──");
  const NOW = Date.parse("2026-08-01T10:00:00.000Z");
  const S = (offsetSec) => Math.floor(NOW / 1000) + offsetSec;

  const tsCases = [
    ["ok — בדיוק עכשיו",           S(0), null, false],
    ["ok — 3ש בעתיד (מתחת לסף)",   S(3), null, false],
    ["ok — 10ש בעבר",              S(-10), null, false],
    ["drift_future — 34ש (אתר 1343)", S(34), null, false],
    ["drift_future — 70ש (אתר 2439)", S(70), null, false],
    ["drift_future — בדיוק על הגבול", S(300), null, false],
    ["reject — 301ש בעתיד",        S(301), null, false],
    ["backfill — 400ש בעבר",       S(-400), null, false],
    ["backfill — בחלון פריקה",     S(-100), null, false],
    ["drift_past — בשגרה",         S(-100), null, true],
    ["ok — 30ש בעבר (על הרצפה)",   S(-30), null, true],
    ["reject — לפני 2020",         1500000000, null, false],
    ["reject — מילישניות",         Date.now(), null, false],
    ["reject — לפני רישום האתר",   S(-60), NOW + 600000, false],
    ["backfill — בתוך חלון החסד",  S(-60), NOW + 30000, false],
    ["reject — NULL",              null, null, false],
  ];

  for (const [label, ts, reg, ap] of tsCases) {
    const okc = await cmpTs(label, ts, NOW, reg, ap);
    if (okc) console.log(`  ✅ ${label.padEnd(32)} → ${classifyTimestamp(ts, NOW, reg, { allowPastClamp: ap }).classification}`);
  }

  console.log("\n── classifyTimestamp: רשת אקראית ──");
  for (let i = 0; i < 400; i++) {
    const off = rnd(1400) - 700;
    await cmpTs(`ts אקראי ${i}`, S(off),
      NOW, Math.random() > 0.6 ? NOW - rnd(9000000) : null, Math.random() > 0.5);
  }
  console.log(`  ${diffs === 0 ? "✅" : "❌"} 400 מקרים אקראיים`);

  // ⚠️ אותו כלל כמו למעלה: "עברו" בלי לגעת בכל הסיווגים אינו אישור.
  const ALL_CLASS = ["ok", "drift_future", "drift_past", "backfill", "reject"];
  const missingClass = ALL_CLASS.filter((c) => !seenClass.has(c));
  if (missingClass.length) {
    diffs++;
    console.log(`  ❌ סיווגים שלא נבדקו כלל: ${missingClass.join(", ")}`);
  } else {
    console.log("  ✅ כל חמשת הסיווגים נבדקו");
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(diffs === 0
    ? `✅ נקי — ${checks} השוואות, 0 הבדלים`
    : `❌ ${diffs} הבדלים מתוך ${checks} השוואות`);
  process.exit(diffs === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
