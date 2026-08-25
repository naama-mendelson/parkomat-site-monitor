// totp-code.js — מחולל קוד אימות דו-שלבי מהטרמינל.
//
// ============================================================
// למי זה נועד
// ============================================================
// מי שאין לו טלפון חכם ואינו רוצה תוסף דפדפן. TOTP הוא אלגוריתם ולא
// מכשיר: אותו מפתח מייצר את אותם קודים בכל מימוש.
//
// ⚠️ **וזה חלש יותר מטלפון, וצריך לומר את זה.** הסוד נשמר בקובץ טקסט על
// אותו מחשב שממנו מתחברים. מי שמשתלט על המחשב מקבל גם את הסיסמה (אם היא
// שמורה בדפדפן) וגם את הגורם השני — כלומר ההפרדה שנותנת ל-2FA את ערכו
// המלא אינה קיימת כאן.
//
// ⚠️ **אבל הוא כן עוצר את האיום הסביר ביותר:** סיסמה שנגנבת מרחוק —
// פישינג, סיסמה שחוזרת באתר אחר, רשימה דלופה. התוקף בתרחישים האלה מקבל
// סיסמה, לא מחשב. עדיף בהרבה על כלום, ופחות טוב ממכשיר נפרד.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { totp } = require("./lib/totp");

// ⚠️ בתיקיית הבית ולא בפרויקט: המאגר ציבורי, וקובץ סוד בתוך עץ העבודה
// הוא תאונה שמחכה לקרות. .gitignore מגן, אבל `git add -f` עוקף אותו.
const FILE = path.join(os.homedir(), ".parkomat-totp");

const arg = process.argv[2];

if (arg === "--save") {
  const secret = (process.argv[3] || "").replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z2-7]{16,}$/.test(secret)) {
    console.error("מפתח לא תקין. הדבק את המפתח מהדשבורד (אותיות וספרות, בלי רווחים).");
    process.exit(1);
  }
  fs.writeFileSync(FILE, secret, { mode: 0o600 });
  console.log(`נשמר: ${FILE}`);
  console.log(`קוד נוכחי: ${totp(secret)}`);
  process.exit(0);
}

if (arg === "--forget") {
  if (fs.existsSync(FILE)) { fs.unlinkSync(FILE); console.log("הסוד נמחק."); }
  else console.log("לא היה סוד שמור.");
  process.exit(0);
}

if (!fs.existsSync(FILE)) {
  console.error("אין מפתח שמור. הרץ תחילה:");
  console.error("  node tools/totp-code.js --save <המפתח-מהדשבורד>");
  process.exit(1);
}

const secret = fs.readFileSync(FILE, "utf8").trim();
const code = totp(secret);
// כמה שניות נשארו לחלון הנוכחי — כדי שלא יוקלד קוד שפג באמצע ההקלדה.
const left = 30 - (Math.floor(Date.now() / 1000) % 30);

console.log("");
console.log(`   ${code.slice(0, 3)} ${code.slice(3)}`);
console.log("");
console.log(`   תקף עוד ${left} שניות${left <= 5 ? "  ⚠️ המתן לקוד הבא" : ""}`);
console.log("");
