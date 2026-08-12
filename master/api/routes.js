// api/routes.js — שרת ה-REST API של ה-Master (Express + SSE)

const express = require("express");
const path = require("path");
const fs = require("fs");
const { getAllSites, getAllSitesWithMetrics, findSiteByCode, insertSite, getRecentOperations, getFilteredOperations,
  getEventsSince, getLatestEventId,
        startMaintenance, getActiveMaintenance, cancelMaintenance, getSiteStats,
        getCurrentStatusSince, getStatusHistory, getMaintenanceHistory,
        getSystemSummary, getSystemMonthlyBreakdown,
        getSiteUptime, getLastFaultAt, getLastOperation,
        getUptimeBreakdown, getCycleDelta, getPeriodBreakdown, getSiteAnalyticsData,
        getSiteInsights, getActivityLog,
        getGlobalInsights, getGlobalActivityLog, getMonthlyReport, getSiteReport, getSiteMonthsReport,
        getSupervisorStats, getExecutiveStats, getExecutiveStatsFiltered,
        getRecentErrors, getActiveMaintenances,
        ensureAdminCode, verifyAdminCode, setAdminCode,
        updateSite, deleteSite } = require("../db/queries");
const db = require("../db/db");
const bus = require("../bus");
// שכבת האימות. מאחורי seam — ראה auth/provider.js. היום היא מאמתת בלבד
// (verifyToken) ואינה מנפיקה: ההנפקה במצב Supabase קורית בדפדפן.
const auth = require("../auth/provider");
const adminUsers = require("../auth/admin");   // ניהול משתמשים — המקום היחיד שנוגע במפתח ה-Secret
const { cache } = require("./cache");
const { resolvePeriod } = require("./periods");
const { runChat, isChatConfigured } = require("../ai/chat");

const app = express();

// סומכים רק על proxy מקומי (loopback) לצורך X-Forwarded-For. כך req.ip נכון
// כשהדשבורד עובר דרך ה-proxy של Vite (localhost), ובו-זמנית לקוח חיצוני לא יכול
// לזייף כתובת דרך הכותרת ולעקוף את מגביל-הקצב של הצ'אט. לא סומכים על proxy
// שרירותי — הגדרה שמרנית ובטוחה כברירת מחדל.
app.set("trust proxy", "loopback");

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
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || "http://localhost:5173";

// מסתיר ערכים רגישים מ-URL לפני כתיבתו ללוג.
//
// ⚠️ מוחלף ולא נמחק: "?access_token=***" אומר שהייתה שם הזדהות, בעוד
// URL קטוע נראה כמו בקשה שגויה ומטעה את מי שמנתח לוג.
function redactUrl(url) {
  return String(url).replace(/([?&](?:access_token|token)=)[^&]*/gi, "$1***");
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
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
// מגביל קצב לניחוש קוד המנהל
// ============================================================
// הקוד הוא סוד משותף אחד, ההשוואה שלו זולה, ולכן בלי הגבלה אפשר לנחש
// אותו בקצב הרשת. עשרה ניסיונות לחמש דקות לכל IP: מספיק בנדיבות למי
// שהקליד שגוי פעם-פעמיים, וסוגר ניחוש שיטתי.
//
// ⚠️ אינו תחליף לאימות אמיתי, וגם לא מתיימר: תוקף עם כמה כתובות עוקף
// אותו. הוא מעלה את המחיר של ניחוש עיוור על ברירת המחדל החלשה, עד
// ש-Supabase Auth יאכף באמת (ראה auth/provider.js).
//
// המפה מנוקה בעצלתיים באותה תבנית כמו מגביל הצ'אט — בלעדיה היא גדלה
// לנצח עם כל IP שאי-פעם ניסה.
const ADMIN_RATE_LIMIT = 10;
const ADMIN_RATE_WINDOW_MS = 5 * 60_000;
const adminHits = new Map();

function adminRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const hits = (adminHits.get(ip) || []).filter((t) => now - t < ADMIN_RATE_WINDOW_MS);

  if (hits.length >= ADMIN_RATE_LIMIT) {
    const retryMs = ADMIN_RATE_WINDOW_MS - (now - hits[0]);
    res.set("Retry-After", String(Math.ceil(retryMs / 1000)));
    console.warn(`[api] חסימת קצב על ניסיונות קוד מנהל מ-${ip}`);
    return res.status(429).json({
      error: `יותר מדי ניסיונות. נסי שוב בעוד ${Math.ceil(retryMs / 60_000)} דקות.`,
    });
  }

  hits.push(now);
  adminHits.set(ip, hits);

  if (adminHits.size > 500) {
    for (const [key, times] of adminHits) {
      if (times.every((t) => now - t >= ADMIN_RATE_WINDOW_MS)) adminHits.delete(key);
    }
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

  // אנונימי — מותר לפי ההחלטה. מסומן ככזה כדי שהלוג לא ייראה כמו זהות.
  req.actor = { userId: null, name: null, role: null, trust: "anonymous" };

  // כדי להפוך את הנתיב לחוסם (אחרי שיהיו משתמשים), הסירו את ההערה:
  // return res.status(401).json({ error: "נדרשת הזדהות" });

  return next();
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
async function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: "נדרשת התחברות" });

  const actor = await auth.verifyToken(token);
  if (!actor) return res.status(401).json({ error: "אסימון לא תקין או שפג" });

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

  req.actor = { userId: actor.userId, name: actor.email || actor.userId,
                role: actor.role, trust: "token" };
  next();
}

// ============================================================
// מגביל קצב להזמנות
// ============================================================
// ההזמנה פתוחה לכל מחובר, ולכן חשבון אחד שנפרץ או משתמש אחד לא זהיר יכול
// לייצר מאה חשבונות בלופ. עשר לשעה הוא מעל ומעבר לשימוש אמיתי (מי מזמין
// עשרה אנשים בשעה?) וחוסם לופ.
const INVITE_RATE_LIMIT = 10;
const INVITE_RATE_WINDOW_MS = 60 * 60_000;
const inviteHits = new Map();

function inviteRateLimit(req, res, next) {
  // המפתח הוא **המשתמש** ולא ה-IP: הגבלה לפי IP הייתה חוסמת משרד שלם
  // מאחורי NAT אחד, ובו-זמנית לא חוסמת מי שמחליף רשתות.
  const who = req.actor?.userId || req.ip || "unknown";
  const now = Date.now();
  const hits = (inviteHits.get(who) || []).filter((t) => now - t < INVITE_RATE_WINDOW_MS);

  if (hits.length >= INVITE_RATE_LIMIT) {
    const retryMs = INVITE_RATE_WINDOW_MS - (now - hits[0]);
    res.set("Retry-After", String(Math.ceil(retryMs / 1000)));
    console.warn(`[users] חסימת קצב על הזמנות מ-${req.actor?.name || who}`);
    return res.status(429).json({
      error: `יותר מדי הזמנות. נסי שוב בעוד ${Math.ceil(retryMs / 60_000)} דקות.`,
    });
  }

  hits.push(now);
  inviteHits.set(who, hits);

  if (inviteHits.size > 500) {
    for (const [k, times] of inviteHits) {
      if (times.every((t) => now - t >= INVITE_RATE_WINDOW_MS)) inviteHits.delete(k);
    }
  }
  next();
}

// ============================================================
// POST /api/users/invite — כל מי שמחובר יכול לצרף מישהו
// ============================================================
// החלטת מוצר. מה שמאזן אותה, כמו בתחזוקה, הוא **ייחוס**: כל הזמנה נרשמת
// עם מי הזמין את מי. בשונה מהתחזוקה, כאן הזהות מאומתת ולא מוצהרת — כי
// requireAuth דורש אסימון.
//
// ⚠️ מה שההחלטה אומרת בפועל: ההרשאה להזמין היא **מדבקת**. כל מוזמן יכול
// להזמין הלאה, ולכן חשבון אחד מספיק כדי לצרף את העולם — בשרשרת ולא
// בקריאה אחת. התפקיד שנוצר הוא תמיד operator (ראה auth/admin.js), ולכן
// אין הסלמת הרשאות; אבל operator רואה את כל נתוני האתרים.
app.post("/api/users/invite", requireAuth, inviteRateLimit, async (req, res) => {
  try {
    const result = await adminUsers.createUser(req.body?.email);

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    // שורת הביקורת. זה כל מה שעומד בין "נוצר חשבון" ל"אין לנו מושג מי
    // צירף אותו" — וכאן, בשונה מהתחזוקה, השם מאומת.
    console.log(
      `[users] ${req.actor.name} (${req.actor.userId}) הזמין את ${result.user.email} ` +
      `בתפקיד ${result.user.role}`);

    res.json({
      ok: true,
      user: result.user,
      // הסיסמה הזמנית מוחזרת פעם אחת בלבד ואינה נשמרת אצלנו. המזמין מעביר
      // אותה, והמוזמן מחליף. ראה ההסבר על SMTP ב-auth/admin.js.
      tempPassword: result.tempPassword,
      message: `נוצר משתמש ${result.user.email}. העבירו לו את הסיסמה הזמנית — היא מוצגת פעם אחת.`,
    });
  } catch (err) {
    console.error("[api] שגיאה ב-POST /api/users/invite:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/users — מי כבר במערכת. פתוח לכל מחובר, כמו ההזמנה עצמה:
// מי שיכול לצרף צריך לדעת את מי כבר צירפו, אחרת הוא מזמין כפולים.
app.get("/api/users", requireAuth, async (req, res) => {
  try {
    const result = await adminUsers.listUsers();
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ users: result.users });
  } catch (err) {
    console.error("[api] שגיאה ב-GET /api/users:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// POST /api/admin/verify — בדיקת קוד (לפתיחת מצב ניהול ב-UI)
app.post("/api/admin/verify", adminRateLimit, async (req, res) => {
  try {
    if (!await verifyAdminCode(req.body?.code)) {
      return res.status(401).json({ error: "קוד מנהל שגוי" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[api] שגיאה ב-admin/verify:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// POST /api/admin/code — שינוי קוד המנהל
// ⚠️ adminRateLimit נוסף כאן אחרי ביקורת: הנתיב הזה מאמת את הקוד הנוכחי
// לפני שהוא מחליף אותו, כלומר הוא **אורקל ניחוש** בדיוק כמו /admin/verify —
// אבל הוא היה היחיד בלי הגבלת קצב. מי שרצה לנחש את הקוד היה פשוט תוקף כאן
// במקום שם, וכל ההגנה של /verify הייתה מעוקפת בשינוי כתובת אחת.
app.post("/api/admin/code", adminRateLimit, async (req, res) => {
  try {
    const { currentCode, newCode } = req.body || {};

    if (!await verifyAdminCode(currentCode)) {
      return res.status(401).json({ error: "הקוד הנוכחי שגוי" });
    }
    if (typeof newCode !== "string" || newCode.trim().length < 4) {
      return res.status(400).json({ error: "הקוד החדש חייב להכיל לפחות 4 תווים" });
    }

    await setAdminCode(newCode.trim());
    console.log("[api] קוד המנהל שונה");
    res.json({ ok: true, message: "הקוד עודכן" });
  } catch (err) {
    console.error("[api] שגיאה ב-admin/code:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// PATCH /api/sites/:code — עדכון שם ו/או קוד האתר
app.patch("/api/sites/:code", requireAdmin, async (req, res) => {
  try {
    const { site_name, code: newCode, tier, plc_type } = req.body || {};

    if (newCode !== undefined) {
      if (typeof newCode !== "string" || !SITE_CODE_PATTERN.test(newCode.trim())) {
        return res.status(400).json({
          error: "קוד אתר לא תקין — 1 עד 64 תווים מהסוג A-Z a-z 0-9 _ - בלבד",
        });
      }
    }

    const name = typeof site_name === "string" ? site_name.trim() : undefined;
    if (site_name !== undefined && !name) {
      return res.status(400).json({ error: "שם האתר לא יכול להיות ריק" });
    }

    if (tier !== undefined && !VALID_TIERS.includes(tier)) {
      return res.status(400).json({ error: "דרגת אתר לא תקינה" });
    }

    // ⚠️ אותה ולידציה בדיוק כמו ברישום. עריכה שמקבלת ערכים שהרישום דוחה
    // הייתה פרצה בדלת האחורית: הרשימה הסגורה נאכפת פעם אחת ונעקפת בשנייה.
    if (plc_type !== undefined && !isValidSiteType(plc_type)) {
      return res.status(400).json({ error: "סוג מתקן לא תקין" });
    }

    // ⚠️ `undefined` נשמר כ-`undefined` (השדה לא נשלח → לא נוגעים בו), אבל
    // מחרוזת ריקה **נשמרת כמחרוזת ריקה** ולא הופכת ל-undefined — היא
    // הבקשה המפורשת לנקות את השדה. ההמרה ל-NULL קורית ב-updateSite.
    const trimOrKeep = (v) => (typeof v === "string" ? v.trim() : undefined);

    const result = await updateSite(req.params.code, {
      newCode: newCode?.trim(),
      siteName: name,
      tier,
      plcType: trimOrKeep(plc_type),
    });

    if (!result.ok) {
      if (result.reason === "not_found") {
        return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
      }
      if (result.reason === "code_taken") {
        return res.status(409).json({ error: "כבר קיים אתר עם הקוד החדש" });
      }
    }

    bus.publish({ type: "registered", code: result.site.code });
    console.log(`[api] אתר עודכן: ${req.params.code} → ${result.site.code} (${result.site.site_name})`);
    res.json({ ok: true, site: result.site });
  } catch (err) {
    console.error("[api] שגיאה ב-PATCH site:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// DELETE /api/sites/:code — מחיקת אתר וכל ההיסטוריה שלו
app.delete("/api/sites/:code", requireAdmin, async (req, res) => {
  try {
    const result = await deleteSite(req.params.code);
    if (!result.ok) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    bus.publish({ type: "registered", code: req.params.code });
    console.log(
      `[api] אתר נמחק: ${result.deleted.code} (${result.deleted.name}) — ` +
      `${result.deleted.operations} פעולות, ${result.deleted.statusHistory} שינויי מצב`
    );
    res.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    console.error("[api] שגיאה ב-DELETE site:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// ה-CORS עבר לראש הקובץ — הוא חייב לרוץ לפני המטמון ולפני כל מסלול.
// ראה ההסבר שם.

// קוד אתר חוקי. הקוד מגיע מה-topic (sites/{code}/state), ולכן אסור שיכיל '/'
// או את תווי ה-wildcard '+' ו-'#' — אחרת אתר אחד יוכל להתחזות לנושאים של אחר.
const SITE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// דרגת אתר (רמת שירות) — נבחרת ברישום ונערכת בניהול. הרשימה הסגורה נאכפת כאן.
const VALID_TIERS = ["vip", "extended", "basic"];

// ⚠️ סוג המתקן מגיע מ-shared/site-types.mjs ולא מרשימה מקומית — אותה רשימה
// בדיוק מזינה את ה-SELECT בטופס ואת התווית על הכרטיס. רשימה שנייה כאן הייתה
// מאפשרת לטופס להציע ערך שהשרת דוחה.
const { isValidSiteType } = require("../../shared/site-types.mjs");

// עוטף אתר: המצב הוא "maintenance" אם PLC שלח maintenance או שיש תחזוקה ידנית (OR)
async function applyMaintenanceStatus(site) {
  const manualMaintenance = await getActiveMaintenance(site.id);   // מקור 1: ידני (טבלת maintenance_windows)
  const plcMaintenance = site.status === "maintenance";       // מקור 2: PLC (כבר ב-sites.status)

  if (manualMaintenance || plcMaintenance) {
    return { ...site, status: "maintenance" };
  }
  return site;
}

// GET /api/sites — רשימת כל האתרים עם המצב הנוכחי + מדדים (אחוז כשל, פעולות, תקלות)
app.get("/api/sites", requireAuth, cache(), async (req, res) => {
  try {
    // אחוז כשל ופעולות מחושבים על 7 הימים האחרונים (שבועי) — *אותה* הגדרה
    // בדיוק כמו התקופה 'week' של הפאנל/הגרף (resolvePeriod): 7 ימים קלנדריים
    // כולל היום, מיושר לחצות. קודם היה כאן חלון מתגלגל של 168 שעות (לא מיושר
    // לחצות), שנתן לאותו אתר מדד שונה במקצת מהמוצג בפאנל — הכרטיס והפאנל לא
    // הסכימו. עכשיו מקור אחד לכולם.
    const weekFrom = resolvePeriod("week").range.from;

    // היה כאן N+1: ~6 שאילתות *לכל אתר* (מדדים, זמינות, תקלה אחרונה, פעולה
    // אחרונה, מצב נוכחי, תחזוקה). מול Postgres מרוחק זה סיבוב רשת לכל אחת.
    // getAllSitesWithMetrics עושה את אותו הדבר במספר שאילתות קבוע.
    // prevFrom — השבוע שלפני, לחישוב "משתפר/מחמיר" על כל כרטיס.
    const sites = await getAllSitesWithMetrics({
      from: weekFrom,
      prevFrom: resolvePeriod("week").prev.from,
    });

    res.json(sites);
  } catch (err) {
    console.error("[api] שגיאה ב-GET /api/sites:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// POST /api/sites — רישום אתר חדש (קוד + שם)
// הרישום הוא השער לקליטה: ה-dispatcher דוחה הודעות מאתר שאינו רשום,
// כך שרק אחרי הרישום כאן מתחיל המידע מהאתר להישמר.
app.post("/api/sites", requireAdmin, async (req, res) => {
  try {
    const { code, site_name, plc_type, tier } = req.body;

    if (typeof code !== "string" || !SITE_CODE_PATTERN.test(code)) {
      return res.status(400).json({
        error: "קוד אתר לא תקין — 1 עד 64 תווים מהסוג A-Z a-z 0-9 _ - בלבד",
      });
    }

    const name = typeof site_name === "string" ? site_name.trim() : "";
    if (!name) {
      return res.status(400).json({ error: "חסר שם אתר (site_name)" });
    }

    // דרגה: אם נשלחה, חייבת להיות מהרשימה הסגורה; אחרת ברירת מחדל 'basic'.
    if (tier !== undefined && !VALID_TIERS.includes(tier)) {
      return res.status(400).json({ error: "דרגת אתר לא תקינה" });
    }

    // ⚠️ הסוג **אינו חובה** — אפשר לרשום אתר בלי לדעת אותו, וזה המצב בשטח
    // כשמתקינים בערב. מה שנדחה הוא ערך שאינו ברשימה: כלומר טעות, לא חוסר.
    //
    // ⚠️ ונאכף **בשרת** ולא רק ב-SELECT: הטופס אינו הדרך היחידה להגיע לכאן
    // (יש גם כלי הוספה בשורת פקודה), ורשימה סגורה שנאכפת רק במסך אחד היא
    // רשימה פתוחה בפועל.
    if (!isValidSiteType(plc_type)) {
      return res.status(400).json({ error: "סוג מתקן לא תקין" });
    }

    if (await findSiteByCode(code)) {
      return res.status(409).json({ error: "אתר עם קוד זה כבר רשום", code });
    }

    // מטא-דאטה אופציונלי לתצוגה. ריק → null, כדי לא לשמור מחרוזות ריקות.
    const optional = (value) =>
      typeof value === "string" && value.trim() ? value.trim() : null;

    await insertSite(code, name, {
      plcType: optional(plc_type),
      tier: tier || "basic",
    });
    const site = await findSiteByCode(code);

    // מודיעים ללקוחות ה-SSE שנוסף אתר, כדי שירעננו את הרשימה בלי המתנה
    // להודעת ה-MQTT הראשונה (שעשויה לאחר דקות, עד שהאתר ידווח).
    bus.publish({
      type: "registered",
      code: site.code,
      siteName: site.site_name,
      registeredAt: site.registered_at,
    });

    console.log(`[api] אתר נרשם: ${site.code} (${site.site_name})`);
    res.status(201).json({ ok: true, site });
  } catch (err) {
    console.error("[api] שגיאה ב-POST /api/sites:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/sites/:code — פרטי אתר בודד + operations אחרונות
app.get("/api/sites/:code", requireAuth, cache(), async (req, res) => {
  try {
    const site = await findSiteByCode(req.params.code);

    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    // 7 הימים האחרונים (שבועי) — *אותה* הגדרה כמו התקופה 'week' של הפאנל/הגרף
    // (resolvePeriod), לא חלון מתגלגל של 168 שעות. כך המדדים כאן זהים לאלה
    // שהפאנל מציג לאותו אתר. ראה ההסבר ב-GET /api/sites.
    const weekFrom = resolvePeriod("week").range.from;

    // כל השאילתות תלויות רק ב-site.id — בלתי-תלויות זו בזו, ולכן במקביל.
    // קודם הן רצו בטור (~11 סיבובי רשת = ~1.7 שניות); עכשיו סיבוב אחד.
    // await חיוני על applyMaintenanceStatus: פריסה (spread) של Promise נותנת
    // אובייקט ריק בלי שגיאה — כל פרטי האתר היו נעלמים בשקט מהתגובה.
    const [
      stats, operations, statusSince, statusHistory, maintenanceHistory,
      siteWithMaintenance, uptime, lastFaultAt, lastOperation,
    ] = await Promise.all([
      getSiteStats(site.id, { from: weekFrom }),
      getRecentOperations(site.id),
      getCurrentStatusSince(site.id),            // מתי המצב הנוכחי התחיל
      getStatusHistory(site.id),                 // לוג 10 שינויי המצב האחרונים
      getMaintenanceHistory(site.id),            // חלונות תחזוקה (מי הפעיל, משך)
      applyMaintenanceStatus(site),
      getSiteUptime(site.id, weekFrom),
      getLastFaultAt(site.id),
      getLastOperation(site.id),
    ]);

    res.json({
      site: {
        ...siteWithMaintenance,
        statusSince,
        failureRate: stats.failureRate,
        operations: stats.operations,
        errors: stats.errors,
        uptime,
        lastFaultAt,
        lastOperation,
      },
      operations,
      statusHistory,
      maintenanceHistory,
    });
  } catch (err) {
    console.error("[api] שגיאה ב-GET /api/sites/:code:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/events — operations מסוננות (site_code, from, to, limit)
app.get("/api/events", requireAuth, async (req, res) => {
  try {
    const { site_code, from, to, limit } = req.query;

    const operations = await getFilteredOperations({
      siteCode: site_code,
      from: from,
      to: to,
      limit: limit ? Number(limit) : undefined,
    });

    res.json({ count: operations.length, operations });
  } catch (err) {
    console.error("[api] שגיאה ב-GET /api/events:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/sites/:code/stats — מדדים: אחוז כשל, errors, operations
app.get("/api/sites/:code/stats", requireAuth, cache(), async (req, res) => {
  try {
    const site = await findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const { from, to } = req.query;
    const stats = await getSiteStats(site.id, { from: from || null, to: to || null });

    res.json({ code: site.code, ...stats });
  } catch (err) {
    console.error("[api] שגיאה ב-GET stats:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

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

// ============================================================
// POST /api/sites/:code/maintenance — מוגן ב-requireSiteAccess
// ============================================================
// היה **פתוח לחלוטין**, וזה היה החור החמור ביותר ב-API. תחזוקה אינה
// תווית: היא מדכאת רישום תקלות לגמרי (הודעת error בזמן תחזוקה נזרקת
// ואינה נרשמת ב-status_history, אינה נספרת ואינה מתריעה) והיא מוחרגת
// ממכנה הזמינות. כלומר כל מי שהגיע ל-API יכול היה להשתיק אתר אמיתי עד
// 30 יום בקריאה אחת — והמערכת הייתה מציגה אותו כתקין.
//
// ההגנה היא **הזדהות ולא הרשאת מנהל**, לפי החלטת המוצר: מי שיש לו גישה
// לאתר מוסמך להפעיל תחזוקה. ראה requireSiteAccess.
//
// ⚠️ מה שההחלטה הזו אומרת בפועל, ושווה להכיר: כל משתמש מאומת יכול להשתיק
// כל אתר עד 30 יום. מה שמאזן את זה הוא התיעוד — set_by_name נרשם, ומעכשיו
// הוא נלקח מהזהות (req.actor) ולא מטקסט חופשי שהלקוח שולח. כלומר הפעולה
// אינה חסומה אך היא **מיוחסת**.
app.post("/api/sites/:code/maintenance", identifyActor, async (req, res) => {
  try {
    const site = await findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const { name, duration_hours, reason } = req.body || {};

    // ============================================================
    // מי הפעיל — מהזהות אם יש, ומהגוף רק כשאין
    // ============================================================
    // תחזוקה פתוחה לכל אחד (החלטת מוצר), ולכן התיעוד הוא מה שמאזן אותה.
    // אסימון מביא שם מאומת וגובר; טקסט חופשי מהלקוח הוא הצהרה בלבד ולכן
    // נדחק למקום השני — אבל הוא **חובה**, וזה הכלל שהופך "כל אחד יכול"
    // ל"כל אחד יכול, ואנחנו יודעים מי".
    const setBy = req.actor?.name || name;

    if (!setBy || typeof setBy !== "string" || !setBy.trim()) {
      return res.status(400).json({ error: "חסר שם (name)" });
    }
    // Number.isFinite ולא !duration_hours: Infinity עובר את בדיקת ה-falsy
    if (!Number.isFinite(duration_hours) || duration_hours <= 0 ||
        duration_hours > MAX_MAINTENANCE_HOURS) {
      return res.status(400).json({
        error: `משך לא תקין (duration_hours) — מספר בין 0 ל-${MAX_MAINTENANCE_HOURS} שעות`,
      });
    }

    const result = await startMaintenance(
      site.id, setBy.trim(), duration_hours, reason || null, req.actor?.role || null);

    // ============================================================
    // שורת ביקורת — זה מה שהופך "ייחוס" ממילה למשהו שאפשר לבדוק
    // ============================================================
    // תחזוקה משתיקה אתר עד 30 יום ומוחרגת ממכנה הזמינות. כשהפעולה פתוחה
    // לכולם, הדבר היחיד שעומד בין "מישהו השתיק אתר" ל"אין לנו מושג מי" הוא
    // השורה הזו. trust נרשם במפורש: "anonymous" אומר שהשם הוא הצהרה בלבד,
    // ולא זהות שאומתה. אל תסירו אותו — בלעדיו כל השמות נראים אמינים במידה שווה.
    console.log(
      `[maintenance] אתר ${site.code}: הופעלה ל-${duration_hours} שעות ` +
      `ע"י "${setBy.trim()}" (אמון: ${req.actor?.trust || "unknown"}, ` +
      `IP: ${req.ip || "?"})${reason ? ` — ${reason}` : ""}`);

    // חובה לשדר: תחזוקה משנה את המצב האפקטיבי של האתר (applyMaintenanceStatus),
    // ובלי האירוע הזה המטמון לא מתנקה ושאר הדשבורדים לא יודעים.
    bus.publish({ type: "maintenance", code: site.code, action: "start" });

    res.json({
      ok: true,
      message: `תחזוקה הופעלה על אתר ${site.code}`,
      maintenance: result,
    });
  } catch (err) {
    console.error("[api] שגיאה ב-POST maintenance:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// DELETE /api/sites/:code/maintenance — ביטול תחזוקה פעילה. אותה הגנה
// בדיוק: ביטול מחזיר אתר לספירת התקלות ולמכנה הזמינות, ולכן הוא משנה
// מספרים בדוחות בדיוק כמו ההפעלה.
app.delete("/api/sites/:code/maintenance", identifyActor, async (req, res) => {
  try {
    const site = await findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const result = await cancelMaintenance(site.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: "אין תחזוקה פעילה לביטול" });
    }

    // ביטול משנה מספרים בדוחות בדיוק כמו הפעלה — הוא מחזיר את האתר לספירת
    // התקלות ולמכנה הזמינות. לכן הוא מתועד באותה מידה.
    console.log(
      `[maintenance] אתר ${site.code}: בוטלה ע"י ` +
      `"${req.actor?.name || "לא צוין"}" (אמון: ${req.actor?.trust || "unknown"}, ` +
      `IP: ${req.ip || "?"})`);

    bus.publish({ type: "maintenance", code: site.code, action: "cancel" });

    res.json({ ok: true, message: `תחזוקה בוטלה על אתר ${site.code}` });
  } catch (err) {
    console.error("[api] שגיאה ב-DELETE maintenance:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/sites/:code/maintenance — בדיקת תחזוקה פעילה
app.get("/api/sites/:code/maintenance", requireAuth, cache(), async (req, res) => {
  try {
    const site = await findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const active = await getActiveMaintenance(site.id);
    res.json({
      code: site.code,
      inMaintenance: !!active,
      maintenance: active || null,
    });
  } catch (err) {
    console.error("[api] שגיאה ב-GET maintenance:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/stats/system — סיכום מערכתי (כל האתרים) עבור המנהל הכללי
app.get("/api/stats/system", requireAuth, cache(), async (req, res) => {
  try {
    const { month, year, from, to } = req.query;

    const summary = await getSystemSummary({
      yearMonth: month || null,
      year: year || null,
      from: from || null,
      to: to || null,
    });

    res.json(summary);
  } catch (err) {
    console.error("[api] שגיאה ב-GET /api/stats/system:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/stats/system/monthly — פירוט חודשי (לגרף מגמות)
app.get("/api/stats/system/monthly", requireAuth, cache(), async (req, res) => {
  try {
    const { year, from, to } = req.query;

    const breakdown = await getSystemMonthlyBreakdown({
      year: year || null,
      from: from || null,
      to: to || null,
    });

    res.json({ months: breakdown });
  } catch (err) {
    console.error("[api] שגיאה ב-GET /api/stats/system/monthly:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});


// ===== אנליטיקה לפי תקופה =====

// resolvePeriod עבר ל-api/periods.js (ראה require בראש הקובץ) — כדי שעוזר ה-AI
// ישתמש *באותה* הגדרת תקופה בדיוק, ולא ידווח מספרים שאינם תואמים למסך.

// אחוז השינוי מול התקופה הקודמת. null כשאין בסיס להשוואה (חלוקה באפס).
function percentChange(current, previous) {
  if (!Number.isFinite(previous) || previous === 0) {
    return current === 0 ? 0 : null;
  }
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// GET /api/sites/:code/analytics?period=week|month|year
app.get("/api/sites/:code/analytics", requireAuth, cache(), async (req, res) => {
  try {
    const site = await findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const p = resolvePeriod(req.query.period);

    // תקופה נוכחית + השוואה + גרף — הכל משליפה אחת של הנתונים הגולמיים
    // (loadRangeData, 3 שאילתות) ומחושב בזיכרון. קודם היו כאן 5 קריאות =
    // ~14 שאילתות; עכשיו findSiteByCode(1) + 3 = 4. אותן פונקציות טהורות,
    // אותם מספרים.
    const { stats, uptime, chart, prevStats, prevUptime } =
      await getSiteAnalyticsData(site.id, {
        range: p.range, prev: p.prev, granularity: p.granularity,
      });

    // האם בכלל היו נתונים בתקופה הקודמת? בלי זה אין משמעות לחץ מגמה.
    const hasComparison =
      prevStats.operations > 0 || prevStats.errors > 0 || prevUptime.totalHours > 0;

    const trendOf = (current, previous) => ({
      current,
      previous,
      changePercent: hasComparison ? percentChange(current, previous) : null,
    });

    res.json({
      period: p.period,
      label: p.label,
      comparisonLabel: p.comparisonLabel,
      hasComparison,
      range: p.range,
      stats,
      uptime,
      cycles: {
        // null — טבלת operations אינה שומרת את מונה הבקר לכל הודעה (ראה getCycleDelta)
        deltaInPeriod: getCycleDelta(site.id, p.range),
        totalFromPLC: site.plc_cycle_last,   // המונה הגולמי של הבקר
        countedTotal: site.cycle_total,      // מה שנספר מאז ההתקנה
      },
      trend: {
        operations: trendOf(stats.operations, prevStats.operations),
        errors: trendOf(stats.errors, prevStats.errors),
        failureRate: trendOf(stats.failureRate, prevStats.failureRate),
        availability: trendOf(uptime.availabilityPercent, prevUptime.availabilityPercent),
      },
      chart,
    });
  } catch (err) {
    console.error("[api] שגיאה ב-GET analytics:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/sites/:code/insights?period=week|month|year — סטטיסטיקה מעמיקה ("עוד מידע")
app.get("/api/sites/:code/insights", requireAuth, cache(), async (req, res) => {
  try {
    const site = await findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const p = resolvePeriod(req.query.period);
    // שני המקורות בלתי-תלויים — במקביל במקום בטור.
    const [insights, log] = await Promise.all([
      getSiteInsights(site.id, p.range),
      getActivityLog(site.id, { ...p.range, limit: 300 }),
    ]);

    res.json({
      period: p.period,
      label: p.label,
      range: p.range,
      ...insights,
      log,
    });
  } catch (err) {
    console.error("[api] שגיאה ב-GET insights:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/insights?period=week|month|year — אותה סטטיסטיקה מעמיקה, אך *מצרפת
// על כל האתרים* (מנהל כללי → "כל האתרים"). אין :code — זה המצרף הכלל-מערכתי.
app.get("/api/insights", requireAuth, cache(), async (req, res) => {
  try {
    const p = resolvePeriod(req.query.period);
    const [insights, log] = await Promise.all([
      getGlobalInsights(p.range),
      getGlobalActivityLog({ ...p.range, limit: 300 }),
    ]);

    res.json({
      period: p.period,
      label: p.label,
      range: p.range,
      ...insights,
      log,
    });
  } catch (err) {
    console.error("[api] שגיאה ב-GET insights גלובלי:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// ==========================================================
// GET /api/report/monthly?from=YYYY-MM-DD&to=YYYY-MM-DD[&site=<code>]
// ==========================================================
// דוח לטווח תאריכים חופשי: כמה פעולות וכמה תקלות בכל חודש.
//
// ⚠️ ללא cache(): טווח חופשי הוא צירוף פתוח, ומטמון שמפתחו רשימת-היתר של
// פרמטרים היה מגיש דוח של טווח אחד תחת טווח אחר.
app.get("/api/report/monthly", requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: "נדרשים from ו-to בפורמט YYYY-MM-DD" });
    }
    // ⚠️ **חצות מקומית, לא חצות UTC.** כל המערכת מיושרת לשעון המקומי
    // (api/periods.js, resolveRange), ו-`T00:00:00.000Z` היה מזיז את הגבול
    // בשלוש שעות בישראל — כלומר מוריד מהדוח כל פעולה שקרתה בין חצות לשלוש.
    //
    // ⚠️ ו-to כולל את היום כולו: המשתמשת בוחרת "עד 4.8" ומתכוונת שה-4.8
    // בפנים. בלי זה כל פעולה מאותו יום נעלמת — וזה בדיוק היום שהיא בדקה.
    const [fy, fm, fd] = String(from).slice(0, 10).split("-").map(Number);
    const [ty, tm, td] = String(to).slice(0, 10).split("-").map(Number);
    if (!fy || !fm || !fd || !ty || !tm || !td) {
      return res.status(400).json({ error: "תאריך לא תקין — נדרש YYYY-MM-DD" });
    }
    const fromIso = new Date(fy, fm - 1, fd, 0, 0, 0, 0).toISOString();
    const toIso = new Date(ty, tm - 1, td, 23, 59, 59, 999).toISOString();
    if (!(fromIso < toIso)) {
      return res.status(400).json({ error: "טווח לא תקין — from חייב להקדים את to" });
    }

    let siteIds = null;
    if (req.query.site) {
      const site = await findSiteByCode(String(req.query.site));
      if (!site) return res.status(404).json({ error: "אתר לא נמצא", code: req.query.site });
      siteIds = [site.id];
    }

    // שני החתכים מאותו טווח, בקריאה אחת: לפי חודש ולפי אתר. הם עונים על
    // שתי שאלות שונות ("איך זה התפתח" מול "מי בעייתי"), ומי שמפיק דוח רוצה
    // בדרך כלל את שתיהן — שתי בקשות נפרדות היו רק סיבוב רשת מיותר.
    const [months, sites, siteMonths] = await Promise.all([
      getMonthlyReport({ siteIds, from: fromIso, to: toIso }),
      getSiteReport({ siteIds, from: fromIso, to: toIso }),
      getSiteMonthsReport({ siteIds, from: fromIso, to: toIso }),
    ]);

    res.json({ from: fromIso, to: toIso, site: req.query.site || null, months, sites, siteMonths });
  } catch (err) {
    console.error("[api] שגיאה ב-GET report/monthly:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

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

// GET /api/sites/:code/activity — לוג הפעילות של אתר בודד, עם סינון ודפדוף
app.get("/api/sites/:code/activity", requireAuth, async (req, res) => {
  try {
    const site = await findSiteByCode(req.params.code);
    if (!site) return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });

    const p = resolvePeriod(req.query.period);
    res.json(await getActivityLog(site.id, { ...p.range, ...logParams(req) }));
  } catch (err) {
    console.error("[api] שגיאה ב-GET activity:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/activity — אותו לוג, מצרף על כל האתרים.
//
// ⚠️ אין כאן `?site=`, בכוונה: `/api/sites/:code/activity` כבר עושה בדיוק את
// זה. פרמטר שני לאותה יכולת היה שני מסלולים שצריך לתחזק במקביל, ואחד מהם
// היה מתיישן בשקט.
app.get("/api/activity", requireAuth, async (req, res) => {
  try {
    const p = resolvePeriod(req.query.period);
    res.json(await getGlobalActivityLog({ ...p.range, ...logParams(req) }));
  } catch (err) {
    console.error("[api] שגיאה ב-GET activity גלובלי:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
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
  const ip = req.ip || req.socket.remoteAddress || "unknown";
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

app.post("/api/chat", chatRateLimit, async (req, res) => {
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

// ===== ממשקי הניהול =====

// GET /api/stats/supervisor?period=week|month|year — נתונים תפעוליים למנהל בקרה
app.get("/api/stats/supervisor", requireAuth, cache(), async (req, res) => {
  try {
    const p = resolvePeriod(req.query.period);
    const { sites, summary } = await getSupervisorStats(p.range);

    res.json({
      period: p.period,
      label: p.label,
      range: p.range,
      sites,
      summary,
      recentErrors: await getRecentErrors({ limit: 10 }),
      activeMaintenances: await getActiveMaintenances(),
    });
  } catch (err) {
    console.error("[api] שגיאה ב-GET supervisor:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// ===== טווח מותאם אישית =====

const DAY_MS = 24 * 60 * 60 * 1000;
const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
                   "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

/**
 * מפרש טווח מהבקשה. אם נשלחו from/to → טווח מותאם; אחרת נופל חזרה
 * ל-period (תאימות אחורה מלאה עם הקוד הקיים).
 * מחזיר null אם הטווח לא תקין — מי שקורא מחזיר 400.
 */
function resolveRange(query) {
  if (!query.from || !query.to) return resolvePeriod(query.period);

  // תאריכים מגיעים כ-YYYY-MM-DD (input type="date"). מפרשים בשעון מקומי,
  // ו-to כולל את היום כולו (עד סופו).
  const [fy, fm, fd] = String(query.from).split("-").map(Number);
  const [ty, tm, td] = String(query.to).split("-").map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return null;

  const from = new Date(fy, fm - 1, fd, 0, 0, 0, 0);
  let to = new Date(ty, tm - 1, td, 23, 59, 59, 999);

  if (!(from < to)) return null;

  // לא סופרים אל תוך העתיד
  const now = new Date();
  if (to > now) to = now;

  const days = Math.max(1, Math.round((to - from) / DAY_MS));

  // רזולוציה: מה שנבחר, אחרת נבחרת אוטומטית לפי אורך הטווח
  const allowed = ["day", "week", "month"];
  const granularity = allowed.includes(query.granularity)
    ? query.granularity
    : days <= 31 ? "day" : days <= 180 ? "week" : "month";

  const fmt = (d) => `${d.getDate()} ב${HE_MONTHS[d.getMonth()]}`;
  const label =
    from.getFullYear() === to.getFullYear()
      ? `${fmt(from)} – ${fmt(to)} ${to.getFullYear()}`
      : `${fmt(from)} ${from.getFullYear()} – ${fmt(to)} ${to.getFullYear()}`;

  // תקופת ההשוואה: טווח באותו אורך שקדם לו
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(from.getTime() - (to - from));

  return {
    period: "custom",
    label,
    daysCount: days,
    comparisonLabel: `לעומת ${days} הימים שקדמו`,
    granularity,
    range: { from: from.toISOString(), to: to.toISOString() },
    prev: { from: prevFrom.toISOString(), to: prevTo.toISOString() },
  };
}

// פירוק רשימה מופרדת בפסיקים לערכים נקיים
const listOf = (v) =>
  typeof v === "string" && v.trim()
    ? v.split(",").map((x) => x.trim()).filter(Boolean)
    : [];

// GET /api/stats/executive
//   ?period=week|month|year                      (כמו קודם)
//   או ?from=YYYY-MM-DD&to=YYYY-MM-DD            (טווח מותאם)
//   &sites=A1,B2  &statuses=error,ready  &minFailureRate=5
//   &groupBy=site|status|time  &granularity=day|week|month
app.get("/api/stats/executive", requireAuth, cache(), async (req, res) => {
  try {
    const p = resolveRange(req.query);
    if (!p) {
      return res.status(400).json({ error: "טווח תאריכים לא תקין" });
    }

    const siteCodes = listOf(req.query.sites);
    const statuses = listOf(req.query.statuses);
    const minFailureRate = Number(req.query.minFailureRate) || 0;
    const groupBy = ["site", "status", "time"].includes(req.query.groupBy)
      ? req.query.groupBy : "site";

    const filters = {
      siteCodes, statuses, minFailureRate,
      groupBy, granularity: p.granularity,
    };

    const current = await getExecutiveStatsFiltered({ ...p.range, ...filters });

    // ההשוואה מוחלת על אותם פילטרים בדיוק, אחרת המגמה חסרת משמעות
    const prev = await getExecutiveStatsFiltered({ ...p.prev, ...filters });

    const hasComparison =
      prev.kpis.totalOperations > 0 || prev.kpis.totalErrors > 0 || prev.kpis.avgAvailability > 0;

    const trendOf = (cur, old) => ({
      current: cur,
      previous: old,
      changePercent: hasComparison ? percentChange(cur, old) : null,
    });

    res.json({
      period: p.period,
      label: p.label,
      daysCount: p.daysCount ?? null,
      comparisonLabel: p.comparisonLabel,
      hasComparison,
      granularity: p.granularity,
      groupBy,
      range: p.range,
      filters: { sites: siteCodes, statuses, minFailureRate },
      kpis: current.kpis,
      sitesByStatus: current.sitesByStatus,
      topPerformers: current.topPerformers,
      worstPerformers: current.worstPerformers,
      chart: current.chart,
      heatmap: current.heatmap,
      groups: current.groups,
      rawRows: current.rawRows,
      allSites: current.allSites,
      filteredSitesCount: current.filteredSitesCount,
      totalSitesInSystem: current.totalSitesInSystem,
      trend: {
        operations: trendOf(current.kpis.totalOperations, prev.kpis.totalOperations),
        errors: trendOf(current.kpis.totalErrors, prev.kpis.totalErrors),
        availability: trendOf(current.kpis.avgAvailability, prev.kpis.avgAvailability),
        failureRate: trendOf(current.kpis.avgFailureRate, prev.kpis.avgFailureRate),
      },
    });
  } catch (err) {
    console.error("[api] שגיאה ב-GET executive:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// גרסה קודמת של הנתיב — נשמרת כדי לא לשבור צרכנים קיימים
app.get("/api/stats/executive-legacy", requireAuth, async (req, res) => {
  try {
    const p = resolvePeriod(req.query.period);
    const range = { ...p.range, granularity: p.granularity };

    const current = await getExecutiveStats(range);

    // מגמה מול התקופה הקודמת המקבילה
    const prev = await getExecutiveStats({ ...p.prev, granularity: p.granularity });
    const hasComparison =
      prev.kpis.totalOperations > 0 || prev.kpis.totalErrors > 0 || prev.kpis.avgAvailability > 0;

    const trendOf = (cur, old) => ({
      current: cur,
      previous: old,
      changePercent: hasComparison ? percentChange(cur, old) : null,
    });

    res.json({
      period: p.period,
      label: p.label,
      comparisonLabel: p.comparisonLabel,
      hasComparison,
      range: p.range,
      kpis: current.kpis,
      sitesByStatus: current.sitesByStatus,
      topPerformers: current.topPerformers,
      worstPerformers: current.worstPerformers,
      chart: current.chart,
      heatmap: current.heatmap,
      trend: {
        operations: trendOf(current.kpis.totalOperations, prev.kpis.totalOperations),
        errors: trendOf(current.kpis.totalErrors, prev.kpis.totalErrors),
        availability: trendOf(current.kpis.avgAvailability, prev.kpis.avgAvailability),
        failureRate: trendOf(current.kpis.avgFailureRate, prev.kpis.avgFailureRate),
      },
    });
  } catch (err) {
    console.error("[api] שגיאה ב-GET executive:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

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

// GET /api/stream — SSE: עדכונים בזמן אמת
app.get("/api/stream", requireAuthSse, async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  res.write(": connected\n\n");

  function onSiteUpdate(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  bus.on("siteUpdate", onSiteUpdate);

  const pingInterval = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  // נרשם כדי שכיבוי מסודר יוכל לסגור אותו. חיבור SSE נשאר פתוח לנצח מעצם
  // טבעו, ולכן server.close() לבדו לא היה מסתיים לעולם — הוא ממתין לסגירת
  // כל החיבורים. בלי הרישום הזה כל `docker stop` היה מסתיים ב-SIGKILL.
  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
    bus.removeListener("siteUpdate", onSiteUpdate);
    clearInterval(pingInterval);
    console.log("api: SSE client disconnected");
  });

  console.log("api: SSE client connected");
});

// ============================================================
// GET /api/stream/since?after=<id> — ה-replay שה-SSE לא יכול לתת
// ============================================================
// SSE הוא שידור בלבד: הודעה שנשלחה כשהטאב היה מנותק אבדה, ואין דרך לבקש
// אותה שוב. הדשבורד שומר את ה-id האחרון שראה, ואחרי חזרה מבקש כאן את מה
// שאחריו — וסוגר את הפער בלי לשלוף מחדש את כל רשימת האתרים.
//
// **הנתיב אינו /api/events**: השם הזה כבר תפוס ומחזיר *פעולות* (operations),
// לא אירועים. השם המבלבל ההוא קדם לטבלת events ואינו בשימוש הדשבורד.
//
// ללא after — מחזיר את הסמן הנוכחי בלבד. כך לקוח חדש יודע מאיפה להתחיל
// בלי להוריד היסטוריה שהוא ממילא מקבל מ-/api/sites.
app.get("/api/stream/since", requireAuth, async (req, res) => {
  try {
    const after = req.query.after;
    const latestId = await getLatestEventId();

    if (after === undefined) {
      return res.json({ cursor: latestId, events: [] });
    }

    const events = await getEventsSince(after, req.query.limit);
    res.json({
      cursor: events.length ? events[events.length - 1].id : Number(after) || 0,
      latestId,
      // true = נחתך בתקרה, ויש עוד. הלקוח פשוט מבקש שוב מהסמן החדש.
      hasMore: events.length > 0 && events[events.length - 1].id < latestId,
      events,
    });
  } catch (err) {
    console.error("[api] שגיאה ב-GET /api/stream/since:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

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

module.exports = { startApiServer, closeSseClients };