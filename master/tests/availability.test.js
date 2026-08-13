// tests/availability.test.js — ההגדרה של הזמינות, נעולה.
//
// ============================================================
// למה זה קיים, ומתי התגלה שהוא חסר
// ============================================================
// הזמינות שונתה כאן מהותית — `no_comm` יצא מהמכנה — ו**אף בדיקה לא נפלה**.
// אחוז הזמינות של אתר 2439 קפץ מ-72.8% ל-99.3%, וסוויטה של 196 בדיקות
// נשארה ירוקה.
//
// היה שער: tools/parity.js, 1,338 השוואות. הוא עבר — ובצדק. הוא משווה את
// מימוש ה-JS למימוש ה-SQL, ושניהם שונו יחד.
//
// ⚠️ **שער זהות מוכיח ששני מימושים תואמים. הוא אינו יכול להוכיח שההגדרה
// נכונה.** שניהם יכולים להיות שגויים באותה מידה, והשער יאיר ירוק.
//
// מה שנעול כאן הוא ההגדרה עצמה, במספרים.
//
// ============================================================
// ההגדרה
// ============================================================
//     זמינות = (מוכן + בפעולה) ÷ (מוכן + בפעולה + תקלה)
//
// שני מצבים **יוצאים מהמדידה לגמרי** — לא במונה ולא במכנה:
//
//   תחזוקה — הורדה מכוונת. אסור שתיראה ככשל, ואסור שתתוגמל כזמינות.
//   נתק    — הסוכן/הרשת אינם מדווחים. המחסום עצמו עשוי לעבוד ולשרת רכבים
//            כל אותו זמן; איננו יודעים. **אי-ידיעה אינה כשל.**

const test = require("node:test");
const assert = require("node:assert/strict");

const { availabilityFrom, AVAILABLE_STATUSES, DOWN_STATUSES } =
  require("../../shared/executive.mjs");

const H = 3600000;

test("זמינות = (מוכן + בפעולה) ÷ (מוכן + בפעולה + תקלה)", () => {
  const r = availabilityFrom({ ready: 90 * H, operating: 0, error: 10 * H });
  assert.equal(r.availabilityPercent, 90);
  assert.equal(r.measuredMs, 100 * H);
});

test("'בפעולה' הוא זמן זמין — רכב שעובר הוא המכונה עושה את עבודתה", () => {
  const r = availabilityFrom({ ready: 50 * H, operating: 40 * H, error: 10 * H });
  assert.equal(r.availabilityPercent, 90);
});

test("תחזוקה יוצאת מהמדידה — לא מענישה ולא מתגמלת", () => {
  // אותם 90/10 עם 100 שעות תחזוקה נוספות חייבים להחזיר את אותו אחוז בדיוק.
  const bare = availabilityFrom({ ready: 90 * H, error: 10 * H });
  const withM = availabilityFrom({ ready: 90 * H, error: 10 * H, maintenance: 100 * H });
  assert.equal(withM.availabilityPercent, bare.availabilityPercent);
  assert.equal(withM.measuredMs, bare.measuredMs);
});

test("נתק יוצא מהמדידה — באותו מעמד כמו תחזוקה", () => {
  // ⚠️ זו ההחלטה שהשתנתה. קודם נתק היה במכנה, כלומר נספר ככשל של המכונה.
  const bare = availabilityFrom({ ready: 90 * H, error: 10 * H });
  const withNc = availabilityFrom({ ready: 90 * H, error: 10 * H, no_comm: 100 * H });
  assert.equal(withNc.availabilityPercent, bare.availabilityPercent,
    "נתק אינו רשאי להזיז את האחוז");
  assert.equal(withNc.measuredMs, bare.measuredMs,
    "נתק אינו רשאי להיכנס למכנה");
});

test("נתק ותחזוקה יחד — עדיין אותו אחוז", () => {
  const r = availabilityFrom({
    ready: 45 * H, operating: 45 * H, error: 10 * H,
    maintenance: 200 * H, no_comm: 300 * H,
  });
  assert.equal(r.availabilityPercent, 90);
  assert.equal(r.measuredMs, 100 * H);
});

test("אתר שהיה מנותק כל התקופה — measured = 0, ולא 'זמינות אפס'", () => {
  // ⚠️ תוצאת לוואי מכוונת של ההחלטה, והיא נכונה: לא מדדנו עליו כלום.
  // הקוראים בודקים measuredHours ומציגים "—". 0% היה קורא כ"שבור לחלוטין",
  // וזו טענה שאין לנו בסיס לה.
  const r = availabilityFrom({ no_comm: 168 * H });
  assert.equal(r.measuredMs, 0);
});

test("אתר שרק היה בתחזוקה — אותו דבר", () => {
  assert.equal(availabilityFrom({ maintenance: 168 * H }).measuredMs, 0);
});

test("תקלה בלבד — 0% אמיתי, וזה שונה מ'אין נתון'", () => {
  const r = availabilityFrom({ error: 24 * H });
  assert.equal(r.availabilityPercent, 0);
  assert.ok(r.measuredMs > 0, "יש כאן מדידה — האפס אמיתי ולא חוסר נתונים");
});

test("קלט ריק אינו זורק", () => {
  const r = availabilityFrom({});
  assert.equal(r.measuredMs, 0);
  assert.equal(r.availabilityPercent, 0);
});

// ============================================================
// הרשימות עצמן — כי הן ההגדרה, לא פרט מימוש
// ============================================================
// ⚠️ כל שינוי כאן משנה כל מסך במערכת. הבדיקה קיימת כדי שהשינוי יהיה
// מודע: מי שמוסיף מצב לרשימה יראה בדיוק אילו מספרים הוא מזיז.
//
// ⚠️ ויש עותק שני של ההגדרה ב-SQL (public.site_uptime). הוא אינו נבדק כאן
// אלא ב-tools/parity.js. אם משנים אחד בלי השני — parity ייפול.
test("רשימות המצבים הן ההגדרה", () => {
  assert.deepEqual(AVAILABLE_STATUSES, ["ready", "operating"]);
  assert.deepEqual(DOWN_STATUSES, ["error"]);
  assert.ok(!DOWN_STATUSES.includes("no_comm"), "נתק אינו השבתה");
  assert.ok(!DOWN_STATUSES.includes("maintenance"), "תחזוקה אינה השבתה");
});
// ============================================================
// פילוח התחזוקה: תפעול תקלה מול מתוכננת
// ============================================================
// שתיהן נרשמות כמקטע `maintenance` זהה, והן שני דברים הפוכים:
//
//   **מתוכננת** — מישהו בחר להוריד את האתר. זו החלטה, וזה סימן טוב.
//   **תפעול תקלה** — האתר נפל ומישהו בא. זו תוצאה, ומבחינת מי שרצה לחנות
//     זו אותה השבתה שנמשכת.
//
// ערבובן מייפה את התמונה: אתר שנופל שלוש פעמים בשבוע ומטופל בכל פעם נראה
// כמו אתר שעובר תחזוקה שוטפת מסודרת.
//
// ⚠️ מה שנבדק כאן הוא בעיקר ה**אינווריאנטה**: repair + planned חייב לשוות
// בדיוק ל-maintenance, ו-availabilityPercent אינו רשאי לזוז בכלל. זה פילוח
// תצוגה, לא שינוי מדד.

const { uptimeFromData } = require("../../shared/executive.mjs");

const MIN = 60000;
const at = (m) => new Date(Date.UTC(2026, 6, 20, 0, 0) + m * MIN).toISOString();
const dataOf = (segments, windows = []) => ({
  ops: new Map(), segments: new Map([[1, segments]]), windows: new Map([[1, windows]]),
});
const seg = (status, fromMin, toMin) =>
  ({ status, started_at: at(fromMin), ended_at: toMin === null ? null : at(toMin) });
const uptimeOf = (segments, fromMin, toMin, windows) =>
  uptimeFromData(dataOf(segments, windows), 1, { from: at(fromMin), to: at(toMin) });

test("תחזוקה שהתחילה בדיוק כשתקלה נגמרה = תפעול תקלה", () => {
  const u = uptimeOf([
    seg("ready", 0, 60), seg("error", 60, 120), seg("maintenance", 120, 180), seg("ready", 180, 240),
  ], 0, 240);
  assert.equal(u.repairHours, 1);
  assert.equal(u.plannedHours, 0);
});

test("תחזוקה אחרי 'מוכן' = מתוכננת", () => {
  const u = uptimeOf([
    seg("ready", 0, 60), seg("maintenance", 60, 120), seg("ready", 120, 180),
  ], 0, 180);
  assert.equal(u.repairHours, 0);
  assert.equal(u.plannedHours, 1);
});

test("תחזוקה אחרי 'בפעולה' = מתוכננת", () => {
  const u = uptimeOf([
    seg("operating", 0, 10), seg("maintenance", 10, 70), seg("ready", 70, 120),
  ], 0, 120);
  assert.equal(u.repairHours, 0);
  assert.equal(u.plannedHours, 1);
});

test("⚠️ הסכום שווה תמיד ל-maintenanceHours", () => {
  // מעורב: טיפול אחד ומתוכננת אחת באותה תקופה.
  const u = uptimeOf([
    seg("error", 0, 30), seg("maintenance", 30, 90),      // טיפול — שעה
    seg("ready", 90, 150), seg("maintenance", 150, 180),  // מתוכננת — חצי שעה
  ], 0, 180);
  assert.equal(u.repairHours, 1);
  assert.equal(u.plannedHours, 0.5);
  assert.equal(u.repairHours + u.plannedHours, u.maintenanceHours);
});

test("⚠️ הזמינות אינה זזה בכלל — זה פילוח ולא מדד", () => {
  // אותם נתונים, פעם כשהתחזוקה היא טיפול ופעם כשהיא מתוכננת.
  const repair = uptimeOf([seg("error", 0, 30), seg("maintenance", 30, 90), seg("ready", 90, 150)], 0, 150);
  const planned = uptimeOf([seg("error", 0, 30), seg("ready", 30, 31), seg("maintenance", 31, 90), seg("ready", 90, 150)], 0, 150);

  assert.equal(repair.repairHours, 1);
  assert.equal(planned.repairHours, 0);
  // התחזוקה מוחרגת מהמכנה בשני המקרים, ולכן האחוז נקבע מ-ready מול error בלבד.
  assert.ok(repair.availabilityPercent > 0 && planned.availabilityPercent > 0);
  assert.equal(repair.measuredHours, repair.readyHours + repair.errorHours);
  assert.equal(planned.measuredHours, planned.readyHours + planned.errorHours);
});

test("חלון תחזוקה ידני נספר תמיד כמתוכננת", () => {
  // ⚠️ מישהו לחץ על כפתור — זו החלטה לפי הגדרה, גם אם היה תקלה רגע קודם.
  const u = uptimeOf(
    [seg("error", 0, 30), seg("ready", 30, 150)], 0, 150,
    [{ started_at: at(30), expires_at: at(90), cancelled_at: null }]
  );
  assert.equal(u.repairHours, 0);
  assert.equal(u.plannedHours, 1);
  assert.equal(u.maintenanceHours, 1);
});

test("תקלה בלי ended_at אינה מסווגת תחזוקה כטיפול", () => {
  // מקטע תקלה פתוח לא נגמר, ולכן אין חותם שאפשר להתאים אליו.
  const u = uptimeOf([seg("maintenance", 60, 120), seg("error", 0, null)], 0, 180);
  assert.equal(u.repairHours, 0);
});

test("בלי תחזוקה כלל — שני הפילוחים אפס", () => {
  const u = uptimeOf([seg("ready", 0, 60), seg("error", 60, 90)], 0, 90);
  assert.equal(u.repairHours, 0);
  assert.equal(u.plannedHours, 0);
  assert.equal(u.maintenanceHours, 0);
});

// ============================================================
// משתפר או מחמיר — הפסק שעל כרטיס האתר
// ============================================================
// ⚠️ המדד הוא **אחוז הכשל** ולא הזמינות: מאז שנתק ותחזוקה יצאו מהמדידה
// היא יושבת אצל כמעט כל האתרים סביב 99% ואינה מבחינה בין אתר בריא לאתר
// שהתחיל ליפול. אחוז הכשל זז.
//
// ⚠️ והכיוון הפוך לסימן: אחוז כשל **יורד** = האתר משתפר. זו הנקודה היחידה
// שקל להפוך כאן, ולכן הפסק מוחזר כמילה ולא כמספר לפרשנות.

const { siteTrend, SITE_TREND_MIN_OPERATIONS } = require("../../shared/executive.mjs");

test("אחוז כשל שיורד = משתפר", () => {
  const t = siteTrend({ operations: 40, failureRate: 3 }, { operations: 35, failureRate: 9 });
  assert.equal(t.direction, "improving");
  assert.equal(t.deltaPoints, -6);
});

test("אחוז כשל שעולה = מחמיר", () => {
  const t = siteTrend({ operations: 40, failureRate: 12 }, { operations: 35, failureRate: 4 });
  assert.equal(t.direction, "worsening");
  assert.equal(t.deltaPoints, 8);
});

test("⚠️ שני מצבים בלבד — גם תזוזה זעירה היא כיוון", () => {
  // היה כאן אזור מת של נקודת אחוז, והוא בוטל בהחלטת מוצר: על המסך הוא
  // יצר מצב שלישי דהוי שנראה כמו נתון חסר. הסימן אומר **כיוון**, לא
  // עוצמה — גודל ההפרש נמצא בריחוף.
  assert.equal(siteTrend({ operations: 40, failureRate: 5.11 },
                         { operations: 40, failureRate: 5 }).direction, "worsening");
  assert.equal(siteTrend({ operations: 40, failureRate: 4.89 },
                         { operations: 40, failureRate: 5 }).direction, "improving");
});

test("'יציב' נשאר רק לשוויון מדויק", () => {
  // ⚠️ אינו מצב שלישי אלא מקרה קצה: שני שבועות עם אותו אחוז בדיוק, לרוב
  // 0% מול 0%. חץ שם היה טוען על כיוון שלא קיים.
  const t = siteTrend({ operations: 40, failureRate: 3.5 }, { operations: 40, failureRate: 3.5 });
  assert.equal(t.direction, "stable");
  assert.equal(t.deltaPoints, 0);
});

test("⚠️ מדגם קטן — אין פסק בכלל, ולא 'יציב'", () => {
  // אתר עם 4 פעולות ותקלה אחת הוא 25% כשל; שבוע קודם 3 פעולות ואפס הוא 0%.
  // "החמרה של 25 נקודות" שכולה רעש. null אומר "אין מספיק כדי לקבוע".
  assert.equal(siteTrend({ operations: 4, failureRate: 25 }, { operations: 3, failureRate: 0 }), null);
  assert.equal(siteTrend({ operations: 40, failureRate: 5 }, { operations: 2, failureRate: 0 }), null,
    "גם כשרק התקופה הקודמת קטנה");
  assert.equal(siteTrend({ operations: 2, failureRate: 0 }, { operations: 40, failureRate: 5 }), null,
    "וגם כשרק הנוכחית קטנה");
});

test("הסף הוא בדיוק MIN_OPERATIONS ולא יותר", () => {
  const n = SITE_TREND_MIN_OPERATIONS;
  assert.ok(siteTrend({ operations: n, failureRate: 0 }, { operations: n, failureRate: 10 }));
  assert.equal(siteTrend({ operations: n - 1, failureRate: 0 }, { operations: n, failureRate: 10 }), null);
});

test("תקופה קודמת חסרה = אין פסק", () => {
  assert.equal(siteTrend({ operations: 40, failureRate: 5 }, null), null);
  assert.equal(siteTrend(null, { operations: 40, failureRate: 5 }), null);
});

test("שני השבועות באפס תקלות = יציב", () => {
  // המקרה הנפוץ ביותר של שוויון מדויק — אתר תקין שממשיך להיות תקין.
  const t = siteTrend({ operations: 40, failureRate: 0 }, { operations: 40, failureRate: 0 });
  assert.equal(t.direction, "stable");
  assert.equal(t.deltaPoints, 0);
});

test("מ-0 לאחוז כשל אמיתי = מחמיר", () => {
  const t = siteTrend({ operations: 40, failureRate: 7.5 }, { operations: 40, failureRate: 0 });
  assert.equal(t.direction, "worsening");
  assert.equal(t.previous, 0);
});

// ============================================================
// פילוח ההשבתות: טופלה מול התאוששה מעצמה
// ============================================================
// שתיהן "אירוע השבתה" באותו מספר, והן שני דברים שונים תפעולית: טיפול
// פירושו שמישהו התערב — והתאוששות עצמית היא לרוב
// ריצוד שהמכונה ניקתה לבד. אתר עם 5 השבתות שכולן נפתרו לבד הוא סיפור אחר
// מאתר עם 5 שכולן הצריכו טיפול.
//
// ⚠️ אותו כלל זיהוי בדיוק כמו פילוח התחזוקה:
//     error.ended_at === maintenance.started_at

const { computeInsights: ci } = require("../../shared/insights.mjs");

const iso = (h, m = 0) => new Date(Date.UTC(2026, 6, 20, h, m)).toISOString();
const err = (fromH, toH) => ({ status: "error", started_at: iso(fromH), ended_at: toH === null ? null : iso(toH) });
const mnt = (fromH, toH) => ({ status: "maintenance", started_at: iso(fromH), ended_at: iso(toH) });

const down = (errorRows, maintRows = []) => ci({
  ops: [], errorRows, maintRows, windows: [],
  from: iso(0), to: iso(23),
}).downtime;

test("תקלה שאחריה תחזוקה = הסתיימה בטיפול", () => {
  const d = down([err(1, 2)], [mnt(2, 3)]);
  assert.equal(d.incidents, 1);
  assert.equal(d.handledIncidents, 1);
  assert.equal(d.recoveredIncidents, 0);
  assert.equal(d.handledHours, 1);
});

test("תקלה שנגמרה בלי תחזוקה = התאוששה מעצמה", () => {
  const d = down([err(1, 2)], []);
  assert.equal(d.handledIncidents, 0);
  assert.equal(d.recoveredIncidents, 1);
  assert.equal(d.recoveredHours, 1);
});

test("⚠️ הסכומים נשמרים — פילוח ולא מדד חדש", () => {
  const d = down([err(1, 2), err(4, 5), err(8, 10)], [mnt(2, 3)]);
  assert.equal(d.handledIncidents + d.recoveredIncidents, d.incidents);
  assert.equal(Math.round((d.handledHours + d.recoveredHours) * 100) / 100, d.totalHours);
});

test("⚠️ תקלה פתוחה אינה 'טופלה' — אין לה חותם סיום להתאים אליו", () => {
  // בלי התנאי על ended_at היא הייתה נספרת לפי undefined ומקבלת סיווג שרירותי.
  const d = down([err(20, null)], [mnt(2, 3)]);
  assert.equal(d.handledIncidents, 0);
  assert.equal(d.recoveredIncidents, 1);
});

test("תחזוקה שאינה צמודה לסיום התקלה אינה הופכת אותה ל'טופלה'", () => {
  // תחזוקה שהתחילה שעה אחרי שהתקלה נגמרה היא תחזוקה מתוכננת, לא טיפול.
  const d = down([err(1, 2)], [mnt(3, 4)]);
  assert.equal(d.handledIncidents, 0);
});

test("בלי השבתות כלל — שני הפילוחים אפס", () => {
  const d = down([], []);
  assert.equal(d.incidents, 0);
  assert.equal(d.handledIncidents, 0);
  assert.equal(d.recoveredIncidents, 0);
});
