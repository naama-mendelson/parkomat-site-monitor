// האם כל כרטיס מחובר למקום הנכון?
//
//   node --env-file=.env tools/check-fixflow-targets.js
//
// ============================================================
// ⚠️ "נכון" צריך ראיה, ולא דעה
// ============================================================
// הקישור אינו יכול להעיד על עצמו: הוא נגזר משם או מסוג, ואם הגזירה שגויה הוא
// ישקר בביטחון מלא — ובדיוק כך ישב הירקון 224 חודשיים על ספרייה ריקה. לכן
// הביקורת מצליבה **שלושה מקורות בלתי תלויים**, וכל אחד יכול להפיל:
//
//   1. **היצרן שהסוג מחייב** — ברמת היצרן, ולא ברמת הפרופיל.
//   2. **הפרופיל שהסוג מחייב** — כשהסוג מכריע גם ברמה הזאת.
//   3. **נוסח התקלות** — המילים שהבקר עצמו כתב. ראיה שאינה תלויה בשם ולא
//      בהגדרה: היא מגיעה מהמתקן.
//
// ⚠️ **שתי הרמות הראשונות אינן אותה בדיקה, וההפרדה היא כל העניין.**
// `matzbet-x` בלתי-מוכרע ברמת הפרופיל ומוכרע לחלוטין ברמת היצרן, ולכן בדיקה
// שגזרה ציפייה מ-`PROFILE_BY_TYPE` בלבד החזירה עליו "אין ציפייה" — והחמיצה
// אתר לולק שקושר ידנית לספריית ביטנקם.
//
// ⚠️ **וספרייה ריקה נספרת ככישלון.** רשימת תקלות ריקה אינה מציגה שגיאה; היא
// נראית למוקדן בדיוק כמו "אין תקלות ידועות לאתר הזה". זה הכשל הכי שקט כאן,
// ולכן הכלי גם **מציע חלופה מנומקת בציון** במקום להסתפק בדגל.
//
// ⚠️ **והכלי מסרב להכריע כשהראיה דקה.** אתר בלי תקלות בהיסטוריה אינו מקבל
// "כנראה בסדר" — הוא מקבל "אין ראיה". ירוק בלי מדידה הוא בדיוק סוג הביטחון
// שהפרויקט הזה נכווה ממנו.
import pg from "pg";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolveLink, resolveProfile, systemForType } from "../../shared/fixflow-profiles.mjs";
import { tokens, similarity, buildWeights } from "../../shared/fixflow-match.mjs";

const MAP = JSON.parse(
  readFileSync(new URL("../../dashboard/src/components/FixFlowLink/fixflow-sites.json", import.meta.url), "utf8"));
const FIXFLOW_DB =
  process.env.FIXFLOW_DB_PATH || "C:/Users/נעמהמנדלסון/Documents/FixFlow/server/data/parkomat.sqlite";

// ---- המערכת שנוסח התקלות מסגיר ----------------------------------------
// ⚠️ **ברמת היצרן ולא ברמת הפרופיל, ובכוונה.** נמדד: ברמת הפרופיל השיטה
// מסרבת, כי שני פרופילים של אותו יצרן חולקים אוצר מילים — סוקולוב 10 יצא
// 0.53 מול 0.52. ברמת היצרן ההפרש עצום: אוסישקין 58 קיבל לולק 0.756 מול
// ביטנקם 0.074, פי עשרה.
const SYSTEM_MARGIN = 3;
const MIN = 0.2;

function scoreProfiles(texts, profiles, model) {
  const out = [];
  for (const p of profiles) {
    let sum = 0, n = 0;
    for (const ft of texts) {
      const f = tokens(ft);
      if (!f.size) continue;
      let top = 0;
      for (const t of p.titleTokens) { const s = similarity(f, t, model.weight); if (s > top) top = s; }
      sum += top; n++;
    }
    out.push({ ...p, score: n ? sum / n : 0 });
  }
  return out.sort((a, b) => b.score - a.score);
}

function systemFromScores(scored) {
  const best = new Map();
  for (const p of scored) if (!best.has(p.system) || p.score > best.get(p.system)) best.set(p.system, p.score);
  const sorted = [...best].sort((a, b) => b[1] - a[1]);
  const [first, second] = sorted;
  if (!first || first[1] < MIN) return { ok: false, why: "ציון נמוך" };
  if (second && second[1] > 0 && first[1] / second[1] < SYSTEM_MARGIN)
    return { ok: false, why: `לא מובהק (${first[1].toFixed(2)} מול ${second[1].toFixed(2)})` };
  return { ok: true, system: first[0], score: first[1] };
}

// ---- ההכרעה, מופרדת מהדפוס כדי שאפשר יהיה לבדוק אותה ----------------
// ⚠️ היא ישבה בתוך הלולאה, וכך היא הייתה בלתי ניתנת לבדיקה אלא מול ייצור —
// כלומר נבדקת רק על הנתונים שבמקרה קיימים היום. פונקציה שמסווגת ואיש לא ירה
// בה מוטציה היא פונקציה שאיש אינו יודע מה היא תופסת.
export function judge(link, plcType, ctrl) {
  const mustSystem = systemForType(plcType);
  const sysV = !mustSystem ? "—" : mustSystem === link.system ? "✓" : "✗";

  // ⚠️ הספרייה הצפויה נגזרת מהיצרן **שהסוג מחייב**, ורק כשאינו מחייב — מזה של
  // הקישור. גזירה מיצרן הקישור בלבד הייתה שואלת "מה הספרייה של מצבט בביטנקם",
  // מקבלת "אין", ומשתיקה בדיוק את הסתירה שהשורה הזו אמורה לדווח.
  const byType = resolveProfile(plcType ?? null, mustSystem ?? link.system);
  const profV = byType.status !== "ok" ? "—" : byType.profile === link.profile ? "✓" : "✗";

  const ctrlV = !ctrl?.ok ? "—" : ctrl.system === link.system ? "✓" : "✗";

  const notes = [];
  if (sysV === "✗") notes.push(`הסוג "${plcType}" הוא ${mustSystem}, הקישור ל-${link.system}`);
  if (profV === "✗") notes.push(`הסוג "${plcType}" מצפה ל-${byType.profile}`);
  if (ctrlV === "✗") notes.push(`נוסח התקלות מצביע על ${ctrl.system} (${ctrl.score.toFixed(2)})`);

  return { sysV, profV, ctrlV, mustSystem, notes };
}

async function main() {
  const ff = new DatabaseSync(FIXFLOW_DB, { readOnly: true });
  const profiles = ff
    .prepare(`SELECT p.id, p.name AS profile, sy.name AS system FROM profiles p JOIN systems sy ON sy.id=p.system_id`)
    .all()
    .map((p) => ({
      ...p,
      titles: ff.prepare(`SELECT title FROM faults WHERE profile_id=? AND deleted_at IS NULL`).all(p.id).map((r) => r.title),
    }))
    .filter((p) => p.titles.length > 0)
    .map((p) => ({ ...p, titleTokens: p.titles.map(tokens).filter((s) => s.size > 0) }));
  const model = buildWeights(profiles.flatMap((p) => p.titles.map((t) => ({ title: t }))));
  ff.close();

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows: sites } = await pool.query(
    `SELECT code, site_name, plc_type, fixflow_profile, control_system FROM sites ORDER BY code`);
  const { rows: faults } = await pool.query(
    `SELECT s.code, h.fault_text FROM status_history h JOIN sites s ON s.id=h.site_id
      WHERE COALESCE(h.fault_text,'') <> '' GROUP BY s.code, h.fault_text`);
  await pool.end();

  const textsBySite = new Map();
  for (const r of faults) {
    if (!textsBySite.has(r.code)) textsBySite.set(r.code, []);
    textsBySite.get(r.code).push(r.fault_text);
  }

  const wrong = [], empty = [], missing = [], unknown = [];
  let confirmed = 0;

  console.log(`\nקוד   אתר                     יעד                                  יצרן  פרופיל  בקר   מסקנה`);
  console.log("─".repeat(110));
  const pad = (v, n) => String(v ?? "").slice(0, n).padEnd(n);

  for (const s of sites) {
    const link = resolveLink(s, MAP);
    const how = link.status === "ok"
      ? (link.by === "chosen" || link.by === "chosen-site" ? "ידני" : link.by === "name" ? "שם" : "סוג")
      : "—";

    if (link.status !== "ok") {
      missing.push([s, link.reason]);
      console.log(`${pad(s.code, 6)}${pad(s.site_name, 23)}${pad("— אין קישור —", 37)}${pad("", 6)}${pad("", 8)}${pad("", 6)}❌`);
      continue;
    }

    const target = `${link.system}/${link.profile}`;
    const texts = textsBySite.get(s.code) ?? [];
    const scored = texts.length ? scoreProfiles(texts, profiles, model) : [];

    const ctrl = scored.length ? systemFromScores(scored) : { ok: false };
    const { sysV, profV, ctrlV, mustSystem, notes } = judge(link, s.plc_type, ctrl);

    let verdict;
    if (notes.length) {
      // ⚠️ סתירה בין יצרנים היא הקטגוריה החמורה ונספרת לחוד: ספרייה לא
      // מדויקת מציגה נהלים דומים; ספרייה של יצרן אחר מציגה מתקן אחר.
      wrong.push([s, target, how, notes.join(" · ")]);
      verdict = "❌ סתירה";
    } else if (link.docs === 0) {
      // ⚠️ החלופה מוגבלת ליצרן של הקישור **או** ליצרן שהסוג מחייב — הצעה
      // שחוצה יצרנים היא בדיוק הטעות שהבדיקה הזאת קיימת כדי לתפוס.
      const only = mustSystem ?? link.system;
      const alt = scored.filter((p) => p.system === only)[0];
      const second = scored.filter((p) => p.system === only)[1];
      empty.push([s, target, how, alt, second]);
      verdict = "⚠️ ריקה";
    } else if (sysV === "✓" || profV === "✓" || ctrlV === "✓") {
      confirmed++;
      verdict = "✅";
    } else {
      unknown.push([s, target, how]);
      verdict = "· אין ראיה";
    }

    console.log(`${pad(s.code, 6)}${pad(s.site_name, 23)}${pad(target, 37)}${pad(sysV, 6)}${pad(profV, 8)}${pad(ctrlV, 6)}${verdict}`);
  }

  console.log(`\n=== סיכום ===`);
  console.log(`  ✅ מאומתים בלפחות ראיה אחת: ${confirmed}`);
  console.log(`  ❌ סתירה מוכחת:              ${wrong.length}`);
  console.log(`  ⚠️  מחוברים לספרייה ריקה:    ${empty.length}`);
  console.log(`  ❌ בלי קישור כלל:            ${missing.length}`);
  console.log(`  ·  בלי ראיה להכריע:          ${unknown.length}`);

  if (wrong.length) {
    console.log(`\n--- ❌ מחוברים למקום הלא נכון ---`);
    for (const [s, target, how, why] of wrong)
      console.log(`  ${pad(s.code, 6)} ${pad(s.site_name, 22)} ${pad(target, 30)} [${how}]  ${why}`);
  }
  if (empty.length) {
    console.log(`\n--- ⚠️ מחוברים לספרייה בלי אף מסמך (המסך יציג רשימה ריקה) ---`);
    for (const [s, target, how, alt, second] of empty) {
      console.log(`  ${pad(s.code, 6)} ${pad(s.site_name, 22)} ${pad(target, 30)} [${how}]`);
      if (!alt) { console.log(`         אין תקלות בהיסטוריה — אין ממה להציע חלופה`); continue; }
      const margin = second ? alt.score - second.score : alt.score;
      // ⚠️ ההצעה מגיעה עם המרווח, ולא רק עם המוביל. 0.68 מול 0.41 היא
      // הכרעה; 0.53 מול 0.52 היא הטלת מטבע שנראית בדיוק כמוה.
      console.log(`         ${margin >= 0.1 ? "→ מומלץ" : "? לא מובהק"}: ${alt.system}/${alt.profile}  ` +
        `${alt.score.toFixed(3)}${second ? ` מול ${second.profile} ${second.score.toFixed(3)}` : ""}`);
    }
  }
  if (missing.length) {
    console.log(`\n--- ❌ בלי קישור ---`);
    for (const [s, why] of missing) console.log(`  ${pad(s.code, 6)} ${pad(s.site_name, 22)} ${why}`);
  }
  if (unknown.length) {
    console.log(`\n--- · אין ראיה להכריע (לא בהכרח שגוי) ---`);
    for (const [s, target, how] of unknown)
      console.log(`  ${pad(s.code, 6)} ${pad(s.site_name, 22)} ${pad(target, 32)} הוכרע לפי ${how}`);
  }

  process.exit(wrong.length + empty.length + missing.length ? 1 : 0);
}

// ⚠️ רץ רק כשמפעילים אותו ישירות. בלי השומר הזה יבוא של הפונקציה
// מתוך בדיקה היה פותח חיבור לייצור — כלומר חבילת הבדיקות היתה נוגעת
// במסד האמיתי בלי שאיש יבקש זאת.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => { console.error(e.message); process.exit(1); });
