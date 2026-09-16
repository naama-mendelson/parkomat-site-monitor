// כמה זמן לוקח למסך להיפתח — ומה בדיוק נמדד.
//
//   node --env-file=.env tools/measure-fixflow-speed.js
//
// ============================================================
// ⚠️ "PostgREST עונה ב-40ms" אינו התשובה
// ============================================================
// פתיחת תקלה היא **רצף** קריאות, וחלקן תלויות זו בזו: אי אפשר לשאול על
// החריגה לפני שיודעים את מזהה האתר. לכן נמדד הרצף כפי שהוא ב-
// `readSupabase.js`, כולל מה שרץ במקביל ומה שלא.
//
// ============================================================
// ⚠️ מה נמדד ישירות, ומה מורכב משני חלקים — וזה נאמר בפירוש
// ============================================================
// מדידה מושלמת דורשת אסימון של משתמש מחובר. `service_role` **אינו מורשה**
// על טבלאות `ff_` — בכוונה, כי רשימת ההרשאות הצרה היא התיעוד של מי ניגש
// למה — ויצירת משתמש חד-פעמי מנפחת את מונה ה-MAU (1,857 מול 32 משתמשים
// אמיתיים; מתועד ב-CLAUDE.md).
//
// לכן:
//   **נמדד ישירות** — זמן הלוך-ושוב ל-PostgREST, על טבלה קיימת. זה האיבר
//                     הדומיננטי, והוא אינו תלוי בטבלה.
//   **נמדד ישירות** — זמן ביצוע כל שאילתה במסד, בתפקיד `authenticated`.
//   **מורכב**       — סכום הרצף. הוא חיבור של שני הנמדדים, ולא תצפית.
//
// ⚠️ מספר מורכב שמוצג כתצפית הוא בדיוק סוג הביטחון שהפרויקט הזה נכווה ממנו,
// ולכן הוא מסומן ככזה בפלט.
import pg from "pg";

const URL_BASE = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SECRET_KEY;
const LOCAL = process.env.FIXFLOW_LOCAL_URL || "http://192.168.1.93:3001";
const ms = (n) => `${n.toFixed(0).padStart(5)}ms`;

async function median(fn, n = 5) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await fn());
  return out.sort((a, b) => a - b)[Math.floor(n / 2)];
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();

  // ---- 1. הלוך-ושוב ל-PostgREST, נמדד --------------------------------
  // ⚠️ על `public.sites` ולא על `ff_*`: מה שנמדד הוא הרשת ו-PostgREST, ואלה
  // זהים לכל טבלה. שאילתה קטנה במכוון, כדי שהמספר יהיה התקורה ולא הנתונים.
  const roundTrip = await median(async () => {
    const t = performance.now();
    await fetch(`${URL_BASE}/rest/v1/sites?select=id&limit=1`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    }).then((r) => r.text());
    return performance.now() - t;
  });

  const localTrip = await median(async () => {
    const t = performance.now();
    await fetch(`${LOCAL}/api/health`).then((r) => r.text()).catch(() => "");
    return performance.now() - t;
  });

  console.log(`\n=== תקורה לקריאה אחת (נמדד) ===`);
  console.log(`  Supabase, מהמחשב הזה             ${ms(roundTrip)}`);
  console.log(`  השרת המקומי, LAN, אותו מחשב      ${ms(localTrip)}`);

  // ---- 2. זמן ביצוע השאילתות במסד, נמדד ------------------------------
  await c.query("BEGIN");
  await c.query("SET LOCAL ROLE authenticated");

  const site = (await c.query(
    `SELECT s.id, s.name, s.profile_id FROM public.ff_sites s
      WHERE s.id IN (SELECT site_id FROM public.ff_site_fault_overrides WHERE deleted_at IS NULL)
      LIMIT 1`)).rows[0];
  const profile = (await c.query(`SELECT * FROM public.ff_profiles WHERE id=$1`, [site.profile_id])).rows[0];
  const fault = (await c.query(
    `SELECT id FROM public.ff_faults WHERE profile_id=$1 AND deleted_at IS NULL LIMIT 1`,
    [site.profile_id])).rows[0];

  // ============================================================
  // ⚠️ `EXPLAIN ANALYZE` ולא שעון קיר — אחרת הרשת נספרת פעמיים
  // ============================================================
  // הגרסה הקודמת מדדה `performance.now()` סביב `c.query` — ו-`pg`
  // מתחבר גם הוא דרך האינטרנט. כל שאילתה יצאה ~90ms, והרוב
  // המוחלט מזה הוא הלוך-ושוב — ולא זמן עבודה. חיבור של המספר
  // הזה לתקורת PostgREST ספר את הרשת פעמיים, וניפח את הרצף
  // בכחצי שנייה מומצאת. `EXPLAIN ANALYZE` מחזיר את זמן הביצוע
  // בצד השרת בלבד.
  const q = async (sql, params) => median(async () => {
    const r = await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
    return r.rows[0]["QUERY PLAN"][0]["Execution Time"];
  });

  const qSite = await q(`SELECT * FROM public.ff_sites WHERE id=$1 AND deleted_at IS NULL`, [site.id]);
  const qProfile = await q(`SELECT * FROM public.ff_profiles WHERE id=$1`, [site.profile_id]);
  const qSystem = await q(`SELECT * FROM public.ff_systems WHERE id=$1`, [profile.system_id]);
  const qFaults = await q(
    `SELECT id,title,warning,component_id,handling,sort_order FROM public.ff_faults
      WHERE profile_id=$1 AND deleted_at IS NULL`, [site.profile_id]);
  const qComps = await q(`SELECT id,name,sort_order FROM public.ff_components WHERE profile_id=$1`, [site.profile_id]);
  const qOv = await q(
    `SELECT fault_id FROM public.ff_site_fault_overrides WHERE site_id=$1 AND deleted_at IS NULL`, [site.id]);
  const qFault = await q(`SELECT * FROM public.ff_faults WHERE id=$1 AND deleted_at IS NULL`, [fault.id]);
  const qOvOne = await q(
    `SELECT * FROM public.ff_site_fault_overrides WHERE site_id=$1 AND fault_id=$2 AND deleted_at IS NULL`,
    [site.id, fault.id]);
  const qProcs = await q(
    `SELECT id,title FROM public.ff_procedures WHERE profile_id=$1 AND deleted_at IS NULL`, [site.profile_id]);

  const bytes = (await c.query(
    `SELECT SUM(LENGTH(handling::text))::int n FROM public.ff_faults
      WHERE profile_id=$1 AND deleted_at IS NULL`, [site.profile_id])).rows[0].n;

  await c.query("ROLLBACK");
  c.release();
  await pool.end();

  console.log(`\n=== זמן ביצוע במסד, בתפקיד authenticated (נמדד) ===`);
  console.log(`  רשימת התקלות של הפרופיל          ${ms(qFaults)}   ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`  נהלים / רכיבים / חריגות          ${ms(qProcs)} / ${ms(qComps)} / ${ms(qOv)}`);
  console.log(`  שורה בודדת (אתר/פרופיל/תקלה)     ${ms(qSite)} / ${ms(qProfile)} / ${ms(qFault)}`);

  // ---- 3. הרצף, מורכב -------------------------------------------------
  // ⚠️ `readSite` — שלוש קריאות **בשרשרת** (אתר → פרופיל → מערכת) ואז שלוש
  // במקביל. `readFault` — שתיים במקביל, ואז שתיים בשרשרת.
  const chain = (...calls) => calls.reduce((s, x) => s + roundTrip + x, 0);
  const par = (...calls) => roundTrip + Math.max(...calls);

  // ⚠️ הרצף אחרי התיקון: `readSite` היא קריאה מקוננת אחת
  // (אתר+פרופיל+מערכת) ואז שלוש במקביל; `readFault` היא שתיים
  // במקביל ואז שתיים במקביל.
  const readSite = chain(qSite + qProfile + qSystem) + par(qFaults, qComps, qOv);
  const readFault = par(qSite, qFault) + par(qOvOne, qProcs);

  const before = { site: chain(qSite, qProfile, qSystem) + par(qFaults, qComps, qOv) + 2 * roundTrip,
                   fault: par(qSite, qFault) + chain(qOvOne, qProcs) };

  console.log(`\n=== הרצף שהמסך מבצע (מורכב משני הנמדדים) ===`);
  console.log(`  רשימת התקלות של אתר   2 קריאות   ${ms(readSite)}   (לפני התיקון: ${ms(before.site)})`);
  console.log(`  פתיחת תקלה אחת        2 קריאות   ${ms(readFault)}   (לפני התיקון: ${ms(before.fault)})`);
  console.log(`  ⚠️ מספרים מורכבים, לא תצפית ישירה — ראה הכותרת.`);

  console.log(`\n=== מה זה אומר ===`);
  console.log(`  ${roundTrip > localTrip ? "המסלול המקומי מהיר יותר" : "המסלולים דומים"}, וזמין רק במשרד.`);
  const worst = Math.max(readSite, readFault);
  console.log(worst < 1000
    ? `  הרצף הכבד ביותר מתחת לשנייה — נפתח מיד למוקדן.`
    : `  ⚠️ הרצף הכבד ביותר ${(worst / 1000).toFixed(1)} שניות. זה מורגש, וניתן לקצר בצמצום מספר הקריאות.`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
