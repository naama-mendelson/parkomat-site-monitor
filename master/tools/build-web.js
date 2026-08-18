// tools/build-web.js — בונה את הדשבורד ומעתיק אותו ל-master/public.
//
// ============================================================
// ⚠️ למה זה קיים: מקומית לא היה שום שלב כזה
// ============================================================
// ב-Docker זה שורה אחת ב-Dockerfile (`COPY dashboard/dist master/public`),
// ולכן בייצור הבנדל תמיד תואם לקוד. **מקומית התיקייה הייתה עותק ידני**,
// היא ב-.gitignore, ואף פקודה לא רעננה אותה.
//
// ⚠️ ונמדד: הבנדל שהוגש ב-localhost:4000 היה בן יומיים ולא הכיל אף אחת
// מהכתיבות הישירות ל-Supabase. הכפתור "הכנס לתחזוקה" היה על המסך ופשוט
// לא עבד. אין כאן הודעת שגיאה להסתכל בה — הקוד החדש פשוט לא היה שם.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const DASHBOARD = path.join(ROOT, "dashboard");
const DIST = path.join(DASHBOARD, "dist");
const PUBLIC = path.join(ROOT, "master", "public");

// ⚠️ מריץ את הבינארי של Vite ישירות ולא דרך `npm run build`, ובלי shell.
// `npm` הוא סקריפט מעטפת, ולכן spawn שלו דורש `shell: true` — שמשרשר
// ארגומנטים בלי הברחה (DEP0190) — או `npm.cmd`, ששמו שונה בין מערכות
// **ואינו נפתר תחת Git Bash**. `node vite.js` הוא אותו קובץ בכל מערכת.
const VITE = path.join(DASHBOARD, "node_modules", "vite", "bin", "vite.js");
if (!fs.existsSync(VITE)) {
  console.error(`build-web: Vite לא נמצא ב-${VITE}. הריצי npm install ב-dashboard.`);
  process.exit(1);
}
const r = spawnSync(process.execPath, [VITE, "build"], { cwd: DASHBOARD, stdio: "inherit" });
if (r.status !== 0) {
  console.error("build-web: בניית הדשבורד נכשלה — master/public לא נגעו בו.");
  process.exit(1);
}

// ⚠️ מוחק את היעד לפני ההעתקה, ולא מעתיק מעליו. Vite מגבב את שמות
// הקבצים, ולכן העתקה-מעל משאירה את כל הבנדלים הישנים בתיקייה לנצח —
// והם ממשיכים להיות מוגשים למי שה-index.html שלו נשמר במטמון.
fs.rmSync(PUBLIC, { recursive: true, force: true });
fs.cpSync(DIST, PUBLIC, { recursive: true });

const assets = fs.readdirSync(path.join(PUBLIC, "assets"));
console.log(`\n✅ הדשבורד נבנה והועתק ל-master/public`);
for (const a of assets) console.log(`   ${a}`);
console.log("\n⚠️ בדפדפן: רענון רגיל מספיק (שם הקובץ השתנה), אך אם המסך לא");
console.log("   מתעדכן — Ctrl+Shift+R, כי index.html עצמו עלול להיות במטמון.");
