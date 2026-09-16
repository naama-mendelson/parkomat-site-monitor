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
import { resolveProfile, PROFILE_BY_TYPE, UNRESOLVED_TYPES, resolveLink } from "../../shared/fixflow-profiles.mjs";
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

// ============================================================
// הבחירה שנשמרה על האתר — ולמה היא גוברת על הכול
// ============================================================
// ⚠️ שלוש שיטות גזירה נוסו ונמדדו, וכולן נכשלו או סירבו. והחמור: גזירה אינה
// יכולה לעבוד בעיקרון — FixFlow מתייקת 5 אתרים ל-`שאטל מצבט x` שיש בו 0
// מסמכים בזמן ש-25 המסמכים יושבים ב-`שאטל מצבט שמסובבת במעלית` שיש בו אתר
// אחד. סבך במקור אינו ניתן להתרה; רק להכרעה.
const MAP = {
  profiles: {
    "לולק|xy לולק": { system: "לולק", profile: "xy לולק", docs: 67 },
    "לולק|שאטל מצבט שמסובבת במעלית": { system: "לולק", profile: "שאטל מצבט שמסובבת במעלית", docs: 25 },
  },
  sites: {
    1284: { by: "name", siteId: "abc", siteName: "עמנואל הרומי 10", system: "לולק", profile: "xy לולק", docs: 67 },
  },
};

test("בחירה שנשמרה גוברת על התאמת שם", () => {
  const r = resolveLink(
    { code: "1284", plc_type: "xy", fixflow_profile: "לולק|שאטל מצבט שמסובבת במעלית" }, MAP);
  assert.equal(r.status, "ok");
  assert.equal(r.by, "chosen");
  assert.equal(r.profile, "שאטל מצבט שמסובבת במעלית");
  assert.equal(r.docs, 25);
});

test("בחירה שנשמרה גוברת על גזירה מסוג המכונה", () => {
  const r = resolveLink({ code: "9999", plc_type: "doli", fixflow_profile: "לולק|xy לולק" }, MAP);
  assert.equal(r.by, "chosen");
  assert.equal(r.profile, "xy לולק");
});

// ⚠️ **הבדיקה החשובה כאן.** ערך פגום שנופל בשקט לגזירה מייצר כפתור שעובד
// ומוביל למקום אחר ממה שנבחר — כלומר מוקדן שנשלח לספרייה של מכונה אחרת,
// ואף הודעה בשום מסך. חייב להיות סירוב מפורש.
test("בחירה פגומה נדחית במפורש, ואינה נופלת בשקט לגזירה", () => {
  for (const bad of ["לולק", "|xy לולק", "לולק|", "   |   "]) {
    const r = resolveLink({ code: "1284", plc_type: "doli", fixflow_profile: bad }, MAP);
    assert.equal(r.status, "bad-choice", `"${bad}" היה אמור להידחות`);
  }
});

// ⚠️ ריק הוא ערך אמיתי: הוא **מנקה** בחירה ומחזיר לגזירה. בלעדיו אי אפשר
// לבטל בחירה שנעשתה בטעות, וזה מצב שאין ממנו יציאה מהמסך.
test("ריק מחזיר לגזירה הרגילה, ואינו נחשב בחירה", () => {
  for (const empty of ["", "   ", null, undefined]) {
    const r = resolveLink({ code: "1284", plc_type: "xy", fixflow_profile: empty }, MAP);
    assert.equal(r.by, "name", `"${empty}" לא היה אמור להיחשב בחירה`);
    assert.equal(r.profile, "xy לולק");
  }
});

// ⚠️ ספרייה שנבחרה ואינה ברשימה עדיין מוחזרת כ-ok עם docs=undefined, ולא
// כשגיאה: הרשימה היא תמונת מצב שנוצרה בפקודה, ופרופיל שנוסף ב-FixFlow אחריה
// אינו "לא קיים" — הוא חדש. המסך מציג אזהרה; הקישור אינו נחסם.
test("ספרייה שאינה ברשימה — קישור תקף בלי מספר מסמכים", () => {
  const r = resolveLink({ code: "1", fixflow_profile: "לולק|חדשה לגמרי" }, MAP);
  assert.equal(r.status, "ok");
  assert.equal(r.docs, undefined);
});

// ============================================================
// קישור ברמת האתר — ולמה הוא רמה נפרדת ולא "ספרייה יפה יותר"
// ============================================================
// ⚠️ קישור לאתר מביא את תקלות סוג המכונה **בתוספת חריגות האתר**. 22 חריגות
// קיימות, ו-15 מהן בגרוזנברג 7 — אתר שלנו. הגרסה הראשונה של הבורר הציעה
// ספריות בלבד, ובחירה ידנית שם הייתה מוחקת 15 חריגות בלי סימן על המסך.
const MAP2 = {
  ffSites: {
    abc123: { name: "גרוזנברג 7 ת\"א", system: "ביטנקם", profile: "ביטנקם xy", docs: 37, overrides: 15 },
  },
  profiles: { "ביטנקם|ביטנקם xy": { system: "ביטנקם", profile: "ביטנקם xy", docs: 37 } },
  sites: {
    2222: { by: "name", siteId: "abc123", siteName: "גרוזנברג 7 ת\"א", system: "ביטנקם", profile: "ביטנקם xy", docs: 37 },
  },
};

test("בחירת אתר מחזירה קישור ברמת האתר, עם מספר החריגות", () => {
  const r = resolveLink({ code: "2222", fixflow_profile: "site:abc123" }, MAP2);
  assert.equal(r.status, "ok");
  assert.equal(r.by, "chosen-site");
  assert.equal(r.siteId, "abc123");
  assert.equal(r.overrides, 15);
  assert.equal(r.scope, "גרוזנברג 7 ת\"א");
});

// ⚠️ ההבחנה שקובעת איזה נתיב ייבנה. `by` אחיד לשתי הרמות היה שולח בחירת
// אתר לנתיב הספרייה — כלומר מוחק את החריגות בדיוק כשביקשו אותן במפורש.
test("בחירת ספרייה אינה מתחזה לקישור ברמת אתר", () => {
  const r = resolveLink({ code: "2222", fixflow_profile: "ביטנקם|ביטנקם xy" }, MAP2);
  assert.equal(r.by, "chosen");
  assert.equal(r.siteId, undefined);
  assert.equal(r.overrides, undefined);
});

test("site: בלי מזהה נדחה במפורש", () => {
  for (const bad of ["site:", "site:   "]) {
    const r = resolveLink({ code: "2222", fixflow_profile: bad }, MAP2);
    assert.equal(r.status, "bad-choice", `"${bad}" היה אמור להידחות`);
  }
});

// ⚠️ מזהה שאינו במפה עדיין מייצר קישור תקף: המפה היא תמונת מצב, ואתר שנוסף
// ב-FixFlow אחריה אינו "לא קיים". ⚠️ ו-`scope` נופל למזהה ולא לריק —
// כותרת ריקה על הכפתור נראית כמו באג ולא כמו מידע חסר.
test("אתר שאינו במפה — קישור תקף, וכותרת שאינה ריקה", () => {
  const r = resolveLink({ code: "9", fixflow_profile: "site:zzz" }, MAP2);
  assert.equal(r.status, "ok");
  assert.equal(r.siteId, "zzz");
  assert.equal(r.scope, "zzz");
  assert.equal(r.docs, undefined);
});
