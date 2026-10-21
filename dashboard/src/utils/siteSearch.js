// utils/siteSearch.js — חיפוש אתר "פחות או יותר" לחלון "צא ל:" (21/10/2026).
//
// בעלת המוצר: "SELECT עם כל שמות האתרים — שמתחילים להקליד את שם האתר פחות או יותר וזה מביא את השם". שם האתר הוא הכתובת
// ("הרצל 50, ת"א"), ולכן החיפוש סלחני כמו מי שמקליד כתובת בטלפון:
//   • כל מילה שהוקלדה, בכל סדר ("50 הרצל", "תא הרצל");
//   • בלי גרשיים ומירכאות (ת"א = תא), מקף = רווח, ואותיות סופיות כרגילות (חצי מילה נגמרת באות רגילה: "רמת ג");
//   • קיצור עיר = העיר (תא / ת"א / "תל אביב" מוצאים "…, ת"א" וגם "…, תל אביב");
//   • כתיב מלא / חסר — השוואה על "שלד" בלי י/ו וסופית א/ה (אותו כלל כמו ב-tools/geocode-sites.js: "שנקין" = "שינקין");
//   • טעות הקלדה אחת במילה של 4 אותיות ומעלה ("הרצלל", "שנקנ").
// ספרות: קוד אתר שמתחיל בהן, או מספר בית שמתחיל בהן — לא "מכיל" (אחרת "5" מוצא כל אתר עם 5 במספר).
// נבדק ב-master/tests/technicians-ui.test.js.
import { cityName, parseSiteAddress } from "../../../shared/site-address.mjs";

const QUOTES = /["'״׳‘’“”`]/g;
const FINALS = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
const DIGITS = /^\d+$/;

/** טקסט להשוואה: בלי גרשיים, אותיות סופיות רגילות, כל מה שאינו אות או ספרה — רווח. */
export function looseText(s) {
  return String(s ?? "").toLowerCase().replace(QUOTES, "").replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** "שלד" של מילה: בלי י/ו, ובלי א/ה בסוף. מילה שנשארת ריקה — המילה עצמה. */
export function skel(w) {
  const s = String(w ?? "").replace(/[יו]/g, "").replace(/[אה]$/, "");
  return s || String(w ?? "");
}

/** מרחק עריכה עם החלפת שתי אותיות סמוכות (Damerau, הגרסה המצומצמת). */
export function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

const rawName = (s) => String(s?.site_name ?? s?.name ?? "").replace(/\s+/g, " ").trim();

/** מפתח החיפוש של אתר — נבנה פעם אחת לרשימה. השם, והעיר הרשמית כשהקיצור מוכר ("ת"א" → גם "תל אביב יפו"). */
export function siteKey(site) {
  const name = rawName(site);
  const city = parseSiteAddress(name).city;
  const text = looseText(city ? `${name} ${city}` : name);
  const words = text ? text.split(" ") : [];
  // ⚠️ הקוד מנורמל כמו החיפוש: "MX-007" → "mx 007", כך ש"mx-007" ו-"MX 007" מוצאים אותו
  const code = looseText(site?.code);
  return { code, codeWords: code ? code.split(" ") : [], name, nameLoose: looseText(name), text, words, skels: words.map(skel) };
}

// רמת ההתאמה של מילה אחת מהחיפוש: 3 = כמו שהיא, 2 = אותו שלד (כתיב מלא / חסר), 1 = טעות הקלדה אחת, 0 = אין
function tokenLevel(t, raw, key) {
  if (key.codeWords.some((c) => c.startsWith(t))) return 3;
  if (DIGITS.test(t)) return key.words.some((w) => DIGITS.test(w) && w.startsWith(t)) ? 3 : 0;
  if (key.text.includes(t)) return 3;
  const city = cityName(raw);   // ⚠️ לפני המרת הסופיות: "י''ם" → "ים", והמפתח של ירושלים כתוב עם ם
  if (city && key.text.includes(looseText(city))) return 3;
  const st = skel(t);
  if (st.length >= 2 && key.skels.some((w) => w.includes(st))) return 2;
  if (t.length >= 4 && key.words.some((w) => !DIGITS.test(w)
      && (editDistance(t, w) <= 1 || (w.length > t.length && editDistance(t, w.slice(0, t.length)) <= 1)))) return 1;
  return 0;
}

/**
 * ציון ההתאמה של אתר לחיפוש (0 = לא מתאים). קוד מדויק → קוד שמתחיל → שם שמתחיל → כל המילים כמו שהן → בשלד → בטעות.
 * ⚠️ אתר מתאים רק אם **כל** מילה שהוקלדה נמצאה בו.
 */
export function matchScore(key, query) {
  const q = looseText(query);
  if (!q) return 0;
  if (key.code && key.code === q) return 1000;
  if (DIGITS.test(q) && key.code.startsWith(q)) return 900;
  if (key.nameLoose.startsWith(q)) return 800;
  const raw = String(query).replace(QUOTES, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ");
  let sum = 0;
  for (const r of raw) {
    const t = looseText(r);
    if (!t) continue;
    const lv = tokenLevel(t, r, key);
    if (!lv) return 0;
    sum += lv;
  }
  return 100 + sum * 10;
}

/** החיפוש עצמו: [{site, score}] מהטוב לפחות, עד limit. keys = siteKey לכל אתר (אותו סדר), כדי לא לבנות בכל הקלדה. */
export function searchSites(sites, keys, query, limit = 30) {
  const list = Array.isArray(sites) ? sites : [];
  const out = [];
  list.forEach((s, i) => {
    const score = matchScore(keys?.[i] ?? siteKey(s), query);
    if (score > 0) out.push({ site: s, score, name: keys?.[i]?.name ?? rawName(s) });
  });
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "he"));
  return out.slice(0, limit);
}
