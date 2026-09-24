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

// ============================================================
// ⚠️ בדיקת התקופות (24/09/2026) — החלון מול הכרטיס
// ============================================================
// השוואה של כל אתר, בכל תקופה, בין חלון התובנות ל-site_stats מצאה שני כללים
// שהחלון לא החיל: פעולה שסומנה ניסוי נספרה, ותקלה בתוך חלון ידני נספרה.
const op = (at, excluded_at = null) => ({ site_id: 1, start_end: "end", entry_exit: "entry", card_number: "",
  is_anomaly: 0, superseded_by: null, occurred_at: at, excluded_at });
const errSeg = (s, e) => ({ id: 9, site_id: 1, status: "error", reclassified_to: null, started_at: s, ended_at: e, excluded_at: null });

test("⚠️ פעולה שסומנה ניסוי אינה נספרת", () => {
  const r = computeInsights({ ops: [op(at(3)), op(at(4), at(5))], errorRows: [], maintRows: [], windows: [], from, to, allRows: [] });
  assert.equal(r.totals.operations, 1);
});

test("⚠️ תקלה שהתחילה בתוך חלון ידני אינה נספרת כתקלה", () => {
  const e = errSeg(at(5), at(6));
  const win = { site_id: 1, set_by_name: "x", reason: null, started_at: at(4), duration_hours: 2, cancelled_at: null, excluded_at: null };
  const r = computeInsights({ ops: [], errorRows: [e], maintRows: [], windows: [win], from, to, allRows: [e] });
  assert.equal(r.totals.errors, 0);
  // ובלי החלון — נספרת
  assert.equal(computeInsights({ ops: [], errorRows: [e], maintRows: [], windows: [], from, to, allRows: [e] }).totals.errors, 1);
});

test("⚠️ חלון שהתחיל לפני התקופה (coverWindows) מכסה גם פעולות וגם תקלות בתוכה", () => {
  const e = errSeg(at(1), at(2));
  const before = { site_id: 1, started_at: "2026-08-31T20:00:00.000Z", expires_at: at(3), cancelled_at: null, excluded_at: null };
  const r = computeInsights({ ops: [op(at(1.5))], errorRows: [e], maintRows: [], windows: [], coverWindows: [before], from, to, allRows: [e] });
  assert.equal(r.totals.errors, 0, "התקלה בתוך החלון");
  assert.equal(r.totals.operations, 0, "הפעולה בתוך החלון");
  assert.equal(r.totals.maintenanceEvents, 0, "והחלון אינו נספר ככניסה לתחזוקה בתקופה");
});
