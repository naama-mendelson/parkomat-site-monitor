// מזהה את סוג המכונה של אתר מתוך **נוסח התקלות שהבקר שלו כתב**.
//
//   node --env-file=.env tools/fixflow-type-from-faults.js
//
// ============================================================
// ⚠️ למה הכלי הזה קיים
// ============================================================
// שלושה אתרים אינם מקושרים ל-FixFlow, ולכל אחד סיבה אחרת:
//
//   1370 הקונגרס      `plc_type='xy'` — והסוג `xy` קיים בשתי המערכות
//   3465 אוסישקין 58  אותו דבר
//   3510 ברנדיס 38    אין `plc_type` כלל, ואין התאמת שם ב-FixFlow
//
// `xy` מתחלק 22 לולק מול 26 ביטנקם. ניחוש הוא הטלת מטבע ששולחת מוקדן
// לספריית המכונה הלא נכונה — וכל הצעדים שם נראים סבירים.
//
// ============================================================
// הראיה: אוצר המילים של הבקר
// ============================================================
// בקר לולק כותב `מיטה 2 - בוכנה 3: זמן מקסימלי לפעולה`, `דקלוק 1 - אוברלואד`.
// בקר ביטנקם כותב `אנקודר יצא מטווח`, `טיים אאוט שער`, `גלישת מגש`.
//
// ⚠️ **וכותרות המסמכים ב-FixFlow הן אותו אוצר מילים בדיוק**, כי הן נכתבו מול
// אותם בקרים. לכן ההשוואה אינה דמיון סמנטי אלא חפיפת מונחים.
//
// ⚠️ **ומשקל לפי נדירות, לא ספירה גולמית.** `מגש`, `זמן` ו`מקסימלי` מופיעים
// כמעט בכל פרופיל ואינם מבחינים בכלום; `בוכנה`, `דקלוק`, `אנקודר` מופיעים
// בפרופיל אחד או שניים. משקל 1/df נותן למילה המבחינה את כל המשקל, ולמילה
// המשותפת כמעט אפס — בלי רשימת מילות-עצירה שמישהו צריך לתחזק.
//
// ============================================================
// ⚠️ והכלי מאמת את עצמו לפני שהוא עונה
// ============================================================
// יש 26 אתרים שהתשובה שלהם **ידועה** — הם הותאמו ב-FixFlow לפי שם. השיטה
// מורצת עליהם קודם, ואם היא אינה משחזרת את מה שכבר ידוע, אין שום סיבה
// להאמין לה על השלושה שאינם ידועים. הדיוק נדפס, ולא נטען.
//
// ⚠️ וכשהראיה דקה — הכלי **מסרב**. אתר בלי היסטוריית תקלות, או כזה שכל
// תקלותיו במילים משותפות, מקבל "אין די ראיות". סירוב הוא תשובה; ניחוש
// שנראה כמו תשובה אינו.
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const FIXFLOW_DB =
  process.env.FIXFLOW_DB_PATH ||
  "C:/Users/נעמהמנדלסון/Documents/FixFlow/server/data/parkomat.sqlite";

// ⚠️ שני הספים נקבעו **אחרי** מדידת האימות, לא לפניה — ראה הפלט.
const MIN_MARGIN = 1.4;   // כמה פעמים הראשון חייב להיות גדול מהשני
const MIN_SCORE = 0.20;   // ממוצע ההתאמה הטובה ביותר, על פני תקלות האתר
// ⚠️ סף המערכת גבוה בהרבה מסף הפרופיל, ובכוונה. שני פרופילים של אותה מערכת
// חולקים אוצר מילים ולכן קרובים זה לזה מטבעם; שתי **מערכות** אינן חולקות
// כמעט דבר. פער של פחות מפי שלושה בין מערכות פירושו שהראיה אינה שם.
const SYSTEM_MARGIN = 3;

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// ⚠️ `מספר` נמחק כי הוא ה-placeholder בכותרות (`מיטה (מספר)`), וספרות
// נמחקות כי `מיטה 13` ו-`מיטה 6` הם אותה תקלה. בלי זה כל מספר מיטה היה
// נספר כמונח נפרד, והמשקל היה נשפך לרעש.
const tokens = (s) =>
  new Set(
    String(s ?? "")
      .replace(BIDI, "")
      .replace(/[0-9]+/g, " ")
      .split(/[^\u0590-\u05FFA-Za-z]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && w !== "מספר")
  );

// ============================================================
// ⚠️ השיטה הראשונה נמדדה ונפלה — 50% דיוק
// ============================================================
// היא השוותה **אוצר מילים**: כמה מהמונחים של האתר מופיעים
// איפשהו בכותרות הפרופיל. האימות הראה את ההטייה מיד: 1416 הרב לוין,
// שהוא **שאטל דולי**, קיבל 0.66 ל-`xy לולק` מול 0.37 לאמת.
//
// הסיבה מבנית: `xy לולק` מחזיק  67 מסמכים — האוצר הגדול ביותר —
// ולכן הוא מכיל כמעט כל מונח שבקר לולק כותב. ספירת מונחים מעניקה
// יתרון לספרייה הגדולה, וזה בדיוק הכשל שהכלי נבנה למנוע.
//
// השיטה שהחליפה אותה שואלת שאלה אחרת, והיא השאלה האמיתית:
// **האם בספרייה הזו יש מסמך שמתאר את התקלה הזו?** לכל נוסח תקלה
// מחפשים את הכותרת הדומה ביותר, והציון הוא הממוצע. ספרייה גדולה
// עדיין מקבלת יותר הזדמנויות, אבל התאמה חלקית למסמך אחד אינה
// מצטברת לציון גבוה כמו שפיזור מונחים על שישים מסמכים הצטבר.
function buildModel(profiles) {
  // df על רמת המונח — משמש למשקל, לא לציון עצמו.
  const df = new Map();
  for (const p of profiles) {
    const set = new Set();
    for (const t of p.titles) for (const w of tokens(t)) set.add(w);
    for (const w of set) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const weight = (w) => 1 / (df.get(w) ?? profiles.length);
  // כותרות מטוקנות מראש, כדי שלא נפרק אותן מחדש בכל השוואה.
  const titleTokens = new Map(
    profiles.map((p) => [p.key, p.titles.map((t) => tokens(t)).filter((s) => s.size > 0)]));
  return { weight, titleTokens };
}

// דמיון בין נוסח תקלה לכותרת אחת: F1 של שתי הכיסויות, ממושקל.
//
// ⚠️ **F1 ולא כיסוי בכיוון אחד.** כיסוי הכותרת לבדו נותן ציון מלא
// לכותרת קצרה מאוד ("גלישת מגש") שנבלעת בכל תקלה שמזכירה מגש;
// כיסוי התקלה לבדו נותן ציון מלא לכותרת ארוכה שמכילה הכל.
function similarity(fSet, tSet, weight) {
  let inter = 0, fTot = 0, tTot = 0;
  for (const w of fSet) { const x = weight(w); fTot += x; if (tSet.has(w)) inter += x; }
  for (const w of tSet) tTot += weight(w);
  if (inter === 0 || fTot === 0 || tTot === 0) return 0;
  const pf = inter / fTot, pt = inter / tTot;
  return (2 * pf * pt) / (pf + pt);
}

function score(faultTexts, model, profileKey) {
  const titles = model.titleTokens.get(profileKey) ?? [];
  if (titles.length === 0) return 0;
  let sum = 0, n = 0;
  for (const ft of faultTexts) {
    const f = tokens(ft);
    if (f.size === 0) continue;
    let best = 0;
    for (const t of titles) {
      const s = similarity(f, t, model.weight);
      if (s > best) best = s;
    }
    sum += best; n++;
  }
  return n === 0 ? 0 : sum / n;
}

function rank(faultTexts, model, profiles) {
  return profiles
    .map((p) => ({ ...p, s: score(faultTexts, model, p.key) }))
    .sort((a, b) => b.s - a.s);
}

// ============================================================
// ⚠️ השאלה הנכונה היא **המערכת**, לא הפרופיל
// ============================================================
// הדירוג ברמת פרופיל סירב ל-3465 (0.76 מול 0.61) — ושני המתמודדים
// היו **שניהם לולק**. כלומר הסירוב היה על שאלה שאיש לא שאל.
//
// האי-ודאות המקורית היא צרה במדויק: `plc_type='xy'` ידוע, והוא
// קיים בשתי המערכות. ברגע שהמערכת ידועה, הפרופיל **נגזר** —
// ואין צורך להכריע בין שני פרופילים של אותה מערכת.
//
// נמדד על 3465: לולק 0.756 מול ביטנקם 0.074 — פי עשרה, וכל שבעת
// פרופילי לולק מעל כל שבעת פרופילי ביטנקם.
function systemVerdict(ranked) {
  const best = new Map();
  for (const p of ranked) if (!best.has(p.system) || p.s > best.get(p.system)) best.set(p.system, p.s);
  const sorted = [...best].sort((a, b) => b[1] - a[1]);
  const [first, second] = sorted;
  if (!first || first[1] < MIN_SCORE) return { ok: false, why: "ציון נמוך מדי", sorted };
  if (second && second[1] > 0 && first[1] / second[1] < SYSTEM_MARGIN)
    return { ok: false, why: `לא מספיק מובהק (${first[1].toFixed(2)} מול ${second[1].toFixed(2)})`, sorted };
  return { ok: true, system: first[0], sorted };
}

function verdict(ranked) {
  const [first, second] = ranked;
  if (!first || first.s < MIN_SCORE) return { ok: false, why: "ציון נמוך מדי" };
  if (second && second.s > 0 && first.s / second.s < MIN_MARGIN)
    return { ok: false, why: `לא מספיק מובהק (${first.s.toFixed(2)} מול ${second.s.toFixed(2)})` };
  return { ok: true };
}

async function main() {
  const ff = new DatabaseSync(FIXFLOW_DB, { readOnly: true });
  const profiles = ff
    .prepare(
      `SELECT p.id, p.name AS profile, sy.name AS system
         FROM profiles p JOIN systems sy ON sy.id = p.system_id`)
    .all()
    .map((p) => ({
      ...p,
      key: `${p.system}|${p.profile}`,
      titles: ff.prepare(`SELECT title FROM faults WHERE profile_id=? AND deleted_at IS NULL`)
        .all(p.id).map((r) => r.title),
    }))
    // ⚠️ פרופיל בלי מסמכים אינו מועמד. הוא אינו יכול להתאים לכלום, והשארתו
    // ברשימה רק מדללת את ה-df של כל מונח.
    .filter((p) => p.titles.length > 0);

  // מפת אתר→פרופיל כפי ש-FixFlow יודעת אותה, לאימות.
  const ffSites = new Map(
    ff.prepare(
      `SELECT s.name, p.name AS profile, sy.name AS system
         FROM sites s JOIN profiles p ON p.id=s.profile_id JOIN systems sy ON sy.id=p.system_id
        WHERE s.deleted_at IS NULL`).all()
      .map((r) => [r.name, `${r.system}|${r.profile}`]));
  ff.close();

  const model = buildModel(profiles);

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows: faults } = await pool.query(
    `SELECT s.code, s.site_name, h.fault_text
       FROM status_history h JOIN sites s ON s.id = h.site_id
      WHERE COALESCE(h.fault_text,'') <> ''
      GROUP BY s.code, s.site_name, h.fault_text`);
  await pool.end();

  const bySite = new Map();
  for (const r of faults) {
    if (!bySite.has(r.code)) bySite.set(r.code, { name: r.site_name, texts: [] });
    bySite.get(r.code).texts.push(r.fault_text);
  }

  // ============================================================
  // 1. אימות — על אתרים שהתשובה שלהם כבר ידועה
  // ============================================================
  const MAP = JSON.parse(
    (await import("node:fs")).readFileSync(
      new URL("../../dashboard/src/components/FixFlowLink/fixflow-sites.json", import.meta.url), "utf8"));

  console.log(`\n=== אימות השיטה על אתרים שהתשובה שלהם ידועה ===\n`);
  let hit = 0, miss = 0, refused = 0;
  const misses = [];
  for (const [code, m] of Object.entries(MAP.sites)) {
    if (m.by !== "name") continue;                 // רק אלה שהותאמו בוודאות
    const truth = ffSites.get(m.siteName);
    const site = bySite.get(code);
    if (!truth || !site) continue;
    const ranked = rank(site.texts, model, profiles);
    const v = verdict(ranked);
    if (!v.ok) { refused++; continue; }
    if (ranked[0].key === truth) hit++;
    else { miss++; misses.push([code, site.name, truth, ranked[0].key, ranked[0].s, ranked[1].s]); }
  }
  const decided = hit + miss;
  console.log(`   נבדקו ${decided + refused} אתרים עם היסטוריית תקלות והתאמת שם.`);
  console.log(`   ✅ צדק: ${hit}   ❌ טעה: ${miss}   ⏭️ סירב (ראיה דקה): ${refused}`);
  if (decided) console.log(`   דיוק כשהוא כן עונה: ${((hit / decided) * 100).toFixed(1)}%`);
  for (const [code, name, truth, got, s1, s2] of misses)
    console.log(`      ❌ ${code} ${name}: אמת=${truth} · ניחש=${got} (${s1.toFixed(2)} מול ${s2.toFixed(2)})`);

  // ============================================================
  // 2. התשובה לשלושת האתרים שאינם מקושרים
  // ============================================================
  console.log(`\n=== האתרים שאינם מקושרים ===`);
  // ⚠️ הרשימה מגיעה מהפקודה כשניתנה, אחרת ברירת המחדל. כלי אבחון שאפשר
  // לכוון לאתר אחר הוא כלי שישמש שוב; כזה שקשיח לשלושה קודים ייזרק.
  const CODES = process.argv.slice(2).filter((a) => /^[A-Za-z0-9_-]+$/.test(a));
  for (const code of (CODES.length ? CODES : ["1370", "3465", "3510"])) {
    const site = bySite.get(code);
    console.log(`\n${code}  ${site?.name ?? ""}`);
    if (!site) { console.log(`   ⏭️  אין ולו תקלה אחת בהיסטוריה — אין על מה למדוד.`); continue; }
    console.log(`   ${site.texts.length} נוסחי תקלה שונים`);
    const ranked = rank(site.texts, model, profiles);
    for (const p of ranked.slice(0, 4))
      console.log(`      ${p.s.toFixed(3)}  ${p.system} / ${p.profile}`);
    const v = verdict(ranked);
    console.log(v.ok
      ? `   ✅ פרופיל: ${ranked[0].system} / ${ranked[0].profile}`
      : `   ⏭️  פרופיל — אין די ראיות (${v.why})`);

    // ⚠️ ואז השאלה שבאמת חסרה: איזו מערכת. `plc_type` כבר ידוע,
    // והוא גוזר את הפרופיל בתוך המערכת בלי שום ניחוש.
    const sv = systemVerdict(ranked);
    console.log(`      מערכות: ${sv.sorted.map(([n, v2]) => `${n} ${v2.toFixed(3)}`).join("  ·  ")}`);
    console.log(sv.ok
      ? `   ✅ מערכת: ${sv.system}`
      : `   ⏭️  מערכת — אין די ראיות (${sv.why})`);
  }

  console.log(`\n⚠️ הכלי אינו כותב דבר. מה שהוא מייצר הוא **טענה שאפשר לבדוק**;`);
  console.log(`   השיוך בפועל נקבע ב-fixflow-overrides.json שבתיקיית הפיילוט.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
