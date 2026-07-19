const db = require("./db");

async function findSiteByCode(code) {
  return await db.prepare("SELECT * FROM sites WHERE code = ?").get(code);
}

async function insertSite(code, siteName, meta = {}, isNewSite = 1) {
  const now = new Date().toISOString();
  const { plcType = null, plcIp = null, siteIp = null, tier = "basic" } = meta;
  return await db
    .prepare(
      `INSERT INTO sites (code, site_name, registered_at, plc_type, plc_ip, site_ip, is_new_site, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(code, siteName, now, plcType, plcIp, siteIp, isNewSite ? 1 : 0, tier);
}

async function insertOperation(siteId, startEnd, entryExit, cardNumber, state, isAnomaly, occurredAt, receivedAt) {
  try {
    const result = await db
      .prepare(
        `INSERT INTO operations (site_id, start_end, entry_exit, card_number, state, is_anomaly, occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(siteId, startEnd, entryExit, cardNumber, state, isAnomaly, occurredAt, receivedAt);
    return { inserted: true, result };
  } catch (err) {
    // 23505 = unique_violation ב-Postgres (היה SQLITE_CONSTRAINT_UNIQUE)
    if (err.code === "23505") {
      return { inserted: false, duplicate: true };
    }
    throw err;
  }
}

// עדכן מונה סייקלים מצטבר (מטפל ב-first, delta, reset, ו-Backfill לפי זמן)
async function applyCycleCounter(siteId, current, occurredAt) {
  const site = await db
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

  await db.prepare("UPDATE sites SET cycle_total = ?, plc_cycle_last = ?, cycle_last_ts = ? WHERE id = ?")
    .run(total, current, occurredAt, siteId);

  return { mode, total, last, current };
}

// עדכון המצב הנוכחי + last_seen.
//
// last_seen מתקדם *קדימה בלבד*, בדיוק כמו ב-updateLastSeenIfNewer. קודם הוא
// נכתב ללא תנאי, ולכן הודעת state שהגיעה מאוחר (מסירה מחדש של תור MQTT אחרי
// שהשרת היה כבוי) דחפה את last_seen *אחורה* — ואתר שדיווח לפני דקה נראה
// כאילו לא נשמע 12 שעות. הסטטוס עצמו כן מתעדכן: הוא מתאר את המצב הנוכחי,
// ומי שמגן עליו מפני הודעות ישנות הוא ה-guard שב-applyStateChange.
async function updateSiteStatus(siteId, status, lastSeen) {
  return await db
    .prepare(
      `UPDATE sites
       SET status = ?,
           last_seen = CASE
             WHEN last_seen IS NULL OR last_seen < ? THEN ?
             ELSE last_seen
           END
       WHERE id = ?`
    )
    .run(status, lastSeen, lastSeen, siteId);
}

// עדכון מצב בלי לגעת ב-last_seen. משמש ל-no_comm: ההודעה הזו מגיעה מה-Broker
// (LWT) בשם האתר שהתנתק — היא מעידה שהאתר *לא* נשמע, ולכן אסור לה לרענן
// את last_seen. אחרת אתר מת נראה "נצפה זה עתה" וכלל ה-90 שניות לא יתפוס אותו.
async function updateStatusOnly(siteId, status) {
  return await db
    .prepare("UPDATE sites SET status = ? WHERE id = ?")
    .run(status, siteId);
}

async function updateLastSeen(siteId, lastSeen) {
  return await db
    .prepare("UPDATE sites SET last_seen = ? WHERE id = ?")
    .run(lastSeen, siteId);
}

// עדכון last_seen רק אם הזמן החדש מאוחר מהקיים. מונע החזרת last_seen אחורה
// כשהודעה ישנה מגיעה מאוחר (backfill / redelivery של QoS 1).
async function updateLastSeenIfNewer(siteId, lastSeen) {
  return await db
    .prepare("UPDATE sites SET last_seen = ? WHERE id = ? AND (last_seen IS NULL OR last_seen < ?)")
    .run(lastSeen, siteId, lastSeen);
}

// זמן ההתחלה של המצב הנוכחי (השורה הפתוחה ב-status_history), או null אם אין.
// משמש כ-guard: הודעה שקרתה *לפני* תחילת המצב הנוכחי היא מאוחרת, ואסור לה
// לשכתב את הסטטוס (מקביל לזיהוי ה-backfill ב-applyCycleCounter).
async function getOpenStatusStartedAt(siteId) {
  const row = await db
    .prepare("SELECT started_at FROM status_history WHERE site_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
    .get(siteId);
  return row ? row.started_at : null;
}

async function closeOpenStatus(siteId, endedAt) {
  return await db
    .prepare("UPDATE status_history SET ended_at = ? WHERE site_id = ? AND ended_at IS NULL")
    .run(endedAt, siteId);
}

async function insertStatusHistory(siteId, status, startedAt) {
  return await db
    .prepare("INSERT INTO status_history (site_id, status, started_at) VALUES (?, ?, ?)")
    .run(siteId, status, startedAt);
}

// טרנזקציה: שינוי מצב (סגירת קודם + פתיחת חדש + עדכון) כיחידה אחת.
// שלוש הפעולות חייבות להצליח או להיכשל ביחד — אחרת נשארת שורה פתוחה בלי
// סוגרת, או סטטוס שלא תואם להיסטוריה.
//
// שלוש הפונקציות הפנימיות ממשיכות לקרוא ל-db הגלובלי כרגיל; db.transaction
// מנתב אותן לאותו client דרך AsyncLocalStorage (ראה db.js). לכן החתימות
// שלהן לא השתנו.
async function applyStateChange(siteId, newStatus, occurredAt) {
  return db.transaction(async () => {
    // ============================================================
    // נעילת שורת האתר — זה מה שהיה חסר, וזה שיבש נתונים אמיתיים
    // ============================================================
    // ההגנות בקוד (בדיקת backfill, השוואת סטטוס) *קוראות ואז כותבות*. עם
    // SQLite זה היה בטוח כי העיבוד היה סינכרוני — הודעה הסתיימה לפני הבאה.
    // עם Postgres שתי הודעות מעובדות במקביל, שתיהן קוראות את אותו מצב,
    // שתיהן עוברות את ההגנה, ושתיהן כותבות.
    //
    // התוצאה בשטח (אתר 1234): שורות 'operating' כפולות באותה שנייה, ארבעה
    // מקטעים פתוחים בו-זמנית, ושורה עם ended_at מוקדם מ-started_at — משך
    // שלילי, שמרעיל את חישוב הזמינות.
    //
    // FOR UPDATE נועל את שורת האתר עד סוף הטרנזקציה, וכך שינויי מצב של אותו
    // אתר מסתדרים בזה אחר זה *ברמת ה-DB* — לא רק בתוך התהליך. זה מחזיק גם
    // אם ירוצו שני שרתים במקביל.
    await db.prepare("SELECT id FROM sites WHERE id = ? FOR UPDATE").get(siteId);

    // עכשיו, אחרי הנעילה, המצב שנקרא הוא אמיתי ולא יכול להשתנות תחתינו.
    const open = await db.prepare(
      `SELECT status, started_at FROM status_history
       WHERE site_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
    ).get(siteId);

    if (open) {
      // הודעה שקדמה למצב הפתוח הגיעה מאוחר — היא לא רשאית לשכתב אותו.
      // (אותה הגנה קיימת ב-state-handler; כאן היא אטומית.)
      if (occurredAt < open.started_at) {
        return { skipped: "backfill" };
      }
      // המצב כבר פתוח — אין מה לשנות. זה מה שמנע את השורות הכפולות:
      // הודעת state=operating והודעת operation/start נושאות את אותו מצב
      // ואת אותו חותם זמן, ובלי הבדיקה הזו שתיהן פתחו מקטע.
      if (open.status === newStatus) {
        return { skipped: "no_change" };
      }
    }

    await closeOpenStatus(siteId, occurredAt);
    await insertStatusHistory(siteId, newStatus, occurredAt);

    // ניתוק אינו "צפייה" — ראה updateStatusOnly.
    if (newStatus === "no_comm") {
      await updateStatusOnly(siteId, newStatus);
    } else {
      await updateSiteStatus(siteId, newStatus, occurredAt);
    }

    return { applied: true };
  });
}

async function getAllSites() {
  return await db.prepare("SELECT * FROM sites ORDER BY code").all();
}


// מתי המצב הנוכחי התחיל — started_at של השורה הפתוחה (ended_at IS NULL) ב-status_history
async function getCurrentStatusSince(siteId) {
  const row = await db.prepare(
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
async function getStatusHistory(siteId, limit = 10) {
  // שולפים יותר מ-limit, כי חלק מהשורות (תקלות בזמן תחזוקה) יסוננו החוצה.
  const rows = await db.prepare(
    "SELECT status, started_at, ended_at FROM status_history WHERE site_id = ? AND status != 'operating' ORDER BY started_at DESC LIMIT ?"
  ).all(siteId, Math.max(limit * 4, 40));

  if (rows.length === 0) return rows;

  // "תחזוקה גוברת" — תקלה שקרתה בזמן/בגבול תחזוקה לא מוצגת בלוג (כמו שהיא לא
  // נספרת). מזהים תחזוקה משני מקורות: מקטעי maintenance מהבקר (כבר בשליפה)
  // וחלונות תחזוקה ידניים חופפים. אותו גבול כולל כמו wasInMaintenanceMem.
  // (מהיום ה-ingestion ממילא זורק תקלות כאלה; זו הגנה על היסטוריה שכבר נרשמה.)
  const maintSegs = rows.filter((r) => r.status === "maintenance");
  const oldest = rows[rows.length - 1].started_at;
  const windows = await db
    .prepare(
      `SELECT started_at, expires_at, cancelled_at FROM maintenance_windows
       WHERE site_id = ? AND COALESCE(cancelled_at, expires_at) >= ?`
    )
    .all(siteId, oldest);

  const inMaintenance = (ts) => {
    for (const s of maintSegs) {
      if (s.started_at <= ts && (s.ended_at === null || s.ended_at >= ts)) return true;
    }
    for (const w of windows) {
      const end = w.cancelled_at || w.expires_at;
      if (w.started_at <= ts && end >= ts) return true;
    }
    return false;
  };

  return rows
    .filter((r) => !(r.status === "error" && inMaintenance(r.started_at)))
    .slice(0, limit);
}

// היסטוריית חלונות תחזוקה ידנית (מי הפעיל, משך, מתי) — מהחדש לישן.
// תחזוקה ידנית לא נרשמת ב-status_history, ולכן נשלפת בנפרד ללוג המצבים.
async function getMaintenanceHistory(siteId, limit = 10) {
  return await db.prepare(
    `SELECT set_by_name, reason, started_at, duration_hours, expires_at, cancelled_at
     FROM maintenance_windows WHERE site_id = ? ORDER BY started_at DESC LIMIT ?`
  ).all(siteId, limit);
}

async function getRecentOperations(siteId, limit = 10) {
  return await db
    .prepare("SELECT * FROM operations WHERE site_id = ? ORDER BY occurred_at DESC LIMIT ?")
    .all(siteId, limit);
}

async function getFilteredOperations({ siteCode, from, to, limit = 100 } = {}) {
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

  return await db.prepare(sql).all(...params);
}

// ===== תחזוקה =====

async function startMaintenance(siteId, setByName, durationHours, reason = null, setByRole = null) {
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + durationHours * 60 * 60 * 1000);

  // RETURNING id — ב-Postgres זו הדרך היחידה לקבל את המזהה שנוצר.
  // (ב-SQLite הוא הגיע חינם ב-lastInsertRowid.)
  const result = await db
    .prepare(
      `INSERT INTO maintenance_windows (site_id, set_by_name, set_by_role, reason, started_at, duration_hours, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .run(siteId, setByName, setByRole, reason, startedAt.toISOString(), durationHours, expiresAt.toISOString());

  return {
    id: result.lastInsertRowid,
    startedAt: startedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

async function getActiveMaintenance(siteId) {
  const now = new Date().toISOString();
  return await db
    .prepare(
      `SELECT * FROM maintenance_windows
       WHERE site_id = ? AND cancelled_at IS NULL AND expires_at > ?
       ORDER BY expires_at DESC LIMIT 1`
    )
    .get(siteId, now);
}

async function cancelMaintenance(siteId) {
  const now = new Date().toISOString();
  return await db
    .prepare(
      `UPDATE maintenance_windows SET cancelled_at = ?
       WHERE site_id = ? AND cancelled_at IS NULL AND expires_at > ?`
    )
    .run(now, siteId, now);
}

// ===== סטטיסטיקה =====

// בדוק אם בזמן נתון האתר היה בתחזוקה (ידני או PLC)
async function wasInMaintenance(siteId, ts) {
  const manual = await db
    .prepare(
      `SELECT 1 FROM maintenance_windows
       WHERE site_id = ?
         AND started_at <= ?
         AND COALESCE(cancelled_at, expires_at) >= ?
       LIMIT 1`
    )
    .get(siteId, ts, ts);
  if (manual) return true;

  const plc = await db
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
/**
 * הזמינות של אתר בחלון [from, now] — מחזיר אחוז, או null כשאין מה למדוד.
 *
 * הפונקציה הזו הכילה *הגדרה שנייה, סותרת* של זמינות: היא ספרה תחזוקה
 * כזמן זמין, וחילקה באורך החלון כולו במקום בזמן הנמדד. אותו אתר קיבל
 * ממנה 100% ומ-getUptimeBreakdown 0%.
 *
 * עכשיו היא רק עוטפת את getUptimeBreakdown — מקור אמת אחד, הגדרה אחת.
 * null (ולא 0) כשאין זמן נמדד: "אין נתון" ו"זמינות אפס" הם שני דברים שונים.
 */
async function getSiteUptime(siteId, from, to = new Date().toISOString()) {
  const uptime = await getUptimeBreakdown(siteId, { from, to });
  return uptime.measuredHours > 0 ? uptime.availabilityPercent : null;
}

// מתי התחילה התקלה האחרונה (null אם מעולם לא הייתה)
async function getLastFaultAt(siteId) {
  return (await db
    .prepare("SELECT MAX(started_at) AS t FROM status_history WHERE site_id = ? AND status = 'error'")
    .get(siteId)).t;
}

// הפעולה האחרונה — מאפשרת לדשבורד להציג "רכב נכנס/יוצא" בזמן שהאתר בפעולה
async function getLastOperation(siteId) {
  return (await db
    .prepare(
      `SELECT start_end, entry_exit, occurred_at FROM operations
       WHERE site_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`
    )
    .get(siteId)) ?? null;
}

// חשב מדדים לאתר: errors (ללא אלה שבתחזוקה), operations, אחוז כשל
async function getSiteStats(siteId, { from = null, to = null } = {}) {
  let opsSql = "SELECT COUNT(*) AS n FROM operations WHERE site_id = ? AND is_anomaly = 0 AND start_end = 'end'";
  const opsParams = [siteId];
  if (from) { opsSql += " AND occurred_at >= ?"; opsParams.push(from); }
  if (to)   { opsSql += " AND occurred_at < ?"; opsParams.push(to); }

  let errSql = "SELECT started_at FROM status_history WHERE site_id = ? AND status = 'error'";
  const errParams = [siteId];
  if (from) { errSql += " AND started_at >= ?"; errParams.push(from); }
  if (to)   { errSql += " AND started_at < ?"; errParams.push(to); }

  // כאן היה N+1 נוסף: wasInMaintenance רץ *לכל תקלה*, ושלח שתי שאילתות בכל
  // פעם. אתר עם 50 תקלות בחודש = 100 סיבובי רשת רק כדי לסווג אותן.
  // עכשיו שולפים את חלונות התחזוקה ואת מקטעי ה-maintenance פעם אחת,
  // ומסווגים בזיכרון — בדיוק אותם תנאי גבול (ראה wasInMaintenanceMem).
  const rangeFrom = from || "";                       // בלי טווח: כל ההיסטוריה
  const rangeTo = to || "9999-12-31T23:59:59.999Z";

  // ארבע השאילתות בלתי-תלויות זו בזו — סיבוב רשת אחד במקום ארבעה בטור.
  // (היו כאן: ops בטור, errorRows בטור, ואז Promise.all על שתי האחרונות.)
  const [opsRow, errorRows, windows, maintSegs] = await Promise.all([
    db.prepare(opsSql).get(...opsParams),
    db.prepare(errSql).all(...errParams),

    db.prepare(
      `SELECT site_id, started_at, expires_at, cancelled_at
       FROM maintenance_windows
       WHERE site_id = ? AND started_at < ? AND COALESCE(cancelled_at, expires_at) >= ?`
    ).all(siteId, rangeTo, rangeFrom),

    db.prepare(
      `SELECT site_id, status, started_at, ended_at
       FROM status_history
       WHERE site_id = ? AND status = 'maintenance'
         AND started_at < ? AND (ended_at IS NULL OR ended_at >= ?)`
    ).all(siteId, rangeTo, rangeFrom),
  ]);
  const operations = opsRow.n;

  const mem = {
    windows: new Map([[siteId, windows]]),
    segments: new Map([[siteId, maintSegs]]),
  };

  let errors = 0;
  let errorsInMaintenance = 0;
  for (const row of errorRows) {
    if (wasInMaintenanceMem(mem, siteId, row.started_at)) {
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

async function generateMonthlySummary(siteId, yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const monthEnd = new Date(Date.UTC(year, month, 1)).toISOString();

  // --- פעולות ואנומליות ---
  const ops = await db.prepare(
    `SELECT
       SUM(CASE WHEN is_anomaly = 0 THEN 1 ELSE 0 END) AS operations,
       SUM(CASE WHEN is_anomaly = 1 THEN 1 ELSE 0 END) AS anomalies
     FROM operations
     WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ? AND start_end = 'end'`
  ).get(siteId, monthStart, monthEnd);

  const operations = ops.operations || 0;
  const anomalies = ops.anomalies || 0;

  // --- תקלות (כולל החרגת תחזוקה) ---
  const stats = await getSiteStats(siteId, { from: monthStart, to: monthEnd });

  // ==========================================================
  // --- שעות בכל מצב (חתוך לגבולות החודש, בשני הקצוות) ---
  // ==========================================================
  // כאן היה באג חמור. השאילתה סיננה `started_at >= monthStart`, כלומר
  // *כל מקטע שהתחיל לפני החודש ונמשך לתוכו נעלם לגמרי*. ההערה טענה
  // "חתוך לגבולות החודש", אבל היא חתכה רק את הסוף.
  //
  // אתר שנפל ב-28 בינואר ונשאר מושבת עד 10 בפברואר קיבל **0 שעות תקלה
  // בפברואר** במקום 216. אתר יציב שיושב במקטע 'ready' אחד שלושה חודשים
  // קיבל 0 שעות מוכן בחודש האמצעי.
  //
  // ולמה זה היה קריטי ולא רק לא-מדויק: cleanup-old-data מוחק את הנתונים
  // הגולמיים אחרי שנה ומשאיר את הסיכום כמקור היחיד. **השגיאה הייתה הופכת
  // בלתי הפיכה.**
  //
  // עכשיו: אותו תנאי חפיפה בדיוק שבו משתמש getUptimeBreakdown — כל מקטע
  // שחופף לחודש, עם חיתוך *בשני* הקצוות.
  const monthStartTime = new Date(monthStart).getTime();
  const monthEndTime = new Date(monthEnd).getTime();

  const statusRows = await db.prepare(
    `SELECT status, started_at, ended_at
     FROM status_history
     WHERE site_id = ?
       AND started_at < ?
       AND (ended_at IS NULL OR ended_at > ?)`
  ).all(siteId, monthEnd, monthStart);

  const hours = { ready: 0, operating: 0, error: 0, maintenance: 0, no_comm: 0 };
  for (const row of statusRows) {
    if (hours[row.status] === undefined) continue;

    // חיתוך לשני הקצוות: מקטע שהתחיל לפני החודש נספר מתחילת החודש,
    // ומקטע שנמשך אחריו נחתך בסופו. מקטע פתוח נמשך עד סוף החודש.
    const start = Math.max(new Date(row.started_at).getTime(), monthStartTime);
    const end = Math.min(
      row.ended_at ? new Date(row.ended_at).getTime() : monthEndTime,
      monthEndTime,
    );

    if (end > start) {
      hours[row.status] += (end - start) / (1000 * 60 * 60);
    }
  }

  // --- מונה סייקלים (הערך הנוכחי — מדויק לחודש הנוכחי, אפרוקסימציה להיסטוריים) ---
  const cycleEnd = (await db.prepare("SELECT cycle_total FROM sites WHERE id = ?").get(siteId)).cycle_total;

  const round = (n) => Math.round(n * 100) / 100;

  // --- שמירה (INSERT או UPDATE אם כבר קיים) ---
  await db.prepare(
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

async function getSystemSummary({ yearMonth = null, year = null, from = null, to = null } = {}) {
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

  const row = await db.prepare(`
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

async function getSystemMonthlyBreakdown({ year = null, from = null, to = null } = {}) {
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

  return await db.prepare(`
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

// ==========================================================
// זמינות — הגדרה אחת, ורק אחת
// ==========================================================
// קודם היו כאן *שתי* הגדרות סותרות, ושתיהן הוצגו כעובדה:
//   getUptimeBreakdown : תחזוקה נספרת כ"לא זמין"  → אתר בתחזוקה שבוע = 0%
//   getSiteUptime      : תחזוקה נספרת כ"זמין"     → אותו אתר בדיוק = 100%
// אותו אתר הציג 100% במסך אחד ו-0% במסך אחר, באותו רגע.
//
// ההחלטה: **תחזוקה מתוכננת מוחרגת מהמכנה לחלוטין.** היא לא זמינות ולא
// השבתה — היא פשוט לא נמדדת.
//
//     זמינות = (ready + operating) / (ready + operating + error + no_comm)
//
// שלוש סיבות:
//   1. עקביות עם כלל שכבר קיים ומתועד: תקלה שקרתה בתוך חלון תחזוקה
//      *מוחרגת* מאחוז הכשל (wasInMaintenance). אם מחלנו על התקלה, אי אפשר
//      להעניש על הזמן שבו היא קרתה. אחרת אותה תחזוקה גם מזכה וגם מרשיעה.
//   2. הממשק כבר אומר למשתמשת "מתוכנן — לא כשל". המספר צריך להסכים עם זה.
//   3. זה התקן המקובל: SLA מחריג planned maintenance מהמכנה.
//
// no_comm כן נספר כהשבתה: אתר שאיננו שומעים ממנו הוא אתר שלא יכולנו
// להוכיח שהוא נותן שירות. ההנחה השמרנית היא שלא.
//
// אתר שהיה בתחזוקה *כל* התקופה: המכנה הוא 0 → אין נתון. במקרה כזה
// measuredHours = 0, וזה השער שדרכו הממשק מציג "—" ולא "0%".
// ==========================================================

const AVAILABLE_STATUSES = ["ready", "operating"];   // זמין לשירות
const DOWN_STATUSES = ["error", "no_comm"];          // השבתה
// maintenance — מחוץ למשוואה, בכוונה.

/**
 * מחשב את הזמינות ממפת מילישניות לפי מצב. מקור האמת היחיד.
 * מחזיר { availabilityPercent, measuredMs } — measuredMs הוא המכנה,
 * ו-0 בו פירושו "אין נתון" (ולא "זמינות אפס").
 */
function availabilityFrom(ms) {
  const availableMs = AVAILABLE_STATUSES.reduce((sum, s) => sum + (ms[s] || 0), 0);
  const downMs = DOWN_STATUSES.reduce((sum, s) => sum + (ms[s] || 0), 0);
  const measuredMs = availableMs + downMs;

  return {
    measuredMs,
    availabilityPercent: measuredMs > 0
      ? Math.round((availableMs / measuredMs) * 10000) / 100
      : 0,
  };
}

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
async function getUptimeBreakdown(siteId, { from, to }) {
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

  const rows = await db
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
  const { measuredMs, availabilityPercent } = availabilityFrom(ms);

  return {
    readyHours: toHours(ms.ready),
    operatingHours: toHours(ms.operating),
    errorHours: toHours(ms.error),
    maintenanceHours: toHours(ms.maintenance),
    noCommHours: toHours(ms.no_comm),
    totalHours: toHours(totalMs),          // כל הזמן שנמדד, כולל תחזוקה (לתצוגה)
    // המכנה של הזמינות — בלי תחזוקה. 0 = אין נתון, ולא "זמינות אפס".
    measuredHours: toHours(measuredMs),
    availabilityPercent,
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
// ==========================================================
// חישוב טהור של סדרת הגרף — לוגיקת הדליים במקום אחד
// ==========================================================
// מקבל שלוש רשימות של חותמות-זמן (ISO): פעולות, כניסות ל-error, כניסות
// ל-maintenance — כבר מסוננות לטווח. מופרד מ-getPeriodBreakdown כדי ש*גם*
// המסלול ששולף מה-DB *וגם* המסלול שמחשב מנתונים שכבר נטענו (getSiteAnalyticsData)
// יפיקו בדיוק אותה סדרה. שינוי כאן משנה את שניהם — אין שתי הגדרות.
function buildPeriodSeries(opsIso, errIso, maintIso, { from, to, granularity }) {
  const byMonth = granularity === "month";

  // מפתח הדלי נגזר בשעון ה*מקומי*, לא מקידומת ה-ISO (שהיא UTC). גבולות התקופה
  // קלנדריים-מקומיים, וקיבוץ לפי UTC היה משייך פעולות סמוכות-לחצות לדלי הלא נכון.
  const keyOfDate = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    if (byMonth) return `${y}-${m}`;
    return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const tally = (isoList) => {
    const map = new Map();
    for (const iso of isoList) {
      const k = keyOfDate(new Date(iso));
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  };

  const ops = tally(opsIso);
  const errs = tally(errIso);
  const maints = tally(maintIso);

  // סדרה רציפה: דלי לכל יום/חודש מ-from ועד to *כולל*.
  // הלולאה נעצרת לפי מפתח הדלי של to, ולא לפי הזמן — תנאי כמו `cursor < to`
  // היה מפיל את הדלי של היום הנוכחי (שעדיין לא הסתיים), ואיתו כל הפעולות
  // והתקלות שקרו היום. דלי ריק מקבל 0, כדי שהגרף לא "יקפוץ".
  const points = [];
  const lastKey = keyOfDate(new Date(to));
  const cursor = new Date(from);

  // עיגון לתחילת היום/החודש, כדי שהמפתחות ייפלו על גבולות קלנדריים
  if (byMonth) cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);

  const MAX_POINTS = byMonth ? 24 : 400;   // בלם בטיחות מפני לולאה אינסופית

  while (points.length < MAX_POINTS) {
    const key = keyOfDate(cursor);
    points.push({
      label: byMonth
        ? cursor.toLocaleDateString("he-IL", { month: "short" })
        : `${cursor.getDate()}.${cursor.getMonth() + 1}`,
      operations: ops.get(key) || 0,
      errors: errs.get(key) || 0,
      maintenance: maints.get(key) || 0,
    });

    if (key === lastKey) break;

    if (byMonth) cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }

  return points;
}

async function getPeriodBreakdown(siteId, { from, to, granularity }) {
  // שלוש השאילתות בלתי-תלויות — במקביל, סיבוב רשת אחד במקום שלושה בטור.
  // תחזוקה: כמה פעמים האתר נכנס למצב תחזוקה באותו יום/חודש — מקביל ל-errors
  // (כניסות למצב), כדי שהיחידות בגרף יישארו אחידות.
  const [opsRows, errRows, maintRows] = await Promise.all([
    db.prepare(
      `SELECT occurred_at FROM operations
       WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
         AND is_anomaly = 0 AND start_end = 'end'`
    ).all(siteId, from, to),

    db.prepare(
      `SELECT started_at FROM status_history
       WHERE site_id = ? AND started_at >= ? AND started_at < ? AND status = 'error'`
    ).all(siteId, from, to),

    db.prepare(
      `SELECT started_at FROM status_history
       WHERE site_id = ? AND started_at >= ? AND started_at < ? AND status = 'maintenance'`
    ).all(siteId, from, to),
  ]);

  return buildPeriodSeries(
    opsRows.map((r) => r.occurred_at),
    errRows.map((r) => r.started_at),
    maintRows.map((r) => r.started_at),
    { from, to, granularity },
  );
}

/**
 * כל נתוני מסך האנליטיקה — תקופה נוכחית + תקופת השוואה — משליפה *אחת* של
 * הנתונים הגולמיים על פני טווח-העל [prev.from, range.to].
 *
 * קודם המסלול ירה 5 קריאות נפרדות (getSiteStats×2, getUptimeBreakdown×2,
 * getPeriodBreakdown) = ~14 שאילתות. loadRangeData מביא את אותם נתונים גולמיים
 * ב-3 שאילתות, וכל השאר מחושב בזיכרון עם *אותן* פונקציות טהורות שמשמשות את
 * המנהל הכללי (statsFromData/uptimeFromData) ואת הגרף (buildPeriodSeries) —
 * ולכן המספרים זהים בהגדרה. סה"כ: findSiteByCode(1) + 3 = 4 שאילתות.
 *
 * טווח-העל מכיל את שתי התקופות, ולכן כל תת-טווח מחושב ממנו בלי שליפה נוספת
 * (ראה ההוכחה בתנאי הגבול של loadRangeData). הגרף מכסה את התקופה הנוכחית בלבד.
 */
async function getSiteAnalyticsData(siteId, { range, prev, granularity }) {
  const data = await loadRangeData([siteId], { from: prev.from, to: range.to });

  // סדרת הגרף — התקופה הנוכחית בלבד, מאותם נתונים שכבר נטענו.
  // אותם מסננים בדיוק כמו השאילתות של getPeriodBreakdown.
  const inRange = (t) => t >= range.from && t < range.to;
  const segs = data.segments.get(siteId) || [];
  const opsIso = (data.ops.get(siteId) || [])
    .filter((o) => o.is_anomaly === 0 && o.start_end === "end" && inRange(o.occurred_at))
    .map((o) => o.occurred_at);
  // תקלות בזמן תחזוקה מוחרגות גם מגרף המגמה — "תחזוקה גוברת". כך הגרף עקבי
  // עם stats.errors (שגם הוא מחריג דרך wasInMaintenanceMem) ולא מציג תקלה
  // שאיננה נספרת. מהיום ה-ingestion ממילא לא רושם תקלות כאלה; זו הגנה על היסטוריה.
  const errIso = segs
    .filter((s) => s.status === "error" && inRange(s.started_at)
      && !wasInMaintenanceMem(data, siteId, s.started_at))
    .map((s) => s.started_at);
  const maintIso = segs
    .filter((s) => s.status === "maintenance" && inRange(s.started_at))
    .map((s) => s.started_at);

  return {
    stats: statsFromData(data, siteId, range),
    uptime: uptimeFromData(data, siteId, range),
    prevStats: statsFromData(data, siteId, prev),
    prevUptime: uptimeFromData(data, siteId, prev),
    chart: buildPeriodSeries(opsIso, errIso, maintIso, {
      from: range.from, to: range.to, granularity,
    }),
  };
}

const WEEKDAY_LABELS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/**
 * סטטיסטיקה מעמיקה לאתר בטווח [from, to) — למסך "עוד מידע".
 *
 * שולף פעם אחת את הפעולות ואת מקטעי המצב, ומחשב הכל ב-JS.
 * זול יותר מ-8 שאילתות נפרדות, ומאפשר חישובים (שיוך start↔end) שקשה לבטא ב-SQL.
 */
async function getSiteInsights(siteId, { from, to }) {
  // ארבע השאילתות של המסך (פעולות, מקטעי error, מקטעי maintenance, חלונות
  // ידניים) בלתי-תלויות זו בזו — נשלפות במקביל, סיבוב רשת אחד במקום ארבעה.
  // כל העיבוד למטה הוא ב-JS על הנתונים שכבר בזיכרון.
  const [ops, errorRows, maintRows, windows] = await Promise.all([
    // --- כל הפעולות בטווח, כרונולוגית (צריך גם start וגם end לשיוך משכים) ---
    db.prepare(
      `SELECT start_end, entry_exit, card_number, is_anomaly, occurred_at
       FROM operations
       WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at ASC, id ASC`
    ).all(siteId, from, to),

    // --- מקטעי error בטווח (להשבתות) ---
    db.prepare(
      `SELECT started_at, ended_at FROM status_history
       WHERE site_id = ? AND status = 'error' AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)`
    ).all(siteId, to, from),

    // --- מקטעי maintenance בטווח (מתוכננת, נמדדת בנפרד מהשבתות) ---
    db.prepare(
      `SELECT started_at, ended_at FROM status_history
       WHERE site_id = ? AND status = 'maintenance' AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)`
    ).all(siteId, to, from),

    // --- חלונות תחזוקה ידניים שהופעלו מהדשבורד ---
    db.prepare(
      `SELECT set_by_name, reason, started_at, duration_hours, cancelled_at
       FROM maintenance_windows
       WHERE site_id = ? AND started_at >= ? AND started_at < ?
       ORDER BY started_at DESC`
    ).all(siteId, from, to),
  ]);

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

  // ===== השבתות (מקטעי error בטווח) — errorRows נשלף למעלה במקביל =====
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

  // ===== תחזוקה — מתוכננת, ולכן נמדדת בנפרד מהשבתות =====
  // שני מקורות: מצב תחזוקה שמדווח מה-PLC (maintRows), וחלונות תחזוקה ידניים
  // שהופעלו מהדשבורד (windows). שניהם נשלפו למעלה במקביל.
  let maintMs = 0, longestMaintMs = 0;
  for (const row of maintRows) {
    const s = Math.max(Date.parse(row.started_at), windowStart);
    const e = Math.min(row.ended_at ? Date.parse(row.ended_at) : windowEnd, windowEnd);
    const span = e - s;
    if (span <= 0) continue;
    maintMs += span;
    if (span > longestMaintMs) longestMaintMs = span;
  }

  // ספירות "שהתחילו בתקופה" — לפילוח הפעילות (כניסות/יציאות/תקלות/תחזוקה)
  // היחידה חייבת להיות אחידה: אירועים שקרו בתקופה. זה עקבי עם *גרף המגמה*
  // (getPeriodBreakdown סופר כניסה למצב בתוך [from,to)), בשונה מ-
  // downtime.incidents / maintenance.plcEntries שסופרים *חפיפה* (מקטע שהתחיל
  // לפני התקופה ונמשך לתוכה).
  //
  // הערה: 'errors' כאן סופר את *כל* התקלות שהתחילו בתקופה, כולל כאלה שקרו בזמן
  // תחזוקה. זה שונה מ-analytics.stats.errors (הכרטיס), שמחריג בכוונה תקלות
  // שקרו בחלון תחזוקה — כי לא מענישים על תקלה בהשבתה מתוכננת. לפילוח "כמה
  // אירועים קרו" הספירה המלאה נכונה; אחוז הכשל הוא מדד אחר.
  //
  // errorRows/maintRows כבר מסוננים ל-started_at < to, ולכן די בסינון >= from.
  //
  // תקלה שהתחילה בזמן/בגבול תחזוקה (בתוך מקטע maintenance מהבקר) אינה נספרת —
  // "תחזוקה גוברת", עקבי עם statsFromData ועם גרף המגמה. חלונות ידניים כבר
  // נחסמים בקליטה (state-handler); כאן בדיקת ה-PLC מכסה את המקרה ההיסטורי השכיח.
  const inMaint = (ts) =>
    maintRows.some((s) => s.started_at <= ts && (s.ended_at === null || s.ended_at >= ts));
  const errorsStarted = errorRows.filter(
    (r) => r.started_at >= from && !inMaint(r.started_at)
  ).length;
  const maintenanceEvents =
    maintRows.filter((r) => r.started_at >= from).length + windows.length;

  return {
    totals: {
      operations,
      entries,
      exits,
      anomalies,
      activeDays,
      errors: errorsStarted,           // כל התקלות שהתחילו בתקופה (כמו גרף המגמה)
      maintenanceEvents,               // כניסות לתחזוקה (PLC) + חלונות ידניים, שהתחילו בתקופה
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
    maintenance: {
      plcEntries: maintRows.length,                // כמה פעמים האתר נכנס למצב תחזוקה
      totalHours: hrs(maintMs),                    // סך הזמן בתחזוקה
      longestHours: hrs(longestMaintMs),
      manualWindows: windows.length,               // חלונות שהופעלו ידנית מהדשבורד
      cancelledWindows: windows.filter((w) => w.cancelled_at).length,
      recentWindows: windows.slice(0, 5).map((w) => ({
        setBy: w.set_by_name,
        reason: w.reason,
        startedAt: w.started_at,
        durationHours: w.duration_hours,
        cancelled: Boolean(w.cancelled_at),
      })),
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
async function getActivityLog(siteId, { from, to, limit = 300 }) {
  const countIn = async (table, timeCol) =>
    (await db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ? AND ${timeCol} >= ? AND ${timeCol} < ?`
    ).get(siteId, from, to)).n;

  // תחזוקה מגיעה משני מקורות: חלון ידני (maintenance_windows) *וגם* מצב
  // תחזוקה שמדווח מה-PLC (status_history.status='maintenance'). המונים חייבים
  // לשקף את שניהם, אחרת מסנן "תחזוקה" בלוג מציג 0 בזמן שיש תחזוקה בפועל.
  //
  // extra מחריג את 'operating' מספירת המצבים — בדיוק כמו מהתצוגה. בלי זה
  // הצ'יפ "מצבים" היה מציג מספר גדול מכמות השורות שבאמת מופיעות בלוג.
  const countStatus = async (op, extra = "") =>
    (await db.prepare(
      `SELECT COUNT(*) AS n FROM status_history
       WHERE site_id = ? AND started_at >= ? AND started_at < ?
         AND status ${op} 'maintenance' ${extra}`
    ).get(siteId, from, to)).n;

  // שמונה השאילתות (שלוש רשימות + חמישה מונים) בלתי-תלויות זו בזו —
  // נשלפות במקביל, סיבוב רשת אחד במקום שמונה בטור. זה היה המסלול האיטי ביותר.
  //
  // הערה על 'operating': כל פעולת חניה מייצרת גם state=operating וגם הודעת
  // operation, ולכן בציר הזמן המאוחד ("הכל") כל כניסת רכב הופיעה פעמיים. לכן
  // השרת מחזיר את הכל, וה-ActivityLog מסתיר את 'operating' בכל מסנן חוץ מ-
  // "שינויי מצב" (שם הרעש הזה הוא בדיוק התוכן). getStatusHistory (הפאנל) *כן*
  // מסנן — שם זו תצוגה מתומצתת. שום חישוב (זמינות/אחוז כשל) לא נגזר מכאן.
  //
  // המונים הם הסכומים ה*מלאים* בתקופה (בלי LIMIT), גם אם entries נחתך —
  // כדי שה-UI יוכל לומר "מוצגות 300 מתוך 812". הקטגוריות זרות זו לזו:
  //   status    = שינויי מצב שאינם תחזוקה ו*בלי* 'בפעולה' — המונה של "הכל".
  //   statusAll = אותו דבר, *כולל* 'בפעולה' — המונה של הצ'יפ "שינויי מצב".
  //   maintenance = חלונות ידניים + מצב תחזוקה מה-PLC.
  const [ops, states, maint, cOperations, cStatus, cStatusAll, cMaintWindows, cMaintStatus] =
    await Promise.all([
      db.prepare(
        `SELECT start_end, entry_exit, card_number, is_anomaly, state, occurred_at
         FROM operations
         WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
         ORDER BY occurred_at DESC LIMIT ?`
      ).all(siteId, from, to, limit),

      db.prepare(
        `SELECT status, started_at, ended_at FROM status_history
         WHERE site_id = ? AND started_at >= ? AND started_at < ?
         ORDER BY started_at DESC LIMIT ?`
      ).all(siteId, from, to, limit),

      db.prepare(
        `SELECT set_by_name, set_by_role, reason, started_at, duration_hours, expires_at, cancelled_at
         FROM maintenance_windows
         WHERE site_id = ? AND started_at >= ? AND started_at < ?
         ORDER BY started_at DESC LIMIT ?`
      ).all(siteId, from, to, limit),

      countIn("operations", "occurred_at"),
      countStatus("!=", "AND status != 'operating'"),
      countStatus("!="),
      countIn("maintenance_windows", "started_at"),
      countStatus("="),
    ]);

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

  // "תחזוקה גוברת" — תקלה שקרתה בזמן/בגבול תחזוקה לא מוצגת בלוג ולא נספרת
  // בצ'יפים. מזהים תחזוקה ממקטעי ה-PLC (בתוך states) וחלונות ידניים (maint).
  // (מהיום ה-ingestion זורק תקלות כאלה; זו הגנה על היסטוריה שכבר נרשמה.)
  const maintSegs = states.filter((s) => s.status === "maintenance");
  const inMaintenance = (ts) => {
    for (const s of maintSegs) {
      if (s.started_at <= ts && (s.ended_at === null || s.ended_at >= ts)) return true;
    }
    for (const w of maint) {
      const end = w.cancelled_at || w.expires_at;
      if (w.started_at <= ts && end >= ts) return true;
    }
    return false;
  };
  const isMaintError = (s) => s.status === "error" && inMaintenance(s.started_at);
  const visibleStates = states.filter((s) => !isMaintError(s));
  const hiddenErrors = states.length - visibleStates.length;

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
    ...visibleStates.map((s) => ({
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
      operations: cOperations,
      // מפחיתים את התקלות שהוסתרו (בזמן תחזוקה) כדי שהצ'יפ יתאים למספר השורות
      // שבאמת מוצגות. hiddenErrors נספר מתוך החלון המוגבל — מדויק למקרה השכיח.
      status: Math.max(0, cStatus - hiddenErrors),
      statusAll: Math.max(0, cStatusAll - hiddenErrors),
      maintenance: cMaintWindows + cMaintStatus,   // חלונות ידניים + מצב תחזוקה מה-PLC
    },
  };
}

// ==========================================================
// ===== שכבת ה-BATCH — הפתרון ל-N+1 =====
// ==========================================================
//
// הבעיה: הפונקציות לכל אתר (getSiteStats, getUptimeBreakdown...) נקראו בתוך
// לולאות — פעם לכל אתר, ובמנהל הכללי גם פעם לכל *דלי* בגרף. מול SQLite מקומי
// שאילתה עלתה מיקרו-שניות וזה לא הורגש. מול Postgres מרוחק כל שאילתה היא
// סיבוב רשת (~100ms), ולכן:
//
//     מנהל כללי, חודש, אתר אחד     = 100 שאילתות = 3.5 שניות
//     מנהל כללי, חודש, 200 אתרים   = ~18,000 שאילתות = בלתי שמיש
//
// הפתרון: לשלוף את הנתונים הגולמיים *פעם אחת* לכל הטווח ולכל האתרים, ולחשב
// את כל האתרים וכל הדליים בזיכרון. מספר השאילתות הופך לקבוע — הוא לא גדל
// עם מספר האתרים ולא עם מספר הדליים.
//
// קריטי: החישוב כאן הוא *העתק מדויק* של האריתמטיקה בפונקציות לכל אתר —
// אותם חיתוכים, אותם עיגולים, אותם תנאי גבול. הפונקציות המקוריות נשארו
// כפי שהן ומשמשות את ה-endpoints של אתר בודד.
// ==========================================================

/**
 * שולף את כל הנתונים הגולמיים הדרושים לטווח — 3 שאילתות, ללא תלות בכמות
 * האתרים או הדליים.
 *
 * הטווח שנשלף הוא *מכיל* (superset) של מה שכל דלי צריך, ולכן אפשר לחשב ממנו
 * כל תת-טווח בזיכרון.
 */
async function loadRangeData(siteIds, { from, to }) {
  const empty = { ops: new Map(), segments: new Map(), windows: new Map() };
  if (siteIds && siteIds.length === 0) return empty;

  // siteIds === null פירושו "כל האתרים". זה לא נוחות בלבד: בלי זה היינו
  // חייבים לשלוף קודם את רשימת האתרים כדי לדעת את המזהים — סיבוב רשת שלם
  // (115ms) בטור, לפני שאפשר בכלל להתחיל. בלעדיו הכול רץ במקביל.
  const filter = siteIds ? `site_id IN (${siteIds.map(() => "?").join(",")})` : "TRUE";
  const ids = siteIds || [];

  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.site_id)) m.set(r.site_id, []);
      m.get(r.site_id).push(r);
    }
    return m;
  };

  const [ops, segments, windows] = await Promise.all([
    // כל הפעולות בטווח
    db.prepare(
      `SELECT site_id, occurred_at, entry_exit, start_end, is_anomaly
       FROM operations
       WHERE ${filter} AND occurred_at >= ? AND occurred_at < ?`
    ).all(...ids, from, to),

    // כל מקטעי המצב שחופפים לטווח.
    // '>= from' ולא '> from' (כמו במקור) — זה superset, ומקטע באורך אפס
    // תורם 0ms ממילא. עדיף להביא יותר מדי מלפספס מקטע קצה.
    db.prepare(
      `SELECT site_id, status, started_at, ended_at
       FROM status_history
       WHERE ${filter} AND started_at < ? AND (ended_at IS NULL OR ended_at >= ?)`
    ).all(...ids, to, from),

    // חלונות תחזוקה ידנית שחופפים לטווח (להחרגת תקלות שקרו בתחזוקה)
    db.prepare(
      `SELECT site_id, started_at, expires_at, cancelled_at
       FROM maintenance_windows
       WHERE ${filter} AND started_at < ? AND COALESCE(cancelled_at, expires_at) >= ?`
    ).all(...ids, to, from),
  ]);

  return { ops: group(ops), segments: group(segments), windows: group(windows) };
}

// האם ברגע ts האתר היה בתחזוקה — גרסת הזיכרון של wasInMaintenance.
//
// הגבול *כולל* בשני הקצוות (<= ... >=) *במכוון*: "מצב תחזוקה גובר על הכלל".
// כשה-PLC עובר מתחזוקה לתקלה, applyStateChange סוגר את מקטע התחזוקה ופותח
// את מקטע התקלה באותו חותם זמן (maintenance.ended_at === error.started_at).
// ה-'>=' גורם לתקלה שמתחילה בדיוק כשהתחזוקה נגמרה להיחשב "בתוך תחזוקה"
// ולכן היא מוחרגת מהספירה — בדיוק ההתנהגות הרצויה: תקלה בזמן/בגבול תחזוקה
// אינה תקלה. (מהיום גם ה-ingestion זורק תקלות כאלה לחלוטין — ראה state-handler;
// כאן זו הגנה על נתונים היסטוריים שכבר נרשמו.)
function wasInMaintenanceMem(data, siteId, ts) {
  for (const w of data.windows.get(siteId) || []) {
    const end = w.cancelled_at || w.expires_at;
    if (w.started_at <= ts && end >= ts) return true;
  }
  for (const s of data.segments.get(siteId) || []) {
    if (s.status !== "maintenance") continue;
    if (s.started_at <= ts && (s.ended_at === null || s.ended_at >= ts)) return true;
  }
  return false;
}

/** גרסת הזיכרון של getSiteStats — מחזירה את אותו אובייקט בדיוק. */
function statsFromData(data, siteId, { from, to }) {
  let operations = 0;
  for (const o of data.ops.get(siteId) || []) {
    if (o.is_anomaly === 0 && o.start_end === "end" &&
        o.occurred_at >= from && o.occurred_at < to) operations++;
  }

  let errors = 0;
  let errorsInMaintenance = 0;
  for (const s of data.segments.get(siteId) || []) {
    if (s.status !== "error") continue;
    if (!(s.started_at >= from && s.started_at < to)) continue;
    if (wasInMaintenanceMem(data, siteId, s.started_at)) errorsInMaintenance++;
    else errors++;
  }

  const failureRate = operations > 0 ? (errors / operations) * 100 : 0;
  return {
    operations,
    errors,
    errorsInMaintenance,
    failureRate: Math.round(failureRate * 100) / 100,
  };
}

/** גרסת הזיכרון של getUptimeBreakdown — אותם חיתוכים ואותם עיגולים. */
function uptimeFromData(data, siteId, { from, to }) {
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

  const ms = { ready: 0, operating: 0, error: 0, maintenance: 0, no_comm: 0 };

  for (const row of data.segments.get(siteId) || []) {
    if (ms[row.status] === undefined) continue;
    // אותו תנאי חפיפה כמו בשאילתה המקורית
    if (!(row.started_at < rangeEnd && (row.ended_at === null || row.ended_at > from))) continue;

    const start = Math.max(Date.parse(row.started_at), windowStart);
    const end = Math.min(row.ended_at ? Date.parse(row.ended_at) : windowEnd, windowEnd);
    if (end > start) ms[row.status] += end - start;
  }

  const toHours = (v) => Math.round((v / 3600000) * 100) / 100;
  const totalMs = Object.values(ms).reduce((a, b) => a + b, 0);
  const { measuredMs, availabilityPercent } = availabilityFrom(ms);

  return {
    readyHours: toHours(ms.ready),
    operatingHours: toHours(ms.operating),
    errorHours: toHours(ms.error),
    maintenanceHours: toHours(ms.maintenance),
    noCommHours: toHours(ms.no_comm),
    totalHours: toHours(totalMs),          // כל הזמן שנמדד, כולל תחזוקה (לתצוגה)
    // המכנה של הזמינות — בלי תחזוקה. 0 = אין נתון, ולא "זמינות אפס".
    measuredHours: toHours(measuredMs),
    availabilityPercent,
  };
}

/** גרסת הזיכרון של getDirectionCounts (על פני קבוצת אתרים). */
function directionFromData(data, siteIds, { from, to }) {
  let entries = 0, exits = 0;
  for (const id of siteIds) {
    for (const o of data.ops.get(id) || []) {
      if (o.is_anomaly !== 0 || o.start_end !== "end") continue;
      if (!(o.occurred_at >= from && o.occurred_at < to)) continue;
      if (o.entry_exit === "entry") entries++;
      else if (o.entry_exit === "exit") exits++;
    }
  }
  return { entries, exits };
}

/**
 * המדדים שאינם תלויי-טווח, לכל האתרים בבת אחת — 5 שאילתות במקום 5 לכל אתר.
 * מחזיר Map: site_id → { lastFaultAt, statusSince, lastOperation,
 *                        operationsSinceLastError, activeMaintenance, firstStatusAt }
 */
async function getAllSitesGlobals(siteIds) {
  const result = new Map();
  if (siteIds && siteIds.length === 0) return result;

  // כמו ב-loadRangeData: null = כל האתרים, כדי לא לחכות לשליפת המזהים.
  const all = !siteIds;
  const filter = all ? "TRUE" : `site_id IN (${siteIds.map(() => "?").join(",")})`;
  const ids = siteIds || [];

  const blank = () => ({
    lastFaultAt: null, statusSince: null, lastOperation: null,
    operationsSinceLastError: 0, activeMaintenance: null, firstStatusAt: null,
  });
  const at = (id) => {
    if (!result.has(id)) result.set(id, blank());
    return result.get(id);
  };
  for (const id of ids) at(id);

  const holes = filter;   // נשאר בשם הזה כדי לא לשנות את גוף השאילתות
  const now = new Date().toISOString();

  const [faults, open, lastOps, sinceError, maint] = await Promise.all([
    // התקלה האחרונה + המקטע הראשון אי-פעם (ל-getSiteUptime)
    db.prepare(
      `SELECT site_id,
              MAX(started_at) FILTER (WHERE status = 'error') AS "lastFaultAt",
              MIN(started_at) AS "firstStatusAt"
       FROM status_history
       WHERE ${holes}
       GROUP BY site_id`
    ).all(...ids),

    // המצב הפתוח הנוכחי. DISTINCT ON הוא הדרך של Postgres ל"שורה אחת לכל
    // קבוצה" — במקום שאילתה נפרדת עם LIMIT 1 לכל אתר.
    db.prepare(
      `SELECT DISTINCT ON (site_id) site_id, started_at
       FROM status_history
       WHERE ${holes} AND ended_at IS NULL
       ORDER BY site_id, started_at DESC`
    ).all(...ids),

    // הפעולה האחרונה
    db.prepare(
      `SELECT DISTINCT ON (site_id) site_id, start_end, entry_exit, occurred_at
       FROM operations
       WHERE ${holes}
       ORDER BY site_id, occurred_at DESC, id DESC`
    ).all(...ids),

    // כמה פעולות מאז התקלה האחרונה. CTE מחשב את זמן התקלה לכל אתר, ואז
    // סופרים מולו — הכול בשאילתה אחת במקום שתיים לכל אתר.
    db.prepare(
      `WITH last_fault AS (
         SELECT site_id, MAX(started_at) AS t
         FROM status_history
         WHERE ${holes} AND status = 'error'
         GROUP BY site_id
       )
       SELECT o.site_id, COUNT(*) AS n
       FROM operations o
       LEFT JOIN last_fault f ON f.site_id = o.site_id
       WHERE ${holes.replace(/site_id/g, "o.site_id")}
         AND o.is_anomaly = 0 AND o.start_end = 'end'
         AND (f.t IS NULL OR o.occurred_at > f.t)
       GROUP BY o.site_id`
    ).all(...ids, ...ids),

    // תחזוקה ידנית פעילה כרגע
    db.prepare(
      `SELECT DISTINCT ON (site_id) *
       FROM maintenance_windows
       WHERE ${holes} AND cancelled_at IS NULL AND expires_at > ?
       ORDER BY site_id, expires_at DESC`
    ).all(...ids, now),
  ]);

  // at() ולא result.get(): כשקוראים עם null (כל האתרים) המפה מתחילה ריקה,
  // ו-get היה מחזיר undefined — כל המדדים היו נזרקים בשקט.
  for (const r of faults) {
    const g = at(r.site_id);
    g.lastFaultAt = r.lastFaultAt;
    g.firstStatusAt = r.firstStatusAt;
  }
  for (const r of open) {
    at(r.site_id).statusSince = r.started_at;
  }
  for (const r of lastOps) {
    at(r.site_id).lastOperation = {
      start_end: r.start_end, entry_exit: r.entry_exit, occurred_at: r.occurred_at,
    };
  }
  for (const r of sinceError) {
    at(r.site_id).operationsSinceLastError = r.n;
  }
  for (const r of maint) {
    at(r.site_id).activeMaintenance = r;
  }

  return result;
}

/**
 * גרסת ה-batch של GET /api/sites: כל האתרים, כל המדדים — במספר שאילתות
 * קבוע (8) במקום 6 לכל אתר. מחזיר בדיוק את אותו מבנה כמו הלולאה הישנה.
 */
async function getAllSitesWithMetrics({ from }) {
  const now = new Date().toISOString();

  // הכול במקביל — אין תלות בין שליפת האתרים לשליפת הנתונים שלהם
  const [sites, data, globals] = await Promise.all([
    getAllSites(),
    loadRangeData(null, { from, to: now }),
    getAllSitesGlobals(null),
  ]);
  if (sites.length === 0) return [];

  return sites.map((site) => {
    // אתר שאין לו שום היסטוריה לא יופיע בשליפות — ואז g היה undefined
    const g = globals.get(site.id) || {
      lastFaultAt: null, statusSince: null, lastOperation: null,
      operationsSinceLastError: 0, activeMaintenance: null, firstStatusAt: null,
    };
    const stats = statsFromData(data, site.id, { from, to: now });

    // חלון תחזוקה ידני פעיל. הוא גובר על מה שה-PLC דיווח (כמו applyMaintenanceStatus):
    // תקלה שקורה בתוך תחזוקה מתוכננת אינה "תקלה" — היא כבר מוחרגת מאחוז הכשל
    // (wasInMaintenance), וכאן היא לא הופכת את הכרטיס ל"מושבת". הדגל נחשף כדי
    // שגם עדכון ה-SSE החי בכרטיס (sitePatch) יכבד את אותו כלל, ולא רק ריענון מלא.
    const inMaintenance = !!g.activeMaintenance;
    const status = inMaintenance || site.status === "maintenance"
      ? "maintenance"
      : site.status;

    return {
      ...site,
      status,
      inMaintenance,
      failureRate: stats.failureRate,
      operations: stats.operations,
      errors: stats.errors,
      uptime: uptimeFromDataLegacy(data, site.id, from, now),
      lastFaultAt: g.lastFaultAt,
      lastOperation: g.lastOperation,
      statusSince: g.statusSince,
    };
  });
}

/**
 * גרסת הזיכרון של getSiteUptime (השונה מ-getUptimeBreakdown!):
 * אחוז הזמן שהאתר *לא* היה ב-error/no_comm, מתוך *כל* החלון — ולא מתוך
 * הזמן הנמדד. מחזיר null כשאין היסטוריה, בדיוק כמו המקור.
 */
function uptimeFromDataLegacy(data, siteId, from, to) {
  const uptime = uptimeFromData(data, siteId, { from, to });
  return uptime.measuredHours > 0 ? uptime.availabilityPercent : null;
}

// ==========================================================
// ===== אגרגציה מערכתית (מנהל בקרה / מנהל כללי) =====
// ==========================================================

/**
 * גבולות הדליים לתקופה — [{ label, from, to }].
 * נחוץ כדי לחשב מדד *לכל דלי* (למשל זמינות ליום), מה ש-getPeriodBreakdown
 * לא מספק (הוא מחזיר ספירות בלבד).
 */
function getBucketRanges({ from, to, granularity }) {
  const byMonth = granularity === "month";
  const byWeek = granularity === "week";

  const keyOf = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    if (byMonth) return `${y}-${m}`;
    // שבוע: מזוהה לפי תאריך תחילת השבוע (ראשון), כדי ששני ימים באותו
    // שבוע ייפלו לאותו מפתח.
    return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const ranges = [];
  const lastMs = Date.parse(to);
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  if (byMonth) cursor.setDate(1);
  if (byWeek) cursor.setDate(cursor.getDate() - cursor.getDay());   // אחורה עד יום ראשון

  const MAX = byMonth ? 36 : byWeek ? 120 : 400;

  while (ranges.length < MAX) {
    const start = new Date(cursor);
    const next = new Date(cursor);
    if (byMonth) next.setMonth(next.getMonth() + 1);
    else if (byWeek) next.setDate(next.getDate() + 7);
    else next.setDate(next.getDate() + 1);

    // הדלי לא נמשך אל מעבר לקצה התקופה
    const end = next.getTime() > lastMs ? new Date(to) : next;
    const clippedStart = start.getTime() < Date.parse(from) ? new Date(from) : start;

    const label = byMonth
      ? start.toLocaleDateString("he-IL", { month: "short" })
      : byWeek
        ? `${start.getDate()}.${start.getMonth() + 1}`
        : `${start.getDate()}.${start.getMonth() + 1}`;

    ranges.push({
      key: keyOf(start),
      label,
      from: clippedStart.toISOString(),
      to: end.toISOString(),
    });

    // עוצרים כשהדלי הבא כבר מעבר לקצה
    if (next.getTime() >= lastMs) break;
    cursor.setTime(next.getTime());
  }

  return ranges;
}

/**
 * ספירת כניסות/יציאות עבור *קבוצת* אתרים בטווח — שאילתה אחת לכל דלי,
 * ולא אחת לכל אתר לכל דלי (שהיה מכפיל את מספר השאילתות במספר האתרים).
 */
async function getDirectionCounts(siteIds, { from, to }) {
  if (!siteIds || siteIds.length === 0) return { entries: 0, exits: 0 };

  const holes = siteIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT entry_exit, COUNT(*) AS n FROM operations
       WHERE site_id IN (${holes})
         AND occurred_at >= ? AND occurred_at < ?
         AND is_anomaly = 0 AND start_end = 'end'
       GROUP BY entry_exit`
    )
    .all(...siteIds, from, to);

  let entries = 0, exits = 0;
  for (const r of rows) {
    if (r.entry_exit === "entry") entries = r.n;
    else if (r.entry_exit === "exit") exits = r.n;
  }
  return { entries, exits };
}

// כמה פעולות בוצעו מאז התקלה האחרונה (מדד "כמה זמן האתר יציב")
async function getOperationsSinceLastError(siteId) {
  const lastError = await getLastFaultAt(siteId);
  if (!lastError) {
    // מעולם לא הייתה תקלה — סופרים את כל הפעולות
    return (await db.prepare(
      "SELECT COUNT(*) AS n FROM operations WHERE site_id = ? AND is_anomaly = 0 AND start_end = 'end'"
    ).get(siteId)).n;
  }
  return (await db.prepare(
    `SELECT COUNT(*) AS n FROM operations
     WHERE site_id = ? AND is_anomaly = 0 AND start_end = 'end' AND occurred_at > ?`
  ).get(siteId, lastError)).n;
}

/**
 * שורת נתונים מלאה לכל אתר בתקופה — הבסיס גם למנהל הבקרה וגם למנהל הכללי.
 * מרכיב מהפונקציות הקיימות (getSiteStats / getUptimeBreakdown) ולא משכפל לוגיקה.
 */
// ה-loader מוחזר יחד עם השורות, כדי שהמנהל הכללי יוכל להשתמש *באותם*
// נתונים גולמיים לחישוב הדליים של הגרף ומפת החום — בלי לשלוף אותם שוב.
async function getSupervisorStats({ from, to }) {
  const { rows, summary } = await getSupervisorStatsWithData({ from, to });
  return { sites: rows, summary };
}

async function getSupervisorStatsWithData({ from, to }) {
  // null = כל האתרים. כך שלוש הקבוצות רצות *במקביל* — קודם היינו מחכים
  // לרשימת האתרים (סיבוב רשת שלם) רק כדי לדעת אילו מזהים לבקש.
  const [sites, data, globals] = await Promise.all([
    getAllSites(),
    loadRangeData(null, { from, to }),
    getAllSitesGlobals(null),
  ]);

  const rows = sites.map((site) => {
    // אתר בלי שום היסטוריה לא מופיע בשליפות — ואז אין לו רשומה במפה
    const g = globals.get(site.id) || {
      lastFaultAt: null, statusSince: null, lastOperation: null,
      operationsSinceLastError: 0, activeMaintenance: null, firstStatusAt: null,
    };
    const stats = statsFromData(data, site.id, { from, to });
    const uptime = uptimeFromData(data, site.id, { from, to });
    const activeMaint = g.activeMaintenance;

    // המצב האפקטיבי: תחזוקה ידנית פעילה גוברת על מה שה-PLC דיווח
    const status = activeMaint || site.status === "maintenance" ? "maintenance" : site.status;

    return {
      code: site.code,
      name: site.site_name,
      status,
      operations: stats.operations,
      errors: stats.errors,
      failureRate: stats.failureRate,
      availability: uptime.availabilityPercent,
      // הזמן *הנמדד* (בלי תחזוקה) — אתר שהיה בתחזוקה כל התקופה אין
      // עליו נתון זמינות, ואסור להציג לו 0%.
      hasUptimeData: uptime.measuredHours > 0,
      maintenanceHours: uptime.maintenanceHours,
      downtimeHours: uptime.errorHours,
      lastError: g.lastFaultAt,
      operationsSinceLastError: g.operationsSinceLastError,
      cycleTotal: site.cycle_total,
      // לא ניתן לחישוב: המונה אינו נשמר לכל פעולה (ראה getCycleDelta)
      cycleDelta: null,
      inManualMaintenance: Boolean(activeMaint),
    };
  });

  // שתי שאלות שונות לגמרי, ואסור לערבב ביניהן:
  //   sitesInError      — כמה אתרים *מושבתים ברגע זה* (מצב נוכחי, כמו בתחזוקה/ללא תקשורת)
  //   sitesWithErrors   — בכמה אתרים *הייתה* תקלה כלשהי בתקופה הנבחרת (מצטבר)
  // אתר שנפל והתאושש נספר ב-sitesWithErrors אבל לא ב-sitesInError.
  const summary = {
    totalSites: rows.length,
    sitesInError: rows.filter((r) => r.status === "error").length,
    sitesWithErrors: rows.filter((r) => r.errors > 0).length,
    sitesInMaintenance: rows.filter((r) => r.status === "maintenance").length,
    sitesOffline: rows.filter((r) => r.status === "no_comm").length,
  };

  // data ו-globals נמסרים הלאה: המנהל הכללי מחשב מהם את דליי הגרף ואת מפת
  // החום *בלי אף שאילתה נוספת*. זה מה שהופך את המנהל הכללי מ-100 שאילתות
  // לספרה חד-ספרתית.
  return { rows, summary, data, sites };
}

// התקלות האחרונות בכל המערכת (חוצה אתרים)
//
// ⚠️ המרכאות הכפולות סביב ה-aliases אינן קישוט. Postgres מקטין כל מזהה
// שאינו מצוטט לאותיות קטנות, ולכן `AS siteCode` היה חוזר כ-`sitecode`
// ו-r.siteCode היה undefined — האובייקט היה נבנה ריק, בלי שאף שגיאה תיזרק.
// SQLite שימר את הרישיות ולכן זה עבד שם. זה ההבדל היחיד ב-SQL שבאמת נשך.
async function getRecentErrors({ limit = 10 } = {}) {
  return (await db
    .prepare(
      `SELECT s.code AS "siteCode", s.site_name AS "siteName",
              h.started_at AS "startedAt", h.ended_at AS "endedAt"
       FROM status_history h
       JOIN sites s ON h.site_id = s.id
       WHERE h.status = 'error'
         -- "תחזוקה גוברת" — תקלה שהתחילה בתוך/בגבול תחזוקה לא מוצגת (כמו שהיא
         -- לא נספרת). מקור 1: מקטע maintenance מהבקר. גבול כולל כמו wasInMaintenanceMem.
         AND NOT EXISTS (
           SELECT 1 FROM status_history m
           WHERE m.site_id = h.site_id AND m.status = 'maintenance'
             AND m.started_at <= h.started_at
             AND (m.ended_at IS NULL OR m.ended_at >= h.started_at)
         )
         -- מקור 2: חלון תחזוקה ידני מה-dashboard.
         AND NOT EXISTS (
           SELECT 1 FROM maintenance_windows w
           WHERE w.site_id = h.site_id
             AND w.started_at <= h.started_at
             AND COALESCE(w.cancelled_at, w.expires_at) >= h.started_at
         )
       ORDER BY h.started_at DESC
       LIMIT ?`
    )
    .all(limit))
    .map((r) => {
      const end = r.endedAt ? Date.parse(r.endedAt) : Date.now();
      return {
        ...r,
        ongoing: !r.endedAt,
        durationMinutes: Math.max(0, Math.round((end - Date.parse(r.startedAt)) / 60000)),
      };
    });
}

// כל חלונות התחזוקה הידניים שפעילים כרגע
async function getActiveMaintenances() {
  const now = new Date().toISOString();
  return await db
    .prepare(
      `SELECT s.code AS "siteCode", s.site_name AS "siteName",
              m.set_by_name AS "setBy", m.reason, m.started_at AS "startedAt",
              m.expires_at AS "expiresAt"
       FROM maintenance_windows m
       JOIN sites s ON m.site_id = s.id
       WHERE m.cancelled_at IS NULL AND m.expires_at > ?
       ORDER BY m.expires_at ASC`
    )
    .all(now);
}

// דירוג אתרים: הכי זמינים / הכי בעייתיים. מקבל את שורות ה-supervisor כדי
// לא לחשב הכל פעמיים.
function getTopPerformers(rows, limit = 5) {
  return rows
    .filter((r) => r.hasUptimeData)
    .sort((a, b) => b.availability - a.availability || b.operations - a.operations)
    .slice(0, limit)
    .map((r) => ({
      code: r.code, name: r.name,
      availability: r.availability, operations: r.operations,
    }));
}

function getWorstPerformers(rows, limit = 5) {
  return rows
    .filter((r) => r.errors > 0)
    .sort((a, b) => b.failureRate - a.failureRate || b.errors - a.errors)
    .slice(0, limit)
    .map((r) => ({
      code: r.code, name: r.name,
      failureRate: r.failureRate, errors: r.errors,
    }));
}

/**
 * מפת חום: שורה לכל אתר, תא לכל דלי — עוצמת הפעילות.
 *
 * גרסת הזיכרון: מקבלת את הנתונים הגולמיים שכבר נשלפו (data) ולא מריצה
 * אף שאילתה. הגרסה הישנה קראה ל-getPeriodBreakdown לכל אתר — כלומר
 * שאילתה לכל אתר, ובגרנולריות יומית זה הצטבר מהר.
 */
function heatmapFromData(data, sites, buckets) {
  const rows = sites.map((site) => ({
    siteCode: site.code,
    siteName: site.site_name,
    values: buckets.map((b) =>
      statsFromData(data, site.id, { from: b.from, to: b.to }).operations),
  }));

  const max = Math.max(0, ...rows.flatMap((r) => r.values));
  return { labels: buckets.map((b) => b.label), rows, max };
}

/**
 * מפת חום — נשמרה לתאימות (משמשת קוד חיצוני/בדיקות). שולפת בעצמה.
 */
async function getSystemHeatmap({ from, to, granularity }) {
  const sites = await getAllSites();
  const buckets = getBucketRanges({ from, to, granularity });
  const data = await loadRangeData(sites.map((s) => s.id), { from, to });
  return heatmapFromData(data, sites, buckets);
}

/**
 * תמונה עסקית כוללת של כל המערכת.
 * rows מגיע מ-getSupervisorStats כדי לא לחשב את אותם מדדים פעמיים.
 */
async function getExecutiveStats({ from, to, granularity }) {
  const { rows, data, sites: allSites } = await getSupervisorStatsWithData({ from, to });

  const sum = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const totalOperations = sum("operations");
  const totalErrors = sum("errors");

  // ממוצע זמינות — רק על אתרים שיש עליהם נתוני מצב, אחרת אתר חדש
  // שמעולם לא דיווח היה גורר את הממוצע ל-0 ומעוות את התמונה.
  const withData = rows.filter((r) => r.hasUptimeData);
  const avgAvailability = withData.length
    ? Math.round((withData.reduce((s, r) => s + r.availability, 0) / withData.length) * 100) / 100
    : 0;

  const sitesByStatus = { ready: 0, operating: 0, error: 0, maintenance: 0, no_comm: 0 };
  for (const r of rows) {
    if (sitesByStatus[r.status] !== undefined) sitesByStatus[r.status]++;
  }

  const kpis = {
    totalSites: rows.length,
    activeSites: sitesByStatus.ready + sitesByStatus.operating,
    totalOperations,
    totalErrors,
    // אחוז כשל מערכתי = סך התקלות ÷ סך הפעולות (ולא ממוצע של אחוזים,
    // שהיה נותן משקל זהה לאתר עם 2 פעולות ולאתר עם 2000)
    avgFailureRate: totalOperations > 0
      ? Math.round((totalErrors / totalOperations) * 10000) / 100
      : 0,
    avgAvailability,
    totalMaintenanceHours: Math.round(sum("maintenanceHours") * 100) / 100,
    totalDowntimeHours: Math.round(sum("downtimeHours") * 100) / 100,
  };

  // ===== גרף לאורך זמן =====
  const buckets = getBucketRanges({ from, to, granularity });

  // אפס שאילתות בלולאה הזו: הכול מחושב מהנתונים שכבר בזיכרון.
  const chart = buckets.map((b) => {
    let ops = 0, errs = 0, availSum = 0, availCount = 0;

    for (const site of allSites) {
      const st = statsFromData(data, site.id, { from: b.from, to: b.to });
      ops += st.operations;
      errs += st.errors;

      const up = uptimeFromData(data, site.id, { from: b.from, to: b.to });
      if (up.measuredHours > 0) {
        availSum += up.availabilityPercent;
        availCount++;
      }
    }

    return {
      label: b.label,
      operations: ops,
      errors: errs,
      availability: availCount ? Math.round((availSum / availCount) * 100) / 100 : null,
    };
  });

  return {
    kpis,
    sitesByStatus,
    topPerformers: getTopPerformers(rows),
    worstPerformers: getWorstPerformers(rows),
    chart,
    heatmap: heatmapFromData(data, allSites, buckets),
  };
}

/**
 * גרסה מסוננת ומפולחת של התמונה העסקית — הבסיס לכלי הניתוח של המנהל הכללי.
 *
 * siteCodes      — רשימת קודי אתרים. ריק/undefined = כל האתרים.
 * statuses       — סינון לפי מצב נוכחי. ריק = כל המצבים.
 * minFailureRate — רק אתרים שאחוז הכשל שלהם מעל הסף.
 * groupBy        — 'site' | 'status' | 'time'
 * granularity    — 'day' | 'week' | 'month' (רזולוציית הגרף)
 *
 * הסינון מוחל *לפני* חישוב ה-KPIs, כך שכל המספרים במסך עקביים עם מה שנבחר.
 */
async function getExecutiveStatsFiltered({
  from, to, siteCodes, statuses, minFailureRate = 0,
  groupBy = "site", granularity = "day",
}) {
  // data ו-sites מגיעים מכאן ומשמשים את *כל* החישובים שלמטה — הדליים,
  // מפת החום והפילוחים — בלי אף שאילתה נוספת.
  const { rows: allRows, data, sites: allSites } = await getSupervisorStatsWithData({ from, to });
  const totalSitesInSystem = allRows.length;

  // --- סינון ---
  const codeSet = siteCodes?.length ? new Set(siteCodes) : null;
  const statusSet = statuses?.length ? new Set(statuses) : null;

  const rows = allRows.filter((r) => {
    if (codeSet && !codeSet.has(r.code)) return false;
    if (statusSet && !statusSet.has(r.status)) return false;
    if (minFailureRate > 0 && r.failureRate < minFailureRate) return false;
    return true;
  });

  const idOf = new Map(allSites.map((s) => [s.code, s.id]));
  const selectedIds = rows.map((r) => idOf.get(r.code)).filter((x) => x !== undefined);

  // --- KPIs (על המסונן בלבד) ---
  const sum = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const totalOperations = sum("operations");
  const totalErrors = sum("errors");

  const withData = rows.filter((r) => r.hasUptimeData);
  const avgAvailability = withData.length
    ? Math.round((withData.reduce((s, r) => s + r.availability, 0) / withData.length) * 100) / 100
    : 0;

  const sitesByStatus = { ready: 0, operating: 0, error: 0, maintenance: 0, no_comm: 0 };
  for (const r of rows) if (sitesByStatus[r.status] !== undefined) sitesByStatus[r.status]++;

  // סך הכניסות/היציאות בכל הטווח (לאריחי הסיכום מתחת לגרף) — מהזיכרון
  const totals = directionFromData(data, selectedIds, { from, to });

  const kpis = {
    totalSites: rows.length,
    activeSites: sitesByStatus.ready + sitesByStatus.operating,
    totalOperations,
    totalEntries: totals.entries,
    totalExits: totals.exits,
    totalErrors,
    // משוקלל (סך תקלות ÷ סך פעולות), ולא ממוצע של אחוזים — אחרת אתר עם
    // 2 פעולות מקבל אותו משקל כמו אתר עם 2000.
    avgFailureRate: totalOperations > 0
      ? Math.round((totalErrors / totalOperations) * 10000) / 100
      : 0,
    avgAvailability,
    totalMaintenanceHours: Math.round(sum("maintenanceHours") * 100) / 100,
    totalDowntimeHours: Math.round(sum("downtimeHours") * 100) / 100,
  };

  // --- סדרת הזמן (משמשת גם לגרף וגם ל-groupBy=time) ---
  const buckets = getBucketRanges({ from, to, granularity });

  // הלולאה הזו הייתה הרוצחת: (דליים × אתרים × 3) שאילתות. חודש בגרנולריות
  // יומית = 30 דליים; עם 200 אתרים זה היה ~18,000 סיבובי רשת. עכשיו: אפס.
  const chart = buckets.map((b) => {
    let ops = 0, errs = 0, maint = 0, availSum = 0, availCount = 0;

    for (const id of selectedIds) {
      const st = statsFromData(data, id, { from: b.from, to: b.to });
      ops += st.operations;
      errs += st.errors;

      const up = uptimeFromData(data, id, { from: b.from, to: b.to });
      maint += up.maintenanceHours;
      if (up.measuredHours > 0) {
        availSum += up.availabilityPercent;
        availCount++;
      }
    }

    const { entries, exits } = directionFromData(data, selectedIds, { from: b.from, to: b.to });

    return {
      label: b.label,
      operations: ops,
      entries,
      exits,
      errors: errs,
      maintenanceHours: Math.round(maint * 100) / 100,
      availability: availCount ? Math.round((availSum / availCount) * 100) / 100 : 0,
      failureRate: ops > 0 ? Math.round((errs / ops) * 10000) / 100 : 0,
    };
  });

  // --- מפת חום (שורה לאתר, תא לדלי) — גם היא מהזיכרון ---
  const heatRows = rows.map((r) => {
    const id = idOf.get(r.code);
    return {
      siteCode: r.code,
      siteName: r.name,
      values: buckets.map((b) => statsFromData(data, id, { from: b.from, to: b.to }).operations),
    };
  });
  const heatmap = {
    labels: buckets.map((b) => b.label),
    rows: heatRows,
    max: Math.max(0, ...heatRows.flatMap((r) => r.values)),
  };

  // --- פילוח (groupBy) ---
  let groups;
  if (groupBy === "status") {
    const byStatus = new Map();
    for (const r of rows) {
      const g = byStatus.get(r.status) || {
        key: r.status, label: r.status,
        sites: 0, operations: 0, errors: 0,
        maintenanceHours: 0, availSum: 0, availCount: 0,
      };
      g.sites++;
      g.operations += r.operations;
      g.errors += r.errors;
      g.maintenanceHours += r.maintenanceHours || 0;
      if (r.hasUptimeData) { g.availSum += r.availability; g.availCount++; }
      byStatus.set(r.status, g);
    }
    groups = [...byStatus.values()].map((g) => ({
      key: g.key,
      label: g.label,
      sites: g.sites,
      operations: g.operations,
      errors: g.errors,
      maintenanceHours: Math.round(g.maintenanceHours * 100) / 100,
      availability: g.availCount ? Math.round((g.availSum / g.availCount) * 100) / 100 : 0,
      failureRate: g.operations > 0 ? Math.round((g.errors / g.operations) * 10000) / 100 : 0,
    }));
  } else if (groupBy === "time") {
    groups = chart.map((c) => ({
      key: c.label, label: c.label,
      sites: rows.length,
      operations: c.operations,
      errors: c.errors,
      maintenanceHours: c.maintenanceHours,
      availability: c.availability,
      failureRate: c.failureRate,
    }));
  } else {
    groups = rows.map((r) => ({
      key: r.code,
      label: r.name,
      sites: 1,
      operations: r.operations,
      errors: r.errors,
      maintenanceHours: r.maintenanceHours || 0,
      availability: r.hasUptimeData ? r.availability : 0,
      failureRate: r.failureRate,
    }));
  }

  // --- שורות גולמיות לייצוא CSV ---
  //
  // "מצב נוכחי" ולא "מצב": כל שאר העמודות מתארות את *התקופה* (פעולות, תקלות,
  // זמינות), אבל הסטטוס הוא צילום רגע — המצב של האתר כרגע, לא בתקופה. בשם
  // "מצב" הוא נקרא כאילו הוא נתון של התקופה, וזה מטעה.
  // בדוח המודפס הוא לא מופיע כלל (ראה ReportView) — שם זה מסמך על תקופה.
  const rawRows = rows.map((r) => ({
    "קוד אתר": r.code,
    "שם האתר": r.name,
    "מצב נוכחי": r.status,
    "פעולות": r.operations,
    "תקלות": r.errors,
    "אחוז כשל": r.failureRate,
    "זמינות": r.hasUptimeData ? r.availability : "",
    "שעות תחזוקה": r.maintenanceHours || 0,
    "שעות השבתה": r.downtimeHours || 0,
    "מונה מחזורים": r.cycleTotal,
    "פעולות מאז התקלה": r.operationsSinceLastError,
  }));

  return {
    kpis,
    sitesByStatus,
    topPerformers: getTopPerformers(rows),
    worstPerformers: getWorstPerformers(rows),
    chart,
    heatmap,
    groups,
    rawRows,
    filteredSitesCount: rows.length,
    totalSitesInSystem,
    // רשימת כל האתרים במערכת — כדי שה-UI יוכל לבנות את בורר האתרים
    allSites: allRows.map((r) => ({ code: r.code, name: r.name, status: r.status })),
  };
}

// ==========================================================
// ===== ניהול: קוד מנהל + עריכת/מחיקת אתרים =====
// ==========================================================

const crypto = require("crypto");

const ADMIN_KEY = "admin_code_hash";
const DEFAULT_ADMIN_CODE = "admin123";

// הקוד נשמר כ-hash ולא כטקסט גלוי, כדי שמי שמציץ במסד לא יקרא אותו ישירות.
// שימו לב: זו *לא* מערכת הרשאות אמיתית — ראה README.
function hashCode(code) {
  return crypto.createHash("sha256").update(String(code), "utf8").digest("hex");
}

async function getSetting(key) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, new Date().toISOString());
}

// נזרע בהרצה הראשונה בלבד — שינוי הקוד לא נדרס בהפעלה מחדש
async function ensureAdminCode() {
  if (!await getSetting(ADMIN_KEY)) {
    await setSetting(ADMIN_KEY, hashCode(DEFAULT_ADMIN_CODE));
  }
}

async function verifyAdminCode(code) {
  if (!code) return false;
  const stored = await getSetting(ADMIN_KEY);
  if (!stored) return false;

  // השוואה בזמן קבוע — מונעת דליפת מידע דרך זמן התגובה
  const a = Buffer.from(hashCode(code), "hex");
  const b = Buffer.from(stored, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function setAdminCode(newCode) {
  await setSetting(ADMIN_KEY, hashCode(newCode));
}

/**
 * עדכון אתר: שם ו/או קוד.
 * שינוי הקוד הוא פעולה עדינה — הוא ה-{code} בנתיב ה-MQTT, ולכן משנה
 * *לאיזה אתר* משויכות ההודעות הנכנסות. ההיסטוריה הקיימת עוברת איתו (site_id
 * לא משתנה), אבל הסוכן בשטח חייב להתעדכן גם הוא, אחרת הודעותיו יידחו.
 */
async function updateSite(currentCode, { newCode, siteName, tier }) {
  const site = await findSiteByCode(currentCode);
  if (!site) return { ok: false, reason: "not_found" };

  if (newCode && newCode !== currentCode && await findSiteByCode(newCode)) {
    return { ok: false, reason: "code_taken" };
  }

  const fields = [];
  const params = [];
  if (newCode && newCode !== currentCode) { fields.push("code = ?"); params.push(newCode); }
  if (siteName) { fields.push("site_name = ?"); params.push(siteName); }
  if (tier) { fields.push("tier = ?"); params.push(tier); }

  if (fields.length === 0) return { ok: true, site };

  params.push(site.id);
  await db.prepare(`UPDATE sites SET ${fields.join(", ")} WHERE id = ?`).run(...params);

  return { ok: true, site: await findSiteByCode(newCode || currentCode) };
}

/**
 * מחיקת אתר. ה-cascade שבסכמה מוחק גם את כל ההיסטוריה שלו
 * (operations, status_history, maintenance_windows, monthly_summary).
 */
async function deleteSite(code) {
  const site = await findSiteByCode(code);
  if (!site) return { ok: false, reason: "not_found" };

  const counts = {
    operations: (await db.prepare("SELECT COUNT(*) n FROM operations WHERE site_id = ?").get(site.id)).n,
    statusHistory: (await db.prepare("SELECT COUNT(*) n FROM status_history WHERE site_id = ?").get(site.id)).n,
  };

  await db.prepare("DELETE FROM sites WHERE id = ?").run(site.id);
  return { ok: true, deleted: { code: site.code, name: site.site_name, ...counts } };
}

// ===== תחזוקת נתונים (summary / cleanup / backup) =====

// האם קיים סיכום חודשי לאתר+חודש
async function hasMonthlySummary(siteId, yearMonth) {
  return !!await db.prepare(
    "SELECT 1 FROM monthly_summary WHERE site_id = ? AND year_month = ?"
  ).get(siteId, yearMonth);
}

// חודשים ייחודיים עם נתוני raw לפני חודש-חתך (איחוד מכל טבלאות ה-raw)
async function getRawMonthsBefore(cutoffMonth) {
  return (await db.prepare(
    `SELECT DISTINCT substr(occurred_at, 1, 7) AS ym FROM operations WHERE substr(occurred_at, 1, 7) < ?
     UNION
     SELECT DISTINCT substr(started_at, 1, 7) AS ym FROM status_history WHERE substr(started_at, 1, 7) < ?
     UNION
     SELECT DISTINCT substr(started_at, 1, 7) AS ym FROM maintenance_windows WHERE substr(started_at, 1, 7) < ?
     ORDER BY ym`
  ).all(cutoffMonth, cutoffMonth, cutoffMonth)).map((r) => r.ym);
}

// מחיקת נתוני raw בטווח [monthStart, monthEnd) מכל שלוש הטבלאות
async function deleteRawInRange(monthStart, monthEnd) {
  const operations = (await db.prepare(
    "DELETE FROM operations WHERE occurred_at >= ? AND occurred_at < ?"
  ).run(monthStart, monthEnd)).changes;
  // לא מוחקים את השורה הפתוחה (ended_at IS NULL) — היא המצב הנוכחי של האתר.
  // אתר יציב מעל שנה עלול להחזיק שורה פתוחה ישנה; מחיקתה תשבש את
  // getCurrentStatusSince ו-getSiteUptime בזמן שהמצב עצוב עדיין ב-sites.status.
  const statusHistory = (await db.prepare(
    "DELETE FROM status_history WHERE started_at >= ? AND started_at < ? AND ended_at IS NOT NULL"
  ).run(monthStart, monthEnd)).changes;
  const maintenance = (await db.prepare(
    "DELETE FROM maintenance_windows WHERE started_at >= ? AND started_at < ?"
  ).run(monthStart, monthEnd)).changes;
  return { operations, statusHistory, maintenance };
}

// גיבוי: היה עוטף את backup API של better-sqlite3. ב-Postgres אין מקבילה
// ברמת הדרייבר (גיבוי נעשה ב-pg_dump, או אוטומטית ע"י Supabase), ולכן
// הפונקציה זורקת במקום להעמיד פנים שגיבתה. ראה tools/backup-db.js.
function backupDatabase() {
  throw new Error(
    "backupDatabase לא נתמך ב-PostgreSQL. Supabase מגבה אוטומטית; " +
    "לגיבוי מקומי השתמש ב-pg_dump."
  );
}

module.exports = {
  // ---- שכבת ה-batch (הפתרון ל-N+1) ----
  getAllSitesWithMetrics,   // GET /api/sites — כל האתרים, מספר שאילתות קבוע
  getAllSitesGlobals,       // מדדים לא-תלויי-טווח לכל האתרים בבת אחת
  loadRangeData,            // שליפת הנתונים הגולמיים לטווח (3 שאילתות)
  statsFromData,            // = getSiteStats, מהזיכרון
  uptimeFromData,           // = getUptimeBreakdown, מהזיכרון
  directionFromData,        // = getDirectionCounts, מהזיכרון
  getBucketRanges,
  getDirectionCounts,
  wasInMaintenance,
  wasInMaintenanceMem,

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
  getOperationsSinceLastError,
  getLastFaultAt,
  getLastOperation,
  updateLastSeenIfNewer,
  getOpenStatusStartedAt,
  getUptimeBreakdown,
  getCycleDelta,
  getPeriodBreakdown,
  getSiteAnalyticsData,
  getSiteInsights,
  getActivityLog,
  getBucketRanges,
  getSupervisorStats,
  getExecutiveStats,
  getExecutiveStatsFiltered,
  ensureAdminCode,
  verifyAdminCode,
  setAdminCode,
  updateSite,
  deleteSite,
  getRecentErrors,
  getActiveMaintenances,
  getSystemHeatmap,
  wasInMaintenance,
  generateMonthlySummary,
  getSystemSummary,
  getSystemMonthlyBreakdown,
  hasMonthlySummary,
  getRawMonthsBefore,
  deleteRawInRange,
  backupDatabase,
};