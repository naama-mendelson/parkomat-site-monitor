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
const norm = (s) =>
  String(s ?? "")
    .replace(BIDI, "")
    .replace(/['`׳״"]+/g, "")
    .replace(/[,\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

async function main() {
  const ff = new DatabaseSync(FIXFLOW_DB, { readOnly: true });
  const ffSites = ff
    .prepare(
      `SELECT s.id, s.name, p.id AS profile_id, p.name AS profile, sy.name AS system
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

  const map = {};
  const report = [];
  for (const s of sites) {
    const byType = resolveProfile(s.plc_type ?? null, null);
    const typeDocs =
      byType.status === "ok" ? (docCount.get(profileIdByName.get(`${byType.system}|${byType.profile}`)) ?? 0) : 0;

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
    JSON.stringify({ generatedAt: new Date().toISOString(), sites: map }, null, 2) + "\n",
    "utf8"
  );
  console.log(`\n✅ נכתב: ${OUT}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
