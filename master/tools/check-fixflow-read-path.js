// מסלול הקריאה של המסך — שהוא מחזיר תוכן, בזכויות של מוקדן.
//
//   node --env-file=.env tools/check-fixflow-read-path.js
//
// ============================================================
// ⚠️ "הטבלה נגישה" אינה "המסך מציג משהו"
// ============================================================
// `check-fixflow-schema` מוכיח שהרשאות הקריאה עובדות. הוא **אינו** מוכיח
// שהשאילתות שהמסך באמת מבצע מחזירות תוכן: אתר בלי תקלות, ספרייה שהצירוף
// אליה שגוי, או חריגה שאינה נמצאת — כולם מחזירים רשימה ריקה, וזו אינה
// שגיאה על שום מסך. היא נראית בדיוק כמו "אין תקלות ידועות לאתר הזה".
//
// לכן כאן נבדק **המסלול המלא** של `readSite` ו-`readFault`, בתפקיד
// `authenticated` — בדיוק מה ש-PostgREST עושה עבור מוקדן מחובר.
import db from "../db/db.js";

let failures = 0;
const check = (label, ok, detail) => {
  console.log((ok ? "✅ " : "❌ ") + label + (detail ? `   ${detail}` : ""));
  if (!ok) failures++;
};

async function main() {
  const c = await db.pool.connect();
  try {
    // ⚠️ בטרנזקציה שמתגלגלת חזרה — `SET ROLE` משנה את החיבור, וכלי שמשאיר
    // אותו כ-`authenticated` מרעיל כל מה שרץ אחריו על אותו pool.
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE authenticated");

    // ---- אתר עם חריגות: גרוזנברג 7 הוא היחיד שיש לו נהלים משלו ----------
    const site = (await c.query(
      `SELECT id, name, profile_id FROM public.ff_sites
        WHERE name LIKE '%גרוזנברג%' AND deleted_at IS NULL LIMIT 1`)).rows[0];
    check("נמצא אתר עם נהלים משלו", !!site, site?.name);
    if (!site) { await c.query("ROLLBACK"); return; }

    const faults = (await c.query(
      `SELECT id, title, handling FROM public.ff_faults
        WHERE profile_id = $1 AND deleted_at IS NULL`, [site.profile_id])).rows;
    check("⚠️ רשימת התקלות של האתר אינה ריקה", faults.length > 0, `${faults.length} תקלות`);

    const overrides = (await c.query(
      `SELECT fault_id FROM public.ff_site_fault_overrides
        WHERE site_id = $1 AND deleted_at IS NULL`, [site.id])).rows;
    check("⚠️ החריגות של האתר נקראות", overrides.length > 0, `${overrides.length} חריגות`);

    // ---- תקלה מלאה, כולל החריגה שגוברת עליה -----------------------------
    const ov = (await c.query(
      `SELECT o.handling, o.warning, o.source_text, f.title, f.warning AS base_warning
         FROM public.ff_site_fault_overrides o JOIN public.ff_faults f ON f.id = o.fault_id
        WHERE o.site_id = $1 AND o.deleted_at IS NULL AND o.source_text LIKE '%4785%' LIMIT 1`,
      [site.id])).rows[0];
    check("⚠️ נקראת חריגה שהתיאור שלה ייחודי לאתר", !!ov);
    if (ov) {
      // ⚠️ הערך הזה קיים **רק** במסמך של גרוזנברג. אם הוא אינו כאן, המסך
      // מציג את התיאור של "שאר האתרים" מעל הנוהל של האתר הזה — ערך כיול
      // של מתקן אחר, שנראה בדיוק כמו שלך.
      check("⚠️ ערך הכיול של האתר עבר ל-Supabase", /4785/.test(ov.warning ?? ""), ov.warning);
      check("עץ הטיפול של החריגה הוא אובייקט ולא מחרוזת",
        ov.handling && typeof ov.handling === "object" && Array.isArray(ov.handling.root),
        `${ov.handling?.root?.length ?? 0} צעדי שורש`);
    }

    // ---- ספריית סוג מכונה: נקודת הכניסה מ-SiteMonitor --------------------
    const prof = (await c.query(
      `SELECT p.id, p.name, sy.name AS system FROM public.ff_profiles p
         JOIN public.ff_systems sy ON sy.id = p.system_id
        WHERE sy.name = 'לולק' AND p.name = 'xy לולק' LIMIT 1`)).rows[0];
    check("ספריית סוג מכונה נמצאת לפי שם", !!prof, prof ? `${prof.system} / ${prof.name}` : "");
    if (prof) {
      const n = (await c.query(
        `SELECT COUNT(*)::int n FROM public.ff_faults WHERE profile_id = $1 AND deleted_at IS NULL`,
        [prof.id])).rows[0].n;
      check("⚠️ הספרייה אינה ריקה", n > 0, `${n} תקלות`);
    }

    // ---- נהלים: הכפתור "פתח נוהל" ---------------------------------------
    const procs = (await c.query(
      `SELECT COUNT(*)::int n FROM public.ff_procedures WHERE deleted_at IS NULL`)).rows[0].n;
    check("נהלים נקראים", procs > 0, `${procs} נהלים`);

    await c.query("ROLLBACK");
    const who = (await c.query("SELECT current_user AS u")).rows[0].u;
    check("החיבור חזר לתפקידו", who !== "authenticated", who);
  } finally {
    c.release();
  }
}

main()
  .then(() => console.log(failures ? `\n❌ ${failures} כשלים` : "\n✅ הכל עבר"))
  .catch((e) => { console.error("❌", e.message); failures++; })
  .finally(async () => { await db.close(); process.exit(failures ? 1 : 0); });
