// tests/inspection-actions.test.js — פעולות על תסקיר שכבר עלה (11/10/2026), הצד של המסך.
//
// בעלת המוצר: "אופציה למחוק דוח שעלה כבר או לערוך את התאריכים שלו או להוסיף ליקויים או כל דבר.
// אם מעלים קובץ והתאריכים קיימים כבר אז לכתוב קובץ זה כבר קיים". הכללים עצמם נאכפים ב-SQL
// (compliance.test.js, בדיקות 52–55); כאן — שהמסך מציע ומזהה אותו דבר:
//   • sameDatesReport — "קובץ זה כבר קיים" בטופס, לפני השמירה.
//   • addTarget — "+ הוספת ליקוי" גם בתקופתי שסומן נקי, ולא בבדיקה חוזרת נקייה.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SRC = path.join(__dirname, "../../dashboard/src/components/Compliance/InspectionUtils.js");

// InspectionUtils מייבא בלי סיומת (Vite) — Node צריך כתובת מלאה
async function load() {
  const abs = (rel) => pathToFileURL(path.resolve(path.dirname(SRC), rel)).href;
  const src = fs.readFileSync(SRC, "utf8")
    .replace(`from "../../utils/compliance";`, `from ${JSON.stringify(abs("../../utils/compliance.js"))};`);
  assert.doesNotMatch(src, /from "\.{1,2}\//, "נשאר ייבוא יחסי — InspectionUtils קיבל ייבוא חדש");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "insp-actions-")), "InspectionUtils.mjs");
  fs.writeFileSync(tmp, src);
  return import(pathToFileURL(tmp).href);
}

const rep = (o) => ({ id: o.id, machine_key: o.machine_key ?? "1", kind: o.kind ?? "periodic", followup_of: o.followup_of ?? null,
  inspected_on: o.inspected_on, valid_until: "valid_until" in o ? o.valid_until : "2027-03-01", declared_clean: !!o.declared_clean,
  defects: o.defects ?? [] });

test("sameDatesReport — אותו מתקן + אותו תאריך בדיקה + אותה בדיקה הבאה, מכל סוג", async () => {
  const { sameDatesReport } = await load();
  const reports = [
    rep({ id: 1, inspected_on: "2026-03-01", valid_until: "2027-03-01" }),
    rep({ id: 2, kind: "archive", inspected_on: "2024-03-01", valid_until: "2025-03-01" }),
    rep({ id: 3, kind: "followup", followup_of: 1, inspected_on: "2026-05-01", valid_until: null }),
    rep({ id: 4, machine_key: "2", inspected_on: "2026-06-01", valid_until: "2027-06-01" }),
  ];
  assert.equal(sameDatesReport(reports, "1", "2026-03-01", "2027-03-01")?.id, 1);
  assert.equal(sameDatesReport(reports, "1", "2024-03-01", "2025-03-01")?.id, 2, "דוח ישן — גם הוא");
  // תאריך אחד שונה, או מתקן אחר — לא כפילות
  assert.equal(sameDatesReport(reports, "1", "2026-03-02", "2027-03-01"), null);
  assert.equal(sameDatesReport(reports, "1", "2026-03-01", "2027-03-02"), null);
  assert.equal(sameDatesReport(reports, "2", "2026-03-01", "2027-03-01"), null);
  assert.equal(sameDatesReport(reports, "2", "2026-06-01", "2027-06-01")?.id, 4);
  // בדיקה חוזרת שיורשת תוקף: "" בטופס = null בשרת — נמדדת מול null, ולא מול תוקף כלשהו
  assert.equal(sameDatesReport(reports, "1", "2026-05-01", "")?.id, 3);
  assert.equal(sameDatesReport(reports, "1", "2026-05-01", null)?.id, 3);
  assert.equal(sameDatesReport(reports, "1", "2026-05-01", "2027-03-01"), null, "חוזרת עם תוקף משלה — תאריכים אחרים");
  // לפני שהמתקן או תאריך הבדיקה ידועים — אין מה לבדוק
  assert.equal(sameDatesReport(reports, "", "2026-03-01", "2027-03-01"), null);
  assert.equal(sameDatesReport(reports, "1", "", "2027-03-01"), null);
  assert.equal(sameDatesReport(undefined, "1", "2026-03-01", "2027-03-01"), null);
});

test("addTarget — 'הוספת ליקוי' גם בתקופתי שסומן נקי; לא בבדיקה חוזרת נקייה", async () => {
  const { deriveInspection } = await load();
  const cycleOf = (reports, pid = 1) =>
    deriveInspection({ reports, machines: [{ key: "1", retired_at: null, periodic_id: pid }] }).cycles[0];
  // תקופתי נקי ("אין ליקויים") — היעד הוא הוא (השרת מוריד את הסימון עם p_unclean)
  assert.equal(cycleOf([rep({ id: 1, inspected_on: "2026-03-01", declared_clean: true })]).addTarget?.id, 1);
  // תקופתי עם ליקויים — כמו קודם
  assert.equal(cycleOf([rep({ id: 1, inspected_on: "2026-03-01" })]).addTarget?.id, 1);
  // בדיקה חוזרת נקייה היא האחרונה — אין יעד: הבודק סגר את המחזור, וליקוי חדש מגיע עם תסקיר חדש
  const closed = cycleOf([
    rep({ id: 1, inspected_on: "2026-03-01" }),
    rep({ id: 2, kind: "followup", followup_of: 1, inspected_on: "2026-05-01", valid_until: null, declared_clean: true }),
  ]);
  assert.equal(closed.addTarget, null);
  // ⚠️ ולא "האחרון שאינו נקי": התקופתי הישן מתחת לחוזרת הנקייה אינו יעד
  assert.equal(closed.latest?.id, 2);
  // חוזרת עם ליקויים היא האחרונה — אליה
  assert.equal(cycleOf([
    rep({ id: 1, inspected_on: "2026-03-01" }),
    rep({ id: 2, kind: "followup", followup_of: 1, inspected_on: "2026-05-01", valid_until: null }),
  ]).addTarget?.id, 2);
  // מתקן בלי תסקיר — אין יעד
  assert.equal(cycleOf([], null).addTarget, null);
});
