// מסך FixFlow שמוטמע בדשבורד — שהוא באמת מה שיושב בקוד המקור.
//
//   node tools/check-fixflow-web-fresh.js
//
// ============================================================
// ⚠️ זה השער שהופך תוצר בנייה שמור למותר
// ============================================================
// `dashboard/public/fixflow/` הוא תצלום: הוא נבנה על המחשב ונדחף עם הדשבורד,
// כי Cloudflare Pages בונה את הריפו הזה בלבד ו-FixFlow יושבת בתיקייה אחרת.
//
// תצלום שמתיישן בשקט הוא בדיוק הכשל שהפרויקט הזה נלחם בו לאורך כל הדרך:
// מישהו מתקן את המסך, רואה את התיקון אצלו, ולא מבין למה בשטח שום דבר לא
// השתנה. השער הזה הופך את השקט לצעקה — הוא נכשל ברגע שקובץ מקור אחד
// השתנה והבנייה לא רצה.
//
// ⚠️ **והוא בודק תוכן, לא תאריך.** השוואת זמני קבצים נשברת על `git clone`
// (שמעדכן את כולם) ועל העתקה בין מכונות. תקציר תוכן אינו נשבר על אף אחד
// משניהם.
//
// ⚠️ **ובנוסף: שהחבילה באמת מצביעה ל-Supabase.** בנייה שרצה בלי המשתנים
// מייצרת מסך שנראה תקין לגמרי ומחזיר רשימה ריקה — כלומר "אין תקלות ידועות".
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const FIXFLOW_WEB = process.env.FIXFLOW_WEB_DIR || "C:/Users/נעמהמנדלסון/Documents/FixFlow/web";
const SHARED = join(FIXFLOW_WEB, "..", "shared");
const OUT = fileURLToPath(new URL("../../dashboard/public/fixflow/", import.meta.url));

let failures = 0;
const check = (label, ok, detail) => {
  console.log((ok ? "✅ " : "❌ ") + label + (detail ? `   ${detail}` : ""));
  if (!ok) failures++;
};

// ⚠️ מועתק מ-`build-fixflow-web.js` **בכוונה, וזו לא כפילות שאפשר לאחד**:
// שער שמייבא את פונקציית התקציר מהכלי שהוא בודק מסכים איתו תמיד. אם השניים
// יסטו זה מזה — השער ייכשל, וזה הסימן הנכון.
function sourceDigest() {
  const h = createHash("sha256");
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === "dist") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
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

const manifestPath = join(OUT, "manifest.json");
check("הבנייה המוטבעת קיימת", existsSync(manifestPath));
if (!existsSync(manifestPath)) {
  console.error("\n   הרץ:  node tools/build-fixflow-web.js");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const now = sourceDigest();
check("הבנייה תואמת את קוד המקור", manifest.sourceDigest === now.digest,
  manifest.sourceDigest === now.digest
    ? `${now.files} קבצים · ${now.digest.slice(0, 12)}`
    : `נבנה מ-${String(manifest.sourceDigest).slice(0, 12)} · המקור כעת ${now.digest.slice(0, 12)} — הרץ build-fixflow-web.js`);

// ---- מה שבאמת נכנס לחבילה --------------------------------------------
const assets = join(OUT, "assets");
const js = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith(".js")) : [];
check("יש חבילת JS", js.length > 0, js.join(", "));

if (js.length) {
  const bundle = readFileSync(join(assets, js[0]), "utf8");
  // ⚠️ כתובת Supabase — בלעדיה המסך נטען ומציג רשימה ריקה בלי שום שגיאה.
  check("⚠️ כתובת Supabase נצרבה בחבילה", /supabase\.co/.test(bundle));
  // ⚠️ שמות הטבלאות. בנייה שנפלה חזרה למסלול השרת לא תכיל אותם, והמסך
  // ינסה לפנות ל-`/api/read` שאינו קיים בדומיין של הדשבורד.
  check("⚠️ החבילה קוראת את טבלאות ff_", /ff_faults/.test(bundle) && /ff_site_fault_overrides/.test(bundle));
  // ⚠️ הנתיב `/fixflow/` — בנייה עם base ברירת מחדל מבקשת `/assets/...`
  // מהשורש, כלומר מהדשבורד, ומקבלת HTML במקום JS.
  const html = readFileSync(join(OUT, "index.html"), "utf8");
  check("⚠️ נבנה עם base=/fixflow/", /\/fixflow\/assets\//.test(html));
}

console.log(failures ? `\n❌ ${failures} כשלים` : "\n✅ הכל עבר");
process.exit(failures ? 1 : 0);
