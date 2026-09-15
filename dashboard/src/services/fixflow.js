// שירות FixFlow — הכל כאן, כדי שאפשר יהיה להעיף את הכל.
//
// ============================================================
// ⚠️ זהו פיילוט, וההסרה היא דרישת תכנון ולא הערה בסוף
// ============================================================
// הבקשה הייתה מפורשת: "ואם לא אהיה מרוצה תעיף את כל ה-FixFlow מהאתר". לכן:
//
//   כיבוי מיידי   — `VITE_FIXFLOW_ENABLED=false` ב-.env, בנייה, וזהו.
//   הסרה מלאה     — מחיקת `services/fixflow.js`, מחיקת `components/FixFlowLink/`
//                   (ובתוכה גם המפה), ומחיקת שתי שורות ב-SiteCard.
//
// ⚠️ ולכן **אין טבלה, אין עמודה ואין מיגרציה**. הפיתוי היה לשמור ב-Supabase
// מיפוי של אתר → תקלות. זה היה עובד, והיה מותיר טבלה שצריך להחליט מה לעשות
// איתה ביום שבו הפיילוט נגמר — כלומר הופך "להעיף" לפרויקט.
//
// ============================================================
// איך אתר מגיע לספריית התקלות שלו — שתי דרכים, בסדר הזה
// ============================================================
// **1. לפי שם האתר.** זו הדרך הטובה, כי היא נותנת קישור ברמת האתר ולכן מביאה
// את **חריגות האתר** (22 קיימות) — דרך טיפול שנכתבה במיוחד לאתר אחד.
//
// ⚠️ וזו התאמת **שוויון מחרוזות אחרי נרמול**, לא ציון דמיון. ההבדל מדוד:
// התאמה לפי ציון נתנה 0.67 גם ל-`ז'בוטניסקי 6 → ז'בוטינסקי 6` (נכון) וגם
// ל-`ברנדיס 38 → הירקון 38` (שגוי לגמרי) — מספר רחוב ו"ת\"א" מספיקים כדי
// להרים אותה. שוויון מחרוזות אינו סובל מזה: 117 שמות ב-FixFlow נורמלו
// ל-117 שמות ייחודיים, אפס התנגשויות.
//
// **2. לפי סוג המכונה**, כשאין התאמת שם — או כשהשם הוביל לספרייה ריקה.
// ⚠️ המקרה השני אמיתי: גולדברג 5 מתאים בשם לאתר שמשויך ב-FixFlow לפרופיל
// `שאטל מצבט y`, שאין לו תיקייה בכונן ולכן 0 מסמכים לנצח — בזמן
// ש-`שאטל מצבט y שמסובבת בשאטל` מחזיק 38. התאמה מושלמת לרשימה ריקה, שנראית
// למוקדן בדיוק כמו "אין תקלות ידועות".
//
// המפה נבנית מראש ב-`master/tools/build-fixflow-map.js`, כי דף https אינו
// יכול לעשות fetch לשרת http ברשת המשרד — הדפדפן חוסם, והדשבורד אינו יכול
// לשאול את FixFlow דבר.
import MAP from "../components/FixFlowLink/fixflow-sites.json";
import { resolveProfile } from "../../../shared/fixflow-profiles.mjs";

/** האם הפיילוט פעיל. ברירת המחדל כבויה — תכונה ניסיונית אינה נדלקת מעצמה. */
export const FIXFLOW_ENABLED = String(import.meta.env.VITE_FIXFLOW_ENABLED ?? "") === "true";

/**
 * כתובת הבסיס של FixFlow.
 *
 * ⚠️ FixFlow רצה על מחשב במשרד, והדשבורד מוגש מ-Cloudflare באינטרנט. הקישור
 * לכן עובד **רק ברשת המשרד**.
 */
export const FIXFLOW_BASE_URL = String(import.meta.env.VITE_FIXFLOW_BASE_URL ?? "").replace(/\/+$/, "");

/**
 * הקישור לספריית התקלות של אתר.
 *
 * ⚠️ מחזיר `status !== 'ok'` במקום לנחש. אתר בלי סוג, סוג שטרם מופה
 * (`shuttle-x`), או `xy` שלא ידוע אם הוא לולק או ביטנקם — כולם מקבלים כאן
 * סירוב עם סיבה. כפתור שפותח את ספריית המכונה הלא נכונה גרוע מכפתור שאינו
 * קיים: שניהם לא עוזרים, אבל הראשון מטעה, וכל הצעדים שם נראים סבירים.
 *
 * @param {{code?: string|number, plc_type?: string|null}} site
 * @param {string|null} faultText  טקסט התקלה מהבקר, לסינון מקדים ברשימה
 */
export function fixflowLinkFor(site, faultText = null) {
  if (!FIXFLOW_ENABLED || !FIXFLOW_BASE_URL || !site) return null;

  const q = faultText ? `?q=${encodeURIComponent(faultText)}` : "";
  const entry = MAP?.sites?.[String(site.code)];

  if (entry?.by === "name") {
    return {
      status: "ok",
      by: "name",
      scope: entry.siteName,
      profile: entry.profile,
      system: entry.system,
      docs: entry.docs,
      url: `${FIXFLOW_BASE_URL}/#/site/${encodeURIComponent(entry.siteId)}${q}`,
    };
  }

  // ⚠️ ליפול חזרה ל-`resolveProfile` ולא להסתמך רק על המפה: המפה היא תמונת מצב
  // שנוצרה בפקודה, ואתר שנרשם אחריה אינו בה. סוג מכונה שכבר הוגדר לו יביא אותו
  // לספרייה הנכונה בלי שאיש יריץ שום דבר מחדש.
  const type = entry?.by === "type" ? { status: "ok", system: entry.system, profile: entry.profile } : resolveProfile(site.plc_type ?? null, null);
  if (type.status !== "ok") return { status: type.status, reason: type.reason, url: null };

  return {
    status: "ok",
    by: "type",
    scope: type.profile,
    profile: type.profile,
    system: type.system,
    docs: entry?.docs,
    url:
      `${FIXFLOW_BASE_URL}/#/profile/${encodeURIComponent(type.system)}/${encodeURIComponent(type.profile)}` + q,
  };
}
