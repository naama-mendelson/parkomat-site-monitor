// tests/tech-report-ui.test.js — דוח הטכנאים בדשבורד (utils/techReport.js, 22/10/2026): תקופה, מיון, שיאים, טקסטים.
// ⚠️ שמות מומצאים — המאגר ציבורי.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERIODS, israelDay, addDays, periodRange, dayShort, dataNote, minuteText, minutesLong, techLabel, kmPerDay,
  COLUMNS, sortTechs, records, teamFacts, siteTechsText, siteLabel,
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

test("שורת הצוות והטכנאים באתר", () => {
  const f = teamFacts({ km: 80, drive_s: 5400, visits: 5, sites: 2, visit_avg_s: 3600, visit_total_s: 18000, work_days: 3 });
  assert.deepEqual(f.map((x) => x.text), ["80", "1:30 שע׳", "5", "2", "1:00 שע׳", "5:00 שע׳", "3"]);
  assert.equal(teamFacts({ visit_avg_s: null }).find((x) => x.label === "זמן ממוצע באתר").text, "—");
  assert.deepEqual(teamFacts(null), []);
  assert.equal(siteTechsText({ techs: [{ plate: "1", tech: "אבי", n: 3 }, { plate: "2", nickname: "כינוי 2", n: 1 }] }), "אבי (3), כינוי (1)");
  assert.equal(siteTechsText({}), "");
});
