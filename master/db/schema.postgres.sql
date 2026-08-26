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

-- ============================================================
-- suppressed_faults — תקלות שהגיעו בזמן תחזוקה
-- ============================================================
-- "מצב תחזוקה גובר על הכל": תקלה שמגיעה כשהאתר כבר בתחזוקה נזרקת ב-
-- `ingestion/state-handler.js` — לא נרשמת, לא משנה מצב, לא משודרת. זו
-- החלטה נכונה למדדים: תקלה בזמן תחזוקה מתוכננת אינה כשל של המכונה.
--
-- ⚠️ **אבל "לא נספרת" ו"לא קרתה" אינם אותו דבר.** עד היום הן נעלמו לגמרי:
-- מי שהיה בשטח ראה תקלה, וחיפש אותה בלוג ולא מצא כלום. הטבלה הזו מחזירה
-- את **הידיעה** בלי להחזיר את הספירה.
--
-- ============================================================
-- ⚠️ טבלה נפרדת, ולא שורה ב-status_history — וזה כל העניין
-- ============================================================
-- שורת `error` ב-status_history הייתה **סוגרת את מקטע התחזוקה** ופותחת
-- מקטע תקלה, כלומר משנה את מצב האתר ואת חישוב הזמינות — בדיוק הכלל
-- שהשמטה הזו נועדה לשמר. וגם אם הייתה מסומנת, כל מדד היה צריך לזכור
-- לסנן אותה, ומי שישכח יקבל אחוז כשל שגוי בלי שום סימן.
--
-- כאן ההפרדה מבנית: **אף מדד אינו קורא מהטבלה הזו.** אחוז הכשל אינו
-- יכול להשתנות ממנה, לא היום ולא בטעות עתידית. היא נקראת רק בלוג.
--
-- ⚠️ אין ON DELETE CASCADE במקרה — מחיקת אתר מוחקת גם את הרישומים האלה,
-- והם חסרי משמעות בלעדיו (בשונה מ-events, שמודיע על המחיקה עצמה).
CREATE TABLE IF NOT EXISTS suppressed_faults (
  id          BIGSERIAL PRIMARY KEY,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,              -- ISO 8601, כמו כל התאריכים כאן
  fault_text  TEXT,                       -- תיאור מהבקר; NULL = לא נקרא
  -- מה בדיוק גבר: 'window' (חלון ידני מהדשבורד) או 'plc' (מצב הבקר).
  -- ⚠️ שני מקורות שונים לחלוטין, והלוג צריך לומר איזה מהם — "מישהו
  -- העביר לתחזוקה" ו"הבקר לא באוטומט" הם שתי מסקנות שונות.
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- ⚠️ מפתח ייחודי על (site_id, occurred_at): מסירה חוזרת של QoS-1 היא
-- מקרה רגיל ב-MQTT, ובלי זה אותה תקלה הייתה נרשמת פעמיים ומופיעה
-- כפולה בלוג. אותו נימוק בדיוק כמו ה-dedup של הפעולות.
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppressed_dedup
  ON suppressed_faults(site_id, occurred_at);

-- לשליפת הטווח בלוג הפעילות.
CREATE INDEX IF NOT EXISTS idx_suppressed_site_time
  ON suppressed_faults(site_id, occurred_at);

-- ============================================================
-- app_users — טבלת המשתמשים **שלנו**
-- ============================================================
-- ⚠️ **בלי FK ל-auth.users.** זה חוק 1 בדלת היציאה, והוא לא סגנון: FK כזה
-- קושר את גרף המשתמשים לסכמה של Supabase, ו-`pg_dump --schema=public`
-- פשוט לא נושא אותו. `supabase_uid` הוא עמודה רגילה שניתן למלא, לרוקן
-- ולהחליף בזהות של ספק אחר בלי לגעת בשום שורה אחרת.
--
-- ============================================================
-- למה בכלל צריך אותה — הרי יש auth.users
-- ============================================================
-- מפני שאי אפשר לעשות JOIN מול app_metadata. הדרגה חיה שם כתביעה ב-JWT,
-- וזה מספיק כדי *לקרוא* אותה בבקשה — אבל לא כדי לשאול "מי המנהלים",
-- "מי צירף את מי", או "אילו אתרים משויכים למי". כל אלה דורשים טבלה.
--
-- ⚠️ **הדרגה נשמרת בשני מקומות, וזה מכוון**: כאן ובתביעה. הכפילות אינה
-- סימטרית — `app_users.role` הוא **מקור האמת** לכל החלטת הרשאה, והתביעה
-- קיימת כי הטריגר `enforce_invite_only` דורש אותה בזמן commit ואין לו
-- גישה לטבלה הזו. מי שמשנה דרגה חייב לעדכן את שניהם (auth/admin.js).
--
-- ⚠️ **אין מחיקה, יש השבתה.** משתמש שנמחק לוקח איתו את השם מכל שורת
-- ביקורת שהצביעה עליו, וההיסטוריה הופכת ל"מישהו העביר לתחזוקה". is_active
-- שומר את העבר קריא ואת ההווה חסום.
CREATE TABLE IF NOT EXISTS app_users (
  id           SERIAL PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  full_name    TEXT,
  -- ============================================================
  -- שתי קבוצות. זהו.
  -- ============================================================
  -- ⚠️ היו כאן שלוש דרגות (בקר / מנהל בקרה / מנכ"ל) והוכרע לצמצם לשתיים:
  -- **מנהלים** ו**בקרים**. דרגת ביניים שאיש אינו נמצא בה היא דרגה שאיש
  -- לא יודע מה מותר בה, והיא מתגלה ביום שמישהו מוצב בה בטעות.
  --
  -- מנהל = כל מה שבקר יכול, ועוד: ניהול משתמשים, הוצאת אנשים מהמערכת,
  -- וראייה של **כל** יומן הפעולות. בקר רואה רק את מה שבקרים עשו.
  role         TEXT NOT NULL DEFAULT 'operator'
                 CHECK (role IN ('operator', 'manager')),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  supabase_uid UUID,                                -- ⚠️ בלי FK — ראה למעלה
  created_at   TEXT NOT NULL,
  created_by   INTEGER REFERENCES app_users(id),    -- מי צירף. FK פנימי מותר.
  disabled_at  TEXT,
  disabled_by  INTEGER REFERENCES app_users(id)
);

-- ============================================================
-- מעבר משלוש דרגות לשתיים — אידמפוטנטי
-- ============================================================
-- ⚠️ `CREATE TABLE IF NOT EXISTS` **אינו** משנה אילוץ על טבלה קיימת. הוא
-- no-op מלא, ולכן שינוי ה-CHECK למעלה לא היה נכנס לתוקף על שום מסד שכבר
-- רץ — כלומר על הפרודקשן בלבד. זה סוג הפער שעובר בפיתוח נקי ונופל בייצור.
--
-- הסדר קריטי: **קודם ממירים את הערכים, ורק אז מחזירים את האילוץ.** אילוץ
-- שנוסף לפני ההמרה נכשל על השורות הקיימות ומפיל את כל העלייה.
--
-- המיפוי: executive ו-supervisor → manager. שניהם היו "מעל בקר", ובפועל
-- אין אף supervisor במערכת — שתי השורות הקיימות הן executive.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'app_users') THEN
    ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
    UPDATE app_users SET role = 'manager' WHERE role IN ('executive', 'supervisor');
    ALTER TABLE app_users ADD CONSTRAINT app_users_role_check
      CHECK (role IN ('operator', 'manager'));
  END IF;
END
$$;

-- ============================================================
-- ⚠️ עמודות שנוספו אחרי הקמת הטבלאות — והיו חסרות מהקובץ הזה
-- ============================================================
-- **הן קיימות בייצור ולא היו קיימות כאן.** הן נוספו ביד, בהרצה חיה, ואיש
-- לא החזיר את ה-DDL לקובץ. התוצאה: בסיס נתונים חדש — בסיס הבדיקות, או כל
-- מופע שיוקם בעתיד — נוצר בלעדיהן, ו-db.init() נופל מיד אחר כך על
-- functions.postgres.sql שקורא `h.excluded_at` ו-`h.reclassified_to`.
-- כלומר השרת לא עולה בכלל, והשגיאה מצביעה על הפונקציה ולא על הסיבה.
--
-- ⚠️ וזה סותר את הכלל שהקובץ הזה בנוי עליו: **הקובץ הוא מצב היעד.** מרגע
-- שיש עמודה בייצור שאינה כאן, "להריץ את הקובץ" כבר לא מייצר את המערכת.
--
-- ============================================================
-- ⚠️ עטוף בתנאי — כי `IF NOT EXISTS` אינו חוסך את הנעילה
-- ============================================================
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` על עמודה שכבר קיימת אינו
-- משנה דבר — אבל הוא **עדיין תופס ACCESS EXCLUSIVE על הטבלה**. הוא ממתין
-- לכל טרנזקציה פתוחה עליה, וחוסם כל טרנזקציה חדשה בינתיים.
--
-- ⚠️ ו-`db.init()` רץ בכל עלייה של השרת **ובכל שער**, כלומר נעילה בלעדית
-- על שלוש הטבלאות החמות ביותר בזמן שהקליטה כותבת אליהן. נמדד בפועל:
-- `deadlock detected` — "process A waits for AccessExclusiveLock ... blocked
-- by process B; process B waits for AccessShareLock ... blocked by A".
-- שני שערים נפלו על זה, ובדיקת דפדפן נפלה עליו שוב.
--
-- הבדיקה המקדימה עולה שאילתת קטלוג אחת ומריצה את ה-DDL פעם אחת בחיי המסד.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'status_history'
       AND column_name = 'reclassified_to'
  ) THEN
    ALTER TABLE status_history
      ADD COLUMN IF NOT EXISTS fault_text        TEXT,   -- תיאור התקלה מהבקר. NULL = לא נקרא, '' = נקרא וריק
      ADD COLUMN IF NOT EXISTS excluded_at       TEXT,   -- סומן כניסוי — ואינו נספר באף מדד
      ADD COLUMN IF NOT EXISTS excluded_by       TEXT,
      ADD COLUMN IF NOT EXISTS exclusion_reason  TEXT,
      -- סיווג מחדש: שכבה מעל `status`, שנשאר המקור לנצח.
      ADD COLUMN IF NOT EXISTS reclassified_to   TEXT,
      ADD COLUMN IF NOT EXISTS reclassified_by   TEXT,
      ADD COLUMN IF NOT EXISTS reclassified_at   TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'operations'
       AND column_name = 'exclusion_reason'
  ) THEN
    ALTER TABLE operations
      ADD COLUMN IF NOT EXISTS excluded_at       TEXT,
      ADD COLUMN IF NOT EXISTS excluded_by       TEXT,
      ADD COLUMN IF NOT EXISTS exclusion_reason  TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'maintenance_windows'
       AND column_name = 'exclusion_reason'
  ) THEN
    ALTER TABLE maintenance_windows
      ADD COLUMN IF NOT EXISTS excluded_at       TEXT,
      ADD COLUMN IF NOT EXISTS excluded_by       TEXT,
      ADD COLUMN IF NOT EXISTS exclusion_reason  TEXT;
  END IF;
END
$$;

-- ⚠️ **רק 'maintenance'.** הפיכת תקלה ל'מוכן' הייתה מוחקת אירוע במקום
-- לסווגו מחדש — ואת זה כבר עושה סימון הניסוי, שם במפורש ותחת השם הנכון.
--
-- ============================================================
-- ⚠️ נוצר פעם אחת, ולא בכל עלייה — וזה תוקן אחרי שנמדד
-- ============================================================
-- כאן היה `DROP CONSTRAINT IF EXISTS` ואחריו `ADD CONSTRAINT`, בלי תנאי.
-- זה אכן ניתן להרצה חוזרת, אבל המחיר הוסתר: **כל `db.init()` הפיל את
-- האילוץ ובנה אותו מחדש**, וכל בנייה כזו נועלת את status_history ב-
-- ACCESS EXCLUSIVE וסורקת אותה במלואה כדי לאמת.
--
-- ⚠️ ו-`db.init()` רץ בכל עלייה של השרת **ובכל שער** — כלומר נעילה בלעדית
-- על הטבלה החמה ביותר, בזמן שהקליטה כותבת אליה. נמדד בפועל: `deadlock
-- detected` בשני שערים באותה ריצה, בזמן שהשרת במשרד קלט.
--
-- ⚠️ ויש כאן גם חלון של ממש: בין ה-DROP ל-ADD **אין אילוץ**. אם התהליך
-- נופל באמצע — וזה קרה לי כאן ביד — הטבלה נשארת בלי הגנה ואיש לא יודע.
--
-- התנאי למטה עולה שאילתת קטלוג אחת, ומריץ את ה-DDL פעם אחת בחיי המסד.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'status_history_reclass_chk') THEN
    ALTER TABLE status_history ADD CONSTRAINT status_history_reclass_chk
      CHECK (reclassified_to IS NULL OR reclassified_to = 'maintenance');
  END IF;
END
$$;

-- ============================================================
-- ⚠️ ON DELETE SET NULL על שני ה-FK הפנימיים — בלעדיו אין מחיקה
-- ============================================================
-- `created_by` ו-`disabled_by` מצביעים ל-`app_users(id)` **בתוך אותה
-- טבלה**, ובלי סעיף ON DELETE ברירת המחדל היא NO ACTION. כלומר מחיקת מי
-- שאי פעם צירף מישהו, או השבית מישהו, נדחית על הפרה של אילוץ — והמחיקה
-- נכשלת דווקא על המשתמשים הוותיקים, שהם בדיוק אלה שירצו למחוק.
--
-- ⚠️ **וזו הסיבה ש-SET NULL ולא CASCADE.** CASCADE על FK כזה היה מוחק
-- בשרשרת את כל מי שהמשתמש הזה צירף — כלומר מחיקת מנהל אחד הייתה מוחקת
-- חצי מהמערכת. SET NULL מוחק את מי שביקשו, ומאבד רק את ההצבעה.
--
-- ומה שלא הולך לאיבוד: `audit_log.actor_name` ו-`maintenance_windows.
-- set_by_name` הם **צילומי טקסט בלי FK**, ולכן שורת הביקורת ממשיכה לומר
-- מי עשה מה גם אחרי שהמשתמש נמחק. ככה הן תוכננו מלכתחילה.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'app_users') THEN
    ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_created_by_fkey;
    ALTER TABLE app_users ADD CONSTRAINT app_users_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES app_users(id) ON DELETE SET NULL;

    ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_disabled_by_fkey;
    ALTER TABLE app_users ADD CONSTRAINT app_users_disabled_by_fkey
      FOREIGN KEY (disabled_by) REFERENCES app_users(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- החיפוש החם: כל בקשה מזוהה ממירה uid → שורת משתמש.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_uid ON app_users(supabase_uid)
  WHERE supabase_uid IS NOT NULL;
-- כתובות אימייל אינן רגישות-רישיות בפועל; ההשוואה חייבת להיות אחידה.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_email ON app_users(LOWER(email));

-- ============================================================
-- user_sites — **בוטלה**
-- ============================================================
-- כאן ישבה טבלת שיוך משתמש↔אתר, כדי שבקר יראה רק את האתרים שהוקצו לו.
-- הוכרע ההפך: **בקר רואה את כל האתרים.** ההגבלה היחידה שנשארה היא על
-- יומן הפעולות — ראה מדיניות audit_log ב-security.postgres.sql.
--
-- ⚠️ נמחקת ולא נשארת ריקה "ליתר ביטחון". טבלת שיוך שקיימת ואינה בשימוש
-- מחייבת החלטה על כל שורה בה ביום שמישהו יסתכל עליה, ומדיניות שמסננת
-- לפיה מחייבת שכל שאילתה תישא זהות — כולל הקליטה, שאין לה.
--
-- ⚠️ ה-DROP נשאר לצמיתות: הוא מה שמסיר את הטבלה ממופע שכבר מכיל אותה.
-- בלעדיו הפרודקשן היה נשאר עם טבלה שאף קוד אינו מכיר.
DROP TABLE IF EXISTS user_sites;

-- ============================================================
-- audit_log — מי עשה מה, ומתי
-- ============================================================
-- ⚠️ עד היום הביקורת הייתה שורות console.log. הן נכונות, והן נמחקות עם
-- כל הפעלה מחדש — ואי אפשר לשאול אותן, לסנן אותן או להציג אותן במסך.
--
-- actor_name ו-actor_role **משוכפלים לשורה** ואינם JOIN. זה מכוון: שורת
-- ביקורת חייבת לתאר את מה שהיה **ברגע שקרה**. משתמש שהועלה בדרגה או
-- שהוחלף לו השם לא רשאי לשנות למפרע את מה שכתוב על פעולה מלפני חודש.
--
-- trust — 'token' | 'admin-code' | 'anonymous'. אותו שדה שכבר קיים
-- בביקורת התחזוקה, ומאותו טעם: בלעדיו טענה אנונימית נראית כמו זהות
-- מאומתת.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TEXT NOT NULL,                     -- ISO 8601, כמו כל התאריכים
  actor_id    INTEGER,                           -- app_users.id, או NULL לאנונימי
  actor_name  TEXT NOT NULL,                     -- צילום, לא JOIN
  actor_role  TEXT,                              -- צילום
  trust       TEXT NOT NULL DEFAULT 'anonymous',
  action      TEXT NOT NULL,                     -- user.invite | maintenance.start | ...
  target_type TEXT,                              -- site | user | settings
  target_id   TEXT,                              -- קוד אתר / מזהה משתמש
  target_name TEXT,                              -- שם קריא, גם הוא צילום
  details     JSONB,
  ip          TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at    ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, at DESC);

-- ============================================================
-- ingest_drops — כל הודעה שהגיעה ולא נכתבה
-- ============================================================
-- ⚠️ **נולד מאובדן אמיתי.** אתר היה בתקלה שלוש שעות והמסך הראה "בפעולה".
-- הסוכן שידר, Mosquitto העביר, HiveMQ אישר ב-`PUBACK RC:0` — וההודעה
-- נעלמה אצלנו. שש שעות חקירה על שלושה מחשבים, ולבסוף התשובה לא נמצאה:
-- הקונטיינר נוצר מחדש והלוג נמחק איתו.
--
-- ⚠️ **וזה לא היה מקרה חד-פעמי אלא תכונה של המערכת.** בקליטה יש אחד-עשר
-- מסלולי זריקה שקטים (אתר לא רשום, state לא חוקי, חותם זמן פסול, גארד
-- backfill, ועוד), וכולם כותבים `console.log` בלבד. ומעל כולם: כשעיבוד
-- **נכשל**, המנוי מאשר את ההודעה ל-HiveMQ בכל זאת — כדי שהודעה תקולה לא
-- תחסום את התור — ולכן היא נמחקת משם לנצח. הראיה היחידה היא שורה בלוג של
-- תהליך, ולוג של תהליך מת בהפעלה מחדש.
--
-- ⚠️ **המטען נשמר במלואו, וזה העיקר.** בלעדיו יש "משהו נזרק"; איתו אפשר
-- לראות מה בדיוק שודר, להשוות למה שהסוכן חושב ששלח, ובמקרה הצורך לשדר
-- מחדש ביד.
--
-- ⚠️ אין FK ל-sites: הודעה מאתר **לא רשום** היא בדיוק אחת מהסיבות לזריקה,
-- ו-FK היה מונע את רישומה — כלומר מסתיר את המקרה שהכי צריך לראות.
CREATE TABLE IF NOT EXISTS ingest_drops (
  id         BIGSERIAL PRIMARY KEY,
  at         TEXT NOT NULL,              -- ISO 8601 UTC, כמו כל התאריכים כאן
  topic      TEXT NOT NULL,
  site_code  TEXT,                       -- נגזר מה-topic; NULL אם לא היה ניתן לפרסר
  kind       TEXT,                       -- state / operation / bridge / unknown
  reason     TEXT NOT NULL,              -- מפתח קצר וקבוע, לסינון וספירה
  detail     TEXT,                       -- הסבר חופשי / הודעת השגיאה
  payload    TEXT                        -- ⚠️ המטען כפי שהגיע, לא מפורסר
);

-- החיפוש הראשון הוא תמיד "מה נזרק אצל אתר X לאחרונה".
CREATE INDEX IF NOT EXISTS idx_ingest_drops_site_time
  ON ingest_drops(site_code, at DESC);

-- והשני "איזה סוג זריקה גדל" — ספירה לפי סיבה על טווח זמן.
CREATE INDEX IF NOT EXISTS idx_ingest_drops_reason_time
  ON ingest_drops(reason, at DESC);

-- ============================================================
-- מצב הגשר לכל אתר — האות שמבדיל בין "שקט" ל"מת"
-- ============================================================
-- ⚠️ הגשר של Mosquitto מפרסם `sites/{code}/bridge` = "1"/"0", ו-HiveMQ
-- מחזיק את ה-will שלו. עד כה השרת **טיפל רק ב-"0"**: "1" נכתב ללוג
-- ונשכח, ולכן לא הייתה שום דרך לשאול "האם האתר הזה מחובר עכשיו".
--
-- ⚠️ וזה בדיוק הפער שהותיר את מגדל 1 שקט 22 שעות ומוצג "תקין": הסוכן
-- משדר רק על שינוי, ולכן שקט אינו מעיד על כלום. מדדתי קודם שפערי שקט
-- תקינים מגיעים ל-40 שעות, אז התראה על שקט לבדו הייתה מצייצת על מערכות
-- בריאות — כלומר התראה שמלמדת להתעלם.
--
-- מצב הגשר הופך את זה לחד-משמעי:
--   גשר מחובר + שקט ארוך  → הסוכן חי ואינו מדווח. **חריגה אמיתית.**
--   גשר מנותק             → כבר מסומן no_comm.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sites'
       AND column_name = 'bridge_connected'
  ) THEN
    ALTER TABLE sites
      -- NULL = מעולם לא דיווח. ⚠️ אינו "מנותק": אתר שטרם שודרג לגשר
      -- שמדווח הוא לא-ידוע, והתראה עליו הייתה שקרית.
      ADD COLUMN IF NOT EXISTS bridge_connected  INTEGER,
      ADD COLUMN IF NOT EXISTS bridge_seen_at    TEXT;
  END IF;
END $$;

-- ============================================================
-- מי בפועל הכניס לתחזוקה — שם מוקלד, לצד הזהות המאומתת
-- ============================================================
-- ⚠️ `set_by_name` נגזר מהאסימון ולעולם לא מגוף הבקשה — זה הכלל שמפריד
-- בין ייחוס לבין הצהרה, והוא לא משתנה. אבל הוא עונה על "איזה **חשבון**
-- עשה את זה", ולא על "**מי** עמד שם".
--
-- ⚠️ ובפועל זה לא תיאורטי: החשבון `sherut@parkomat.co.il` הוא תיבה
-- משותפת, ובנוסף לכל שמונת המשתמשים אין `full_name` — כך שכל חלון
-- תחזוקה נרשם על כתובת מייל שאינה מזהה אדם.
--
-- `performed_by` הוא **שדה נפרד ולא תחליף**: הוא הצהרה של מי שלחץ, והוא
-- מוצג לצד החשבון המאומת ולא במקומו. מי שקורא את היומן רואה את שניהם
-- ויודע מה מאומת ומה נאמר.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'maintenance_windows'
       AND column_name = 'performed_by'
  ) THEN
    ALTER TABLE maintenance_windows
      ADD COLUMN IF NOT EXISTS performed_by TEXT;
  END IF;
END $$;

-- ============================================================
-- מי ביטל את התחזוקה — אותו כלל כמו מי שהתחיל אותה
-- ============================================================
-- ⚠️ עד כה `cancelled_at` תיעד **מתי** בוטל ולא **מי**. וזו הפעולה
-- שמחזירה אתר לספירה: מרגע הביטול תקלות נספרות שוב והזמינות מושפעת.
-- מי שסוגר חלון מוקדם עושה החלטה תפעולית, ולא פחות מזו שפתחה אותו.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'maintenance_windows'
       AND column_name = 'cancelled_by'
  ) THEN
    ALTER TABLE maintenance_windows
      ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
  END IF;
END $$;

-- ============================================================
-- field_reports — דיווח מהשטח, מאנשי תחזוקה אל המנהלת
-- ============================================================
-- ⚠️ **זו טבלת תוכן ולא טבלת מדידה, ואסור לערבב.** שום מדד אינו קורא
-- ממנה: לא זמינות, לא אחוז כשל, ולא ספירת תקלות. דיווח הוא מה ש**אדם
-- ראה**, ותקלה היא מה שה**בקר דיווח** — שני מקורות שונים לחלוטין, ומיזוגם
-- היה מזהם את המספרים בהערכות אנוש.
--
-- אותו נימוק בדיוק שהפריד את suppressed_faults מ-status_history: טבלה
-- נפרדת היא מה שמבטיח שאף מדד לא יוכל להיות מושפע ממנה בטעות.
--
-- ⚠️ site_id הוא **NULL מותר**, ובכוונה: לא כל ממצא שייך לאתר ("הרכב
-- שלי נתקע ולא הבנתי איפה"). דרישה לבחור אתר הייתה מייצרת בחירה
-- שרירותית, וזה גרוע מהיעדר שיוך — כי אז הדיווח מצטלב עם ההיסטוריה של
-- אתר שאין לו קשר אליו.
--
-- ⚠️ ON DELETE SET NULL ולא CASCADE: מחיקת אתר לא מוחקת את מה שאנשים
-- דיווחו עליו. הדיווח הוא עדות, והיא שורדת את מושא העדות.
CREATE TABLE IF NOT EXISTS field_reports (
  id           BIGSERIAL PRIMARY KEY,
  site_id      INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  -- ⚠️ הזהות **המאומתת** ולא שם מוקלד. הכניסה למסך היא דרך Supabase Auth,
  -- ולכן אין כאן את הפשרה של "ייחוס במקום מנע" שקיימת בתחזוקה ידנית —
  -- מי שכתב הוא מי שהתחבר, נקודה.
  reported_by  TEXT NOT NULL,
  -- מזהה ב-app_users. NULL אפשרי אם המשתמש נמחק מאוחר יותר; הדיווח נשאר,
  -- והשם ב-reported_by נשמר כטקסט כדי שלא ייעלם איתו.
  reported_by_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  -- 'open' | 'done'. שני מצבים ולא ארבעה: "בטיפול" ו"נדחה" נשמעים שימושיים
  -- ומייצרים מסך שדורש תחזוקה משלו. אם יתברר שצריך — זה שינוי קטן.
  status       TEXT NOT NULL DEFAULT 'open',
  resolved_at  TEXT,
  resolved_by  TEXT,
  resolved_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_field_reports_status
  ON field_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_reports_site
  ON field_reports(site_id, created_at DESC);

-- ============================================================
-- field_report_files — צילומי המסך
-- ============================================================
-- ⚠️ **בתוך Postgres ולא ב-Supabase Storage**, וזה כלל 4 בקובץ ההנחיות:
-- ל-Storage אין מקבילה ניידת, וקובץ ששמור שם אינו נוסע ב-pg_dump. תמונה
-- בטבלה נוסעת עם כל השאר, ודלת היציאה נשארת פתוחה.
--
-- ⚠️ **TEXT ולא BYTEA, וזו בחירה מודעת.** bytea חוזר דרך PostgREST כמחרוזת
-- hex ודורש המרה בשני הכיוונים; base64 הוא מה שהדפדפן ממילא מייצר
-- (canvas.toDataURL) ומה שהוא ממילא מציג (src="data:..."). המחיר הוא 33%
-- נפח, והתמורה היא שאין נקודת המרה שיכולה להישבר בשקט.
--
-- ⚠️ **התקרות אינן קישוט.** התוכנית החינמית היא 500MB, והמדידה בקובץ
-- ההנחיות מראה ~1MB נתוני יישום בסך הכול. תמונה אחת לא דחוסה מהטלפון היא
-- 2–5MB — כלומר בלי תקרה, עשרה דיווחים מכפילים את כל המסד. הדפדפן דוחס
-- ל-1280px לפני השליחה, וה-RPC אוכף את התקרה שוב: לקוח אינו גבול.
CREATE TABLE IF NOT EXISTS field_report_files (
  id         BIGSERIAL PRIMARY KEY,
  report_id  BIGINT NOT NULL REFERENCES field_reports(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  -- base64 נטו, בלי הקידומת "data:image/png;base64," — הקידומת נבנית
  -- בתצוגה מ-mime. שמירתה הייתה כופלת מידע שכבר יש בעמודה שלידה.
  data_b64   TEXT NOT NULL,
  byte_size  INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_field_report_files_report
  ON field_report_files(report_id);

-- ============================================================
-- ⚠️ מי **בפועל** — שדה נפרד, ולא תחליף לזהות המאומתת
-- ============================================================
-- `reported_by` נגזר מהאסימון ולעולם לא מגוף הבקשה. אבל הוא עונה על
-- "איזה **חשבון** שלח", ולא על "**מי** ראה".
--
-- ⚠️ ובפועל: `sherut@parkomat.co.il` היא תיבה משותפת, ולכל שמונת
-- המשתמשים אין full_name — כך שדיווח נרשם על כתובת מייל שאינה מזהה אדם.
-- מי שקורא דיווח על דלת שמרעישה צריך לדעת את מי לשאול, לא לאיזו תיבה
-- לכתוב.
--
-- אותו שדה ואותו נימוק בדיוק כמו `performed_by` בחלונות התחזוקה.
ALTER TABLE field_reports
  ADD COLUMN IF NOT EXISTS reported_by_name TEXT;

-- ============================================================
-- הכרזות שנקראו — לכל **אדם**, ולא לכל דפדפן
-- ============================================================
-- ⚠️ localStorage היה פשוט יותר ושגוי: הוא לכל מכשיר. מי שפותח את
-- הדשבורד גם בטלפון וגם במחשב היה רואה את אותה הכרזה פעמיים, ומי שמנקה
-- נתוני אתר היה רואה אותה שוב לנצח. הבקשה הייתה **פעם אחת לכל אחד**.
--
-- ⚠️ עמודה ולא טבלה: אין כאן מודל תוכן. מפתח ההכרזה חי בקוד (הטקסט שלה
-- ממילא שם), וכל מה שצריך לזכור הוא "מי כבר ראה מה". טבלה שנייה עם
-- מדיניות משלה היא מנגנון שלם עבור מחרוזת אחת.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS seen_announcements TEXT[] NOT NULL DEFAULT '{}';

-- ============================================================
-- announcements — הודעות מערכת, שנכתבות מהמסך
-- ============================================================
-- ⚠️ **עברו מהקוד למסד, וזה שינוי מהותי.** בגרסה הראשונה ההכרזה הייתה
-- מערך קבוע ב-JS: הכרזה חדשה = שינוי קוד + פריסה. זה היה מספיק להכרזה
-- אחת, ומרגע שהמנהלת רוצה לכתוב בעצמה — הוא הופך את כל היכולת לבלתי
-- שמישה, כי היא תלויה במפתח.
--
-- ⚠️ `seen_announcements` ממשיך להחזיק **מחרוזות**, ולא מזהים מספריים.
-- זה מה שמאפשר למפתחות הישנים מהקוד ולמזהים החדשים לחיות זה לצד זה בלי
-- מיגרציה של הנתונים: המזהה נשמר כ-text.
CREATE TABLE IF NOT EXISTS announcements (
  id         BIGSERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- ⚠️ ביטול ולא מחיקה: מי שכבר ראה הודעה שנמחקה היה רואה אותה שוב אילו
  -- מזהה כלשהו היה חוזר בשימוש, והשורה עצמה היא תיעוד של מה שנאמר.
  is_active  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_announcements_active
  ON announcements(is_active, id);

-- ============================================================
-- ⚠️ דיווח חדש נדחף חי — למנהלת בלבד
-- ============================================================
-- אותה תבנית כמו `events`, ומאותה סיבה: Realtime מכבד RLS, ולכן מנוי
-- מקבל שורה **רק אם המדיניות מתירה לו לקרוא אותה**. המדיניות על
-- field_reports היא "מנהלת, או שלי" — כלומר הדחיפה מגיעה למי שצריך
-- ולא לאחרים, בלי שום תנאי בקוד הלקוח.
--
-- ⚠️ ולכן **לא** דרך `events`: הטבלה ההיא קריאה לכל מאומת, ואירוע עליה
-- היה מדליף לכולם שהוגש דיווח — ואת תוכנו, אם היה נכנס למטען.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.field_reports;
EXCEPTION
  WHEN duplicate_object THEN NULL;   -- כבר בפרסום
  WHEN undefined_object THEN NULL;   -- אין פרסום (Postgres נקי, לא Supabase)
END $$;

-- ⚠️ REPLICA IDENTITY FULL — נמדד שהוא חובה גם ל-INSERT. ראה ההסבר
-- המלא ליד events ב-functions.postgres.sql.
ALTER TABLE field_reports REPLICA IDENTITY FULL;
