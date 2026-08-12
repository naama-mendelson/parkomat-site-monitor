// services/supervisorShape.js — המרת תשובות ה-SQL למבנה שהמסך מצפה לו.
//
// ============================================================
// למה זה קובץ נפרד, ולמה הוא טהור
// ============================================================
// כאן יושב **כל** הסיכון של המעבר לקריאה ישירה, והוא סיכון שקט: שם עמודה
// שגוי אינו זורק שגיאה אלא הופך ל-undefined, ואז ל-0 או null דרך ה-??.
// התוצאה היא מסך שנראה תקין לגמרי עם נתונים ריקים.
//
// site_globals, למשל, מחזירה את התחזוקה ואת הפעולה האחרונה **שטוחות**
// (maintenance_*, last_op_*) ולא מקוננות — ניחוש טבעי כמו g.last_operation
// היה עובר בשקט.
//
// הפרדה לקובץ בלי שום import מאפשרת ל-tools/parity-supervisor.js לייבא את
// **הפונקציה עצמה** ולהשוות אותה לפלט השרת. אילו הוא היה מחזיק עותק של
// המיפוי, הוא היה בודק את העותק ולא את הקוד שרץ — וזו בדיוק צורת הכשל
// שהפרויקט הזה כבר נשרף בה.

/**
 * @returns אותו מבנה בדיוק ש-GET /api/stats/supervisor מחזיר.
 */
export function toSupervisorShape({ siteRows, statsRows, uptimeRows, globalsRows, errorRows, maintRows }) {
  const by = (rows) => new Map((rows || []).map((r) => [r.site_id, r]));
  const stats = by(statsRows);
  const uptime = by(uptimeRows);
  const globals = by(globalsRows);

  const sites = (siteRows || [])
    // אותו מיון שהשרת מחזיר (getAllSites → ORDER BY code). בלי זה הטבלה
    // מופיעה בסדר אחר בשני מצבי המתג, וזה נראה כמו נתונים אחרים.
    .slice()
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));

  const rows = sites.map((site) => {
    // אתר בלי שום היסטוריה אינו מופיע בשליפות — ואז אין לו רשומה במפה.
    const s = stats.get(site.id)   || {};
    const u = uptime.get(site.id)  || {};
    const g = globals.get(site.id) || {};

    // ⚠️ site_globals מחזירה את התחזוקה ואת הפעולה האחרונה **שטוחות**
    // (maintenance_*, last_op_*) ולא כאובייקטים מקוננים. ניחוש של שם עמודה
    // כאן אינו נכשל אלא הופך ל-undefined ואז ל-0/null דרך ה-??, כלומר מסך
    // תקין למראה עם נתונים ריקים. המיפוי כאן זהה לזה שב-sitesDirect.js.
    const inManualMaintenance = Boolean(g.maintenance_id);

    // המצב האפקטיבי: תחזוקה ידנית פעילה גוברת על מה שה-PLC דיווח.
    const status = inManualMaintenance || site.status === "maintenance"
      ? "maintenance"
      : site.status;

    return {
      code: site.code,
      name: site.site_name,
      status,
      tier: site.tier,
      // אובייקט או null — ולא אובייקט עם שדות undefined, שנראה למסך כמו
      // "יש פעולה אחרונה" ואז מרנדר ריק.
      lastOperation: g.last_op_occurred_at
        ? {
            start_end:   g.last_op_start_end,
            entry_exit:  g.last_op_entry_exit,
            card_number: g.last_op_card_number,
            occurred_at: g.last_op_occurred_at,
          }
        : null,
      operations: s.operations ?? 0,
      errors: s.errors ?? 0,
      failureRate: s.failure_rate ?? 0,
      availability: u.availability_percent ?? null,
      // הזמן ה*נמדד* (בלי תחזוקה) — אתר שהיה בתחזוקה כל התקופה אין עליו
      // נתון זמינות, ואסור להציג לו 0%. "0%" נקרא "שבור לגמרי" במקום
      // "אין לנו מושג", וזו בדיוק ההטעיה שהשדה הזה מונע.
      hasUptimeData: (u.measured_hours ?? 0) > 0,
      maintenanceHours: u.maintenance_hours ?? 0,
      downtimeHours: u.error_hours ?? 0,
      lastError: g.last_fault_at ?? null,
      operationsSinceLastError: g.operations_since_last_error ?? 0,
      // "מונה מחזורים" = המונה הפיזי מהבקר, ולא cycle_total (שהוא "גידול
      // מאז ההתקנה" ולכן ≤ מספר הפעולות באתר חדש — מבלבל).
      cycleTotal: site.plc_cycle_last,
      cycleDelta: null,   // המונה אינו נשמר לכל פעולה (ראה getCycleDelta)
      inManualMaintenance,
    };
  });

  // שתי שאלות שונות לגמרי, ואסור לערבב ביניהן:
  //   sitesInError    — כמה אתרים מושבתים *ברגע זה* (מצב נוכחי)
  //   sitesWithErrors — בכמה אתרים *הייתה* תקלה בתקופה (מצטבר)
  // אתר שנפל והתאושש נספר בשני אבל לא בראשון.
  const summary = {
    totalSites: rows.length,
    sitesInError: rows.filter((r) => r.status === "error").length,
    sitesWithErrors: rows.filter((r) => r.errors > 0).length,
    sitesInMaintenance: rows.filter((r) => r.status === "maintenance").length,
    sitesOffline: rows.filter((r) => r.status === "no_comm").length,
  };

  // ⚠️ שמות השדות כאן הם camelCase כי כך השרת מחזיר אותם (ה-aliases המצוטטים
  // ב-getRecentErrors). הפונקציה ב-SQL מחזירה snake_case, ולכן ההמרה חייבת
  // להיות כאן — בלעדיה המסך מקבל undefined בכל שדה ומרנדר שורות ריקות.
  const recentErrors = (errorRows || []).map((e) => ({
    siteCode: e.site_code,
    siteName: e.site_name,
    startedAt: e.started_at,
    endedAt: e.ended_at,
    ongoing: e.ongoing,
    durationMinutes: e.duration_minutes,
    durationSeconds: e.duration_seconds,
    // תיאור התקלה מהבקר. ⚠️ `?? null` ולא `|| null`: '' הוא ערך תקף
    // שמשמעותו "הבקר נשאל והחזיר ריק", ו-|| היה הופך אותו ל-null —
    // כלומר ל"לא נקרא". שני דברים שונים.
    faultText: e.fault_text ?? null,
  }));

  const activeMaintenances = (maintRows || []).map((m) => ({
    siteCode: m.sites?.code ?? null,
    siteName: m.sites?.site_name ?? null,
    setBy: m.set_by_name,
    reason: m.reason,
    startedAt: m.started_at,
    expiresAt: m.expires_at,
  }));


  return { sites: rows, summary, recentErrors, activeMaintenances };
}
