import { useLayoutEffect, useRef } from "react";

/**
 * מקטין את גודל הפונט של אלמנט עד שהטקסט נכנס ברוחב שהוקצה לו — על שורה
 * אחת, בלי חיתוך ובלי "...".
 *
 * ============================================================
 * ⚠️ למה מדידה ולא נוסחה ב-CSS
 * ============================================================
 * הגרסה הקודמת חישבה את הגודל ב-CSS:
 *
 *     clamp(0.7rem, calc((100cqi - 3.2rem) / (var(--name-chars) * 0.58)), 1em)
 *
 * והיא **נכשלה על המסך**. שתי הנחות שבורות:
 *
 * 1. `- 3.2rem` הניח שרק קוד האתר יושב לצד השם. בפועל ב-normal יש שם גם
 *    תג סוג ותג דרגה, ורוחבם משתנה עם הטקסט שבתוכם — אין קבוע נכון.
 * 2. `* 0.58` הניח רוחב תו ממוצע. באותיות עבריות, ספרות ומרכאות זה נע
 *    מספיק כדי שהערכה תחטיא.
 *
 * הדפדפן כבר יודע את שני הדברים במדויק. `clientWidth` הוא מה ש-flex
 * הקצה בפועל, ו-`scrollWidth` הוא הרוחב הטבעי של הטקסט. היחס ביניהם
 * הוא בדיוק כמה צריך להקטין — בלי לנחש כלום.
 *
 * ⚠️ **הרוחב נמדד רק אחרי איפוס הגודל.** בלי השורה הזו המדידה השנייה
 * מתבצעת על פונט שכבר הוקטן, וכל ריצה מקטינה עוד קצת עד שהשם נעלם.
 *
 * ⚠️ **ו-`useLayoutEffect` ולא `useEffect`**: המדידה חייבת לקרות לפני
 * שהדפדפן מצייר, אחרת רואים הבהוב של השם בגודל מלא ואז קופץ.
 *
 * @param {string} text     הטקסט עצמו — מודדים מחדש כשהוא משתנה
 * @param {number} minScale כמה מותר להקטין לכל היותר (0.62 ≈ 62%)
 */
export function useFitText(text, minScale = 0.62) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    function fit() {
      // איפוס לפני מדידה — ראה ההסבר למעלה.
      el.style.fontSize = "";

      const available = el.clientWidth;
      const needed = el.scrollWidth;
      if (!available || !needed || needed <= available) return;

      const base = parseFloat(getComputedStyle(el).fontSize);
      // 0.98 — שוליים של פיקסל-שניים. עיגול כלפי מטה של הדפדפן החזיר
      // לפעמים טקסט שנכנס "כמעט", כלומר נחתך באות האחרונה.
      const scale = Math.max(minScale, (available / needed) * 0.98);
      el.style.fontSize = `${base * scale}px`;
    }

    fit();

    // ⚠️ הכרטיס משנה רוחב בלי שהטקסט משתנה: שינוי גודל חלון, מעבר רמת
    // צפיפות, פתיחת הכרטיס המורחב. בלי המעקב הזה השם היה נשאר בגודל
    // שחושב לרוחב אחר — קטן מדי אחרי הגדלה, וחתוך אחרי הקטנה.
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, minScale]);

  return ref;
}
