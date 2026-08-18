// tools/parity-insights.js — שער האימוץ לתובנות בקריאה ישירה.
//
//   node --env-file=.env tools/parity-insights.js
//
// ============================================================
// ⚠️ הגרסה הראשונה של השער הזה הייתה חלשה — ונמדד שהיא חלשה
// ============================================================
// היא שלפה שורות פעם אחת והשוותה את computeInsights על אותן שורות בשני
// סידורים. שלוש מוטציות הורצו נגדה ו**שתיים עברו**: שינוי של חלון המצבים
// מחפיפה להכלה, והשמטת superseded_by. שתיהן שינו את שני הצדדים יחד, ולכן
// לא הופיע שום הבדל.
//
// שער שלא נבדק במוטציות נראה בדיוק כמו שער עובד. זה היה טקס, לא אימות.
//
// ============================================================
// מה השער עושה עכשיו: פונה ל-PostgREST **האמיתי**
// ============================================================
// הסיכון האמיתי כאן אינו החישוב — זו אותה computeInsights משני הצדדים —
// אלא **האם הבורר של supabase-js מייצר את אותה קבוצת שורות שהשרת שולף.**
// במיוחד חלון המצבים, שנכתב שם אחרת לגמרי:
//
//     שרת      WHERE started_at < to AND (ended_at IS NULL OR ended_at > from)
//     PostgREST .lt("started_at", to).or("ended_at.is.null,ended_at.gt.<from>")
//
// זה נראה שקול, אבל \`.or\` ב-PostgREST הוא ברמת השאילתה ולא בסוגריים — טעות
// כאן מחזירה קבוצה אחרת בשקט. אי אפשר לאמת את זה בסימולציה; חייבים לשאול
// את PostgREST עצמו. לכן השער קורא ל-REST API עם אותו מפתח שהדפדפן משתמש בו.
//
// ⚠️ מה שהוא עדיין **לא** בודק: RLS תחת session של משתמש אמיתי. המפתח כאן
// הוא ה-publishable, ולכן הרשאות נבדקות רק בדפדפן. שני מצבי המתג עדיין
// חייבים להיבדק שם לפני שחרור.

const fs = require("node:fs");
const { fetchRetry } = require("./lib/fetch-retry");
const path = require("node:path");
const db = require("../db/db");
const { computeInsights, collapseSegmentsBySite } = require("../../shared/insights.mjs");
const { resolvePeriod } = require("../api/periods");

// מפתחות הדשבורד — אותו URL ואותו מפתח שהדפדפן משתמש בהם.
const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const pick = (k) => (ENV.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const SB_URL = pick("VITE_SUPABASE_URL");
const SB_KEY = pick("VITE_SUPABASE_PUBLISHABLE_KEY");

let checks = 0, failures = 0;
const fails = [];

function compare(label, a, b) {
  checks++;
  const x = JSON.stringify(a ?? null);
  const y = JSON.stringify(b ?? null);
  if (x === y) return;
  failures++;
  fails.push(`${label}:\n      שרת = ${x.slice(0, 220)}\n      PostgREST = ${y.slice(0, 220)}`);
}

// ============================================================
// ⚠️ המפתח הציבורי לבדו מקבל 401 — וזה תקין
// ============================================================
// נמדד: `permission denied for table operations`. ה-RLS מעניק SELECT ל-
// `authenticated` בלבד, ולא ל-`anon` — כלומר קריאה בלי התחברות באמת חסומה.
// זו הוכחה שהמדיניות עובדת, לא תקלה בשער.
//
// לכן השער נכנס עם משתמש אמיתי, בדיוק כמו הדפדפן. הפרטים **אינם בקוד** אלא
// במשתני סביבה, ובלעדיהם השער אומר במפורש שהוא לא בדק את PostgREST — ולא
// מציג "עבר":
//
//     PARITY_EMAIL=... PARITY_PASSWORD=... node --env-file=.env tools/parity-insights.js
let TOKEN = null;
let GATE_EMAIL = null;
let cleanupUser = async () => {};

// ⚠️ **כבר לא דורש חשבון של אדם.** קודם השער נכנס עם PARITY_EMAIL, ולכן
// מחיקת אותו חשבון השביתה אותו לגמרי — וזה קרה. עכשיו הוא בונה לעצמו
// משתמש חד-פעמי ומוחק אותו בסוף. PARITY_EMAIL עדיין מנצח אם הוגדר.
async function signIn() {
  const { gateToken } = require("./lib/gate-user");
  try {
    const g = await gateToken(SB_URL, SB_KEY, process.env.SUPABASE_SECRET_KEY, fetchRetry);
    TOKEN = g.token;
    GATE_EMAIL = g.email;
    cleanupUser = g.cleanup;
    return true;
  } catch (e) {
    // ⚠️ מחזיר false ולא זורק: "לא הצלחתי להזדהות" הוא **אין ידיעה**, וזו
    // בדיוק ההפרדה ש-gates.js קיים בשבילה. כשל כאן שהיה נספר ככישלון
    // פריטי היה מצביע על באג במדדים שאינו קיים.
    console.log(`⚠️  ${e.message}`);
    return false;
  }
}

// ============================================================
// ⚠️ Supabase חוסם כל בקשה ב-1,000 שורות — ומתעלם מ-limit
// ============================================================
// נמדד מול הפרויקט החי:
//
//     בלי limit        -> 1000 שורות   content-range: 0-999/*
//     limit=20000      -> 1000 שורות   content-range: 0-999/*
//     Range: 1000-1999 -> 1000 שורות   content-range: 1000-1999/*
//
// **רק כותרת Range מזיזה את החלון.** זה בדיוק הבאג שהשער הזה תפס במסלולים
// הישירים: הם ביקשו limit(20000), קיבלו 1,000 בשקט, וגלאי החריגה שלהם השווה
// מול 20,000 ולכן לעולם לא נורה. הדשבורד היה מציג חודש חלקי עם "סה\"כ" שנראה
// סמכותי, בלי שום סימן שמשהו חסר.
//
// ⚠️ והשער עצמו חייב לדפדף גם כן, אחרת הוא היה משווה נתונים חתוכים למלאים
// לנצח — כלומר נכשל תמיד, גם אחרי שהבאג תוקן, והופך לרעש שמתעלמים ממנו.
const PAGE = 1000;

/** קריאה ל-PostgREST, בעמודים, בדיוק כפי ש-supabase-js עושה עם .range(). */
async function rest(pathAndQuery) {
  const rows = [];
  for (let off = 0; ; off += PAGE) {
    const res = await fetchRetry(`${SB_URL}/rest/v1/${pathAndQuery}`, {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${TOKEN || SB_KEY}`,
        Accept: "application/json",
        Range: `${off}-${off + PAGE - 1}`,
      },
    });
    if (!res.ok) throw new Error(`PostgREST ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

const enc = encodeURIComponent;

/** הצד הישיר — דרך PostgREST, עם אותם בוררים שב-insightsDirect.js. */
async function viaPostgrest(siteCode, from, to) {
  let siteFilter = "";
  if (siteCode) {
    const [s] = await rest(`sites?select=id&code=eq.${enc(siteCode)}`);
    siteFilter = `&site_id=eq.${s.id}`;
  }

  const ops = await rest(
    `operations?select=site_id,start_end,entry_exit,card_number,is_anomaly,superseded_by,occurred_at` +
    `&occurred_at=gte.${enc(from)}&occurred_at=lt.${enc(to)}${siteFilter}` +
    `&order=occurred_at.asc&limit=20000`
  );

  // ⚠️ זהו הביטוי שהשער קיים בשבילו: חפיפה, לא הכלה.
  const segments = await rest(
    `status_history?select=site_id,status,started_at,ended_at` +
    `&started_at=lt.${enc(to)}&or=(ended_at.is.null,ended_at.gt.${enc(from)})${siteFilter}` +
    `&order=started_at.asc&limit=20000`
  );

  const windows = await rest(
    `maintenance_windows?select=set_by_name,reason,started_at,duration_hours,cancelled_at` +
    `&started_at=gte.${enc(from)}&started_at=lt.${enc(to)}${siteFilter}&limit=20000`
  );

  return { ops, segments, windows };
}

/** הצד של השרת — השאילתות כפי שהן ב-getSiteInsights / getGlobalInsights. */
async function viaServer(siteId, from, to) {
  const where = siteId ? "site_id = ? AND " : "";
  const p = (...rest) => (siteId ? [siteId, ...rest] : rest);

  const ops = await db.prepare(
    `SELECT site_id, start_end, entry_exit, card_number, is_anomaly, superseded_by, occurred_at
       FROM operations WHERE ${where}occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at ASC`
  ).all(...p(from, to));

  const segments = await db.prepare(
    `SELECT site_id, status, started_at, ended_at FROM status_history
      WHERE ${where}started_at < ? AND (ended_at IS NULL OR ended_at > ?)
      ORDER BY started_at ASC`
  ).all(...p(to, from));

  const windows = await db.prepare(
    `SELECT set_by_name, reason, started_at, duration_hours, cancelled_at
       FROM maintenance_windows WHERE ${where}started_at >= ? AND started_at < ?`
  ).all(...p(from, to));

  return { ops, segments, windows };
}

const build = ({ ops, segments, windows }, from, to) => {
  const counted = collapseSegmentsBySite(segments);
  return computeInsights({
    ops,
    errorRows: counted.filter((s) => s.status === "error"),
    maintRows: counted.filter((s) => s.status === "maintenance"),
    windows, from, to,
  });
};

(async () => {
  await db.init();

  if (!SB_URL || !SB_KEY) {
    console.error("parity-insights: חסרים VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY ב-dashboard/.env");
    process.exit(1);
  }

  const authed = await signIn();
  if (!authed) {
    // ⚠️ **לא** נופלים בשקט לבדיקה חלשה יותר. השער הזה קיים כדי לאמת שהבורר
    // של PostgREST מחזיר את אותה קבוצת שורות; בלי התחברות הוא אינו יכול
    // לעשות זאת, ו"עבר" כאן היה שקר.
    console.log("\n⚠️  לא ניתן היה להזדהות — PostgREST לא נבדק.");
    console.log("    השער בונה לעצמו משתמש דרך SUPABASE_SECRET_KEY; בלעדיו:");
    console.log("      PARITY_EMAIL=<מייל> PARITY_PASSWORD=<סיסמה> \\");
    console.log("        node --env-file=.env tools/parity-insights.js");
    console.log("\n    (401 ללא התחברות הוא ההתנהגות התקינה: RLS מעניק קריאה ל-authenticated בלבד.)");
    process.exit(2);
  }
  console.log(`מחובר כ-${GATE_EMAIL} — נבדק מול PostgREST האמיתי`);

  const sites = await db.prepare("SELECT id, code FROM sites ORDER BY code").all();
  const targets = [{ id: null, code: null, label: "כל האתרים" },
                   ...sites.slice(0, 3).map((s) => ({ ...s, label: s.code }))];

  for (const period of ["week", "month"]) {
    const { range } = resolvePeriod(period);
    // ⚠️ קצה קבוע לשתי הזרועות: הן פונות לשני מנועים שונים ברצף, והקליטה
    // רצה במקביל. בלי חלון זהה השער היה מהבהב על שורה שנקלטה בין השתיים.
    const to = new Date().toISOString();

    console.log(`\n=== תובנות — ${period} ===`);

    for (const t of targets) {
      // ============================================================
      // ⚠️ ריטריי על **תזוזת נתונים** בלבד — לא על הבדל ערכים
      // ============================================================
      // השער משווה שני מנועים שונים (pg מול PostgREST), ולכן אי אפשר לכסות
      // אותם בצילום מצב אחד כמו ב-parity-activity. כשהקליטה חיה, שורה שנכתבת
      // בין שתי השליפות משנה את הקבוצה — נמדד: 2,699 מול 2,700 מקטעים.
      //
      // ⚠️ ההבחנה חדה, וזו כל הנקודה: **ספירות זהות וערך שונה = באג**, ואין
      // שום סיבה לנסות שוב. רק אי-התאמה בספירה היא חתימה של נתונים שזזו.
      // ריטריי גורף היה הופך "עבר אחרי כמה ניסיונות" ללגיטימי, וזו בדיוק
      // הדרך שבה באג נדיר שורד שער.
      let srvRows, pgRows;
      for (let attempt = 1; ; attempt++) {
        srvRows = await viaServer(t.id, range.from, to);
        pgRows = await viaPostgrest(t.code, range.from, to);

        const stable = srvRows.ops.length === pgRows.ops.length
          && srvRows.segments.length === pgRows.segments.length
          && srvRows.windows.length === pgRows.windows.length;

        if (stable || attempt >= 4) break;
        // הקליטה כתבה בין השליפות. ממתינים שהגל יעבור ומודדים שוב.
        await new Promise((r) => setTimeout(r, 700 * attempt));
      }

      // קודם כל: אותה **קבוצת שורות**. אם זה נשבר גם אחרי הריטריי, זה כבר
      // לא רעש — או שהבורר של PostgREST אינו שקול לשאילתת השרת, או שהקליטה
      // כה עמוסה שאי אפשר למדוד. שתיהן ראויות לכישלון.
      compare(`${period}/${t.label}.rows.ops`, srvRows.ops.length, pgRows.ops.length);
      compare(`${period}/${t.label}.rows.segments`, srvRows.segments.length, pgRows.segments.length);
      compare(`${period}/${t.label}.rows.windows`, srvRows.windows.length, pgRows.windows.length);

      const a = build(srvRows, range.from, to);
      const b = build(pgRows, range.from, to);
      for (const key of Object.keys(a)) {
        compare(`${period}/${t.label}.${key}`, a[key], b[key]);
      }
    }
    console.log(`  ${targets.length} יעדים נבדקו מול PostgREST`);
  }

  // כיסוי מפורש לכלל החפיפה: אם אין מקטעים כאלה בנתונים, הכלל אינו נבדק
  // וצריך לומר זאת ולא להציג "עבר".
  const { range } = resolvePeriod("week");
  const spanning = await db.prepare(
    `SELECT COUNT(*)::int n FROM status_history
      WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)`
  ).get(range.from, range.from);
  console.log(`\n=== כיסוי כלל החפיפה ===`);
  console.log(`  מקטעים שהתחילו לפני החלון ונמשכים לתוכו: ${spanning.n}` +
              (spanning.n ? "  ✓ הכלל מכוסה" : "  ⚠ אין מקרים — הכלל אינו מכוסה"));

  // ⚠️ **לפני כל יציאה, כולל יציאת כישלון.** ניקוי שרץ רק בנתיב ההצלחה
  // משאיר משתמש שער אחרי כל ריצה אדומה — כלומר בדיוק כשמריצים שוב ושוב.
  await cleanupUser();

  console.log(`\n${"=".repeat(60)}`);
  if (failures) {
    console.log(`❌ ${failures} הבדלים מתוך ${checks} השוואות\n`);
    fails.slice(0, 10).forEach((f) => console.log("   " + f));
    process.exit(1);
  }
  console.log(`✅ שתי הזרועות זהות — ${checks} השוואות, 0 הבדלים`);
  process.exit(0);
})().catch(async (e) => {
  await cleanupUser();
  console.error("parity-insights: נפל —", e.message);
  process.exit(1);
});
