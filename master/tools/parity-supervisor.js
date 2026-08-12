// tools/parity-supervisor.js — שער האימוץ למסך הבקרה בקריאה ישירה.
//
//   node --env-file=.env tools/parity-supervisor.js
//
// ============================================================
// מה זה בודק, ולמה זה לא כמו parity.js
// ============================================================
// parity.js משווה **מדד מול מדד**: JS מול פונקציית SQL. כאן ההשוואה היא
// ברמה אחת מעל — **התשובה המלאה של המסך** בשני מצבי המתג:
//
//     דרך השרת : getSupervisorStats  (loadRangeData + חישוב ב-JS)
//     ישיר      : site_stats / site_uptime / site_globals / recent_errors
//                 ואז toSupervisorShape — **הפונקציה שרצה בדפדפן ממש**
//
// ============================================================
// ⚠️ למה הוא מייבא את המיפוי ולא מעתיק אותו
// ============================================================
// הסיכון האמיתי במעבר לקריאה ישירה אינו האריתמטיקה — היא כבר מאומתת
// ב-1,338 השוואות. הסיכון הוא **שם עמודה**: site_globals מחזירה שדות
// שטוחים (last_op_*, maintenance_*), וניחוש טבעי כמו g.last_operation אינו
// זורק שגיאה אלא הופך ל-undefined ואז ל-null דרך ה-??. התוצאה היא מסך
// שנראה תקין לגמרי עם נתונים ריקים.
//
// בדיקה שמחזיקה עותק של המיפוי הייתה בודקת את העותק. לכן toSupervisorShape
// יושבת בקובץ טהור בלי שום import, והבדיקה מייבאת אותה כמות שהיא.
//
// ============================================================
// ומה הוא **לא** בודק, במפורש
// ============================================================
// את supabase-js עצמו: RLS, session, והרשאות. אלה נבדקים רק בדפדפן, ולכן
// שני מצבי המתג עדיין חייבים להיבדק שם לפני שחרור. כאן נבדק שהנתונים
// והמבנה זהים — לא שהגישה מותרת.

const path = require("node:path");
const db = require("../db/db");
const { getSupervisorStats, getRecentErrors, getActiveMaintenances } = require("../db/queries");
const { resolvePeriod } = require("../api/periods");

let checks = 0, failures = 0;
const fails = [];

// ============================================================
// תיקו-עיגול על גבול .005 — נספר, לא מפיל
// ============================================================
// נתפס כאן בפועל: maintenanceHours של אתר 3513 יצא 8.15 מול 8.16. הערך
// הגולמי זהה בשני הצדדים; ההפרש כולו בעיגול. ב-double 8.155 יושב מעט מתחת
// לחצי ו-Math.round יורד, ו-Postgres מעגל ב-NUMERIC (עשרוני מדויק) ולכן עולה.
//
// אף צד אינו שגוי, ו-tools/parity.js כבר מכיר בזה במפורש. שער שנצבע אדום
// מפער שאינו של אף אחד מהצדדים הוא שער שלומדים להתעלם ממנו.
//
// ⚠️ ההקלה חלה **רק על שברים**. שלמים — ספירות — מושווים בשוויון מוחלט, כי
// שם כל הפרש הוא באג.
const TIE = 0.0100001;
let ties = 0;

function compare(label, server, direct) {
  checks++;

  if (typeof server === "number" && typeof direct === "number"
      && Number.isFinite(server) && Number.isFinite(direct)
      && !(Number.isInteger(server) && Number.isInteger(direct))
      && Math.abs(server - direct) <= TIE) {
    if (server !== direct) ties++;
    return;
  }

  // המרה למחרוזת כדי ש-null מול undefined ייחשבו שונים — הם אינם זהים
  // למסך: null מרנדר "—", ו-undefined מרנדר כלום.
  const a = JSON.stringify(server ?? null);
  const b = JSON.stringify(direct ?? null);
  if (a === b) return;
  failures++;
  fails.push(`${label}:\n      שרת = ${a}\n      ישיר = ${b}`);
}

(async () => {
  await db.init();

  // ייבוא דינמי: הדשבורד הוא ESM, והקובץ הזה CommonJS.
  const shapeUrl = "file://" + path
    .resolve(__dirname, "../../dashboard/src/services/supervisorShape.js")
    .replace(/\\/g, "/");
  const { toSupervisorShape } = await import(shapeUrl);

  for (const period of ["week", "month", "year"]) {
    const { range } = resolvePeriod(period);
    const to = new Date().toISOString();
    const from = range.from;

    console.log(`\n=== מסך הבקרה — ${period} ===`);

    // ---- זרוע השרת ----
    const srv = await getSupervisorStats({ from, to });
    srv.recentErrors = await getRecentErrors({ limit: 10 });
    srv.activeMaintenances = await getActiveMaintenances();

    // ---- הזרוע הישירה, מאותם מקורות שהדפדפן קורא ----
    const [siteRows, statsRows, uptimeRows, globalsRows, errorRows, maintRows] =
      await Promise.all([
        db.prepare("SELECT * FROM sites").all(),
        db.prepare("SELECT * FROM public.site_stats(NULL, ?, ?)").all(from, to),
        db.prepare("SELECT * FROM public.site_uptime(NULL, ?, ?)").all(from, to),
        db.prepare("SELECT * FROM public.site_globals(NULL)").all(),
        db.prepare("SELECT * FROM public.recent_errors(10)").all(),
        // אותה שאילתה ש-PostgREST מייצר מהבורר בדפדפן, כולל הקינון של sites.
        db.prepare(
          `SELECT m.started_at, m.expires_at, m.set_by_name, m.reason,
                  json_build_object('code', s.code, 'site_name', s.site_name) AS sites
             FROM maintenance_windows m JOIN sites s ON s.id = m.site_id
            WHERE m.cancelled_at IS NULL AND m.expires_at > ?
            ORDER BY m.expires_at ASC`
        ).all(new Date().toISOString()),
      ]);

    const dir = toSupervisorShape({
      siteRows, statsRows, uptimeRows, globalsRows, errorRows, maintRows,
    });

    // ---- השוואה ----
    compare(`${period}.sites.length`, srv.sites.length, dir.sites.length);

    for (let i = 0; i < Math.min(srv.sites.length, dir.sites.length); i++) {
      const a = srv.sites[i], b = dir.sites[i];
      // גם הסדר נבדק, לא רק התוכן: טבלה שמופיעה בסדר אחר בשני מצבי המתג
      // נקראת כמו נתונים אחרים.
      compare(`${period}.sites[${i}].code`, a.code, b.code);
      for (const k of ["name", "status", "tier", "operations", "errors", "failureRate",
                       "availability", "hasUptimeData", "maintenanceHours", "downtimeHours",
                       "lastError", "operationsSinceLastError", "cycleTotal",
                       "inManualMaintenance", "lastOperation"]) {
        compare(`${period}.sites[${i}](${a.code}).${k}`, a[k], b[k]);
      }
    }

    for (const k of Object.keys(srv.summary)) {
      compare(`${period}.summary.${k}`, srv.summary[k], dir.summary[k]);
    }

    compare(`${period}.recentErrors.length`, srv.recentErrors.length, dir.recentErrors.length);
    for (let i = 0; i < Math.min(srv.recentErrors.length, dir.recentErrors.length); i++) {
      const a = srv.recentErrors[i], b = dir.recentErrors[i];
      for (const k of ["siteCode", "siteName", "startedAt", "endedAt", "ongoing", "durationMinutes"]) {
        compare(`${period}.recentErrors[${i}].${k}`, a[k], b[k]);
      }
      // תקלה פתוחה נמדדת מול "עכשיו" בשני הצדדים בזמנים שונים בשבריר שנייה.
      // הסבילות חלה **רק** עליה; על תקלה סגורה כל הפרש הוא באג.
      if (!a.ongoing) {
        compare(`${period}.recentErrors[${i}].durationSeconds`, a.durationSeconds, b.durationSeconds);
      }
    }

    compare(`${period}.activeMaintenances.length`,
            srv.activeMaintenances.length, dir.activeMaintenances.length);
    for (let i = 0; i < Math.min(srv.activeMaintenances.length, dir.activeMaintenances.length); i++) {
      const a = srv.activeMaintenances[i], b = dir.activeMaintenances[i];
      for (const k of ["siteCode", "siteName", "setBy", "reason", "startedAt", "expiresAt"]) {
        compare(`${period}.activeMaintenances[${i}].${k}`, a[k], b[k]);
      }
    }

    console.log(`  ${srv.sites.length} אתרים · ${srv.recentErrors.length} תקלות · ` +
                `${srv.activeMaintenances.length} תחזוקות פעילות`);
  }

  // ============================================================
  // מקרים זרועים — מה שנתוני הייצור אינם מכילים
  // ============================================================
  // ההשוואה למעלה רצה על נתוני אמת, וזה הכיסוי החזק ביותר שיש — אבל הוא
  // עיוור לכל מה שלא קרה בפועל. נמדד כאן ממש: מוטציה שביטלה את "תחזוקה
  // ידנית גוברת על מצב האתר" **עברה את כל 810 ההשוואות**, פשוט כי אין
  // בייצור אף חלון תחזוקה פעיל.
  //
  // זה בדיוק הלקח שכבר נלמד בפרויקט הזה (ראה site_globals ב-CLAUDE.md):
  // ארבע מוטציות רצו על נתוני ייצור ורק אחת נתפסה — לא כי הקוד היה נכון,
  // אלא כי לנתונים אין מקרים כאלה.
  //
  // כאן ההשוואה אינה מול השרת אלא מול **ההתנהגות המוגדרת**, כי אי אפשר
  // לזרוע שורות בייצור. הקלט סינתטי, הפונקציה היא זו שרצה בדפדפן.
  console.log(`\n=== מקרים זרועים ===`);

  const seeded = [
    {
      name: "חלון תחזוקה ידני פעיל גובר על מצב האתר",
      site: { id: 1, code: "T1", site_name: "בדיקה", status: "ready", tier: "basic", plc_cycle_last: 5 },
      globals: { site_id: 1, maintenance_id: 77 },
      expect: (r) => r.status === "maintenance" && r.inManualMaintenance === true,
      why: "אתר ב-ready עם חלון פעיל חייב להופיע כתחזוקה — אחרת הוא נחשב זמין",
    },
    {
      name: "בלי חלון פעיל — המצב מהבקר נשמר",
      site: { id: 1, code: "T1", site_name: "בדיקה", status: "ready", tier: "basic" },
      globals: { site_id: 1, maintenance_id: null },
      expect: (r) => r.status === "ready" && r.inManualMaintenance === false,
      why: "בלי זה כל אתר היה מסומן בתחזוקה",
    },
    {
      name: "measured_hours = 0 → אין נתון זמינות, לא 0%",
      site: { id: 1, code: "T1", site_name: "בדיקה", status: "ready" },
      uptime: { site_id: 1, measured_hours: 0, availability_percent: 0 },
      expect: (r) => r.hasUptimeData === false,
      why: '"0%" נקרא "מושבת לגמרי" כשהמשמעות היא "איננו יודעים"',
    },
    {
      name: "אתר בלי היסטוריה כלל — אפסים, לא undefined",
      site: { id: 9, code: "T9", site_name: "חדש", status: "ready" },
      expect: (r) => r.operations === 0 && r.errors === 0 && r.lastOperation === null,
      why: "אתר שנרשם ועדיין לא שידר אינו מופיע באף שליפה",
    },
    {
      name: "פעולה אחרונה קיימת → אובייקט מלא, לא שדות undefined",
      site: { id: 1, code: "T1", site_name: "בדיקה", status: "ready" },
      globals: { site_id: 1, last_op_occurred_at: "2026-08-01T10:00:00.000Z",
                 last_op_start_end: "end", last_op_entry_exit: "entry", last_op_card_number: "7" },
      expect: (r) => r.lastOperation?.card_number === "7" && r.lastOperation?.entry_exit === "entry",
      why: "site_globals מחזירה שדות שטוחים; ניחוש g.last_operation היה עובר בשקט כ-null",
    },
  ];

  for (const c of seeded) {
    checks++;
    const out = toSupervisorShape({
      siteRows: [c.site],
      statsRows: c.stats ? [c.stats] : [],
      uptimeRows: c.uptime ? [c.uptime] : [],
      globalsRows: c.globals ? [c.globals] : [],
      errorRows: [], maintRows: [],
    });
    const ok = out.sites.length === 1 && c.expect(out.sites[0]);
    if (!ok) {
      failures++;
      fails.push(`זרוע — ${c.name}\n      ${c.why}\n      התקבל: ${JSON.stringify(out.sites[0])}`);
    }
    console.log(`  ${ok ? "✓" : "✗"} ${c.name}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  if (failures) {
    console.log(`❌ ${failures} הבדלים מתוך ${checks} השוואות\n`);
    fails.slice(0, 25).forEach((f) => console.log("   " + f));
    if (fails.length > 25) console.log(`   ... ועוד ${fails.length - 25}`);
    process.exit(1);
  }
  console.log(`✅ שתי הזרועות זהות — ${checks} השוואות, 0 הבדלים`);
  if (ties) console.log(`   (${ties} תיקו-עיגול על גבול .005 — הערך הגולמי זהה בשני הצדדים)`);
  process.exit(0);
})().catch((e) => { console.error("parity-supervisor: נפל —", e.message); process.exit(1); });
