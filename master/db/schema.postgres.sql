-- schema.postgres.sql — סכמת SiteMonitor ל-PostgreSQL (Supabase).
-- המרה של schema.sql. המבנה, השמות והאילוצים זהים — רק הטיפוסים הותאמו.
--
-- ============================================================
-- החלטות ההמרה (מכוונות — לא השמטות):
--
-- 1. תאריכים נשארים TEXT (ISO 8601), ולא TIMESTAMPTZ.
--    כל השאילתות משוות מחרוזות (occurred_at >= $1), וזה עובד כי ISO ממוין
--    לקסיקוגרפית = כרונולוגית. מעבר ל-TIMESTAMPTZ היה מחייב שינוי בכל
--    חישוב בקוד — סיכון גדול בלי תועלת מיידית. אפשר להמיר בהגירה נפרדת.
--
-- 2. is_anomaly / is_new_site נשארים INTEGER (0/1), ולא BOOLEAN.
--    הקוד משווה במפורש ל-0 ול-1 (למשל `site.is_new_site === 0`).
--    BOOLEAN היה מחזיר true/false ושובר את ההשוואות האלה בשקט.
--
-- 3. REAL → DOUBLE PRECISION. *לא* NUMERIC: הדרייבר (pg) מחזיר NUMERIC
--    כמחרוזת, ו-DOUBLE PRECISION כמספר. חישובי השעות והאחוזים חייבים מספר.
--
-- 4. INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL. שומר על מזהים מספריים
--    ומאפשר להזריק מזהים מקוריים בהגירה (ואז לסנכרן את ה-SEQUENCE).
--
-- 5. PRAGMA journal_mode / foreign_keys — הוסרו. אין להם מקבילה ב-Postgres,
--    ומפתחות זרים נאכפים בו תמיד.
-- ============================================================

-- ============================================================
-- טבלת sites — רישום האתרים והמצב הנוכחי של כל אתר
-- ============================================================
CREATE TABLE IF NOT EXISTS sites (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,           -- קוד האתר (מה-topic: sites/{code}/...)
  site_name      TEXT NOT NULL,                  -- שם האתר (מהרישום)
  status         TEXT NOT NULL DEFAULT 'no_comm' CHECK (status IN ('ready','operating','error','maintenance','no_comm')),
  last_seen      TEXT,                           -- ISO 8601 — מתי נראה לאחרונה
  cycle_total    INTEGER NOT NULL DEFAULT 0,     -- מונה המחזורים המצטבר של המכונה
  plc_cycle_last INTEGER,                        -- ערך מונה הבקר האחרון שנראה (לזיהוי reset)
  cycle_last_ts  TEXT,                           -- זמן ההודעה האחרונה שעדכנה את המונה (לזיהוי Backfill)
  is_new_site    INTEGER NOT NULL DEFAULT 1,     -- 1 = אתר חדש (מונה מ-0), 0 = ותיק (מאמץ מונה מהבקר)
  registered_at  TEXT NOT NULL,                  -- מתי האתר נרשם

  -- מטא-דאטה לתצוגה בלבד (לא משתתף בקליטה)
  plc_type       TEXT,
  plc_ip         TEXT,
  site_ip        TEXT,

  -- דרגת האתר (רמת שירות) — מוצגת על הכרטיס, נערכת בניהול. ברירת מחדל: basic.
  tier           TEXT NOT NULL DEFAULT 'basic' CHECK (tier IN ('vip','extended','basic'))
);

-- ============================================================
-- טבלת settings — הגדרות מערכת (key/value)
-- כרגע: קוד המנהל לניהול אתרים. נשמר כ-hash, לא כטקסט גלוי.
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================
-- טבלת status_history — היסטוריית מצבים (כל שינוי state)
-- ============================================================
CREATE TABLE IF NOT EXISTS status_history (
  id         SERIAL PRIMARY KEY,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('ready','operating','error','maintenance','no_comm')),
  started_at TEXT NOT NULL,                    -- ISO 8601 — מתי המצב התחיל
  ended_at   TEXT                              -- NULL = המצב הנוכחי
);

-- ============================================================
-- טבלת operations — הודעות operation (כניסה/יציאה)
-- ============================================================
-- שלושה זמנים, ולכל אחד תפקיד. אל תמזגו אותם:
--   occurred_at — זמן ה"אמת" של השרת. **מיושר** אם שעון האתר הקדים
--                 (ingestion/plausibility.js). ממנו נגזרים סדר, זמינות ודליים.
--   reported_at — מה שהסוכן שידר, בדיוק כפי ששידר. **מפתח ה-dedup.**
--                 חייב להישאר מקורי: הוא מה שמזהה מסירה חוזרת של QoS-1.
--                 יישור occurred_at תלוי ברגע הקליטה, ולכן הוא *לא* יכול
--                 לשמש מפתח — מסירה חוזרת הייתה מקבלת ערך אחר ונכנסת כשורה שנייה.
--   received_at — מתי השרת קלט בפועל. אבחון בלבד.
CREATE TABLE IF NOT EXISTS operations (
  id          SERIAL PRIMARY KEY,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  start_end   TEXT NOT NULL,
  entry_exit  TEXT NOT NULL,
  card_number TEXT NOT NULL DEFAULT '',         -- מספר כרטיס (משדה user בהודעה)
  state       TEXT NOT NULL,
  is_anomaly  INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  reported_at TEXT
);

-- ⚠️ מפתח ה-dedup (ux_operations_dedup) **אינו** נוצר כאן, ובכוונה.
-- הקובץ הזה רץ עם CREATE TABLE IF NOT EXISTS, ולכן על מסד קיים הוא no-op —
-- העמודה reported_at נוספת רק אחר כך, בבלוק ה-ALTER שב-db.js init(). אינדקס
-- שמוגדר כאן היה מתייחס לעמודה שעדיין לא קיימת, והאתחול היה נכשל כולו
-- ("column reported_at does not exist"). לכן האינדקס נוצר שם, אחרי ה-ALTER.

-- ============================================================
-- אינדקסים — להאצת שאילתות לפי אתר וזמן
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_operations_site_time ON operations(site_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_status_hist_site     ON status_history(site_id, started_at);

-- ===== טבלת חלונות תחזוקה =====
-- כל שורה = הפעלת תחזוקה אחת על אתר. שומר היסטוריה מלאה (audit).
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id             SERIAL PRIMARY KEY,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  set_by_name    TEXT NOT NULL,                 -- שם מי שהפעיל
  set_by_role    TEXT,                          -- תפקיד (יתמלא כשנבנה אימות)
  reason         TEXT,                          -- סיבת התחזוקה (אופציונלי)
  started_at     TEXT NOT NULL,                 -- מתי הופעלה (ISO 8601)
  duration_hours DOUBLE PRECISION NOT NULL,     -- משך בשעות
  expires_at     TEXT NOT NULL,                 -- מתי פגה (started_at + duration)
  cancelled_at   TEXT                           -- אם בוטלה ידנית (NULL = לא בוטלה)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_site ON maintenance_windows(site_id, expires_at);

-- ===== טבלת סיכום חודשי =====
-- שורה אחת לכל אתר × חודש. נוצרת מנתוני ה-raw כשהם מתבגרים (מעל שנה).
CREATE TABLE IF NOT EXISTS monthly_summary (
  id                    SERIAL PRIMARY KEY,
  site_id               INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  year_month            TEXT NOT NULL,                        -- "2025-03"

  -- פעולות
  operations            INTEGER NOT NULL DEFAULT 0,           -- פעולות לגיטימיות
  anomalies             INTEGER NOT NULL DEFAULT 0,           -- פעולות אנומליות

  -- תקלות
  errors                INTEGER NOT NULL DEFAULT 0,           -- תקלות שנספרו (ללא תחזוקה)
  errors_in_maintenance INTEGER NOT NULL DEFAULT 0,           -- תקלות שהוחרגו (בתחזוקה)
  failure_rate          DOUBLE PRECISION NOT NULL DEFAULT 0,  -- אחוז כשל החודש

  -- זמן בכל מצב (בשעות)
  ready_hours           DOUBLE PRECISION NOT NULL DEFAULT 0,
  operating_hours       DOUBLE PRECISION NOT NULL DEFAULT 0,
  error_hours           DOUBLE PRECISION NOT NULL DEFAULT 0,
  maintenance_hours     DOUBLE PRECISION NOT NULL DEFAULT 0,
  no_comm_hours         DOUBLE PRECISION NOT NULL DEFAULT 0,

  -- מונה הסייקלים
  cycle_total_start     INTEGER,                              -- בתחילת החודש
  cycle_total_end       INTEGER,                              -- בסוף החודש

  generated_at          TEXT NOT NULL,                        -- מתי הסיכום הופק
  UNIQUE (site_id, year_month)                                -- סיכום אחד לכל אתר-חודש
);

-- אינדקס על year_month לבדו (לשאילתות סיכום מערכתי שמסננות לפי חודש בלי site_id)
CREATE INDEX IF NOT EXISTS idx_summary_year_month ON monthly_summary(year_month);
-- הערה: UNIQUE(site_id, year_month) כבר יוצר אינדקס על (site_id, year_month)

-- ============================================================
-- טבלת events — חוזה האירועים, לא התעבורה
-- ============================================================
-- כל אירוע סמנטי שהמערכת מייצרת נרשם כאן: שינוי מצב, פעולה, תחזוקה,
-- רישום אתר, נתק גשר. זו *אותה* מטענה שנשלחת ל-SSE, ולא צורת השורה של
-- הטבלאות הגולמיות.
--
-- ============================================================
-- למה טבלה ולא רק שידור
-- ============================================================
-- 1. **Replay אחרי ניתוק.** ה-SSE לא יכול לזה: הודעה שנשלחה כשהטאב היה
--    מנותק פשוט אבדה, ואין דרך לבקש אותה שוב. עם id עולה מונוטוני הדשבורד
--    שומר את האחרון שראה ומבקש `id > last` — וסוגר את הפער.
-- 2. **שני קוראים לחוזה אחד.** Supabase Realtime יכול להאזין ל-INSERT כאן,
--    וה-SSE הקיים יכול לקרוא מאותה טבלה. המעבר בין השניים מפסיק להיות
--    "או-או" עם שכתוב, ונהפך להחלפת קורא. מסלול ה-SSE נשאר כתוב ועובד.
-- 3. **בלי REPLICA IDENTITY FULL.** אילו האזנו לשינויי הטבלאות עצמן,
--    oldStatus היה דורש כתיבת השורה הישנה כולה ל-WAL. כאן הוא סתם עמודה
--    שאנחנו כותבים.
-- 4. **הלקוח אינו קשור לסכמה.** הוא נרשם לצורת האירוע שלנו, לא למבנה
--    status_history — כך אפשר לשנות טבלאות בלי לשבור אותו.
--
-- site_id הוא ON DELETE SET NULL ו-site_code נשמר בנפרד **במכוון**: מחיקת
-- אתר מייצרת אירוע, ואילו היה FK מחיקתי (CASCADE) האירוע שמודיע על המחיקה
-- היה נמחק יחד עם האתר. הקוד נשאר כדי שהאירוע ישרוד את מה שהוא מתאר.
CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,                -- סמן ה-replay. מונוטוני עולה.
  site_id    INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  site_code  TEXT NOT NULL,                        -- דנורמלי בכוונה — שורד מחיקת אתר
  type       TEXT NOT NULL,                        -- state | operation | maintenance | registered | bridge
  payload    JSONB NOT NULL,                       -- המטענה כפי שנשלחה ל-SSE
  created_at TEXT NOT NULL                         -- ISO 8601, כמו כל התאריכים כאן
);

-- לגריפת הרטנציה (מוחקים לפי גיל). ה-PK כבר מכסה את שאילתת ה-replay.
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
