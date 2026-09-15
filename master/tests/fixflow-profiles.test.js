// tests/fixflow-profiles.test.js — מסוג המכונה אל ספריית התקלות ב-FixFlow.
//
// ============================================================
// ⚠️ למה דווקא כאן שקט הוא יקר
// ============================================================
// כשל במיפוי הזה אינו מייצר שגיאה. הוא מייצר **רשימת תקלות ריקה**, שנראית
// למוקדן בדיוק כמו "אין תקלות ידועות לאתר הזה" — באמצע אירוע, מול לקוח.
// זה נמדד בשטח: סוקולוב 10 וז'בוטינסקי 6 משויכים ב-FixFlow לפרופיל בשם
// `שאטל מצבט x` שאין לו תיקייה בכונן כלל, ולכן 0 מסמכים, בלי שום סימן.
//
// לכן הבדיקות כאן מתעקשות על ההבחנה בין ארבעה מצבים שכולם "אין תשובה":
// אין סוג · חסרה המערכת · הסוג לא הוכרע · הסוג מופה. מיזוג שניים מהם לאחד
// הוא בדיוק איך שהמידע נעלם.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProfile, PROFILE_BY_TYPE, UNRESOLVED_TYPES } from "../../shared/fixflow-profiles.mjs";
import { SITE_TYPE_KEYS } from "../../shared/site-types.mjs";

test("דולי מגיע לשאטל דולי", () => {
  const r = resolveProfile("doli");
  assert.equal(r.status, "ok");
  assert.equal(r.system, "לולק");
  assert.equal(r.profile, "שאטל דולי");
});

test("מצבט Y מגיע לספרייה שיש בה תוכן, ולא לשארית הריקה", () => {
  const r = resolveProfile("matzbet-y");
  assert.equal(r.status, "ok");
  // ⚠️ `שאטל מצבט y` הוא שארית זריעה בלי תיקייה בכונן — 0 מסמכים, לנצח.
  // גולדברג 5 משויך אליו ב-FixFlow, וזו תקלה בשיוך ולא מיפוי חלופי.
  assert.notEqual(r.profile, "שאטל מצבט y");
  assert.equal(r.profile, "שאטל מצבט y שמסובבת בשאטל");
});

// ⚠️ הליבה. גרוזנברג 7 הוא ביטנקם ומגדל 1 הוא לולק — שניהם `xy`. בכונן יש
// אפילו `חולדה 1` תחת ביטנקם לצד `חולדה 4` תחת לולק. ניחוש כאן שולח מוקדן
// לספריית התקלות של היצרן השני, וכל הצעדים שם נכונים למכונה אחרת.
test("xy בלי מערכת אינו נפתר, ואינו בוחר צד", () => {
  const r = resolveProfile("xy");
  assert.equal(r.status, "needs-system");
  assert.equal(r.profile, undefined);
});

test("xy עם מערכת נפתר לשתי הספריות הנכונות", () => {
  assert.deepEqual(resolveProfile("xy", "לולק"), { status: "ok", system: "לולק", profile: "xy לולק" });
  assert.deepEqual(resolveProfile("xy", "ביטנקם"), { status: "ok", system: "ביטנקם", profile: "ביטנקם xy" });
});

test("מערכת שאינה מוכרת אינה נופלת לברירת מחדל", () => {
  assert.equal(resolveProfile("xy", "לולק ביטנקם").status, "unmapped");
});

test("אין סוג — מצב נפרד, לא 'לא מופה'", () => {
  for (const v of [null, undefined, ""]) assert.equal(resolveProfile(v).status, "no-type");
});

test("סוג שטרם הוכרע מחזיר סיבה, ולא שתיקה", () => {
  const r = resolveProfile("shuttle-y");
  assert.equal(r.status, "unmapped");
  assert.match(r.reason, /לא הוכרע/);
  assert.equal(r.profile, undefined);
});

// ⚠️ המיפוי הזה נקבע **בספירה ולא בדמיון שמות**: ב-FixFlow יש בדיוק שני אתרי
// "נמל", אצלנו בדיוק שני קודים באותו אתר פיזי (1376 ו-3501), והזיווג של 3501
// ל-`שאטל דולי` מאומת עצמאית — ולכן השני נכפה. הדמיון בין "נמל מסילות"
// ל-"שאטל מסילה" תומך בתוצאה ולא מבסס אותה; דמיון שמות הוא בדיוק מה שנפסל.
test("שאטל X מגיע לשאטל מסילה", () => {
  const r = resolveProfile("shuttle-x");
  assert.equal(r.status, "ok");
  assert.equal(r.system, "לולק");
  assert.equal(r.profile, "שאטל מסילה");
});

// ⚠️ השער שתופס את התוספת הבאה. מי שיוסיף דגם ל-site-types.mjs ולא ימפה אותו
// כאן ייצור אתרים שמציגים רשימה ריקה — וזו הבדיקה היחידה שתראה זאת, מפני
// שבשטח זה נראה כמו אתר בלי תקלות.
test("כל דגם קיים או מופה, או רשום במפורש כלא-מוכרע", () => {
  const unaccounted = SITE_TYPE_KEYS.filter((k) => !PROFILE_BY_TYPE[k] && !UNRESOLVED_TYPES[k]);
  assert.deepEqual(
    unaccounted,
    [],
    `דגמים שאינם מופים ואינם רשומים כלא-מוכרעים: ${unaccounted.join(", ")} — ` +
      `הוסף אותם ל-PROFILE_BY_TYPE או ל-UNRESOLVED_TYPES ב-shared/fixflow-profiles.mjs`
  );
});

test("סוג מומצא אינו מתחזה ללא-מוכרע", () => {
  const r = resolveProfile("banana");
  assert.equal(r.status, "unmapped");
  assert.match(r.reason, /לא מוכר/);
});
