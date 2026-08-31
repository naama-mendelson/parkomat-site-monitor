// tools/check-scope-master.js — מה master באמת מגיש.
//
// ============================================================
// ⚠️ למה שער ולא ספירה חד-פעמית
// ============================================================
// ההחלטה היא ש-master מכיל **קליטת MQTT, הבוט וגיבוי — ותו לא**.
// החלטה כזו נשחקת בשקט: מישהו יוסיף נתיב "רק כדי לבדוק משהו", והוא
// יישאר. שנה אחר כך אף אחד לא יזכור שהייתה החלטה.
//
// ⚠️ **הבדיקה טוענת את routes.js ומונה נתיבים בפועל** — לא סורקת טקסט.
// סריקת טקסט הייתה מפספסת נתיב שנרשם בלולאה או דרך router נוסף, וזה
// בדיוק הסוג שנשכח.
//
// ⚠️ `require` על routes.js **אינו מאזין** — הוא מייצא `startApiServer`.
// זה חשוב: הפעלת השרת כאן הייתה תופסת את נעילת המופע היחיד ומנתקת את
// הייצור (ראה db/single-instance.js).
const path = require("node:path");

// מה שמותר להישאר. ⚠️ `/health` נשאר לא כי הוא "קטן" אלא כי הכפתור
// בשולחן העבודה של השרת ו-deploy.ps1 מוודאים דרכו שהקליטה חיה —
// "הקונטיינר רץ" אינו "השרת עובד".
const ALLOWED = new Set([
  "/api/chat",   // הבוט
  "/health",     // בדיקת חיים — הכפתור והפריסה
]);

function routesOf(app) {
  const out = [];
  const stack = app?._router?.stack || app?.router?.stack || [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods || {})
      .filter((m) => layer.route.methods[m])
      .map((m) => m.toUpperCase());
    for (const m of methods) out.push({ method: m, path: layer.route.path });
  }
  return out;
}

(async () => {
  console.log("=== check-scope-master ===\n");

  let mod;
  try {
    mod = require(path.join(__dirname, "..", "api", "routes.js"));
  } catch (e) {
    console.log(`❌ לא ניתן לטעון את routes.js — ${e.message}`);
    process.exit(1);
  }

  const app = mod.app || mod.__app;
  if (!app) {
    // ⚠️ אם routes.js אינו חושף את ה-app, אי אפשר למנות נתיבים — והשער
    // ידווח **"לא רץ"** ולא "עבר". שער שאינו יכול לבדוק אינו אישור.
    console.log("⚠️  routes.js אינו מייצא את ה-app — לא ניתן למנות נתיבים.");
    console.log("    הוסיפו `app` ל-module.exports כדי שהשער יוכל לרוץ.");
    process.exit(2);
  }

  const found = routesOf(app);
  const extra = found.filter((r) => !ALLOWED.has(r.path));

  console.log(`נתיבים רשומים: ${found.length}`);
  for (const r of found) {
    const ok = ALLOWED.has(r.path);
    console.log(`  ${ok ? "✅" : "❌"} ${r.method.padEnd(6)} ${r.path}`);
  }

  console.log("");
  if (extra.length === 0) {
    console.log("✅ master מגיש רק את הבוט ואת בדיקת החיים.");
    process.exit(0);
  }
  console.log(`❌ ${extra.length} נתיבים שאינם אמורים להיות כאן.`);
  console.log("   ההחלטה: master מכיל קליטת MQTT, הבוט וגיבוי בלבד.");
  process.exit(1);
})();
