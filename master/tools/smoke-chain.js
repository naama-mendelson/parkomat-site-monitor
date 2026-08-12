// tools/smoke-chain.js — השרשרת המלאה, מקצה לקצה, על נתונים אמיתיים.
//
//   PARITY_EMAIL=<מייל> PARITY_PASSWORD=<סיסמה> \
//     node --env-file=.env tools/smoke-chain.js
//
// ============================================================
// מה זה בודק שאף בדיקה אחרת לא
// ============================================================
// כל שאר השערים בודקים חוליה אחת:
//
//     parity-*        — הדשבורד והשרת מחשבים אותו דבר
//     smoke-direct    — לדשבורד מותר לקרוא מ-Supabase
//     smoke-realtime  — Realtime מוסר שורה **שהבדיקה עצמה כתבה**
//
// אף אחד מהם לא מוכיח שהשרשרת שלמה. הבדיקה כאן ממתינה לאירוע **אמיתי**,
// כזה שמקורו בסוכן בשטח:
//
//     Agent → HiveMQ → שרת → Supabase → Realtime → דפדפן
//
// אם הוא מגיע, כל חוליה עובדת. אם לא — הבדיקה אומרת **איזו** חוליה שקטה,
// ולא רק "משהו לא עובד".
//
// ⚠️ היא **אינה כותבת כלום**. אירוע מפוברק היה מוכיח רק ש-Realtime עובד,
// וזה כבר נבדק במקום אחר. כאן הערך הוא דווקא בכך שהנתון אמיתי.
//
// ============================================================
// ⚠️ הריצו אותה **לבדה**, ולא ברצף עם כלי Supabase אחרים
// ============================================================
// נמדד: כשהיא רצה מיד אחרי smoke-direct / smoke-realtime היא נכשלה, וכשהיא
// רצה לבדה עברה שלוש מתוך שלוש. הסיבה אינה במוצר אלא **בכלים**: כל אחד מהם
// פותח לקוח Supabase משלו ומתחבר מחדש, ו-Realtime מגביל חיבורים בו-זמניים
// מאותו מקור. הערוץ נפתח אך אינו מקבל.
//
// זה נרשם כאן כי כשל בבדיקה הזו נראה בדיוק כמו תקלה אמיתית בעדכונים החיים —
// וזו התקלה שהכי קשה להאמין לה כשהיא כן אמיתית. אם היא נכשלת, הריצו אותה
// שוב לבדה **לפני** שמחפשים תקלה.

const fs = require("node:fs");
const path = require("node:path");
const db = require("../db/db");
const { createClient } = require("../../dashboard/node_modules/@supabase/supabase-js");

const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const pick = (k) => (ENV.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const SB_URL = pick("VITE_SUPABASE_URL");
const SB_KEY = pick("VITE_SUPABASE_PUBLISHABLE_KEY");

const WAIT_MS = 60000;

(async () => {
  await db.init();
  const t0 = Date.now();

  console.log("=== החוליות ===\n");

  // ============================================================
  // ⚠️ "אין תנועה" ≠ "השרת מת" — וזו הבחנה שהבדיקה חייבת לעשות
  // ============================================================
  // הגרסה הראשונה כאן בדקה רק "האם נכתבו שורות בשתי הדקות האחרונות", והכריזה
  // "הקליטה מושבתת" כשהתשובה הייתה 0. **זה היה אבחון שגוי ונתפס בפועל**: ב-05:40
  // בבוקר, אחרי שהתור נפרק, החניונים פשוט שקטים. אין תנועה זה מצב תקין.
  //
  // ההבחנה היא **פיגור**, לא נפח: אם הפעולה החדשה ביותר היא מלפני דקות, השרת
  // עמד בקצב ואין מה לתקן. פיגור של שעות פירושו שהוא לא רץ או לא מחובר.
  //
  // הודעה שגויה כאן גרועה משתיקה: היא שולחת לחפש תקלה שאינה קיימת, ובפעם
  // הבאה שהיא תופיע — כשהיא אמיתית — כבר לא יאמינו לה.
  const CAUGHT_UP_MIN = 20;

  const newest = await db.prepare("SELECT MAX(occurred_at) m FROM operations").get();
  const lagMin = newest.m ? Math.round((t0 - Date.parse(newest.m)) / 60000) : Infinity;
  const recent = await db.prepare(
    "SELECT COUNT(*)::int n FROM operations WHERE received_at > ?"
  ).get(new Date(t0 - 120000).toISOString());

  const caughtUp = lagMin <= CAUGHT_UP_MIN;
  const mqttAlive = recent.n > 0 || caughtUp;

  console.log(
    `  ${mqttAlive ? "✔" : "✘"} HiveMQ → שרת: ${recent.n} פעולות בשתי הדקות האחרונות · ` +
    `פיגור ${lagMin === Infinity ? "—" : lagMin + " דק'"}` +
    (recent.n === 0 && caughtUp ? "  (שקט, אבל מעודכן — תקין)" : "")
  );

  // ---- חוליה 2: שרת → Supabase ----
  const written = await db.prepare(
    "SELECT COUNT(*)::int n FROM events WHERE created_at > ?"
  ).get(new Date(t0 - 120000).toISOString());
  console.log(`  ${written.n > 0 ? "✔" : "✘"} שרת → Supabase: ${written.n} אירועים נכתבו`);

  // ---- חוליה 3: Supabase → דשבורד (Realtime) ----
  const supabase = createClient(SB_URL, SB_KEY);
  const { error } = await supabase.auth.signInWithPassword({
    email: process.env.PARITY_EMAIL, password: process.env.PARITY_PASSWORD,
  });
  if (error) { console.error(`  ✘ התחברות נכשלה: ${error.message}`); process.exit(1); }

  console.log(`  … Supabase → דשבורד: ממתין לאירוע אמיתי (עד ${WAIT_MS / 1000}s)`);

  const arrived = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), WAIT_MS);
    supabase
      .channel("smoke-chain")
      .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "events" },
          (msg) => { clearTimeout(timer); resolve(msg.new); })
      .subscribe();
  });

  console.log(`\n${"=".repeat(60)}`);

  if (!mqttAlive) {
    console.log(`❌ הקליטה מפגרת ${lagMin} דקות — השרת אינו רץ או אינו מחובר ל-HiveMQ.`);
    console.log("   שאר החוליות אינן ניתנות לבדיקה כשאין נתונים זורמים.");
    process.exit(1);
  }

  if (!arrived) {
    // ============================================================
    // ⚠️ השאלה היא "נכתב משהו **בזמן ההמתנה**", לא "היה עמוס לפני כן"
    // ============================================================
    // כאן כוילה הבדיקה שלוש פעמים, וכל גרסה הייתה מדויקת יותר:
    //   1. "0 שורות בשתי דקות" -> הכריזה שהשרת מת. שגוי: חניון שקט ב-05:40.
    //   2. "היו שורות לפני כן"  -> הכריזה על תקלה ב-Realtime. גם שגוי:
    //      **תנועה באתרים מתפרצת**. שתי פעולות בדקה שעברה אינן מבטיחות
    //      עוד אחת בדקה הבאה.
    //
    // המבחן הנכון הוא ישיר: לספור אירועים לפני ההמתנה ואחריה. אם נכתב אירוע
    // בזמן שהמנוי היה פתוח והוא לא הגיע — **זו תקלה ודאית ב-Realtime**.
    // אם לא נכתב כלום, פשוט לא היה מה למסור.
    const after = await db.prepare(
      "SELECT COUNT(*)::int n FROM events WHERE created_at > ?"
    ).get(new Date(t0).toISOString());

    if (after.n === 0) {
      console.log(`⚠️  שום אירוע לא נוצר בזמן ההמתנה (${WAIT_MS / 1000}s) — האתרים שקטים כרגע.`);
      console.log(`   הקליטה מעודכנת (פיגור ${lagMin} דק'), ולכן אין מה למסור.`);
      console.log("   Realtime עצמו נבדק בנפרד ב-tools/smoke-realtime.js.");
      process.exit(0);   // לא תקלה
    }

    console.log(`❌ ${after.n} אירועים נכתבו בזמן שהמנוי היה פתוח — ואף אחד לא הגיע.`);
    console.log("   זו תקלה ודאית ב-Realtime: הדשבורד לא יתעדכן בזמן אמת,");
    console.log("   והכרטיסים יקפאו על מצב ישן בלי שום שגיאה על המסך.");
    process.exit(1);
  }

  console.log("✅ השרשרת שלמה — אירוע אמיתי עבר את כל הדרך:");
  console.log(`   Agent → HiveMQ → שרת → Supabase → Realtime`);
  console.log(`   אתר ${arrived.site_code} · ${arrived.type} · נכתב ${arrived.created_at.slice(11, 19)}`);
  process.exit(0);
})().catch((e) => { console.error("smoke-chain: נפל —", e.message); process.exit(1); });
