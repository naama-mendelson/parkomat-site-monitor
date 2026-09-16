// סכימת FixFlow ב-Supabase — שהיא קיימת, נקראת למי שצריך, וסגורה לכל השאר.
//
//   node --env-file=.env tools/check-fixflow-schema.js
//
// ============================================================
// ⚠️ "הטבלה קיימת" אינה השאלה
// ============================================================
// טבלה יכולה להתקיים, להיות מלאה, ולהיות בלתי נגישה לדפדפן — ואז המסך מציג
// רשימה ריקה. זו אינה שגיאה על שום מסך; היא נראית בדיוק כמו "אין תקלות
// ידועות לאתר הזה". לכן השער בודק את **מסלול ההרשאות עצמו**: הוא מחליף
// role ל-`authenticated` ול-`anon` וקורא, בדיוק כפי ש-PostgREST עושה.
//
// ⚠️ **והכיוון השני חשוב לא פחות.** ל-FixFlow אין מדיניות כתיבה בכוונה: הנוהל
// שמוקדן קורא באמצע אירוע אינו דבר שדפדפן צריך להיות מסוגל לשנות. שער שבודק
// רק שאפשר לקרוא היה עובר גם ביום שבו כל אחד יכול לכתוב.
import db from "../db/db.js";
import { DatabaseSync } from "node:sqlite";

const SQLITE =
  process.env.FIXFLOW_DB_PATH || "C:/Users/נעמהמנדלסון/Documents/FixFlow/server/data/parkomat.sqlite";

const TABLES = {
  ff_systems: "systems",
  ff_profiles: "profiles",
  ff_components: "components",
  ff_faults: "faults",
  ff_procedures: "procedures",
  ff_sites: "sites",
  ff_site_fault_overrides: "site_fault_overrides",
};

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? "✅ " : "❌ ") + label + (detail ? `   ${detail}` : ""));
  if (!ok) failures++;
}

async function main() {
  const c = await db.pool.connect();
  const lite = new DatabaseSync(SQLITE, { readOnly: true });
  try {
    // ---- 1. קיום, RLS ומדיניות ---------------------------------------
    const meta = await c.query(
      `SELECT cl.relname AS t, cl.relrowsecurity AS rls,
              (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid = cl.oid) AS policies
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname='public' AND cl.relkind='r' AND cl.relname = ANY($1)`,
      [Object.keys(TABLES)]);
    const byName = new Map(meta.rows.map((r) => [r.t, r]));
    for (const t of Object.keys(TABLES)) {
      const r = byName.get(t);
      check(`${t} — קיימת`, !!r);
      if (!r) continue;
      check(`${t} — RLS פעיל`, r.rls === true);
      // ⚠️ **מדיניות אחת בדיוק.** שתיים פירושן שמישהו הוסיף אחת ושכח להסיר
      // את הישנה, ו-RLS מאחד מדיניות ב-OR — כלומר השנייה יכולה לפתוח מה
      // שהראשונה סוגרת, בלי שאף בדיקה תבחין.
      check(`${t} — מדיניות אחת בדיוק`, Number(r.policies) === 1, `נמצאו ${r.policies}`);
    }

    // ---- 2. `handling` הוא jsonb ולא מחרוזת --------------------------
    // ⚠️ עמודת TEXT שמחזיקה JSON נראית זהה בשאילתה ומקבלת בשקט כל זבל.
    const types = await c.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND column_name IN ('handling','data')
          AND table_name = ANY($1)`, [Object.keys(TABLES)]);
    const badType = types.rows.filter((r) => r.data_type !== "jsonb");
    check("כל עמודות ה-JSON הן jsonb", badType.length === 0,
      badType.map((r) => `${r.table_name}.${r.column_name}=${r.data_type}`).join(", "));

    // ---- 3. הספירה תואמת ל-SQLite ------------------------------------
    for (const [pgName, liteName] of Object.entries(TABLES)) {
      const a = lite.prepare(`SELECT COUNT(*) n FROM ${liteName}`).get().n;
      const b = (await c.query(`SELECT COUNT(*)::int n FROM public.${pgName}`)).rows[0].n;
      check(`${pgName} — ${a} שורות כמו במקור`, a === b, a === b ? "" : `Supabase מחזיקה ${b}`);
    }

    // ---- 4. מסלול ההרשאות, כפי ש-PostgREST עובר בו --------------------
    // ⚠️ בטרנזקציה שמתגלגלת חזרה: `SET ROLE` משנה את החיבור, ו-`ROLLBACK`
    // הוא מה שמחזיר אותו — כלי שמשאיר חיבור כ-`anon` מרעיל את כל מה שאחריו.
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE authenticated");
    const asAuth = await c.query("SELECT COUNT(*)::int n FROM public.ff_faults");
    check("⚠️ authenticated קורא תקלות", asAuth.rows[0].n > 0, `${asAuth.rows[0].n} שורות`);

    let wrote = false;
    try {
      await c.query("SAVEPOINT w");
      await c.query(
        `INSERT INTO public.ff_systems (id,name) VALUES ('__gate__','בדיקה')`);
      wrote = true;
      await c.query("ROLLBACK TO SAVEPOINT w");
    } catch {
      await c.query("ROLLBACK TO SAVEPOINT w");
    }
    // ⚠️ הכיוון השני: הנוהל אינו דבר שדפדפן משנה.
    check("⚠️ authenticated אינו יכול לכתוב", wrote === false);

    await c.query("SET LOCAL ROLE anon");
    let anonRead = null;
    try {
      anonRead = (await c.query("SELECT COUNT(*)::int n FROM public.ff_faults")).rows[0].n;
    } catch { anonRead = "נדחה"; }
    check("⚠️ anon אינו קורא", anonRead === "נדחה" || anonRead === 0, String(anonRead));

    await c.query("ROLLBACK");

    // ⚠️ אחרי ה-ROLLBACK — שהחיבור באמת חזר. בלי הטענה הזו כלי הבדיקה עצמו
    // יכול להשאיר role דולף, וזה מתגלה רק בכלי הבא שרץ על אותו pool.
    const who = await c.query("SELECT current_user AS u");
    check("החיבור חזר לתפקידו", who.rows[0].u !== "anon" && who.rows[0].u !== "authenticated",
      who.rows[0].u);
  } finally {
    lite.close();
    c.release();
  }
}

main()
  .then(() => console.log(failures ? `\n❌ ${failures} כשלים` : "\n✅ הכל עבר"))
  .catch((e) => { console.error("❌", e.message); failures++; })
  .finally(async () => { await db.close(); process.exit(failures ? 1 : 0); });
