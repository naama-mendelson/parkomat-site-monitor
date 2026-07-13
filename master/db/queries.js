const db = require("./db");

function findSiteByCode(code) {
  return db.prepare("SELECT * FROM sites WHERE code = ?").get(code);
}

function insertSite(code, siteName, meta = {}, isNewSite = 1) {
  const now = new Date().toISOString();
  const { plcType = null, plcIp = null, siteIp = null } = meta;
  return db
    .prepare(
      `INSERT INTO sites (code, site_name, registered_at, plc_type, plc_ip, site_ip, is_new_site)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(code, siteName, now, plcType, plcIp, siteIp, isNewSite ? 1 : 0);
}

function insertOperation(siteId, startEnd, entryExit, cardNumber, state, isAnomaly, occurredAt, receivedAt) {
  try {
    const result = db
      .prepare(
        `INSERT INTO operations (site_id, start_end, entry_exit, card_number, state, is_anomaly, occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(siteId, startEnd, entryExit, cardNumber, state, isAnomaly, occurredAt, receivedAt);
    return { inserted: true, result };
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return { inserted: false, duplicate: true };
    }
    throw err;
  }
}

// עדכן מונה סייקלים מצטבר (מטפל ב-first, delta, reset, ו-Backfill לפי זמן)
function applyCycleCounter(siteId, current, occurredAt) {
  const site = db
    .prepare("SELECT cycle_total, plc_cycle_last, cycle_last_ts, is_new_site FROM sites WHERE id = ?")
    .get(siteId);

  const last = site.plc_cycle_last;
  const lastTs = site.cycle_last_ts;
  let total = site.cycle_total;
  let mode;

  if (last === null) {
    mode = "first";
    // קריאה ראשונה מהבקר:
    //  - אתר ותיק (is_new_site = 0): מאמצים את המונה ההיסטורי — cycle_total = הערך מהבקר.
    //  - אתר חדש  (is_new_site = 1): cycle_total נשאר 0, והערך נשמר רק כבסיס ל-delta.
    // בשני המקרים plc_cycle_last מתעדכן ל-current בהמשך, ומכאן סופרים delta כרגיל.
    if (site.is_new_site === 0) {
      total = current;
    }
  } else if (lastTs !== null && occurredAt < lastTs) {
    mode = "backfill";
    return { mode, total, last, current, ignored: true };
  } else if (current >= last) {
    total = total + (current - last);
    mode = "normal";
  } else {
    total = total + current;
    mode = "reset";
  }

  db.prepare("UPDATE sites SET cycle_total = ?, plc_cycle_last = ?, cycle_last_ts = ? WHERE id = ?")
    .run(total, current, occurredAt, siteId);

  return { mode, total, last, current };
}

function updateSiteStatus(siteId, status, lastSeen) {
  return db
    .prepare("UPDATE sites SET status = ?, last_seen = ? WHERE id = ?")
    .run(status, lastSeen, siteId);
}

// עדכון מצב בלי לגעת ב-last_seen. משמש ל-no_comm: ההודעה הזו מגיעה מה-Broker
// (LWT) בשם האתר שהתנתק — היא מעידה שהאתר *לא* נשמע, ולכן אסור לה לרענן
// את last_seen. אחרת אתר מת נראה "נצפה זה עתה" וכלל ה-90 שניות לא יתפוס אותו.
function updateStatusOnly(siteId, status) {
  return db
    .prepare("UPDATE sites SET status = ? WHERE id = ?")
    .run(status, siteId);
}

function updateLastSeen(siteId, lastSeen) {
  return db
    .prepare("UPDATE sites SET last_seen = ? WHERE id = ?")
    .run(lastSeen, siteId);
}

// עדכון last_seen רק אם הזמן החדש מאוחר מהקיים. מונע החזרת last_seen אחורה
// כשהודעה ישנה מגיעה מאוחר (backfill / redelivery של QoS 1).
function updateLastSeenIfNewer(siteId, lastSeen) {
  return db
    .prepare("UPDATE sites SET last_seen = ? WHERE id = ? AND (last_seen IS NULL OR last_seen < ?)")
    .run(lastSeen, siteId, lastSeen);
}

// זמן ההתחלה של המצב הנוכחי (השורה הפתוחה ב-status_history), או null אם אין.
// משמש כ-guard: הודעה שקרתה *לפני* תחילת המצב הנוכחי היא מאוחרת, ואסור לה
// לשכתב את הסטטוס (מקביל לזיהוי ה-backfill ב-applyCycleCounter).
function getOpenStatusStartedAt(siteId) {
  const row = db
    .prepare("SELECT started_at FROM status_history WHERE site_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
    .get(siteId);
  return row ? row.started_at : null;
}

function closeOpenStatus(siteId, endedAt) {
  return db
    .prepare("UPDATE status_history SET ended_at = ? WHERE site_id = ? AND ended_at IS NULL")
    .run(endedAt, siteId);
}

function insertStatusHistory(siteId, status, startedAt) {
  return db
    .prepare("INSERT INTO status_history (site_id, status, started_at) VALUES (?, ?, ?)")
    .run(siteId, status, startedAt);
}

// טרנזקציה: שינוי מצב (סגירת קודם + פתיחת חדש + עדכון) כיחידה אחת
const applyStateChange = db.transaction((siteId, newStatus, occurredAt) => {
  closeOpenStatus(siteId, occurredAt);
  insertStatusHistory(siteId, newStatus, occurredAt);

  // ניתוק אינו "צפייה" — ראה updateStatusOnly.
  if (newStatus === "no_comm") {
    updateStatusOnly(siteId, newStatus);
  } else {
    updateSiteStatus(siteId, newStatus, occurredAt);
  }
});

function getAllSites() {
  return db.prepare("SELECT * FROM sites ORDER BY code").all();
}

// מתי המצב הנוכחי התחיל — started_at של השורה הפתוחה (ended_at IS NULL) ב-status_history
function getCurrentStatusSince(siteId) {
  const row = db.prepare(
    "SELECT started_at FROM status_history WHERE site_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
  ).get(siteId);
  return row ? row.started_at : null;
}

// היסטוריית המצבים האחרונה (לוג שינויי מצב) — מהחדש לישן.
// מסננים החוצה 'operating' *בתצוגה בלבד*: פעולת חניה שולחת גם state=operating וגם
// operation, ולוג מלא ב"בפעולה" הוא רעש. הבקר רוצה לראות רק אירועים משמעותיים
// (תקלה, תחזוקה, נתק, מוכן). ה-DB עדיין רושם את כל המצבים כולל operating —
// הסינון כאן לא משפיע על status_history, על operating_hours, על sites.status,
// או על חישובי זמינות/אחוז-כשל (אלה שולפים מ-status_history ישירות).
function getStatusHistory(siteId, limit = 10) {
  return db.prepare(
    "SELECT status, started_at, ended_at FROM status_history WHERE site_id = ? AND status != 'operating' ORDER BY started_at DESC LIMIT ?"
  ).all(siteId, limit);
}

// היסטוריית חלונות תחזוקה ידנית (מי הפעיל, משך, מתי) — מהחדש לישן.
// תחזוקה ידנית לא נרשמת ב-status_history, ולכן נשלפת בנפרד ללוג המצבים.
function getMaintenanceHistory(siteId, limit = 10) {
  return db.prepare(
    `SELECT set_by_name, reason, started_at, duration_hours, expires_at, cancelled_at
     FROM maintenance_windows WHERE site_id = ? ORDER BY started_at DESC LIMIT ?`
  ).all(siteId, limit);
}

function getRecentOperations(siteId, limit = 10) {
  return db
    .prepare("SELECT * FROM operations WHERE site_id = ? ORDER BY occurred_at DESC LIMIT ?")
    .all(siteId, limit);
}

function getFilteredOperations({ siteCode, from, to, limit = 100 } = {}) {
  let sql = `
    SELECT o.*, s.code, s.site_name
    FROM operations o
    JOIN sites s ON o.site_id = s.id
    WHERE 1=1
  `;
  const params = [];

  if (siteCode) {
    sql += " AND s.code = ?";
    params.push(siteCode);
  }
  if (from) {
    sql += " AND o.occurred_at >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND o.occurred_at < ?";
    params.push(to);
  }

  // limit לא-מספרי (למשל ?limit=abc) היה מגיע כ-NaN ומפיל את השאילתה ב-500.
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 1000) : 100;
  sql += " ORDER BY o.occurred_at DESC LIMIT ?";
  params.push(safeLimit);

  return db.prepare(sql).all(...params);
}

// ===== תחזוקה =====

function startMaintenance(siteId, setByName, durationHours, reason = null, setByRole = null) {
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + durationHours * 60 * 60 * 1000);

  const result = db
    .prepare(
      `INSERT INTO maintenance_windows (site_id, set_by_name, set_by_role, reason, started_at, duration_hours, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(siteId, setByName, setByRole, reason, startedAt.toISOString(), durationHours, expiresAt.toISOString());

  return {
    id: result.lastInsertRowid,
    startedAt: startedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function getActiveMaintenance(siteId) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT * FROM maintenance_windows
       WHERE site_id = ? AND cancelled_at IS NULL AND expires_at > ?
       ORDER BY expires_at DESC LIMIT 1`
    )
    .get(siteId, now);
}

function cancelMaintenance(siteId) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `UPDATE maintenance_windows SET cancelled_at = ?
       WHERE site_id = ? AND cancelled_at IS NULL AND expires_at > ?`
    )
    .run(now, siteId, now);
}

// ===== סטטיסטיקה =====

// בדוק אם בזמן נתון האתר היה בתחזוקה (ידני או PLC)
function wasInMaintenance(siteId, ts) {
  const manual = db
    .prepare(
      `SELECT 1 FROM maintenance_windows
       WHERE site_id = ?
         AND started_at <= ?
         AND COALESCE(cancelled_at, expires_at) >= ?
       LIMIT 1`
    )
    .get(siteId, ts, ts);
  if (manual) return true;

  const plc = db
    .prepare(
      `SELECT 1 FROM status_history
       WHERE site_id = ? AND status = 'maintenance'
         AND started_at <= ?
         AND (ended_at IS NULL OR ended_at >= ?)
       LIMIT 1`
    )
    .get(siteId, ts, ts);
  if (plc) return true;

  return false;
}

// אחוז הזמינות של האתר בחלון נתון: כמה מהזמן הוא *לא* היה ב-error או no_comm.
// מחזיר null כשאין מספיק היסטוריה כדי לענות (אתר שנרשם ומעולם לא דיווח).
function getSiteUptime(siteId, from, to = new Date().toISOString()) {
  // לא סופרים זמן שקדם להיסטוריה של האתר — אחרת אתר חדש ייראה 100% זמין
  // על חלון שלם שרובו קדם לרישומו.
  const first = db
    .prepare("SELECT MIN(started_at) AS m FROM status_history WHERE site_id = ?")
    .get(siteId).m;
  if (!first) return null;

  const windowStart = Math.max(Date.parse(from), Date.parse(first));
  const windowEnd = Date.parse(to);
  const totalMs = windowEnd - windowStart;
  if (!(totalMs > 0)) return null;

  // כל מקטע מצב שחופף לחלון. ended_at=NULL פירושו "המצב הנוכחי" → נמשך עד עכשיו.
  const rows = db
    .prepare(
      `SELECT status, started_at, ended_at FROM status_history
       WHERE site_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)`
    )
    .all(siteId, to, new Date(windowStart).toISOString());

  let downMs = 0;
  for (const row of rows) {
    if (row.status !== "error" && row.status !== "no_comm") continue;

    // חיתוך המקטע לגבולות החלון, כדי לא לספול זמן שמחוץ לו.
    const start = Math.max(Date.parse(row.started_at), windowStart);
    const end = Math.min(row.ended_at ? Date.parse(row.ended_at) : windowEnd, windowEnd);
    if (end > start) downMs += end - start;
  }

  const uptime = ((totalMs - downMs) / totalMs) * 100;
  return Math.round(uptime * 100) / 100;
}

// מתי התחילה התקלה האחרונה (null אם מעולם לא הייתה)
function getLastFaultAt(siteId) {
  return db
    .prepare("SELECT MAX(started_at) AS t FROM status_history WHERE site_id = ? AND status = 'error'")
    .get(siteId).t;
}

// הפעולה האחרונה — מאפשרת לדשבורד להציג "רכב נכנס/יוצא" בזמן שהאתר בפעולה
function getLastOperation(siteId) {
  return db
    .prepare(
      `SELECT start_end, entry_exit, occurred_at FROM operations
       WHERE site_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`
    )
    .get(siteId) ?? null;
}

// חשב מדדים לאתר: errors (ללא אלה שבתחזוקה), operations, אחוז כשל
function getSiteStats(siteId, { from = null, to = null } = {}) {
  let opsSql = "SELECT COUNT(*) AS n FROM operations WHERE site_id = ? AND is_anomaly = 0 AND start_end = 'end'";
  const opsParams = [siteId];
  if (from) { opsSql += " AND occurred_at >= ?"; opsParams.push(from); }
  if (to)   { opsSql += " AND occurred_at < ?"; opsParams.push(to); }
  const operations = db.prepare(opsSql).get(...opsParams).n;

  let errSql = "SELECT started_at FROM status_history WHERE site_id = ? AND status = 'error'";
  const errParams = [siteId];
  if (from) { errSql += " AND started_at >= ?"; errParams.push(from); }
  if (to)   { errSql += " AND started_at < ?"; errParams.push(to); }
  const errorRows = db.prepare(errSql).all(...errParams);

  let errors = 0;
  let errorsInMaintenance = 0;
  for (const row of errorRows) {
    if (wasInMaintenance(siteId, row.started_at)) {
      errorsInMaintenance++;
    } else {
      errors++;
    }
  }

  const failureRate = operations > 0 ? (errors / operations) * 100 : 0;

  return {
    operations,
    errors,
    errorsInMaintenance,
    failureRate: Math.round(failureRate * 100) / 100,
  };
}

// ===== צבירה לסיכום חודשי =====

function generateMonthlySummary(siteId, yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const monthEnd = new Date(Date.UTC(year, month, 1)).toISOString();

  // --- פעולות ואנומליות ---
  const ops = db.prepare(
    `SELECT
       SUM(CASE WHEN is_anomaly = 0 THEN 1 ELSE 0 END) AS operations,
       SUM(CASE WHEN is_anomaly = 1 THEN 1 ELSE 0 END) AS anomalies
     FROM operations
     WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ? AND start_end = 'end'`
  ).get(siteId, monthStart, monthEnd);

  const operations = ops.operations || 0;
  const anomalies = ops.anomalies || 0;

  // --- תקלות (כולל החרגת תחזוקה) ---
  const stats = getSiteStats(siteId, { from: monthStart, to: monthEnd });

  // --- שעות בכל מצב (חתוך לגבולות החודש) ---
  const statusRows = db.prepare(
    `SELECT status, started_at, ended_at
     FROM status_history
     WHERE site_id = ? AND started_at >= ? AND started_at < ?`
  ).all(siteId, monthStart, monthEnd);

  const monthEndTime = new Date(monthEnd).getTime();
  const hours = { ready: 0, operating: 0, error: 0, maintenance: 0, no_comm: 0 };
  for (const row of statusRows) {
    const start = new Date(row.started_at).getTime();
    const end = row.ended_at ? new Date(row.ended_at).getTime() : monthEndTime;
    const cappedEnd = Math.min(end, monthEndTime);
    const durationHours = (cappedEnd - start) / (1000 * 60 * 60);
    if (durationHours > 0 && hours[row.status] !== undefined) {
      hours[row.status] += durationHours;
    }
  }

  // --- מונה סייקלים (הערך הנוכחי — מדויק לחודש הנוכחי, אפרוקסימציה להיסטוריים) ---
  const cycleEnd = db.prepare("SELECT cycle_total FROM sites WHERE id = ?").get(siteId).cycle_total;

  const round = (n) => Math.round(n * 100) / 100;

  // --- שמירה (INSERT או UPDATE אם כבר קיים) ---
  db.prepare(
    `INSERT INTO monthly_summary
       (site_id, year_month, operations, anomalies, errors, errors_in_maintenance, failure_rate,
        ready_hours, operating_hours, error_hours, maintenance_hours, no_comm_hours,
        cycle_total_start, cycle_total_end, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, year_month) DO UPDATE SET
       operations=excluded.operations, anomalies=excluded.anomalies,
       errors=excluded.errors, errors_in_maintenance=excluded.errors_in_maintenance,
       failure_rate=excluded.failure_rate,
       ready_hours=excluded.ready_hours, operating_hours=excluded.operating_hours,
       error_hours=excluded.error_hours, maintenance_hours=excluded.maintenance_hours,
       no_comm_hours=excluded.no_comm_hours,
       cycle_total_start=excluded.cycle_total_start, cycle_total_end=excluded.cycle_total_end,
       generated_at=excluded.generated_at`
  ).run(
    siteId, yearMonth, operations, anomalies, stats.errors, stats.errorsInMaintenance, stats.failureRate,
    round(hours.ready), round(hours.operating), round(hours.error), round(hours.maintenance), round(hours.no_comm),
    null, cycleEnd, new Date().toISOString()
  );

  return {
    yearMonth, operations, anomalies,
    errors: stats.errors, errorsInMaintenance: stats.errorsInMaintenance, failureRate: stats.failureRate,
    hours: {
      ready: round(hours.ready), operating: round(hours.operating), error: round(hours.error),
      maintenance: round(hours.maintenance), no_comm: round(hours.no_comm),
    },
    cycleTotalEnd: cycleEnd,
  };
}

// ===== סיכום מערכתי (כל האתרים) =====

function getSystemSummary({ yearMonth = null, year = null, from = null, to = null } = {}) {
  let whereClause = "";
  const params = [];

  if (yearMonth) {
    whereClause = "WHERE year_month = ?";
    params.push(yearMonth);
  } else if (year) {
    whereClause = "WHERE year_month >= ? AND year_month <= ?";
    params.push(`${year}-01`, `${year}-12`);
  } else if (from || to) {
    whereClause = "WHERE 1=1";
    if (from) { whereClause += " AND year_month >= ?"; params.push(from); }
    if (to)   { whereClause += " AND year_month <= ?"; params.push(to); }
  }

  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT site_id) AS sites_count,
      COUNT(*) AS months_reported,
      SUM(operations) AS total_operations,
      SUM(anomalies) AS total_anomalies,
      SUM(errors) AS total_errors,
      SUM(errors_in_maintenance) AS total_errors_in_maintenance,
      SUM(ready_hours) AS total_ready_hours,
      SUM(operating_hours) AS total_operating_hours,
      SUM(error_hours) AS total_error_hours,
      SUM(maintenance_hours) AS total_maintenance_hours,
      SUM(no_comm_hours) AS total_no_comm_hours
    FROM monthly_summary
    ${whereClause}
  `).get(...params);

  const ops = row.total_operations || 0;
  const errs = row.total_errors || 0;
  const failureRate = ops > 0 ? (errs / ops) * 100 : 0;

  return {
    sitesCount: row.sites_count || 0,
    monthsReported: row.months_reported || 0,
    operations: ops,
    anomalies: row.total_anomalies || 0,
    errors: errs,
    errorsInMaintenance: row.total_errors_in_maintenance || 0,
    failureRate: Math.round(failureRate * 100) / 100,
    hours: {
      ready: Math.round((row.total_ready_hours || 0) * 100) / 100,
      operating: Math.round((row.total_operating_hours || 0) * 100) / 100,
      error: Math.round((row.total_error_hours || 0) * 100) / 100,
      maintenance: Math.round((row.total_maintenance_hours || 0) * 100) / 100,
      no_comm: Math.round((row.total_no_comm_hours || 0) * 100) / 100,
    },
  };
}

function getSystemMonthlyBreakdown({ year = null, from = null, to = null } = {}) {
  let whereClause = "";
  const params = [];

  if (year) {
    whereClause = "WHERE year_month >= ? AND year_month <= ?";
    params.push(`${year}-01`, `${year}-12`);
  } else if (from || to) {
    whereClause = "WHERE 1=1";
    if (from) { whereClause += " AND year_month >= ?"; params.push(from); }
    if (to)   { whereClause += " AND year_month <= ?"; params.push(to); }
  }

  return db.prepare(`
    SELECT
      year_month,
      COUNT(DISTINCT site_id) AS sites_count,
      SUM(operations) AS operations,
      SUM(anomalies) AS anomalies,
      SUM(errors) AS errors,
      SUM(errors_in_maintenance) AS errors_in_maintenance,
      SUM(maintenance_hours) AS maintenance_hours,
      SUM(no_comm_hours) AS no_comm_hours
    FROM monthly_summary
    ${whereClause}
    GROUP BY year_month
    ORDER BY year_month
  `).all(...params);
}

// ===== אנליטיקה לפי תקופה (משמש את GET /api/sites/:code/analytics) =====

// המצבים שנחשבים "זמין לשירות" — האתר יכול לקבל רכבים.
const AVAILABLE_STATUSES = ["ready", "operating"];

/**
 * פילוח זמינות מפורט: כמה שעות האתר היה בכל מצב בטווח [from, to).
 * נגזר מ-status_history, עם חיתוך נכון של מקטעים בשני הקצוות:
 *   - מקטע שהתחיל לפני from ונמשך לתוכו → נספר רק החלק שבטווח.
 *   - מקטע שנמשך אחרי to → נחתך ב-to.
 *   - מקטע פתוח (ended_at IS NULL) → נמשך עד to או עד עכשיו (המוקדם).
 *
 * totalHours הוא סך הזמן ה*נמדד* (סכום המקטעים), ולא אורך החלון —
 * אתר שנרשם באמצע התקופה לא ייענש על זמן שלא היה קיים בו.
 */
function getUptimeBreakdown(siteId, { from, to }) {
  const empty = {
    readyHours: 0, operatingHours: 0, errorHours: 0,
    maintenanceHours: 0, noCommHours: 0,
    totalHours: 0, availabilityPercent: 0,
  };

  const nowIso = new Date().toISOString();
  const rangeEnd = to < nowIso ? to : nowIso;   // לא סופרים אל תוך העתיד
  const windowStart = Date.parse(from);
  const windowEnd = Date.parse(rangeEnd);
  if (!(windowEnd > windowStart)) return empty;

  const rows = db
    .prepare(
      `SELECT status, started_at, ended_at FROM status_history
       WHERE site_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)`
    )
    .all(siteId, rangeEnd, from);

  const ms = { ready: 0, operating: 0, error: 0, maintenance: 0, no_comm: 0 };

  for (const row of rows) {
    if (ms[row.status] === undefined) continue;
    const start = Math.max(Date.parse(row.started_at), windowStart);
    const end = Math.min(row.ended_at ? Date.parse(row.ended_at) : windowEnd, windowEnd);
    if (end > start) ms[row.status] += end - start;
  }

  const toHours = (v) => Math.round((v / 3600000) * 100) / 100;
  const totalMs = Object.values(ms).reduce((a, b) => a + b, 0);
  const availableMs = AVAILABLE_STATUSES.reduce((sum, s) => sum + ms[s], 0);

  return {
    readyHours: toHours(ms.ready),
    operatingHours: toHours(ms.operating),
    errorHours: toHours(ms.error),
    maintenanceHours: toHours(ms.maintenance),
    noCommHours: toHours(ms.no_comm),
    totalHours: toHours(totalMs),
    availabilityPercent: totalMs > 0
      ? Math.round((availableMs / totalMs) * 10000) / 100
      : 0,
  };
}

/**
 * כמה מחזורים נוספו למונה הבקר בטווח.
 *
 * מחזיר null — הערך אינו ניתן לחישוב מהנתונים השמורים: טבלת operations
 * אינה שומרת את ה-cycle_counter של כל הודעה (רק sites.cycle_total המצטבר
 * ו-plc_cycle_last העדכני), ואין היסטוריה של המונה לאורך זמן.
 * כדי לאפשר זאת יש לשמור את המונה בכל שורת operation — שינוי סכמה.
 * ה-frontend מציג "לא זמין" במקום לנחש.
 */
// eslint-disable-next-line no-unused-vars
function getCycleDelta(siteId, { from, to }) {
  return null;
}

/**
 * סדרת נקודות לגרף המגמה: פעולות ותקלות לכל יום/חודש בטווח.
 * granularity: 'day' (נקודה ליום) או 'month' (נקודה לחודש).
 * מחזיר מערך רציף — גם דלי ריק מקבל נקודה עם 0, כדי שהגרף לא "יקפוץ".
 */
function getPeriodBreakdown(siteId, { from, to, granularity }) {
  const byMonth = granularity === "month";

  // מפתח הדלי נגזר בשעון ה*מקומי*, לא מקידומת ה-ISO (שהיא UTC). גבולות התקופה
  // קלנדריים-מקומיים, וקיבוץ לפי UTC היה משייך פעולות סמוכות-לחצות לדלי הלא נכון.
  const keyOfDate = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    if (byMonth) return `${y}-${m}`;
    return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const keyOfIso = (iso) => keyOfDate(new Date(iso));

  const opsRows = db
    .prepare(
      `SELECT occurred_at FROM operations
       WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
         AND is_anomaly = 0 AND start_end = 'end'`
    )
    .all(siteId, from, to);

  const errRows = db
    .prepare(
      `SELECT started_at FROM status_history
       WHERE site_id = ? AND started_at >= ? AND started_at < ? AND status = 'error'`
    )
    .all(siteId, from, to);

  const tally = (rows, field) => {
    const map = new Map();
    for (const row of rows) {
      const k = keyOfIso(row[field]);
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  };

  const ops = tally(opsRows, "occurred_at");
  const errs = tally(errRows, "started_at");

  // סדרה רציפה מ-from עד to (דלי ריק מקבל 0, כדי שהגרף לא "יקפוץ").
  const points = [];
  const end = Date.parse(to);
  const cursor = new Date(from);

  while (cursor.getTime() < end) {
    const key = keyOfDate(cursor);
    points.push({
      label: byMonth
        ? cursor.toLocaleDateString("he-IL", { month: "short" })
        : `${cursor.getDate()}.${cursor.getMonth() + 1}`,
      operations: ops.get(key) || 0,
      errors: errs.get(key) || 0,
    });

    if (byMonth) cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }

  return points;
}

const WEEKDAY_LABELS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/**
 * סטטיסטיקה מעמיקה לאתר בטווח [from, to) — למסך "עוד מידע".
 *
 * שולף פעם אחת את הפעולות ואת מקטעי המצב, ומחשב הכל ב-JS.
 * זול יותר מ-8 שאילתות נפרדות, ומאפשר חישובים (שיוך start↔end) שקשה לבטא ב-SQL.
 */
function getSiteInsights(siteId, { from, to }) {
  // --- כל הפעולות בטווח, כרונולוגית (צריך גם start וגם end לשיוך משכים) ---
  const ops = db
    .prepare(
      `SELECT start_end, entry_exit, card_number, is_anomaly, occurred_at
       FROM operations
       WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at ASC, id ASC`
    )
    .all(siteId, from, to);

  // ===== מונים בסיסיים =====
  let entries = 0, exits = 0, anomalies = 0, withCard = 0, withoutCard = 0;

  const byHour = Array.from({ length: 24 }, () => 0);
  const byWeekday = Array.from({ length: 7 }, () => 0);
  const byDay = new Map();     // "2026-07-12" → מספר פעולות
  const cards = new Map();     // מספר כרטיס → { total, entries, exits, lastAt }

  // שיוך start↔end לחישוב משך פעולה. מפתח: כיוון+כרטיס.
  const openStarts = new Map();
  const durations = [];

  for (const op of ops) {
    const when = new Date(op.occurred_at);
    const key = `${op.entry_exit}|${op.card_number}`;

    if (op.start_end === "start") {
      openStarts.set(key, when.getTime());
      continue;   // רק end נחשב "פעולה שהושלמה"
    }

    // --- מכאן: הודעת end ---
    const start = openStarts.get(key);
    if (start !== undefined) {
      const seconds = (when.getTime() - start) / 1000;
      // מסננים משכים לא-סבירים (שיוך שגוי / הודעה שאבדה): מעל 4 שעות
      if (seconds > 0 && seconds < 4 * 3600) durations.push(seconds);
      openStarts.delete(key);
    }

    if (op.is_anomaly) {
      anomalies++;
      continue;   // אנומליה אינה פעולת חניה תקינה — לא נספרת במדדים
    }

    if (op.entry_exit === "entry") entries++;
    else if (op.entry_exit === "exit") exits++;

    byHour[when.getHours()]++;
    byWeekday[when.getDay()]++;

    const dayKey = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
    byDay.set(dayKey, (byDay.get(dayKey) || 0) + 1);

    if (op.card_number) {
      withCard++;
      const c = cards.get(op.card_number) || { card: op.card_number, total: 0, entries: 0, exits: 0, lastAt: null };
      c.total++;
      if (op.entry_exit === "entry") c.entries++; else c.exits++;
      if (!c.lastAt || op.occurred_at > c.lastAt) c.lastAt = op.occurred_at;
      cards.set(op.card_number, c);
    } else {
      withoutCard++;
    }
  }

  const operations = entries + exits;

  // ===== שיאים =====
  let busiestDay = null;
  for (const [date, count] of byDay) {
    if (!busiestDay || count > busiestDay.operations) {
      busiestDay = { date, operations: count };
    }
  }
  if (busiestDay) {
    const d = new Date(`${busiestDay.date}T12:00:00`);
    busiestDay.label = `${d.getDate()}.${d.getMonth() + 1} (${WEEKDAY_LABELS[d.getDay()]})`;
  }

  const peakHourValue = Math.max(...byHour);
  const busiestHour = peakHourValue > 0
    ? { hour: byHour.indexOf(peakHourValue), operations: peakHourValue }
    : null;

  const activeDays = byDay.size;
  const dailyAverage = activeDays > 0
    ? Math.round((operations / activeDays) * 10) / 10
    : 0;

  // ===== משכי פעולה =====
  const sorted = [...durations].sort((a, b) => a - b);
  const durationStats = sorted.length > 0
    ? {
        samples: sorted.length,
        averageSeconds: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
        medianSeconds: Math.round(sorted[Math.floor(sorted.length / 2)]),
        longestSeconds: Math.round(sorted[sorted.length - 1]),
        shortestSeconds: Math.round(sorted[0]),
      }
    : null;

  // ===== השבתות (מקטעי error בטווח) =====
  const errorRows = db
    .prepare(
      `SELECT started_at, ended_at FROM status_history
       WHERE site_id = ? AND status = 'error' AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)`
    )
    .all(siteId, to, from);

  const nowMs = Date.now();
  const windowStart = Date.parse(from);
  const windowEnd = Math.min(Date.parse(to), nowMs);

  let totalDownMs = 0, longestMs = 0, longestAt = null;
  for (const row of errorRows) {
    const s = Math.max(Date.parse(row.started_at), windowStart);
    const e = Math.min(row.ended_at ? Date.parse(row.ended_at) : windowEnd, windowEnd);
    const span = e - s;
    if (span <= 0) continue;
    totalDownMs += span;
    if (span > longestMs) {
      longestMs = span;
      longestAt = row.started_at;
    }
  }

  const hrs = (ms) => Math.round((ms / 3600000) * 100) / 100;
  const incidents = errorRows.length;

  return {
    totals: {
      operations,
      entries,
      exits,
      anomalies,
      activeDays,
    },
    cards: {
      uniqueCards: cards.size,
      withCard,
      withoutCard,
      top: [...cards.values()]
        .sort((a, b) => b.total - a.total || (a.card < b.card ? -1 : 1))
        .slice(0, 10),
    },
    activity: {
      byHour: byHour.map((operations, hour) => ({ hour, operations })),
      byWeekday: byWeekday.map((operations, i) => ({
        weekday: i,
        label: WEEKDAY_LABELS[i],
        operations,
      })),
      busiestDay,
      busiestHour,
      dailyAverage,
    },
    durations: durationStats,
    downtime: {
      incidents,
      totalHours: hrs(totalDownMs),
      longestHours: hrs(longestMs),
      averageHours: incidents > 0 ? hrs(totalDownMs / incidents) : 0,
      longestAt,
    },
  };
}

/**
 * לוג פעילות מלא לתקופה — מאחד שלושה מקורות לציר זמן אחד:
 * פעולות (כניסה/יציאה), שינויי מצב, וחלונות תחזוקה ידניים.
 *
 * counts הם הסכומים ה*מלאים* בתקופה, גם אם entries נחתך ל-limit —
 * כדי שה-UI יוכל לומר "מוצגות 300 מתוך 812".
 */
function getActivityLog(siteId, { from, to, limit = 300 }) {
  const ops = db
    .prepare(
      `SELECT start_end, entry_exit, card_number, is_anomaly, state, occurred_at
       FROM operations
       WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at DESC LIMIT ?`
    )
    .all(siteId, from, to, limit);

  const states = db
    .prepare(
      `SELECT status, started_at, ended_at FROM status_history
       WHERE site_id = ? AND started_at >= ? AND started_at < ?
       ORDER BY started_at DESC LIMIT ?`
    )
    .all(siteId, from, to, limit);

  const maint = db
    .prepare(
      `SELECT set_by_name, set_by_role, reason, started_at, duration_hours, expires_at, cancelled_at
       FROM maintenance_windows
       WHERE site_id = ? AND started_at >= ? AND started_at < ?
       ORDER BY started_at DESC LIMIT ?`
    )
    .all(siteId, from, to, limit);

  const countIn = (table, timeCol) =>
    db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ? AND ${timeCol} >= ? AND ${timeCol} < ?`
    ).get(siteId, from, to).n;

  const secondsBetween = (a, b) =>
    a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null;

  // דירוג לוגי לשבירת שוויון כשכמה אירועים נושאים את *אותו* חותם זמן.
  // הסוכן משדר את הודעת ה-state לפני הודעת ה-operation באותו סבב, אבל הסדר
  // האמיתי של המציאות הפוך: המצב operating מתחיל, ואז הפעולה מתחילה; הפעולה
  // מסתיימת, ורק אז האתר חוזר ל-ready. בלי הדירוג הזה הלוג היה מציג "ready"
  // *בתוך* הפעולה — מצב שלא יכול להתקיים.
  const phaseRank = (e) => {
    if (e.kind === "status") return e.status === "operating" ? 0 : 3;
    if (e.kind === "operation") return e.startEnd === "start" ? 1 : 2;
    return 4;   // תחזוקה
  };

  const entries = [
    ...ops.map((o) => ({
      kind: "operation",
      at: o.occurred_at,
      startEnd: o.start_end,
      entryExit: o.entry_exit,
      card: o.card_number || null,
      isAnomaly: !!o.is_anomaly,
      state: o.state,
    })),
    ...states.map((s) => ({
      kind: "status",
      at: s.started_at,
      status: s.status,
      endedAt: s.ended_at,
      durationSeconds: secondsBetween(s.started_at, s.ended_at),
    })),
    ...maint.map((m) => ({
      kind: "maintenance",
      at: m.started_at,
      setBy: m.set_by_name,
      role: m.set_by_role,
      reason: m.reason,
      durationHours: m.duration_hours,
      expiresAt: m.expires_at,
      cancelledAt: m.cancelled_at,
    })),
  ]
    .sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? 1 : -1;   // מהחדש לישן
      return phaseRank(b) - phaseRank(a);               // באותו רגע: המאוחר לוגית קודם
    })
    .slice(0, limit);

  return {
    entries,
    truncated: entries.length >= limit,
    counts: {
      operations: countIn("operations", "occurred_at"),
      status: countIn("status_history", "started_at"),
      maintenance: countIn("maintenance_windows", "started_at"),
    },
  };
}

// ===== תחזוקת נתונים (summary / cleanup / backup) =====

// האם קיים סיכום חודשי לאתר+חודש
function hasMonthlySummary(siteId, yearMonth) {
  return !!db.prepare(
    "SELECT 1 FROM monthly_summary WHERE site_id = ? AND year_month = ?"
  ).get(siteId, yearMonth);
}

// חודשים ייחודיים עם נתוני raw לפני חודש-חתך (איחוד מכל טבלאות ה-raw)
function getRawMonthsBefore(cutoffMonth) {
  return db.prepare(
    `SELECT DISTINCT substr(occurred_at, 1, 7) AS ym FROM operations WHERE substr(occurred_at, 1, 7) < ?
     UNION
     SELECT DISTINCT substr(started_at, 1, 7) AS ym FROM status_history WHERE substr(started_at, 1, 7) < ?
     UNION
     SELECT DISTINCT substr(started_at, 1, 7) AS ym FROM maintenance_windows WHERE substr(started_at, 1, 7) < ?
     ORDER BY ym`
  ).all(cutoffMonth, cutoffMonth, cutoffMonth).map((r) => r.ym);
}

// מחיקת נתוני raw בטווח [monthStart, monthEnd) מכל שלוש הטבלאות
function deleteRawInRange(monthStart, monthEnd) {
  const operations = db.prepare(
    "DELETE FROM operations WHERE occurred_at >= ? AND occurred_at < ?"
  ).run(monthStart, monthEnd).changes;
  // לא מוחקים את השורה הפתוחה (ended_at IS NULL) — היא המצב הנוכחי של האתר.
  // אתר יציב מעל שנה עלול להחזיק שורה פתוחה ישנה; מחיקתה תשבש את
  // getCurrentStatusSince ו-getSiteUptime בזמן שהמצב עצוב עדיין ב-sites.status.
  const statusHistory = db.prepare(
    "DELETE FROM status_history WHERE started_at >= ? AND started_at < ? AND ended_at IS NOT NULL"
  ).run(monthStart, monthEnd).changes;
  const maintenance = db.prepare(
    "DELETE FROM maintenance_windows WHERE started_at >= ? AND started_at < ?"
  ).run(monthStart, monthEnd).changes;
  return { operations, statusHistory, maintenance };
}

// גיבוי מסד הנתונים ליעד (better-sqlite3 backup API — בטוח גם תוך כדי כתיבה)
function backupDatabase(destPath) {
  return db.backup(destPath);
}

module.exports = {
  findSiteByCode,
  insertSite,
  insertOperation,
  applyCycleCounter,
  updateSiteStatus,
  updateLastSeen,
  closeOpenStatus,
  insertStatusHistory,
  applyStateChange,
  getAllSites,
  getCurrentStatusSince,
  getStatusHistory,
  getMaintenanceHistory,
  getRecentOperations,
  getFilteredOperations,
  startMaintenance,
  getActiveMaintenance,
  cancelMaintenance,
  getSiteStats,
  getSiteUptime,
  getLastFaultAt,
  getLastOperation,
  updateLastSeenIfNewer,
  getOpenStatusStartedAt,
  getUptimeBreakdown,
  getCycleDelta,
  getPeriodBreakdown,
  getSiteInsights,
  getActivityLog,
  wasInMaintenance,
  generateMonthlySummary,
  getSystemSummary,
  getSystemMonthlyBreakdown,
  hasMonthlySummary,
  getRawMonthsBefore,
  deleteRawInRange,
  backupDatabase,
};