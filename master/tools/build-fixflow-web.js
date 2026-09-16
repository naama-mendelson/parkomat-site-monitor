// בונה את מסך FixFlow ומטמיע אותו בדשבורד תחת `/fixflow/`.
//
//   node --env-file=.env tools/build-fixflow-web.js
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
import { readFileSync, writeFileSync, rmSync, cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
function sourceDigest() {
  const h = createHash("sha256");
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === "dist") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(jsx?|mjs|css|html|json)$/.test(name) && name !== "package-lock.json") files.push(full);
    }
  };
  walk(join(FIXFLOW_WEB, "src"));
  walk(SHARED);
  files.push(join(FIXFLOW_WEB, "package.json"), join(FIXFLOW_WEB, "index.html"));
  for (const f of files.sort()) {
    h.update(relative(FIXFLOW_WEB, f).replace(/\\/g, "/"));
    h.update(readFileSync(f));
  }
  return { digest: h.digest("hex"), files: files.length };
}

const env = dashboardEnv();
for (const k of ["VITE_SUPABASE_URL"]) {
  if (!env[k]) { console.error(`❌ חסר ${k} ב-dashboard/.env`); process.exit(1); }
}

console.log(`  בונה מ-${FIXFLOW_WEB}`);
execFileSync("npm", ["run", "build", "--", "--base=/fixflow/", "--outDir=dist"], {
  cwd: FIXFLOW_WEB,
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? "",
  },
});

const dist = join(FIXFLOW_WEB, "dist");
if (!existsSync(join(dist, "index.html"))) { console.error("❌ הבנייה לא ייצרה index.html"); process.exit(1); }

rmSync(OUT, { recursive: true, force: true });
cpSync(dist, OUT, { recursive: true });

const { digest, files } = sourceDigest();
writeFileSync(join(OUT, "manifest.json"),
  JSON.stringify({ builtAt: new Date().toISOString(), sourceDigest: digest, sourceFiles: files }, null, 2));

console.log(`\n  ✅ הוטמע ב-dashboard/public/fixflow/  (${files} קבצי מקור · ${digest.slice(0, 12)})`);
console.log(`  אימות:  node tools/check-fixflow-web-fresh.js`);
