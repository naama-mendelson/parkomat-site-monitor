// shared/site-types.mjs — סוגי המתקן באתר, בשתי רמות.
//
// ============================================================
// למה שתי רמות ולא רשימה שטוחה
// ============================================================
// הרשימה הראשונה כאן הייתה שטוחה — XY / דולי / מצבט. בפועל אלה **משפחות**,
// ולכל אחת דגמים: "מצבט X" ו-"מצבט Y" הם שני מתקנים שונים שמתנהגים אחרת,
// ושניהם מצבט.
//
// ⚠️ רשימה שטוחה הייתה מכריחה לבחור באיזו רמה לוותר. בחירה בדגם בלבד מונעת
// את השאלה "כמה מתקני XY יש לנו" (חמישה ערכים שונים, אף אחד לא נקרא XY);
// בחירה במשפחה בלבד מוחקת את ההבחנה שבגללה בכלל מפרידים.
//
// ============================================================
// המפתחות — ומה קורה כששם המשפחה זהה לשם הדגם
// ============================================================
// ⚠️ "דולי" ו-"XY" הם גם שם משפחה וגם שם דגם. אילו הסינון היה מקבל את שניהם
// באותו שדה, `plc_type = "xy"` היה עמום: הדגם XY, או כל המשפחה?
//
// לכן **המפתח שנשמר במסד הוא תמיד של דגם**, וסינון לפי משפחה נושא קידומת
// `group:`. שני מרחבי ערכים נפרדים, בלי מקרה גבול אחד.
//
// המפתח באנגלית כי הוא נוסע ב-URL של הסינון ומושווה בשאילתות; התווית עברית
// והיא היחידה שמותר לשנות בלי לגעת בנתונים.

export const SITE_TYPE_GROUPS = [
  {
    key: "doli",
    label: "דולי",
    types: [{ key: "doli", label: "דולי" }],
  },
  {
    key: "matzbet",
    label: "מצבט",
    types: [
      { key: "matzbet-x", label: "מצבט X" },
      { key: "matzbet-y", label: "מצבט Y" },
    ],
  },
  {
    key: "xy",
    label: "XY",
    types: [
      { key: "xy", label: "XY" },
      { key: "x", label: "X" },
      { key: "y", label: "Y" },
      { key: "shuttle-y", label: "שאטל Y" },
      { key: "shuttle-x", label: "שאטל X" },
    ],
  },
];

/** קידומת ערכי הסינון לפי משפחה. ראה ההסבר על העמימות למעלה. */
export const GROUP_PREFIX = "group:";

/** כל הדגמים, שטוח — לוולידציה ולתוויות. */
export const SITE_TYPES = SITE_TYPE_GROUPS.flatMap((g) => g.types);

export const SITE_TYPE_KEYS = SITE_TYPES.map((t) => t.key);

export const SITE_TYPE_LABELS = Object.fromEntries(
  SITE_TYPES.map((t) => [t.key, t.label]),
);

/** דגם → מפתח המשפחה שלו. */
const GROUP_OF = Object.fromEntries(
  SITE_TYPE_GROUPS.flatMap((g) => g.types.map((t) => [t.key, g.key])),
);

/** מפתחות המשפחות, לזיהוי ערכים היסטוריים. */
const GROUP_KEYS = new Set(SITE_TYPE_GROUPS.map((g) => g.key));

export function siteTypeGroup(key) {
  if (GROUP_OF[key]) return GROUP_OF[key];

  // ==========================================================
  // ערך היסטורי: מפתח משפחה ששמור כסוג של אתר
  // ==========================================================
  // ⚠️ לפני הפיצול לשתי רמות, "מצבט" היה **דגם** ונשמר ככזה על אתרים
  // אמיתיים. הפיצול הפך אותו לשם משפחה בלבד, ובלי השורה הזו אותם אתרים
  // היו מציגים "matzbet" באנגלית ולא נתפסים באף סינון — שקט שנראה כמו
  // באג בטעינה, על נתון שנשמר בכוונה.
  //
  // ⚠️ **ומכוון רק לקריאה.** isValidSiteType ממשיך לדחות את הערך, כך
  // שאי אפשר לשמור אותו מכאן והלאה. הוא נקרא, לא נכתב — וכשמישהו יערוך
  // את האתר ויבחר "מצבט X", הערך ההיסטורי ייעלם מעצמו.
  if (GROUP_KEYS.has(key)) return key;

  return null;
}

/**
 * התווית להצגה, כולל המקרה שאין סוג.
 *
 * ⚠️ **"לא הוגדר" ולא מחרוזת ריקה.** האתרים הקיימים נרשמו לפני שהשדה הזה
 * היה קיים, ולכולם אין סוג. שדה ריק על הכרטיס נראה כמו תקלה בטעינה;
 * "לא הוגדר" אומר את האמת — הנתון חסר, ואפשר להשלים אותו.
 */
export function siteTypeLabel(key) {
  if (!key) return "לא הוגדר";
  if (SITE_TYPE_LABELS[key]) return SITE_TYPE_LABELS[key];

  // ערך היסטורי שהוא מפתח משפחה — ראה siteTypeGroup. מציגים את שם המשפחה
  // בעברית במקום את המפתח באנגלית.
  const group = SITE_TYPE_GROUPS.find((g) => g.key === key);
  return group ? group.label : key;
}

/**
 * התווית המלאה, כולל המשפחה כשהיא מוסיפה מידע.
 *
 * ⚠️ "X" לבדו על כרטיס אינו אומר דבר — הוא נראה כמו קיצור או תקלת רינדור.
 * "XY · X" ממקם אותו. אבל "דולי · דולי" הוא רעש, ולכן המשפחה מושמטת כשהיא
 * זהה לדגם.
 */
export function siteTypeFullLabel(key) {
  if (!key) return "לא הוגדר";
  const label = siteTypeLabel(key);
  const group = SITE_TYPE_GROUPS.find((g) => g.key === siteTypeGroup(key));
  if (!group || group.label === label) return label;
  return `${group.label} · ${label}`;
}

/**
 * האם הערך תקין לשמירה.
 *
 * ⚠️ null/undefined/'' **תקינים** — הסוג אינו חובה. אילו היה חובה, אי אפשר
 * היה לרשום אתר בלי לדעת את סוגו, וזה בדיוק המצב בשטח כשמתקינים בערב.
 *
 * ⚠️ ומפתח משפחה **אינו** ערך תקין לשמירה: הוא ערך סינון בלבד. שמירתו
 * הייתה יוצרת אתר ששייך למשפחה בלי דגם, ואז "כמה מצבט X יש" מפספס אותו.
 */
export function isValidSiteType(value) {
  if (value === null || value === undefined || value === "") return true;
  return SITE_TYPE_KEYS.includes(value);
}

/**
 * האם אתר עם הסוג הזה תואם לערך הסינון.
 * הערך הוא מפתח דגם, `group:<משפחה>`, או '' (=הכל).
 */
export function matchesTypeValue(siteType, filterValue) {
  if (!filterValue) return true;
  if (filterValue.startsWith(GROUP_PREFIX)) {
    return siteTypeGroup(siteType) === filterValue.slice(GROUP_PREFIX.length);
  }
  return siteType === filterValue;
}
