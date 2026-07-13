// api/routes.js — שרת ה-REST API של ה-Master (Express + SSE)

const express = require("express");
const { getAllSites, findSiteByCode, insertSite, getRecentOperations, getFilteredOperations,
        startMaintenance, getActiveMaintenance, cancelMaintenance, getSiteStats,
        getCurrentStatusSince, getStatusHistory, getMaintenanceHistory,
        getSystemSummary, getSystemMonthlyBreakdown,
        getSiteUptime, getLastFaultAt, getLastOperation,
        getUptimeBreakdown, getCycleDelta, getPeriodBreakdown,
        getSiteInsights, getActivityLog } = require("../db/queries");
const bus = require("../bus");

const app = express();
app.use(express.json());

const PORT = 4000;

// כל לקוח SSE מוסיף מאזין ל-bus המשותף. ברירת המחדל (10) מייצרת אזהרה
// כשיש הרבה מסכי בקרה פתוחים במקביל; מרימים את הסף (הניקוי נעשה ב-req.close).
bus.setMaxListeners(50);

// הדשבורד רץ במקור אחר (Vite על 5173), ולכן הדפדפן חוסם את הבקשות אליו
// בלי כותרות CORS. ברירת המחדל היא הפיתוח המקומי; בייצור מגדירים DASHBOARD_ORIGIN.
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || "http://localhost:5173";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");

  // בקשת preflight — עונים מיד ולא מריצים את שאר המסלולים.
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// קוד אתר חוקי. הקוד מגיע מה-topic (sites/{code}/state), ולכן אסור שיכיל '/'
// או את תווי ה-wildcard '+' ו-'#' — אחרת אתר אחד יוכל להתחזות לנושאים של אחר.
const SITE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// עוטף אתר: המצב הוא "maintenance" אם PLC שלח maintenance או שיש תחזוקה ידנית (OR)
function applyMaintenanceStatus(site) {
  const manualMaintenance = getActiveMaintenance(site.id);   // מקור 1: ידני (טבלת maintenance_windows)
  const plcMaintenance = site.status === "maintenance";       // מקור 2: PLC (כבר ב-sites.status)

  if (manualMaintenance || plcMaintenance) {
    return { ...site, status: "maintenance" };
  }
  return site;
}

// GET /api/sites — רשימת כל האתרים עם המצב הנוכחי + מדדים (אחוז כשל, פעולות, תקלות)
app.get("/api/sites", (req, res) => {
  try {
    // אחוז כשל ופעולות מחושבים על 7 הימים האחרונים בלבד (שבועי)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const sites = getAllSites().map(applyMaintenanceStatus).map((site) => {
      const stats = getSiteStats(site.id, { from: weekAgo });
      return {
        ...site,
        failureRate: stats.failureRate,
        operations: stats.operations,
        errors: stats.errors,
        uptime: getSiteUptime(site.id, weekAgo),      // אחוז זמינות שבועי (null אם אין היסטוריה)
        lastFaultAt: getLastFaultAt(site.id),         // מתי הייתה התקלה האחרונה
        lastOperation: getLastOperation(site.id),     // לזיהוי כניסה/יציאה בזמן פעולה
        statusSince: getCurrentStatusSince(site.id),  // מתי המצב הנוכחי התחיל
      };
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
app.post("/api/sites", (req, res) => {
  try {
    const { code, site_name, plc_type, plc_ip, site_ip } = req.body;

    if (typeof code !== "string" || !SITE_CODE_PATTERN.test(code)) {
      return res.status(400).json({
        error: "קוד אתר לא תקין — 1 עד 64 תווים מהסוג A-Z a-z 0-9 _ - בלבד",
      });
    }

    const name = typeof site_name === "string" ? site_name.trim() : "";
    if (!name) {
      return res.status(400).json({ error: "חסר שם אתר (site_name)" });
    }

    if (findSiteByCode(code)) {
      return res.status(409).json({ error: "אתר עם קוד זה כבר רשום", code });
    }

    // מטא-דאטה אופציונלי לתצוגה. ריק → null, כדי לא לשמור מחרוזות ריקות.
    const optional = (value) =>
      typeof value === "string" && value.trim() ? value.trim() : null;

    insertSite(code, name, {
      plcType: optional(plc_type),
      plcIp: optional(plc_ip),
      siteIp: optional(site_ip),
    });
    const site = findSiteByCode(code);

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
app.get("/api/sites/:code", (req, res) => {
  try {
    const site = findSiteByCode(req.params.code);

    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const stats = getSiteStats(site.id, { from: weekAgo });

    const operations = getRecentOperations(site.id);
    const statusSince = getCurrentStatusSince(site.id);            // מתי המצב הנוכחי התחיל
    const statusHistory = getStatusHistory(site.id);              // לוג 10 שינויי המצב האחרונים
    const maintenanceHistory = getMaintenanceHistory(site.id);   // חלונות תחזוקה (מי הפעיל, משך)
    res.json({
      site: {
        ...applyMaintenanceStatus(site),
        statusSince,
        failureRate: stats.failureRate,
        operations: stats.operations,
        errors: stats.errors,
        uptime: getSiteUptime(site.id, weekAgo),
        lastFaultAt: getLastFaultAt(site.id),
        lastOperation: getLastOperation(site.id),
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
app.get("/api/events", (req, res) => {
  try {
    const { site_code, from, to, limit } = req.query;

    const operations = getFilteredOperations({
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
app.get("/api/sites/:code/stats", (req, res) => {
  try {
    const site = findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const { from, to } = req.query;
    const stats = getSiteStats(site.id, { from: from || null, to: to || null });

    res.json({ code: site.code, ...stats });
  } catch (err) {
    console.error("[api] שגיאה ב-GET stats:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// POST /api/sites/:code/maintenance — הפעלת תחזוקה על אתר
app.post("/api/sites/:code/maintenance", (req, res) => {
  try {
    const site = findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const { name, duration_hours, reason } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "חסר שם (name)" });
    }
    if (!duration_hours || typeof duration_hours !== "number" || duration_hours <= 0) {
      return res.status(400).json({ error: "משך לא תקין (duration_hours) — חייב מספר חיובי" });
    }

    const result = startMaintenance(site.id, name, duration_hours, reason || null);
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
app.delete("/api/sites/:code/maintenance", (req, res) => {
  try {
    const site = findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const result = cancelMaintenance(site.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: "אין תחזוקה פעילה לביטול" });
    }

    res.json({ ok: true, message: `תחזוקה בוטלה על אתר ${site.code}` });
  } catch (err) {
    console.error("[api] שגיאה ב-DELETE maintenance:", err.message);
    res.status(500).json({ error: "שגיאת שרת" });
  }
});

// GET /api/sites/:code/maintenance — בדיקת תחזוקה פעילה
app.get("/api/sites/:code/maintenance", (req, res) => {
  try {
    const site = findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const active = getActiveMaintenance(site.id);
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
app.get("/api/stats/system", (req, res) => {
  try {
    const { month, year, from, to } = req.query;

    const summary = getSystemSummary({
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
app.get("/api/stats/system/monthly", (req, res) => {
  try {
    const { year, from, to } = req.query;

    const breakdown = getSystemMonthlyBreakdown({
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

// גבולות התקופה הנבחרת + התקופה הקודמת המקבילה.
// הגבולות קלנדריים ומחושבים בשעון המקומי (השרת רץ בישראל), ומומרים ל-ISO לשאילתות.
function resolvePeriod(period) {
  const now = new Date();
  const iso = (d) => d.toISOString();

  if (period === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);       // 1 בחודש הנוכחי
    const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return {
      period: "month",
      label: from.toLocaleDateString("he-IL", { month: "long", year: "numeric" }),
      comparisonLabel: `לעומת ${prevFrom.toLocaleDateString("he-IL", { month: "long" })}`,
      granularity: "day",
      range: { from: iso(from), to: iso(now) },
      prev: { from: iso(prevFrom), to: iso(from) },   // החודש הקודם במלואו
    };
  }

  if (period === "year") {
    const from = new Date(now.getFullYear(), 0, 1);                    // 1 בינואר
    const prevFrom = new Date(now.getFullYear() - 1, 0, 1);
    return {
      period: "year",
      label: String(now.getFullYear()),
      comparisonLabel: `לעומת ${now.getFullYear() - 1}`,
      granularity: "month",
      range: { from: iso(from), to: iso(now) },
      prev: { from: iso(prevFrom), to: iso(from) },   // השנה הקודמת במלואה
    };
  }

  // ברירת מחדל: שבוע — 7 ימים קלנדריים כולל היום, מיושר לחצות.
  // חשוב: חלון שמתחיל בשעה שרירותית (now פחות 168 שעות) יוצר ימים חלקיים
  // בשני הקצוות, והדלי של *היום* נופל מחוץ לסדרה — כך אבדו פעולות ותקלות של היום.
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const prevFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13);
  return {
    period: "week",
    label: "7 הימים האחרונים",
    comparisonLabel: "לעומת השבוע הקודם",
    granularity: "day",
    range: { from: iso(from), to: iso(now) },
    prev: { from: iso(prevFrom), to: iso(from) },   // 7 הימים הקלנדריים שלפני כן
  };
}

// אחוז השינוי מול התקופה הקודמת. null כשאין בסיס להשוואה (חלוקה באפס).
function percentChange(current, previous) {
  if (!Number.isFinite(previous) || previous === 0) {
    return current === 0 ? 0 : null;
  }
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// GET /api/sites/:code/analytics?period=week|month|year
app.get("/api/sites/:code/analytics", (req, res) => {
  try {
    const site = findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const p = resolvePeriod(req.query.period);

    const stats = getSiteStats(site.id, p.range);
    const uptime = getUptimeBreakdown(site.id, p.range);
    const chart = getPeriodBreakdown(site.id, { ...p.range, granularity: p.granularity });

    const prevStats = getSiteStats(site.id, p.prev);
    const prevUptime = getUptimeBreakdown(site.id, p.prev);

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
app.get("/api/sites/:code/insights", (req, res) => {
  try {
    const site = findSiteByCode(req.params.code);
    if (!site) {
      return res.status(404).json({ error: "אתר לא נמצא", code: req.params.code });
    }

    const p = resolvePeriod(req.query.period);
    const insights = getSiteInsights(site.id, p.range);
    const log = getActivityLog(site.id, { ...p.range, limit: 300 });

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

// GET /api/stream — SSE: עדכונים בזמן אמת
app.get("/api/stream", (req, res) => {
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

// מפעיל את השרת — נקרא מ-master.js
function startApiServer() {
  app.listen(PORT, () => {
    console.log(`api: REST server running on http://localhost:${PORT}`);
  });
}

module.exports = { startApiServer };