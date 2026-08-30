// tools/parity-executive.js — שער האימוץ למסך ההנהלה בקריאה ישירה.
//
//   PARITY_EMAIL=<מייל> PARITY_PASSWORD=<סיסמה> \
//     node --env-file=.env tools/parity-executive.js
//
// ============================================================
// מה מסוכן כאן
// ============================================================
// החישוב עצמו הוא shared/executive.mjs — אותו קובץ בשני הצדדים, ולכן אינו
// יכול לסטות. מה שכן יכול:
//
//   1. **מבנה `data`.** statsFromData/uptimeFromData מצפות ל-Map לפי site_id
//      עם שלושה שדות. חסר אחד מהם ואין שגיאה — יש מדד שקט ושגוי.
//
//   2. **חלון המצבים.** חפיפה ולא הכלה. ב-PostgREST זה נכתב אחרת לגמרי
//      (\`.or(ended_at.is.null,...)\`), וטעות שם מחזירה קבוצה אחרת בשקט.
//
//   3. **סדר האתרים.** computeExecutive ממפה קוד→מזהה דרך allSites; סדר שונה
//      מזיז שורות במפת החום בלי שאף מספר ייראה שגוי.
//
// ולכן הצד הישיר כאן נשלף מ-**PostgREST האמיתי**, ולא מהדמיה. הדמיה הייתה
// מפספסת בדיוק את מה שכבר נתפס פעם אחת: Supabase חוסם כל בקשה ב-1,000
// שורות ומתעלם מ-limit.

const fs = require("node:fs");
const { fetchRetry } = require("./lib/fetch-retry");
const path = require("node:path");
const db = require("../db/db");
const { getExecutiveStatsFiltered } = require("../db/queries");
const { computeExecutive, getBucketRanges } = require("../../shared/executive.mjs");
const { resolvePeriod } = require("../api/periods");

const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const pick = (k) => (ENV.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const SB_URL = pick("VITE_SUPABASE_URL");
const SB_KEY = pick("VITE_SUPABASE_PUBLISHABLE_KEY");

let checks = 0, failures = 0;
const fails = [];
let TOKEN = null;

// ⚠️ לשער הזה חמש נקודות יציאה שונות (כולל "לא ניתן להשוות" ו-catch),
// ולכן הניקוי עובר דרך `done` ולא נכתב ליד כל אחת מהן. ניקוי שנשכח
// בנתיב אחד משאיר משתמש שער אחרי כל ריצה שנופלת בו — כלומר בדיוק בנתיב
// שחוזרים עליו.
let cleanupUser = async () => {};
const done = async (code) => { await cleanupUser(); process.exit(code); };

// ============================================================
// ⚠️ תיקו-עיגול — הלקח שהשער הראשי למד וזה לא
// ============================================================
// כאן הייתה השוואת JSON.stringify מדויקת, בלי שום סובלנות. התוצאה:
// השער נצבע אדום על totalMaintenanceHours 86.24 מול 86.25 — הפרש של
// **אגורה אחת** שאף צד אינו אשם בו.
//
// מקור ההפרש מתועד ב-parity.js: ערך גולמי זהה עד הספרה העשירית, והעיגול
// נופל על גבול ה-.005. ב-JS המספר יושב מעט מתחת לחצי ב-double ולכן
// Math.round יורד; Postgres מעגל ב-NUMERIC ולכן עולה. Postgres מדויק
// יותר, והוא גם הצד שיישאר אחרי ההגירה.
//
// ⚠️ ושער שנצבע אדום מנתונים שזזו הוא שער שלומדים להתעלם ממנו — וזו
// בדיוק הסיבה שהכלל הזה קיים בשער הראשי. אותו כלל, אותו קבוע.
//
// ⚠️ **שלמים אינם זכאים להקלה.** שם כל הפרש הוא באג בספירה.
const TIE = 0.0100001;
let ties = 0;
const tieList = [];

function sameWithTie(a, b, path, hits) {
  if (a === b) return true;

  if (typeof a === "number" && typeof b === "number"
      && Number.isFinite(a) && Number.isFinite(b)) {
    if (Math.abs(a - b) < 1e-9) return true;
    // שלמים — השוואה מוחלטת. ספירה שזזה היא באג, לא עיגול.
    if (Number.isInteger(a) && Number.isInteger(b)) return false;
    if (Math.abs(a - b) <= TIE) { hits.push(`${path}: ${a} מול ${b}`); return true; }
    return false;
  }

  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => sameWithTie(v, b[i], `${path}[${i}]`, hits));
  }

  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k)
    && sameWithTie(a[k], b[k], path ? `${path}.${k}` : k, hits));
}

function compare(label, a, b) {
  checks++;
  const x = JSON.stringify(a ?? null), y = JSON.stringify(b ?? null);
  if (x === y) return;

  const hits = [];
  if (sameWithTie(a ?? null, b ?? null, label, hits)) {
    ties += hits.length;
    tieList.push(...hits);
    return;
  }

  failures++;
  fails.push(`${label}:\n      שרת = ${x.slice(0, 200)}\n      PostgREST = ${y.slice(0, 200)}`);
}

// ⚠️ Supabase חוסם ב-1,000 שורות ומתעלם מ-limit. רק Range מזיז את החלון.
const PAGE = 1000;
async function rest(q) {
  const rows = [];
  for (let off = 0; ; off += PAGE) {
    const res = await fetchRetry(`${SB_URL}/rest/v1/${q}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${TOKEN}`,
                 Accept: "application/json", Range: `${off}-${off + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`PostgREST ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}
async function rpc(fn, args) {
  const res = await fetchRetry(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`RPC ${fn} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const enc = encodeURIComponent;
const group = (rows) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.site_id)) m.set(r.site_id, []);
    m.get(r.site_id).push(r);
  }
  return m;
};

// ============================================================
// ⚠️ זהו **העתק** של executiveDirect.js, לא ייבוא — וזה עלה
// ============================================================
// הקבצים בדשבורד הם מודולי דפדפן שמייבאים supabase-js; השער רץ ב-node
// ומדבר עם PostgREST ישירות. לכן השאילתות משוכפלות כאן.
//
// ⚠️ **וזה בדיוק מה שהפך את השער לעיוור:** כשהתגלה שהזרוע הישירה לא
// שולפת excluded_at ו-reclassified_to, התיקון נכנס ל-executiveDirect.js
// והשער המשיך להריץ את הגרסה הישנה — כלומר הוא בדק העתק מיושן ולא את
// הקוד שרץ בפועל, והמשיך לדווח על פער שכבר תוקן.
//
// כל שינוי ב-select של executiveDirect.js או supervisorDirect.js חייב
// להשתקף כאן. אין מנגנון שאוכף את זה — רק ההערה הזו.
/** בונה את הצד הישיר בדיוק כמו executiveDirect.js + supervisorDirect.js. */
async function viaPostgrest(from, to, filters) {
  // ⚠️ **הזרוע הישירה כבר אינה שולפת שורות גולמיות.** היא קוראת
  // ל-executive_series, שמצטברת במסד: 10,630 שורות הפכו ל-480. העותק
  // כאן חייב לעקוב, אחרת השער בודק מסלול שאיש כבר לא מריץ — וזה גרוע
  // משער שנופל, כי הוא ירוק.
  const buckets = getBucketRanges({ from, to, granularity: filters.granularity || "day" });
  const withTotal = [...buckets.map((b) => ({ from: b.from, to: b.to })), { from, to }];

  const [sites, stats, uptime, globals, series] = await Promise.all([
    rest("sites?select=*"),
    rpc("site_stats", { p_site_ids: null, p_from: from, p_to: to }),
    rpc("site_uptime", { p_site_ids: null, p_from: from, p_to: to }),
    rpc("site_globals", { p_site_ids: null }),
    rpc("executive_series", { p_site_ids: null, p_from: from, p_to: to, p_buckets: withTotal }),
  ]);

  const by = (rows) => new Map(rows.map((r) => [r.site_id, r]));
  const S = by(stats), U = by(uptime), G = by(globals);

  const sorted = sites.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));

  const allRows = sorted.map((site) => {
    const s = S.get(site.id) || {}, u = U.get(site.id) || {}, g = G.get(site.id) || {};
    const inManualMaintenance = Boolean(g.maintenance_id);
    return {
      code: site.code, name: site.site_name,
      status: inManualMaintenance || site.status === "maintenance" ? "maintenance" : site.status,
      tier: site.tier,
      lastOperation: g.last_op_occurred_at ? {
        start_end: g.last_op_start_end, entry_exit: g.last_op_entry_exit,
        card_number: g.last_op_card_number, occurred_at: g.last_op_occurred_at,
      } : null,
      operations: s.operations ?? 0, errors: s.errors ?? 0,
      failureRate: s.failure_rate ?? 0,
      availability: u.availability_percent ?? null,
      hasUptimeData: (u.measured_hours ?? 0) > 0,
      maintenanceHours: u.maintenance_hours ?? 0,
      downtimeHours: u.error_hours ?? 0,
      lastError: g.last_fault_at ?? null,
      operationsSinceLastError: g.operations_since_last_error ?? 0,
      cycleTotal: site.plc_cycle_last, cycleDelta: null, inManualMaintenance,
    };
  });

  return computeExecutive({
    allRows,
    series,
    allSites: sorted.map((s) => ({ id: s.id, code: s.code, site_name: s.site_name })),
    from, to, ...filters,
  });
}

(async () => {
  await db.init();

  // ⚠️ בונה לעצמו משתמש חד-פעמי במקום להישען על חשבון של אדם — החשבון
  // שהשער השתמש בו נמחק בפועל, והשער הפסיק לרוץ בלי שאיש שם לב.
  const { gateToken } = require("./lib/gate-user");
  let email;
  try {
    const g = await gateToken(SB_URL, SB_KEY, process.env.SUPABASE_SECRET_KEY, fetchRetry);
    TOKEN = g.token; email = g.email; cleanupUser = g.cleanup;
  } catch (e) {
    // ⚠️ קוד 2 ולא 1: אי-אפשרות להזדהות היא **אין ידיעה**, לא אי-התאמה
    // בין הזרועות. דיווח ככישלון היה מצביע על באג במדדים שאינו קיים.
    console.log(`\n⚠️  לא ניתן היה להזדהות — PostgREST לא נבדק. ${e.message}`);
    process.exit(2);
  }
  console.log(`מחובר כ-${email}\n`);

  // מגוון פילטרים — לא רק ברירת המחדל. הפילוח והמיון הם בדיוק המקום שבו
  // סדר אתרים שונה משנה תוצאה בלי לשנות אף מספר בודד.
  const CASES = [
    { name: "ברירת מחדל", f: {} },
    { name: "groupBy=status", f: { groupBy: "status" } },
    { name: "groupBy=time", f: { groupBy: "time" } },
    { name: "minFailureRate=1", f: { minFailureRate: 1 } },
  ];

  // ============================================================
  // ⚠️ מגן היציבות — וזה השער היחיד שלא קיבל אותו
  // ============================================================
  // `PARITY_LAG_MS` למטה סוגר את קצה הטווח, והוא מכסה **פעולה שנוצרת
  // עכשיו**. הוא אינו מכסה שני דברים אחרים, ושניהם נמדדו:
  //
  //   • **מסירה חוזרת מ-HiveMQ** — שורות עם חותם מלפני שעות נכתבות עכשיו,
  //     כלומר טווח עבר משתנה מתחת לשתי הזרועות. שום חלון לא יעזור.
  //   • **`sites.status`** — עמודת מצב **חי**, לא ממוסגרת בטווח בכלל.
  //     אתר שעבר מ-`ready` ל-`operating` בין הקריאה לשרת לקריאה ל-
  //     PostgREST מייצר "הבדל" ברשימת האתרים, ולא בשום מספר.
  //
  // נמדד ממש עכשיו: השער נפל על רשימת אתרים שבה קוד אחד החליף מצב, ועבר
  // נקי בהרצה שאחריה — על אותו קוד בדיוק. שער שנופל באקראי מלמד להתעלם
  // ממנו, וזה גרוע משער שאינו קיים.
  //
  // ⚠️ `snapshot` מזהה גם את שינוי המצב החי, ולא במקרה: כל שינוי מצב כותב
  // שורה ל-`status_history` **וגם** מעדכן את `sites.status`, ולכן
  // `MAX(id)` שם זז יחד איתו.
  const { runStable } = require("./lib/stability");

  let liveFailures = 0;
  const compareLive = async () => {
    // ⚠️ איפוס: runStable מריץ את ההשוואה **כולה** מחדש, ובלי זה המונים
    // מצטברים והשער היה מדווח על 178 השוואות במקום 89 — ועל אותו הבדל
    // פעמיים.
    checks = 0; failures = 0; fails.length = 0;

  for (const period of ["week", "month"]) {
    const p = resolvePeriod(period);
    // ============================================================
    // ⚠️ חלון **סגור**, ולא "עד עכשיו" — וזה תיקון של הפכפכות אמיתית
    // ============================================================
    // שתי הזרועות נקראות ברצף, ולכן הודעה שנכנסת בין הקריאה הראשונה
    // לשנייה נראית רק לשנייה מהן. נמדד: 83 מול 82 בהרצה אחת, ואפס
    // הבדלים בשתי ההרצות שאחריה — על אותו קוד בדיוק.
    //
    // שער שנופל באקראי מלמד להתעלם ממנו, וזה גרוע משער שאינו קיים.
    // לכן הקצה נסגר כמה שניות אחורה: פעולות שנקלטות ממש עכשיו נושאות
    // occurred_at של עכשיו, ומחוץ לחלון שתי הזרועות רואות בדיוק אותו דבר.
    const PARITY_LAG_MS = 15_000;
    const to = new Date(Date.now() - PARITY_LAG_MS).toISOString();
    console.log(`=== מסך ההנהלה — ${period} ===`);

    for (const c of CASES) {
      const filters = { granularity: p.granularity, ...c.f };
      const srv = await getExecutiveStatsFiltered({ from: p.range.from, to, ...filters });
      const dir = await viaPostgrest(p.range.from, to, filters);

      for (const key of Object.keys(srv)) {
        compare(`${period}/${c.name}.${key}`, srv[key], dir[key]);
      }
    }
    console.log(`  ${CASES.length} צירופי פילטרים נבדקו`);
  }
    liveFailures = failures;
  };

  const { stable, marker } = await runStable(db, compareLive);

  // ============================================================
  // מקרים זרועים — מה שנתוני הייצור אינם מכילים
  // ============================================================
  // ⚠️ נמדד כאן ממש: מוטציה שהעבירה מפת windows ריקה ל-computeExecutive
  // **עברה את כל 88 ההשוואות**, פשוט כי בייצור אין אף חלון תחזוקה ידני.
  // אותו עיוורון מתועד ב-master/CLAUDE.md על שער ה-parity הראשי.
  //
  // ההשוואה כאן אינה מול השרת אלא מול **ההתנהגות המוגדרת**, כי אי אפשר
  // לזרוע שורות בייצור. הקלט סינתטי, הפונקציה היא זו שרצה בשני הצדדים.
  console.log(`\n=== מקרים זרועים ===`);

  const H = 3600 * 1000;
  const T0 = Date.parse("2026-07-01T00:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  const FROM = iso(T0), TO = iso(T0 + 24 * H);

  const baseRow = {
    code: "T1", name: "בדיקה", status: "ready", tier: "basic",
    operations: 10, errors: 1, failureRate: 10, availability: 100,
    hasUptimeData: true, maintenanceHours: 0, downtimeHours: 0,
    lastError: null, operationsSinceLastError: 10, cycleTotal: 0,
    cycleDelta: null, inManualMaintenance: false, lastOperation: null,
  };

  const run = (windows) => computeExecutive({
    allRows: [baseRow],
    data: {
      ops: new Map([[1, []]]),
      // 24 שעות ready רצופות. בלי חלון — 100% זמינות ואפס תחזוקה.
      segments: new Map([[1, [{ site_id: 1, status: "ready", started_at: FROM, ended_at: TO, id: 1 }]]]),
      windows: new Map([[1, windows]]),
    },
    allSites: [{ id: 1, code: "T1", site_name: "בדיקה" }],
    from: FROM, to: TO, granularity: "day",
  });

  const withoutWindow = run([]);
  const withWindow = run([{
    site_id: 1, started_at: iso(T0 + 6 * H), expires_at: iso(T0 + 18 * H), cancelled_at: null,
  }]);

  // ⚠️ 12 שעות תחזוקה ידנית **מוחרגות מהמכנה לגמרי** — הן אינן זמן תקין
  // ואינן השבתה. אם המפה מתעלמים ממנה, שני החישובים יוצאים זהים — וזה
  // בדיוק מה שהמוטציה הראתה.
  checks++;
  const differs = JSON.stringify(withoutWindow.chart) !== JSON.stringify(withWindow.chart);
  if (!differs) {
    failures++;
    fails.push("זרוע — חלון תחזוקה ידני אינו משפיע על הגרף.\n" +
               "      12 שעות תחזוקה מתוך 24 חייבות לשנות את הזמינות; " +
               "אם לא — data.windows אינו מגיע לחישוב.");
    console.log("  ✗ חלון תחזוקה ידני משפיע על הזמינות");
  } else {
    console.log(`  ✓ חלון תחזוקה ידני משפיע על הזמינות  ` +
                `(${withoutWindow.chart[0]?.maintenanceHours ?? 0} -> ${withWindow.chart[0]?.maintenanceHours ?? 0} שע')`);
  }

  console.log(`\n${"=".repeat(60)}`);

  // ============================================================
  // ⚠️ המקרים הזרועים נבדקים ראשונים — הם דטרמיניסטיים
  // ============================================================
  // הקלט שלהם סינתטי ואינו נקרא מהמסד, ולכן "הנתונים זזו" אינו הסבר
  // אפשרי לכשל שלהם. בלי ההפרדה הזו כשל אמיתי בזרוע היה מדווח כ"לא ניתן
  // להשוות" בכל פעם שאתר כלשהו פעל באותו רגע — כלומר נקבר.
  const seededFailures = failures - liveFailures;
  if (seededFailures) {
    console.log(`❌ ${seededFailures} כשלים במקרים הזרועים — אינם תלויים בנתוני ייצור\n`);
    fails.slice(-8).forEach((f) => console.log("   " + f));
    await done(1);
  }

  // "לא ניתן להשוות" — ולא "עבר" ולא "נפל". קוד 2, ו-gates.js מדווח
  // "לא רץ": אין ידיעה, וזה נאמר. ראה tools/lib/stability.js.
  if (!stable && liveFailures) {
    console.log("⏭️  לא ניתן להשוות — נתונים נכתבו במהלך כל הניסיונות.");
    console.log(`   סמן: ${marker}`);
    console.log("   קורה כשאתר משנה מצב או בזמן מסירה חוזרת מ-HiveMQ. נסו שוב בעוד דקה.");
    await done(2);
  }

  if (failures) {
    console.log(`❌ ${failures} הבדלים מתוך ${checks} השוואות\n`);
    fails.slice(0, 8).forEach((f) => console.log("   " + f));
    await done(1);
  }
  console.log(`✅ שתי הזרועות זהות — ${checks} השוואות, 0 הבדלים`);
  // ⚠️ התיקואים מוצגים ולא נבלעים: שער ששותק על הפרש, גם זעיר, מסתיר
  // בדיוק את הסוג שאם יגדל יהפוך לבאג אמיתי.
  if (ties) {
    console.log(`   (${ties} תיקו-עיגול על גבול .005 — הערך הגולמי זהה בשני הצדדים)`);
    for (const t of tieList.slice(0, 5)) console.log(`     ${t}`);
  }
  await done(0);
})().catch(async (e) => { console.error("parity-executive: נפל —", e.message); await done(1); });
