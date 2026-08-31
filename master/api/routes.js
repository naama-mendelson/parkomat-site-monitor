// api/routes.js — שרת ה-REST API של ה-Master (Express + SSE)

const express = require("express");
const path = require("path");
const fs = require("fs");
const {
  getActiveMaintenance, ensureAdminCode, verifyAdminCode, getAppUserByUid
} = require("../db/queries");
const db = require("../db/db");
const bus = require("../bus");

// שכבת האימות. מאחורי seam — ראה auth/provider.js. היום היא מאמתת בלבד
// (verifyToken) ואינה מנפיקה: ההנפקה במצב Supabase קורית בדפדפן.
const auth = require("../auth/provider");
const adminUsers = require("../auth/admin");   // ניהול משתמשים — המקום היחיד שנוגע במפתח ה-Secret
const {
  cache
} = require("./cache");

const {
  runChat, isChatConfigured
} = require("../ai/chat");

const app = express();

// סומכים רק על proxy מקומי (loopback) לצורך X-Forwarded-For. כך clientIp(req) נכון
// כשהדשבורד עובר דרך ה-proxy של Vite (localhost), ובו-זמנית לקוח חיצוני לא יכול
// לזייף כתובת דרך הכותרת ולעקוף את מגביל-הקצב של הצ'אט. לא סומכים על proxy
// שרירותי — הגדרה שמרנית ובטוחה כברירת מחדל.
// ⚠️ **הורחב כשנכנס Cloudflare Tunnel, ובלי זה שני דברים נשברים בשקט.**
// השרשרת היום היא: דפדפן ← Cloudflare ← cloudflared ← Caddy ← כאן. כלומר
// clientIp(req) הוא כתובת הקונטיינר של ה-proxy — **אותה כתובת לכל אדם בחברה**:
//   1. כל שורת ביקורת הייתה רושמת 172.x.x.x חסר משמעות. ה-IP הוא אחד
//      משני הדברים שעליהם נשענת ההסבה (השני הוא השם).
//   2. שני מגבילי הקצב מגבילים לפי IP — אדם אחד שמגיע לתקרה היה חוסם
//      את **כל** החברה.
//
// uniquelocal מכסה את 172.16/12 שהוא טווח רשתות ה-Docker. עדיין לא
// "סמוך על כל proxy" — הגדרה תחומה.
app.set("trust proxy", ["loopback", "uniquelocal"]);

// ============================================================
// ⚠️ CF-Connecting-IP קודם, ולמה זה בטוח כאן
// ============================================================
// Cloudflare מציב את הכותרת הזו בעצמו **ומוחק** כל ערך שהלקוח שלח, ולכן
// היא אינה ניתנת לזיוף מהאינטרנט. היא כן ניתנת לזיוף בידי מי שמגיע
// לשרת ישירות — אבל אחרי המעבר למנהרה, 4000 חשוף רק ל-127.0.0.1 ולרשת
// ה-Docker הפנימית.
//
// ⚠️ החלופה אינה "בטוחה יותר" אלא **שבורה**: לרשום את כתובת ה-proxy
// לכל אדם היא לא זהירות, היא מחיקת המידע.
function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  // ⚠️ req.ip ולא clientIp — ההחלפה הגורפת פגעה כאן פעם אחת והפכה את
  // הפונקציה לרקורסיה אינסופית. כל בקשה בלי כותרת Cloudflare הייתה
  // מפילה את השרת, כולל ה-healthcheck של הקונטיינר.
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// ניתן להגדרה כדי שאפשר יהיה להריץ מופע API לבדיקות על פורט אחר, בלי להתנגש
// בשרת שרץ (ובלי להעלות Master שני — שני מופעים עם אותו MASTER_CLIENT_ID
// מנתקים זה את זה מ-HiveMQ). ברירת המחדל לא השתנתה.
const PORT = Number(process.env.PORT) || 4000;

// ============================================================
// CORS — חייב להיות ה-middleware הראשון. בלי יוצא מן הכלל.
// ============================================================
// הוא היה רשום *אחרי* המטמון ואחרי מסלולי הניהול, ולכן:
//
//   • על פגיעה במטמון הקוד עשה `return res.json(...)` בלי לקרוא ל-next() —
//     ה-CORS לא רץ. אותה בקשה החזירה header ב-MISS ולא החזירה ב-HIT.
//     הדשבורד היה עובד בפעם הראשונה ונחסם ל-10 השניות הבאות. בדקתי: כך
//     בדיוק זה התנהג.
//   • תגובות מסלולי הניהול לא קיבלו headers של CORS כלל.
//
// היום זה מוסתר כי הדשבורד עובר דרך ה-proxy של Vite (same-origin). ביום
// שהוא יעלה לדומיין משלו — הניהול פשוט לא יעבוד, וזה ייראה כמו באג אימות.
// ============================================================
// ⚠️ **רשימה, ולא origin אחד** — וזה מה שחוסם את הפיצול
// ============================================================
// כאן היה ערך בודד שהוצב ישירות בכותרת. `Access-Control-Allow-Origin`
// **אינו מקבל רשימה** לפי התקן — מותר בו origin אחד או `*` — ולכן שרת
// שתומך בכמה origins חייב להשוות מול הבקשה ולהחזיר את זה שהתאים.
//
// ⚠️ בלי זה אי אפשר להחזיק בו-זמנית את הפיתוח (5173) ואת דומיין הספק,
// והמעבר הופך ל"או-או": כל בנייה שמכוונת לספק שוברת את הפיתוח המקומי.
//
// ⚠️ ו-`*` אינו חלופה: הוא אסור יחד עם אישורים, והוא היה פותח את כל
// נתיבי ה-API לכל דף באינטרנט שהמשתמש מבקר בו במקביל.
//
// מופרד בפסיקים. רווחים נסבלים כי קובץ `.env` שנערך ביד תמיד יקבל אותם.
const ALLOWED_ORIGINS = (process.env.DASHBOARD_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// מסתיר ערכים רגישים מ-URL לפני כתיבתו ללוג.
//
// ⚠️ מוחלף ולא נמחק: "?access_token=***" אומר שהייתה שם הזדהות, בעוד
// URL קטוע נראה כמו בקשה שגויה ומטעה את מי שמנתח לוג.
function redactUrl(url) {
  return String(url).replace(/([?&](?:access_token|token)=)[^&]*/gi, "$1***");
}

app.use((req, res, next) => {
  // ⚠️ מחזירים את ה-origin **שהתאים**, ולא את הראשון ברשימה: דפדפן משווה
  // את הכותרת מול ה-origin שלו בדיוק, וערך אחר פירושו חסימה.
  //
  // ⚠️ ובקשה מ-origin שאינו ברשימה — או בלי Origin כלל (curl, בדיקות,
  // בקשה מאותו origin) — **אינה נחסמת כאן**. השומר הזה אינו אבטחה: CORS
  // מגן על הדפדפן מפני דף זדוני, לא על השרת מפני לקוח. האכיפה היא
  // requireAuth. הוספת חסימה כאן הייתה שוברת כל בדיקה וכל שער.
  const origin = req.get("origin");
  if (origin && ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ""))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    // ⚠️ נדרש כשיש כמה origins: בלעדיו proxy או מטמון עלול להגיש לדומיין
    // אחד תשובה ששמורה עם הכותרת של דומיין אחר, וזה נראה כמו תקלת CORS
    // מקרית שאי אפשר לשחזר.
    res.setHeader("Vary", "Origin");
  } else if (!origin) {
    // אין Origin — same-origin או לקוח שאינו דפדפן. נשמר ההתנהגות הקודמת
    // כדי שהגשה מאותו שרת (המצב היום) לא תשתנה בכלל.
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS[0]);
  }
  // x-admin-code היה חסר — כלומר כל בקשת ניהול הייתה נכשלת ב-preflight.
  //
  // ⚠️ **ו-Authorization נוסף כאן ברגע שנתיבי הקריאה הפכו למוגנים.** בלעדיו
  // כל קריאת נתונים חוצת-origin נופלת ב-preflight — לפני שהיא בכלל מגיעה
  // לשרת. הכשל הזה **בלתי נראה היום**, כי הדשבורד יושב מאחורי ה-proxy של
  // Vite ולכן same-origin; הוא מתעורר בדיוק ביום שהקבצים עוברים ל-Apache
  // או לאחסון החיצוני, ואז הוא נראה כמו תקלת אימות ולא כמו CORS.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-code");
  // PATCH היה חסר, למרות ש-PATCH /api/sites/:code קיים.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");

  // בקשת preflight — עונים מיד ולא מריצים את שאר המסלולים.
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// ============================================================
// מדידת בקשות — כדי ש-N+1 לא יחזור בשקט
// ============================================================
// כל בקשה איטית נרשמת עם *מספר השאילתות* שהיא הריצה. זה המספר שמסגיר N+1:
// אם הוא גדל כשמוסיפים אתרים, יש לולאה שמריצה שאילתה לכל אתר.
// נרשם רק מעל הסף, כדי לא להציף את הלוג.
const SLOW_MS = 500;

app.use((req, res, next) => {
  const before = db.getQueryStats();
  const started = Date.now();

  res.on("finish", () => {
    const ms = Date.now() - started;
    const queries = db.getQueryStats().queries - before.queries;
    if (ms >= SLOW_MS) {
      // ⚠️ **האסימון מנוקה מה-URL לפני הכתיבה.** נתיב ה-SSE מקבל אותו
      // כפרמטר שאילתה (EventSource אינו יכול לשלוח כותרות — ראה
      // requireAuthSse), ולוג של originalUrl גולמי היה כותב אסימון תקף
      // לקובץ בכל בקשה איטית.
      //
      // וזו בדיוק הסיבה שאסימון ב-URL נחות מכותרת: הוא דולף למקומות
      // שאיש לא חשב עליהם. כאן זה נסגר; ההערה נשארת כדי שמי שיוסיף לוג
      // נוסף יידע לעשות אותו דבר.
      console.log(`[api] איטי: ${req.method} ${redactUrl(req.originalUrl)} — ${ms}ms, ${queries} שאילתות`);
    }
  });

  next();
});

// המטמון הוא opt-in לכל מסלול (cache() בשרשרת), ולא app.use גלובלי.
// כך אי אפשר לשכוח ולהגיש בטעות תגובה מוגנת לכל אנונימי.

// כל לקוח SSE מוסיף מאזין ל-bus המשותף. ברירת המחדל (10) מייצרת אזהרה
// כשיש הרבה מסכי בקרה פתוחים במקביל; מרימים את הסף (הניקוי נעשה ב-req.close).
bus.setMaxListeners(50);

// זריעת קוד המנהל עברה ל-startApiServer(): היא נוגעת ב-DB, ו-DB עכשיו
// אסינכרוני — ואי אפשר await ברמת המודול ב-CommonJS.

/**
 * שער הניהול. נאכף *בשרת* — הסתרה ב-UI בלבד לא הייתה שווה כלום,
 * כי כל אחד יכול לקרוא ל-API ישירות.
 *
 * ⚠️ זו איננה מערכת הרשאות אמיתית: הקוד משותף לכולם, עובר בכל בקשה,
 * ואין ממנו זהות משתמש. הוא מונע טעויות, לא תוקף. ראה README.
 */
async function requireAdmin(req, res, next) {
  const code = req.get("x-admin-code") || req.body?.adminCode;
  if (!await verifyAdminCode(code)) {
    return res.status(401).json({ error: "קוד מנהל שגוי" });
  }
  next();
}



// ============================================================
// identifyActor — מזהה, ולא חוסם
// ============================================================
// החלטת מוצר: **לכל אחד** יש אפשרות להכניס אתר להשבתה. זה גם העיצוב
// המקורי — הכפתור בדשבורד מעולם לא היה מוגן לפי תפקיד, והטופס דורש
// מהמשתמש להקליד את שמו. כלומר הכלל תמיד היה "כל אחד יכול, אבל חייב לומר
// מי הוא": **ייחוס במקום מנע.**
//
// לכן ה-middleware הזה אינו שער. הוא ממלא את req.actor אם יש אישורים,
// ומעביר הלאה גם כשאין.
//
// שלוש דרגות של אמון בזהות, והן נרשמות כמו שהן:
//   1. אסימון תקין  → זהות מאומתת. הזהות גוברת על מה שהלקוח שלח בגוף.
//   2. קוד מנהל     → פעולת ניהול. אין שם, ולכן נלקח מהגוף.
//   3. שום דבר      → אנונימי. השם מהגוף הוא הצהרה, לא אימות, והוא
//                     נרשם ככזה בלוג.
//
// אסימון שנשלח ונפסל הוא עדיין 401: מי ששלח אסימון התכוון להזדהות, וקבלה
// שקטה שלו כאנונימי הייתה מסתירה תקלת אימות אמיתית.
//
// ⚠️ מה שזה אומר בפועל, ומתועד ב-README: הנתיב פתוח לכל קורא HTTP, כלומר
// אפשר להשתיק אתר עד 30 יום בלי שום אישור. **להפוך אותו לחוסם זו שורה
// אחת** — להסיר את ההערה מה-return למטה. עשו זאת ברגע שיש משתמשים.
async function identifyActor(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (token) {
    const actor = await auth.verifyToken(token);
    if (!actor) return res.status(401).json({ error: "אסימון לא תקין או שפג" });
    req.actor = { userId: actor.userId, name: actor.email || actor.userId,
                  role: actor.role, trust: "token" };
    return next();
  }

  const code = req.get("x-admin-code") || req.body?.adminCode;
  if (code && await verifyAdminCode(code)) {
    req.actor = { userId: null, name: null, role: "admin", trust: "admin-code" };
    return next();
  }

  // ============================================================
  // ⚠️ הענף האנונימי **נסגר**, והתנאי שנקבע לכך התקיים
  // ============================================================
  // ההערה כאן אמרה: "כדי להפוך את הנתיב לחוסם (אחרי שיהיו משתמשים),
  // הסירו את ההערה". **יש משתמשים** — הם נוצרים בהזמנה, מאומתים מול
  // GoTrue, ונשמרים ב-app_users. התנאי מולא, ולכן זה מבוצע.
  //
  // ⚠️ ומה שהפך את זה מדחוי לדחוף: הפיצול לשני קונטיינרים אומר ששרת
  // ה-Node יקבל **שם DNS ציבורי**. עד היום הנתיב מוגן ברשת בלבד — פורט
  // מקומי. נמדד לפני הסגירה:
  //
  //     POST /api/sites/2438/maintenance  (בלי אסימון)  →  400 "חסר שם"
  //
  // כלומר הוא עבר את השומר והגיע לוולידציה. ברגע שהפורט ייפתח, "כל מי
  // שמגיע לפורט" הוא האינטרנט — וכל אדם יוכל להשתיק כל אתר ל-720 שעות,
  // מה שמסיר אותו ממכנה הזמינות ומדכא רישום תקלות.
  //
  // ⚠️ **"ייחוס במקום מנע" נשמר במלואו.** ההחלטה הייתה שכל **משתמש**
  // יכול להכניס אתר לתחזוקה — בלי דרישת תפקיד, בלי קוד מנהל. זה לא
  // השתנה: מנהל ובקר כאחד עוברים כאן. מה שנחסם הוא מי שאינו מזוהה
  // **כלל**, ועליו ההחלטה מעולם לא דיברה.
  //
  // ⚠️ ולכן גם `trust` נשאר: מי שנכנס עם קוד מנהל מסומן 'admin-code'
  // ולא 'token', וההבדל הזה הוא כל מה שמפריד בין שם מאומת להצהרה.
  req.actor = { userId: null, name: null, role: null, trust: "anonymous" };

  return res.status(401).json({ error: "נדרשת הזדהות" });
}

// ============================================================
// requireAuth — שער אמיתי, בשונה מ-identifyActor
// ============================================================
// ההבדל מהתחזוקה אינו קפריזה. תחזוקה פתוחה לכל אחד כי הנזק שלה מוגבל
// ומתועד (משתיקה אתר, נרשם מי עשה זאת). **יצירת משתמש היא אחרת**: משתמש
// חדש מקבל authenticated, ו-RLS מתיר לכל authenticated לקרוא את כל נתוני
// האתרים. כלומר נתיב יצירה אנונימי היה מאפשר לכל אדם באינטרנט להנפיק
// לעצמו גישה מלאה לנתונים — לא "לעשות פעולה", אלא לפתוח את הדלת.
//
// לכן כאן נדרש אסימון תקין, ואין מסלול חלופי של קוד מנהל: קוד מנהל הוא
// סוד משותף בלי זהות, ואי אפשר לרשום בעזרתו *מי* הזמין.
// ============================================================
// למה נתיבי הקריאה מוגנים עכשיו
// ============================================================
// הם היו פתוחים לחלוטין, וזה היה מקובל כל עוד הכל רץ ברשת פנימית והדשבורד
// יושב באותו origin. שתי ההנחות האלה נשברות בפיצול לשני קונטיינרים ובמעבר
// של הקבצים לאחסון החיצוני של החברה.
//
// ⚠️ **ובלי זה, "דלת החירום" הייתה הופכת לחור.** VITE_SUPABASE_DIRECT=false
// מחזיר את כל הקריאות דרך השרת — כלומר בדיוק המסלול שנשמר כדרך חזרה מ-
// Supabase. RLS מגן על המסלול הישיר; השרת מתחבר כ-postgres עם
// rolbypassrls, ולכן **הוא עוקף את RLS לגמרי**. מסלול פתוח כזה, חשוף
// לאינטרנט, נותן את כל הנתונים לכל מי שיודע את הכתובת.
//
// אותו מנגנון זהות בדיוק כמו בשאר הפרויקט: אסימון Supabase, מאומת דרך
// auth/provider.js — ולכן זה עובד גם בזרוע העצמאית, בלי שינוי.
//
// הדשבורד כבר מצרף את האסימון (services/api.js), והאפליקציה כולה חסומה
// מאחורי AuthGate — כלומר אין משתמש בלי session, ושום מסך לא נשבר.
// ============================================================
// ⚠️ מטמון "מי פעיל" — ובלעדיו השבתה לא השביתה כלום בזרוע הזו
// ============================================================
// `verifyToken` מאמת **חתימה**, ותו לא. אסימון של מי שהושבת נשאר חתום
// כדין, ולכן הוא המשיך לקרוא הכול דרך השרת — ואף יכול היה להתחבר מחדש
// ולקבל אסימון טרי, כי ההשבתה נוגעת ל-`app_users` ולא למשתמש ב-GoTrue.
//
// ⚠️ **התיקון ב-RLS (`app.is_active_user()`) כיסה רק את הזרוע הישירה.**
// מול PostgREST המדיניות אכן חוסמת; מול השרת היא לא רצה בכלל, כי
// `postgres` הוא `rolbypassrls`. כלומר בדיוק **דלת החירום** —
// `VITE_SUPABASE_DIRECT=false` — נשארה פתוחה למי שהושבת. נמדד מקצה לקצה.
//
// ⚠️ ולמה מטמון ולא שאילתה בכל בקשה: הבדיקה יושבת לפני **כל** מסלול קריאה,
// ופתיחת פאנל יורה כמה בקשות במקביל. שאילתה לכל אחת מוסיפה הלוך-ושוב
// לענן לכל אחת מהן. ההשבתה בכל זאת מיידית, כי המסלול שמשבית **מנקה את
// הרשומה** בעצמו; ה-TTL הוא רשת ביטחון לשינוי שנעשה מחוץ לשרת.
const ACTIVE_TTL_MS = 60_000;
const ACTIVE_MAX = 500;          // חסום, כמו api/cache.js — לא מפה שגדלה בלי גבול
const activeCache = new Map();

/** מנקה משתמש מהמטמון — נקרא מכל מסלול שמשנה סטטוס או דרגה. */


async function actorIsActive(userId) {
  const key = String(userId);
  const hit = activeCache.get(key);
  if (hit && Date.now() - hit.at < ACTIVE_TTL_MS) return hit.active;

  // getAppUserByUid כבר מסנן is_active, ולכן null = מושבת או לא קיים.
  const user = await getAppUserByUid(userId);
  const active = Boolean(user);

  if (activeCache.size >= ACTIVE_MAX) activeCache.delete(activeCache.keys().next().value);
  activeCache.set(key, { active, at: Date.now() });
  return active;
}

async function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: "נדרשת התחברות" });

  const actor = await auth.verifyToken(token);
  if (!actor) return res.status(401).json({ error: "אסימון לא תקין או שפג" });

  // ⚠️ כשל בבדיקה מחזיר 503 ולא 403: "אין לך הרשאה" על תקלת מסד שולח את
  // המשתמש לחפש בעיית הרשאות שאינה קיימת. נכשלים סגור, אבל אומרים למה.
  let active;
  try {
    active = await actorIsActive(actor.userId);
  } catch (err) {
    console.error("[auth] בדיקת פעילות נכשלה:", err.message);
    return res.status(503).json({ error: "לא ניתן לאמת את המשתמש כרגע" });
  }
  if (!active) return res.status(403).json({ error: "המשתמש אינו פעיל במערכת" });

  req.actor = { userId: actor.userId, name: actor.email || actor.userId,
                role: actor.role, trust: "token" };
  next();
}

// ============================================================
// אימות ל-SSE — ומדוע דווקא כאן האסימון בשאילתה
// ============================================================
// ⚠️ **`EventSource` אינו יכול לשלוח כותרות.** זו מגבלת ה-API בדפדפן, לא
// בחירה: אין ל-`new EventSource(url)` פרמטר headers כלל. לכן הנתיב הזה
// לבדו מקבל את האסימון כפרמטר שאילתה.
//
// ⚠️ **וזו פשרה מודעת, לא פתרון שווה ערך.** אסימון ב-URL מגיע ללוגי שרת,
// להיסטוריית דפדפן ולכותרת Referer. הוא נחות מכותרת, והוא נבחר רק מפני
// שהחלופות גרועות יותר:
//   • להשאיר את הנתיב פתוח — כל זרם האירועים של כל האתרים, לכל אחד.
//   • עוגייה — מוסיפה CSRF ושוברת בדיוק בפיצול origins שבגללו זה נעשה.
//
// ⚠️ **וזה זמני מעצם הגדרתו:** לזרוע הישירה כבר יש חלופה — Supabase
// Realtime (services/realtimeDirect.js), שמאומתת דרך RLS ולא צריכה את
// הנתיב הזה בכלל. ה-SSE הוא זרוע הגיבוי, וברגע שהיא תופעל כברירת מחדל
// הפשרה הזו נעלמת.
async function requireAuthSse(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : (typeof req.query.access_token === "string" ? req.query.access_token : null);

  if (!token) return res.status(401).json({ error: "נדרשת התחברות" });

  const actor = await auth.verifyToken(token);
  if (!actor) return res.status(401).json({ error: "אסימון לא תקין או שפג" });

  // ⚠️ אותה בדיקה כמו ב-requireAuth, ודווקא כאן היא קריטית: SSE הוא חיבור
  // **ארוך**. מי שהושבת בזמן שהזרם פתוח ממשיך לקבל כל אירוע במערכת עד
  // שיסגור את הלשונית. הבדיקה חלה על הפתיחה; ראה גם ניקוי המטמון ב-PATCH.
  let sseActive;
  try {
    sseActive = await actorIsActive(actor.userId);
  } catch (err) {
    console.error("[auth] בדיקת פעילות (SSE) נכשלה:", err.message);
    return res.status(503).json({ error: "לא ניתן לאמת את המשתמש כרגע" });
  }
  if (!sseActive) return res.status(403).json({ error: "המשתמש אינו פעיל במערכת" });

  req.actor = { userId: actor.userId, name: actor.email || actor.userId,
                role: actor.role, trust: "token" };
  next();
}

// ============================================================
// requireManager — ההפרדה בין מנהלים לבקרים, נאכפת
// ============================================================
// ⚠️ עד עכשיו שני נתיבי ניהול המשתמשים נשאו `requireAuth` בלבד, כלומר
// **כל מי שמחובר** — גם בקר — יכול היה להזמין ולהסיר אנשים. ההפרדה
// הייתה קיימת בנתונים ולא באכיפה.
//
// זה לא הורגש כי שני המשתמשים היחידים הם מנהלים. הוא היה מתגלה ביום
// שבו נוסף הבקר הראשון — כלומר בדיוק כשההפרדה מתחילה להיות משמעותית.
//
// ⚠️ **התפקיד נקרא מהטבלה ולא מהאסימון.** `parkomat_role` נכתב פעם אחת
// בהרשמה ותקף שעה: מנהל שהושבת ממשיך לשאת 'manager' עד שיפוג. אותו כלל
// בדיוק שקובעת app.current_app_role() במסד — הטבלה היא הסמכות.
//
// ⚠️ ורץ **אחרי** requireAuth ולא במקומו: שרשור שני השומרים מפריד בין
// "מי אתה" (401) לבין "אינך רשאי" (403), ושתי התשובות אינן אותו דבר —
// לא למשתמש ולא למי שקורא לוג.
async function requireManager(req, res, next) {
  const user = await getAppUserByUid(req.actor?.userId);

  if (!user) {
    // מאומת מול Supabase אבל אין לו שורה פעילה אצלנו — הושבת, או נוצר
    // בדרך שלא עברה ב-provision_app_user.
    return res.status(403).json({ error: "המשתמש אינו פעיל במערכת" });
  }
  if (user.role !== "manager") {
    return res.status(403).json({ error: "הפעולה מותרת למנהלים בלבד" });
  }

  // התפקיד האמיתי גובר על מה שהאסימון טען.
  req.actor.role = user.role;
  req.actor.appUserId = user.id;
  return next();
}



// ⚠️ סוג המתקן מגיע מ-shared/site-types.mjs ולא מרשימה מקומית — אותה רשימה
// בדיוק מזינה את ה-SELECT בטופס ואת התווית על הכרטיס. רשימה שנייה כאן הייתה
// מאפשרת לטופס להציע ערך שהשרת דוחה.


// עוטף אתר: המצב הוא "maintenance" אם PLC שלח maintenance או שיש תחזוקה ידנית (OR)
async function applyMaintenanceStatus(site) {
  const manualMaintenance = await getActiveMaintenance(site.id);   // מקור 1: ידני (טבלת maintenance_windows)
  const plcMaintenance = site.status === "maintenance";       // מקור 2: PLC (כבר ב-sites.status)

  if (manualMaintenance || plcMaintenance) {
    return { ...site, status: "maintenance" };
  }
  return site;
}


// ==========================================================
// תחזוקה — פעולה חופשית, *במכוון*, ולא מאחורי requireAdmin
// ==========================================================
// החלטת מוצר: תמיד צריך להיות אפשר להכניס/להוציא אתר מתחזוקה, בלי נעילת קוד
// מנהל — כדי שמי שנמצא בשטח יוכל לסמן תחזוקה מיד. שאר מסלולי השינוי (רישום,
// עריכה ומחיקת אתר) נשארים מאחורי requireAdmin.
//
// ⚠️ יש לזה מחיר שכדאי לזכור: תקלה שקרתה בתוך חלון תחזוקה מוחרגת מאחוז הכשל
// (ראה wasInMaintenance), ולכן מי שיש לו גישה לדשבורד יכול, דרך הפעלת תחזוקה,
// להסתיר לאתר את מדדי הכשל. זה נחשב מקובל כאן כי "קוד המנהל" ממילא לא היה
// אבטחה אמיתית (סוד משותף, למניעת טעויות) — עד שתיכנס אותנטיקציה אמיתית.
//
// duration_hours מוגבל מלמעלה: 1e9 שעות היה מחביא את האתר מהסטטיסטיקות
// ל-114,000 שנה, ו-1e15 היה מפיל את השרת ב-RangeError (Invalid Date).
const MAX_MAINTENANCE_HOURS = 720;   // 30 יום — מעבר לזה זו כבר לא "תחזוקה"



// ==========================================================
// ===== לוג הפעילות — endpoint משלו =====
// ==========================================================
// הלוג היה מוטמע בתוך תשובת ה-insights בלבד, וזה חייב אותו לעמוד אחד קבוע:
// כל לחיצה על צ'יפ, וכל "טען עוד", היו מושכים מחדש את **כל** חבילת התובנות
// (מדדים, גרפים, טבלת כרטיסים) רק כדי להחליף רשימה.
//
// עכשיו יש מסלול ייעודי. ה-insights ממשיך להטמיע את העמוד הראשון, כדי
// שהמודאל ייפתח עם תוכן ולא עם ספינר — והדפדוף מכאן ואילך זול.
//
// ⚠️ ללא cache(): הפרמטרים כאן (filter/card/offset) הם צירוף פתוח, ומטמון
// שמפתחו רשימת-היתר של פרמטרים היה מגיש עמוד של מסנן אחד תחת מסנן אחר.
const logParams = (req) => ({
  filter: String(req.query.filter || "all"),
  card: req.query.card ? String(req.query.card) : null,
  offset: Math.max(0, parseInt(req.query.offset, 10) || 0),
  // תקרה קשיחה: offset/limit מגיעים מהדפדפן, ו-limit=100000 היה מחזיר את כל
  // התקופה בבקשה אחת.
  limit: Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 300)),
});


// ==========================================================
// ===== עוזר ה-AI =====
// ==========================================================
// POST /api/chat — שאלה בעברית, תשובה מנתונים אמיתיים.
//
// *לא* מוגן ב-requireAdmin, כי הוא קריאה-בלבד: הכלים שהמודל יכול להפעיל הם
// אותם שאילתות שה-GET-ים הפתוחים כבר חושפים (ראה ai/tools.js). אין דרך לכתוב
// דרכו — וזה גבול שנאכף בבחירת הכלים, לא בהוראה ל-prompt. הוראה אפשר לשכנע.

// ===== הגבלת קצב =====
// המכסה של Groq משותפת לכל המשתמשים. בלי הגבלה, לשונית אחת בלולאה שורפת
// אותה לכולם. מפה בזיכרון מספיקה — זה תהליך יחיד; אם יהיו כמה, זה יעבור ל-DB.
const CHAT_RATE_LIMIT = 20;          // בקשות
const CHAT_RATE_WINDOW_MS = 60_000;  // לדקה
const chatHits = new Map();          // ip → number[] (חותמות זמן)

function chatRateLimit(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();

  const hits = (chatHits.get(ip) || []).filter((t) => now - t < CHAT_RATE_WINDOW_MS);

  if (hits.length >= CHAT_RATE_LIMIT) {
    const retryMs = CHAT_RATE_WINDOW_MS - (now - hits[0]);
    res.set("Retry-After", String(Math.ceil(retryMs / 1000)));
    return res.status(429).json({
      error: `יותר מדי שאלות. נסי שוב בעוד ${Math.ceil(retryMs / 1000)} שניות.`,
    });
  }

  hits.push(now);
  chatHits.set(ip, hits);

  // ניקוי עצל: בלי זה המפה גדלה לנצח עם כל IP שאי-פעם שאל (דליפת זיכרון איטית).
  if (chatHits.size > 500) {
    for (const [key, times] of chatHits) {
      if (times.every((t) => now - t >= CHAT_RATE_WINDOW_MS)) chatHits.delete(key);
    }
  }

  next();
}

// ============================================================
// ⚠️ requireAuth **לפני** מגבלת הקצב — ולפני הכל
// ============================================================
// העוזר מחזיק שבעה כלים שקוראים מהמסד (get_all_sites, get_site_stats,
// get_executive_stats ועוד). כלומר הוא **ממשק קריאה בשפה חופשית לאותם
// נתונים** שבדיוק הוגנו ב-17 הנתיבים האחרים.
//
// בלי השורה הזו כל האבטחה ההיא עקיפה: מי שנחסם מ-/api/sites פשוט שואל
// "תן לי את כל האתרים" ומקבל את אותו מידע.
//
// ⚠️ ומגבלת קצב אינה אימות. היא הייתה ההגנה היחידה כאן, והיא לפי **IP** —
// כלומר משרד שלם חולק מכסה אחת, ומי שמחליף IP מקבל מכסה חדשה. היא נועדה
// לרסן שימוש, לא למנוע גישה.
//
// ⚠️ ויש כאן גם עלות: כל קריאה היא בקשה בתשלום ל-Groq. נתיב פתוח פירושו
// שכל אחד יכול לחייב את החשבון.
//
// requireAuth ראשון גם כדי שבקשה לא מאומתת לא תצרוך מהמכסה של אף אחד.
app.post("/api/chat", requireAuth, chatRateLimit, async (req, res) => {
  // המפתח חסר → 503 ברור, לא 500 מסתורי. השרת עולה תקין גם בלי המפתח;
  // רק העוזר מושבת, ושאר המערכת ממשיכה לעבוד.
  if (!isChatConfigured()) {
    return res.status(503).json({
      error: "עוזר ה-AI אינו מוגדר. חסר GROQ_API_KEY בהגדרות השרת.",
    });
  }

  const { messages } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages חייב להיות מערך לא ריק" });
  }
  if (messages.length > 40) {
    return res.status(400).json({ error: "השיחה ארוכה מדי" });
  }
  // חוסם הודעת ענק שתנפח את הבקשה למודל ותשרוף מכסה.
  const tooLong = messages.find((m) => typeof m?.content === "string" && m.content.length > 4000);
  if (tooLong) {
    return res.status(400).json({ error: "ההודעה ארוכה מדי" });
  }

  // ==========================================================
  // הזרמה — הטקסט נשלח תוך כדי שהמודל מייצר אותו
  // ==========================================================
  // הפורמט הוא שורות JSON מופרדות ב-\n (NDJSON) ולא SSE תקני, כי EventSource
  // של הדפדפן תומך רק ב-GET, וכאן צריך POST עם גוף. הלקוח קורא את הזרם עם
  // fetch + ReadableStream.
  //
  // flushHeaders חיוני: בלעדיו Express מחזיק את הכותרות עד הסוף, והדפדפן לא
  // מתחיל לקרוא — כלומר "הזרמה" שמגיעה בבת אחת, בדיוק מה שלא רצינו.
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");   // אם יושב פרוקסי באמצע
  res.flushHeaders?.();

  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const { toolsUsed, truncated } = await runChat(messages, (chunk) => send({ t: chunk }));
    send({ done: true, toolsUsed, truncated: truncated || false });
    res.end();
  } catch (err) {
    console.error("[api] שגיאה ב-POST chat:", err.message);
    const msg = err.status === 429 ? err.message : "העוזר לא זמין כרגע. נסי שוב.";

    // אם כבר התחלנו להזרים, אי אפשר לשנות status — שולחים את השגיאה בתוך הזרם.
    if (res.headersSent) {
      send({ error: msg });
      res.end();
    } else {
      res.status(err.status === 429 ? 429 : 502).json({ error: msg });
    }
  }
});

const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
                   "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

/**
 * מפרש טווח מהבקשה. אם נשלחו from/to → טווח מותאם; אחרת נופל חזרה
 * ל-period (תאימות אחורה מלאה עם הקוד הקיים).
 * מחזיר null אם הטווח לא תקין — מי שקורא מחזיר 400.
 */


// פירוק רשימה מופרדת בפסיקים לערכים נקיים
const listOf = (v) =>
  typeof v === "string" && v.trim()
    ? v.split(",").map((x) => x.trim()).filter(Boolean)
    : [];


// ============================================================
// GET /health — בדיקת חיות ל-Docker/מנהל התהליכים
// ============================================================
// *לא* תחת /api בכוונה: זו נקודת תשתית, לא חלק מה-API של הדשבורד. היא רשומה
// כאן, לפני ה-static ולפני ה-SPA fallback, אחרת ה-fallback היה מגיש לה
// index.html (הוא תופס כל GET שאינו /api) והבדיקה הייתה "מצליחה" תמיד.
//
// למה לא להסתפק ב-'/' כמו קודם: דף סטטי מוכיח רק ש-Express חי. Master שמגיש
// דפים אבל מנותק מ-HiveMQ או שהסכמה שלו לא אותחלה **אינו** בריא — הוא בדיוק
// התקלה השקטה שהמערכת קיימת כדי לתפוס.
//
// ומה שהיא כן נזהרת לא לעשות: לא נוגעת ב-DB. שאילתה בכל 30 שניות היא עלות
// מתמשכת מול Supabase בלי תמורה — ה-keep-alive כבר מחזיק את ה-pool חם.
// לכן היא קוראת רק מצב שנצבר בתהליך.
const MQTT_UNHEALTHY_AFTER_SECONDS = 120;

app.get("/health", (req, res) => {
  const dbReady = db.isReady();
  const mqttUp = typeof bus.isConnected === "function" ? bus.isConnected() : null;
  const mqttDown = typeof bus.downForSeconds === "function" ? bus.downForSeconds() : 0;

  // ניתוק MQTT רגעי הוא שגרה (reconnect עם backoff), ולכן הוא *לא* מכשיל את
  // הבדיקה מיד — אחרת הסטטוס היה מרצד. ניתוק ממושך כן: אז השרת באמת לא קולט.
  const mqttHealthy = mqttUp === null || mqttUp || mqttDown < MQTT_UNHEALTHY_AFTER_SECONDS;
  const healthy = dbReady && mqttHealthy;

  // ============================================================
  // ⚠️ פירוט רק ללולאה המקומית — /health הפך לנגיש מהאינטרנט
  // ============================================================
  // עד המנהרה הנתיב הזה היה מוגן ברשת: פורט מקומי בלבד. מרגע שהדשבורד
  // מוגש דרך Cloudflare, גם /health מוגש — והוא מדווח uptime, מצב DB,
  // מצב MQTT ומספר חיבורי SSE לכל מי ששואל.
  //
  // ⚠️ אין כאן נתונים עסקיים, ולכן זו אינה דליפה חמורה — אבל "מתי
  // הקליטה למטה" הוא בדיוק המידע שמועיל למי שמנסה לזייף הודעות MQTT,
  // והצירוף בין השניים אינו מקרי.
  //
  // ⚠️ **הנתיב עצמו נשאר פתוח בכוונה, ולא הוסר.** זרוע השרת של המתג
  // (fetchServerHealth ב-api.js) קוראת לו, וזו דלת היציאה. הסרתו הייתה
  // שוברת אותה בשקט — והלקוח ממילא משתמש רק בקוד ה-HTTP.
  const raw = req.socket?.remoteAddress || "";
  const loopback = !req.headers["cf-connecting-ip"] &&
    (raw === "127.0.0.1" || raw === "::1" || raw === "::ffff:127.0.0.1");
  if (!loopback) {
    return res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "unhealthy" });
  }
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "unhealthy",
    uptimeSeconds: Math.round(process.uptime()),
    db: dbReady ? "ready" : "not_ready",
    mqtt: mqttUp === null ? "unknown" : mqttUp ? "connected" : `down_${mqttDown}s`,
    sseClients: sseClients.size,
  });
});

// חיבורי SSE פתוחים. נדרש לכיבוי מסודר — ראה ההערה ב-/api/stream.
const sseClients = new Set();


// ============================================================
// הגשת הדשבורד (פרודקשן / Docker)
// ============================================================
// בפיתוח Vite מגיש את הדשבורד ומעביר /api ל-proxy. בפרודקשן אין Vite, ולכן
// אותו שרת מגיש גם את קבצי ה-build. זה לא רק נוחות: הדשבורד קורא ל-API
// בנתיב *יחסי* ("/api"), ולכן הגשה מאותו origin עוקפת CORS לגמרי ומייתרת
// הגדרת כתובת-שרת בלקוח.
//
// מופעל רק אם תיקיית ה-build קיימת — כך ריצה בפיתוח (בלי dist) לא משתנה.
// DASHBOARD_DIST ניתן להגדרה כדי שה-Dockerfile יוכל להעתיק לאן שנוח לו.
const DASHBOARD_DIST = process.env.DASHBOARD_DIST
  || path.join(__dirname, "..", "public");

if (fs.existsSync(DASHBOARD_DIST)) {
  app.use(express.static(DASHBOARD_DIST));

  // Fallback ל-SPA: כל נתיב GET שאינו /api מוחזר כ-index.html, כדי שרענון
  // בכתובת פנימית לא יחזיר 404. *לא* משתמשים ב-app.get("*") — ב-Express 5
  // התחביר הזה נשבר (path-to-regexp v8 דורש wildcard בעל שם); middleware
  // רגיל עם בדיקת נתיב עובד בכל גרסה.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(DASHBOARD_DIST, "index.html"));
  });

  console.log(`api: מגיש את הדשבורד מ-${DASHBOARD_DIST}`);
  warnIfStaleBuild(DASHBOARD_DIST);
}

// ============================================================
// ⚠️ בנייה ישנה — הכשל השקט הגרוע ביותר שהיה כאן
// ============================================================
// ב-Docker העתקת ה-build אוטומטית (Dockerfile: COPY dashboard/dist master/public).
// **מקומית אין שום שלב כזה** — התיקייה היא עותק ידני, והיא ב-.gitignore.
//
// ⚠️ ונמדד: הבנדל שהוגש היה בן יומיים ולא הכיל אף אחת מהכתיבות הישירות
// ל-Supabase. המסך נראה תקין לחלוטין, הכפתור היה שם, והפעולה פשוט לא
// עבדה — כלומר יומיים של עבודה נבדקו מול ממשק שלא הכיל אותה, בלי שום סימן.
//
// ⚠️ אזהרה ולא סירוב לעלות: בייצור התיקייה **תמיד** חדשה מהמקור (היא
// נבנית בבנייה), אבל שם גם אין `dashboard/src` בכלל — ולכן הבדיקה פשוט
// אינה רצה. שרת שמסרב לעלות בגלל build ישן היה מפיל את הקליטה בגלל בעיה
// בממשק, ואלה שני דברים נפרדים.
function warnIfStaleBuild(dist) {
  try {
    const src = path.join(__dirname, "../../dashboard/src");
    if (!fs.existsSync(src)) return;   // ייצור — אין מקור להשוות אליו

    const newest = (dir) => {
      let max = 0;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        max = Math.max(max, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
      }
      return max;
    };

    const built = fs.statSync(path.join(dist, "index.html")).mtimeMs;
    const srcTime = newest(src);
    if (srcTime <= built) return;

    const days = Math.floor((srcTime - built) / 86400000);
    const age = days >= 1 ? `${days} ימים` : `${Math.round((srcTime - built) / 3600000)} שעות`;
    console.warn(
      `\n⚠️  הדשבורד שמוגש ישן מהמקור ב-${age} — שינויים אחרונים אינם בו.\n` +
      `   בנייה מחדש:  npm run build:web\n`,
    );
  } catch { /* בדיקה בלבד — לעולם לא מפילה עלייה */ }
}

// מטפל שגיאות אחרון — חייב 4 פרמטרים ולהיות אחרי כל המסלולים.
// בלעדיו, גוף JSON פגום (SyntaxError מ-body-parser) מחזיר עמוד HTML עם stack trace
// מלא שחושף נתיבי קבצים בשרת. כאן מחזירים JSON נקי במקום.
app.use((err, req, res, _next) => {
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "גוף הבקשה אינו JSON תקין" });
  }
  console.error("[api] שגיאה לא מטופלת:", err.message);
  res.status(500).json({ error: "שגיאת שרת" });
});

// מפעיל את השרת — נקרא מ-master.js.
// אסינכרוני עכשיו: חייבים לוודא שהסכמה קיימת ושקוד המנהל נזרע *לפני*
// שהשרת מתחיל לקבל בקשות, אחרת הבקשה הראשונה תיפול על טבלה שלא נוצרה.
async function startApiServer() {
  await db.init();

  // עטוף בניסיון חוזר כי זה נתיב *עלייה*: כשל כאן מתפשט ל-main() ב-master.js
  // שמסיים ב-exit(1), ולכן ניתוק חולף אחד של ה-pooler היה משאיר את השרת למטה.
  // בטוח לחזור עליו: הקריאה היא SELECT, והכתיבה (setSetting) היא upsert
  // (ON CONFLICT DO UPDATE) — הרצה כפולה כותבת בדיוק את אותו ערך.
  await db.retryTransient(ensureAdminCode, "זריעת קוד המנהל");

  // מחזירים את ה-server כדי שהכיבוי המסודר ב-master.js יוכל לסגור אותו.
  // בלי ההחזרה אין שום דרך להפסיק לקבל בקשות חדשות, ו-SIGTERM היה מסתיים
  // בקטיעה של בקשות באמצע.
  return app.listen(PORT, () => {
    console.log(`api: REST server running on http://localhost:${PORT}`);
  });
}

/**
 * סוגר את כל חיבורי ה-SSE הפתוחים. נקרא בכיבוי מסודר *לפני* server.close(),
 * אחרת הסגירה ממתינה לנצח: חיבור SSE לעולם אינו נגמר מעצמו.
 */
function closeSseClients() {
  const count = sseClients.size;
  for (const res of sseClients) {
    try { res.end(); } catch { /* הצד השני כבר נעלם */ }
  }
  sseClients.clear();
  return count;
}

// ⚠️ `app` נחשף כדי ש-check-scope-master יוכל **למנות נתיבים בפועל**
// במקום לסרוק טקסט. סריקת טקסט מפספסת נתיב שנרשם בלולאה, וזה בדיוק
// הסוג שנשכח. החשיפה אינה מפעילה כלום — ההאזנה היא ב-startApiServer.
module.exports = { startApiServer, closeSseClients, app };