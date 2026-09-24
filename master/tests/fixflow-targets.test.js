// ההכרעה של `check-fixflow-targets` — מה היא באמת תופסת.
//
// ============================================================
// ⚠️ למה הבדיקה הזאת קיימת
// ============================================================
// הגרסה הראשונה של הביקורת גזרה ציפייה מ-`PROFILE_BY_TYPE` בלבד, ולכן על
// `matzbet-x` — שיושב ב-`UNRESOLVED_TYPES` — היא החזירה "אין ציפייה" **וצבעה
// את האתר בירוק**. הירקון 224 הוא אתר לולק שקושר ידנית לספריית ביטנקם, והשער
// אמר עליו שהכול בסדר. שער שעובר על התקלה היחידה שהוא נבנה בשבילה גרוע משער
// שאינו קיים, כי הוא מייצר ביטחון.
//
// ⚠️ **ולכן כל טענה כאן נכתבה בכיוון שנכשל.** בדיקה שמאשרת רק שיוך נכון
// עוברת גם על פונקציה שמחזירה "תקין" תמיד.
import test from "node:test";
import assert from "node:assert/strict";
import { judge } from "../tools/check-fixflow-targets.js";
import { systemForType, SYSTEM_BY_TYPE } from "../../shared/fixflow-profiles.mjs";

const link = (system, profile) => ({ status: "ok", system, profile });

// ⚠️ עד 24/09/2026 `matzbet-x` היה בלתי-מוכרע ברמת הפרופיל, ושלוש הבדיקות
// כאן נשענו על זה. מאז הוא ממופה לספרייה הקומתית — ולכן יש לו ציפייה בשתי
// הרמות, והבדיקות מוודאות ששתיהן נבדקות **בנפרד**: סתירת יצרן היא הערה
// משלה, ואינה נבלעת בתוך סתירת הפרופיל.
test("סוג לולק שקושר לספריית ביטנקם — נופל ברמת היצרן", () => {
  const v = judge(link("ביטנקם", "ביטנקם xy"), "matzbet-x", { ok: false });
  assert.equal(v.sysV, "✗");
  assert.ok(v.notes.some((n) => /לולק/.test(n)), "הערת היצרן קיימת");
});

test("⚠️ סתירת יצרן נאמרת גם כשגם הפרופיל שגוי — שתי הערות, לא אחת", () => {
  const v = judge(link("ביטנקם", "ביטנקם xy"), "matzbet-x", { ok: false });
  assert.equal(v.profV, "✗");
  assert.equal(v.notes.length, 2);
});

test("מצבט X שקושר לספרייה הקומתית — עובר", () => {
  const v = judge(link("לולק", "שאטל מצבט x קומתי (מצבטון על המעלית)"), "matzbet-x", { ok: false });
  assert.equal(v.sysV, "✓");
  assert.equal(v.profV, "✓");
  assert.deepEqual(v.notes, []);
});

test("מצבט X שקושר לספריית מצבט אחרת של לולק — היצרן תקין, הפרופיל לא", () => {
  const v = judge(link("לולק", "שאטל מצבט שמסובבת במעלית"), "matzbet-x", { ok: false });
  assert.equal(v.sysV, "✓");
  assert.equal(v.profV, "✗");
});

// ⚠️ הדוגמאות כאן היו `doli`, ועברו ל-`matzbet-y`: מאז 17/09/2026 דולי אינו
// קובע יצרן — בכונן יש גם `דולי ביטנקם`. מצבט הוא עדיין לולק בלבד.
test("פרופיל שגוי בתוך היצרן הנכון — נופל ברמת הפרופיל", () => {
  const v = judge(link("לולק", "שאטל מסילה"), "matzbet-y", { ok: false });
  assert.equal(v.sysV, "✓", "היצרן תואם");
  assert.equal(v.profV, "✗", "והפרופיל לא");
  assert.equal(v.notes.length, 1);
});

test("⚠️ נוסח התקלות מפיל לבדו, גם כשאין סוג מוגדר", () => {
  // זה המקרה של אתר שנרשם בלי `plc_type` — 11 אתרים היום. בלי הראיה הזאת
  // הם כולם "אין ראיה", ושיוך שגוי בהם בלתי נראה לחלוטין.
  const v = judge(link("ביטנקם", "ביטנקם xy"), null, { ok: true, system: "לולק", score: 0.71 });
  assert.equal(v.ctrlV, "✗");
  assert.equal(v.notes.length, 1);
  assert.match(v.notes[0], /0\.71/, "הציון נאמר — דגל בלי מספר אינו ניתן לשיפוט");
});

test("בקר שמסרב להכריע אינו מאשר ואינו מפיל", () => {
  const v = judge(link("ביטנקם", "ביטנקם xy"), null, { ok: false, why: "לא מובהק" });
  assert.equal(v.ctrlV, "—");
  assert.deepEqual(v.notes, []);
});

test("⚠️ שלוש ראיות סותרות מדווחות כשלוש, ולא כאחת", () => {
  // איחוד לשורה אחת היה מסתיר שתי סיבות עצמאיות — ומי שמתקן את הראשונה
  // היה מניח שהשאר נפתר.
  const v = judge(link("ביטנקם", "ביטנקם xy"), "matzbet-y", { ok: true, system: "לולק", score: 0.8 });
  assert.equal(v.notes.length, 3);
});

test("⚠️ `xy` אינו קובע יצרן — ולכן אינו מפיל אף צד", () => {
  // הוא קיים בשתי המערכות. אילו נכלל במפה, אחת משתי הספריות הלגיטימיות
  // הייתה מסומנת כסתירה בכל האתרים שלה.
  assert.equal(systemForType("xy"), null);
  assert.deepEqual(judge(link("ביטנקם", "ביטנקם xy"), "xy", { ok: false }).notes, []);
  assert.deepEqual(judge(link("לולק", "xy לולק"), "xy", { ok: false }).notes, []);
});

test("סוג לא מוכר אינו מייצר סתירה מדומה", () => {
  assert.equal(systemForType("no-such-type"), null);
  assert.deepEqual(judge(link("לולק", "שאטל דולי"), "no-such-type", { ok: false }).notes, []);
});

test("⚠️ כל ערך ב-SYSTEM_BY_TYPE הוא אחד משני היצרנים הקיימים", () => {
  // שגיאת כתיב ביצרן הייתה הופכת כל אתר מהסוג הזה ל"סתירה" — כלומר שער
  // אדום על נתונים תקינים, שהוא הדרך המהירה ביותר לגרום למישהו להתעלם ממנו.
  for (const [type, system] of Object.entries(SYSTEM_BY_TYPE))
    assert.ok(["לולק", "ביטנקם"].includes(system), `${type} → ${system}`);
});
