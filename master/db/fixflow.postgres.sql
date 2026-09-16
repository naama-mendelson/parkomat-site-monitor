-- ============================================================
-- FixFlow ב-Supabase — ספריית התקלות, קריאה מכל מקום
-- ============================================================
-- עד כה FixFlow רצה כשרת Node עם SQLite **על המחשב הנייד**. נמדד: ה-API עונה
-- ב-17–36ms והמסך עולה ב-330ms — כלומר היא אינה איטית, היא פשוט **אינה
-- מגיעה**. כללי חומת האש מתירים ל-`node.exe` לקבל חיבורים בפרופיל `Public`
-- בזמן שה-Wi-Fi הוא `Private`, ולכן מכל מכשיר אחר הדפדפן ממתין עד שהוא
-- מוותר. זה נראה בדיוק כמו "נטען המון זמן", בלי הודעת שגיאה.
--
-- ⚠️ **ומחוץ למשרד זה לא יכול לעבוד בעיקרון:** `192.168.1.93` היא כתובת
-- פרטית, והיא גם מגיעה מ-DHCP — ביום שהיא תשתנה, הקישור הצרוב בדשבורד
-- יצביע לשום מקום.
--
-- ============================================================
-- ⚠️ למה `ff_` בתוך `public`, ולא סכימה בשם `fixflow`
-- ============================================================
-- סכימה נפרדת נקייה יותר לקריאה, ויש לה מחיר שנמדד: PostgREST חושף רק את
-- הסכימות שברשימת `pgrst.db_schemas`, וזו הגדרה **ברמת ה-role**. שינוי שלה
-- נוגע ב-API כולו — כלומר בדשבורד החי — ושגיאה שם מפילה הכול, לא רק את
-- FixFlow.
--
-- ⚠️ **ושם הטבלה `sites` תפוס, וזו אינה אותה ישות.** ל-`public.sites` יש 37
-- אתרים מנוטרים עם `code` שהוא נושא ה-MQTT; ל-FixFlow יש 121 רשומות אתר
-- שהן תיוק של מסמכים. חפיפת שמות בין שתי ישויות שונות היא בדיוק סוג הבלבול
-- שמסתיים בשאילתה שמחזירה את הדבר הלא נכון בלי שגיאה.
--
-- הקידומת פותרת את שניהם באפס הגדרות, והיא גם מסמנת את הגבול בכל שאילתה.
--
-- ============================================================
-- ⚠️ `jsonb` ולא `TEXT`, וזו אינה קוסמטיקה
-- ============================================================
-- ב-SQLite `handling` ו-`data` הם TEXT שמחזיקים JSON, כלומר המסד אינו יודע
-- לוודא כלום. עץ טיפול פגום נכתב בשקט ומתגלה רק כשמוקדן פותח תקלה באמצע
-- אירוע. `jsonb` דוחה אותו בכתיבה.
--
-- ============================================================
-- ⚠️ הסנכרון מהכונן **אינו** עובר לכאן
-- ============================================================
-- `syncFromSource` קורא קבצי Word מ-`G:\תיקיות אחסון שיתופי\איתור תקלות`.
-- אין ל-Postgres גישה לכונן ממופה, ולא צריכה להיות: הכונן הוא מקור האמת
-- ו-FixFlow היא נגזרת שלו. הסנכרון נשאר כלי על מחשב, והוא יכתוב לכאן.
--
-- החלה:  node --env-file=.env tools/apply-fixflow-schema.js
-- אימות: node --env-file=.env tools/check-fixflow-schema.js

-- ---- מערכות ופרופילים ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ff_systems (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.ff_profiles (
  id          TEXT PRIMARY KEY,
  system_id   TEXT NOT NULL REFERENCES public.ff_systems(id),
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  in_service  BOOLEAN NOT NULL DEFAULT true,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_ff_profiles_system ON public.ff_profiles(system_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ff_profiles_system_name
  ON public.ff_profiles(system_id, name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.ff_components (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES public.ff_profiles(id),
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_ff_components_profile
  ON public.ff_components(profile_id) WHERE deleted_at IS NULL;

-- ---- התוכן -----------------------------------------------------------
-- ⚠️ `source_path` הוא הזהות היציבה של המסמך בין סנכרונים, וזה מה שמאפשר
-- **עדכון במקום** ולא מחיקה-והוספה. ההבחנה נושאת משקל: `ff_site_fault_
-- overrides` מצביעה על `fault_id`, ומחיקה-והוספה הייתה מייתמת אותן.
CREATE TABLE IF NOT EXISTS public.ff_faults (
  id                TEXT PRIMARY KEY,
  profile_id        TEXT NOT NULL REFERENCES public.ff_profiles(id),
  component_id      TEXT REFERENCES public.ff_components(id),
  title             TEXT NOT NULL,
  warning           TEXT,
  handling          JSONB NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  source            TEXT NOT NULL CHECK (source IN ('imported','manual','field')),
  fingerprint       TEXT,
  data              JSONB,
  source_path       TEXT,
  source_hash       TEXT,
  source_synced_at  TIMESTAMPTZ,
  source_text       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_ff_faults_profile
  ON public.ff_faults(profile_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_ff_faults_component
  ON public.ff_faults(component_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ff_faults_source_path
  ON public.ff_faults(source_path) WHERE source_path IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.ff_procedures (
  id                TEXT PRIMARY KEY,
  profile_id        TEXT NOT NULL REFERENCES public.ff_profiles(id),
  title             TEXT NOT NULL,
  warning           TEXT,
  handling          JSONB NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('imported','manual','field')),
  data              JSONB,
  source_path       TEXT,
  source_hash       TEXT,
  source_synced_at  TIMESTAMPTZ,
  source_text       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_ff_procedures_profile
  ON public.ff_procedures(profile_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ff_procedures_source_path
  ON public.ff_procedures(source_path) WHERE source_path IS NOT NULL AND deleted_at IS NULL;

-- ---- אתרי FixFlow והחריגות שלהם --------------------------------------
-- ⚠️ **אלה אינם `public.sites`.** שם, `code` הוא הקוד בנושא ה-MQTT ו-37
-- השורות הן אתרים מנוטרים. כאן `code` הוא מה שכתוב בטבלת האתרים של הכונן,
-- ו-121 השורות הן תיוק מסמכים. הקשר ביניהם הוא `public.sites.fixflow_profile`,
-- והוא מכוון ומפורש — לא צירוף לפי שם.
CREATE TABLE IF NOT EXISTS public.ff_sites (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  profile_id  TEXT NOT NULL REFERENCES public.ff_profiles(id),
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_ff_sites_profile ON public.ff_sites(profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ff_sites_code
  ON public.ff_sites(code) WHERE deleted_at IS NULL;

-- ⚠️ `warning` נמצא כאן מ-16/09/2026 ולא במקרה: ראש מסמך של אתר נושא את
-- התיאור שלו, ולעיתים ערך כיול — `איזור סיבוב מוגדר על 4785` בגרוזנברג 7.
-- בלי העמודה הוא נזרק בכתיבה, והמסך הציג את התיאור של המסמך הכללי מעל
-- הנוהל של האתר הזה. ערך כיול של מתקן אחר שמוצג כשלך אינו ניתן להבחנה.
CREATE TABLE IF NOT EXISTS public.ff_site_fault_overrides (
  id                TEXT PRIMARY KEY,
  site_id           TEXT NOT NULL REFERENCES public.ff_sites(id),
  fault_id          TEXT NOT NULL REFERENCES public.ff_faults(id),
  handling          JSONB NOT NULL,
  warning           TEXT,
  base_fault_hash   TEXT,
  data              JSONB,
  author_name       TEXT NOT NULL,
  source_path       TEXT,
  source_hash       TEXT,
  source_synced_at  TIMESTAMPTZ,
  source_text       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ff_site_fault_overrides
  ON public.ff_site_fault_overrides(site_id, fault_id) WHERE deleted_at IS NULL;

-- ============================================================
-- ⚠️ RLS — קריאה לכל מי שמחובר, כתיבה לאיש
-- ============================================================
-- זהו אותו כלל בדיוק שכבר תקף על שאר הטבלאות: *"Every user sees every
-- site"*, ולכן `USING (true)` היא **הביטוי המדויק של הכלל** ולא קיצור דרך.
--
-- ⚠️ **ואין מדיניות כתיבה, בכוונה.** RLS דוחה כל מה שאין לו מדיניות, ולכן
-- דפדפן אינו יכול לכתוב לכאן כלל. הכתיבה היחידה היא הסנכרון מהכונן, שרץ עם
-- מפתח שרת ממחשב — כלומר גם ביום שמישהו ימצא דרך לקרוא לטבלאות האלה, אין
-- שום נתיב שבו הוא משנה נוהל שמוקדן יקרא באמצע אירוע.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ff_systems','ff_profiles','ff_components','ff_faults',
                           'ff_procedures','ff_sites','ff_site_fault_overrides'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
                   t || '_read', t);
  END LOOP;
END $$;
