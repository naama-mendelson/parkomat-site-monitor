// tools/lib/sql-shape.js — מה משווים כששואלים "האם הייצור זהה לקוד".
//
// ⚠️ שאילתה אחת לשני הצדדים. שתי גרסאות של אותה שאילתה היו מייצרות פער
// מדומה ביום שמישהו יעדכן רק אחת מהן — כלומר בדיוק כשל האמינות שהכלי
// הזה נועד לשלול.
//
// ⚠️ ופונקציות של תוספים מסוננות (`pg_depend.deptype = 'e'`): הן אינן
// באות מהקוד שלנו, והופעתן ברשימה הייתה מרעישה על כל התקנת תוסף.
const FN_SQL = `
  SELECT n.nspname || '.' || p.oid::regprocedure::text AS sig,
         p.prosrc AS src, p.prosecdef AS secdef, p.provolatile AS vol,
         coalesce(array_to_string(p.proconfig, ';'), '') AS cfg,
         pg_get_function_result(p.oid) AS ret,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`;

const POL_SQL = `
  SELECT schemaname || '.' || tablename || ':' || policyname AS k,
         cmd, array_to_string(roles, ',') AS roles, coalesce(qual, '') AS qual, coalesce(with_check, '') AS wc
    FROM pg_policies WHERE schemaname IN ('public', 'app')`;

const CRON_SQL = `SELECT jobname AS k, schedule, command FROM cron.job`;

// ============================================================
// ⚠️ CON_SQL — הטבלאות עצמן, ולא רק הפונקציות
// ============================================================
// עד כאן ההשוואה ראתה פונקציות, מדיניות ותזמונים — ולא טבלאות. ו-
// `CREATE TABLE IF NOT EXISTS` מדלג על טבלה קיימת **כולה**: CHECK שנערך
// בקובץ, טריגר שנוסף או GRANT שדלף אינם מגיעים לייצור, וההרצה היבשה
// הייתה מדווחת "זהה". זה בדיוק העיוורון שהכלי קיים כדי לסגור.
//
// כאן, לטבלאות הבודק והתחזוקה המונעת (compliance.postgres.sql):
//   • אילוצים — שם + pg_get_constraintdef
//   • טריגרים — שם + pg_get_triggerdef
//   • relrowsecurity, ומדיניות (גם **עודפת** בייצור — D2 אומר "אין אף אחת")
//   • הרשאות טבלה, עמודה ו-sequence ל-anon / authenticated / service_role
//   • אינדקסים
//
// ⚠️ שורת הרשאה נכתבת **גם כשהיא ריקה**, כדי ש-GRANT שנוסף בייצור יופיע
// כשינוי ערך ולא ייבלע כ"שורה שאין לה מקבילה".
//
// ⚠️ הרשימה מפורשת ולא "כל הטבלאות": הטבלאות הוותיקות לא נבנו עם שמות
// אילוצים קבועים, והשוואה שלהן הייתה מרעישה על הבדלים שאין להם משמעות.
// טבלה חדשה שנבנית בתבנית של compliance.postgres.sql — מוסיפים לכאן.
const CON_TABLES = [
  "inspection_machines", "inspection_files", "inspection_reports", "inspection_defects",
  "inspection_defect_photos", "pm_checklist_items", "pm_visits", "pm_visit_items", "pm_files",
  "compliance_history",
];

const CON_SQL = `
  WITH t AS (
    SELECT c.oid, c.relname, c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname = ANY (ARRAY[${CON_TABLES.map((x) => `'${x}'`).join(", ")}])),
  r AS (SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role'))
  SELECT 'rls:' || t.relname AS k, t.relrowsecurity::text AS def FROM t
  UNION ALL
  SELECT 'con:' || t.relname || ':' || co.conname, pg_get_constraintdef(co.oid)
    FROM t JOIN pg_constraint co ON co.conrelid = t.oid
  UNION ALL
  SELECT 'trg:' || t.relname || ':' || tg.tgname, pg_get_triggerdef(tg.oid)
    FROM t JOIN pg_trigger tg ON tg.tgrelid = t.oid AND NOT tg.tgisinternal
  UNION ALL
  SELECT 'idx:' || t.relname || ':' || i.relname, pg_get_indexdef(i.oid)
    FROM t JOIN pg_index x ON x.indrelid = t.oid JOIN pg_class i ON i.oid = x.indexrelid
  UNION ALL
  SELECT 'pol:' || t.relname || ':' || p.polname,
         p.polcmd::text || ' ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' '
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    FROM t JOIN pg_policy p ON p.polrelid = t.oid
  UNION ALL
  SELECT 'grant:' || t.relname || ':' || r.rolname,
         array_to_string(ARRAY(SELECT pv FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pv
                                WHERE has_table_privilege(r.rolname, t.oid, pv)), ',')
    FROM t CROSS JOIN r
  UNION ALL
  SELECT 'colgrant:' || t.relname || ':' || r.rolname,
         array_to_string(ARRAY(SELECT pv FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) pv
                                WHERE has_any_column_privilege(r.rolname, t.oid, pv)), ',')
    FROM t CROSS JOIN r
  UNION ALL
  SELECT 'seqgrant:' || s.relname || ':' || r.rolname,
         array_to_string(ARRAY(SELECT pv FROM unnest(ARRAY['USAGE','SELECT','UPDATE']) pv
                                WHERE has_sequence_privilege(r.rolname, s.oid, pv)), ',')
    FROM t JOIN pg_depend d ON d.refobjid = t.oid AND d.deptype IN ('a', 'i')
           JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
          CROSS JOIN r
  ORDER BY 1`;

module.exports = { FN_SQL, POL_SQL, CRON_SQL, CON_SQL, CON_TABLES };
