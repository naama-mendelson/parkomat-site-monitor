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
import { BRAND, STATUS_COLORS, DIRECTION_COLORS, METRIC_COLORS, STUCK_COLOR, UPTIME_COLORS, COMPLIANCE_COLORS } from "../src/utils/constants.js";

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
  // שתי המנורות יושבות זו ליד זו בכרטיס, וכל אחת יכולה להיות בכל אחד מארבעת
  // המצבים — כלומר ארבעת הגוונים חייבים להיבדל זה מזה.
  "רמזורי בודק/תחזוקה מונעת (כרטיס)": Object.fromEntries(
    Object.entries(COMPLIANCE_COLORS).map(([k, v]) => [k, v.dot]),
  ),
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
// טקסט קטן במנורות הציות — 4.5:1 מול **שני** הרקעים
// ============================================================
// הבדיקה שלמעלה מודדת רק מול הכרטיס הכהה, אבל ברירת המחדל של הדשבורד
// בהירה — ושם "לא הוגש" באדום #ef4444 נתן 3.76:1 וה-"?" האפור 3.05:1.
// הערכים נקראים מ-ComplianceLights.css עצמו, כדי שהבדיקה תמדוד את מה
// שמוצג ולא עותק שלו שיכול לסטות.
{
  const LIGHT_CARD = "#ffffff";
  const MIN_TEXT = 4.5;
  // rgba(...) מעל צבע הכרטיס → hex: הצבע שהעין רואה בפועל מאחורי הסימן
  const over = (rgba, under) => {
    const [r, g, b, a] = rgba.match(/[\d.]+/g).map(Number);
    const u = under.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16));
    return "#" + [r, g, b].map((v, i) => Math.round(v * a + u[i] * (1 - a)).toString(16).padStart(2, "0")).join("");
  };
  const css = readFileSync(new URL("../src/components/Compliance/ComplianceLights.css", import.meta.url), "utf8");
  const block = (selector) => {
    const at = css.indexOf(selector);
    if (at === -1) return null;
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    const vars = {};
    for (const m of css.slice(open + 1, close).matchAll(/(--cl-[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) vars[m[1]] = m[2];
    return vars;
  };
  const themes = [
    ["בהיר", block("[data-theme=\"light\"] {"), LIGHT_CARD],
    ["כהה", block("[data-theme=\"dark\"] {"), DARK_CARD],
  ];
  console.log("\nטקסט קטן במנורות בודק/תחזוקה (4.5:1)");
  let localFail = 0;
  for (const [name, vars, card] of themes) {
    const need = ["--cl-ink-red", "--cl-ink-green", "--cl-ink-amber", "--cl-solid-red", "--cl-muted"];
    if (!vars || need.some((k) => !vars[k])) {
      localFail++;
      console.log(`   ❌ ${name}: לא נמצאו ${need.join(", ")} ב-ComplianceLights.css`);
      continue;
    }
    const pairs = [
      [`"לא הוגש" (${vars["--cl-ink-red"]}) על הכרטיס`, vars["--cl-ink-red"], card],
      [`ספרה/✕ לבנים על ${vars["--cl-solid-red"]}`, "#ffffff", vars["--cl-solid-red"]],
      [`○ / ? (${vars["--cl-muted"]}) על הכרטיס`, vars["--cl-muted"], card],
      // המנורות עצמן (06/10/2026: גוון שקוף, לא מילוי): דיו על ה-bg כפי שהוא נראה מעל הכרטיס
      [`✓ (${vars["--cl-ink-green"]}) על הגוון הירוק`, vars["--cl-ink-green"], over(COMPLIANCE_COLORS.ok.bg, card)],
      [`! (${vars["--cl-ink-amber"]}) על הגוון הענברי`, vars["--cl-ink-amber"], over(COMPLIANCE_COLORS.soon.bg, card)],
      [`✕ (${vars["--cl-ink-red"]}) על הגוון האדום`, vars["--cl-ink-red"], over(COMPLIANCE_COLORS.expired.bg, card)],
    ];
    for (const [label, fg, bg] of pairs) {
      const c = contrast(fg, bg);
      if (c < MIN_TEXT) {
        localFail++;
        console.log(`   ❌ ${name}: ${label} — ${c.toFixed(2)}:1`);
      }
    }
  }
  if (!localFail) console.log("   ✓ כל הטקסט הקטן קריא בשני הנושאים");
  failures += localFail;
}

const dataColors = new Set([...Object.values(DIRECTION_COLORS), ...Object.values(METRIC_COLORS)]);
console.log(`\nצבעי נתונים בשימוש: ${dataColors.size} · מהלוגו: ${BRAND.blue} · ${BRAND.lime}`);

if (failures) {
  console.error(`\n❌ ${failures} בעיות צבע`);
  process.exit(1);
}
console.log("\n✅ הפלטה אחידה — אין התנגשויות");
