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

module.exports = { FN_SQL, POL_SQL, CRON_SQL };
