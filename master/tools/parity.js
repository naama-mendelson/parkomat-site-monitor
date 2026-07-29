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
const { loadRangeData, uptimeFromData } = require("../db/queries");
const { resolvePeriod } = require("../api/periods");

// ===== דיווח =====
let checks = 0, failures = 0;
const fails = [];

function compare(label, expected, actual) {
  checks++;
  const same = expected === actual
    || (typeof expected === "number" && typeof actual === "number"
        && Number.isFinite(expected) && Number.isFinite(actual)
        && Math.abs(expected - actual) < 1e-9);
  if (!same) {
    failures++;
    fails.push(`${label}: JS=${JSON.stringify(expected)} SQL=${JSON.stringify(actual)}`);
  }
  return same;
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

    const data = await loadRangeData(null, { from: range.from, to });
    const sql = await db.prepare(
      "SELECT * FROM public.site_uptime(?, ?, ?)"
    ).all(ids, range.from, to);
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

    let sqlRow;
    await db.transaction(async () => {
      const site = await db.prepare(
        "INSERT INTO sites (code, site_name, registered_at) VALUES (?, ?, ?) RETURNING id"
      ).run(`PARITY-${Math.abs(hash(c.name))}`, "parity", iso(from - 100 * H));
      const siteId = site.lastInsertRowid;

      for (const s of segments) {
        await db.prepare(
          "INSERT INTO status_history (site_id, status, started_at, ended_at) VALUES (?, ?, ?, ?)"
        ).run(siteId, s.status, s.started_at, s.ended_at);
      }

      const rows = await db.prepare(
        "SELECT * FROM public.site_uptime(?, ?, ?)"
      ).all([siteId], winFrom, winTo);
      sqlRow = rows[0];

      // מגלגלים תמיד — הזריעה לא נשמרת
      throw new Rollback();
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

    // צד ה-JS מקבל בדיוק אותם מקטעים
    const data = { segments: new Map([[1, segments.map((s) => ({ ...s, site_id: 1 }))]]) };
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

// ===== main =====
const SUITES = { uptime: async () => { await parityUptime(); await parityEdgeCases(); } };

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
  } else {
    console.log(`❌ ${failures} הבדלים מתוך ${checks} השוואות:\n`);
    for (const f of fails.slice(0, 40)) console.log(`   ${f}`);
    if (fails.length > 40) console.log(`   … ועוד ${fails.length - 40}`);
  }
  await db.close?.();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("parity: נפל —", e); process.exit(1); });
