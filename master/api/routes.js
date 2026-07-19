// api/routes.js — שרת ה-REST API של ה-Master (Express + SSE)

const express = require("express");
const { getAllSites, getAllSitesWithMetrics, findSiteByCode, insertSite, getRecentOperations, getFilteredOperations,
        startMaintenance, getActiveMaintenance, cancelMaintenance, getSiteStats,
        getCurrentStatusSince, getStatusHistory, getMaintenanceHistory,
        getSystemSummary, getSystemMonthlyBreakdown,
        getSiteUptime, getLastFaultAt, getLastOperation,
        getUptimeBreakdown, getCycleDelta, getPeriodBreakdown, getSiteAnalyticsData,
        getSiteInsights, getActivityLog,
        getSupervisorStats, getExecutiveStats, getExecutiveStatsFiltered,
        getRecentErrors, getActiveMaintenances,
        ensureAdminCode, verifyAdminCode, setAdminCode,
        updateSite, deleteSite } = require("../db/queries");
const db = require("../db/db");
const bus = require("../bus");
const { cache } = require("./cache");
const { resolvePeriod } = require("./periods");
const { runChat, isChatConfigured } = require("../ai/chat");

const app = express();

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

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
  // x-admin-code היה חסר — כלומר כל בקשת ניהול הייתה נכשלת ב-preflight.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-code");
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
      console.log(`[api] איטי: ${req.method} ${req.originalUrl} — ${ms}ms, ${queries} שאילתות`);
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

// POST /api/admin/verify — בדיקת קוד (לפתיחת מצב ניהול ב-UI)
app.post("/api/admin/verify", async (req, res) => {
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
app.post("/api/admin/code", async (req, res) => {
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
    const { site_name, code: newCode, tier } = req.body || {};

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

    const result = await updateSite(req.params.code, {
      newCode: newCode?.trim(),
      siteName: name,
      tier,
    });

    if (!result.ok) {
      if (result.reason === "not_found") {
        return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
      }
      if (result.reason === "code_taken") {
        return res.status(409).json({ error: "כבר קיים אתר עם הקוד החדש" });
      }
    }

    bus.emit("siteUpdate", { type: "registered", code: result.site.code });
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

    bus.emit("siteUpdate", { type: "registered", code: req.params.code });
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
app.get("/api/sites", cache(), async (req, res) => {
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
    const sites = await getAllSitesWithMetrics({ from: weekFrom });

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
    const { code, site_name, plc_type, plc_ip, site_ip, tier } = req.body;

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

    if (await findSiteByCode(code)) {
      return res.status(409).json({ error: "אתר עם קוד זה כבר רשום", code });
    }

    // מטא-דאטה אופציונלי לתצוגה. ריק → null, כדי לא לשמור מחרוזות ריקות.
    const optional = (value) =>
      typeof value === "string" && value.trim() ? value.trim() : null;

    await insertSite(code, name, {
      plcType: optional(plc_type),
      plcIp: optional(plc_ip),
      siteIp: optional(site_ip),
      tier: tier || "basic",
    });
    const site = await findSiteByCode(code);

    // מודיעים ללקוחות ה-SSE שנוסף אתר, כדי שירעננו את הרשימה בלי המתנה
    // להודעת ה-MQTT הראשונה (שעשויה לאחר דקות, עד שהאתר ידווח).
    bus.emit("siteUpdate", {
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
app.get("/api/sites/:code", cache(), async (req, res) => {
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
app.get("/api/events", async (req, res) => {
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
app.get("/api/sites/:code/stats", cache(), async (req, res) => {
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

// POST /api/sites/:code/maintenance — הפעלת תחזוקה על אתר (פתוח, ללא קוד מנהל)
app.post("/api/sites/:code/maintenance", async (req, res) => {
  try {
    const site = await findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const { name, duration_hours, reason } = req.body || {};

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "חסר שם (name)" });
    }
    // Number.isFinite ולא !duration_hours: Infinity עובר את בדיקת ה-falsy
    if (!Number.isFinite(duration_hours) || duration_hours <= 0 ||
        duration_hours > MAX_MAINTENANCE_HOURS) {
      return res.status(400).json({
        error: `משך לא תקין (duration_hours) — מספר בין 0 ל-${MAX_MAINTENANCE_HOURS} שעות`,
      });
    }

    const result = await startMaintenance(site.id, name, duration_hours, reason || null);

    // חובה לשדר: תחזוקה משנה את המצב האפקטיבי של האתר (applyMaintenanceStatus),
    // ובלי האירוע הזה המטמון לא מתנקה ושאר הדשבורדים לא יודעים.
    bus.emit("siteUpdate", { type: "maintenance", code: site.code, action: "start" });

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

// DELETE /api/sites/:code/maintenance — ביטול תחזוקה פעילה
app.delete("/api/sites/:code/maintenance", async (req, res) => {
  try {
    const site = await findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const result = await cancelMaintenance(site.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: "אין תחזוקה פעילה לביטול" });
    }

    bus.emit("siteUpdate", { type: "maintenance", code: site.code, action: "cancel" });

    res.json({ ok: true, message: `תחזוקה בוטלה על אתר ${site.code}` });
  } catch (err) {
    console.error("[api] שגיאה ב-DELETE maintenance:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/sites/:code/maintenance — בדיקת תחזוקה פעילה
app.get("/api/sites/:code/maintenance", cache(), async (req, res) => {
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
app.get("/api/stats/system", cache(), async (req, res) => {
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
app.get("/api/stats/system/monthly", cache(), async (req, res) => {
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
app.get("/api/sites/:code/analytics", cache(), async (req, res) => {
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
app.get("/api/sites/:code/insights", cache(), async (req, res) => {
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
app.get("/api/stats/supervisor", cache(), async (req, res) => {
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
app.get("/api/stats/executive", cache(), async (req, res) => {
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
app.get("/api/stats/executive-legacy", async (req, res) => {
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

// GET /api/stream — SSE: עדכונים בזמן אמת
app.get("/api/stream", async (req, res) => {
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

  req.on("close", () => {
    bus.removeListener("siteUpdate", onSiteUpdate);
    clearInterval(pingInterval);
    console.log("api: SSE client disconnected");
  });

  console.log("api: SSE client connected");
});

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
  await ensureAdminCode();

  app.listen(PORT, () => {
    console.log(`api: REST server running on http://localhost:${PORT}`);
  });
}

module.exports = { startApiServer };