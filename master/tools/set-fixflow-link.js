// שינוי או ניקוי של שיוך ספריית התקלות של אתר — מהטרמינל.
//
//   node --env-file=.env tools/set-fixflow-link.js <קוד> "<ערך>"
//
//   ערך ריק ("")            — מנקה את הבחירה ומחזיר לגזירה האוטומטית
//   "site:<id>"             — קישור לאתר ב-FixFlow, כולל חריגות האתר
//   "מערכת|פרופיל"          — קישור לספריית סוג המכונה בלבד
//
// ============================================================
// ⚠️ למה כלי ולא שאילתת UPDATE
// ============================================================
// `UPDATE sites SET fixflow_profile=…` הייתה עוקפת את `app.check_fixflow_profile`
// ואת שורת הביקורת. ערך פגום שנשמר בשקט מחזיר את האתר לגזירה — כלומר לכפתור
// שעובד ומוביל למקום אחר ממה שנבחר, וזה בדיוק הכשל שאי אפשר לראות מהמסך.
// הכלי עובר דרך `public.update_site`, אותו מסלול בדיוק שהדפדפן עובר.
//
// ⚠️ **וההתחזות היא דרך ה-GUC ולא דרך `service_role`.** `update_site` דורשת
// מנהל, ו-`service_role` הייתה עוקפת את הבדיקה במקום לעבור אותה — כלומר הכלי
// היה מצליח גם ביום שבו ההרשאות נשברות.
import pg from "pg";

const [code, value] = process.argv.slice(2);
if (!code || value === undefined) {
  console.error('שימוש:  node --env-file=.env tools/set-fixflow-link.js <קוד> "<ערך>"');
  process.exit(2);
}

const ACTOR = process.env.FIXFLOW_ACTOR_EMAIL || "lolek@parkomat.co.il";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();
try {
  const u = await c.query(
    `SELECT supabase_uid::text AS uid, email FROM app_users
      WHERE email=$1 AND role='manager' AND is_active AND supabase_uid IS NOT NULL`, [ACTOR]);
  if (u.rowCount !== 1) throw new Error(`לא נמצא מנהל פעיל בשם ${ACTOR}`);

  await c.query("SET lock_timeout = '5s'");
  await c.query("BEGIN");
  await c.query("SELECT set_config('app.user_id', $1, true)", [u.rows[0].uid]);

  const before = await c.query(
    "SELECT site_name, plc_type, fixflow_profile FROM sites WHERE code=$1", [code]);
  if (before.rowCount !== 1) throw new Error(`אין אתר עם קוד ${code}`);
  console.log(`  אתר:   ${before.rows[0].site_name}  (סוג: ${before.rows[0].plc_type ?? "—"})`);
  console.log(`  לפני:  ${before.rows[0].fixflow_profile ?? "(אין)"}`);

  await c.query(`SELECT * FROM public.update_site($1, NULL, NULL, NULL, NULL, $2)`, [code, value]);

  const after = await c.query("SELECT fixflow_profile FROM sites WHERE code=$1", [code]);
  const got = after.rows[0].fixflow_profile;
  console.log(`  אחרי:  ${got ?? "(אין)"}`);

  // ⚠️ אימות לפני COMMIT, ולא אחריו. כתיבה שדווחה כהצלחה בלי לקרוא את
  // התוצאה היא בדיוק מה שקרה כאן פעם — `UPDATE` שעדכן 0 שורות והחזיר "בוצע".
  const want = value === "" ? null : value;
  if (got !== want) throw new Error(`הערך שנשמר אינו מה שנשלח (${got} במקום ${want}) — מתגלגל חזרה`);

  await c.query("COMMIT");
  console.log(`\n✅ בוצע, בשם ${u.rows[0].email}`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(`\n❌ ${e.message}`);
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
