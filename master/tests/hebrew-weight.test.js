// ⚠️ אין טקסט עברי במשקל 800 ומעלה בדשבורד (13/10/2026).
//
// הגופן של הדשבורד ב-Windows הוא "Segoe UI", ואין לו משקל 800. אותיות עבריות ב-800/900 נופלות לגופן אחר —
// קטן יותר ושונה — ורק ספרות לטיניות נשארות ב-Segoe. כך נראה "טכני" בצילום המסך של בעלת המוצר במשימות.
// נמדד בדפדפן על כל המסכים (סריקה: כל אלמנט עם צומת טקסט עברי ומשקל מחושב ≥800), ותוקן ל-700.
//
// הבדיקה כאן סטטית: כל כלל CSS עם משקל ≥800 חייב להופיע ברשימה למטה, עם הסיבה שבגללה אין בו עברית —
// ספרות, סמלים או "Parkomat". כלל חדש במשקל כזה נכשל עד שמישהו בודק מה הוא מציג. שמות קבוצה ברשימה
// נפתחת (<option>) לא נתפסים בסריקה בדפדפן — רק כאן.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../dashboard/src");

// selector → מה מוצג בו (ולכן למה 800 בסדר)
const ALLOWED = {
  ".alert-unlock-mark": "Parkomat",
  ".anum-value": "מספר",
  ".cl-badge": "מספר ליקויים",
  ".cl-mini-sq": "סמל",
  ".cl-pill": "סמל המנורה",
  ".it-done-check": "✓",
  ".it-lamp": "סמל המנורה",
  ".pm-lamp": "סמל המנורה",
  ".pm-stepper-val": "מספר",
  ".pm-view-mark": "✓ / —",
  ".cf-item-check": "✓",
  ".donut-total": "מספר",
  ".logo-mark": "Parkomat",
  ".lb-rank": "מספר",
  ".lb-value": "אחוז",
  ".ring-percent": "אחוז",
  ".rv-brand": "Parkomat · SiteMonitor",
  ".exp-value": "מספר (הקטן, .exp-value--sm, הוא טקסט ו-700)",
  ".sys-chip-num": "מספר המערכת",
  ".filter-count": "מספר",
  ".tk-card-n": "מספר",
  ".tk-ico": "⏳ ✓ ✕",
  '.tk-sec[data-state="done"] .tk-mark::before': "✓",
  ".uptime-percent": "אחוז",
  ".ex-avail-v": "שעות (מספר)",
  ".sv-card-value": "מספר",
};

const cssFiles = (dir) => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? cssFiles(p) : n.endsWith(".css") ? [p] : [];
});

// כל הכללים עם משקל ≥800: selector + קובץ. בלי parser — הקבצים כאן פשוטים (אין @media מקוננים עם משקל).
function heavyRules() {
  const out = [];
  for (const f of cssFiles(SRC)) {
    const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const w = m[2].match(/font-weight\s*:\s*([^;]+)/);
      if (!w) continue;
      const v = w[1].trim();
      if (v === "bolder" || v === "800" || v === "900" || Number(v) >= 800) {
        for (const sel of m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean)) {
          out.push({ sel, file: path.relative(SRC, f).replace(/\\/g, "/") });
        }
      }
    }
  }
  return out;
}

test("כל כלל במשקל ≥800 מוכר — ואין בו טקסט עברי", () => {
  const rules = heavyRules();
  assert.ok(rules.length >= 20, `נמצאו רק ${rules.length} כללים — הקריאה נשברה?`);
  const unknown = rules.filter((r) => !(r.sel in ALLOWED));
  assert.deepEqual(unknown, [], "כלל חדש במשקל ≥800. אם הוא מציג עברית — 700; אם ספרות/סמלים — להוסיף ל-ALLOWED עם הסיבה");
});

test("הכללים שתוקנו ל-700 נשארו 700 (טקסט עברי)", () => {
  const rules = heavyRules().map((r) => r.sel);
  for (const sel of [".exp-name", ".exp-value--sm", ".it-due--late", ".it-due--soon", ".ex-head h1",
    ".ex-insights-btn", ".rv-header h1", ".pm-tpl-group", ".sft-select option.sft-group-row"]) {
    assert.ok(!rules.includes(sel), `${sel} חזר למשקל ≥800`);
  }
});

test("הרשימה אינה מחזיקה כללים שכבר אינם", () => {
  const present = new Set(heavyRules().map((r) => r.sel));
  const stale = Object.keys(ALLOWED).filter((s) => !present.has(s));
  assert.deepEqual(stale, [], "selector ב-ALLOWED שכבר אינו במשקל ≥800 — להסיר אותו");
});
