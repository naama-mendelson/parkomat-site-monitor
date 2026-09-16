// שירות FixFlow — הכל כאן, כדי שאפשר יהיה להעיף את הכל.
//
// ============================================================
// ⚠️ זהו פיילוט, וההסרה היא דרישת תכנון ולא הערה בסוף
// ============================================================
// הבקשה הייתה מפורשת: "ואם לא אהיה מרוצה תעיף את כל ה-FixFlow מהאתר". לכן:
//
//   כיבוי מיידי   — `VITE_FIXFLOW_ENABLED=false` ב-.env, בנייה, וזהו.
//   הסרה מלאה     — מחיקת `services/fixflow.js`, מחיקת `components/FixFlowLink/`
//                   (ובתוכה גם המפה, הבורר, חלון השיוך והתאמת התקלות),
//                   ומחיקת שתי שורות בכל אחד משלושה קבצים: `SiteCard`,
//                   `AdminPanel`, `AddSiteModal` — ה-import ואלמנט ה-JSX,
//                   שניהם מסומנים בהערה. (ב-SiteCard יש שתי שורות JSX:
//                   `FixFlowSolution` ו-`FixFlowLink`.)
//
// ⚠️ **ויש היום גם עמודה אחת במסד** — `sites.fixflow_profile`. הכלל המקורי
// אמר "אין טבלה ואין עמודה", והוא נשבר במודע אחרי שנמדד ששיוך אינו ניתן
// לגזירה בעיקרון (ראה `resolveLink` ב-shared). ההסרה נשארת שורה אחת:
//
//     ALTER TABLE sites DROP COLUMN fixflow_profile;
//
// ובנוסף: `app.check_fixflow_profile`, והפרמטר `p_fixflow_profile`
// ב-`register_site` / `update_site` — שלושתם ב-`db/writes.postgres.sql`.
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
import { resolveLink } from "../../../shared/fixflow-profiles.mjs";

/**
 * האם הפיילוט פעיל.
 *
 * ============================================================
 * ⚠️ ברירת המחדל התהפכה לדלוקה, ולא משינוי דעה
 * ============================================================
 * הכיבוי בברירת מחדל נכתב כדי שתכונה ניסיונית לא תידלק מעצמה.
 * בפועל הוא עשה דבר אחר לגמרי: המשתנה נצרב בזמן הבנייה, וב-
 * Cloudflare Pages הוא מעולם לא הוגדר — ולכן הפיילוט היה **בלתי נראה
 * לחלוטין בדשבורד שפותחים באמת**. לא כפתור שבור, לא הודעה — פשוט
 * שום דבר, ואין מסך שעליו ההעדר הזה נראה.
 *
 * ⚠️ **והמתג לא נעלם — רק הכיוון שלו התהפך.** `VITE_FIXFLOW_ENABLED=false`
 * מכבה הכול כשהיה כמו קודם. מה שהשתנה הוא שכיבוי דורש עכשיו
 * אמירה מפורשת, במקום לקרות משכחה.
 */
export const FIXFLOW_ENABLED = String(import.meta.env.VITE_FIXFLOW_ENABLED ?? "true") !== "false";

/**
 * כתובת הבסיס של FixFlow.
 *
 * ⚠️ FixFlow רצה על מחשב במשרד, והדשבורד מוגש מ-Cloudflare באינטרנט. הקישור
 * לכן עובד **רק ברשת המשרד**.
 */
// ============================================================
// ⚠️ כתובת יחסית — אותו origin, ולכן אותה התחברות
// ============================================================
// עד כאן הערך היה `http://192.168.1.93:3001` — המחשב הנייד. נמדד:
// השרת ענה שם ב-17ms, ומכל מכשיר אחר הדפדפן המתין עד שוותר, כי
// כללי חומת האש מתירים ל-`node.exe` לקבל חיבורים בפרופיל `Public`
// בזמן שה-Wi-Fi הוא `Private`. מחוץ למשרד זה לא יכול לעבוד בעיקרון.
//
// עכשיו המסך מוגש מתוך הדשבורד עצמו, וקורא את הנתונים ישירות
// מ-Supabase. ⚠️ **ואותו origin אינו נוחות אלא תנאי:** `localStorage`
// משותף, ולכן ההתחברות של המוקדן עוברת איתו. דומיין נפרד היה מסך
// התחברות שני באמצע אירוע.
//
// ⚠️ המשתנה עדיין גובר, ולכן הפניה חזרה לשרת המקומי היא שורה ב-.env.
export const FIXFLOW_BASE_URL = String(
  import.meta.env.VITE_FIXFLOW_BASE_URL ?? "/fixflow"
).replace(/\/+$/, "");

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

  const r = resolveLink(site, MAP);
  if (r.status !== "ok") return { status: r.status, reason: r.reason, url: null };

  const q = faultText ? `?q=${encodeURIComponent(faultText)}` : "";
  // ⚠️ שתי הדרכים לקישור **ברמת האתר** — התאמת שם אוטומטית ובחירה ידנית —
  // מייצרות את אותו נתיב. בדיקה על `by === "name"` בלבד הייתה שולחת בחירה
  // ידנית לנתיב הספרייה, כלומר מוחקת את חריגות האתר בדיוק כשמישהו ביקש אותן
  // במפורש.
  const siteLevel = r.by === "name" || r.by === "chosen-site";
  const path = siteLevel
    ? `#/site/${encodeURIComponent(r.siteId)}`
    : `#/profile/${encodeURIComponent(r.system)}/${encodeURIComponent(r.profile)}`;

  return { ...r, url: `${FIXFLOW_BASE_URL}/${path}${q}` };
}

// ============================================================
// מנוסח התקלה שהבקר כתב — אל הנוהל עצמו
// ============================================================
// ⚠️ **הקישור לספרייה אינו מספיק ברגע אמת.** מוקדן שרואה `מנהל חניון - דלתות
// חניון פתוחות` באמצע אירוע צריך לדעת *מיד* שיש נוהל, ובעיקר — אם יש אזהרת
// בטיחות. רשימה של 67 מסמכים שהוא צריך לחפש בה היא צעד נוסף בדיוק ברגע שבו
// אין לו צעדים פנויים.
//
// נמדד על 90 צמדי (אתר, נוסח תקלה) אמיתיים: **47% נמצא להם נוהל** בציון
// ≥0.55, רובם ב-0.88–1.00. השאר אינם התאמה חלשה — פשוט אין עליהם מסמך.
import MAP_FAULTS from "../components/FixFlowLink/fixflow-sites.json";
import { matchFault, buildWeights } from "../../../shared/fixflow-match.mjs";

// ⚠️ טבלת המשקלים נבנית **פעם אחת לכל ספרייה** ונשמרת. בנייה בכל רינדור של
// כרטיס הייתה 319 טוקניזציות × מספר הכרטיסים, בכל שנייה שבה מסך המפקח מתרענן.
const weightCache = new Map();
function modelFor(key, faults) {
  if (!weightCache.has(key)) weightCache.set(key, buildWeights(faults));
  return weightCache.get(key);
}

/**
 * הנוהל שמתאים לתקלה הנוכחית של האתר, או null.
 *
 * ⚠️ החיפוש הוא **בתוך הספרייה של האתר בלבד**. חיפוש על כל 319 הנהלים היה
 * מוצא כותרת דומה מספרייה של מתקן אחר — וכל הצעדים בה נראים סבירים.
 */
export function fixflowSolutionFor(site, faultText) {
  if (!FIXFLOW_ENABLED || !FIXFLOW_BASE_URL || !faultText) return null;

  const link = fixflowLinkFor(site, null);
  if (!link || link.status !== "ok" || !link.system || !link.profile) return null;

  const key = `${link.system}|${link.profile}`;
  const raw = MAP_FAULTS.faults?.[key];
  if (!raw?.length) return null;

  // מפתחות קצרים בקובץ (i/t/w) — נפרשים כאן, כדי שהמתאם יישאר קריא.
  const faults = raw.map((f) => ({ id: f.i, title: f.t, warning: f.w ?? null }));
  const hit = matchFault(faultText, faults, modelFor(key, faults));
  if (!hit) return null;

  const base =
    link.by === "name" || link.by === "chosen-site"
      ? `#/site/${encodeURIComponent(link.siteId)}`
      : `#/profile/${encodeURIComponent(link.system)}/${encodeURIComponent(link.profile)}`;

  return {
    title: hit.fault.title,
    warning: hit.fault.warning,
    score: hit.score,
    url: `${FIXFLOW_BASE_URL}/${base}/fault/${encodeURIComponent(hit.fault.id)}`,
  };
}
