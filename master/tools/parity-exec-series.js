// tools/parity-exec-series.js — שער האימוץ ל-executive_series.
//
// ============================================================
// מה נבדק כאן, ולמה זה חייב לרוץ לפני האימוץ
// ============================================================
// מסך "מנהל כללי" שלף **שורות גולמיות** והריץ עליהן את computeExecutive
// בדפדפן. נמדד על הייצור, תצוגת חודש: 10,630 שורות · 1.6MB · שמונה
// נסיעות רשת סדרתיות, כדי להפיק גרף של 30 נקודות.
//
// `public.executive_series` מצטברת במסד ומחזירה 480 שורות ו-68KB. אבל
// כלל הברזל של הפרויקט הוא שמדד שעבר ל-SQL **חייב להחזיר תוצאה זהה על
// נתונים אמיתיים לפני שהוא מאומץ** — אחרת המסך יראה מספרים אחרים בלי
// שאיש ידע איזה מהם נכון.
//
// ⚠️ **שני הצדדים מוזנים לאותה computeExecutive**, ורק הקלט שונה:
// `data` (שורות גולמיות, זרוע השרת) מול `series` (מצטבר, SQL). כל השאר
// — סינון, KPIs, פילוחים — זהה בהגדרה, ולכן כל הבדל שיתגלה הוא באמת
// בהצטברות ולא ברעש.
//
// ⚠️ ורץ מול המסד ישירות ולא דרך PostgREST: זה מבודד את השינוי. הבדיקה
// שהמסלול הישיר בדפדפן שולף נכון היא parity-executive, והיא נפרדת.
const db = require("../db/db.js");
const { loadRangeData } = require("../db/queries.js");
const { resolvePeriod } = require("../api/periods.js");
const { computeExecutive, getBucketRanges } = require("../../shared/executive.mjs");

// ⚠️ אותה סובלנות כמו בשאר שערי ה-parity: ההפרש בין צבירת מילישניות
// שלמות ב-JS לצבירת שניות כ-double ב-Postgres נופל בדיוק על גבול ה-.005
// של העיגול. תיקו כזה נספר ומודפס, ואינו מפיל.
const TIE = 0.0100001;

let diffs = 0, ties = 0, checks = 0;

function walk(a, b, path) {
  if (a === b) return;
  if (typeof a === "number" && typeof b === "number") {
    checks++;
    if (Number.isInteger(a) && Number.isInteger(b)) {
      if (a !== b) { diffs++; console.log(`  ❌ ${path}: JS=${a} SQL=${b}`); }
      return;
    }
    const d = Math.abs(a - b);
    if (d < 1e-9) return;
    if (d <= TIE) { ties++; console.log(`  ≈ ${path}: JS=${a} SQL=${b} (תיקו עיגול)`); return; }
    diffs++; console.log(`  ❌ ${path}: JS=${a} SQL=${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    checks++;
    if (a.length !== b.length) { diffs++; console.log(`  ❌ ${path}.length: ${a.length} vs ${b.length}`); return; }
    a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`));
    return;
  }
  if (a && b && typeof a === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) walk(a[k], b[k], path ? `${path}.${k}` : k);
    return;
  }
  checks++;
  diffs++;
  console.log(`  ❌ ${path}: JS=${JSON.stringify(a)} SQL=${JSON.stringify(b)}`);
}

(async () => {
  await db.init();
  console.log("=== parity-exec-series ===\n");

  const sites = await db.prepare(
    "SELECT id, code, site_name, status FROM sites ORDER BY code").all();
  const siteIds = sites.map((s) => s.id);
  const allSites = sites.map((s) => ({ id: s.id, code: s.code, site_name: s.site_name }));

  for (const period of ["week", "month", "year"]) {
    for (const granularity of ["day", "month"]) {
      const p = resolvePeriod(period);
      const { from, to } = p.range;
      const buckets = getBucketRanges({ from, to, granularity });

      // ---------- הקלט המצטבר ----------
      // ⚠️ הדלי הנוסף בקצה הוא **כל הטווח** — הסיכומים (כניסות/יציאות
      // לאריחים) מחושבים ממנו ולא מסכימת הדליים, בדיוק כמו ב-JS שקורא
      // ל-directionFromData על הטווח המלא בנפרד.
      const withTotal = [...buckets.map((b) => ({ from: b.from, to: b.to })),
                         { from, to }];
      // ⚠️ p_from/p_to הם גבולות **התקופה** — הקיפול חייב את ההקשר שלפני
      // הדלי. זה בדיוק מה שהריצה הראשונה של השער הזה חשפה.
      const series = await db.prepare(
        "SELECT * FROM executive_series(?, ?, ?, ?::jsonb)")
        .all(siteIds, from, to, JSON.stringify(withTotal));

      // ---------- הקלט הגולמי ----------
      const data = await loadRangeData(siteIds, { from, to });

      // ---------- allRows זהה לשני הצדדים ----------
      // הוא אינו מה שנבדק כאן; הוא מגיע מ-supervisor בשתי הזרועות כאחת.
      const stats = await db.prepare("SELECT * FROM site_stats(?, ?, ?)").all(siteIds, from, to);
      const up = await db.prepare("SELECT * FROM site_uptime(?, ?, ?)").all(siteIds, from, to);
      const sMap = new Map(stats.map((r) => [r.site_id, r]));
      const uMap = new Map(up.map((r) => [r.site_id, r]));
      const allRows = sites.map((s) => {
        const st = sMap.get(s.id) || {};
        const u = uMap.get(s.id) || {};
        return {
          code: s.code, name: s.site_name, status: s.status,
          operations: st.operations || 0, errors: st.errors || 0,
          failureRate: st.failure_rate || 0,
          availability: u.availability_percent ?? 0,
          hasUptimeData: (u.measured_hours || 0) > 0,
          maintenanceHours: u.maintenance_hours || 0,
          downtimeHours: u.error_hours || 0,
          cycleTotal: 0, operationsSinceLastError: 0,
        };
      });

      const common = { allRows, allSites, from, to, granularity };
      const viaData = computeExecutive({ ...common, data });
      const viaSeries = computeExecutive({ ...common, series });

      const label = `${period}/${granularity}`;
      const before = diffs;
      // ⚠️ rawRows ו-topPerformers נגזרים מ-allRows בלבד ואינם נוגעים
      // בשינוי — אבל הם מושווים בכל זאת, כי השוואה חלקית היא בדיוק איך
      // ששער מפספס רגרסיה בשדה שאיש לא חשב עליו.
      walk(viaData, viaSeries, label);
      console.log(`  ${before === diffs ? "✅" : "❌"} ${label.padEnd(14)} ${buckets.length} דליים · ${series.length} שורות סדרה`);
    }
  }

  // ============================================================
  // ⚠️ בדיקת התחבורה — השער עד כאן אינו חוצה את PostgREST
  // ============================================================
  // כל ההשוואות למעלה רצות דרך ה-pool, כלומר הן מוכיחות שה-SQL וה-JS
  // מסכימים. הן **אינן יכולות** לתפוס אובדן נתונים בדרך אל הדפדפן — ולא
  // תפסו: PostgREST חותך כל תשובה ב-1,000 שורות, ו-executive_series
  // מחזירה שורה לכל (דלי × אתר).
  //
  // ⚠️ נמדד בייצור: "השנה הנוכחית" ברזולוציה יומית = 3,920 שורות, חזרו
  // 1,000, **בסטטוס 200**. אין ORDER BY בפונקציה, ולכן אלה 1,000 שורות
  // שרירותיות — הגרף מתפזר במקום להיגמר, וזה נראה כמו מכונה שקטה.
  //
  // זו הבדיקה היחידה כאן שנוגעת ברשת, והיא הסיבה שהיא קיימת: שער
  // שמשווה שני חישובים לעולם לא יראה מה השכבה שביניהם זרקה.
  {
    const fs = require("node:fs");
    const { gateToken } = require("./lib/gate-user");
    const SB = process.env.SUPABASE_URL, SECRET = process.env.SUPABASE_SECRET_KEY;
    const ANON = (fs.readFileSync("../dashboard/.env", "utf8")
      .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

    const retry = async (url, opt) => {
      let last;
      for (let i = 0; i < 5; i++) {
        try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); }
      }
      throw last;
    };

    console.log("\n── תחבורה: מה באמת מגיע לדפדפן ──");
    const g = await gateToken(SB, ANON, SECRET, retry);
    try {
      const H = { apikey: ANON, Authorization: `Bearer ${g.token}`, "Content-Type": "application/json" };
      const to = new Date().toISOString();
      // ⚠️ שנה × יומי — הטווח הרחב ביותר שהבורר במסך מאפשר ("שנה שעברה").
      // בדיקה על טווח צר הייתה עוברת תמיד: התקרה נפגעת רק מעל ~62 ימים.
      const from = new Date(Date.now() - 365 * 86400000).toISOString();
      const bs = getBucketRanges({ from, to, granularity: "day" });
      const withTotal = [...bs.map((b) => ({ from: b.from, to: b.to })), { from, to }];
      const body = JSON.stringify({ p_site_ids: null, p_from: from, p_to: to, p_buckets: withTotal });

      const r = await retry(`${SB}/rest/v1/rpc/executive_series_json`, { method: "POST", headers: H, body });
      const got = await r.json();
      const nSites = (await db.prepare("SELECT COUNT(*)::int AS n FROM sites").get()).n;
      const expect = withTotal.length * nSites;
      const ok = Array.isArray(got) && got.length === expect;
      console.log(`  ${ok ? "✅" : "❌"} ${withTotal.length} דליים × ${nSites} אתרים = ${expect} · הגיעו ${Array.isArray(got) ? got.length : "לא-מערך"}`);
      if (!ok) {
        diffs++;
        console.log("     הנתונים נחתכים בדרך לדפדפן. אל תחזירו שורות מ-RPC רחב.");
      }
    } finally {
      await g.cleanup();
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(diffs === 0
    ? `✅ נקי — ${checks} השוואות, 0 הבדלים${ties ? ` (${ties} תיקו-עיגול)` : ""}`
    : `❌ ${diffs} הבדלים מתוך ${checks} השוואות`);
  process.exit(diffs === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
