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
