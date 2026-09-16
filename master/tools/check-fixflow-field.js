// שדה `sites.fixflow_profile` — שהוא באמת קיים, נאכף, ולא שבר את רישום האתרים.
//
//   node --env-file=.env tools/check-fixflow-field.js
//
// ============================================================
// ⚠️ למה `register_site` נבדק כאן, למרות שהתכונה היא של `update_site`
// ============================================================
// הוספת פרמטר משנה **חתימה**, ולשתי הפונקציות נוספה אותה תוספת. `register_site`
// הוא מה שרץ כשרושמים אתר חדש — ואם הוא נשבר, זה מתגלה רק ברגע שמישהו מנסה
// לרשום אתר, כלומר בשטח ובלחץ. שינוי שנוגע בשתיהן חייב לבדוק את שתיהן.
//
// ⚠️ **והכול בטרנזקציה שמתגלגלת חזרה.** הבדיקה כותבת אתר אמיתי כדי לוודא
// שהכתיבה עובדת — בדיקה שרק קוראת אינה יודעת אם אפשר לכתוב.
import db from "../db/db.js";

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? "✅ " : "❌ ") + label + (detail ? `   ${detail}` : ""));
  if (!ok) failures++;
}

const CODE = "__gate_fixflow__";

async function main() {
  const c = await db.pool.connect();
  try {
    // ---- 1. העמודה קיימת ----------------------------------------------
    const col = await c.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name='sites' AND column_name='fixflow_profile'`);
    check("העמודה sites.fixflow_profile קיימת", col.rowCount === 1, col.rows[0]?.data_type);

    // ---- 2. החתימות בייצור --------------------------------------------
    const sig = await c.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN ('register_site','update_site')
        ORDER BY p.proname, args`);
    const byName = new Map();
    for (const r of sig.rows) byName.set(r.proname, (byName.get(r.proname) ?? []).concat(r.args));

    for (const fn of ["register_site", "update_site"]) {
      const all = byName.get(fn) ?? [];
      // ⚠️ **עומס הוא כישלון, לא ניצחון.** שתי חתימות לאותו שם גורמות
      // ל-PostgREST להחזיר `function is not unique` — שגיאה שנראית כמו
      // בעיית הרשאות ואינה.
      check(`${fn} — חתימה אחת בלבד`, all.length === 1, `נמצאו ${all.length}`);
      check(`${fn} — כולל p_fixflow_profile`, (all[0] ?? "").includes("p_fixflow_profile"), all[0]);
    }

    // ---- 3. ההרשאה ל-authenticated ------------------------------------
    for (const fn of ["register_site", "update_site"]) {
      const g = await c.query(
        `SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AS ok
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname=$1`, [fn]);
      check(`${fn} — ל-authenticated יש EXECUTE`, g.rows[0]?.ok === true);
    }

    // ---- 4. כתיבה אמיתית, ואז חזרה ------------------------------------
    await c.query("BEGIN");
    // ⚠️ הפונקציות דורשות מנהל. מתחזים דרך ה-GUC — אותו מסלול הרשאות בדיוק
    // שהדפדפן עובר, ולא עקיפה שלו.
    const mgr = await c.query(
      `SELECT supabase_uid::text AS uid FROM app_users
        WHERE role='manager' AND is_active AND supabase_uid IS NOT NULL LIMIT 1`);
    check("נמצא מנהל להתחזות", mgr.rowCount === 1);
    if (mgr.rowCount !== 1) { await c.query("ROLLBACK"); return; }
    await c.query("SELECT set_config('app.user_id', $1, true)", [mgr.rows[0].uid]);

    // רישום אתר חדש — עם הפרמטר החדש
    await c.query(
      `SELECT * FROM public.register_site($1,$2,$3,$4,$5,$6)`,
      [CODE, "אתר בדיקה", "doli", "basic", true, "לולק|שאטל דולי"]);
    const born = await c.query("SELECT fixflow_profile FROM sites WHERE code=$1", [CODE]);
    check("⚠️ register_site שומר את הספרייה שנבחרה",
      born.rows[0]?.fixflow_profile === "לולק|שאטל דולי", born.rows[0]?.fixflow_profile);

    // עדכון — הקריאה שהמסך עושה
    await c.query(`SELECT * FROM public.update_site($1, NULL, NULL, NULL, NULL, $2)`,
      [CODE, "ביטנקם|ביטנקם xy"]);
    const upd = await c.query("SELECT fixflow_profile FROM sites WHERE code=$1", [CODE]);
    check("update_site משנה את הספרייה", upd.rows[0]?.fixflow_profile === "ביטנקם|ביטנקם xy");

    // ⚠️ ריק **מנקה** ומחזיר לגזירה האוטומטית. בלי זה אין דרך לבטל בחירה.
    await c.query(`SELECT * FROM public.update_site($1, NULL, NULL, NULL, NULL, $2)`, [CODE, ""]);
    const cleared = await c.query("SELECT fixflow_profile FROM sites WHERE code=$1", [CODE]);
    check("⚠️ מחרוזת ריקה מנקה את הבחירה", cleared.rows[0]?.fixflow_profile === null,
      String(cleared.rows[0]?.fixflow_profile));

    // ⚠️ ו-NULL אינו נוגע — אחרת כל עריכת שם אתר הייתה מוחקת את הספרייה.
    await c.query(`SELECT * FROM public.update_site($1, NULL, NULL, NULL, NULL, $2)`, [CODE, "לולק|שאטל דולי"]);
    await c.query(`SELECT * FROM public.update_site($1, NULL, $2, NULL, NULL, NULL)`, [CODE, "שם חדש"]);
    const kept = await c.query("SELECT fixflow_profile, site_name FROM sites WHERE code=$1", [CODE]);
    check("⚠️ עדכון שדה אחר אינו מוחק את הספרייה",
      kept.rows[0]?.fixflow_profile === "לולק|שאטל דולי", String(kept.rows[0]?.fixflow_profile));

    // ---- 5. ערך פגום נדחה ---------------------------------------------
    for (const bad of ["לולק", "|xy", "לולק|"]) {
      let rejected = false;
      try {
        await c.query("SAVEPOINT s");
        await c.query(`SELECT * FROM public.update_site($1, NULL, NULL, NULL, NULL, $2)`, [CODE, bad]);
        await c.query("RELEASE SAVEPOINT s");
      } catch {
        rejected = true;
        await c.query("ROLLBACK TO SAVEPOINT s");
      }
      check(`ערך פגום נדחה: "${bad}"`, rejected);
    }

    // ⚠️ וקישור לאתר (`site:<id>`) **כן** מתקבל — הוא הצורה השנייה.
    let siteFormOk = true;
    try {
      await c.query(`SELECT * FROM public.update_site($1, NULL, NULL, NULL, NULL, $2)`, [CODE, "site:01ABC"]);
    } catch { siteFormOk = false; }
    check("קישור לאתר FixFlow מתקבל", siteFormOk);

    await c.query("ROLLBACK");

    const gone = await c.query("SELECT 1 FROM sites WHERE code=$1", [CODE]);
    check("הייצור נקי — אתר הבדיקה לא נשאר", gone.rowCount === 0);
  } finally {
    c.release();
  }
}

main()
  .then(() => console.log(failures ? `\n❌ ${failures} כשלים` : "\n✅ הכל עבר"))
  .catch((e) => { console.error("❌", e.message); failures++; })
  .finally(async () => { await db.close(); process.exit(failures ? 1 : 0); });
