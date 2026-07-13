-- schema.sql — סכמת הליבה של SiteMonitor (מינימלי: sites + status_history + events)
-- כל הזמנים נשמרים כ-ISO 8601 (טקסט). הקצה שולח Unix; ה-Master ממיר באחסון.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- טבלת sites — רישום האתרים והמצב הנוכחי של כל אתר
-- ============================================================
CREATE TABLE IF NOT EXISTS sites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,           -- קוד האתר (מה-topic: sites/{code}/...)
  site_name     TEXT NOT NULL,                  -- שם האתר (מהרישום)
  status         TEXT NOT NULL DEFAULT 'no_comm' CHECK(status IN ('ready','operating','error','maintenance','no_comm')),
  last_seen     TEXT,                           -- ISO 8601 — מתי נראה לאחרונה
  cycle_total   INTEGER NOT NULL DEFAULT 0,     -- סך כל ההודעות שהגיעו מהאתר
  plc_cycle_last INTEGER,                       -- ערך מונה הבקר האחרון שנראה (לזיהוי reset)
  cycle_last_ts  TEXT,                          -- זמן ההודעה האחרונה שעדכנה את המונה (לזיהוי Backfill)
  is_new_site   INTEGER NOT NULL DEFAULT 1,     -- 1 = אתר חדש (מונה מתחיל מ-0), 0 = אתר ותיק (מאמץ מונה מהבקר)
  registered_at TEXT NOT NULL,                  -- מתי האתר נרשם

  -- מטא-דאטה לתצוגה בלבד (לא משתתף בקליטה). נוסף גם למסדים קיימים דרך db.js.
  plc_type      TEXT,
  plc_ip        TEXT,
  site_ip       TEXT
);

-- ============================================================
-- טבלת status_history — היסטוריית מצבים (כל שינוי state)
-- ============================================================
CREATE TABLE IF NOT EXISTS status_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK(status IN ('ready','operating','error','maintenance','no_comm')),
  started_at TEXT NOT NULL,                    -- ISO 8601 — מתי המצב התחיל
  ended_at   TEXT                              -- NULL = המצב הנוכחי
);

-- ============================================================
-- טבלת operations — הודעות operation (כניסה/יציאה)
-- ============================================================
CREATE TABLE IF NOT EXISTS operations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  start_end   TEXT NOT NULL,                  
  entry_exit  TEXT NOT NULL,                 
  card_number TEXT NOT NULL DEFAULT '',  -- card number (משדה user בהודעה)
  state       TEXT NOT NULL,                          
  is_anomaly  INTEGER NOT NULL DEFAULT 0,      
  occurred_at TEXT NOT NULL,                  
  received_at TEXT NOT NULL,                    
  UNIQUE (site_id, occurred_at, start_end, entry_exit, card_number)
);

-- ============================================================
-- אינדקסים — להאצת שאילתות לפי אתר וזמן
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_operations_site_time  ON operations(site_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_status_hist_site  ON status_history(site_id, started_at);

-- ===== טבלת חלונות תחזוקה =====
-- כל שורה = הפעלת תחזוקה אחת על אתר. שומר היסטוריה מלאה (audit).
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id      INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  set_by_name  TEXT NOT NULL,                 -- שם מי שהפעיל
  set_by_role  TEXT,                          -- תפקיד (יתמלא כשנבנה אימות)
  reason       TEXT,                          -- סיבת התחזוקה (אופציונלי)
  started_at   TEXT NOT NULL,                 -- מתי הופעלה (ISO 8601)
  duration_hours REAL NOT NULL,               -- משך בשעות
  expires_at   TEXT NOT NULL,                 -- מתי פגה (started_at + duration)
  cancelled_at TEXT                           -- אם בוטלה ידנית לפני הזמן (NULL = לא בוטלה)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_site ON maintenance_windows(site_id, expires_at);

-- ===== טבלת סיכום חודשי =====
-- שורה אחת לכל אתר × חודש. נוצרת מנתוני ה-raw כשהם מתבגרים (מעל שנה).
-- ה-raw המלא עובר לארכיון (לא נמחק) — זה רק סיכום מהיר לדוחות מגמה.
CREATE TABLE IF NOT EXISTS monthly_summary (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id               INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  year_month            TEXT NOT NULL,            -- "2025-03"

  -- פעולות
  operations            INTEGER NOT NULL DEFAULT 0,  -- פעולות לגיטימיות (operating)
  anomalies             INTEGER NOT NULL DEFAULT 0,  -- פעולות אנומליות

  -- תקלות
  errors                INTEGER NOT NULL DEFAULT 0,  -- תקלות שנספרו (ללא תחזוקה)
  errors_in_maintenance INTEGER NOT NULL DEFAULT 0,  -- תקלות שהוחרגו (בתחזוקה)
  failure_rate          REAL NOT NULL DEFAULT 0,     -- אחוז כשל החודש

  -- זמן בכל מצב (בשעות)
  ready_hours           REAL NOT NULL DEFAULT 0,
  operating_hours       REAL NOT NULL DEFAULT 0,
  error_hours           REAL NOT NULL DEFAULT 0,
  maintenance_hours     REAL NOT NULL DEFAULT 0,
  no_comm_hours         REAL NOT NULL DEFAULT 0,

  -- מונה הסייקלים
  cycle_total_start     INTEGER,                     -- בתחילת החודש
  cycle_total_end       INTEGER,                     -- בסוף החודש

  generated_at          TEXT NOT NULL,               -- מתי הסיכום הופק
  UNIQUE (site_id, year_month)                       -- סיכום אחד לכל אתר-חודש
);

-- אינדקס על year_month לבדו (לשאילתות סיכום מערכתי שמסננות לפי חודש בלי site_id)
CREATE INDEX IF NOT EXISTS idx_summary_year_month ON monthly_summary(year_month);
-- הערה: UNIQUE(site_id, year_month) כבר יוצר אינדקס על (site_id, year_month) — לא צריך נוסף