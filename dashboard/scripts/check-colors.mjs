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
import { BRAND, STATUS_COLORS, DIRECTION_COLORS, METRIC_COLORS } from "../src/utils/constants.js";

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
  "מצבי אתר (דונאט + תגיות)": Object.fromEntries(
    Object.entries(STATUS_COLORS).map(([k, v]) => [k, v.dot]),
  ),
};

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

const dataColors = new Set([...Object.values(DIRECTION_COLORS), ...Object.values(METRIC_COLORS)]);
console.log(`\nצבעי נתונים בשימוש: ${dataColors.size} · מהלוגו: ${BRAND.blue} · ${BRAND.lime}`);

if (failures) {
  console.error(`\n❌ ${failures} בעיות צבע`);
  process.exit(1);
}
console.log("\n✅ הפלטה אחידה — אין התנגשויות");
