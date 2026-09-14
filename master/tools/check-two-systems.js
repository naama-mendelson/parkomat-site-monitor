// check-two-systems — אתר עם שתי מערכות בבקר אחד: השרשרת המלאה.
//
// ============================================================
// ⚠️ למה השער הזה קיים
// ============================================================
// אתר פלורנטין (3468) מריץ שני ParkManager על אותו בקר. הסוכן מאחד את
// מצביהן למצב **אחד** ושולח את הפירוט בנפרד, ב-`p_systems`. כלומר יש
// כאן נתיב חדש לגמרי בין הסוכן לבין המסך — ואי אפשר לבדוק אותו
// בבדיקות היחידה של הסוכן, כי החצי השני שלו נמצא ב-SQL.
//
// ⚠️ **והכשל האפשרי כאן שקט לחלוטין.** ‏`p_systems` עם ברירת מחדל אינו
// מחליף חתימה — הוא יוצר **עומס נוסף**, ואז קריאה בת שני ארגומנטים
// הופכת לדו-משמעית. כל 22 האתרים היו מפסיקים לדווח באותו רגע, בלי שום
// שגיאה בשום מסך. השער הזה בודק גם את זה במפורש.
//
// ============================================================
// ⚠️ עובר במסלול ההרשאות האמיתי, ואינו משאיר שארית
// ============================================================
// מתחזה לסוכן דרך `app.user_id` — הנפילה-לאחור של `app.current_actor()`
// (כלל 2 ב-CLAUDE.md) — כך ש-`app.agent_site_id()` גוזרת את האתר בדיוק
// כמו בייצור. הכול בטרנזקציה שמתגלגלת חזרה, והשוואת לפני/אחרי היא חלק
// מהשער, כמו ב-check-direct-drops.
//
//   node --env-file=.env tools/check-two-systems.js

const db = require("../db/db");

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? "✅ " : "❌ ") + label + (detail ? `   ${detail}` : ""));
  if (!ok) failures++;
}

const SITE = "3468";   // פלורנטין

async function main() {
  const client = await db.pool.connect();
  try {
    // ------------------------------------------------------------
    // 0. החתימה — הכשל השקט שמפיל את כל הצי
    // ------------------------------------------------------------
    const { rows: overloads } = await client.query(`
      SELECT pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'ingest_batch'`);

    check("⚠️ ל-ingest_batch יש עומס **אחד** בלבד", overloads.length === 1,
      overloads.map((o) => `(${o.args})`).join(" · ") || "אין בכלל");

    check("והוא זה שכולל את p_systems",
      overloads[0]?.args?.includes("p_systems"), overloads[0]?.args);

    // ⚠️ REVOKE/GRANT על חתימה שהוחלפה אינם עוברים מעצמם. סוכן בלי
    // הרשאת הרצה מקבל 403 על כל פעימה — ואת זה רואים רק ב-alive.
    const { rows: [g] } = await client.query(`
      SELECT has_function_privilege('authenticated',
             'public.ingest_batch(jsonb,text,jsonb)', 'EXECUTE') AS ok`);
    check("ל-authenticated יש הרשאת הרצה על החתימה החדשה", g.ok === true);

    const { rows: [col] } = await client.query(`
      SELECT data_type FROM information_schema.columns
       WHERE table_name = 'alive' AND column_name = 'systems'`);
    check("העמודה alive.systems קיימת", col?.data_type === "jsonb", col?.data_type);

    // ------------------------------------------------------------
    // 1. זהות האתר
    // ------------------------------------------------------------
    const { rows: [agent] } = await client.query(`
      SELECT u.supabase_uid::text AS uid, u.site_id, s.status, s.site_name
        FROM app_users u JOIN sites s ON s.id = u.site_id
       WHERE s.code = $1 AND u.role = 'agent' AND u.is_active`, [SITE]);
    check(`נמצאה זהות סוכן לאתר ${SITE}`, !!agent, agent?.site_name);
    if (!agent) return;

    const readSystems = async (c) => (await c.query(
      "SELECT systems FROM alive WHERE site_id = $1", [agent.site_id])).rows[0]?.systems ?? null;

    const before = await readSystems(client);

    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [agent.uid]);

    // ------------------------------------------------------------
    // 2. פעימה עם שתי מערכות — בדיוק מה שהסוכן שולח
    // ------------------------------------------------------------
    // ⚠️ המבנה כאן חייב להיות זהה ל-`BatchPayload.Systems` בסוכן: שמות
    // ולא מספרי enum. מספרים היו הופכים תוספת ערך באמצע `SiteState`
    // לשינוי משמעות של כל הכרטיסים במסך, בלי שגיאה בשום מקום.
    const systems = [
      { unit: 1, state: "error", car: "42" },
      { unit: 2, state: "ready", car: "" },
    ];

    await client.query(
      "SELECT * FROM public.ingest_batch($1::jsonb, $2, $3::jsonb)",
      [JSON.stringify([]), "gate-two-systems", JSON.stringify(systems)]);

    const stored = await readSystems(client);

    check("⚠️ הפעימה כתבה את שתי המערכות ל-alive.systems",
      Array.isArray(stored) && stored.length === 2,
      JSON.stringify(stored));

    check("מערכת 1 בתקלה, עם הרכב שלה",
      stored?.[0]?.unit === 1 && stored[0].state === "error" && stored[0].car === "42");

    check("מערכת 2 ממתינה", stored?.[1]?.unit === 2 && stored[1].state === "ready");

    // ------------------------------------------------------------
    // 3. הדשבורד באמת רואה את זה
    // ------------------------------------------------------------
    // ⚠️ **אותה קריאה בדיוק שהדשבורד עושה.** בדיקה שקוראת את הטבלה
    // ישירות הייתה עוברת גם אם `site_globals` שכחה את העמודה — כלומר
    // הנתון היה במסד והמסך היה ריק.
    const { rows: [view] } = await client.query(
      "SELECT systems FROM site_globals(ARRAY[$1]::integer[])", [agent.site_id]);

    check("⚠️ site_globals מחזירה את הפירוט לדשבורד",
      Array.isArray(view?.systems) && view.systems.length === 2,
      JSON.stringify(view?.systems));

    // ------------------------------------------------------------
    // 4. אתר חד-מערכתי אינו נפגע
    // ------------------------------------------------------------
    // ⚠️ פעימה בלי p_systems חייבת **לנקות** את העמודה ולא לשמר אותה —
    // אחרת אתר שהוגדר בחזרה למערכת אחת היה נושא תצלום ישן לנצח, כלומר
    // מסך שמראה מערכת שאינה קיימת.
    // ⚠️ **וזו בדיוק הקריאה של 21 הסוכנים שבשטח** — שני ארגומנטים בלבד.
    // אם החתימה נעשתה דו-משמעית היא נכשלת **כאן**, בטרנזקציה שמתגלגלת
    // חזרה, ולא בייצור על כל הצי בבת אחת.
    let twoArgOk = false;
    let twoArgErr = "";
    try {
      await client.query(
        "SELECT * FROM public.ingest_batch($1::jsonb, $2)",
        [JSON.stringify([]), "gate-two-systems"]);
      twoArgOk = true;
    } catch (e) {
      twoArgErr = e.message;
      // ⚠️ שגיאה מבטלת את הטרנזקציה כולה, ולכן פותחים חדשה כדי שהבדיקות
      // שאחריה (והגלגול-לאחור) עדיין יהיו בעלות משמעות.
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true)", [agent.uid]);
    }

    check("⚠️ קריאה בת שני ארגומנטים (21 הסוכנים שבשטח) עדיין עוברת",
      twoArgOk, twoArgErr);

    check("⚠️ פעימה בלי p_systems מנקה את התצלום",
      twoArgOk && (await readSystems(client)) === null);

    await client.query("ROLLBACK");

    const after = await readSystems(client);
    check("⚠️ השער לא השאיר שארית",
      JSON.stringify(before) === JSON.stringify(after),
      `לפני=${JSON.stringify(before)} אחרי=${JSON.stringify(after)}`);
  } finally {
    client.release();
    await db.pool.end();
  }

  console.log(failures === 0 ? "\n✅ הכול עבר" : `\n❌ ${failures} כשלונות`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
