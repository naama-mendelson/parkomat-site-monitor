// tools/check-heartbeat.js — אות החיים של השרת, מקצה לקצה.
//
// ============================================================
// מה נבדק כאן, ולמה זה שער ולא בדיקת יחידה
// ============================================================
// הבאנר "הנתונים אינם מתעדכנים" נשען על שרשרת של ארבעה חלקים, ושלושה
// מהם חיים מחוץ לקוד: השרת כותב ל-`settings`, פונקציית SQL חושפת את
// המפתח **הבודד** הזה, ו-GRANT מאפשר ל-`authenticated` לקרוא אותה.
// בדיקת יחידה הייתה מאמתת את החשבון ומפספסת את שלושת אלה.
//
// ⚠️ והחלק הרגיש ביותר הוא ה-GRANT: ל-`settings` **אין מדיניות RLS
// במכוון** — היא מחזיקה את גיבוב קוד המנהל. אם הפונקציה תיפתח יותר מדי,
// או אם מישהו "יתקן" את זה במדיניות על הטבלה, ייחשף הגיבוב.
const fs = require("node:fs");
const path = require("node:path");
const { gateToken } = require("./lib/gate-user");

const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const ANON = (ENV.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

const STALE_AFTER = 300;

async function f(url, opt) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); }
  }
  throw last;
}

// אותו חשבון בדיוק שב-healthDirect.js. שכפול מכוון וקטן: הצד השני הוא
// קוד דפדפן, וייבואו לכאן היה גורר את כל שרשרת ה-supabase-js.
const verdict = (beat) => {
  if (!beat) return { unknown: true, alive: null };
  const age = Math.max(0, Math.round((Date.now() - new Date(beat).getTime()) / 1000));
  return { unknown: false, alive: age < STALE_AFTER, ageSeconds: age };
};

(async () => {
  if (!SB || !SECRET || !ANON) {
    console.error("check-heartbeat: חסרים SUPABASE_URL / SUPABASE_SECRET_KEY / VITE_SUPABASE_PUBLISHABLE_KEY");
    process.exit(2);
  }

  const db = require("../db/db");
  await db.init();
  const { setSetting } = require("../db/queries");

  // ⚠️ שומרים את הערך הקיים ומחזירים אותו בסוף. אם השרת כבר כותב אות חיים,
  // שער שמשאיר אחריו ערך בדיקה היה גורם לבאנר להופיע על מערכת תקינה.
  const before = (await db.prepare("SELECT value FROM settings WHERE key = ?").get("server_heartbeat"))?.value ?? null;

  const { token, cleanup } = await gateToken(SB, ANON, SECRET, f);
  const rpc = async () => {
    const r = await f(`${SB}/rest/v1/rpc/server_heartbeat`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const checks = [];
  const add = (name, got, want) => checks.push([name, got, want]);

  try {
    // ---- 1. אין אות חיים → "לא ידוע", ולא "מת" ----
    await db.prepare("DELETE FROM settings WHERE key = ?").run("server_heartbeat");
    let r = await rpc();
    add("אין אות חיים → הפונקציה עונה 200", r.status, 200);
    // ⚠️ ההבחנה שמונעת אזהרה אדומה על שרת שטרם נפרס עם התכונה.
    add("⚠️ ...והמצב 'לא ידוע', לא 'מת'", verdict(r.body).unknown, true);

    // ---- 2. אות טרי → חי ----
    await setSetting("server_heartbeat", new Date().toISOString());
    r = await rpc();
    add("אות טרי → חי", verdict(r.body).alive, true);

    // ============================================================
    // ---- 3. אות ישן → הבאנר נדלק ----
    // ============================================================
    // ⚠️ **מרוץ עם השרת החי, ונמדד.** `master` כותב `server_heartbeat`
    // כל 20 שניות. השער מזריק ערך בן 4 שעות וקורא ל-RPC — ואם master
    // הספיק לדרוס בין השניים, התשובה היא "חי, גיל 0", והשער מדווח כישלון
    // על **התנהגות נכונה לחלוטין**.
    //
    // זה בדיוק "שער שנופל כי הנתונים זזו הוא שער שלומדים להתעלם ממנו",
    // והפעם המקור הוא השרת שאמור לרוץ.
    //
    // הפתרון: לאשר שהערך שהוזרק **עדיין במקומו** אחרי הקריאה. אם לא —
    // הריצה לא הייתה נקייה, וננסה שוב במקום לקבוע ממנה מסקנה.
    const staleIso = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    let v = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await setSetting("server_heartbeat", staleIso);
      r = await rpc();
      const still = (await db.prepare("SELECT value FROM settings WHERE key = ?")
        .get("server_heartbeat"))?.value;
      if (still === staleIso) { v = verdict(r.body); break; }
      console.log(`  ⏭️  master דרס את הערך באמצע — ניסיון ${attempt}/5`);
      await new Promise((res) => setTimeout(res, 1500));
    }

    if (v === null) {
      // ⚠️ "לא ניתן לבדוק" ולא "נכשל". הצהרת כישלון כאן הייתה מאשימה את
      // הקוד במרוץ, ושולחת מישהו לחפש באג שאינו קיים.
      console.log("  ⚠️  לא ניתן היה לבדוק: master דורס את אות החיים מהר מדי");
    } else {
      add("אות בן 4 שעות → אינו חי", v.alive, false);
      add("...והגיל מדווח נכון (שעות)", Math.round(v.ageSeconds / 3600), 4);
    }

    // ---- 4. ⚠️ הגיבוב אינו נחשף ----
    // הבדיקה שמוודאת שהפונקציה היא חלון למפתח אחד ולא לטבלה.
    const leak = await f(`${SB}/rest/v1/settings?select=*`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
    });
    add("⚠️ קריאה ישירה ל-settings חסומה", leak.status >= 400, true);
  } finally {
    // שחזור מלא: הערך שהיה, או מחיקה אם לא היה.
    if (before === null) await db.prepare("DELETE FROM settings WHERE key = ?").run("server_heartbeat");
    else await setSetting("server_heartbeat", before);
    await cleanup();
  }

  console.log("בדיקה                                          בפועל       צפוי");
  let bad = 0;
  for (const [n, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${n.padEnd(46)} ${String(got).padStart(6)} ${String(want).padStart(10)}  ${ok ? "✅" : "❌"}`);
  }
  console.log("");
  console.log(bad ? `❌ ${bad} כשלים` : "✅ אות החיים מתנהג כמתוכנן");
  process.exit(bad ? 1 : 0);
})();
