// tests/compliance-ui.test.js — הצד של הדשבורד ברמזורי הבודק והתחזוקה: תרגום, לא החלטה.
//
// ============================================================
// ⚠️ מה נבדק כאן, ומה לא
// ============================================================
// המצב (שבעה: ok/fixing/soon/awaiting/overdue/expired/none) נקבע ב-SQL ונבדק ב-compliance.test.js.
// כאן נבדק רק מה שהדשבורד עושה עם השורה: איך היא מתורגמת לאובייקט של הכרטיס, מה כתוב ליד
// המנורה ובחלונית שלה, ושלכל מצב יש דירוג, גליף, תווית וצבע.
//
// (רשימת "דורש טיפול" למנהלים והבדיקות שלה הוסרו לבקשת בעלת המוצר, 06/10/2026.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toCompliance, stateLabel, lightTitle, markFor, markVisible, draftStale, lampState, machineLampLabel,
  ALL_AREAS, COMPLIANCE_AREAS, PM_ENABLED, worstSeverity, severity, GLYPH, LIGHT_LABEL,
  COMPLIANCE_FILTER_ROWS, complianceFilterKey, complianceFilterCounts,
  DEFAULT_COMPLIANCE_VIEW, lampAreasFor, matchesComplianceView, complianceActiveCount, sanitizeComplianceView,
} from "../../dashboard/src/utils/compliance.js";
import { COMPLIANCE_STATES, COMPLIANCE_COLORS } from "../../dashboard/src/utils/constants.js";
import { mergeCompliance } from "../../dashboard/src/utils/complianceMerge.js";

const NOW = "2026-10-04T09:00:00.000Z";

/** שורת site_compliance כמו שה-RPC מחזיר — תקינה, ואז דריסות. */
function row(over = {}) {
  return {
    site_id: 1, site_code: "1000", site_name: "אתר",
    inspection_state: "ok", inspection_validity_state: "ok", inspection_valid_until: "2027-03-16",
    inspection_days_left: 163, inspection_missing: false, inspection_cycle: "clean",
    inspection_awaiting_since: null, open_defects: 0, overdue_defects: 0, due_soon_defects: 0,
    machines: 1, machines_detail: [{ key: "1", label: null, valid_until: "2027-03-16", state: "ok", validity: "ok", cycle: "clean",
      open: 0, overdue: 0, due_soon: 0 }],
    pm_state: "ok", pm_missing: false, pm_last_on: "2026-08-01", pm_last_visit_id: 5, pm_due_on: "2027-02-01",
    pm_days_left: 120, pm_draft_id: null, pm_draft_last_activity: null,
    ...over,
  };
}

// ---------------------------------------------------------------
// toCompliance
// ---------------------------------------------------------------
test("toCompliance: שורה חסרה → {unknown:true} (מנורה '?'), לא null ולא אובייקט ריק", () => {
  assert.deepEqual(toCompliance(undefined), { unknown: true });
  assert.deepEqual(toCompliance(null), { unknown: true });
  assert.equal(lampState("inspection", toCompliance(null)), "unknown");
});

test("toCompliance: השדות עוברים כפי שהם — המצב מה-SQL, לא מחושב כאן", () => {
  const c = toCompliance(row({ inspection_state: "awaiting", inspection_validity_state: "ok", inspection_cycle: "awaiting_clean",
    inspection_awaiting_since: "2026-09-20", open_defects: 0, pm_state: "expired", pm_days_left: -3 }));
  assert.equal(c.inspection.state, "awaiting");
  assert.equal(c.inspection.validityState, "ok");
  assert.equal(c.inspection.awaitingSince, "2026-09-20");
  assert.equal(c.pm.state, "expired");
  assert.equal(c.pm.daysLeft, -3);
  assert.equal(c.inspection.machinesDetail.length, 1);
});

test("⚠️ toCompliance: הספירה 'בתוך החודש' עוברת בשם של ה-SQL — באתר ובכל מתקן", () => {
  // ?? 0 היה מאפס בשקט שם שגוי — הבדיקה הזו ובדיקה 49 ב-SQL מצמידות את השם משני הצדדים
  const c = toCompliance(row({ inspection_state: "soon", open_defects: 3, overdue_defects: 0, due_soon_defects: 2,
    machines_detail: [{ key: "1", state: "soon", validity: "ok", cycle: "open", open: 3, overdue: 0, due_soon: 2 }] }));
  assert.equal(c.inspection.dueSoonDefects, 2);
  assert.equal(c.inspection.machinesDetail[0].dueSoon, 2);
});

test("toCompliance: בלי עמודת התוקף — המצב משמש כתוקף רק אם הוא באמת מצב תוקף", () => {
  const legacy = (state) => { const r = row({ inspection_state: state }); delete r.inspection_validity_state; return toCompliance(r); };
  assert.equal(legacy("soon").inspection.validityState, "soon");
  assert.equal(legacy("overdue").inspection.validityState, "none", "כתום אינו תוקף");
  assert.equal(legacy("fixing").inspection.validityState, "none");
});

// ---------------------------------------------------------------
// התווית ליד המנורה
// ---------------------------------------------------------------
// ⚠️ רמזור במילים של בעלת המוצר (06/10/2026): בתוקף / עומד לפוג תוך חודש / לא בתוקף,
// לבודק ולתחזוקה כאחד. "באיחור" ו"בקרוב" הוחלפו — לא להחזיר בלי לשאול.
test("רמזור: שלוש המילים, לבודק ולתחזוקה", () => {
  const at = (state, days) => toCompliance(row({
    inspection_state: state, inspection_validity_state: state, inspection_days_left: days,
    pm_state: state, pm_days_left: days,
  }));
  assert.equal(stateLabel("inspection", at("ok", 163)), "בודק בתוקף");
  assert.equal(stateLabel("inspection", at("soon", 12)), "בודק עומד לפוג תוך חודש");
  assert.equal(stateLabel("inspection", at("expired", -3)), "בודק לא בתוקף");
  assert.equal(stateLabel("pm", at("ok", 120)), "תחזוקה בתוקף");
  assert.equal(stateLabel("pm", at("soon", 12)), "תחזוקה עומדת לפוג תוך חודש");
  assert.equal(stateLabel("pm", at("expired", -3)), "תחזוקה לא בתוקף");
  // והחלונית אומרת כמה בדיוק
  assert.match(lightTitle("inspection", at("soon", 12)), /עומד לפוג בעוד 12 ימים/);
  assert.match(lightTitle("pm", at("soon", 12)), /עומדת לפוג — הבאה עד .* \(עוד 12 ימים\)/);
  assert.match(lightTitle("pm", at("expired", -3)), /לא בתוקף — נדרשה עד/);
});
test("⚠️ צהוב חזק מהמחזור על תסקיר בתוקף — 'בודק בתוקף · ממתין לתסקיר נקי', לא 'עומד לפוג'", () => {
  const c = toCompliance(row({ inspection_state: "awaiting", inspection_validity_state: "ok", inspection_cycle: "awaiting_clean" }));
  assert.equal(stateLabel("inspection", c), "בודק בתוקף · ממתין לתסקיר נקי");
  // ומסמך שעומד לפוג כשהליקויים כבר טופלו — שתי הסיבות
  const both = toCompliance(row({ inspection_state: "awaiting", inspection_validity_state: "soon", inspection_cycle: "awaiting_clean" }));
  assert.equal(stateLabel("inspection", both), "בודק עומד לפוג תוך חודש · ממתין לתסקיר נקי");
});

// ---------------------------------------------------------------
// ⚠️ הטבלה של בעלת המוצר (06/10/2026) — תשעה מקרים, שבעה מצבים
// ---------------------------------------------------------------
// 2 שחור-לבן · 1 ירוק · 4, 9 צהוב · 8 צהוב חזק · 3 כתום · 5, 6, 7 אדום. המצב מגיע מה-SQL
// (בדיקה 49 שם); כאן — מה שהדשבורד עושה איתו: תווית, סימן בכרטיס הקטן, דירוג.
const CASES = [
  // [מקרה, מצב, תוקף, מחזור, ספירות, תווית, סימן בכרטיס הקטן]
  ["2 בתוקף, אין ליקויים", "ok", "ok", "clean", {}, "בודק בתוקף", false],
  ["1 בתוקף, ליקויים בזמן", "fixing", "ok", "open", { open_defects: 2 }, "בודק בתוקף · ליקויים בטיפול", false],
  ["4 עומד לפוג", "soon", "soon", "clean", {}, "בודק עומד לפוג תוך חודש", true],
  ["9 מועד תיקון בתוך החודש", "soon", "ok", "open", { open_defects: 1, due_soon_defects: 1 }, "בודק בתוקף · מועד תיקון בעוד פחות מחודש", true],
  ["8 טופלו, ממתין לנקי", "awaiting", "ok", "awaiting_clean", {}, "בודק בתוקף · ממתין לתסקיר נקי", true],
  ["3 עבר מועד", "overdue", "ok", "open", { open_defects: 2, overdue_defects: 1 }, "בודק בתוקף · עבר מועד תיקון", true],
  ["5 לא בתוקף", "expired", "expired", "clean", {}, "בודק לא בתוקף", true],
  ["6 לא בתוקף, טופלו", "expired", "expired", "awaiting_clean", {}, "בודק לא בתוקף", true],
  ["7 לא בתוקף, עבר מועד", "expired", "expired", "open", { open_defects: 1, overdue_defects: 1 }, "בודק לא בתוקף", true],
];
for (const [name, state, validity, cycle, counts, label, marked] of CASES) {
  test(`מקרה ${name}: '${label}'`, () => {
    const c = toCompliance(row({ inspection_state: state, inspection_validity_state: validity, inspection_cycle: cycle, ...counts }));
    assert.equal(lampState("inspection", c), state);
    assert.equal(stateLabel("inspection", c), label);
    assert.equal(markVisible(markFor(c, ["inspection"])), marked, "סימן בכרטיס הקטן רק כשצריך לעשות משהו");
  });
}

test("⚠️ שלמות: לכל מצב של ה-SQL — דירוג, גליף משלו, תווית וצבע; ומצב לא מוכר אינו יורד מתחת לתקין", () => {
  for (const st of COMPLIANCE_STATES) {
    assert.ok(GLYPH[st], `גליף ל-${st}`);
    assert.ok(LIGHT_LABEL.inspection[st], `תווית ל-${st}`);
    assert.ok(COMPLIANCE_COLORS[st]?.bg && COMPLIANCE_COLORS[st]?.border && COMPLIANCE_COLORS[st]?.ink, `צבע ל-${st}`);
  }
  const glyphs = [...COMPLIANCE_STATES, "unknown"].map((s) => GLYPH[s]);
  assert.equal(new Set(glyphs).size, glyphs.length, "גליף אחר לכל מצב — הצבע לעולם אינו הסימן היחיד");
  // הסדר של app.light_rank, ו-"?" מעל התקין
  const order = ["none", "ok", "unknown", "fixing", "soon", "awaiting", "overdue", "expired"];
  for (let i = 1; i < order.length; i++) assert.ok(severity(order[i]) > severity(order[i - 1]), `${order[i]} > ${order[i - 1]}`);
  assert.ok(severity("state-from-the-future") > severity("ok"), "מצב לא מוכר — לפחות כמו '?', לא 0");
});

test("⚠️ בלי 'באיחור' בתוויות המנורה (בעלת המוצר החליפה את המילה)", () => {
  for (const [, state, validity, cycle, counts] of CASES) {
    const c = toCompliance(row({ inspection_state: state, inspection_validity_state: validity, inspection_cycle: cycle, ...counts }));
    assert.doesNotMatch(stateLabel("inspection", c), /באיחור/);
  }
  for (const l of Object.values(LIGHT_LABEL.inspection)) assert.doesNotMatch(l, /באיחור/);
});

test("⚠️ SQL ישן (לפני ההחלה): soon על תסקיר בתוקף עם ליקוי באיחור / המתנה — הסיבה הישנה, לא 'מועד קרוב'", () => {
  const old = (o) => stateLabel("inspection", toCompliance(row({ inspection_state: "soon", inspection_validity_state: "ok", ...o })));
  assert.equal(old({ inspection_cycle: "open", open_defects: 2, overdue_defects: 1 }), "בודק בתוקף · עבר מועד תיקון");
  assert.equal(old({ inspection_cycle: "awaiting_clean" }), "בודק בתוקף · ממתין לתסקיר נקי");
});

test("אין תסקיר אחרי העלייה לאוויר → 'אין תסקיר בודק'; לפני — 'אין נתונים' אפור", () => {
  const after = toCompliance(row({ inspection_state: "expired", inspection_validity_state: "expired",
    inspection_valid_until: null, inspection_days_left: null, inspection_missing: true, inspection_cycle: "none" }));
  assert.equal(stateLabel("inspection", after), "אין תסקיר בודק");
  const before = toCompliance(row({ inspection_state: "none", inspection_validity_state: "none",
    inspection_valid_until: null, inspection_days_left: null, inspection_missing: true, inspection_cycle: "none" }));
  assert.equal(stateLabel("inspection", before), "בודק — אין נתונים");
});

test("title: פג לפני 3 ימים, וסימון stale מוסיף שורה", () => {
  const c = toCompliance(row({ inspection_state: "expired", inspection_validity_state: "expired",
    inspection_valid_until: "2026-10-01", inspection_days_left: -3 }));
  assert.match(lightTitle("inspection", c, NOW), /לא בתוקף — פג לפני 3 ימים \(01\/10\/2026\)/);
  assert.match(lightTitle("inspection", { ...c, stale: true }, NOW), /סטטוס לא עודכן/);
});

// ---------------------------------------------------------------
// סימן ה-mini והטיוטה
// ---------------------------------------------------------------
// ⚠️ התחזוקה המונעת מוסתרת באתר החי (PM_ENABLED). הבדיקות שלה מעבירות ALL_AREAS
// במפורש — כך הקוד הרדום ממשיך להיבדק — ובדיקות ברירת המחדל מוודאות שהיא באמת מוסתרת.
test("mini: הגרוע מבין השתיים; ירוק ואפור אינם מצוירים, '?' כן", () => {
  const c = toCompliance(row({ pm_state: "soon", pm_days_left: 20 }));
  assert.deepEqual(markFor(c, ALL_AREAS), { state: "soon", tab: "pm", stale: false });
  assert.equal(markVisible(markFor(c, ALL_AREAS)), true);
  assert.equal(markVisible(markFor(toCompliance(row()))), false);
  assert.equal(markVisible(markFor({ unknown: true })), true);
  assert.equal(markFor(undefined), null, "מצב שרת — אין סימן בכלל");
});

test("טיוטה שלא נגעו בה 12 שעות → לא הוגש; 11 שעות → עדיין לא", () => {
  const mk = (iso) => toCompliance(row({ pm_draft_id: 9, pm_draft_last_activity: iso }));
  assert.equal(draftStale(mk("2026-10-03T20:59:00.000Z"), NOW), true);
  assert.equal(draftStale(mk("2026-10-03T22:00:00.000Z"), NOW), false);
});

// ---------------------------------------------------------------
// רגרסיות מסקירת החיבור (04/10) — כל אחת נכשלה על הקוד שלפני התיקון
// ---------------------------------------------------------------
// אתר עם שני מתקנים: A עם ליקוי פתוח בזמן (ירוק, מחזור האתר = open), B ממתין לתסקיר נקי
// (צהוב חזק — הוא המצב של האתר). התוקף של שניהם בסדר.
const twoMachines = () => toCompliance(row({
  inspection_state: "awaiting", inspection_validity_state: "ok", inspection_valid_until: "2027-06-01", inspection_days_left: 240,
  inspection_cycle: "open", inspection_awaiting_since: "2026-08-01", open_defects: 2, overdue_defects: 0, machines: 2,
  machines_detail: [
    { key: "A", label: null, valid_until: "2027-06-01", state: "fixing", validity: "ok", cycle: "open", open: 2, overdue: 0 },
    { key: "B", label: null, valid_until: "2027-06-01", state: "awaiting", validity: "ok", cycle: "awaiting_clean", open: 0, overdue: 0 },
  ],
}));

test("⚠️ שני מתקנים: הסיבה של מתקן B ('ממתין') נמצאת גם כשמחזור האתר הוא open", () => {
  const label = stateLabel("inspection", twoMachines());
  assert.doesNotMatch(label, /עומד לפוג/);
  assert.match(label, /בתוקף/);
  assert.match(label, /ממתין לתסקיר נקי/);
});

test("⚠️ שני מתקנים: ההמתנה של מתקן B מופיעה בחלונית המנורה, עם התאריך", () => {
  assert.match(lightTitle("inspection", twoMachines(), NOW), /ממתין לתסקיר נקי מאז 01\/08/);
});

// ---------------------------------------------------------------
// ⚠️ ליקוי שעבר את מועד התיקון → מנורה כתומה על תסקיר בתוקף (מקרה 3 בטבלה של 06/10/2026).
// התווית חייבת לומר "בתוקף · עבר מועד תיקון" — לא "לא בתוקף" (שולח לזמן בודק),
// ולא "נדרשת בדיקה חוזרת" (הנפילה של סיבת המחזור).
const overdue = (over = {}) => toCompliance(row({
  inspection_state: "overdue", inspection_validity_state: "ok", inspection_cycle: "open",
  open_defects: 2, overdue_defects: 1,
  machines_detail: [{ key: "1", label: null, valid_until: "2027-03-16", state: "overdue", validity: "ok", cycle: "open", open: 2, overdue: 1 }],
  ...over,
}));

test("⚠️ ליקוי באיחור על תסקיר בתוקף: 'בודק בתוקף · עבר מועד תיקון', והמנורה כתומה", () => {
  const c = overdue();
  assert.equal(lampState("inspection", c), "overdue");
  assert.equal(stateLabel("inspection", c), "בודק בתוקף · עבר מועד תיקון");
  assert.equal(c.inspection.machinesDetail[0].validity, "ok", "toCompliance מעביר את התוקף של המתקן");
  assert.deepEqual(markFor(c), { state: "overdue", tab: "inspection", stale: false });
  assert.match(lightTitle("inspection", c, NOW), /בתוקף עד 16\/03\/2027/);
  assert.match(lightTitle("inspection", c, NOW), /2 ליקויים פתוחים · 1 באיחור/);
});

test("ליקוי באיחור + תוקף שעומד לפוג: שתי הסיבות; תסקיר שפג: 'לא בתוקף' בלבד", () => {
  assert.equal(stateLabel("inspection", overdue({ inspection_validity_state: "soon", inspection_days_left: 12 })),
    "בודק עומד לפוג תוך חודש · עבר מועד תיקון");
  assert.equal(stateLabel("inspection", overdue({ inspection_state: "expired", inspection_validity_state: "expired", inspection_days_left: -3 })),
    "בודק לא בתוקף");
});

test("machineLampLabel: כל המצבים — בשתי צורות הנתון (site_compliance / inspection_site)", () => {
  assert.equal(machineLampLabel({ state: "overdue", validity: "ok", overdue: 1, cycle: "open" }), "בודק בתוקף · עבר מועד תיקון");
  assert.equal(machineLampLabel({ state: "overdue", validity_state: "ok", overdue: 1, cycle: "open" }), "בודק בתוקף · עבר מועד תיקון");
  assert.equal(machineLampLabel({ state: "overdue", validity_state: "soon", overdue: 1, cycle: "open" }), "בודק עומד לפוג תוך חודש · עבר מועד תיקון");
  assert.equal(machineLampLabel({ state: "expired", validity_state: "expired", overdue: 1, cycle: "open" }), "בודק לא בתוקף");
  assert.equal(machineLampLabel({ state: "awaiting", validity_state: "ok", overdue: 0, cycle: "awaiting_clean" }), "בודק בתוקף · ממתין לתסקיר נקי");
  assert.equal(machineLampLabel({ state: "awaiting", validity_state: "ok", overdue: 0, cycle: "review" }), "בודק בתוקף · לבדיקה");
  assert.equal(machineLampLabel({ state: "awaiting", validity_state: "soon", cycle: "awaiting_clean" }),
    "בודק עומד לפוג תוך חודש · ממתין לתסקיר נקי", "התוקף שעומד לפוג אינו נבלע בסיבה");
  assert.equal(machineLampLabel({ state: "fixing", validity_state: "ok", open: 2, cycle: "open" }), "בודק בתוקף · ליקויים בטיפול");
  assert.equal(machineLampLabel({ state: "soon", validity_state: "ok", open: 1, due_soon: 1, cycle: "open" }),
    "בודק בתוקף · מועד תיקון בעוד פחות מחודש");
  assert.equal(machineLampLabel({ state: "soon", validity_state: "soon", cycle: "clean" }), "בודק עומד לפוג תוך חודש");
  assert.equal(machineLampLabel({ state: "ok", validity_state: "ok", overdue: 0, cycle: "clean" }), "בודק בתוקף");
  // בלי תוקף נפרד (נתון ישן) — לפי המצב, ולעולם לא המילה האנגלית
  assert.equal(machineLampLabel({ state: "expired", overdue: 1, cycle: "open" }), "בודק לא בתוקף");
  assert.equal(machineLampLabel({ state: "state-from-the-future" }), "בודק — לא נטען");
});

test("שני מתקנים: A באיחור, B בתוקף — האתר 'בתוקף · עבר מועד תיקון', והגרוע הוא A עם הסיבה", () => {
  const c = overdue({
    machines: 2,
    machines_detail: [
      { key: "A", label: "צפון", valid_until: "2027-03-16", state: "overdue", validity: "ok", cycle: "open", open: 2, overdue: 1 },
      { key: "B", label: "דרום", valid_until: "2027-03-16", state: "ok", validity: "ok", cycle: "clean", open: 0, overdue: 0 },
    ],
  });
  assert.equal(stateLabel("inspection", c), "בודק בתוקף · עבר מועד תיקון");
  assert.match(lightTitle("inspection", c, NOW), /הגרוע: צפון \(בודק בתוקף · עבר מועד תיקון\)/);
});

const L = (id, code, compliance) => ({ id, code, compliance });
const RED = toCompliance(row({ inspection_state: "expired", inspection_validity_state: "expired", inspection_days_left: -3 }));
const GREEN = toCompliance(row());

test("⚠️ מיזוג לפי id: אתר ששונה לו הקוד שומר את המצב בסבב בלי רמזורים", () => {
  const { list, missing } = mergeCompliance([L(7, "2438", RED)], [L(7, "2440", null)]);
  assert.equal(list[0].compliance, RED);
  assert.equal(missing, false);
});

test("אתר חדש בסבב בלי רמזורים → '?' ו-missing (הסבב הבא ישלוף)", () => {
  const { list, missing } = mergeCompliance([L(7, "2438", RED)], [L(7, "2438", null), L(8, "9999", null)]);
  assert.deepEqual(list[1].compliance, { unknown: true });
  assert.equal(missing, true);
});

test("⚠️ שליפה מלאה שיצאה לפני עדכון ממוקד אינה דורסת אותו", () => {
  // התחילה ב-1000, העדכון (GREEN) ב-1500, היא חוזרת עם הצילום הישן (RED)
  const { list } = mergeCompliance([L(7, "2438", GREEN)], [L(7, "2438", RED)], 1000, { 7: 1500 });
  assert.equal(list[0].compliance, GREEN);
  // ושליפה שיצאה אחרי העדכון — היא החדשה
  const later = mergeCompliance([L(7, "2438", GREEN)], [L(7, "2438", RED)], 2000, { 7: 1500 });
  assert.equal(later.list[0].compliance, RED);
});

test("כשל בשליפה: מצב ידוע נשמר עם stale; בלי מצב קודם — '?' עם השגיאה", () => {
  const err = { unknown: true, error: "PGRST202" };
  const { list } = mergeCompliance([L(7, "2438", RED)], [L(7, "2438", err), L(8, "9", err)]);
  assert.equal(list[0].compliance.stale, true);
  assert.equal(list[0].compliance.inspection.state, "expired");
  assert.deepEqual(list[1].compliance, err);
});

// ---------------------------------------------------------------
// הצעת תאריך מדוח תחזוקה היסטורי (PmUtils.suggestDocDate)
// ---------------------------------------------------------------
import { suggestDocDate } from "../../dashboard/src/components/Compliance/PmUtils.js";
const page = (s) => ({ items: [{ str: s }] });

test("⚠️ תאריך ISO בדוח היסטורי נקרא נכון, לא נחתך ל-26/11/2011", () => {
  assert.equal(suggestDocDate([page("תאריך ביצוע: 2026-03-11")], "2026-10-04"), "2026-03-11");
  assert.equal(suggestDocDate([page("ביצוע 11/03/2026, הביקור הבא 11/09/2026")], "2026-05-01"), "2026-03-11");   // הבא — בעתיד, נפסל
  // מספר ארוך שמכיל תאריך אינו תאריך
  assert.equal(suggestDocDate([page("הזמנה 12026-03-11")], "2026-10-04"), null);
});

// ---------------------------------------------------------------
// רשימת הבדיקה: סך התמונות הנדרשות בביקור (PmUtils.templatePhotoTotal)
// ---------------------------------------------------------------
// ⚠️ שיקוף של pm_template_save (שם הכלל נאכף): מעל 40 אף ביקור לא יוכל להיות
// מוגש. כאן נבדק רק שהעורך סופר כמו השרת — פריטי חובה בלבד, ו"סימון" אינו נספר.
import { templatePhotoTotal, MAX_PHOTOS_PER_VISIT } from "../../dashboard/src/components/Compliance/PmUtils.js";

test("⚠️ סך התמונות בביקור: 7 פריטי צילום חובה × 6 = 42 — מעל התקרה; רשות וסימון אינם נספרים", () => {
  const heavy = Array.from({ length: 7 }, () => ({ kind: "photo", required: true, min_photos: 6 }));
  assert.equal(templatePhotoTotal(heavy), 42);
  assert.ok(templatePhotoTotal(heavy) > MAX_PHOTOS_PER_VISIT);
  assert.equal(MAX_PHOTOS_PER_VISIT, 40);
  assert.equal(templatePhotoTotal([
    { kind: "check_photo", required: true, min_photos: 2 },
    { kind: "photo", required: false, min_photos: 3 },     // רשות — השרת מאפס ל-0
    { kind: "check", required: true, min_photos: 5 },      // סימון — אין תמונות
  ]), 2);
  assert.equal(templatePhotoTotal(null), 0);
});

// ---------------------------------------------------------------
// ⚠️ ברירת המחדל — האתר החי: בודק בלבד (בעלת המוצר, 06/10/2026: "לדחוף רק את הבודק מוסמך")
// ---------------------------------------------------------------
test("ברירת המחדל: התחזוקה המונעת כבויה — בלי משתנה סביבה אין 'pm' בשום רשימה", () => {
  assert.equal(PM_ENABLED, false, "בנייה שאיש לא הגדיר בה דבר חייבת לתת את מה שהוחלט");
  assert.deepEqual(COMPLIANCE_AREAS, ["inspection"]);
});

test("תחזוקה כבויה: אדום של תחזוקה אינו מופיע בסימן הקטן או בטבלת המפקח", () => {
  const pmRed = toCompliance(row({ pm_state: "expired", pm_due_on: "2026-09-01", pm_days_left: -33,
    pm_draft_id: 9, pm_draft_last_activity: "2026-10-01T00:00:00.000Z" }));
  assert.deepEqual(markFor(pmRed), { state: "ok", tab: "inspection", stale: false });
  assert.equal(markVisible(markFor(pmRed)), false, "אתר שהבודק שלו ירוק — אין סימן בכרטיס הקטן");
  assert.equal(worstSeverity(pmRed), severity("ok"), "המפקח ממיין לפי הבודק בלבד");
  assert.equal(worstSeverity(pmRed, ALL_AREAS), severity("expired"));
  // עם התחזוקה: כתום של בודק מעל צהוב של תחזוקה; אדום של תחזוקה מעל כתום של בודק
  const pair = (insp, pm) => markFor(toCompliance(row({ inspection_state: insp, pm_state: pm })), ALL_AREAS);
  assert.deepEqual(pair("overdue", "soon"), { state: "overdue", tab: "inspection", stale: false });
  assert.deepEqual(pair("overdue", "expired"), { state: "expired", tab: "pm", stale: false });
  assert.deepEqual(pair("fixing", "soon"), { state: "soon", tab: "pm", stale: false });
  assert.deepEqual(pair("awaiting", "soon"), { state: "awaiting", tab: "inspection", stale: false });
});

test("תחזוקה כבויה: הבודק עדיין קובע את הסימן", () => {
  const c = toCompliance(row({ inspection_state: "expired", inspection_validity_state: "expired",
    inspection_valid_until: "2026-10-01", inspection_days_left: -3, pm_state: "expired", pm_due_on: "2026-09-01", pm_days_left: -33 }));
  assert.deepEqual(markFor(c), { state: "expired", tab: "inspection", stale: false });
});

// ---------------------------------------------------------------
// סרגל הסינון בצד הלוח (08/10/2026)
// ---------------------------------------------------------------
const site = (over = {}, id = 1) => ({ id, compliance: toCompliance(row(over)) });

test("סרגל: המפתח הוא מצב המנורה, ו'אין תסקיר' נפרד מ'לא בתוקף' — כמו התווית בכרטיס", () => {
  for (const st of COMPLIANCE_STATES) {
    assert.equal(complianceFilterKey("inspection", toCompliance(row({ inspection_state: st }))), st, st);
  }
  const missing = toCompliance(row({ inspection_state: "expired", inspection_missing: true, inspection_valid_until: null }));
  assert.equal(complianceFilterKey("inspection", missing), "missing");
  assert.equal(stateLabel("inspection", missing), LIGHT_LABEL.inspection.missing, "הכרטיס אומר 'אין תסקיר בודק' — והסרגל סופר אותו שם");
  // none + missing = אפור "אין נתונים" (לפני תאריך העלייה לאוויר) — לא אדום
  assert.equal(complianceFilterKey("inspection", toCompliance(row({ inspection_state: "none", inspection_missing: true }))), "none");
  assert.equal(complianceFilterKey("pm", toCompliance(row({ pm_state: "expired", pm_missing: true }))), "missing");
  assert.equal(complianceFilterKey("pm", toCompliance(row({ pm_state: "soon" }))), "soon");
  // לא נטען / null / undefined / מצב שאינו מוכר — כולם "לא נטען", כמו ה-"?" על המנורה
  for (const c of [toCompliance(null), null, undefined, toCompliance(row({ inspection_state: "brand_new" }))]) {
    assert.equal(complianceFilterKey("inspection", c), "unknown");
  }
});

test("סרגל: לכל מצב שורה (חוץ מ'אין נתונים' ו'לא נטען'), לכל שורה מנורה עם גליף, ואין מפתח כפול", () => {
  for (const area of ALL_AREAS) {
    const keys = COMPLIANCE_FILTER_ROWS[area].map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, `${area}: מפתח כפול`);
    assert.ok(keys.includes("missing"), area);
    // ⚠️ בעלת המוצר, 08/10/2026: "תעיף את זה, זה לא קיים"
    assert.ok(!keys.includes("none") && !keys.includes("unknown"), `${area}: 'אין נתונים' / 'לא נטען' חזרו לסרגל`);
    for (const r of COMPLIANCE_FILTER_ROWS[area]) {
      assert.ok(GLYPH[r.swatch], `${area}/${r.key}: אין גליף למנורה ${r.swatch}`);
      assert.ok(r.label?.length >= 2, `${area}/${r.key}: אין תווית`);
    }
  }
  // ⚠️ מצב של הבודק בלי שורה = אתרים שאי אפשר לבחור בהם, ושהמונים לא סופרים
  for (const st of COMPLIANCE_STATES.filter((x) => x !== "none")) {
    assert.ok(COMPLIANCE_FILTER_ROWS.inspection.some((r) => r.key === st), `אין שורה ל-${st}`);
  }
  for (const st of ["ok", "soon", "expired"]) {
    assert.ok(COMPLIANCE_FILTER_ROWS.pm.some((r) => r.key === st), `תחזוקה: אין שורה ל-${st}`);
  }
  // הסדר מהחמור לקל — "לא בתוקף" ראשון, "בתוקף" אחרי כל מה שדורש טיפול
  const order = COMPLIANCE_FILTER_ROWS.inspection.map((r) => r.swatch);
  for (let i = 1; i < order.length; i++) assert.ok(severity(order[i - 1]) >= severity(order[i]), order.join(","));
});

// מצב הסרגל: לכל תחום { show, only } — סומן בכותרת, ואילו מצבים נבחרו (ריק = "הכל")
const view = (insp = {}, pm = {}) => ({ inspection: { show: true, only: [], ...insp }, pm: { show: true, only: [], ...pm } });

test("סרגל: ברירת המחדל — שום תחום לא מסומן: כל אתר עובר, ואין נורות בלוח", () => {
  const sites = [site({ inspection_state: "expired" }, 1), site({ pm_state: "soon" }, 2), { id: 3, compliance: toCompliance(null) }, { id: 4 }];
  for (const v of [DEFAULT_COMPLIANCE_VIEW, undefined, null, {}, { inspection: {} }]) {
    assert.deepEqual(sites.filter((x) => matchesComplianceView(x, v, ALL_AREAS)).map((x) => x.id), [1, 2, 3, 4], JSON.stringify(v));
    // ⚠️ "מופיעה רק כשמסמנים" (בעלת המוצר, 08/10/2026) — בלי סימון אין נורה
    assert.deepEqual(lampAreasFor(v, ALL_AREAS), [], JSON.stringify(v));
    assert.equal(complianceActiveCount(v, ALL_AREAS), 0);
  }
  // סומן, "הכל" — הנורה מופיעה, ועדיין כל האתרים (גם אלה שאין להם אריח)
  assert.deepEqual(sites.filter((x) => matchesComplianceView(x, view(), ALL_AREAS)).map((x) => x.id), [1, 2, 3, 4]);
  assert.deepEqual(lampAreasFor(view(), ALL_AREAS), ALL_AREAS);
  assert.deepEqual(lampAreasFor(view({}, { show: false }), ALL_AREAS), ["inspection"]);
  assert.deepEqual(lampAreasFor(view()), COMPLIANCE_AREAS, "בלי ארגומנט — רק התחומים המוצגים באתר");
});

test("סרגל: בחירה כמו בכותרת — רק המצבים שנבחרו; תחום לא מסומן אינו מסנן", () => {
  const sites = [
    site({ inspection_state: "expired" }, 1),
    site({ inspection_state: "expired", inspection_missing: true }, 2),
    site({ inspection_state: "ok", pm_state: "expired" }, 3),
    site({ inspection_state: "overdue", pm_state: "ok" }, 4),
    { id: 5, compliance: toCompliance(null) },
    site({ inspection_state: "none", inspection_missing: true }, 6),
  ];
  const ids = (v, areas = ALL_AREAS) => sites.filter((x) => matchesComplianceView(x, v, areas)).map((x) => x.id);
  assert.deepEqual(ids(view({ only: ["expired"] })), [1], "'לא בתוקף' אינו מחזיר את 'אין תסקיר'");
  assert.deepEqual(ids(view({ only: ["expired", "missing"] })), [1, 2], "כמה אריחים — 'או'");
  assert.deepEqual(ids(view({ only: ["ok", "overdue"] })), [3, 4]);
  // ⚠️ אתר בלי אריח (לא נטען / אין נתונים) — רק תחת "הכל"
  assert.deepEqual(ids(view()), [1, 2, 3, 4, 5, 6]);
  assert.ok(!ids(view({ only: COMPLIANCE_FILTER_ROWS.inspection.map((r) => r.key) })).some((id) => id === 5 || id === 6),
    "גם כשכל האריחים נבחרו — 'הכל' הוא האריח היחיד שמכיל אותם");
  // ⚠️ תחום לא מסומן: לא מסנן גם אם נשארה בו בחירה, ולא מצויר
  const off = view({ show: false, only: ["expired"] });
  assert.deepEqual(ids(off), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(lampAreasFor(off, ALL_AREAS), ["pm"]);
  // "וגם" בין התחומים: 3 — בודק בתוקף + תחזוקה לא בתוקף; 4 — בודק עבר מועד + תחזוקה בתוקף
  assert.deepEqual(ids(view({ only: ["ok", "overdue"] }, { only: ["expired"] })), [3]);
  assert.deepEqual(ids(view({}, { only: ["expired"] })), [3], "רק התחזוקה מסננת");
  // ⚠️ תחזוקה כבויה: בחירה שנשארה בה אינה מסננת, ואינה נורה מוצגת
  assert.deepEqual(ids(view({}, { only: ["expired"] }), ["inspection"]), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(lampAreasFor(view(), ["inspection"]), ["inspection"]);
  // המונה בכותרת: תחום שנבחר בו משהו = 1, כמו כל בורר (לא משנה מה נבחר); תחום כבוי — 0
  assert.equal(complianceActiveCount(view({}, { show: false }), ALL_AREAS), 1);
  assert.equal(complianceActiveCount(view({ only: ["ok"] }, { only: ["expired"] }), ALL_AREAS), 2);
  assert.equal(complianceActiveCount(view({ show: false, only: ["ok"] }, { show: false }), ALL_AREAS), 0);
  assert.equal(complianceActiveCount(view({}, { only: ["ok"] }), ["inspection"]), 1, "תחזוקה כבויה אינה נספרת");
});

test("סרגל: כל מונה שווה למה שהאריח מציג, והסכום (עם האתרים בלי אריח) — לכל האתרים", () => {
  const states = [...COMPLIANCE_STATES, "brand_new"];
  const sites = states.flatMap((st, i) => [
    site({ inspection_state: st, pm_state: ["ok", "soon", "expired", "none"][i % 4] }, i * 3),
    site({ inspection_state: st, inspection_missing: true, pm_state: "expired", pm_missing: i % 2 === 0 }, i * 3 + 1),
  ]).concat([{ id: 999, compliance: toCompliance(null) }]);
  const counts = complianceFilterCounts(sites, ALL_AREAS);
  for (const area of ALL_AREAS) {
    // בלי אריח: "אין נתונים" (none, גם עם missing) ו"לא נטען" (null, ומצב שאינו מוכר — brand_new)
    const unlisted = sites.filter((x) => ["none", "unknown"].includes(complianceFilterKey(area, x.compliance))).length;
    assert.ok(unlisted >= 3, `${area}: יש אתרים בלי אריח בתרחיש (${unlisted})`);
    let sum = 0;
    for (const r of COMPLIANCE_FILTER_ROWS[area]) {
      const v = { ...view({ show: false }, { show: false }), [area]: { show: true, only: [r.key] } };
      const shownN = sites.filter((x) => matchesComplianceView(x, v, ALL_AREAS)).length;
      assert.equal(counts[area][r.key], shownN, `${area}/${r.key}: מונה ${counts[area][r.key]}, האריח מציג ${shownN}`);
      sum += shownN;
    }
    assert.equal(sum + unlisted, sites.length, `${area}: כל אתר באריח אחד בדיוק, או בלי אריח`);
    assert.ok(Object.values(counts[area]).every(Number.isFinite), `${area}: מונה לא מספר`);
  }
  assert.deepEqual(Object.keys(complianceFilterCounts(sites, ["inspection"])), ["inspection"]);
});

test("סימן ה-mini מכבד נורה מוסתרת: בודק מוסתר — רק התחזוקה; בלי תחומים — אין סימן", () => {
  const c = toCompliance(row({ inspection_state: "expired", pm_state: "soon" }));
  assert.deepEqual(markFor(c, ALL_AREAS), { state: "expired", tab: "inspection", stale: false });
  assert.deepEqual(markFor(c, ["pm"]), { state: "soon", tab: "pm", stale: false }, "האדום של הבודק המוסתר אינו חוזר דרך הסימן");
  assert.deepEqual(markFor(toCompliance(row({ pm_state: "ok" })), ["pm"]), { state: "ok", tab: "pm", stale: false });
  assert.equal(markFor(c, []), null);
  assert.equal(markVisible(markFor(c, [])), false);
  assert.deepEqual(markFor(toCompliance(null), ["pm"]), { state: "unknown", tab: "pm", stale: false }, "'?' פותח לשונית שקיימת");
  assert.deepEqual(markFor(toCompliance(null)), { state: "unknown", tab: "inspection", stale: false });
});

test("בחירה שמורה (localStorage): מה שמוכר נשמר, כל השאר — ברירת המחדל של אותו תחום", () => {
  const off = { show: false, only: [] };
  for (const raw of [null, undefined, "x", 7, [], {}, { inspection: null }, { inspection: { show: "true", only: ["ok"] } }]) {
    assert.deepEqual(sanitizeComplianceView(raw), { inspection: off, pm: off }, JSON.stringify(raw));
  }
  assert.deepEqual(sanitizeComplianceView({ inspection: { show: true, only: ["overdue"] } }),
    { inspection: { show: true, only: ["overdue"] }, pm: off });
  assert.deepEqual(sanitizeComplianceView({ inspection: { show: true, only: [] } }).inspection, { show: true, only: [] }, "'כל האתרים'");
  // ⚠️ מצב שהוסר מהבורר ("none" עד 08/10) או מפתח זר — "כל האתרים", לא לוח מסונן לאפס
  assert.deepEqual(sanitizeComplianceView({ inspection: { show: true, only: ["none"] } }).inspection, { show: true, only: [] });
  assert.deepEqual(sanitizeComplianceView({ inspection: { show: true, only: ["unknown"] } }).inspection, { show: true, only: [] });
  assert.deepEqual(sanitizeComplianceView({ inspection: { show: true, only: "ok" } }).inspection, { show: true, only: [] });
  // בחירה אחת, כמו הבורר; ומפתח נבדק מול השורות של התחום שלו
  assert.deepEqual(sanitizeComplianceView({ inspection: { show: true, only: ["expired", "ok"] } }).inspection, { show: true, only: ["expired"] });
  assert.deepEqual(sanitizeComplianceView({ pm: { show: true, only: ["overdue"] } }).pm, { show: true, only: [] }, "'עבר מועד תיקון' אינו מצב של תחזוקה");
  assert.deepEqual(sanitizeComplianceView({ pm: { show: true, only: ["soon"] } }).pm, { show: true, only: ["soon"] });
  // ברירת המחדל עצמה עוברת כמו שהיא
  assert.deepEqual(sanitizeComplianceView(DEFAULT_COMPLIANCE_VIEW), { inspection: off, pm: off });
});
