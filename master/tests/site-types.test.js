// tests/site-types.test.js — סוגי המתקן, בשתי רמות.
//
// ============================================================
// למה זה נבדק
// ============================================================
// `plc_type` היה שדה טקסט חופשי. שדה חופשי נראה גמיש והוא ההפך: "XY", "xy"
// ו-"X.Y" הם שלושה סוגים שונים מבחינת כל סינון וכל קיבוץ, ואי אפשר לגלות
// את זה מהמסך — הכל נראה תקין עד שמסננים ומקבלים אתר אחד במקום ארבעה.
//
// ⚠️ **והמלכודת המרכזית כאן היא שמות שחוזרים בשתי הרמות:** "דולי" ו-"XY"
// הם גם שם משפחה וגם שם דגם. זו הנקודה היחידה שבה הפרדה לשתי רמות יכולה
// להישבר בשקט, ולכן רוב הבדיקות כאן עליה.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SITE_TYPE_GROUPS, SITE_TYPES, SITE_TYPE_KEYS, GROUP_PREFIX,
  isValidSiteType, siteTypeLabel, siteTypeFullLabel, siteTypeGroup, matchesTypeValue,
} = require("../../shared/site-types.mjs");

test("שלוש משפחות, עם הדגמים שהוגדרו", () => {
  assert.deepEqual(SITE_TYPE_GROUPS.map((g) => g.label), ["דולי", "מצבט", "XY"]);
  assert.deepEqual(
    SITE_TYPE_GROUPS.map((g) => g.types.map((t) => t.label)),
    [["דולי"], ["מצבט X", "מצבט Y"], ["XY", "X", "Y", "שאטל Y", "שאטל X"]],
  );
  assert.equal(SITE_TYPES.length, 8);
});

test("⚠️ אין מפתח דגם כפול בין המשפחות", () => {
  // שני דגמים באותו מפתח היו נשמרים באותו ערך ומסתננים יחד — אחד מהם
  // פשוט מפסיק להתקיים, ואין שום סימן לכך על המסך.
  assert.equal(new Set(SITE_TYPE_KEYS).size, SITE_TYPE_KEYS.length);
});

test("כל דגם משויך למשפחה שלו", () => {
  assert.equal(siteTypeGroup("doli"), "doli");
  assert.equal(siteTypeGroup("matzbet-x"), "matzbet");
  assert.equal(siteTypeGroup("shuttle-y"), "xy");
  assert.equal(siteTypeGroup("x"), "xy");
  assert.equal(siteTypeGroup("nope"), null);
});

// ============================================================
// ולידציה
// ============================================================

test("⚠️ סוג חסר הוא תקין — הוא אינו שדה חובה", () => {
  // אפשר לרשום אתר בלי לדעת את סוגו, וזה המצב בשטח כשמתקינים בערב.
  for (const empty of [null, undefined, ""]) {
    assert.equal(isValidSiteType(empty), true, JSON.stringify(empty));
  }
});

test("⚠️ מפתח משפחה אינו ערך תקין לשמירה", () => {
  // הוא ערך **סינון** בלבד. שמירתו הייתה יוצרת אתר ששייך למשפחה בלי דגם,
  // ואז "כמה מצבט X יש לנו" מפספס אותו — בלי ששום דבר ייראה שבור.
  assert.equal(isValidSiteType("group:xy"), false);
  assert.equal(isValidSiteType("matzbet"), false, "'מצבט' הוא משפחה, לא דגם");
});

test("ערך שאינו ברשימה נדחה", () => {
  // ⚠️ כולל וריאציות אותיות. "XY" באותיות גדולות הוא **התווית**, לא המפתח.
  for (const bad of ["XY", "Doli", "מצבט", "unknown", "xy "]) {
    assert.equal(isValidSiteType(bad), false, bad);
  }
});

test("סוגים שאינם מחרוזת נדחים", () => {
  // ⚠️ 0 ו-false כלולים בכוונה: הם falsy, ולכן `if (!value) return true`
  // היה מקבל אותם כ"אין סוג". מוטציה כזו שרדה את הבדיקה הזו עד שנוספו כאן.
  for (const bad of [1, 0, true, false, {}, []]) {
    assert.equal(isValidSiteType(bad), false, JSON.stringify(bad));
  }
});

// ============================================================
// תוויות
// ============================================================

test("⚠️ אתר בלי סוג מוצג כ'לא הוגדר', לא כשדה ריק", () => {
  // האתרים הקיימים נרשמו לפני שהשדה נוסף. שדה ריק על הכרטיס נראה כמו תקלה
  // בטעינה; "לא הוגדר" אומר את האמת ומזמין להשלים.
  for (const empty of [null, "", undefined]) {
    assert.equal(siteTypeLabel(empty), "לא הוגדר");
    assert.equal(siteTypeFullLabel(empty), "לא הוגדר");
  }
});

test("⚠️ התווית המלאה ממקמת דגם עמום, ואינה חוזרת על עצמה", () => {
  // "X" לבדו על כרטיס נראה כמו קיצור או תקלת רינדור; "XY · X" ממקם אותו.
  assert.equal(siteTypeFullLabel("x"), "XY · X");
  assert.equal(siteTypeFullLabel("shuttle-y"), "XY · שאטל Y");
  assert.equal(siteTypeFullLabel("matzbet-x"), "מצבט · מצבט X");

  // אבל "דולי · דולי" הוא רעש — המשפחה מושמטת כשהיא זהה לדגם.
  assert.equal(siteTypeFullLabel("doli"), "דולי");
  assert.equal(siteTypeFullLabel("xy"), "XY");
});

test("מפתח לא מוכר מוצג כמות שהוא ולא נבלע", () => {
  // ⚠️ ערך שהגיע מהמסד ואינו ברשימה (דגם שהוסר, או כתיבה ידנית) חייב
  // להיראות. החזרת "לא הוגדר" עליו הייתה מסתירה נתון קיים ושגוי.
  assert.equal(siteTypeLabel("legacy-model"), "legacy-model");
  assert.equal(siteTypeFullLabel("legacy-model"), "legacy-model");
});

// ============================================================
// סינון — הרמה שבה השמות הכפולים מסוכנים
// ============================================================

test("סינון ריק מחזיר הכל", () => {
  for (const t of [...SITE_TYPE_KEYS, null, ""]) {
    assert.equal(matchesTypeValue(t, ""), true);
  }
});

test("סינון לפי דגם תופס אותו בלבד", () => {
  assert.equal(matchesTypeValue("shuttle-x", "shuttle-x"), true);
  assert.equal(matchesTypeValue("shuttle-y", "shuttle-x"), false);
  assert.equal(matchesTypeValue("x", "shuttle-x"), false);
});

test("⚠️ סינון לפי משפחה תופס את כל דגמיה", () => {
  const all = ["xy", "x", "y", "shuttle-y", "shuttle-x"];
  for (const t of all) {
    assert.equal(matchesTypeValue(t, GROUP_PREFIX + "xy"), true, t);
  }
  assert.equal(matchesTypeValue("matzbet-x", GROUP_PREFIX + "xy"), false);
  assert.equal(matchesTypeValue("doli", GROUP_PREFIX + "xy"), false);
});

test("⚠️ 'XY' המשפחה ו-'XY' הדגם אינם אותו סינון", () => {
  // זו המלכודת המרכזית של המבנה הדו-שכבתי. בלי הקידומת שני הערכים היו
  // נכתבים "xy", ואז סינון לדגם XY היה מחזיר גם X, Y ושני השאטלים —
  // תוצאה שנראית סבירה לגמרי ולכן לא הייתה נתפסת.
  assert.equal(matchesTypeValue("x", "xy"), false, "הדגם XY אינו כולל את X");
  assert.equal(matchesTypeValue("x", GROUP_PREFIX + "xy"), true, "המשפחה XY כן");

  // ואותו דבר ל'דולי', שם המשפחה והדגם חופפים לגמרי.
  assert.equal(matchesTypeValue("doli", "doli"), true);
  assert.equal(matchesTypeValue("doli", GROUP_PREFIX + "doli"), true);
});

test("אתר בלי סוג אינו נתפס באף סינון סוג", () => {
  // ⚠️ הוא נתפס רק ב"לא הוגדר", שמטופל בנפרד ואינו סוג — ראה
  // matchesSiteFilters. אילו ריק היה נופל לתוך משפחה כלשהי, 13 האתרים
  // חסרי הסוג היו מופיעים בכל סינון.
  assert.equal(matchesTypeValue(null, "doli"), false);
  assert.equal(matchesTypeValue(null, GROUP_PREFIX + "xy"), false);
});

// ============================================================
// עריכה: '' פירושו "נקה", ו-undefined פירושו "אל תיגע"
// ============================================================
// ⚠️ זו ההבחנה שכל טופס העריכה תלוי בה, והיא היחידה שאי אפשר לראות מהמסך:
// אם היא נשברת, המשתמשת בוחרת "לא הוגדר", לוחצת שמור, **מקבלת אישור** —
// והערך הישן נשאר. כשל שקט מושלם.
test("⚠️ שדה ריק בעריכה מנקה, שדה חסר לא נוגע", () => {
  // מדמה את השורה ב-updateSite: תנאי `!== undefined`, וערך `|| null`.
  const build = (patch) => {
    const fields = [], params = [];
    for (const [col, val] of Object.entries(patch)) {
      if (val !== undefined) { fields.push(`${col} = ?`); params.push(val || null); }
    }
    return { fields, params };
  };

  const cleared = build({ plc_type: "" });
  assert.deepEqual(cleared.fields, ["plc_type = ?"]);
  assert.deepEqual(cleared.params, [null], "ריק נשמר כ-NULL, לא כמחרוזת ריקה");

  const untouched = build({ plc_type: undefined });
  assert.deepEqual(untouched.fields, [], "שדה חסר אינו נוגע בערך הקיים");

  // ⚠️ המלכודת שהכלל הזה נמנע ממנה: בדיקת truthy הייתה מתנהגת בשני
  // המקרים אותו דבר — ואז אין שום דרך לנקות שדה.
  assert.equal(["", undefined, null].every((v) => !v), true,
    "שלושתם falsy — ולכן truthy אינו מבחין");
});

// ============================================================
// ערך היסטורי: מפתח משפחה ששמור כסוג של אתר
// ============================================================
// ⚠️ לפני הפיצול לשתי רמות, "מצבט" היה **דגם** ונשמר ככזה על שלושה אתרים
// אמיתיים. הפיצול הפך אותו לשם משפחה — כלומר הנתון הקיים הפך ברגע אחד
// לערך שהמערכת אינה מכירה.
//
// זו בדיוק המחלקה של תקלות שלא רואים: הנתון שמור, כלום לא נכשל, והכרטיס
// פשוט מציג "matzbet" באנגלית ולא נתפס באף סינון.
test("⚠️ מפתח משפחה שנשמר כסוג — נקרא, מוצג בעברית, ומסתנן נכון", () => {
  assert.equal(siteTypeGroup("matzbet"), "matzbet", "משתייך למשפחתו");
  assert.equal(siteTypeLabel("matzbet"), "מצבט", "ולא 'matzbet' באנגלית");
  assert.equal(siteTypeFullLabel("matzbet"), "מצבט", "בלי כפילות 'מצבט · מצבט'");

  // נתפס בסינון המשפחה, יחד עם הדגמים שכן הוגדרו.
  assert.equal(matchesTypeValue("matzbet", GROUP_PREFIX + "matzbet"), true);
  assert.equal(matchesTypeValue("matzbet", "matzbet-x"), false, "אינו דגם מסוים");
});

test("⚠️ אבל אי אפשר לשמור אותו מכאן והלאה", () => {
  // הקריאה סלחנית בכוונה, הכתיבה לא: אחרת הערך ההיסטורי היה מתרבה
  // במקום להיעלם. הוא ייעלם כשמישהו יערוך את האתר ויבחר דגם.
  assert.equal(isValidSiteType("matzbet"), false);
  assert.equal(isValidSiteType("xy"), true, "'xy' הוא גם דגם תקין — ולכן מותר");
});
