// tools/parity-shape.js — האם שתי הזרועות מחזירות את אותו **מבנה**.
//
//   PARITY_EMAIL=<מייל> PARITY_PASSWORD=<סיסמה> \
//     node --env-file=.env tools/parity-shape.js
//
// (דורש שהשרת ירוץ על :4000 — הוא הצד השני של ההשוואה.)
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

const API = process.env.PARITY_API || "http://localhost:4000";
const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const pick = (k) => (ENV.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();

const SB_URL = pick("VITE_SUPABASE_URL");
const SB_KEY = pick("VITE_SUPABASE_PUBLISHABLE_KEY");

let checks = 0, failures = 0;
const fails = [];

// ⚠️ הניקוי עובר דרך `done` ולא נכתב ליד כל יציאה — יש כאן ארבע.
let cleanupUser = async () => {};
const done = async (code) => { await cleanupUser(); process.exit(code); };

/** קבוצת הנתיבים של אובייקט, עד עומק מוגבל. */
function shapeOf(v, prefix = "", depth = 0, out = new Set()) {
  if (depth > 3 || v === null || typeof v !== "object") return out;

  if (Array.isArray(v)) {
    // רק האיבר הראשון — שורות במערך הומוגניות.
    if (v.length) shapeOf(v[0], `${prefix}[]`, depth + 1, out);
    return out;
  }

  for (const k of Object.keys(v)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    shapeOf(v[k], p, depth + 1, out);
  }
  return out;
}

function compareShape(label, server, direct) {
  checks++;
  const a = shapeOf(server), b = shapeOf(direct);

  // ⚠️ רק שדות ש**השרת מחזיר וההזרוע הישירה לא**. ההפך אינו כשל: זרוע
  // ישירה שמחזירה שדה נוסף אינה שוברת מסך שאינו קורא אותו.
  const missing = [...a].filter((k) => !b.has(k));
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

  const codeRes = await sbMod.supabase.from("sites").select("code").limit(1).single();
  const code = codeRes.data.code;

  // ============================================================
  // ⚠️ האסימון מצורף — נתיבי הקריאה בשרת מוגנים
  // ============================================================
  // עד היום הם היו פתוחים, והשער קרא להם בלי כותרות. ברגע שנוסף
  // requireAuth **כל עשרת המסלולים** כאן חזרו 401 — כלומר השער הפסיק
  // להשוות מבנה והתחיל לדווח על אימות.
  //
  // ⚠️ וזה נתפס רק עכשיו כי השער דורש התחברות, ולא רץ מעולם. שער שאינו
  // רץ אינו מגן — הוא רק נראה כאילו.
  //
  // ה-session כבר קיים: signInWithPassword למעלה יצר אותו בשביל הזרוע
  // הישירה. כאן רק שולפים ממנו את האסימון.
  const get = async (p) => {
    const { data } = await sbMod.supabase.auth.getSession();
    const token = data.session?.access_token;
    const r = await fetchRetry(`${API}${p}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) throw new Error(`${p} -> ${r.status}`);
    return r.json();
  };

  // ⚠️ תאריך היום בשעון **מקומי**, ולא toISOString: באזור זמן חיובי הוא מזיז
  // יום אחורה, והשער היה משווה "אתמול" מול "היום" ונופל על הבדל שאינו קיים.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const todayIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  console.log(`אתר לבדיקה: ${code}  ·  מצב ישיר: ${ds.dataSourceName}  ·  היום: ${todayIso}\n`);

  // ============================================================
  // ⚠️ בדיקת נגישות לפני הכול — קוד 2 ולא כישלון
  // ============================================================
  // כל עשרת המקרים כאן קוראים לשרת. כשהוא אינו רץ, כולם נופלים ב-
  // `fetch failed` והשער מדווח כישלון — אבל זה **אין ידיעה**, לא אי-
  // התאמת מבנה. על מכונת פיתוח השרת רץ ב-Docker על DELL008 ולא מקומית,
  // ולכן זה היה צובע את השער באדום בכל הרצה. שער שאדום תמיד הוא שער
  // שמדלגים עליו בעין, וזה גרוע משער שאינו קיים.
  try {
    await get("/health");
  } catch {
    console.log(`
⚠️  השרת אינו עונה ב-${API} — מבנה המסלולים לא נבדק.`);
    console.log("   הפעילי אותו, או קבעי PARITY_API.");
    await done(2);
  }

  const CASES = [
    ["GET /api/sites/:code/analytics", () => get(`/api/sites/${code}/analytics?period=week`),
      () => ds.fetchAnalytics(code, "week")],
    ["GET /api/sites/:code",           () => get(`/api/sites/${code}`),
      () => ds.fetchDetail(code)],
    ["GET /api/sites/:code/maintenance", () => get(`/api/sites/${code}/maintenance`),
      () => ds.fetchMaintenanceState(code)],
    ["GET /api/stats/supervisor",      () => get(`/api/stats/supervisor?period=week`),
      () => ds.fetchSupervisor("week")],
    ["GET /api/sites/:code/insights",  () => get(`/api/sites/${code}/insights?period=week`),
      () => ds.fetchInsights(code, "week")],
    ["GET /api/insights",              () => get(`/api/insights?period=week`),
      () => ds.fetchInsights(null, "week")],
    ["GET /api/activity",              () => get(`/api/activity?period=week&limit=20`),
      () => ds.fetchActivity(null, { period: "week", limit: 20 })],
    ["GET /api/stats/executive",       () => get(`/api/stats/executive?period=week`),
      () => ds.fetchExecutive({ period: "week" })],

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
      () => get(`/api/stats/executive?from=${todayIso}&to=${todayIso}`),
      () => ds.fetchExecutive({ from: todayIso, to: todayIso })],

    ["GET /api/report/monthly",
      () => get(`/api/report/monthly?from=${todayIso}&to=${todayIso}`),
      () => ds.fetchMonthlyReport(null, todayIso, todayIso)],
  ];

  for (const [label, srvFn, dirFn] of CASES) {
    try {
      const [srv, dir] = await Promise.all([srvFn(), dirFn()]);
      const before = failures;
      compareShape(label, srv, dir);
      console.log(`  ${failures === before ? "✔" : "✘"} ${label}`);
    } catch (e) {
      failures++;
      fails.push(`${label}: נפל — ${e.message}`);
      console.log(`  ✘ ${label}  (${e.message.slice(0, 60)})`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  if (failures) {
    console.log(`❌ ${failures} מסלולים עם מבנה חסר\n`);
    fails.forEach((f) => console.log("   " + f));
    await done(1);
  }
  console.log(`✅ כל ${checks} המסלולים מחזירים את אותו מבנה בשתי הזרועות`);
  await done(0);
})().catch(async (e) => { console.error("parity-shape: נפל —", e.message); await done(1); });
