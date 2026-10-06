// utils/pdfBrackets.js — סוגריים הפוכים בטקסט שמסמנים ומעתיקים מתסקיר.
//
// ============================================================
// ⚠️ נמדד, לא הונח (06/10/2026)
// ============================================================
// pdfjs הופך עברית לסדר לוגי, אבל לא מחליף את הסוגריים. אם ה-PDF שמר את
// הסוגר לפי **הצורה** שלו בעמוד (השמאלי תמיד "(") — אחרי ההיפוך הוא בצד
// הלא נכון. בחלק מהתסקירים כל הסוגריים הפוכים:
//     ")1234("   "1. לתקן את המעקה )בקומה 2-( - לטיפול מיידי"   ← ליקוי, בדיוק מה שמעתיקים
// ובאחרים, מתוכנה אחרת, הם תקינים: "(משטח)", "(בדיקה ראשונה)".
//
// לכן אין תיקון אחד לכולם: החלפה גורפת הייתה שוברת את התקינים, ובלי החלפה
// ההפוכים מודבקים לטופס עם ")…(". ההחלטה היא **לכל מסמך**, לפי הקטעים
// שיש בהם גם פותח וגם סוגר — מה מופיע קודם. קטע עם סוגר בודד אינו מכריע
// לשום כיוון (הוא יכול לסגור סוגריים מקטע קודם), אבל מקבל את ההחלטה.
//
// רק קטעים מימין לשמאל (dir === "rtl"); באנגלית ובמספרים pdfjs אינו הופך.
// ⚠️ רק שכבת הטקסט (סימון והעתקה) עוברת כאן — לא קריאת התאריכים.

const MIRROR = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };
const ANY = /[()[\]{}<>]/g;
const OPENERS = "([{<";

/**
 * כמה קטעים מעידים על סוגריים הפוכים ("…)…(…") וכמה על תקינים ("…(…)…").
 * @param {{ str?: string, dir?: string }[]} items — items של getTextContent
 */
export function bracketSignal(items) {
  let reversed = 0;
  let normal = 0;
  for (const it of items || []) {
    if (it?.dir !== "rtl" || !it.str) continue;
    const found = it.str.match(ANY);
    if (!found) continue;
    const hasOpen = found.some((c) => OPENERS.includes(c));
    const hasClose = found.some((c) => !OPENERS.includes(c));
    if (!hasOpen || !hasClose) continue;
    if (OPENERS.includes(found[0])) normal++;
    else reversed++;
  }
  return { reversed, normal };
}

export const mirrorBrackets = (s) => s.replace(ANY, (c) => MIRROR[c]);

/**
 * עוקב אחרי מסמך אחד, עמוד אחר עמוד: כל עמוד מוסיף את הסימנים שלו (פעם אחת),
 * וההחלטה נשענת על כל מה שנראה עד עכשיו. מחזיר את ה-items לשכבת הטקסט —
 * מתוקנים אם המסמך הפוך, וכפי שהם אחרת.
 */
export function bracketFixer() {
  const seen = new Set();
  let reversed = 0;
  let normal = 0;
  return (pageNo, items) => {
    if (!seen.has(pageNo)) {
      seen.add(pageNo);
      const s = bracketSignal(items);
      reversed += s.reversed;
      normal += s.normal;
    }
    if (reversed <= normal) return items;
    return items.map((it) => (it?.dir === "rtl" && it.str ? { ...it, str: mirrorBrackets(it.str) } : it));
  };
}
