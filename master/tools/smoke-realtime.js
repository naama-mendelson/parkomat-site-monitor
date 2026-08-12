// tools/smoke-realtime.js — האם Realtime באמת מוסר אירועים לדפדפן.
//
//   PARITY_EMAIL=<מייל> PARITY_PASSWORD=<סיסמה> \
//     node --env-file=.env tools/smoke-realtime.js
//
// ============================================================
// למה בדיקה חיה, ולא "הטבלה בפרסום ולכן זה עובד"
// ============================================================
// Realtime מחליף את ה-SSE — כלומר את **הערוץ החי היחיד שנשאר** בין הדשבורד
// לשרת. אם הוא לא מוסר, המסך לא מתעדכן: אין שגיאה, אין סמל אפור, פשוט
// כרטיסים שקופאים על מצב ישן. זה הכשל המסוכן ביותר במסך ניטור, וכבר קרה
// כאן פעם אחת (אתר 3501 הציג "בפעולה" בזמן שהלוג הראה "מוכן").
//
// שלושה תנאים נדרשים ביחד, ורק אחד מהם נראה בקוד:
//   1. הטבלה בפרסום supabase_realtime          — נבדק ב-SQL
//   2. RLS מתיר למנוי לקרוא את השורה           — Realtime מכבד RLS
//   3. הערוץ באמת מגיע עד הלקוח                 — רק בדיקה חיה תראה
//
// ⚠️ הבדיקה **כותבת שורת events אמיתית** ואז מוחקת אותה. events היא טבלת
// אירועים עם רטנציה של 7 ימים, לא היסטוריה — שורה זמנית בה אינה מזיקה.
// היא מסומנת ב-site_code ייחודי כדי שלא תתבלבל עם אירוע אמיתי.

const fs = require("node:fs");
const path = require("node:path");
const db = require("../db/db");
const { createClient } = require("../../dashboard/node_modules/@supabase/supabase-js");

const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const pick = (k) => (ENV.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const SB_URL = pick("VITE_SUPABASE_URL");
const SB_KEY = pick("VITE_SUPABASE_PUBLISHABLE_KEY");

const MARKER = "__smoke_realtime__";
const TIMEOUT_MS = 15000;

(async () => {
  await db.init();

  const email = process.env.PARITY_EMAIL, password = process.env.PARITY_PASSWORD;
  if (!email || !password) {
    console.error("smoke-realtime: נדרשים PARITY_EMAIL ו-PARITY_PASSWORD.");
    process.exit(1);
  }

  // ---- 1. הטבלה בפרסום? ----
  const inPub = await db.prepare(
    "SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'events'"
  ).get();
  console.log(`  ${inPub ? "✔" : "✘"} events בפרסום supabase_realtime`);
  if (!inPub) process.exit(1);

  // ---- 2+3. מנוי אמיתי, כמו הדפדפן ----
  const supabase = createClient(SB_URL, SB_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({ email, password });
  if (authErr) { console.error(`  ✘ התחברות נכשלה: ${authErr.message}`); process.exit(1); }
  console.log(`  ✔ מחובר כ-${email}`);

  const got = new Promise((resolve) => {
    const channel = supabase
      .channel("smoke-events")
      .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "events" },
          (msg) => {
            if (msg?.new?.site_code === MARKER) resolve(msg.new);
          })
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        console.log("  ✔ הערוץ פתוח — כותב אירוע בדיקה");

        // ⚠️ הכתיבה **אחרי** SUBSCRIBED. אירוע שנכתב לפני שהמנוי הושלם לא
        // יגיע — Realtime אינו משחזר את מה שקרה לפני ההצטרפות, בדיוק כמו SSE.
        await db.prepare(
          `INSERT INTO events (site_id, site_code, type, payload, created_at)
           VALUES (NULL, ?, 'state', ?::jsonb, ?)`
        ).run(MARKER, JSON.stringify({ probe: true }), new Date().toISOString());
      });
    return channel;
  });

  const result = await Promise.race([
    got,
    new Promise((r) => setTimeout(() => r(null), TIMEOUT_MS)),
  ]);

  // ניקוי — תמיד, גם בכישלון
  await db.prepare("DELETE FROM events WHERE site_code = ?").run(MARKER);

  console.log(`\n${"=".repeat(60)}`);
  if (!result) {
    console.log(`❌ האירוע לא הגיע תוך ${TIMEOUT_MS / 1000}s`);
    console.log("   הדשבורד לא יתעדכן בזמן אמת — הכרטיסים יקפאו בלי שום שגיאה.");
    process.exit(1);
  }
  console.log(`✅ Realtime מוסר — האירוע הגיע עם payload: ${JSON.stringify(result.payload)}`);
  process.exit(0);
})().catch((e) => { console.error("smoke-realtime: נפל —", e.message); process.exit(1); });
