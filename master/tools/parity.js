// tools/parity.js — שער הכניסה לכל פורט של מדד ל-SQL.
//
// ============================================================
// למה זה קיים
// ============================================================
// כל פונקציה שעוברת מ-JS ל-SQL חייבת להחזיר את אותם מספרים על נתונים
// אמיתיים *לפני* שהיא מאומצת. בלי כלי כזה ה"אימות" הוא הרצה ידנית של
// כמה אתרים ומבט — וזה בדיוק איך שסטייה של מאית האחוז עוברת בשקט
// לדשבורד ומשם לדוח החודשי.
//
//   npm run parity           — כל הבדיקות
//   npm run parity uptime    — בדיקה אחת
//
// ============================================================
// שתי החלטות שכדאי להבין לפני שמוסיפים בדיקה
// ============================================================
// 1. **משתמשים ב-db.js עצמו, ולא ב-Pool חדש.**
//    ה-pool של db.js מוגדר עם keepAlive ו-query_timeout אחרי שתקלה
//    אמיתית השביתה קליטה ל-15 שעות: Supavisor סוגר חיבורים באמצע, ובלי
//    keepAlive ה-await לא חוזר לעולם. סקריפט עם Pool משלו היה מקבל
//    ECONNRESET אקראי — שנראה בדיוק כמו כישלון parity, אבל אינו כזה.
//    שימוש ב-db.js מבטיח אותן הגדרות בהגדרה, ולא בהעתקה שתתיישן.
//
// 2. **הסף הוא הערך שהמשתמש רואה, לא הביט.**
//    השוואת שוויון-ביטים על double היא הסף הלא-נכון: JS צובר מילישניות
//    שלמות ו-Postgres צובר שניות כ-double, ולכן הספרה ה-15 יכולה להיבדל
//    בלי שום משמעות. שני הצדדים מעגלים ל-2 ספרות לפני שהם מחזירים, ולכן
//    ההשוואה על הערך המעוגל היא גם מדויקת וגם היא מה שבאמת נשלח למסך.
//    שלמים (ספירות) מושווים בשוויון מוחלט — שם כל הפרש הוא באג.

const db = require("../db/db");
const { loadRangeData, uptimeFromData, collapseNoCommFlicker, statsFromData,
        getAllSitesGlobals, getRecentErrors } = require("../db/queries");
const { resolvePeriod } = require("../api/periods");

// ============================================================
// שני הצדדים חייבים לקרוא את **אותו** צילום
// ============================================================
// ⚠️ נמדד, והשער נפל בגללו: `week/2439.operatingHours: JS=12.87 SQL=12.92`.
// שלוש דקות הפרש, ובריצה הבאה 0 הבדלים. שום דבר בקוד לא השתנה — **רכב נסע
// בין שתי השליפות.**
//
// כל השוואה מול נתוני אמת קוראת פעמיים: פעם דרך loadRangeData (צד ה-JS)
// ופעם דרך פונקציית ה-SQL. בבידוד READ COMMITTED **כל שאילתה מקבלת צילום
// משלה**, ולכן קליטה שכותבת מקטע ביניהן מזיזה צד אחד ולא את השני.
//
// המקטעים הפתוחים מחמירים את זה: הם נמדדים עד "עכשיו", וכל צד לוקח את
// ה"עכשיו" שלו.
//
// REPEATABLE READ מקבע צילום אחד לכל הטרנזקציה. אותו פתרון בדיוק כמו
// parity-activity — הוא רק לא הוחל כאן, והמקרים הזרועים (שרצים בתוך
// transaction ממילא) הסתירו את הפער.
//
// ⚠️ שער שמאדים כי הנתונים זזו הוא שער שלומדים להתעלם ממנו. זה גרוע יותר
// משער שלא קיים, כי הוא נראה כמו כיסוי.
async function snapshot(fn) {
  // db.transaction אינו מוסר client — הוא עוקב אחריו דרך AsyncLocalStorage,
  // ולכן db.prepare שבתוכו רץ אוטומטית על אותו חיבור ואותה טרנזקציה.
  return db.transaction(async () => {
    await db.prepare("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ").run();
    return fn();
  });
}

// ===== דיווח =====
let checks = 0, failures = 0;
const fails = [];

// ============================================================
// תיקו-עיגול — הפרש שאינו של אף אחד מהצדדים
// ============================================================
// נתפס בפועל: readyHours של אתר 3513 יצא JS=130.51 מול SQL=130.52. הערך
// הגולמי בשני הצדדים היה **זהה עד הספרה העשירית** — 130.5150000000. כל
// ההפרש הוא בעיגול על גבול ה-.005: ב-JS 130.515 אינו ניתן לייצוג מדויק
// ב-double ויושב מעט מתחת לחצי, ולכן Math.round יורד; Postgres מעגל
// ב-NUMERIC, חשבון עשרוני מדויק, ולכן עולה.
//
// אף צד אינו שגוי — למען האמת Postgres כאן מדויק יותר, וזה גם הצד שיישאר
// אחרי ההגירה. ליפול על זה פירושו שער שנצבע אדום מנתונים שזזו, ולא מקוד
// שנשבר; זהו בדיוק סוג הכשל שגורם להתעלם משער.
//
// לכן: הפרש של **סנט אחד בדיוק** נספר בנפרד ומוצג בסוף, אך אינו מפיל.
// כל דבר גדול מזה עדיין מפיל. שלמים — ספירות — מושווים בשוויון מוחלט
// ואינם זכאים להקלה הזו, כי שם כל הפרש הוא באג.
const TIE = 0.0100001;
let ties = 0;
const tieList = [];

function compare(label, expected, actual) {
  checks++;
  const bothNum = typeof expected === "number" && typeof actual === "number"
    && Number.isFinite(expected) && Number.isFinite(actual);

  if (expected === actual || (bothNum && Math.abs(expected - actual) < 1e-9)) return true;

  const bothInt = bothNum && Number.isInteger(expected) && Number.isInteger(actual);
  if (bothNum && !bothInt && Math.abs(expected - actual) <= TIE) {
    ties++;
    tieList.push(`${label}: JS=${expected} SQL=${actual}`);
    return true;
  }

  failures++;
  fails.push(`${label}: JS=${JSON.stringify(expected)} SQL=${JSON.stringify(actual)}`);
  return false;
}

// ============================================================
// טיפוסים — המלכודת שאי אפשר לראות במספרים
// ============================================================
// ROUND(x,2) ב-Postgres מחזיר NUMERIC, והדרייבר מחזיר NUMERIC כמחרוזת.
// "99.5" === 99.5 הוא false, אבל גרוע מזה: הדשבורד עושה חשבון על הערך,
// ומחרוזת הופכת חיבור לשרשור בלי שגיאה. לכן כל שדה מספרי נבדק גם בטיפוסו.
function expectNumber(label, value) {
  checks++;
  if (typeof value !== "number") {
    failures++;
    fails.push(`${label}: expected JS number, got ${typeof value} (${JSON.stringify(value)})`);
    return false;
  }
  return true;
}

// ===== הבדיקה: זמינות =====
// JS  — loadRangeData + uptimeFromData (המסלול שהדשבורד משתמש בו היום)
// SQL — public.site_uptime
async function parityUptime() {
  const sites = await db.prepare("SELECT id, code FROM sites ORDER BY code").all();
  const ids = sites.map((s) => s.id);
  const byId = new Map(sites.map((s) => [s.id, s.code]));

  console.log(`\n=== זמינות — ${sites.length} אתרים × week/month/year ===`);

  for (const period of ["week", "month", "year"]) {
    const { range } = resolvePeriod(period);
    const to = new Date().toISOString();

    const { data, sql } = await snapshot(async () => ({
      data: await loadRangeData(null, { from: range.from, to }),
      sql: await db.prepare("SELECT * FROM public.site_uptime(?, ?, ?)").all(ids, range.from, to),
    }));
    const sqlById = new Map(sql.map((r) => [r.site_id, r]));

    let periodFails = 0;
    for (const id of ids) {
      const js = uptimeFromData(data, id, { from: range.from, to });
      const s = sqlById.get(id);
      const code = byId.get(id);

      if (!s) {
        failures++; checks++;
        fails.push(`${period}/${code}: SQL returned no row`);
        periodFails++;
        continue;
      }

      const before = failures;
      compare(`${period}/${code}.readyHours`,       js.readyHours,          s.ready_hours);
      compare(`${period}/${code}.operatingHours`,   js.operatingHours,      s.operating_hours);
      compare(`${period}/${code}.errorHours`,       js.errorHours,          s.error_hours);
      compare(`${period}/${code}.maintenanceHours`, js.maintenanceHours,    s.maintenance_hours);
      // הפילוח החדש. סכומם חייב להיות שווה ל-maintenanceHours בשני הצדדים,
      // ולכן השוואה ישירה היא מה שמונע משני הצדדים לפצל אחרת ולהתקזז.
      compare(`${period}/${code}.repairHours`,      js.repairHours,         s.repair_hours);
      compare(`${period}/${code}.plannedHours`,     js.plannedHours,        s.planned_hours);
      compare(`${period}/${code}.noCommHours`,      js.noCommHours,         s.no_comm_hours);
      compare(`${period}/${code}.totalHours`,       js.totalHours,          s.total_hours);
      compare(`${period}/${code}.measuredHours`,    js.measuredHours,       s.measured_hours);
      compare(`${period}/${code}.availability`,     js.availabilityPercent, s.availability_percent);

      expectNumber(`${period}/${code}.availability type`, s.availability_percent);
      expectNumber(`${period}/${code}.measuredHours type`, s.measured_hours);
      expectNumber(`${period}/${code}.totalHours type`, s.total_hours);

      if (failures > before) periodFails++;
    }
    console.log(`  ${period.padEnd(6)} — ${sites.length - periodFails}/${sites.length} אתרים תואמים`);
  }
}

// ============================================================
// מקרי קצה — נזרעים בתוך טרנזקציה שמתגלגלת לאחור
// ============================================================
// הנתונים בפרודקשן הם שבוע אחד של אתרים בריאים, ולכן הם *לא* מכילים את
// המצבים שבהם תרגום נשבר: מקטע שחוצה את שני גבולות החלון, מקטע פתוח,
// חלון הפוך, אתר בלי היסטוריה. אלה חייבים להיזרע.
//
// הזריעה רצה על חיבור session יחיד בתוך BEGIN … ROLLBACK: ה-SQL רואה את
// השורות של הטרנזקציה שלו, וצד ה-JS מקבל *בדיוק אותן שורות* כליטרל
// בזיכרון (uptimeFromData היא פונקציה טהורה). שום דבר לא נשמר.
const H = 3600 * 1000;
const EDGE_CASES = [
  // ============================================================
  // הוצאה מהסטטיסטיקה — ארבעה מקרים, ואף אחד מהם אינו קיים בייצור
  // ============================================================
  // ⚠️ ההכרעה: זמן שהוצא **אינו נמדד בכלל** — לא במונה ולא במכנה, בדיוק
  // כמו תחזוקה — אבל כן נספר ב-total_hours כדי שהפס על המסך לא יתקצר
  // בלי הסבר. ארבעת המקרים כאן הם הכיסוי היחיד לכלל הזה.
  {
    name: "תקלה שהוצאה — לא במונה ולא במכנה, וזמינות 100%",
    segments: (f, t) => [
      { status: "ready", started_at: iso(f), ended_at: iso(f + 6 * H) },
      { status: "error", started_at: iso(f + 6 * H), ended_at: iso(f + 8 * H),
        excluded_at: iso(t) },
      { status: "ready", started_at: iso(f + 8 * H), ended_at: iso(t) },
    ],
  },
  {
    // ⚠️ המקרה שמפריד בין "הוצא" לבין "נמחק": אילו ההוצאה הייתה DELETE,
    // total_hours היה זהה לזה של תקלה שלא הייתה — וכאן הוא חייב להיות גדול
    // ממנו בדיוק בשעתיים.
    name: "תקלה שהוצאה — נשארת ב-total_hours ואינה נעלמת",
    segments: (f, t) => [
      { status: "error", started_at: iso(f), ended_at: iso(f + 2 * H),
        excluded_at: iso(t) },
      { status: "ready", started_at: iso(f + 2 * H), ended_at: iso(t) },
    ],
  },
  {
    // ⚠️ הוצאה חלקית: רק חלק מהמקטע נופל בחלון. אם החיתוך ב-CTE `excl`
    // נשמט, השעות היו נספרות במלואן — ואותה שעה הייתה מופיעה פעמיים
    // בשתי תקופות סמוכות.
    name: "תקלה שהוצאה וחוצה את גבול החלון — נחתכת כמו כל מקטע",
    segments: (f, t) => [
      { status: "error", started_at: iso(f - 3 * H), ended_at: iso(f + 3 * H),
        excluded_at: iso(t) },
      { status: "ready", started_at: iso(f + 3 * H), ended_at: iso(t) },
    ],
  },
  {
    // ⚠️ המקרה הכי עדין: המקטע שהוצא נמצא **בין** שני מקטעי ready. הקיפול
    // חייב עדיין לראות אותו, אחרת ה-ready השני נקרא כהמשך של הראשון
    // ומקטע שלם נעלם. סינון לפני הקיפול נופל כאן ורק כאן.
    name: "תקלה שהוצאה בין שני ready — הקיפול עדיין רואה אותה",
    segments: (f, t) => [
      { status: "ready", started_at: iso(f), ended_at: iso(f + 2 * H) },
      { status: "error", started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H),
        excluded_at: iso(t) },
      { status: "no_comm", started_at: iso(f + 3 * H), ended_at: iso(f + 4 * H) },
      { status: "ready", started_at: iso(f + 4 * H), ended_at: iso(t) },
    ],
  },
  {
    name: "מקטע יחיד שעוטף את כל החלון (חוצה את שני הגבולות)",
    segments: (f, t) => [{ status: "ready", started_at: iso(f - 5 * H), ended_at: iso(t + 5 * H) }],
  },
  {
    name: "מקטע פתוח (ended_at NULL) — נמשך עד סוף החלון",
    segments: (f) => [{ status: "operating", started_at: iso(f + 1 * H), ended_at: null }],
  },
  {
    name: "אין מקטעים כלל — אין נתון, לא זמינות אפס",
    segments: () => [],
  },
  {
    name: "תחזוקה בלבד — מוחרגת מהמכנה, measured=0",
    segments: (f, t) => [{ status: "maintenance", started_at: iso(f), ended_at: iso(t) }],
  },
  {
    name: "אתר שנרשם באמצע החלון — לא נענש על זמן שלא היה קיים",
    segments: (f, t) => [{ status: "ready", started_at: iso(f + (t - f) / 2), ended_at: iso(t) }],
  },
  {
    name: "מקטע כולו לפני החלון — לא נספר",
    segments: (f) => [{ status: "error", started_at: iso(f - 10 * H), ended_at: iso(f - 5 * H) }],
  },
  {
    name: "מקטע כולו אחרי החלון — לא נספר",
    segments: (f, t) => [{ status: "error", started_at: iso(t + 5 * H), ended_at: iso(t + 10 * H) }],
  },
  {
    name: "מקטע באורך אפס (start == end)",
    segments: (f) => [{ status: "error", started_at: iso(f + H), ended_at: iso(f + H) }],
  },
  {
    name: "חמשת המצבים יחד",
    segments: (f) => [
      { status: "ready",       started_at: iso(f + 0 * H), ended_at: iso(f + 1 * H) },
      { status: "operating",   started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
      { status: "error",       started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) },
      { status: "maintenance", started_at: iso(f + 3 * H), ended_at: iso(f + 4 * H) },
      { status: "no_comm",     started_at: iso(f + 4 * H), ended_at: iso(f + 5 * H) },
    ],
  },
  {
    name: "מחצית מושבת — הזמינות חייבת לצאת 50%",
    segments: (f) => [
      { status: "ready", started_at: iso(f + 0 * H), ended_at: iso(f + 2 * H) },
      { status: "error", started_at: iso(f + 2 * H), ended_at: iso(f + 4 * H) },
    ],
  },
  {
    // ==========================================================
    // חלון תחזוקה ידני — הכיסוי היחיד שיש לו
    // ==========================================================
    // בייצור יש **אפס** חלונות ידניים, ולכן 1,262 ההשוואות מול נתוני אמת
    // לא נוגעות בכלל הזה. אותו לקח כמו ב-site_globals: מה שהנתונים לא
    // מכילים — הבדיקה עיוורת אליו.
    name: "חלון תחזוקה ידני מוחרג מהמכנה",
    segments: (f, t) => [{ status: "ready", started_at: iso(f), ended_at: iso(t) }],
    windows: (f) => [{ started_at: iso(f), expires_at: iso(f + 12 * H), cancelled_at: null }],
  },
  {
    // שני חלונות חופפים היו נספרים פעמיים, וזמן התחזוקה היה יוצא גדול
    // מהחלון הנמדד. האיחוד לקטעים זרים הוא מה שמונע את זה.
    name: "שני חלונות ידניים חופפים — נספרים פעם אחת",
    segments: (f, t) => [{ status: "ready", started_at: iso(f), ended_at: iso(t) }],
    windows: (f) => [
      { started_at: iso(f),          expires_at: iso(f + 12 * H), cancelled_at: null },
      { started_at: iso(f + 6 * H),  expires_at: iso(f + 18 * H), cancelled_at: null },
    ],
  },
  {
    // חלון שבוטל נגמר ב-cancelled_at ולא ב-expires_at.
    name: "חלון ידני שבוטל — נספר עד רגע הביטול",
    segments: (f, t) => [{ status: "ready", started_at: iso(f), ended_at: iso(t) }],
    windows: (f) => [
      { started_at: iso(f), expires_at: iso(f + 20 * H), cancelled_at: iso(f + 5 * H) },
    ],
  },
  {
    // חלון שחורג משני קצות החלון הנמדד — נחתך, ולא נספר מעבר לו.
    name: "חלון ידני שעוטף את כל התקופה",
    segments: (f, t) => [{ status: "ready", started_at: iso(f), ended_at: iso(t) }],
    windows: (f, t) => [
      { started_at: iso(f - 50 * H), expires_at: iso(t + 50 * H), cancelled_at: null },
    ],
  },
  {
    // תחזוקה ידנית *מעל* מקטע שכבר במצב maintenance — אסור לספור פעמיים.
    name: "חלון ידני מעל מקטע תחזוקה — בלי ספירה כפולה",
    segments: (f, t) => [{ status: "maintenance", started_at: iso(f), ended_at: iso(t) }],
    windows: (f) => [{ started_at: iso(f), expires_at: iso(f + 10 * H), cancelled_at: null }],
  },
  {
    name: "חלון הפוך (to <= from) — אפסים, לא שורה חסרה",
    inverted: true,
    segments: (f) => [{ status: "ready", started_at: iso(f), ended_at: null }],
  },
];

const iso = (ms) => new Date(ms).toISOString();

async function parityEdgeCases() {
  console.log(`\n=== מקרי קצה — ${EDGE_CASES.length} תרחישים (נזרעים ומתגלגלים לאחור) ===`);

  // חלון קבוע ובעבר, כדי שההשוואה לא תלויה ב-now
  const to = Date.parse("2026-06-15T00:00:00.000Z");
  const from = to - 24 * H;

  for (const c of EDGE_CASES) {
    const winFrom = c.inverted ? iso(to) : iso(from);
    const winTo = c.inverted ? iso(from) : iso(to);
    const segments = c.segments(from, to);
    const windows = c.windows ? c.windows(from, to) : [];

    let sqlRow;
    await db.transaction(async () => {
      const site = await db.prepare(
        "INSERT INTO sites (code, site_name, registered_at) VALUES (?, ?, ?) RETURNING id"
      ).run(`PARITY-${Math.abs(hash(c.name))}`, "parity", iso(from - 100 * H));
      const siteId = site.lastInsertRowid;

      for (const s of segments) {
        await db.prepare(
          // ⚠️ excluded_at נזרע כאן כי בייצור **אין ולו שורה אחת** כזו, ולכן
          // 1,533 ההשוואות על נתוני אמת עיוורות לחלוטין לכלל החדש. זה בדיוק
          // מה שקרה כבר עם חלונות התחזוקה הידניים.
          "INSERT INTO status_history (site_id, status, started_at, ended_at, excluded_at, excluded_by)" +
          " VALUES (?, ?, ?, ?, ?, ?)"
        ).run(siteId, s.status, s.started_at, s.ended_at,
              s.excluded_at ?? null, s.excluded_at ? "parity" : null);
      }

      for (const w of windows) {
        await db.prepare(
          `INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours,
                                            expires_at, cancelled_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(siteId, "parity", w.started_at, 0, w.expires_at, w.cancelled_at);
      }

      const rows = await db.prepare(
        "SELECT * FROM public.site_uptime(?, ?, ?)"
      ).all([siteId], winFrom, winTo);
      sqlRow = rows[0];

      // מגלגלים תמיד — הזריעה לא נשמרת
      throw new Rollback();
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

    // צד ה-JS מקבל בדיוק אותם מקטעים
    // windows מפורש ולא מושמט: uptimeFromData קורא אותו ישירות ואינו סלחן
    // בכוונה — קורא אמיתי ששוכח לטעון חלונות צריך לקרוס, ולא להחזיר זמינות
    // מנופחת בשקט. התרחישים כאן הם ללא תחזוקה ידנית, ולכן מפה ריקה.
    const data = {
      segments: new Map([[1, segments.map((s) => ({ ...s, site_id: 1 }))]]),
      windows: new Map([[1, windows.map((w) => ({ ...w, site_id: 1 }))]]),
    };
    const js = uptimeFromData(data, 1, { from: winFrom, to: winTo });

    const before = failures;
    compare(`edge[${c.name}].readyHours`,    js.readyHours,          sqlRow?.ready_hours);
    compare(`edge[${c.name}].errorHours`,    js.errorHours,          sqlRow?.error_hours);
    compare(`edge[${c.name}].maintHours`,    js.maintenanceHours,    sqlRow?.maintenance_hours);
    compare(`edge[${c.name}].totalHours`,    js.totalHours,          sqlRow?.total_hours);
    compare(`edge[${c.name}].measuredHours`, js.measuredHours,       sqlRow?.measured_hours);
    compare(`edge[${c.name}].availability`,  js.availabilityPercent, sqlRow?.availability_percent);
    expectNumber(`edge[${c.name}].availability type`, sqlRow?.availability_percent);

    console.log(`  ${failures === before ? "✓" : "✗"} ${c.name}`);
  }
}

class Rollback extends Error {}
const hash = (s) => [...s].reduce((a, ch) => ((a << 5) - a + ch.charCodeAt(0)) | 0, 0);

// ============================================================
// קיפול ריצוד הנתק
// ============================================================
// JS  — collapseNoCommFlicker על segments הממוינים מ-loadRangeData
// SQL — public.site_segments_collapsed
//
// ⚠️ parity על נתוני פרודקשן **אינו מספיק כאן**, וזה נמדד: בכל ההיסטוריה
// יש 161 רצפי ריצוד, ובאף אחד מהם המצב החוזר אינו 'error'. מכיוון
// ש-statsFromData מסתכל רק על 'error', ההגנה שהקיפול נותן אינה נדרשת
// בפרודקשן — ולכן פורט שבור לגמרי היה עובר. מקרי הקצה למטה הם הבדיקה
// האמיתית, ולכן הם נבדקו גם מול גרסאות שבורות בכוונה.
async function parityFlicker() {
  const sites = await db.prepare("SELECT id, code FROM sites ORDER BY code").all();
  const ids = sites.map((s) => s.id);
  const byId = new Map(sites.map((s) => [s.id, s.code]));

  console.log(`\n=== קיפול ריצוד — ${sites.length} אתרים × week/month/year ===`);

  for (const period of ["week", "month", "year"]) {
    const { range } = resolvePeriod(period);
    const to = new Date().toISOString();

    const { data, sql } = await snapshot(async () => ({
      data: await loadRangeData(null, { from: range.from, to }),
      sql: await db.prepare("SELECT * FROM public.site_segments_collapsed(?, ?, ?)").all(ids, range.from, to),
    }));

    const sqlBySite = new Map();
    for (const r of sql) {
      if (!sqlBySite.has(r.site_id)) sqlBySite.set(r.site_id, []);
      sqlBySite.get(r.site_id).push(r);
    }

    let periodFails = 0, dropped = 0, loaded = 0;
    for (const id of ids) {
      const input = data.segments.get(id) || [];
      const js = collapseNoCommFlicker(input);
      const s = sqlBySite.get(id) || [];
      loaded += input.length;
      dropped += input.length - js.length;

      const before = failures;
      compare(`flicker/${period}/${byId.get(id)}.keptCount`, js.length, s.length);
      // השוואה כקבוצת מזהים — הסדר אינו חלק מהחוזה, הזהות כן
      const jsIds = js.map((r) => r.id).sort((a, b) => a - b).join(",");
      const sqlIds = s.map((r) => r.id).sort((a, b) => a - b).join(",");
      compare(`flicker/${period}/${byId.get(id)}.keptIds`, jsIds, sqlIds);
      if (failures > before) periodFails++;
    }
    console.log(`  ${period.padEnd(6)} — ${sites.length - periodFails}/${sites.length} אתרים תואמים ` +
                `(${loaded} מקטעים נטענו, ${dropped} נקפלו)`);
  }
}

// מקרי הקצה של הקיפול. שני הראשונים הם ה-look-back, ובלעדיו הם נכשלים.
const FLICKER_CASES = [
  {
    name: "look-back: תקלה שהתחילה לפני החלון, נותקה, וחזרה בתוכו — המשך, לא תקלה שנייה",
    // error חוצה את p_from → no_comm → error בתוך החלון.
    // בלי look-back ה-error הראשון אינו נטען, ולכן השני נראה חדש ונשמר.
    segments: (f) => [
      { status: "error",   started_at: iso(f - 2 * H), ended_at: iso(f + 1 * H) },
      { status: "no_comm", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
      { status: "error",   started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) },
    ],
    expectKept: 2,   // error הראשון + no_comm. השני נקפל.
  },
  {
    name: "look-back: אותו רצף אך המצב שונה — ready אחרי error, נשמר",
    segments: (f) => [
      { status: "error",   started_at: iso(f - 2 * H), ended_at: iso(f + 1 * H) },
      { status: "no_comm", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
      { status: "ready",   started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) },
    ],
    expectKept: 3,
  },
  {
    name: "ריצוד כפול: error → no_comm → error → no_comm → error",
    segments: (f) => [
      { status: "error",   started_at: iso(f + 0 * H), ended_at: iso(f + 1 * H) },
      { status: "no_comm", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
      { status: "error",   started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) },
      { status: "no_comm", started_at: iso(f + 3 * H), ended_at: iso(f + 4 * H) },
      { status: "error",   started_at: iso(f + 4 * H), ended_at: iso(f + 5 * H) },
    ],
    expectKept: 3,   // error אחד + שני no_comm
  },
  {
    name: "no_comm נשמר תמיד, גם רצוף",
    segments: (f) => [
      { status: "no_comm", started_at: iso(f + 0 * H), ended_at: iso(f + 1 * H) },
      { status: "no_comm", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
    ],
    expectKept: 2,
  },
  {
    name: "מצבים עוקבים זהים בלי נתק — השני נקפל",
    segments: (f) => [
      { status: "ready", started_at: iso(f + 0 * H), ended_at: iso(f + 1 * H) },
      { status: "ready", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
    ],
    expectKept: 1,
  },
  {
    name: "מצבים מתחלפים — שום דבר לא נקפל",
    segments: (f) => [
      { status: "ready",     started_at: iso(f + 0 * H), ended_at: iso(f + 1 * H) },
      { status: "operating", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
      { status: "error",     started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) },
    ],
    expectKept: 3,
  },
  {
    name: "שובר-שוויון: שני מקטעים באותה שנייה (כמו אתר 2439)",
    segments: (f) => [
      { status: "no_comm",   started_at: iso(f + 1 * H), ended_at: iso(f + 1 * H) },
      { status: "operating", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
    ],
    expectKept: 2,
  },
];

async function parityFlickerEdges() {
  console.log(`\n=== קיפול ריצוד — ${FLICKER_CASES.length} מקרי קצה ===`);
  const to = Date.parse("2026-06-15T00:00:00.000Z");
  const from = to - 24 * H;
  const winFrom = iso(from), winTo = iso(to);

  for (const c of FLICKER_CASES) {
    const segments = c.segments(from, to);
    let sqlRows, jsKept;

    await db.transaction(async () => {
      const site = await db.prepare(
        "INSERT INTO sites (code, site_name, registered_at) VALUES (?, ?, ?) RETURNING id"
      ).run(`FLK-${Math.abs(hash(c.name))}`, "parity-flicker", iso(from - 100 * H));
      const siteId = site.lastInsertRowid;

      const inserted = [];
      for (const s of segments) {
        const r = await db.prepare(
          "INSERT INTO status_history (site_id, status, started_at, ended_at) VALUES (?, ?, ?, ?) RETURNING id"
        ).run(siteId, s.status, s.started_at, s.ended_at);
        inserted.push({ ...s, id: r.lastInsertRowid, site_id: siteId });
      }

      sqlRows = await db.prepare(
        "SELECT * FROM public.site_segments_collapsed(?, ?, ?)"
      ).all([siteId], winFrom, winTo);

      // צד ה-JS: אותו טווח קלט בדיוק כמו ה-SQL (כולל ה-look-back),
      // באותו מיון כמו sortByStartedAt
      const loaded = inserted
        .filter((s) => s.started_at < winTo && (s.ended_at === null || s.ended_at >= winFrom))
        .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.id - b.id));
      jsKept = collapseNoCommFlicker(loaded);

      throw new Rollback();
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

    const before = failures;
    compare(`flickerEdge[${c.name}].keptCount`, jsKept.length, sqlRows.length);
    compare(`flickerEdge[${c.name}].expected`, c.expectKept, sqlRows.length);
    const a = jsKept.map((r) => r.id).sort((x, y) => x - y).join(",");
    const b = sqlRows.map((r) => r.id).sort((x, y) => x - y).join(",");
    compare(`flickerEdge[${c.name}].keptIds`, a, b);

    console.log(`  ${failures === before ? "✓" : "✗"} ${c.name}`);
  }
}

// ============================================================
// פעולות, תקלות ואחוז כשל
// ============================================================
// JS  — loadRangeData + statsFromData
// SQL — public.site_stats
async function parityStats() {
  const sites = await db.prepare("SELECT id, code FROM sites ORDER BY code").all();
  const ids = sites.map((s) => s.id);
  const byId = new Map(sites.map((s) => [s.id, s.code]));

  console.log(`\n=== מדדים — ${sites.length} אתרים × week/month/year ===`);

  for (const period of ["week", "month", "year"]) {
    const { range } = resolvePeriod(period);
    const to = new Date().toISOString();

    const { data, sql } = await snapshot(async () => ({
      data: await loadRangeData(null, { from: range.from, to }),
      sql: await db.prepare("SELECT * FROM public.site_stats(?, ?, ?)").all(ids, range.from, to),
    }));
    const sqlById = new Map(sql.map((r) => [r.site_id, r]));

    let periodFails = 0, totalOps = 0, totalErr = 0;
    for (const id of ids) {
      const js = statsFromData(data, id, { from: range.from, to });
      const s = sqlById.get(id);
      const code = byId.get(id);
      totalOps += js.operations; totalErr += js.errors;

      if (!s) { failures++; checks++; fails.push(`stats/${period}/${code}: SQL no row`); periodFails++; continue; }

      const before = failures;
      compare(`stats/${period}/${code}.operations`,   js.operations,          s.operations);
      compare(`stats/${period}/${code}.errors`,       js.errors,              s.errors);
      compare(`stats/${period}/${code}.errInMaint`,   js.errorsInMaintenance, s.errors_in_maintenance);
      compare(`stats/${period}/${code}.failureRate`,  js.failureRate,         s.failure_rate);
      // ⚠️ זמן הטיפול נכנס להשוואה כמו כל שדה אחר. שדה שקיים בשתי הזרועות
      // ואינו מושווה הוא בדיוק החור ש-parity-shape נבנה בשבילו — שם זה היה
      // trend, וכאן היה יכול להיות ההבדל בין ממוצע על מקטעים סגורים לבין
      // ממוצע על כולם.
      compare(`stats/${period}/${code}.avgRepair`,    js.avgRepairMinutes,    s.avg_repair_minutes);
      compare(`stats/${period}/${code}.medRepair`,    js.medianRepairMinutes, s.median_repair_minutes);
      compare(`stats/${period}/${code}.longCount`,    js.longRepairCount,     s.long_repair_count);
      compare(`stats/${period}/${code}.longPct`,      js.longRepairPercent,   s.long_repair_percent);
      compare(`stats/${period}/${code}.quickCount`,   js.quickRepairCount,    s.quick_repair_count);
      compare(`stats/${period}/${code}.medCount`,     js.mediumRepairCount,   s.medium_repair_count);
      // ⚠️ מערך מושווה כמחרוזת: `compare` בנוי לסקלרים, ושני מערכים
      // שווי-ערך אינם `===`. השוואת אורך בלבד הייתה מפספסת סדר שונה —
      // וסדר הוא בדיוק מה שהגרף מציג.
      compare(`stats/${period}/${code}.repairSeries`,
        JSON.stringify(js.repairSeries), JSON.stringify(s.repair_minutes));
      expectNumber(`stats/${period}/${code}.failureRate type`, s.failure_rate);
      expectNumber(`stats/${period}/${code}.operations type`,   s.operations);
      if (failures > before) periodFails++;
    }
    console.log(`  ${period.padEnd(6)} — ${sites.length - periodFails}/${sites.length} אתרים תואמים ` +
                `(${totalOps} פעולות, ${totalErr} תקלות)`);
  }
}

// ============================================================
// אחוז כשל משוקלל — סך תקלות ÷ סך פעולות
// ============================================================
// **לא** ממוצע של אחוזים. אתר עם 2 פעולות ותקלה אחת אינו שווה במשקל לאתר
// עם 2,000. הפער בפרודקשן קטן היום רק כי גדלי האתרים דומים (4–55 פעולות),
// ולכן נבדק גם על תרחיש זרוע עם אתר זעיר ורועש — שם ההבדל בין משוקלל
// ללא-משוקלל הוא הבדל של אחוזים שלמים.
async function parityWeighted() {
  const sites = await db.prepare("SELECT id, code FROM sites ORDER BY code").all();
  const ids = sites.map((s) => s.id);

  console.log(`\n=== אחוז כשל משוקלל ===`);
  for (const period of ["week", "month", "year"]) {
    const { range } = resolvePeriod(period);
    const to = new Date().toISOString();

    // ⚠️ גם כאן צילום אחד. זו הייתה ההשוואה היחידה שנשארה מחוץ לו אחרי
    // התיקון, והיא המשיכה לרצד — אותו מרוץ בדיוק, רק במקום אחר.
    const { data, row } = await snapshot(async () => ({
      data: await loadRangeData(null, { from: range.from, to }),
      row: (await db.prepare(
        `SELECT CASE WHEN SUM(operations) > 0
                  THEN ROUND((SUM(errors)::numeric / SUM(operations)) * 100, 2)::double precision
                  ELSE 0::double precision END AS weighted,
                SUM(operations)::int AS ops, SUM(errors)::int AS errs
           FROM public.site_stats(?, ?, ?)`
      ).all(ids, range.from, to))[0],
    }));

    let sumOps = 0, sumErr = 0;
    for (const id of ids) {
      const js = statsFromData(data, id, { from: range.from, to });
      sumOps += js.operations; sumErr += js.errors;
    }
    const jsWeighted = sumOps > 0 ? Math.round((sumErr / sumOps) * 10000) / 100 : 0;

    compare(`weighted/${period}.rate`, jsWeighted, row.weighted);
    compare(`weighted/${period}.sumOps`, sumOps, row.ops);
    compare(`weighted/${period}.sumErrors`, sumErr, row.errs);
    expectNumber(`weighted/${period}.rate type`, row.weighted);

    const unweighted = ids.length
      ? Math.round((ids.reduce((acc, id) => {
          const st = statsFromData(data, id, { from: range.from, to });
          return acc + (st.operations > 0 ? (st.errors / st.operations) * 100 : 0);
        }, 0) / ids.length) * 100) / 100
      : 0;
    console.log(`  ${period.padEnd(6)} — משוקלל ${row.weighted}%  (${row.errs}/${row.ops})` +
                `   [לא-משוקלל היה ${unweighted}%]`);
  }
}

// מקרי הקצה של המדדים. פרודקשן אינו מכיל אף תקלה בתחזוקה ואף ריצוד-error,
// ולכן כל מסלול ההחרגה והקיפול נבדק כאן בלבד.
const STATS_CASES = [
  {
    name: "תקלה פשוטה בתוך החלון",
    segments: (f) => [{ status: "error", started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) }],
    ops: (f) => [{ occurred_at: iso(f + 1 * H), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 1, errors: 1, errors_in_maintenance: 0, failure_rate: 100 },
  },
  {
    // ⚠️ **operations: 0 ולא 1** — והשינוי הזה הוא הכרעה, לא תיקון.
    // בתחזוקה מהבקר ה-MODE הוא 0 ולכן אין פעולות כלל; חלון ידני מתנהג
    // עכשיו אותו דבר, ולכן פעולה בתוך החלון אינה שירות ואינה נספרת.
    // ראה app.op_served ב-SQL ו-opsOf ב-shared/executive.mjs.
    name: "תקלה בתוך חלון תחזוקה ידני — מוחרגת",
    segments: (f) => [{ status: "error", started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) }],
    windows: (f) => [{ started_at: iso(f + 1 * H), expires_at: iso(f + 5 * H), cancelled_at: null }],
    ops: (f) => [{ occurred_at: iso(f + 1 * H), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 0, errors: 0, errors_in_maintenance: 1, failure_rate: 0 },
  },
  {
    // ⚠️ הגבול חצי-פתוח: פעולה **ברגע** שהחלון נגמר היא כבר שירות.
    // בלי זה כל חלון היה בולע גם את הפעולה הראשונה שאחריו.
    name: "פעולה בדיוק בסיום החלון — נספרת",
    segments: () => [],
    windows: (f) => [{ started_at: iso(f + 1 * H), expires_at: iso(f + 2 * H), cancelled_at: null }],
    ops: (f) => [{ occurred_at: iso(f + 2 * H), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 1, errors: 0, errors_in_maintenance: 0, failure_rate: 0 },
  },
  {
    // ⚠️ חלון שסומן כניסוי אינו מכסה דבר — גם לא פעולות.
    name: "פעולה בתוך חלון שסומן כניסוי — נספרת",
    segments: () => [],
    windows: (f) => [{ started_at: iso(f + 1 * H), expires_at: iso(f + 5 * H), cancelled_at: null, excluded_at: iso(f + 6 * H) }],
    ops: (f) => [{ occurred_at: iso(f + 2 * H), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 1, errors: 0, errors_in_maintenance: 0, failure_rate: 0 },
  },
  {
    name: "תקלה בתוך מקטע תחזוקה של ה-PLC — מוחרגת",
    segments: (f) => [
      { status: "maintenance", started_at: iso(f + 1 * H), ended_at: iso(f + 4 * H) },
      { status: "error",       started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) },
    ],
    ops: (f) => [{ occurred_at: iso(f + 1 * H), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 1, errors: 0, errors_in_maintenance: 1, failure_rate: 0 },
  },
  {
    name: "תקלה בדיוק בגבול סיום התחזוקה — מוחרגת (גבול כולל)",
    segments: (f) => [
      { status: "maintenance", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
      { status: "error",       started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) },
    ],
    ops: (f) => [{ occurred_at: iso(f + 1 * H), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 1, errors: 0, errors_in_maintenance: 1, failure_rate: 0 },
  },
  {
    name: "ריצוד: error → no_comm → error — תקלה אחת, לא שתיים",
    segments: (f) => [
      { status: "error",   started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
      { status: "no_comm", started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) },
      { status: "error",   started_at: iso(f + 3 * H), ended_at: iso(f + 4 * H) },
    ],
    ops: (f) => [{ occurred_at: iso(f + 1 * H), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 1, errors: 1, errors_in_maintenance: 0, failure_rate: 100 },
  },
  {
    name: "look-back: תקלה שחוצה את p_from וחוזרת — לא נספרת פעמיים ולא בכלל",
    // הראשונה התחילה לפני החלון (לא נספרת — אינה תקלה *של* החלון),
    // השנייה נקפלת כהמשך. סה\"כ 0.
    segments: (f) => [
      { status: "error",   started_at: iso(f - 2 * H), ended_at: iso(f + 1 * H) },
      { status: "no_comm", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) },
      { status: "error",   started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) },
    ],
    ops: (f) => [{ occurred_at: iso(f + 1 * H), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 1, errors: 0, errors_in_maintenance: 0, failure_rate: 0 },
  },
  {
    name: "פעולות: is_anomaly=1 ו-start_end='start' אינן נספרות",
    segments: () => [],
    ops: (f) => [
      { occurred_at: iso(f + 1 * H), start_end: "end",   is_anomaly: 0 },
      { occurred_at: iso(f + 2 * H), start_end: "end",   is_anomaly: 1 },
      { occurred_at: iso(f + 3 * H), start_end: "start", is_anomaly: 0 },
    ],
    expect: { operations: 1, errors: 0, errors_in_maintenance: 0, failure_rate: 0 },
  },
  {
    name: "אפס פעולות עם תקלה — אחוז כשל 0, בלי חלוקה באפס",
    segments: (f) => [{ status: "error", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) }],
    ops: () => [],
    expect: { operations: 0, errors: 1, errors_in_maintenance: 0, failure_rate: 0 },
  },
  {
    name: "גבולות החלון: פעולה ותקלה בדיוק ב-p_from נספרות",
    segments: (f) => [{ status: "error", started_at: iso(f), ended_at: iso(f + 1 * H) }],
    ops: (f) => [{ occurred_at: iso(f), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 1, errors: 1, errors_in_maintenance: 0, failure_rate: 100 },
  },
  {
    name: "גבולות החלון: פעולה ותקלה בדיוק ב-p_to אינן נספרות",
    segments: (f, t) => [{ status: "error", started_at: iso(t), ended_at: iso(t + 1 * H) }],
    ops: (f, t) => [{ occurred_at: iso(t), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 0, errors: 0, errors_in_maintenance: 0, failure_rate: 0 },
  },
  {
    name: "עיגול: 1 תקלה מתוך 3 פעולות = 33.33%",
    segments: (f) => [{ status: "error", started_at: iso(f + 1 * H), ended_at: iso(f + 2 * H) }],
    ops: (f) => [
      { occurred_at: iso(f + 1 * H), start_end: "end", is_anomaly: 0 },
      { occurred_at: iso(f + 2 * H), start_end: "end", is_anomaly: 0 },
      { occurred_at: iso(f + 3 * H), start_end: "end", is_anomaly: 0 },
    ],
    expect: { operations: 3, errors: 1, errors_in_maintenance: 0, failure_rate: 33.33 },
  },
];

async function parityStatsEdges() {
  console.log(`\n=== מדדים — ${STATS_CASES.length} מקרי קצה ===`);
  const to = Date.parse("2026-06-15T00:00:00.000Z");
  const from = to - 24 * H;
  const winFrom = iso(from), winTo = iso(to);

  for (const c of STATS_CASES) {
    const segments = (c.segments || (() => []))(from, to);
    const ops = (c.ops || (() => []))(from, to);
    const windows = (c.windows || (() => []))(from, to);
    let sqlRow, jsRow;

    await db.transaction(async () => {
      const site = await db.prepare(
        "INSERT INTO sites (code, site_name, registered_at) VALUES (?, ?, ?) RETURNING id"
      ).run(`ST-${Math.abs(hash(c.name))}`, "parity-stats", iso(from - 100 * H));
      const siteId = site.lastInsertRowid;

      for (const s of segments) {
        await db.prepare(
          "INSERT INTO status_history (site_id, status, started_at, ended_at) VALUES (?, ?, ?, ?)"
        ).run(siteId, s.status, s.started_at, s.ended_at);
      }
      for (const o of ops) {
        await db.prepare(
          `INSERT INTO operations (site_id, start_end, entry_exit, card_number, state, is_anomaly,
                                   occurred_at, received_at, reported_at)
           VALUES (?, ?, 'entry', '', 'operating', ?, ?, ?, ?)`
        ).run(siteId, o.start_end, o.is_anomaly, o.occurred_at, o.occurred_at, o.occurred_at);
      }
      for (const w of windows) {
        await db.prepare(
          `INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at, cancelled_at, excluded_at)
           VALUES (?, 'parity', ?, ?, ?, ?, ?)`
        ).run(siteId, w.started_at, 4, w.expires_at, w.cancelled_at, w.excluded_at ?? null);
      }

      [sqlRow] = await db.prepare("SELECT * FROM public.site_stats(?, ?, ?)")
        .all([siteId], winFrom, winTo);

      // צד ה-JS דרך המסלול האמיתי — loadRangeData רואה את שורות הטרנזקציה
      const data = await loadRangeData([siteId], { from: winFrom, to: winTo });
      jsRow = statsFromData(data, siteId, { from: winFrom, to: winTo });

      throw new Rollback();
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

    const before = failures;
    compare(`statsEdge[${c.name}].operations`,  jsRow.operations,          sqlRow.operations);
    compare(`statsEdge[${c.name}].errors`,      jsRow.errors,              sqlRow.errors);
    compare(`statsEdge[${c.name}].errInMaint`,  jsRow.errorsInMaintenance, sqlRow.errors_in_maintenance);
    compare(`statsEdge[${c.name}].failureRate`, jsRow.failureRate,         sqlRow.failure_rate);
    // וגם מול הציפייה המוצהרת — כדי שגם JS *וגם* SQL ייתפסו אם שניהם טועים
    compare(`statsEdge[${c.name}].EXPECT.operations`,  c.expect.operations,            sqlRow.operations);
    compare(`statsEdge[${c.name}].EXPECT.errors`,      c.expect.errors,                sqlRow.errors);
    compare(`statsEdge[${c.name}].EXPECT.errInMaint`,  c.expect.errors_in_maintenance, sqlRow.errors_in_maintenance);
    compare(`statsEdge[${c.name}].EXPECT.failureRate`, c.expect.failure_rate,          sqlRow.failure_rate);

    console.log(`  ${failures === before ? "✓" : "✗"} ${c.name}`);
  }
}


// ============================================================
// הבדיקה: נתונים גלובליים (site_globals מול getAllSitesGlobals)
// ============================================================
// זו הפונקציה שחסמה את המעבר של הדשבורד לקריאה ישירה, ולכן היא נבדקת
// בשתי צורות הקריאה: null (כל האתרים) ורשימת מזהים מפורשת. שתיהן חייבות
// להסכים — קריאה עם רשימה היא מה שהדשבורד יעשה בפועל.
async function parityGlobals() {
  console.log("\n=== נתונים גלובליים ===");

  const sites = await db.prepare("SELECT id, code FROM sites ORDER BY id").all();
  const ids = sites.map((s) => s.id);
  const byId = new Map(sites.map((s) => [s.id, s.code]));

  for (const [mode, arg] of [["all", null], ["explicit", ids]]) {
    const { js, rows } = await snapshot(async () => ({
      js: await getAllSitesGlobals(arg),
      rows: await db.prepare("SELECT * FROM site_globals(?)").all(arg),
    }));
    const sql = new Map(rows.map((r) => [r.site_id, r]));

    compare(`globals[${mode}].siteCount`, js.size, sql.size);

    for (const id of ids) {
      const j = js.get(id), s = sql.get(id), c = byId.get(id);
      if (!j || !s) { compare(`globals[${mode}]/${c}.present`, Boolean(j), Boolean(s)); continue; }

      compare(`globals[${mode}]/${c}.lastFaultAt`,   j.lastFaultAt,   s.last_fault_at);
      compare(`globals[${mode}]/${c}.firstStatusAt`, j.firstStatusAt, s.first_status_at);
      compare(`globals[${mode}]/${c}.statusSince`,   j.statusSince,   s.status_since);
      // ⚠️ הכלל שמאחוריו עדין: התיאור שורד את המעבר לטיפול, וההתאמה היא
      // על ended_at = started_at בדיוק. שני צדדים שיפרשו אותו אחרת יציגו
      // תיאור אחר לאותו אתר בשני מצבי המתג.
      compare(`globals[${mode}]/${c}.currentFaultText`, j.currentFaultText ?? null, s.current_fault_text ?? null);
      compare(`globals[${mode}]/${c}.opsSinceError`, j.operationsSinceLastError, s.operations_since_last_error);

      // הפעולה האחרונה — ארבעת השדות בנפרד. השוואת האובייקט כמחרוזת הייתה
      // מסתירה איזה שדה נשבר.
      const jo = j.lastOperation;
      compare(`globals[${mode}]/${c}.lastOp.startEnd`,   jo?.start_end   ?? null, s.last_op_start_end);
      compare(`globals[${mode}]/${c}.lastOp.entryExit`,  jo?.entry_exit  ?? null, s.last_op_entry_exit);
      compare(`globals[${mode}]/${c}.lastOp.card`,       jo?.card_number ?? null, s.last_op_card_number);
      compare(`globals[${mode}]/${c}.lastOp.occurredAt`, jo?.occurred_at ?? null, s.last_op_occurred_at);

      const jm = j.activeMaintenance;
      compare(`globals[${mode}]/${c}.maint.id`,      jm?.id             ?? null, s.maintenance_id);
      compare(`globals[${mode}]/${c}.maint.name`,    jm?.set_by_name    ?? null, s.maintenance_set_by_name);
      compare(`globals[${mode}]/${c}.maint.expires`, jm?.expires_at     ?? null, s.maintenance_expires_at);
      compare(`globals[${mode}]/${c}.maint.hours`,   jm?.duration_hours ?? null, s.maintenance_duration_hours);
    }
    console.log(`  ${mode.padEnd(9)} — ${ids.length} אתרים הושוו`);
  }
}

// ============================================================
// מקרי קצה לנתונים הגלובליים — נזרעים, כי הייצור לא מכיל אותם
// ============================================================
// ארבע מוטציות הורצו מול נתוני הייצור בלבד, ורק אחת נתפסה. הסיבה אינה
// שהפורט נכון אלא שהנתונים לא מכילים את המקרים: לכל אתר בייצור יש תקלה
// כלשהי, אין שתי פעולות באותה שנייה, ואין תחזוקה מבוטלת. שלוש הבדיקות
// האלה היו עיוורות לחלוטין. כל תרחיש כאן קיים כדי לתפוס מוטציה מסוימת,
// ותוצאות המוטציות מתועדות ב-master/CLAUDE.md.
const GLOBAL_EDGES = [
  {
    // תופס מוטציה A: LEFT JOIN → INNER בספירת הפעולות מאז התקלה. אתר
    // שמעולם לא נכשל צריך לספור את **כל** פעולותיו, ולא אפס.
    name: "אתר שמעולם לא נכשל",
    segments: (t) => [{ status: "ready", started_at: iso(t - 10 * H), ended_at: null }],
    operations: (t) => [
      { start_end: "end", entry_exit: "entry", card_number: "A1", occurred_at: iso(t - 5 * H) },
      { start_end: "end", entry_exit: "exit",  card_number: "A2", occurred_at: iso(t - 4 * H) },
    ],
  },
  {
    // ============================================================
    // התרחיש שמוטציה A דרשה, והראשון לא סיפק
    // ============================================================
    // "אתר שמעולם לא נכשל" *לא* תפס את LEFT JOIN → INNER, ובצדק: יש לו
    // מקטעי מצב, ולכן ה-CTE של התקלות מחזיר עבורו שורה (עם NULL בתקלה),
    // וה-INNER מוצא אותה. השניים שקולים שם.
    //
    // ההפרש מתגלה רק כשאין **שום** שורת status_history: אז ל-CTE אין שורה
    // בכלל, INNER זורק את כל הפעולות, והספירה יוצאת 0 במקום המספר האמיתי.
    // זה קורה באמת — פעולות שהגיעו לפני הודעת המצב הראשונה.
    name: "פעולות בלי שום היסטוריית מצב",
    segments: () => [],
    operations: (t) => [
      { start_end: "end", entry_exit: "entry", card_number: "N1", occurred_at: iso(t - 5 * H) },
      { start_end: "end", entry_exit: "exit",  card_number: "N2", occurred_at: iso(t - 4 * H) },
      { start_end: "end", entry_exit: "entry", card_number: "N3", occurred_at: iso(t - 3 * H) },
    ],
  },
  {
    // תופס מוטציה B: הסרת שובר השוויון על id. שתי פעולות באותה שנייה
    // בדיוק — בלי ORDER BY id הבחירה ביניהן שרירותית.
    name: "שתי פעולות באותה שנייה",
    segments: (t) => [{ status: "ready", started_at: iso(t - 10 * H), ended_at: null }],
    operations: (t) => [
      { start_end: "end", entry_exit: "entry", card_number: "FIRST",  occurred_at: iso(t - 2 * H) },
      { start_end: "end", entry_exit: "exit",  card_number: "SECOND", occurred_at: iso(t - 2 * H) },
    ],
  },
  {
    // תופס מוטציה C: התעלמות מ-cancelled_at. החלון עוד בתוקף אבל בוטל
    // ידנית, ולכן חייב לחזור null — אחרת אתר פעיל ייראה מושבת.
    name: "תחזוקה שבוטלה אך טרם פגה",
    segments: (t) => [{ status: "ready", started_at: iso(t - 10 * H), ended_at: null }],
    operations: () => [],
    maintenance: (t) => [
      { set_by_name: "נעמה", started_at: iso(t - 3 * H), duration_hours: 24,
        expires_at: iso(t + 21 * H), cancelled_at: iso(t - 1 * H) },
    ],
  },
  {
    // חלון שפג — גם הוא לא אמור לחזור.
    name: "תחזוקה שפגה",
    segments: (t) => [{ status: "ready", started_at: iso(t - 10 * H), ended_at: null }],
    operations: () => [],
    maintenance: (t) => [
      { set_by_name: "נעמה", started_at: iso(t - 30 * H), duration_hours: 2,
        expires_at: iso(t - 28 * H), cancelled_at: null },
    ],
  },
  {
    // שני חלונות פעילים — נבחר זה עם expires_at המאוחר.
    name: "שני חלונות פעילים",
    segments: (t) => [{ status: "ready", started_at: iso(t - 10 * H), ended_at: null }],
    operations: () => [],
    maintenance: (t) => [
      { set_by_name: "קצר",  started_at: iso(t - 2 * H), duration_hours: 4,
        expires_at: iso(t + 2 * H),  cancelled_at: null },
      { set_by_name: "ארוך", started_at: iso(t - 2 * H), duration_hours: 48,
        expires_at: iso(t + 46 * H), cancelled_at: null },
    ],
  },
  {
    // תופס מוטציה D: הסרת COALESCE. אתר בלי שום פעולה — 0 ולא NULL.
    name: "אתר בלי פעולות כלל",
    segments: (t) => [{ status: "ready", started_at: iso(t - 10 * H), ended_at: null }],
    operations: () => [],
  },
  {
    // אתר שנרשם ועוד לא דיווח דבר. חייב לקבל שורה — ב-JS זה at() שיוצר
    // רשומה ריקה, וב-SQL זה ids כנהג.
    name: "אתר ריק לגמרי",
    segments: () => [],
    operations: () => [],
  },
  {
    // פעולות משני צדי התקלה — רק המאוחרות נספרות.
    name: "פעולות משני צדי התקלה",
    segments: (t) => [
      { status: "ready", started_at: iso(t - 20 * H), ended_at: iso(t - 12 * H) },
      { status: "error", started_at: iso(t - 12 * H), ended_at: iso(t - 11 * H) },
      { status: "ready", started_at: iso(t - 11 * H), ended_at: null },
    ],
    operations: (t) => [
      { start_end: "end", entry_exit: "entry", card_number: "BEFORE", occurred_at: iso(t - 15 * H) },
      { start_end: "end", entry_exit: "exit",  card_number: "AFTER1", occurred_at: iso(t - 9 * H) },
      { start_end: "end", entry_exit: "entry", card_number: "AFTER2", occurred_at: iso(t - 8 * H) },
    ],
  },
  {
    // אנומליות ו-start אינן נספרות — אותו כלל בדיוק כמו ב-JS.
    name: "אנומליה ו-start לא נספרות",
    segments: (t) => [{ status: "ready", started_at: iso(t - 10 * H), ended_at: null }],
    operations: (t) => [
      { start_end: "end",   entry_exit: "entry", card_number: "OK",   occurred_at: iso(t - 5 * H) },
      { start_end: "start", entry_exit: "entry", card_number: "STRT", occurred_at: iso(t - 4 * H) },
      { start_end: "end",   entry_exit: "exit",  card_number: "ANOM", occurred_at: iso(t - 3 * H), is_anomaly: 1 },
    ],
  },
];

async function parityGlobalsEdges() {
  console.log("\n=== מקרי קצה גלובליים — " + GLOBAL_EDGES.length + " תרחישים ===");
  const now = Date.now();

  for (const c of GLOBAL_EDGES) {
    const before = failures;

    // שני הצדדים רצים **בתוך אותה טרנזקציה** על אותם נתונים זרועים, ואז
    // הכול מתגלגל לאחור. זה מה שמאפשר להשוות את getAllSitesGlobals, שהוא
    // עצמו פונה לבסיס הנתונים ואינו פונקציה טהורה כמו uptimeFromData.
    await db.transaction(async () => {
      const site = await db.prepare(
        "INSERT INTO sites (code, site_name, registered_at) VALUES (?, ?, ?) RETURNING id"
      ).run("PG-" + Math.abs(hash(c.name)), "parity-globals", iso(now - 500 * H));
      const id = site.lastInsertRowid;

      for (const s of c.segments(now)) {
        await db.prepare(
          "INSERT INTO status_history (site_id, status, started_at, ended_at) VALUES (?, ?, ?, ?)"
        ).run(id, s.status, s.started_at, s.ended_at);
      }
      for (const o of (c.operations ? c.operations(now) : [])) {
        await db.prepare(
          "INSERT INTO operations (site_id, start_end, entry_exit, card_number, state, is_anomaly, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(id, o.start_end, o.entry_exit, o.card_number, "ready", o.is_anomaly || 0, o.occurred_at, o.occurred_at);
      }
      for (const m of (c.maintenance ? c.maintenance(now) : [])) {
        await db.prepare(
          "INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at, cancelled_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(id, m.set_by_name, m.started_at, m.duration_hours, m.expires_at, m.cancelled_at);
      }

      const js = (await getAllSitesGlobals([id])).get(id);
      const sql = (await db.prepare("SELECT * FROM site_globals(?)").all([id]))[0];
      const n = c.name;

      compare("gedge[" + n + "].present",       Boolean(js), Boolean(sql));
      compare("gedge[" + n + "].lastFaultAt",   js?.lastFaultAt   ?? null, sql?.last_fault_at   ?? null);
      compare("gedge[" + n + "].firstStatusAt", js?.firstStatusAt ?? null, sql?.first_status_at ?? null);
      compare("gedge[" + n + "].statusSince",   js?.statusSince   ?? null, sql?.status_since    ?? null);
      compare("gedge[" + n + "].currentFaultText", js?.currentFaultText ?? null, sql?.current_fault_text ?? null);
      compare("gedge[" + n + "].opsSinceError", js?.operationsSinceLastError ?? null, sql?.operations_since_last_error ?? null);
      compare("gedge[" + n + "].lastOp.card",   js?.lastOperation?.card_number ?? null, sql?.last_op_card_number ?? null);
      compare("gedge[" + n + "].lastOp.at",     js?.lastOperation?.occurred_at ?? null, sql?.last_op_occurred_at ?? null);
      compare("gedge[" + n + "].maint.name",    js?.activeMaintenance?.set_by_name ?? null, sql?.maintenance_set_by_name ?? null);
      compare("gedge[" + n + "].maint.expires", js?.activeMaintenance?.expires_at  ?? null, sql?.maintenance_expires_at  ?? null);

      throw new Rollback();
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

    console.log("  " + (failures === before ? "✓" : "✗") + " " + c.name);
  }
}

// ============================================================
// recent_errors — התקלות האחרונות
// ============================================================
// נוספה כדי שמסך הבקרה ייקרא ישירות מהדשבורד. היא **לא** מדד מצטבר אלא
// רשימה, ולכן ההשוואה היא על הזהות והסדר של השורות ולא על סכום — שורה
// שנופלת מהרשימה בצד אחד היא בדיוק סוג ההבדל שסכום היה מחביא.
//
// ⚠️ הכלל הקריטי כאן הוא "תחזוקה גוברת": תקלה שהתחילה בתוך תחזוקה או בגבולה
// אינה מוצגת, ושני המקורות (מקטע PLC + חלון ידני) חייבים להיבדק. אם רק אחד
// ייבדק, אותה תקלה תיעלם ממדד אחד ותופיע במסך אחר.
async function parityRecentErrors() {
  console.log(`\n=== תקלות אחרונות ===`);

  const { js, sql } = await snapshot(async () => ({
    js: await getRecentErrors({ limit: 10 }),
    sql: await db.prepare("SELECT * FROM public.recent_errors(10)").all(),
  }));

  compare("recentErrors.count", js.length, sql.length);

  for (let i = 0; i < Math.min(js.length, sql.length); i++) {
    const a = js[i], b = sql[i];
    compare(`recentErrors[${i}].site`, a.siteCode, b.site_code);
    compare(`recentErrors[${i}].startedAt`, a.startedAt, b.started_at);
    compare(`recentErrors[${i}].ongoing`, a.ongoing, b.ongoing);

    // תקלה שעדיין פתוחה נמדדת מול now() בשני הצדדים, בשבריר שנייה שונה.
    // ⚠️ הסבילות חלה **רק** על תקלה פתוחה: על תקלה סגורה שני הצדדים קוראים
    // את אותם שני חותמים, וכל הפרש שם הוא באג באריתמטיקה.
    if (a.ongoing) {
      const gap = Math.abs(a.durationSeconds - Math.round(b.duration_seconds));
      compare(`recentErrors[${i}].duration~`, gap <= 2, true);
    } else {
      compare(`recentErrors[${i}].duration`, a.durationSeconds, Math.round(b.duration_seconds));
    }
  }
}

// ===== main =====
const SUITES = {
  uptime: async () => { await parityUptime(); await parityEdgeCases(); },
  flicker: async () => { await parityFlicker(); await parityFlickerEdges(); },
  stats: async () => { await parityStats(); await parityStatsEdges(); },
  weighted: async () => { await parityWeighted(); },
  globals: async () => { await parityGlobals(); await parityGlobalsEdges(); },
  errors: async () => { await parityRecentErrors(); },
};

(async () => {
  await db.init();
  const only = process.argv[2];
  const names = only ? [only] : Object.keys(SUITES);

  for (const n of names) {
    if (!SUITES[n]) {
      console.error(`parity: אין בדיקה בשם "${n}". קיימות: ${Object.keys(SUITES).join(", ")}`);
      process.exit(1);
    }
    await SUITES[n]();
  }

  console.log(`\n${"=".repeat(60)}`);
  if (failures === 0) {
    console.log(`✅ PARITY נקי — ${checks} השוואות, 0 הבדלים`);
    // מוצג תמיד ולא נבלע: תיקו הוא מידע, וקפיצה במספרם היא סימן לבדוק.
    if (ties) {
      console.log(`   (${ties} תיקו-עיגול על גבול .005 — הערך הגולמי זהה בשני הצדדים)`);
      for (const t of tieList.slice(0, 5)) console.log(`     ${t}`);
    }
  } else {
    console.log(`❌ ${failures} הבדלים מתוך ${checks} השוואות:\n`);
    for (const f of fails.slice(0, 40)) console.log(`   ${f}`);
    if (fails.length > 40) console.log(`   … ועוד ${fails.length - 40}`);
  }
  await db.close?.();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("parity: נפל —", e); process.exit(1); });
