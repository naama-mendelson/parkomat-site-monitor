// בונה את מסך FixFlow ומטמיע אותו בדשבורד תחת `/fixflow/`.
//
//   node tools/build-fixflow-web.js
//
// ⚠️ **בלי `--env-file`.** הכלי קורא את `dashboard/.env` בעצמו (ראה למטה), ו-
// `master/.env` מחזיק סודות של ייצור שלבנייה של מסך סטטי אין בהם שום צורך.
//
// ============================================================
// ⚠️ למה הבנייה מוטבעת ולא נבנית ב-Cloudflare
// ============================================================
// Cloudflare Pages בונה את הריפו הזה בלבד, ו-FixFlow יושבת בתיקייה אחרת על
// המחשב. לכן התוצר נבנה כאן ונדחף עם הדשבורד.
//
// ⚠️ **ותוצר בנייה שנשמר בגיט הוא תצלום שמתיישן — בדיוק מה שהפרויקט הזה
// נלחם בו לאורך כל הדרך.** ההבדל היחיד שהופך את זה למקובל הוא ש**ההתיישנות
// צועקת**: `manifest.json` שומר תקציר של כל קובץ מקור,
// ו-`check-fixflow-web-fresh.js` נכשל ברגע שהמקור השתנה והבנייה לא.
// תצלום שמתיישן בשקט הוא באג; תצלום שמודיע שהוא ישן הוא שלב ביניים.
//
// ⚠️ **אותו origin, ובכוונה.** `/fixflow/` יושב תחת הדומיין של הדשבורד, ולכן
// `localStorage` משותף — כלומר ההתחברות של המוקדן עוברת, ואיש אינו מתבקש
// להתחבר פעמיים באמצע אירוע.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, cpSync, existsSync, readdirSync, statSync, mkdtempSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
// ⚠️ `fileURLToPath` ולא `.pathname`: הנתיב כאן מכיל עברית, ו-`.pathname`
// מחזיר אותה מקודדת ב-%XX — מה שנותן נתיב שנראה תקין ואינו קיים.
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const FIXFLOW_WEB = process.env.FIXFLOW_WEB_DIR || "C:/Users/נעמהמנדלסון/Documents/FixFlow/web";
const SHARED = join(FIXFLOW_WEB, "..", "shared");
const OUT = fileURLToPath(new URL("../../dashboard/public/fixflow/", import.meta.url));

// ⚠️ המשתנים נלקחים מ-`dashboard/.env` ולא מוגדרים כאן. שני מקורות אמת
// לכתובת Supabase פירושם שיום אחד המסך יקרא מפרויקט אחר מהדשבורד שלצדו.
function dashboardEnv() {
  const p = fileURLToPath(new URL("../../dashboard/.env", import.meta.url));
  const txt = readFileSync(p, "utf8");
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    if (!line.includes("=") || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// תקציר של כל קובץ מקור שמשפיע על התוצר.
//
// ⚠️ **"משפיע על התוצר" היה צר מדי.** התקציר כיסה את `src`, `shared`,
// `package.json` ו-`index.html` — ולא את שלושת אלה, שכל אחד מהם משנה את מה
// שנבנה בלי לגעת באף קובץ שנספר:
//
//   `vite.config.js`     — תוספים, הגדרות בנייה
//   `package-lock.json`  — הגרסה המדויקת של כל תלות שנכנסת לחבילה
//                          (`package.json` אומר `^2.116.0`; הנעילה אומרת מה נבנה)
//   `public/`            — מועתקת כמות שהיא לתוצר (הלוגו, למשל), בכל סיומת
//
// שינוי באחד מהם השאיר את השער ירוק על בנייה ישנה — בדיוק השקט שהשער קיים
// כדי לשבור.
function sourceDigest() {
  const h = createHash("sha256");
  const files = [];
  const walk = (dir, all = false) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === "dist") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, all);
      else if (all || (/\.(jsx?|mjs|css|html|json)$/.test(name) && name !== "package-lock.json")) files.push(full);
    }
  };
  walk(join(FIXFLOW_WEB, "src"));
  walk(SHARED);
  if (existsSync(join(FIXFLOW_WEB, "public"))) walk(join(FIXFLOW_WEB, "public"), true);
  files.push(
    join(FIXFLOW_WEB, "package.json"),
    join(FIXFLOW_WEB, "package-lock.json"),
    join(FIXFLOW_WEB, "index.html"),
    join(FIXFLOW_WEB, "vite.config.js")
  );
  for (const f of files.sort()) {
    h.update(relative(FIXFLOW_WEB, f).replace(/\\/g, "/"));
    h.update(readFileSync(f));
  }
  return { digest: h.digest("hex"), files: files.length };
}

const env = dashboardEnv();
// ============================================================
// ⚠️ גם המפתח חובה — לא רק הכתובת
// ============================================================
// הכלי דרש את `VITE_SUPABASE_URL` בלבד, והעביר את המפתח כ-`?? ""`. אבל
// `supabase.js` ב-FixFlow קובע `SUPABASE_READY = Boolean(url && key)`: מפתח ריק
// = **מסלול השרת המקומי**, שקורא `/api/read/...` — כתובת שאינה קיימת בדומיין
// של הדשבורד. הבנייה עברה, השער עבר (ראה check-fixflow-web-fresh.js), והמסך
// היה שבור בשטח.
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
if (!url) { console.error("❌ חסר VITE_SUPABASE_URL ב-dashboard/.env"); process.exit(1); }
if (!key) {
  console.error("❌ חסר VITE_SUPABASE_PUBLISHABLE_KEY (או VITE_SUPABASE_ANON_KEY) ב-dashboard/.env");
  console.error("   בלעדיו המסך נבנה במסלול השרת המקומי, שאינו קיים תחת /fixflow/.");
  process.exit(1);
}

// ============================================================
// ⚠️ הבנייה יוצאת לתיקייה זמנית — לא ל-`web/dist`
// ============================================================
// `web/dist` הוא מה ששרת ה-Express של FixFlow מגיש במשרד (server.js). הכלי
// כתב לשם בנייה עם `base=/fixflow/`, ולכן **כל הרצה שלו שברה את המסך המקומי**:
// הדף ביקש `/fixflow/assets/...` מהשרת שמגיש מהשורש, וקיבל דף ריק. וזה המסך
// היחיד שבו לשוניות הניהול (ייבוא, שיוך אתרים) עובדות.
const dist = mkdtempSync(join(tmpdir(), "fixflow-web-"));

console.log(`  בונה מ-${FIXFLOW_WEB}`);
let failed = null;
try {
  execFileSync("npm", ["run", "build", "--", "--base=/fixflow/", `--outDir="${dist}"`, "--emptyOutDir"], {
    cwd: FIXFLOW_WEB,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: url,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
      // ⚠️ מתג היציאה של FixFlow (`VITE_FIXFLOW_READ=server`) אסור שיזלוג לכאן
      // מהסביבה של מי שמריץ: הבנייה הזו היא Supabase בהגדרה.
      VITE_FIXFLOW_READ: "",
    },
  });

  if (!existsSync(join(dist, "index.html"))) throw new Error("הבנייה לא ייצרה index.html");

  rmSync(OUT, { recursive: true, force: true });
  cpSync(dist, OUT, { recursive: true });
} catch (e) {
  failed = e;
} finally {
  // ⚠️ `process.exit` בתוך `try` מדלג על `finally` — לכן הכשל נשמר ויוצאים אחרי.
  rmSync(dist, { recursive: true, force: true });
}
if (failed) { console.error(`❌ ${failed.message}`); process.exit(1); }

const { digest, files } = sourceDigest();
writeFileSync(join(OUT, "manifest.json"),
  JSON.stringify({ builtAt: new Date().toISOString(), sourceDigest: digest, sourceFiles: files }, null, 2));

console.log(`\n  ✅ הוטמע ב-dashboard/public/fixflow/  (${files} קבצי מקור · ${digest.slice(0, 12)})`);
console.log(`  אימות:  node tools/check-fixflow-web-fresh.js`);
