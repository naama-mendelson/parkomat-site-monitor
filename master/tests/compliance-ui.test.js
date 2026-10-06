// tests/compliance-ui.test.js — הצד של הדשבורד ברמזורי הבודק והתחזוקה: תרגום, לא החלטה.
//
// ============================================================
// ⚠️ מה נבדק כאן, ומה לא
// ============================================================
// הצבע (ok/soon/expired/none) נקבע ב-SQL ונבדק ב-compliance.test.js. כאן
// נבדק רק מה שהדשבורד עושה עם השורה: איך היא מתורגמת לאובייקט של הכרטיס,
// ומה כתוב ליד המנורה ובחלונית שלה.
//
// (רשימת "דורש טיפול" למנהלים והבדיקות שלה הוסרו לבקשת בעלת המוצר, 06/10/2026.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toCompliance, stateLabel, lightTitle, markFor, markVisible, draftStale, lampState, machineLampLabel,
  ALL_AREAS, COMPLIANCE_AREAS, PM_ENABLED, worstSeverity,
} from "../../dashboard/src/utils/compliance.js";
import { mergeCompliance } from "../../dashboard/src/utils/complianceMerge.js";

const NOW = "2026-10-04T09:00:00.000Z";

/** שורת site_compliance כמו שה-RPC מחזיר — תקינה, ואז דריסות. */
function row(over = {}) {
  return {
    site_id: 1, site_code: "1000", site_name: "אתר",
    inspection_state: "ok", inspection_validity_state: "ok", inspection_valid_until: "2027-03-16",
    inspection_days_left: 163, inspection_missing: false, inspection_cycle: "clean",
    inspection_awaiting_since: null, open_defects: 0, overdue_defects: 0,
    machines: 1, machines_detail: [{ key: "1", label: null, valid_until: "2027-03-16", state: "ok", cycle: "clean", open: 0, overdue: 0 }],
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
  const c = toCompliance(row({ inspection_state: "soon", inspection_validity_state: "ok", inspection_cycle: "awaiting_clean",
    inspection_awaiting_since: "2026-09-20", open_defects: 0, pm_state: "expired", pm_days_left: -3 }));
  assert.equal(c.inspection.state, "soon");
  assert.equal(c.inspection.validityState, "ok");
  assert.equal(c.inspection.awaitingSince, "2026-09-20");
  assert.equal(c.pm.state, "expired");
  assert.equal(c.pm.daysLeft, -3);
  assert.equal(c.inspection.machinesDetail.length, 1);
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
test("⚠️ צהוב מהמחזור על תסקיר בתוקף — 'בודק בתוקף · ממתין לתסקיר נקי', לא 'עומד לפוג'", () => {
  const c = toCompliance(row({ inspection_state: "soon", inspection_validity_state: "ok", inspection_cycle: "awaiting_clean" }));
  const label = stateLabel("inspection", c);
  assert.match(label, /בתוקף/);
  assert.match(label, /ממתין לתסקיר נקי/);
  assert.doesNotMatch(label, /עומד לפוג/);
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
// אתר עם שני מתקנים: A עם ליקוי פתוח (מחזור האתר = open), B ממתין לתסקיר נקי
// (המנורה שלו עלתה לצהוב). התוקף של שניהם בסדר.
const twoMachines = () => toCompliance(row({
  inspection_state: "soon", inspection_validity_state: "ok", inspection_valid_until: "2027-06-01", inspection_days_left: 240,
  inspection_cycle: "open", inspection_awaiting_since: "2026-08-01", open_defects: 2, overdue_defects: 0, machines: 2,
  machines_detail: [
    { key: "A", label: null, valid_until: "2027-06-01", state: "ok", cycle: "open", open: 2, overdue: 0 },
    { key: "B", label: null, valid_until: "2027-06-01", state: "soon", cycle: "awaiting_clean", open: 0, overdue: 0 },
  ],
}));

test("⚠️ שני מתקנים: צהוב ממחזור של מתקן B אינו 'עומד לפוג' כשמחזור האתר הוא open", () => {
  const label = stateLabel("inspection", twoMachines());
  assert.doesNotMatch(label, /עומד לפוג/);
  assert.match(label, /בתוקף/);
  assert.match(label, /ממתין לתסקיר נקי/);
});

test("⚠️ שני מתקנים: ההמתנה של מתקן B מופיעה בחלונית המנורה, עם התאריך", () => {
  assert.match(lightTitle("inspection", twoMachines(), NOW), /ממתין לתסקיר נקי מאז 01\/08/);
});

// ---------------------------------------------------------------
// ⚠️ ליקוי שעבר את מועד התיקון → מנורה צהובה על תסקיר בתוקף (06/10/2026: "זה צריך להיות צהוב כיון
// שהמסמך בתוקף אבל הליקויים לא טופלו" — מחליף את האדום של אותו בוקר).
// התווית חייבת לומר "בתוקף · עבר מועד תיקון" — לא "לא בתוקף" (שולח לזמן בודק),
// ולא "נדרשת בדיקה חוזרת" (הנפילה של סיבת המחזור).
const overdue = (over = {}) => toCompliance(row({
  inspection_state: "soon", inspection_validity_state: "ok", inspection_cycle: "open",
  open_defects: 2, overdue_defects: 1,
  machines_detail: [{ key: "1", label: null, valid_until: "2027-03-16", state: "soon", validity: "ok", cycle: "open", open: 2, overdue: 1 }],
  ...over,
}));

test("⚠️ ליקוי באיחור על תסקיר בתוקף: 'בודק בתוקף · עבר מועד תיקון', והמנורה צהובה", () => {
  const c = overdue();
  assert.equal(lampState("inspection", c), "soon");
  assert.equal(stateLabel("inspection", c), "בודק בתוקף · עבר מועד תיקון");
  assert.equal(c.inspection.machinesDetail[0].validity, "ok", "toCompliance מעביר את התוקף של המתקן");
  assert.deepEqual(markFor(c), { state: "soon", tab: "inspection", stale: false });
  assert.match(lightTitle("inspection", c, NOW), /בתוקף עד 16\/03\/2027/);
  assert.match(lightTitle("inspection", c, NOW), /2 ליקויים פתוחים · 1 באיחור/);
});

test("ליקוי באיחור + תוקף שעומד לפוג: שתי הסיבות; תסקיר שפג: 'לא בתוקף' בלבד", () => {
  assert.equal(stateLabel("inspection", overdue({ inspection_validity_state: "soon", inspection_days_left: 12 })),
    "בודק עומד לפוג תוך חודש · עבר מועד תיקון");
  assert.equal(stateLabel("inspection", overdue({ inspection_state: "expired", inspection_validity_state: "expired", inspection_days_left: -3 })),
    "בודק לא בתוקף");
});

test("machineLampLabel: מתקן צהוב מליקוי באיחור — בשתי צורות הנתון (site_compliance / inspection_site)", () => {
  assert.equal(machineLampLabel({ state: "soon", validity: "ok", overdue: 1, cycle: "open" }), "בודק בתוקף · עבר מועד תיקון");
  assert.equal(machineLampLabel({ state: "soon", validity_state: "ok", overdue: 1, cycle: "open" }), "בודק בתוקף · עבר מועד תיקון");
  assert.equal(machineLampLabel({ state: "soon", validity_state: "soon", overdue: 1, cycle: "open" }), "בודק עומד לפוג תוך חודש · עבר מועד תיקון");
  assert.equal(machineLampLabel({ state: "expired", validity_state: "expired", overdue: 1, cycle: "open" }), "בודק לא בתוקף");
  assert.equal(machineLampLabel({ state: "soon", validity_state: "ok", overdue: 0, cycle: "awaiting_clean" }),
    "נדרשת בדיקה חוזרת — ממתין לתסקיר נקי");
  assert.equal(machineLampLabel({ state: "ok", validity_state: "ok", overdue: 0, cycle: "clean" }), "בודק בתוקף");
  // בלי תוקף נפרד (נתון ישן) — לפי הצבע, לא ממציאים "בתוקף"
  assert.equal(machineLampLabel({ state: "expired", overdue: 1, cycle: "open" }), "בודק לא בתוקף");
});

test("שני מתקנים: A באיחור, B בתוקף — האתר 'בתוקף · עבר מועד תיקון', והגרוע הוא A עם הסיבה", () => {
  const c = overdue({
    machines: 2,
    machines_detail: [
      { key: "A", label: "צפון", valid_until: "2027-03-16", state: "soon", validity: "ok", cycle: "open", open: 2, overdue: 1 },
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
  assert.equal(worstSeverity(pmRed), 1, "המפקח ממיין לפי הבודק בלבד");
  assert.equal(worstSeverity(pmRed, ALL_AREAS), 4);
});

test("תחזוקה כבויה: הבודק עדיין קובע את הסימן", () => {
  const c = toCompliance(row({ inspection_state: "expired", inspection_validity_state: "expired",
    inspection_valid_until: "2026-10-01", inspection_days_left: -3, pm_state: "expired", pm_due_on: "2026-09-01", pm_days_left: -33 }));
  assert.deepEqual(markFor(c), { state: "expired", tab: "inspection", stale: false });
});
