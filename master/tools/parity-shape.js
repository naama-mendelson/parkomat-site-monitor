// tools/parity-shape.js — האם הזרוע הישירה מחזירה את **המבנה** שהמסך צורך.
//
//   node --env-file=.env tools/parity-shape.js
//   node --env-file=.env tools/parity-shape.js --update   ← מקליט חוזה חדש
//
// ============================================================
// למה זה נחוץ, ולמה שום שער אחר לא יכול לתפוס את זה
// ============================================================
// כל שערי ה-parity משווים **ערכים**: לוקחים שדה משתי הזרועות ובודקים שהוא
// זהה. זה תופס חישוב שגוי, שם עמודה שגוי, וסינון שונה.
//
// **אבל שדה שנעדר משתי הזרועות נראה כמו שדה שאינו קיים.** אין מה להשוות,
// ולכן אין מה להיכשל.
//
// נתפס בדפדפן ולא בשום שער: `DetailPanel` קרס עם
// `Cannot read properties of undefined (reading 'operations')`. הזרוע הישירה
// של האנליטיקה החזירה stats/uptime/chart — אבל **לא trend**, שהשרת בונה
// בשכבת ה-route ולא ב-computeAnalytics. 2,279 השוואות ערכים היו ירוקות.
//
// המסקנה: השוואת ערכים אינה מספיקה. חייבים להשוות גם את **קבוצת המפתחות**,
// כי זה מה שהמסך באמת צורך.
//
// ============================================================
// מה נבדק ומה לא
// ============================================================
// **המבנה בלבד** — שמות המפתחות והקינון, לא הערכים. הערכים כבר מכוסים
// בארבעת שערי ה-parity, וכפילות שלהם כאן הייתה מוסיפה רעש ולא כיסוי.
//
// ⚠️ מערכים נבדקים לפי האיבר הראשון בלבד: שורות בתוך מערך הן הומוגניות,
// ומעבר על כולן היה מייצר אלפי השוואות זהות.

const fs = require("node:fs");
const { fetchRetry } = require("./lib/fetch-retry");
const path = require("node:path");

const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const pick = (k) => (ENV.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();

const SB_URL = pick("VITE_SUPABASE_URL");
const SB_KEY = pick("VITE_SUPABASE_PUBLISHABLE_KEY");

let checks = 0, failures = 0;
const fails = [];

// ⚠️ הניקוי עובר דרך `done` ולא נכתב ליד כל יציאה — יש כאן ארבע.
let cleanupUser = async () => {};
const done = async (code) => { await cleanupUser(); process.exit(code); };

/**
 * קבוצת הנתיבים של אובייקט, עד עומק מוגבל.
 *
 * `pruned` אוסף נתיבים ש**קיימים אבל אין להם צאצאים בגלל הנתונים** — null,
 * או מערך ריק. ראה את ההסבר על אבות גזומים ב-`compareShape`.
 */
function shapeOf(v, prefix = "", depth = 0, out = new Set(), pruned = new Set()) {
  if (depth > 3 || typeof v !== "object" || v === null) {
    if (v === null && prefix) pruned.add(prefix);
    return out;
  }

  if (Array.isArray(v)) {
    // ============================================================
    // ⚠️ **כל האיברים, ולא רק הראשון** — ההנחה הקודמת הייתה שגויה
    // ============================================================
    // כאן היה כתוב "רק האיבר הראשון — שורות במערך הומוגניות". יומן
    // הפעילות מפריך את זה: שורת מצב ושורת תפעול הן שני מבנים שונים לגמרי
    // (`startEnd`/`card`/`entryExit` מול `status`/`originalStatus`).
    //
    // ⚠️ וזה **נמדד**, לא נוסח: אותו אתר בדיוק, בהפרש דקות, החזיר שורה
    // ראשונה מסוג אחר — והשער נפל על תשעה שדות בלי ששום שורת קוד השתנתה.
    // בדיקה שנופלת בגלל מה שקרה בחניון היא בדיוק בדיקה שלומדים להתעלם ממנה.
    if (v.length) for (const item of v) shapeOf(item, `${prefix}[]`, depth + 1, out, pruned);
    else if (prefix) pruned.add(prefix);
    return out;
  }

  for (const k of Object.keys(v)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    shapeOf(v[k], p, depth + 1, out, pruned);
  }
  return out;
}

// ============================================================
// ⚠️ תת-עצים תנודתיים — נוכחותם תלויה באילו שורות **הכי חדשות**
// ============================================================
// `fetchInsights` מבקש את 300 השורות האחרונות של השנה עם `filter: "all"`,
// ו-`log.entries` הוא מערך הטרוגני: לשורת תחזוקה יש `reason` ו-`durationHours`,
// לשורת תפעול יש `card` ו-`entryExit`. שורת התחזוקה האחרונה בייצור היא
// מ-30/08 — וככל שנכנסות פעולות חדשות היא **נדחקת מחוץ ל-300**, ואיתה
// 27 השדות שרק היא נושאת.
//
// ⚠️ **נמדד: השער עבר ב-08:18 ונפל ב-08:46 באותו יום, בלי שינוי קוד.**
// זה בדיוק "שער שנופל כי הנתונים זזו הוא שער שלומדים להתעלם ממנו".
//
// ⚠️ **וההחרגה אינה מאבדת כיסוי, וזו כל הסיבה שהיא מותרת:** `log` כאן הוא
// פשוטו כמשמעו הקריאה ל-`fetchActivityDirect`, ואותו מבנה בדיוק מקובע
// **דטרמיניסטית** בשני מקרים אחרים — `GET /api/activity` (שנה, 200 שורות)
// ו-`GET /api/activity (תחזוקה)`, שהפילטר שלו **מבטיח** שורות תחזוקה.
// קיבוע שלישי ממדגם שאינו יכול להבטיח כיסוי מוסיף רעידות ולא הגנה.
//
// ⚠️ ההחרגה היא לפי **תווית**, ולא גלובלית: `entries[].reason` במקרה
// התחזוקה חייב להישאר נדרש, אחרת מחיקתו מהקוד לא תיתפס בשום מקום.
const VOLATILE = {
  "GET /api/insights": ["log.entries[]"],
  "GET /api/sites/:code/insights": ["log.entries[]"],
};

const stripVolatile = (label, keys) => {
  const prefixes = VOLATILE[label];
  if (!prefixes) return keys;
  return keys.filter((k) => !prefixes.some((p) => k.startsWith(p + ".")));
};

function compareShape(label, expected, b, pruned) {
  checks++;

  // ============================================================
  // ⚠️ אב גזום אינו שדה חסר — וזה החוב שהמרת השער יצרה
  // ============================================================
  // כשהשוואנו זרוע מול זרוע, שתיהן ראו את **אותו אתר באותו רגע**, ולכן
  // היעדר שנובע מנתונים התבטל משני הצדדים. מול קובץ מוקלט הוא כבר לא
  // מתבטל: אתר שאין לו תקלה מחזיר `lastFault: null`, ואז כל תת-העץ שהוקלט
  // מתחתיו "חסר" — עשרה שדות אדומים על מערכת תקינה לחלוטין.
  //
  // הכלל: השדה עצמו **חייב** להופיע (מחיקה מהקוד עדיין נתפסת), אבל אם ערכו
  // null או מערך ריק — צאצאיו אינם נדרשים. זו בדיוק ההבחנה בין "הקוד הפסיק
  // להחזיר את זה" ל"אין על מה לדווח".
  const excused = (k) => [...pruned].some((p) => k.startsWith(p + ".") || k.startsWith(p + "["));

  // ⚠️ רק שדות ש**החוזה מכיל והזרוע הישירה לא**. ההפך אינו כשל: שדה נוסף
  // אינו שובר מסך שאינו קורא אותו — ואם הוא כן נחוץ, `--update` יקליט אותו.
  const missing = stripVolatile(label, expected).filter((k) => !b.has(k) && !excused(k));
  if (!missing.length) return;

  failures++;
  fails.push(`${label}: חסרים ${missing.length} שדות —\n      ${missing.slice(0, 12).join("\n      ")}`);
}

(async () => {
  // ⚠️ בונה לעצמו משתמש חד-פעמי אם אין הגדרה — קודם השער היה תלוי בחשבון
  // של אדם, והחשבון נמחק. **וכאן דרושה סיסמה ולא רק אסימון:** הכניסה
  // למטה עוברת ב-`supabase.auth.signInWithPassword` של הלקוח האמיתי, שהוא
  // בדיוק המסלול שהדפדפן מריץ — וזו כל הנקודה של השער הזה.
  const { gateToken } = require("./lib/gate-user");
  let email, password;
  try {
    // ⚠️ fetchRetry ולא fetch. הרשת כאן מנתקת מיוזמתה — נמדד: בערך כל בקשה
    // שנייה — ושני השערים האחרים כבר עברו דרך ריטריי. השער הזה נשאר בלי,
    // ולכן הוא **דיווח "לא ניתן להזדהות" על תקלת רשת חולפת** בזמן ששאר
    // השערים באותה ריצה דיברו עם Supabase בהצלחה. שער שנופל באקראי הוא
    // שער שלומדים להתעלם ממנו.
    const g = await gateToken(SB_URL, SB_KEY, process.env.SUPABASE_SECRET_KEY, fetchRetry);
    email = g.email; password = g.password; cleanupUser = g.cleanup;
  } catch (e) {
    console.log(`⚠️  לא ניתן היה להזדהות — המבנה לא נבדק. ${e.message}`);
    process.exit(2);
  }

  // ============================================================
  // ⚠️ נטען דרך Vite, ולא ב-import של Node
  // ============================================================
  // הזרוע הישירה נטענת דרך dataSource — כלומר **בדיוק המסלול שהדשבורד מריץ**
  // ולא שחזור שלו. אבל import רגיל של Node נכשל עליו: הקוד מייבא `./api`
  // בלי סיומת, ו-Node ESM דורש סיומת מפורשת בעוד ש-Vite פותר לבד.
  //
  // הפתרון אינו להוסיף סיומות לעשרות ייבואים בקוד המוצר, אלא להשתמש בטוען
  // של Vite עצמו: ssrLoadModule פותר בדיוק כמו הדפדפן, ומאכלס גם את
  // import.meta.env. כך הבדיקה בודקת את גרף המודולים האמיתי.
  const { createServer } = await import("../../dashboard/node_modules/vite/dist/node/index.js");
  const vite = await createServer({
    root: path.resolve(__dirname, "../../dashboard"),
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    // ⚠️ supabase-js נשאר **חיצוני**. כשה-SSR של Vite ממיר אותו, ההתחברות
    // נכשלה ב-`fetch failed` — Vite פותר את בניית הדפדפן, שמצפה ל-DOM.
    // כשהוא חיצוני, Node טוען את בניית ה-node הנכונה, ואותה התחברות בדיוק
    // עוברת. שאר המודולים כן עוברים דרך Vite, וזו כל הנקודה.
    ssr: { external: ["@supabase/supabase-js"] },
  });

  // ⚠️ ההתחברות חייבת להיות על **הלקוח של המודול**, לא על לקוח שנוצר כאן.
  // dataSource מייבא את services/supabase.js ומשתמש בלקוח שנוצר שם; לקוח
  // שני שיצרנו בצד היה מתחבר לעצמו, והמודול היה ממשיך לרוץ בלי session
  // ומקבל 401 — כלומר הבדיקה הייתה נכשלת מסיבה שאינה קשורה למבנה.
  const sbMod = await vite.ssrLoadModule("/src/services/supabase.js");

  // ============================================================
  // ⚠️ ניסיון חוזר על `fetch failed` — תקלה חולפת מוכרת כאן
  // ============================================================
  // נמדד: אותה התחברות בדיוק נכשלה שלוש פעמים ברצף ב-`fetch failed`, בזמן
  // ש-smoke-realtime — שמריץ את אותה קריאה עם ניסיון חוזר — עבר. זו אותה
  // משפחה שכבר מטופלת ב-db.js (Supavisor סוגר חיבורים) וב-smoke-direct.js,
  // רק שכאן היא מגיעה מ-fetch.
  //
  // ⚠️ הריטריי הוא **רק על כשל רשת**. שגיאת הרשאה (401/403) חוזרת כמות שהיא
  // ואינה מנוסה שוב — זו בדיוק התשובה שיש לראות, וניסיון חוזר עליה היה הופך
  // מדיניות שבורה ל"עבר אחרי כמה ניסיונות".
  let authErr = null;
  for (let i = 1; i <= 4; i++) {
    const { error } = await sbMod.supabase.auth.signInWithPassword({ email, password });
    authErr = error;
    if (!error || !/fetch failed|network|ECONNRESET/i.test(error.message)) break;
    await new Promise((r) => setTimeout(r, 500 * i));
  }
  if (authErr) { console.error(`  ✘ התחברות: ${authErr.message}`); await done(1); }

  const ds = await vite.ssrLoadModule("/src/services/dataSource.js");

  // ⚠️ **דטרמיניסטי, ולא `limit(1)` בלבד.** בלי ORDER BY המסד מחזיר אתר
  // שרירותי, וכשהצד השני היה שרת חי זה לא הזיק — שתי הזרועות קיבלו את אותו
  // אתר. מול חוזה מוקלט זה כן מזיק: ההקלטה נעשית על אתר אחד וההשוואה על
  // אחר, והשער היה מתחלף בין ירוק לאדום בלי ששום שורת קוד השתנתה.
  // ============================================================
  // ⚠️ **כל האתרים, ואיחוד השדות** — אתר אחד אינו יכול לייצג חוזה
  // ============================================================
  // כשהצד השני היה שרת חי, אתר שרירותי הספיק: שתי הזרועות ראו את אותו
  // אתר באותו רגע, והיעדר שנובע מנתונים התבטל משני הצדדים. מול קובץ
  // מוקלט הוא כבר לא מתבטל, וזה **נמדד**: הקלטה מאתר 1089 מול הקלטה
  // מאתר 1284 נבדלה ב-24 שדות — שישה מהם רק משום של-1089 אין ולו חלון
  // תחזוקה אחד, כלומר `maintenanceHistory` שלו מערך ריק.
  //
  // אתר אחד היה מקבע חוזה חלש יותר ממה שהמסך באמת צורך, ואיש לא היה יודע.
  // לכן שני הצדדים — ההקלטה וההשוואה — עוברים על **כל** האתרים ומאחדים.
  // סימטרי מהגדרתו, ולכן אין מצב שבו ההקלטה ראתה משהו שההשוואה לא.
  //
  // PARITY_SITE מצמצם לאתר אחד, לתשובה על "מה יש באתר הזה ואין באחר".
  // הוא **אינו** אמור לשמש בהקלטה.
  const sitesRes = await sbMod.supabase.from("sites").select("code").order("code");
  const codes = process.env.PARITY_SITE
    ? [process.env.PARITY_SITE]
    : sitesRes.data.map((s) => s.code);
  if (!codes.length) { console.log("⚠️  אין אתרים — המבנה לא נבדק."); await done(2); }
  const code = codes[0];

  // ⚠️ תאריך היום בשעון **מקומי**, ולא toISOString: באזור זמן חיובי הוא מזיז
  // יום אחורה, והשער היה משווה "אתמול" מול "היום" ונופל על הבדל שאינו קיים.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const todayIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  console.log(`אתרים: ${codes.length}  ·  מצב ישיר: ${ds.dataSourceName}  ·  היום: ${todayIso}\n`);

  // ============================================================
  // ⚠️ הצד השני של ההשוואה **נמחק**, והוחלף בחוזה מוקלט
  // ============================================================
  // כשנכתב השער, שתי הזרועות היו חיות והוא השווה ביניהן. 29 נתיבי הקריאה
  // נמחקו מ-master מאז, ולכן הוא דיווח "לא רץ" בכל הרצה — תשובה כנה
  // שאיש אינו קורא, ושגרוע מכך שולחת מישהו לנסות להפעיל שרת שלא יעזור.
  //
  // הצד הישיר לא השתנה כלל: הוא עדיין נטען דרך Vite, עם הלקוח האמיתי,
  // בדיוק כמו בדפדפן. מה שהשתנה הוא מול מה הוא נמדד — קובץ שנוצר ממנו
  // עצמו ונשמר בגיט.
  //
  // ⚠️ **וזה שער רגרסיה, לא שער נכונות.** חוזה שנוצר מהקוד מקבע גם באג,
  // אם היה אחד ברגע ההקלטה. מה שהוא כן מבטיח: שדה שייעלם מהזרוע הישירה
  // ייתפס — וזו בדיוק התקלה שהוא נבנה בשבילה, ושעברה 2,279 השוואות ערכים.
  //
  // לעדכון מכוון: node tools/parity-shape.js --update, ואז לקרוא את
  // ה-diff. חוזה שמתעדכן בלי שמישהו קרא את השינוי אינו חוזה.
  const CONTRACT = path.resolve(__dirname, "../../shared/contracts/direct-shapes.json");
  const UPDATING = process.argv.includes("--update");
  let recorded = {};
  if (!UPDATING) {
    if (!fs.existsSync(CONTRACT)) {
      console.log(`\n⚠️  חסר קובץ החוזה: ${CONTRACT}`);
      console.log("   צרי אותו: node tools/parity-shape.js --update");
      await done(2);
    }
    recorded = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));
  }

  // ⚠️ התוויות נשארו בשמות המסלולים הישנים **בכוונה**. הן המפתחות בקובץ
  // החוזה, ושינוי שם היה מציג את כל השורות כחסרות — ומי שיקרא את ה-diff
  // יראה עשר תקלות במקום שינוי שם אחד.
  // האיבר השלישי: האם המקרה תלוי-אתר, כלומר האם להריץ אותו על כל האתרים.
  const CASES = [
    ["GET /api/sites/:code/analytics",   (c) => ds.fetchAnalytics(c, "week"), true],
    ["GET /api/sites/:code",             (c) => ds.fetchDetail(c), true],
    ["GET /api/sites/:code/maintenance", (c) => ds.fetchMaintenanceState(c), true],
    ["GET /api/stats/supervisor",        () => ds.fetchSupervisor("week")],
    // ⚠️ שנה מאותה סיבה בדיוק: שתיהן מכילות `log.entries` — אותו מערך
    // הטרוגני שהפיל את `GET /api/activity`, רק בקינון אחד עמוק יותר.
    ["GET /api/sites/:code/insights",    (c) => ds.fetchInsights(c, "year"), true],
    ["GET /api/insights",                () => ds.fetchInsights(null, "year")],
    // ============================================================
    // ⚠️ שנה ו-200, ולא שבוע ו-20 — הדגימה חייבת להכיל כל **סוג** שורה
    // ============================================================
    // יומן הפעילות הוא מערך הטרוגני: שורת תפעול, שורת תקלה ושורת תחזוקה
    // הן שלושה מבנים שונים. עשרים השורות האחרונות של שבוע אינן מבטיחות
    // שכל סוג מיוצג — ונמדד: `entries[].reason` (שדה שקיים רק על שורת
    // תחזוקה) הופיע בהקלטה ונעלם בהרצה שאחריה, בלי ששום שורת קוד השתנתה.
    //
    // חלון רחב אינו מבטל את הסיכון, אבל הוא מזיז אותו מ"תלוי במה שקרה
    // בחניון השבוע" ל"תלוי במה שקרה בשנה" — ובטווח כזה כל הסוגים קיימים.
    ["GET /api/activity",                () => ds.fetchActivity(null, { period: "year", limit: 200 })],

    // ============================================================
    // ⚠️ מקרה נפרד לתחזוקה — כיסוי דטרמיניסטי במקום תקווה
    // ============================================================
    // שורות היומן **הטרוגניות**: לשורת תחזוקה יש `reason` ו-`setByName`,
    // ולשורת תפעול יש `card` ו-`entryExit`. המקרה שמעליי מבקש את 200
    // האחרונות, וכשמגיעות תקלות חדשות הן דוחפות את שורות התחזוקה החוצה —
    // ואז `entries[].reason` נעלם מהמבנה **בלי ששום שורת קוד השתנתה**.
    //
    // נמדד: השער נפל על זה פעמיים, בהרצות שונות, על אותו קוד.
    //
    // הפתרון אינו חלון רחב יותר — הוא לבקש את הסוג במפורש. מסנן שהמסך
    // ממילא מציע הופך "אולי יש שם שורת תחזוקה" ל"יש, כי ביקשנו אותה".
    ["GET /api/activity (תחזוקה)",
      () => ds.fetchActivity(null, { period: "year", limit: 50, filter: "maintenance" })],
    ["GET /api/stats/executive",         () => ds.fetchExecutive({ period: "week" })],

    // ============================================================
    // ⚠️ טווח חופשי — הצורה שהשער פספס
    // ============================================================
    // בורר הטווח מחזיר **או** period **או** from/to. הגרסה הראשונה של
    // fetchExecutive קראה רק את period ונפלה ל-"week", ולכן בחירת "היום"
    // הציגה 7 ימים — בלי שום שגיאה.
    //
    // השער לא תפס זאת כי הוא בדק **רק** period. בדיקה שמכסה צורה אחת מתוך
    // שתיים נראית ירוקה בדיוק כמו בדיקה שמכסה את שתיהן.
    ["GET /api/stats/executive (טווח חופשי)",
      () => ds.fetchExecutive({ from: todayIso, to: todayIso })],

    ["GET /api/report/monthly",
      () => ds.fetchMonthlyReport(null, todayIso, todayIso)],
  ];

  const captured = {};
  for (const [label, dirFn, perSite] of CASES) {
    try {
      // איחוד על פני כל האתרים כשהמקרה תלוי-אתר, אחרת קריאה אחת.
      const out = new Set(), pruned = new Set();
      for (const c of perSite ? codes : [code]) {
        shapeOf(await dirFn(c), "", 0, out, pruned);
      }
      // ⚠️ אב שנגזם באתר אחד אך מלא באחר **אינו** גזום: האיחוד ראה את
      // צאצאיו, והפטור נועד רק למה שאיש לא ראה.
      for (const p of [...pruned]) {
        if ([...out].some((k) => k.startsWith(p + ".") || k.startsWith(p + "["))) pruned.delete(p);
      }

      if (UPDATING) {
        captured[label] = [...out].sort();
        console.log(`  ⬤ ${label}  (${captured[label].length} שדות)`);
        continue;
      }

      // ⚠️ תווית שאינה בחוזה היא **כישלון** ולא דילוג. מקרה חדש שנוסף לשער
      // ולא הוקלט היה מדווח ירוק בלי לבדוק דבר — בדיוק הדפוס שהקובץ הזה
      // קיים כדי למנוע.
      const expected = recorded[label];
      if (!Array.isArray(expected)) {
        failures++;
        fails.push(`${label}: אין רשומה בחוזה — הריצי --update ותקראי את ה-diff`);
        console.log(`  ✘ ${label}  (חסר בחוזה)`);
        continue;
      }

      const before = failures;
      compareShape(label, expected, out, pruned);
      console.log(`  ${failures === before ? "✔" : "✘"} ${label}`);
    } catch (e) {
      failures++;
      fails.push(`${label}: נפל — ${e.message}`);
      console.log(`  ✘ ${label}  (${e.message.slice(0, 60)})`);
    }
  }

  if (UPDATING) {
    // ⚠️ נכשל בהקלטה = **לא כותבים**. חוזה שהוקלט מריצה חלקית מקבע פחות
    // שדות ממה שהמסך צורך, ומאותו רגע השער ירוק על מערכת שבורה.
    if (failures) {
      console.log(`\n❌ ${failures} מקרים נפלו — החוזה לא נכתב\n`);
      fails.forEach((f) => console.log("   " + f));
      await done(1);
    }
    // ============================================================
    // ⚠️ הקלטה שמצמצמת את החוזה נעצרת — זו הדרך שבה שער כזה מרקיב
    // ============================================================
    // מי שמריץ `--update` אחרי שינוי לגיטימי לא בודק את מספר השדות; הוא
    // רואה "נכתב" ועושה commit. אם באותו רגע הנתונים היו דלים — שבוע בלי
    // חלון תחזוקה, יום בלי תפעולים — החוזה החדש **קטן** מהקודם, והשער
    // ממשיך לדווח ירוק על מערכת שאיבדה שדות. זה בדיוק הכשל שהוא נבנה נגדו,
    // רק שהפעם הוא מייצר אותו בעצמו.
    //
    // נמדד: אותם עשרה מקרים החזירו 785 שדות מאתר אחד ו-761 מאחר.
    if (fs.existsSync(CONTRACT)) {
      const old = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));
      const lost = [];
      for (const [label, keys] of Object.entries(old)) {
        // ⚠️ **מקרה שנעלם מ-CASES הוא האובדן הגדול ביותר, ופה הוא כמעט
        // חמק.** הגרסה הראשונה כתבה כאן `if (!captured[label]) continue`,
        // כלומר מחיקת מקרה שלם מהשער הייתה מוחקת אותו מהחוזה **בשקט** —
        // בדיוק הריקבון שהשומר הזה נבנה נגדו, רק בגודל של מסלול שלם
        // במקום שדה בודד.
        if (!captured[label]) {
          lost.push(`${label}: המקרה כולו — ${keys.length} שדות, נמחק מ-CASES?`);
          continue;
        }
        // ⚠️ אותה החרגה כמו בהשוואה, ומאותה סיבה: בלעדיה שומר-הצמצום היה
        // חוסם כל `--update` שנעשה ברגע שבו שורת תחזוקה נדחקה מחוץ ל-300,
        // כלומר הופך את ההקלטה למי-שיצליח-ראשון.
        const gone = stripVolatile(label, keys).filter((k) => !captured[label].includes(k));
        if (gone.length) lost.push(`${label}: ${gone.length} שדות — ${gone.slice(0, 6).join(", ")}`);
      }
      if (lost.length && !process.argv.includes("--shrink")) {
        console.log("\n❌ החוזה החדש **מצמצם** את הקיים — לא נכתב:\n");
        lost.forEach((l) => console.log("   " + l));
        console.log("\n   אם המחיקה מכוונת: --update --shrink");
        await done(1);
      }
    }

    fs.mkdirSync(path.dirname(CONTRACT), { recursive: true });
    fs.writeFileSync(CONTRACT, JSON.stringify(captured, null, 2) + "\n");
    console.log(`\n📝 נכתב ${CONTRACT}`);
    console.log("   ⚠️ קראי את ה-diff לפני commit — חוזה שמתעדכן בלי שקראו אותו אינו חוזה.");
    await done(0);
  }

  // ⚠️ מקרה בחוזה שאינו ברשימה = מסלול שנמחק מבלי שהחוזה עודכן. בלי הבדיקה
  // הזו אפשר למחוק מסך שלם מ-dataSource והשער יישאר ירוק.
  const labels = new Set(CASES.map(([l]) => l));
  for (const label of Object.keys(recorded)) {
    if (!labels.has(label)) {
      failures++;
      fails.push(`${label}: קיים בחוזה ואינו נבדק — נמחק מהשער?`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  if (failures) {
    console.log(`❌ ${failures} מסלולים עם מבנה חסר\n`);
    fails.forEach((f) => console.log("   " + f));
    await done(1);
  }
  console.log(`✅ כל ${checks} המסלולים מחזירים את המבנה שבחוזה`);
  await done(0);
})().catch(async (e) => { console.error("parity-shape: נפל —", e.message); await done(1); });
