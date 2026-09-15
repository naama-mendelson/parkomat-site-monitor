// match-fixflow.js — כמה מטקסטי התקלה שהבקרים שולחים יודעים להצביע על תקלה ב-FixFlow.
//
//   node --env-file=.env tools/match-fixflow.js
//   node --env-file=.env tools/match-fixflow.js --verbose
//
// למה זה קיים: המטרה היא שמהכרטיס בדשבורד אפשר יהיה להגיע ישירות לתקלה ולפתרון שלה.
// הגשר היחיד בין שתי המערכות הוא **הטקסט שהבקר כתב** מצד אחד, ו**כותרת התקלה במסמך
// Word** מצד שני. שניהם נכתבו בידי אנשים שונים בשנים שונות ואיש מהם לא התכוון שיתאימו.
//
// ⚠️ הכלי הזה **מודד בלבד** ואינו כותב דבר — לא ל-Supabase ולא ל-FixFlow. הצעד הבא
// (טבלת קישורים) צריך להישען על מספר ידוע, לא על תקווה.
//
// ⚠️ הוא קורא מ-FixFlow דרך קובץ ה-sqlite שלה. זו תלות חד-כיוונית ומכוונת: SiteMonitor
// יודע על FixFlow, FixFlow אינה יודעת שהוא קיים.
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const FIXFLOW_DB =
  process.env.FIXFLOW_DB_PATH ||
  "C:\\Users\\נעמהמנדלסון\\Documents\\FixFlow\\server\\data\\parkomat.sqlite";
const VERBOSE = process.argv.includes("--verbose");

// ============================================================
// נרמול — והוא מקום שקל מאוד לקלקל בו את המדידה
// ============================================================
// ⚠️ נרמול אגרסיבי מדי *מייצר* התאמות שאינן קיימות: אם נמחק ספרות, אז
// "מיטה 3 - זמן מקסימלי" ו-"מיטה 7 - זמן מקסימלי" יהפכו לאותו מחרוזת, והכלי
// ידווח על התאמה מושלמת בזמן שהמוקדן יישלח לתקלה של מיטה אחרת.
//
// לכן נמחקים רק דברים שאין בהם מידע: רווחים כפולים, ניקוד סופי, גרשיים, ותווי
// כיווניות דו-כיווניים (U+200E‏/U+200F‏/U+2066-2069) — אלה נכנסו לקבצים מ-Word
// והם בלתי-נראים לחלוטין, כלומר בדיוק סוג ההבדל שגורם לשתי מחרוזות זהות למראה
// לא להשוות כשוות.
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
function norm(s) {
  return String(s ?? "")
    .replace(BIDI, "")
    .replace(/["'`׳״]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.:\-–—_\s]+$/u, "")
    .trim()
    .toLowerCase();
}

// מילים שאינן מבדילות בין תקלה לתקלה, ולכן אינן ראיה להתאמה.
const STOP = new Set(["של", "על", "את", "עם", "לא", "או", "אם", "יש", "אין", "ב", "ל", "מ", "ה"]);
const tokens = (s) => norm(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOP.has(t));

// Dice על קבוצות מילים. נבחר על פני "האם אחד מכיל את השני" מפני שהכלה מתגמלת
// כותרות ארוכות במיוחד: כותרת בת 15 מילים מכילה כמעט כל טקסט קצר, ותיקח כל אתר אליה.
function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return (2 * hit) / (A.size + B.size);
}

const STRONG = 0.72; // התאמה שאפשר לקשר אוטומטית
const WEAK = 0.45; // מועמדת — דורשת אישור אדם

async function main() {
  // ---- צד FixFlow ----
  const ff = new DatabaseSync(FIXFLOW_DB, { readOnly: true });
  const targets = ff
    .prepare(
      `SELECT f.id, f.title, f.source_path, p.name AS profile, s.name AS system
         FROM faults f
         JOIN profiles p ON p.id = f.profile_id
         JOIN systems  s ON s.id = p.system_id
        WHERE f.deleted_at IS NULL`
    )
    .all();
  ff.close();

  // ⚠️ לכל תקלה **שני** שמות, ולא אחד: הכותרת שבתוך המסמך (שורת "תיאור התקלה:")
  // ושם הקובץ. הן נכתבו בנפרד ולעיתים קרובות שם הקובץ קרוב הרבה יותר לטקסט
  // שהבקר שולח — מדידה: השוואה לכותרת בלבד הגיעה ל-67.3% מהמופעים.
  // השוואה לשתיהן ולקיחת הטובה מביניהן היא שינוי של שורה, ולכן נבדק ולא שוער.
  // ⚠️ הפיצול חייב לכלול בקסלאש: source_path נכתב בנתיבי Windows. גרסה שפיצלה על
  // לוכסן בלבד החזירה את **הנתיב המלא** כ"שם הקובץ", כלומר התוספת נמדדה ולא עשתה דבר —
  // ‎0.2%- ‏— ונראתה בדיוק כמו "שם הקובץ לא עוזר".
  const fileName = (p) => String(p ?? "").split(/[\\/]/).pop().replace(/\.(docx|gdoc)$/i, "");
  for (const t of targets) t.names = [t.title, fileName(t.source_path)].filter(Boolean);

  // ---- צד SiteMonitor ----
  const { Pool } = pg;
  // ⚠️ BIGINT חוזר כמחרוזת מ-pg. כאן זה COUNT, ומיון מחרוזות היה שם 9 לפני 80.
  pg.types.setTypeParser(20, (v) => parseInt(v, 10));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows: faults } = await pool.query(
    `SELECT fault_text, COUNT(*)::bigint AS n, COUNT(DISTINCT site_id)::bigint AS sites
       FROM status_history
      WHERE status = 'error' AND fault_text IS NOT NULL AND btrim(fault_text) <> ''
      GROUP BY fault_text
      ORDER BY n DESC`
  );
  const { rows: monitored } = await pool.query(`SELECT code, site_name AS name FROM sites ORDER BY code`);
  await pool.end();

  // ---- התאמה ----
  const exactIndex = new Map();
  for (const t of targets)
    for (const name of t.names) {
      const key = norm(name);
      if (!exactIndex.has(key)) exactIndex.set(key, []);
      if (!exactIndex.get(key).includes(t)) exactIndex.get(key).push(t);
    }

  const result = { exact: [], strong: [], weak: [], none: [] };
  for (const f of faults) {
    const key = norm(f.fault_text);
    const exact = exactIndex.get(key);
    if (exact) {
      result.exact.push({ ...f, match: exact[0], score: 1, candidates: exact.length });
      continue;
    }
    let best = null;
    for (const t of targets)
      for (const name of t.names) {
        const score = similarity(f.fault_text, name);
        if (!best || score > best.score) best = { match: t, score, via: name };
      }
    if (!best || best.score < WEAK) result.none.push({ ...f, best });
    else if (best.score >= STRONG) result.strong.push({ ...f, ...best });
    else result.weak.push({ ...f, ...best });
  }

  // ---- דוח ----
  const occ = (rows) => rows.reduce((s, r) => s + r.n, 0);
  const total = occ(faults);
  const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : "0.0") + "%";

  console.log(`\n=== התאמת טקסטי תקלה ל-FixFlow ===`);
  console.log(`תקלות ב-FixFlow: ${targets.length}   ·   טקסטים ייחודיים מהבקרים: ${faults.length}   ·   מופעים: ${total}\n`);
  const line = (label, rows) =>
    console.log(`  ${label.padEnd(30)} ${String(rows.length).padStart(4)} טקסטים   ${String(occ(rows)).padStart(5)} מופעים   ${pct(occ(rows)).padStart(6)}`);
  line("התאמה מדויקת", result.exact);
  line(`התאמה חזקה (≥${STRONG})`, result.strong);
  line(`מועמדת לאישור (≥${WEAK})`, result.weak);
  line("ללא התאמה", result.none);
  const linkable = occ(result.exact) + occ(result.strong);
  console.log(`\n  ניתן לקשר אוטומטית: ${pct(linkable)} מהמופעים`);

  const show = (title, rows, fmt) => {
    if (!rows.length) return;
    console.log(`\n--- ${title} (${rows.length}) ---`);
    for (const r of rows.slice(0, VERBOSE ? rows.length : 20)) console.log("   " + fmt(r));
    if (!VERBOSE && rows.length > 20) console.log(`   … ועוד ${rows.length - 20}  (--verbose)`);
  };
  // ============================================================
  // הגשר השני — האתרים
  // ============================================================
  // ⚠️ אין מפתח משותף בין המערכות. SiteMonitor מכיר אתר לפי **קוד מספרי** (2438),
  // ול-FixFlow יש עמודת `code` שמכילה את **השם המשוכפל** ולא קוד. לכן הגשר היחיד
  // הוא השם בעברית, על כל שיבושיו — גרשיים כפולים במקום גרש, "ר\"ג" מול "רמת גן".
  //
  // ⚠️ הכלי אינו כותב ל-FixFlow. המיפוי שייך לצד שיודע על קיומו של השני, וזה
  // SiteMonitor — בדיוק כפי שמתואר בראש הקובץ.
  const ffSites = (() => {
    const d = new DatabaseSync(FIXFLOW_DB, { readOnly: true });
    const r = d.prepare(`SELECT s.id, s.name, p.name AS profile FROM sites s
                           JOIN profiles p ON p.id = s.profile_id
                          WHERE s.deleted_at IS NULL`).all();
    d.close();
    return r;
  })();
  const site = { exact: [], strong: [], weak: [], none: [] };
  for (const s of monitored) {
    let best = null;
    for (const f of ffSites) {
      const score = similarity(s.name, f.name);
      if (!best || score > best.score) best = { match: f, score };
    }
    const bucket = !best || best.score < 0.4 ? "none" : best.score === 1 ? "exact" : best.score >= 0.7 ? "strong" : "weak";
    site[bucket].push({ ...s, ...best });
  }
  console.log(`\n=== התאמת אתרים ===`);
  console.log(`אתרים ב-SiteMonitor: ${monitored.length}   ·   אתרים ב-FixFlow: ${ffSites.length}`);
  console.log(`  זהה: ${site.exact.length} · חזק: ${site.strong.length} · חלש: ${site.weak.length} · ללא: ${site.none.length}`);
  const needsEye = [...site.weak, ...site.none];
  if (needsEye.length) {
    console.log(`\n--- אתרים שדורשים עין (${needsEye.length}) ---`);
    for (const r of needsEye)
      console.log(`   ${String(r.code).padEnd(6)} ${r.name.padEnd(26)} →  ${r.match?.name ?? "-"}  (${(r.score ?? 0).toFixed(2)})`);
  }

  show("ללא התאמה — לפי מופעים", [...result.none].sort((a, b) => b.n - a.n),
       (r) => `${String(r.n).padStart(4)}×  "${r.fault_text}"` + (r.best ? `   (הכי קרוב ${r.best.score.toFixed(2)}: ${r.best.via})` : ""));
  show("מועמדות לאישור", [...result.weak].sort((a, b) => b.n - a.n),
       (r) => `${String(r.n).padStart(4)}×  "${r.fault_text}"  →  ${r.via}  (${r.score.toFixed(2)})`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
