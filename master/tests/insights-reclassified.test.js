// tests/insights-reclassified.test.js — תקלה שסווגה מחדש כתחזוקה אינה זמן תקלה.
//
// ⚠️ נמצא בסקירת הדשבורד (23/09/2026): `computeInsights` מסכם זמן על
// המקטעים הגולמיים (`allRows`), ו-`rawOf` סינן לפי `r.status` הגולמי. מקטע
// שמנהל סיווג מחדש ל-maintenance נשאר "error" בעיני החישוב — לשונית האמינות
// ספרה את שעותיו כ"בתקלה" והשמיטה אותן מהתחזוקה. הזרוע דרך השרת לא נפגעה,
// כי שם ה-SQL כבר החזיר `COALESCE(reclassified_to, status)`.
const test = require("node:test");
const assert = require("node:assert/strict");

let computeInsights;
test.before(async () => {
  ({ computeInsights } = await import("../../shared/insights.mjs"));
});

const H = 3600e3;
const from = "2026-09-01T00:00:00.000Z";
const to = "2026-09-02T00:00:00.000Z";
const at = (h) => new Date(Date.parse(from) + h * H).toISOString();

function run(row) {
  const eff = row.reclassified_to || row.status;
  return computeInsights({
    ops: [],
    errorRows: eff === "error" ? [row] : [],
    maintRows: eff === "maintenance" ? [row] : [],
    windows: [],
    from, to,
    allRows: [row],
  });
}

test("מקטע תקלה רגיל נספר כזמן תקלה", () => {
  const r = run({ id: 1, site_id: 1, status: "error", reclassified_to: null,
                  started_at: at(2), ended_at: at(5), excluded_at: null });
  assert.equal(r.downtime.totalHours, 3);
  assert.equal(r.maintenance.totalHours, 0);
});

test("⚠️ תקלה שסווגה מחדש נספרת כתחזוקה, לא כתקלה", () => {
  const r = run({ id: 1, site_id: 1, status: "error", reclassified_to: "maintenance",
                  started_at: at(2), ended_at: at(5), excluded_at: null });
  assert.equal(r.downtime.totalHours, 0);
  assert.equal(r.maintenance.totalHours, 3);
});
