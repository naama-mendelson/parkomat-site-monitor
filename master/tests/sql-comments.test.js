// tests/sql-comments.test.js — הערת JS בתוך מחרוזת SQL.
//
// ============================================================
// ⚠️ הבדיקה הזו נולדה מאובדן של כל התקלות במערכת
// ============================================================
// ב-getActiveMaintenance נכתבה הערה בסגנון JavaScript בתוך מחרוזת SQL.
// ב-SQL הערה היא "--", ולכן Postgres החזיר: syntax error at or near "//".
//
// ⚠️ **והפונקציה נקראת רק בענף ה-error.** התוצאה: כל הודעת תקלה מכל אתר
// נכשלה, נוסתה חמש פעמים, ואז ננטשה — כלומר PUBACK ומחיקה מ-HiveMQ
// **לתמיד**. נמדד: 19 תקלות אבודות ב-8 אתרים ביממה, ואתר שהציג "פעולה
// תקינה" בזמן שהיה בתקלה.
//
// ⚠️ **ולא נתפס בשום בדיקה קיימת**, כי כל השאר עוברות: ready, operating
// ו-no_comm אינם נוגעים בפונקציה. רק תקלה — כלומר בדיוק המקרה שהמערכת
// קיימת בשבילו.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DIRS = ["db", "ingestion", "api", "ai", "auth", "tools"];
const TICK = String.fromCharCode(96);

function jsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== "node_modules") walk(p);
      else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
    }
  };
  const full = path.join(ROOT, dir);
  if (fs.existsSync(full)) walk(full);
  return out;
}

const SQL_WORD = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE)\b/i;

test("⚠️ אין הערת // בתוך מחרוזת SQL", () => {
  const bad = [];
  for (const dir of DIRS) {
    for (const file of jsFiles(dir)) {
      const src = fs.readFileSync(file, "utf8");
      // ⚠️ פיצול לפי גרש אחורי במקום רגקס: כל ניסיון לתפוס literal ברגקס
      // דורש תווי בריחה, והם בדיוק מה שנשבר בכתיבת הקובץ הזה.
      const parts = src.split(TICK);
      let line = 1;
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1 && SQL_WORD.test(parts[i])) {
          parts[i].split("\n").forEach((l, k) => {
            if (/^\s*\/\//.test(l)) {
              bad.push(`${path.relative(ROOT, file)}:${line + k}  ${l.trim().slice(0, 55)}`);
            }
          });
        }
        line += parts[i].split("\n").length - 1;
      }
    }
  }
  assert.deepEqual(bad, [],
    "הערת JS בתוך SQL — Postgres יחזיר syntax error וההודעה תאבד:\n  " + bad.join("\n  "));
});

test("⚠️ getActiveMaintenance נקייה — היא בנתיב התקלה", () => {
  // שגיאה בפונקציה הזו שקטה לחלוטין עד הרגע שבו היא הכי יקרה.
  const src = fs.readFileSync(path.join(ROOT, "db", "queries.js"), "utf8");
  const i = src.indexOf("async function getActiveMaintenance(siteId)");
  assert.ok(i >= 0, "getActiveMaintenance נעלמה");
  const body = src.slice(i, src.indexOf("\n}", i));
  assert.doesNotMatch(body, /^\s*\/\//m, "יש הערת // בגוף getActiveMaintenance");
});
