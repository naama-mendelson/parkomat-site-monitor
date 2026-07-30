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
const { loadRangeData, uptimeFromData, collapseNoCommFlicker, statsFromData } = require("../db/queries");
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

    const data = await loadRangeData(null, { from: range.from, to });
    const sql = await db.prepare(
      "SELECT * FROM public.site_segments_collapsed(?, ?, ?)"
    ).all(ids, range.from, to);

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

    const data = await loadRangeData(null, { from: range.from, to });
    const sql = await db.prepare(
      "SELECT * FROM public.site_stats(?, ?, ?)"
    ).all(ids, range.from, to);
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

    const data = await loadRangeData(null, { from: range.from, to });
    let sumOps = 0, sumErr = 0;
    for (const id of ids) {
      const js = statsFromData(data, id, { from: range.from, to });
      sumOps += js.operations; sumErr += js.errors;
    }
    const jsWeighted = sumOps > 0 ? Math.round((sumErr / sumOps) * 10000) / 100 : 0;

    const [row] = await db.prepare(
      `SELECT CASE WHEN SUM(operations) > 0
                THEN ROUND((SUM(errors)::numeric / SUM(operations)) * 100, 2)::double precision
                ELSE 0::double precision END AS weighted,
              SUM(operations)::int AS ops, SUM(errors)::int AS errs
         FROM public.site_stats(?, ?, ?)`
    ).all(ids, range.from, to);

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
    name: "תקלה בתוך חלון תחזוקה ידני — מוחרגת",
    segments: (f) => [{ status: "error", started_at: iso(f + 2 * H), ended_at: iso(f + 3 * H) }],
    windows: (f) => [{ started_at: iso(f + 1 * H), expires_at: iso(f + 5 * H), cancelled_at: null }],
    ops: (f) => [{ occurred_at: iso(f + 1 * H), start_end: "end", is_anomaly: 0 }],
    expect: { operations: 1, errors: 0, errors_in_maintenance: 1, failure_rate: 0 },
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
          `INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at, cancelled_at)
           VALUES (?, 'parity', ?, ?, ?, ?)`
        ).run(siteId, w.started_at, 4, w.expires_at, w.cancelled_at);
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

// ===== main =====
const SUITES = {
  uptime: async () => { await parityUptime(); await parityEdgeCases(); },
  flicker: async () => { await parityFlicker(); await parityFlickerEdges(); },
  stats: async () => { await parityStats(); await parityStatsEdges(); },
  weighted: async () => { await parityWeighted(); },
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
  } else {
    console.log(`❌ ${failures} הבדלים מתוך ${checks} השוואות:\n`);
    for (const f of fails.slice(0, 40)) console.log(`   ${f}`);
    if (fails.length > 40) console.log(`   … ועוד ${fails.length - 40}`);
  }
  await db.close?.();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("parity: נפל —", e); process.exit(1); });
