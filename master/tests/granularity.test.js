// tests/granularity.test.js — בורר הרזולוציה, ומה שקורה כשמכבדים אותו.
//
// ============================================================
// ⚠️ פקד שנשלח בכל בקשה ולא השפיע על כלום
// ============================================================
// ה-<select> "רזולוציה" ב-FilterBar גלוי תמיד, ו-ExecutiveView מכניס את
// ערכו ל-query בכל בקשה. אבל:
//
//   • בשרת — `resolveRange` החזיר `resolvePeriod(period)` כמות שהוא, ולתקופה
//     בשם יש granularity קבוע. כלומר על "30 הימים האחרונים" הבורר לא עשה כלום.
//   • במצב הישיר — `dataSource.js` חישב granularity מחדש ודרס את מה שנבחר,
//     **בכל מקרה**, כולל טווח חופשי. וזה המצב שרץ היום.
//
// התוצאה על המסך: הבורר מראה "חודשית", כותרת המשנה מתחתיו אומרת
// "רזולוציה יומית", והגרף יומי. פקד שסותר את המסך שהוא שולט בו.
//
// ⚠️ ותיקון הבורר הפך תקלה שנייה לנגישה: `getBucketRanges` **חתך** בשקט
// מעל תקרה. עד היום הרזולוציה נגזרה מהטווח ולכן לעולם לא חרגה; משנכבד
// בחירה, "יומית" על טווח בן שנתיים היא בקשה לגיטימית — ו-400 דליים היו
// מסתירים את השליש האחרון של התקופה בלי סימן.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolvePeriod } = require("../api/periods.js");

// חילוץ resolveRange מהמקור — routes.js אינו מייצא אותה, ולא נכון לפתוח
// את פנים הקובץ רק בשביל בדיקה.
const SRC = fs.readFileSync(path.join(__dirname, "..", "api", "routes.js"), "utf8");
const BODY = (SRC.match(/^function resolveRange\(query\)[\s\S]*?^\}/m) || [""])[0];
assert.ok(BODY, "resolveRange לא נמצאה ב-routes.js");

const HE_MONTHS = ["ינו", "פבר", "מרץ", "אפר", "מאי", "יונ", "יול", "אוג", "ספט", "אוק", "נוב", "דצמ"];
const resolveRange = new Function(
  "resolvePeriod", "HE_MONTHS", "DAY_MS",
  `${BODY}; return resolveRange;`,
)(resolvePeriod, HE_MONTHS, 86400000);

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };


test("תקופה בשם מכבדת את הרזולוציה שנבחרה", () => {
  // "30 הימים האחרונים" הוא יומי כברירת מחדל. הבורר חייב לגבור.
  assert.equal(resolveRange({ period: "month" }).granularity, "day");
  assert.equal(resolveRange({ period: "month", granularity: "month" }).granularity, "month");
  assert.equal(resolveRange({ period: "month", granularity: "week" }).granularity, "week");

  // וגם לכיוון השני: שנה היא חודשית, ובחירת "יומית" חייבת לעבור.
  assert.equal(resolveRange({ period: "year" }).granularity, "month");
  assert.equal(resolveRange({ period: "year", granularity: "day" }).granularity, "day");
});


test("שאר שדות התקופה אינם נפגעים מהדריסה", () => {
  const plain = resolveRange({ period: "week" });
  const over = resolveRange({ period: "week", granularity: "month" });

  for (const k of ["period", "label", "comparisonLabel"]) {
    assert.equal(over[k], plain[k], `${k} השתנה בגלל בורר הרזולוציה`);
  }
  assert.deepEqual(over.range, plain.range);
  assert.deepEqual(over.prev, plain.prev);
});


test("ערך לא חוקי אינו גובר — נופלים לגזירה", () => {
  // ⚠️ בלי רשימת היתר, `granularity=hour` היה זורם עד getBucketRanges
  // ושם byMonth/byWeek שניהם false — כלומר **יומי בשקט**, ולא שגיאה.
  for (const bad of ["hour", "", "DAY", "'; drop--", null, undefined]) {
    assert.equal(resolveRange({ period: "month", granularity: bad }).granularity, "day", String(bad));
    assert.equal(
      resolveRange({ from: ymd(daysAgo(10)), to: ymd(daysAgo(1)), granularity: bad }).granularity,
      "day", String(bad),
    );
  }
});


test("טווח חופשי: הבורר גובר על הגזירה לפי אורך", () => {
  const from = ymd(daysAgo(300));
  const to = ymd(daysAgo(1));

  // 300 יום ⇐ נגזר "month". הבורר חייב לגבור גם כאן.
  assert.equal(resolveRange({ from, to }).granularity, "month");
  assert.equal(resolveRange({ from, to, granularity: "day" }).granularity, "day");
});


// ============================================================
// getBucketRanges — הגסה במקום חיתוך
// ============================================================
test("טווח ארוך מגס את הרזולוציה ואינו מאבד את סופו", async () => {
  const { getBucketRanges } = await import("../../shared/executive.mjs");

  const from = new Date(2024, 0, 1);
  const to = new Date(2026, 0, 1);                 // שנתיים
  const buckets = getBucketRanges({
    from: from.toISOString(), to: to.toISOString(), granularity: "day",
  });

  assert.ok(buckets.length > 0);

  // ⚠️ הטענה המרכזית: הדלי האחרון מגיע עד סוף הטווח. בגרסה שחתכה,
  // 400 ימים מ-1.1.2024 נגמרו בפברואר 2025 — ועשרה חודשים של תקלות
  // פשוט לא הופיעו בגרף, בלי שום סימן לכך.
  assert.equal(
    Date.parse(buckets.at(-1).to), to.getTime(),
    "הדלי האחרון אינו מגיע לקצה הטווח — נתונים נחתכו בשקט",
  );
  assert.equal(Date.parse(buckets[0].from), from.getTime());

  // ואין חורים באמצע: כל דלי מתחיל בדיוק היכן שקודמו נגמר.
  for (let i = 1; i < buckets.length; i++) {
    assert.equal(buckets[i].from, buckets[i - 1].to, `חור בין דלי ${i - 1} ל-${i}`);
  }
});


test("טווח קצר אינו מוגס — יומי נשאר יומי", () => {
  // ההגסה היא מוצא אחרון, לא התנהגות רגילה.
  return import("../../shared/executive.mjs").then(({ getBucketRanges }) => {
    const from = new Date(2025, 0, 1);
    const to = new Date(2025, 0, 31);
    const buckets = getBucketRanges({
      from: from.toISOString(), to: to.toISOString(), granularity: "day",
    });
    assert.equal(buckets.length, 30, "30 יום ⇐ 30 דליים");
    assert.equal(Date.parse(buckets.at(-1).to), to.getTime());
  });
});
