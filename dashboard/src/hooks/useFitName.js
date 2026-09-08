import { useLayoutEffect, useRef, useState } from "react";

// ============================================================
// ⚠️ מדידה בקנבס ולא ב-DOM — כדי שאפשר יהיה למדוד מועמד בלי להציג אותו
// ============================================================
// צריך לדעת אם "עמנואל הרומי 10" נכנס **לפני** שמחליטים להציג אותו.
// מדידה ב-DOM הייתה דורשת לכתוב את הטקסט, למדוד, ואולי להחזיר — כלומר
// הבהוב, ועוד מחזור פריסה בכל כרטיס.
//
// `canvas.measureText` מודד מחרוזת שרירותית בפונט נתון בלי לגעת בעמוד.
let ctx = null;
function widthOf(text, font) {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  ctx.font = font;
  return ctx.measureText(text).width;
}

// ⚠️ הקיצור `font` ב-getComputedStyle מוחזר ריק בחלק מהדפדפנים, ואז
// ‏measureText היה מודד בפונט ברירת המחדל של הקנבס — כלומר מספר שאין לו
// שום קשר למה שעל המסך. בונים את המחרוזת מהחלקים.
function fontOf(el) {
  const s = getComputedStyle(el);
  return `${s.fontStyle} ${s.fontWeight} ${s.fontSize} / ${s.lineHeight} ${s.fontFamily}`;
}

/**
 * ההחלטה עצמה — **פונקציה טהורה**, בלי DOM ובלי React.
 *
 * ⚠️ היא מופרדת בדיוק כדי שאפשר יהיה לבדוק אותה: סדר הוויתורים הוא כל
 * הבקשה כאן, ובדיקה מבנית ("הקוד מזכיר פסיק") אינה מוכיחה שהסדר נשמר.
 * אותו דפוס כמו `WatchdogPolicy` ו-`RestartPolicy` בסוכן.
 *
 * @param {string}   full      השם המלא
 * @param {number}   available הרוחב שיש, בפיקסלים
 * @param {Function} measure   (text) => width — מוזרק, כדי שהבדיקה תשלוט בו
 * @returns {{text: string, scale: number}} מה להציג, וכמה להקטין (1 = בכלל לא)
 */
export function pickName(full, available, measure, minScale = 0.62) {
  const name = full || "";
  if (!name || !available) return { text: name, scale: 1 };

  // 1. השם המלא, בגודל מלא.
  if (measure(name) <= available) return { text: name, scale: 1 };

  // 2. בלי מה שאחרי הפסיק. גם פסיק עברי וגם רגיל.
  const beforeComma = name.split(/[,،]/)[0].trim();
  const canTrim = beforeComma.length > 0 && beforeComma !== name;
  if (canTrim && measure(beforeComma) <= available) {
    return { text: beforeComma, scale: 1 };
  }

  // 3. מוצא אחרון — מקטינים, על החלק הקצר ביותר שיש.
  const shown = canTrim ? beforeComma : name;
  const needed = measure(shown);
  // 0.98 — שוליים של פיקסל-שניים; עיגול כלפי מטה החזיר לפעמים טקסט
  // שנכנס "כמעט", כלומר נחתך באות האחרונה.
  const scale = needed > 0 ? Math.max(minScale, (available / needed) * 0.98) : 1;
  return { text: shown, scale };
}

/**
 * מתאים שם אתר לרוחב שיש לו, לפי סדר עדיפויות ברור:
 *
 *   1. **השם המלא בגודל מלא** — אם הוא נכנס, לא נוגעים בכלום.
 *   2. **בלי מה שאחרי הפסיק** — "עמנואל הרומי 10 , ת״א" ⇒ "עמנואל הרומי 10".
 *      אחרי הפסיק יושבת העיר, והיא החלק הכי פחות מבחין: כל האתרים
 *      ב"ת״א" חולקים אותה, בזמן שהרחוב והמספר הם הזיהוי.
 *   3. **ורק אז מקטינים את הפונט** — מוצא אחרון, לא ברירת מחדל.
 *
 * ⚠️ **הסדר הזה הוא כל העניין.** הגרסה הקודמת הקטינה מיד, וכל שם ארוך
 * קיבל פונט קטן גם כשהיה אפשר פשוט לוותר על "ת״א". התוצאה הייתה רשת
 * שבה גדלי הטקסט קופצים מכרטיס לכרטיס בלי סיבה נראית לעין.
 *
 * ⚠️ **ובשום שלב אין חיתוך באמצע מילה ואין "...".** מה שמוצג הוא תמיד
 * יחידה שלמה ובעלת משמעות, ו-`title` מחזיק את השם המלא.
 *
 * @param   {string} fullName  השם כפי שהוא במסד
 * @param   {number} minScale  כמה מותר להקטין לכל היותר, אם הגענו לשלב 3
 * @returns {{ref: object, text: string, trimmed: boolean}}
 */
export function useFitName(fullName, minScale = 0.62) {
  const ref = useRef(null);
  const [text, setText] = useState(fullName || "");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    function fit() {
      // ⚠️ איפוס לפני כל מדידה. בלעדיו המדידה הבאה מתבצעת על פונט
      // שכבר הוקטן, וכל ריצה מקטינה עוד — עד שהשם נעלם.
      el.style.fontSize = "";

      const available = el.clientWidth;
      if (!available) return;

      const font = fontOf(el);
      const base = parseFloat(getComputedStyle(el).fontSize);

      // ההחלטה עצמה חיה ב-pickName; כאן רק מודדים ומחילים.
      const { text: shown, scale } = pickName(
        fullName, available, (t) => widthOf(t, font), minScale);

      setText(shown);
      if (scale < 1) el.style.fontSize = `${base * scale}px`;
    }

    fit();

    // ⚠️ הכרטיס משנה רוחב בלי שהשם משתנה: שינוי חלון, מעבר רמת צפיפות,
    // פתיחת הכרטיס. בלי המעקב הזה ההחלטה נשארת זו שהתקבלה לרוחב אחר —
    // כלומר עיר שהוסתרה לחינם אחרי שהמסך גדל.
    const ro = new ResizeObserver(fit);
    ro.observe(el);

    // ============================================================
    // ⚠️ מדידה לפני שהפונט נטען היא מדידה של פונט אחר
    // ============================================================
    // הכרטיס מצויר לפני שהדפדפן סיים לטעון את הפונט, ואז המדידה
    // הראשונה נעשית על פונט הנפילה-לאחור. כשהפונט האמיתי מגיע הטקסט
    // מתרחב — ו-`ResizeObserver` **אינו נורה**, כי רוחב הכרטיס לא זז.
    //
    // התוצאה היא בדיוק הבאג המקורי: שם חתוך, בלי שום סימן שהמדידה רצה.
    // וזה קורה רק בטעינה הראשונה, כלומר דווקא במצב שבו רוב האנשים
    // רואים את המסך.
    let cancelled = false;
    document.fonts?.ready
      ?.then(() => { if (!cancelled) fit(); })
      .catch(() => { /* אין fonts API — המדידה הראשונה תישאר */ });

    return () => { cancelled = true; ro.disconnect(); };
  }, [fullName, minScale]);

  return { ref, text, trimmed: text !== (fullName || "") };
}
