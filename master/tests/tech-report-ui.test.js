// tests/tech-report-ui.test.js — דוח הטכנאים בדשבורד (utils/techReport.js, 22/10/2026): תקופה, מיון, שיאים, טקסטים.
// ⚠️ שמות מומצאים — המאגר ציבורי.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERIODS, israelDay, addDays, periodRange, dayShort, dataNote, minuteText, minutesLong, techLabel, kmPerDay,
  COLUMNS, sortTechs, records, siteTechsText, siteLabel,
  METRICS, barRows, recordFamily, clockAxis, spanRows, MIX_PARTS, dayMix, mixRows, SITE_METRICS, siteBarRows,
} from "../../dashboard/src/utils/techReport.js";

const T = (o) => ({ plate: "8600001", nickname: "כינוי 8600001", tech: null, work_days: 0, km: 0, drive_s: 0, visits: 0, sites: 0,
  visit_total_s: 0, visit_avg_s: null, first_min: null, last_min: null, workday_min: null, avg_speed: null, max_speed: null, ...o });

test("התקופה: היום בישראל (לא UTC), עד היום כולל; שעון קיץ לא מזיז יום; מפתח לא מוכר — 7 ימים", () => {
  assert.equal(israelDay("2026-10-21T21:30:00Z"), "2026-10-22", "00:30 בישראל — כבר מחר");
  assert.equal(israelDay("2026-10-21T20:30:00Z"), "2026-10-21");
  assert.equal(israelDay("2026-12-31T22:30:00Z"), "2027-01-01", "חורף (+2)");
  assert.equal(addDays("2026-10-25", -1), "2026-10-24", "יום החזרה לשעון חורף");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.deepEqual(periodRange("today", "2026-10-22T09:00:00Z"), { from: "2026-10-22", to: "2026-10-22" });
  assert.deepEqual(periodRange("7", "2026-10-22T09:00:00Z"), { from: "2026-10-16", to: "2026-10-22" });
  assert.deepEqual(periodRange("365", "2026-10-22T09:00:00Z"), { from: "2025-10-23", to: "2026-10-22" });
  assert.deepEqual(periodRange("xyz", "2026-10-22T09:00:00Z"), { from: "2026-10-16", to: "2026-10-22" });
  assert.deepEqual(PERIODS.map((p) => p.label), ["היום", "7 ימים", "30 ימים", "90 ימים", "שנה"]);
});

test("טקסטים: תאריך קצר, הערת תחילת המעקב, שעה מדקות, אורך יום, שם, ק\"מ ליום", () => {
  assert.equal(dayShort("2026-10-21"), "21/10");
  assert.equal(dayShort("x"), "");
  assert.equal(dataNote({ from: "2026-10-16", first_day: "2026-10-21" }), "הנתונים מ-21/10, מאז שהמעקב התחיל");
  assert.equal(dataNote({ from: "2026-10-21", first_day: "2026-10-21" }), "");
  assert.equal(dataNote({ from: "2026-10-22", first_day: "2026-10-21" }), "");
  assert.equal(dataNote({ from: "2026-10-16" }), "");
  assert.deepEqual([minuteText(480), minuteText(462.4), minuteText(0), minuteText(null), minuteText(-5)], ["08:00", "07:42", "00:00", "—", "—"]);
  assert.deepEqual([minutesLong(480), minutesLong(45), minutesLong(null)], ["8:00 שע׳", "45 דק׳", "—"]);
  assert.equal(techLabel(T({ tech: "דני לוי" })), "דני לוי");
  assert.equal(techLabel(T({})), "כינוי", "בלי שם מהלוח — הכינוי בלי מספר הרכב");
  assert.deepEqual([kmPerDay(T({ km: 80, work_days: 2 })), kmPerDay(T({ km: 80, work_days: 0 }))], [40, null]);
  assert.equal(siteLabel({ code: "1227", name: "הרצל 50, תל אביב" }), "הרצל 50");
  assert.equal(siteLabel({ code: "1227" }), "1227");
});

test("מיון הטבלה: לפי כל עמודה, יורד ועולה; בלי נתון תמיד בסוף; שוויון — לפי שם", () => {
  const a = T({ plate: "1", tech: "אבי", km: 50, visits: 3, first_min: 420, max_speed: 90 });
  const b = T({ plate: "2", tech: "בני", km: 120, visits: 3, first_min: null, max_speed: null });
  const c = T({ plate: "3", tech: "גדי", km: 50, visits: 7, first_min: 400, max_speed: 110 });
  const names = (l) => l.map(techLabel);
  assert.deepEqual(names(sortTechs([a, b, c], "km")), ["בני", "אבי", "גדי"], "שוויון — לפי שם");
  assert.deepEqual(names(sortTechs([a, b, c], "km", "asc")), ["אבי", "גדי", "בני"]);
  assert.deepEqual(names(sortTechs([a, b, c], "max_speed")), ["גדי", "אבי", "בני"], "בלי נתון — בסוף");
  assert.deepEqual(names(sortTechs([a, b, c], "max_speed", "asc")), ["אבי", "גדי", "בני"], "בלי נתון — בסוף גם בעולה");
  assert.deepEqual(names(sortTechs([a, b, c], "first_min", "asc")), ["גדי", "אבי", "בני"]);
  assert.deepEqual(names(sortTechs([c, b, a], "name", "asc")), ["אבי", "בני", "גדי"]);
  assert.deepEqual(names(sortTechs([a, b, c], "לא קיים")), ["בני", "אבי", "גדי"], "עמודה לא מוכרת — ק\"מ");
  assert.equal(new Set(COLUMNS.map((x) => x.key)).size, COLUMNS.length);
  for (const col of COLUMNS) assert.equal(typeof col.text(T({})), "string", `${col.key}: טקסט גם בלי נתון`);
});

test("שיאים: מי מוביל וכמה; אפס אינו שיא; יוצא מוקדם = הקטן; שוויון — לפי שם; בלי נתונים — כלום", () => {
  const a = T({ plate: "1", tech: "אבי", km: 50, visits: 3, sites: 2, visit_total_s: 7200, visit_avg_s: 2400, max_speed: 90, avg_speed: 40, first_min: 420, workday_min: 500 });
  const b = T({ plate: "2", tech: "בני", km: 120, visits: 3, sites: 1, visit_total_s: 3600, visit_avg_s: 3600, max_speed: 130, avg_speed: 55, first_min: 380, workday_min: 450 });
  const r = Object.fromEntries(records([a, b]).map((x) => [x.key, [x.name, x.text]]));
  assert.deepEqual(r.km, ["בני", "120 ק״מ"]);
  assert.deepEqual(r.visits, ["אבי", "3 ביקורים"], "שוויון — לפי שם");
  assert.deepEqual(r.sites, ["אבי", "2 אתרים"]);
  assert.deepEqual(r.visit_total_s, ["אבי", "2:00 שע׳"]);
  assert.deepEqual(r.visit_avg_s, ["בני", "1:00 שע׳"]);
  assert.deepEqual(r.max_speed, ["בני", "130 קמ״ש"]);
  assert.deepEqual(r.avg_speed, ["בני", "55 קמ״ש"]);
  assert.deepEqual(r.first_min, ["בני", "06:20"], "יוצא הכי מוקדם — הקטן");
  assert.deepEqual(r.workday_min, ["אבי", "8:20 שע׳"]);
  assert.deepEqual(records([T({}), T({ plate: "2" })]), [], "אפסים ובלי נתונים — אין שיאים");
  assert.deepEqual(records([]), []);
});

test("הטכנאים באתר", () => {
  assert.equal(siteTechsText({ techs: [{ plate: "1", tech: "אבי", n: 3 }, { plate: "2", nickname: "כינוי 2", n: 1 }] }), "אבי (3), כינוי (1)");
  assert.equal(siteTechsText({}), "");
});

// 22/10/2026 — התצוגה הוויזואלית: עמודות השוואה, ציר יום העבודה, איך עובר היום, ולפי אתר.
test("השוואה: מהמוביל למטה, המוביל 100%, אפס ובלי נתון — לא עמודה ונספרים; שוויון — לפי שם; מדד לא מוכר — ק\"מ", () => {
  const a = T({ plate: "1", tech: "אבי", km: 50, visits: 2, max_speed: null });
  const b = T({ plate: "2", tech: "בני", km: 100, visits: 2, max_speed: 120 });
  const c = T({ plate: "3", tech: "גדי", km: 0 });
  const r = barRows([a, b, c], "km");
  assert.deepEqual(r.rows.map((x) => [x.name, x.pct, x.rank, x.text]), [["בני", 100, 1, "100 ק״מ"], ["אבי", 50, 2, "50 ק״מ"]]);
  assert.equal(r.missing, 1, "אפס — לא עמודה");
  assert.deepEqual(barRows([b, a], "visits").rows.map((x) => x.name), ["אבי", "בני"], "שוויון — לפי שם");
  assert.equal(barRows([a, b], "visits").rows[0].text, "2 ביקורים");
  assert.equal(barRows([T({ visits: 1 })], "visits").rows[0].text, "ביקור אחד");
  const sp = barRows([a, b], "max_speed");
  assert.deepEqual([sp.rows.length, sp.missing], [1, 1], "בלי נתון — נספר");
  assert.equal(barRows([a, b], "xyz").metric.key, "km");
  assert.deepEqual(barRows([], "km").rows, []);
  assert.equal(new Set(METRICS.map((m) => m.key)).size, METRICS.length);
  for (const m of METRICS) assert.ok(["road", "site", "speed"].includes(m.family), m.key);
  assert.deepEqual([recordFamily("km"), recordFamily("visits"), recordFamily("max_speed"), recordFamily("first_min"), recordFamily("workday_min")],
    ["road", "site", "speed", "time", "time"]);
});

test("ציר יום העבודה: משעה עגולה לפני היציאה עד אחרי הסיום, לפחות 07–17; שורות מהמוקדם; בלי נתון — null", () => {
  assert.equal(clockAxis([T({})]), null);
  assert.equal(clockAxis([]), null);
  const ax = clockAxis([T({ first_min: 381, last_min: 953 })]);            // 06:21–15:53
  assert.deepEqual([ax.from, ax.to], [360, 1020], "06:00 עד 17:00 (המינימום)");
  assert.equal(ax.ticks.length, 12, "עד 12 שעות — כל שעה");
  assert.deepEqual([ax.ticks[0].label, ax.ticks.at(-1).label, ax.ticks[0].pct, ax.ticks.at(-1).pct], ["06:00", "17:00", 0, 100]);
  const wide = clockAxis([T({ first_min: 330, last_min: 1310 })]);       // 05:30–21:50
  assert.deepEqual([wide.from, wide.to], [300, 1320]);
  assert.equal(wide.ticks[1].label, "07:00", "מעל 12 שעות — כל שעתיים");
  const late = clockAxis([T({ first_min: 600, last_min: 1439 })]);
  assert.deepEqual([late.from, late.to], [420, 1440], "לא לפני 07:00; עד חצות");
  const a = T({ plate: "1", tech: "אבי", first_min: 480, last_min: 960, workday_min: 470 });
  const b = T({ plate: "2", tech: "בני", first_min: 420, last_min: 900, workday_min: 480 });
  const c = T({ plate: "4", tech: "גדי", first_min: 450, last_min: 860, workday_min: 410 });   // יוצא אחרי בני ומסיים לפניו
  const rows = spanRows([a, b, c, T({ plate: "3" })], clockAxis([a, b, c]));
  assert.deepEqual(rows.map((r) => r.name), ["בני", "גדי", "אבי"], "מהיוצא המוקדם — לא מהמסיים המוקדם");
  assert.deepEqual([rows[0].start, rows[0].width, rows[0].first, rows[0].last, rows[0].len], [0, 80, "07:00", "15:00", "8:00 שע׳"]);
  assert.deepEqual(spanRows([a], null), []);
  const back = spanRows([T({ first_min: 600, last_min: 590 })], clockAxis([T({ first_min: 600, last_min: 590 })]));
  assert.equal(back[0].width, 0.5, "סיום לפני יציאה — עמודה דקה, לא שלילית");
});

test("איך עובר היום: נסיעה / באתרים / השאר מתוך היום הממוצע; ארוך מהיום — השאר אפס; לא נסע — אין; הכי הרבה באתרים למעלה", () => {
  assert.deepEqual(MIX_PARTS.map((p) => p.key), ["drive", "site", "other"]);
  const m = dayMix(T({ work_days: 2, drive_s: 14400, site_s: 21600, workday_min: 480 }));  // ליום: 2 שע׳ נסיעה, 3 באתרים, מתוך 8
  assert.equal(m.total, 28800);
  assert.deepEqual(m.parts.map((p) => [p.key, p.s, p.pct]), [["drive", 7200, 25], ["site", 10800, 37.5], ["other", 10800, 37.5]]);
  const over = dayMix(T({ work_days: 1, drive_s: 18000, site_s: 18000, workday_min: 480 }));
  assert.deepEqual([over.total, over.parts[2].s], [36000, 0], "יותר מהיום — הסכום הוא היום");
  assert.equal(dayMix(T({ work_days: 0, drive_s: 100 })), null);
  assert.equal(dayMix(T({ work_days: 0, drive_s: 100, site_s: 100, workday_min: 60 })), null, "לא נסע אף יום — אין, גם עם זמנים");
  assert.equal(dayMix(T({ work_days: 1 })), null, "בלי זמנים — אין");
  assert.equal(dayMix(null), null);
  const rows = mixRows([
    T({ plate: "1", tech: "אבי", work_days: 1, drive_s: 3600, site_s: 3600, workday_min: 480 }),
    T({ plate: "2", tech: "בני", work_days: 1, drive_s: 3600, site_s: 14400, workday_min: 480 }),
    T({ plate: "3", tech: "גדי" }),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["בני", "אבי"]);
});

test("לפי אתר: עמודות לפי ביקורים / זמן כולל / ממוצע; המוביל 100%", () => {
  const s = [{ code: "1", name: "א", visits: 2, total_s: 7200, avg_s: 3600 }, { code: "2", name: "ב", visits: 4, total_s: 3600, avg_s: 900 }];
  assert.deepEqual(siteBarRows(s, "visits").rows.map((r) => [r.site.code, r.pct, r.text]), [["2", 100, "4 ביקורים"], ["1", 50, "2 ביקורים"]]);
  assert.deepEqual(siteBarRows(s, "total_s").rows.map((r) => r.site.code), ["1", "2"]);
  assert.deepEqual(siteBarRows(s, "avg_s").rows.map((r) => r.text), ["1:00 שע׳", "15 דק׳"]);
  assert.equal(siteBarRows(s, "xyz").metric.key, "visits");
  assert.deepEqual(SITE_METRICS.map((m) => m.key), ["visits", "total_s", "avg_s"]);
});
