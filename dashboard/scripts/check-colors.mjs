// scripts/check-colors.mjs — שומר על אחידות הצבעים.
//
// למה זה קיים: פעמיים כבר קרה שהוספתי צבע לפלטה ובלי לשים לב הוא יצא
// זהה (או כמעט זהה) לצבע אחר שמופיע *באותו מקרא* — פעם "בתחזוקה" מול
// "יציאת רכב", ופעם "כניסה" מול "בפעולה". העין תופסת את זה, אבל רק אחרי
// שהמשתמשת רואה את המסך. הבדיקה הזו תופסת את זה קודם.
//
// הרעיון: ההתנגשות מסוכנת רק *בתוך קבוצה* — כלומר בין צבעים שמופיעים
// יחד באותו גרף/מקרא. אותו אדום בתגית מצב ובגרף אחר הוא בסדר גמור.
//
//   npm run check:colors
import { readFileSync } from "node:fs";
import { BRAND, STATUS_COLORS, DIRECTION_COLORS, METRIC_COLORS, STUCK_COLOR, UPTIME_COLORS, COMPLIANCE_STATES } from "../src/utils/constants.js";
import { GLYPH } from "../src/utils/compliance.js";

const MIN_DELTA_E = 25;   // מתחת לזה — שני הצבעים נקראים כאותו צבע במבט חטוף
const MIN_CONTRAST = 3;   // מול רקע הכרטיס הכהה — אחרת הקו בגרף פשוט נעלם
const DARK_CARD = "#182238";

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function lab(hexColor) {
  const f = (v) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
  const [r, g, b] = rgb(hexColor).map(f);
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.9505;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.089;
  const k = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * k(Y) - 16, 500 * (k(X) - k(Y)), 200 * (k(Y) - k(Z))];
}

const deltaE = (a, b) => {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

const luminance = (hexColor) => {
  const [r, g, b] = rgb(hexColor).map((v) => {
    v /= 255;
    return v > 0.03928 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// קבוצה = צבעים שמופיעים יחד באותו גרף/מקרא, ולכן חייבים להיות נבדלים.
const GROUPS = {
  "כיוון תנועה (גרף הפעולות)": DIRECTION_COLORS,
  "מדדים (גרף המגמה — אפשר לבחור כמה יחד)": METRIC_COLORS,
  // תג "ייתכן תקוע" מוצג ליד תגית המצב על אותו כרטיס, ולכן הוא נבדק *בתוך*
  // הקבוצה הזו: אם הוא ייראה כמו אחד המצבים, הוא ייקרא כמצב שישי.
  "מצבי אתר (דונאט + תגיות)": {
    ...Object.fromEntries(Object.entries(STATUS_COLORS).map(([k, v]) => [k, v.dot])),
    stuck: STUCK_COLOR.dot,
  },
  "שורת הזמינות (UptimeBar)": UPTIME_COLORS,
  // ⚠️ מנורות הבודק/תחזוקה **אינן** כאן: הצבע שלהן הוא מילוי + מסגרת + סימן, לכל נושא בנפרד,
  // וצהוב מול "צהוב חזק" נבדלים בעוצמה ולא בגוון. הן נמדדות למטה, כפי שהן מוצגות.
};

// הערה למי שיחשוב לצבוע שני מקטעים באותה משפחת גוונים כדי "לקבץ" אותם:
// זה נוסה בשורת הזמינות (מוכן/בפעולה בשני ירוקים) ולא עבד — צבע דומה אומר
// "אלה שייכים יחד" אבל לא אומר *מה זה*, והשאלה הראשונה על המסך הייתה "מה
// הירוק הכהה הזה?". הקיבוץ הוא תפקיד המקרא (שורות-משנה), לא תפקיד הגוון.
// לכן הכלל כאן נשאר אחד ופשוט: צבעים באותה קבוצה חייבים להיות נבדלים.

let failures = 0;

for (const [group, colors] of Object.entries(GROUPS)) {
  console.log(`\n${group}`);
  const keys = Object.keys(colors);

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const [a, b] = [keys[i], keys[j]];
      // כפילות מכוונת (maintenance / maintenanceHours = אותו מדד בשני שמות)
      if (colors[a] === colors[b]) continue;

      const d = deltaE(colors[a], colors[b]);
      if (d < MIN_DELTA_E) {
        failures++;
        console.log(`   ❌ ${a} ↔ ${b}: ΔE ${d.toFixed(1)} — קרובים מדי (${colors[a]} / ${colors[b]})`);
      }
    }
  }

  for (const [name, color] of Object.entries(colors)) {
    const c = contrast(color, DARK_CARD);
    if (c < MIN_CONTRAST) {
      failures++;
      console.log(`   ❌ ${name}: ניגודיות ${c.toFixed(2)} מול הרקע הכהה — ייעלם בגרף (${color})`);
    }
  }

  if (!failures) console.log("   ✓ כל הצבעים נבדלים וקריאים");
}

// ============================================================
// מנורות בודק/תחזוקה — כפי שהן מוצגות, בשני הנושאים
// ============================================================
// הערכים נקראים מ-ComplianceLights.css עצמו (שני בלוקי הנושא), כדי שהבדיקה תמדוד את מה
// שמוצג ולא עותק שלו שיכול לסטות. לכל מצב: מילוי, מסגרת וסימן. נבדק:
//   • כל המשתנים קיימים וניתנים לקריאה — ערך שלא נקרא נכשל, לא "עובר" (NaN < 25 הוא false).
//   • הסימן קריא על המילוי (4.5:1) — כפי שהמילוי נראה מעל הכרטיס.
//   • כל שני מצבים נבדלים (ΔE ≥ 25) במילוי או במסגרת — כפי שהם נראים מעל הכרטיס.
//     בעלת המוצר, 06/10/2026: "אני רוצה שכל הצבעים יהיה ברור איזה צבע הם".
//   • לכל מצב גליף אחר — הצבע לעולם אינו הסימן היחיד.
{
  const LIGHT_CARD = "#ffffff";
  const MIN_TEXT = 4.5;
  const css = readFileSync(new URL("../src/components/Compliance/ComplianceLights.css", import.meta.url), "utf8");
  const block = (selector) => {
    const at = css.indexOf(selector);
    if (at === -1) return null;
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    const vars = {};
    for (const m of css.slice(open + 1, close).matchAll(/(--cl-[a-z-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
    return vars;
  };
  // ערך → hex כפי שהעין רואה אותו מעל `under`. null = לא נקרא (נכשל).
  const paint = (value, under) => {
    if (!value) return null;
    if (value === "transparent") return under;
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
    const m = value.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
    if (!m) return null;
    const [r, g, b, a] = m.slice(1).map(Number);
    const u = rgb(under);
    return "#" + [r, g, b].map((v, k) => Math.round(v * a + u[k] * (1 - a)).toString(16).padStart(2, "0")).join("");
  };
  const themes = [
    ["בהיר", block("[data-theme=\"light\"] {"), LIGHT_CARD],
    ["כהה", block("[data-theme=\"dark\"] {"), DARK_CARD],
  ];
  console.log("\nמנורות בודק/תחזוקה — כפי שהן מוצגות");
  let localFail = 0;
  const bad = (msg) => { localFail++; console.log(`   ❌ ${msg}`); };
  for (const [name, vars, card] of themes) {
    if (!vars) { bad(`${name}: בלוק הנושא לא נמצא ב-ComplianceLights.css`); continue; }
    const look = {};
    for (const st of COMPLIANCE_STATES) {
      const fill = paint(vars[`--cl-${st}-fill`], card);
      const border = fill && paint(vars[`--cl-${st}-border`], fill);   // המסגרת מעל המילוי (border-box)
      const ink = vars[`--cl-${st}-ink`];
      if (!fill || !border || !/^#[0-9a-fA-F]{6}$/.test(ink || "")) {
        bad(`${name}: ${st} — מילוי/מסגרת/סימן חסרים או לא ניתנים לקריאה`);
        continue;
      }
      look[st] = { fill, border };
      const c = contrast(ink, fill);
      if (c < MIN_TEXT) bad(`${name}: ${st} — סימן ${ink} על ${fill}: ${c.toFixed(2)}:1`);
    }
    const keys = Object.keys(look);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const [a, b] = [look[keys[i]], look[keys[j]]];
        const d = Math.max(deltaE(a.fill, b.fill), deltaE(a.border, b.border));
        if (d < MIN_DELTA_E) bad(`${name}: ${keys[i]} ↔ ${keys[j]} — ΔE ${d.toFixed(1)}, קרובים מדי`);
      }
    }
    // טקסט קטן על הכרטיס עצמו: "לא הוגש", "?", ושורות הסיבה בעמוד הבודק
    for (const [label, v] of [["לא הוגש", "--cl-ink-red"], ["?", "--cl-muted"],
                              ["סיבה כתומה", "--cl-overdue-ink"], ["סיבה צהובה", "--cl-soon-ink"]]) {
      const fg = vars[v];
      if (!/^#[0-9a-fA-F]{6}$/.test(fg || "")) { bad(`${name}: ${v} חסר`); continue; }
      const c = contrast(fg, card);
      if (c < MIN_TEXT) bad(`${name}: ${label} (${fg}) על הכרטיס — ${c.toFixed(2)}:1`);
    }
  }
  const glyphs = [...COMPLIANCE_STATES, "unknown"].map((st) => GLYPH[st]);
  if (glyphs.some((g) => !g) || new Set(glyphs).size !== glyphs.length) bad(`גליפים חסרים או כפולים: ${glyphs.join(" ")}`);
  if (!localFail) console.log(`   ✓ ${COMPLIANCE_STATES.length} מצבים — נבדלים, קריאים, עם גליף משלהם, בשני הנושאים`);
  failures += localFail;
}

const dataColors = new Set([...Object.values(DIRECTION_COLORS), ...Object.values(METRIC_COLORS)]);
console.log(`\nצבעי נתונים בשימוש: ${dataColors.size} · מהלוגו: ${BRAND.blue} · ${BRAND.lime}`);

if (failures) {
  console.error(`\n❌ ${failures} בעיות צבע`);
  process.exit(1);
}
console.log("\n✅ הפלטה אחידה — אין התנגשויות");
