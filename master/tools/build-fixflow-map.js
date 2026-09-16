// build-fixflow-map.js — מייצר את מפת האתרים שהדשבורד משתמש בה לקישור ל-FixFlow.
//
//   node --env-file=.env tools/build-fixflow-map.js            (ריצה יבשה)
//   node --env-file=.env tools/build-fixflow-map.js --write
//
// ============================================================
// למה קובץ שנוצר, ולא טבלה ולא שאילתה חיה
// ============================================================
// הדשבורד רץ בדפדפן ומוגש מ-Cloudflare; FixFlow רצה על מחשב במשרד ב-http.
// דף https אינו יכול לעשות fetch לשרת http ברשת המקומית — הדפדפן חוסם. לכן
// הדשבורד אינו יכול לשאול את FixFlow מי האתרים שלה, והמפה חייבת להיות מוכנה
// מראש.
//
// ⚠️ והיא **קובץ בתוך תיקיית הפיילוט**, לא טבלה ב-Supabase. זו דרישת ההסרה:
// מחיקת `components/FixFlowLink/` מוחקת גם את המפה. טבלה הייתה שורדת את
// המחיקה ומצריכה החלטה נפרדת ביום שבו הפיילוט נגמר.
//
// ============================================================
// ⚠️ שתי דרכים לקשר, ולכל אחת כשל משלה
// ============================================================
// **לפי שם** מביא קישור ברמת האתר, כלומר עם חריגות האתר (22 קיימות) — וזה
// עדיף. ההתאמה כאן היא **שוויון מחרוזות אחרי נרמול**, לא ציון דמיון: 117
// שמות ב-FixFlow נורמלו ל-117 שמות ייחודיים, אפס התנגשויות.
//
// ⚠️ אבל השם יורש את השיוך של FixFlow, וחלק מהשיוכים שם שגויים: גולדברג 5
// משויך ל-`שאטל מצבט y`, פרופיל שאין לו תיקייה בכונן ולכן **0 מסמכים לנצח**,
// בזמן ש-`שאטל מצבט y שמסובבת בשאטל` מחזיק 42. התאמה מושלמת לספרייה ריקה.
//
// **לפי סוג מכונה** אינו סובל מזה, אבל אינו מביא חריגות אתר.
//
// לכן: שם קודם, ואם הספרייה שהוא מוביל אליה ריקה והסוג מוביל לאחת עם תוכן —
// הסוג מנצח. הסיבה נרשמת בכל שורה, כדי שההחלטה תהיה נראית ולא מסתורית.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { resolveProfile } from "../../shared/fixflow-profiles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "dashboard", "src", "components", "FixFlowLink", "fixflow-sites.json");
const FIXFLOW_DB =
  process.env.FIXFLOW_DB_PATH ||
  "C:/Users/נעמהמנדלסון/Documents/FixFlow/server/data/parkomat.sqlite";
const WRITE = process.argv.includes("--write");

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// ⚠️ נרמול מינימלי בכוונה. הוא מסיר רק מה שאין בו מידע — גרשיים, פסיקים,
// מקפים וכיווניות. מחיקת ספרות הייתה הופכת את "הירקון 38" ו-"הירקון 224"
// לאותו שם, וזו בדיוק ההתאמה השגויה שהכלי הזה נועד למנוע.
const base = (s) =>
  String(s ?? "")
    .replace(BIDI, "")
    .replace(/['`׳״"]+/g, "")
    .replace(/[,\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// ============================================================
// ⚠️ שני כללים נוספים — ולמה הם אינם "התאמה מעורפלת"
// ============================================================
// ההבדל מציון דמיון הוא מהותי. ציון דמיון **מוותר על מידע**, ולכן הוא יכול
// לחבר שני רחובות שונים: `ברנדיס 38 → הירקון 38` קיבל 0.67, בדיוק כמו זוג נכון.
// הכללים כאן אינם מוותרים על כלום — הם מסירים הבדלי כתיב באותו שם בדיוק:
//
//   עיר      — אצלנו `עמנואל הרומי 10, ת"א`, ב-FixFlow `עמנואל הרומי 10`.
//              אותו רחוב, אותו מספר, והעיר נכתבה בצד אחד בלבד.
//   סדר טווח — אצלנו `בארט 19-11`, ב-FixFlow `בארט 11-19`. אותו טווח, הפוך.
//
// ⚠️ **ונמדדו לפני שנכנסו**, כי כלל שמייצר התנגשות אחת גרוע מארבעה חיבורים
// ידניים: 117 השמות ב-FixFlow נשארים 117 ייחודיים תחת שניהם. אפס התנגשויות.
// אם יום אחד תיווצר התנגשות, הכלי מדווח עליה ואינו מתאים בשקט — ראה `byName`.
const CITY_SUFFIX =
  /\s*(תא|ת א|תל אביב|רג|ר ג|רמת גן|בת ים|חולון|רעננה|ירושלים|הוד השרון|רמת השרון|רמהש|גבעתיים|הרצליה|נס ציונה|פקיעין|ראשון לציון)\s*$/;

// "19 11" → "11 19". רק זוג מספרים צמודים, כלומר טווח.
const sortRange = (s) => s.replace(/(\d+)\s+(\d+)/g, (m, a, b) => (+a <= +b ? `${a} ${b}` : `${b} ${a}`));

const norm = (s) => sortRange(base(s).replace(CITY_SUFFIX, "").trim());

async function main() {
  const ff = new DatabaseSync(FIXFLOW_DB, { readOnly: true });
  const ffSites = ff
    .prepare(
      `SELECT s.id, s.name, p.id AS profile_id, p.name AS profile, sy.name AS system,
              (SELECT COUNT(*) FROM site_fault_overrides o WHERE o.site_id = s.id) AS overrides
         FROM sites s
         JOIN profiles p ON p.id = s.profile_id
         JOIN systems sy ON sy.id = p.system_id
        WHERE s.deleted_at IS NULL`
    )
    .all();
  const docCount = new Map();
  for (const r of ff
    .prepare(
      `SELECT p.id,
              (SELECT COUNT(*) FROM faults f WHERE f.profile_id = p.id AND f.deleted_at IS NULL) AS n
         FROM profiles p`
    )
    .all())
    docCount.set(r.id, r.n);
  const profileIdByName = new Map(ffSites.map((s) => [`${s.system}|${s.profile}`, s.profile_id]));

  // ⚠️ רשימת הספריות — האפשרויות שבתפריט במסך הניהול.
  // הדפדפן אינו יכול לשאול את FixFlow מה הספריות שלה (דף https מול שרת http
  // ברשת המשרד), ולכן הרשימה נוסעת עם המפה.
  //
  // ⚠️ **והיא כוללת גם ספריות ריקות**, עם מספר המסמכים ליד כל אחת. הסתרת
  // הריקות הייתה מונעת בחירה נכונה שעוד לא יוצאה מהכונן — ו-34 מסמכי מצבט X
  // הם בדיוק המצב הזה היום.
  // ============================================================
  // ⚠️ רשימת האתרים של FixFlow — ולמה היא נחוצה לצד רשימת הספריות
  // ============================================================
  // קישור ל**ספרייה** מביא את התקלות של סוג המכונה. קישור ל**אתר** מביא את
  // אותן תקלות **בתוספת חריגות האתר** — דרך טיפול שנכתבה במיוחד למתקן אחד.
  //
  // ⚠️ **וזה אינו תיאורטי:** 22 חריגות קיימות, ו-15 מהן שייכות לגרוזנברג 7
  // — אתר שלנו. בורר שמציע רק ספריות היה גורם לבחירה ידנית בגרוזנברג למחוק
  // 15 חריגות בלי שום סימן על המסך.
  const siteList = {};
  // ⚠️ ממוין לפי שם, כי זו הדרך שבה מחפשים אתר. מיון לפי מספר חריגות היה
  // "חכם" ובלתי ניתן לניווט ברשימה של 117.
  for (const r of [...ffSites].sort((a, b) => String(a.name).localeCompare(String(b.name), "he")))
    siteList[r.id] = {
      name: r.name,
      system: r.system,
      profile: r.profile,
      docs: docCount.get(r.profile_id) ?? 0,
      overrides: r.overrides,
    };

  // ============================================================
  // ⚠️ הנהלים עצמם — כותרת ואזהרת בטיחות בלבד
  // ============================================================
  // הכרטיס בדשבורד צריך להתאים את נוסח התקלה שהבקר כתב לנוהל שמטפל בה. הוא
  // אינו יכול לשאול את FixFlow: דף https מול שרת http ברשת המשרד. לכן הנהלים
  // נוסעים עם המפה.
  //
  // ⚠️ **כותרת ואזהרה בלבד, ולא עצי הטיפול.** נמדד: העצים שוקלים 3.7MB —
  // פי מאה מהמפה. ומעבר לגודל, שלושת הצעדים הראשונים **זהים כמעט בכל נוהל**
  // (`פתח טים` ב-304 מתוך 319, `פתח מצלמות` ב-303), כי כך הם נכתבו. הצגתם
  // על הכרטיס הייתה "הוראה" שנכונה לכל תקלה ואינה מלמדת דבר.
  //
  // מה שכן ייחודי לתקלה הוא **אזהרת הבטיחות** — 148 מתוך 319 מחזיקות אחת,
  // והן ספציפיות ממש: "חובה לוודא במצלמות שאין אנשים בחניון וציוד שהושאר
  // בפיר". זה מה שרוצים לראות בשנייה שבה תקלה קופצת.
  const faultsByProfile = {};
  for (const r of ff
    .prepare(
      `SELECT f.id, f.title, f.warning, sy.name AS system, p.name AS profile
         FROM faults f
         JOIN profiles p ON p.id = f.profile_id
         JOIN systems sy ON sy.id = p.system_id
        WHERE f.deleted_at IS NULL
        ORDER BY sy.name, p.name, f.sort_order`)
    .all()) {
    const key = `${r.system}|${r.profile}`;
    (faultsByProfile[key] ??= []).push(
      // ⚠️ מפתחות קצרים: `id/title/warning` על 319 שורות מוסיפים ~6KB של שמות
      // שדות בלבד. הקובץ הזה נטען בכל פתיחה של הדשבורד.
      r.warning ? { i: r.id, t: r.title, w: r.warning } : { i: r.id, t: r.title });
  }

  const profileList = {};
  for (const r of ff
    .prepare(
      `SELECT sy.name AS system, p.name AS profile,
              (SELECT COUNT(*) FROM faults f WHERE f.profile_id = p.id AND f.deleted_at IS NULL) AS docs,
              (SELECT COUNT(*) FROM sites s WHERE s.profile_id = p.id AND s.deleted_at IS NULL) AS sites
         FROM profiles p JOIN systems sy ON sy.id = p.system_id
        ORDER BY sy.name, p.name`)
    .all())
    profileList[`${r.system}|${r.profile}`] = { system: r.system, profile: r.profile, docs: r.docs, sites: r.sites };

  ff.close();

  // ⚠️ שם שמופיע פעמיים אינו מזהה. במדידה יש 0 כאלה, אבל הבדיקה נשארת: ביום
  // שבו יתווסף אתר בשם קיים, התאמה "מדויקת" תתחיל להצביע על אחד משניים באקראי.
  const byName = new Map();
  for (const s of ffSites) {
    const k = norm(s.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(s);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows: sites } = await pool.query(`SELECT code, site_name, plc_type FROM sites ORDER BY code`);
  const { rows: cols } = await pool.query(`SELECT key, label FROM traffic_light_columns`);
  const { rows: tlRows } = await pool.query(`SELECT cells FROM traffic_light_rows`);
  await pool.end();

  const colKey = (label) => cols.find((c) => c.label === label)?.key;
  const SITE = colKey("אתר");
  const CODE = colKey("קוד אתר");
  const tlName = new Map();
  for (const r of tlRows) {
    const raw = r.cells?.[CODE];
    const nm = r.cells?.[SITE];
    if (!raw || !nm) continue;
    // תא אחד יכול להחזיק שני קודים ("1376, 3501" — שני מתקנים באתר פיזי אחד).
    for (const c of String(raw).split(/[,\s]+/).filter(Boolean)) tlName.set(c.trim(), nm);
  }

  // ============================================================
  // ⚠️ המפה הזו היא **הצעה**, לא סמכות
  // ============================================================
  // מה שקובע בפועל הוא `sites.fixflow_profile` — הבחירה שנעשית במסך הניהול.
  // המפה משמשת רק כשלא נבחר דבר, ו-`resolveLink` מעדיף אותה על פני ניחוש.
  //
  // ⚠️ **והיה כאן קובץ עקיפות, והוסר.** הוא עשה בדיוק את מה שהשדה עושה —
  // ורק אני יכולתי לערוך אותו. שני מנגנונים לאותה שאלה הם שני מקורות אמת
  // שסוטים, וזה בדיוק הפגם שהשדה נועד לסגור.
  // פרופילים שהמפה מצביעה עליהם ואינם קיימים ב-FixFlow — באג, לא ספרייה ריקה.
  const broken = new Set();
  const map = {};
  const report = [];
  for (const s of sites) {
    const byType = resolveProfile(s.plc_type ?? null, null);
    // ============================================================
    // ⚠️ "הפרופיל אינו קיים" אינו "הפרופיל ריק"
    // ============================================================
    // עד כה שניהם נבלעו ב-`?? 0` והוצגו כ"ספרייה ריקה". והיום `matzbet-x`
    // ממופה ל-`שאטל מצבט x קומתי (מצבטון על המעלית)` — **שם שאינו קיים
    // ב-FixFlow כלל**; זה שם התיקייה בכונן, לא שם הפרופיל. הירקון 224 יושב
    // שם עכשיו, והמסך אומר "ספרייה ריקה" — כלומר באג במיפוי נראה בדיוק כמו
    // המתנה לייצוא מסמכים מהכונן.
    const typeKey = byType.status === "ok" ? `${byType.system}|${byType.profile}` : null;
    const typeMissing = typeKey !== null && !profileIdByName.has(typeKey);
    if (typeMissing) broken.add(typeKey);
    const typeDocs = typeKey && !typeMissing ? (docCount.get(profileIdByName.get(typeKey)) ?? 0) : 0;

    let hit = null;
    for (const candidate of [tlName.get(String(s.code)), s.site_name]) {
      if (!candidate) continue;
      const m = byName.get(norm(candidate));
      if (m && m.length === 1) {
        hit = m[0];
        break;
      }
    }

    if (hit) {
      const nameDocs = docCount.get(hit.profile_id) ?? 0;
      if (nameDocs === 0 && typeDocs > 0) {
        // ⚠️ השם התאים, אבל האתר משויך ב-FixFlow לפרופיל ריק. שליחת מוקדן
        // לרשימה ריקה אינה מציגה שגיאה — היא נראית כמו "אין תקלות ידועות".
        map[s.code] = { by: "type", system: byType.system, profile: byType.profile, docs: typeDocs };
        report.push([s.code, s.site_name, `סוג (השם הוביל לספרייה ריקה: ${hit.profile})`, byType.profile, typeDocs]);
        continue;
      }
      map[s.code] = { by: "name", siteId: hit.id, siteName: hit.name, system: hit.system, profile: hit.profile, docs: nameDocs };
      report.push([s.code, s.site_name, "שם", `${hit.name} · ${hit.profile}`, nameDocs]);
      continue;
    }

    if (byType.status === "ok") {
      map[s.code] = { by: "type", system: byType.system, profile: byType.profile, docs: typeDocs };
      report.push([s.code, s.site_name, "סוג", byType.profile, typeDocs]);
      continue;
    }
    report.push([s.code, s.site_name, "—", byType.reason, 0]);
  }

  console.log(`\nקוד   אתר                        דרך        →  יעד                                  מסמכים`);
  for (const [code, name, via, target, docs] of report)
    console.log(
      String(code).padEnd(6) +
        String(name).slice(0, 25).padEnd(27) +
        String(via).padEnd(11) +
        "→  " +
        String(target).slice(0, 44).padEnd(46) +
        (docs || "—")
    );

  if (broken.size) {
    console.log(`
❌ מיפוי לפרופיל שאינו קיים ב-FixFlow (${broken.size}) — באג ב-PROFILE_BY_TYPE:`);
    for (const k of broken) console.log(`   ${k}`);
    console.log(`   ⚠️ האתרים האלה הוצגו עד כה כ"ספרייה ריקה" — באג שנראה כמו המתנה.`);
  }

  const linked = Object.keys(map).length;
  const byName_ = Object.values(map).filter((m) => m.by === "name").length;
  const empty = Object.values(map).filter((m) => m.docs === 0).length;
  console.log(`\nמקושרים: ${linked} מתוך ${sites.length}  (לפי שם ${byName_} · לפי סוג ${linked - byName_})`);
  if (empty) console.log(`⚠️  מתוכם ${empty} מובילים לספרייה ריקה.`);

  if (!WRITE) {
    console.log(`\n(ריצה יבשה — לא נכתב דבר. לכתיבה: --write)`);
    return;
  }
  writeFileSync(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), profiles: profileList, ffSites: siteList, faults: faultsByProfile, sites: map }, null, 2) + "\n",
    "utf8"
  );
  console.log(`\n✅ נכתב: ${OUT}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
