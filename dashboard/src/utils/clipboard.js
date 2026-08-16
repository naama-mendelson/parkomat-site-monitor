// utils/clipboard.js — העתקה שעובדת גם כשה-API המודרני אינו זמין.
//
// ============================================================
// ⚠️ למה זה לא `navigator.clipboard.writeText` ותו לא
// ============================================================
// `navigator.clipboard` קיים **רק ב-secure context**: HTTPS, או
// `localhost` בדיוק. בכל כתובת אחרת — ובראשן `http://192.168.x.x:5173`,
// כלומר פתיחת הדשבורד ממחשב אחר ברשת — האובייקט פשוט **אינו קיים**.
//
// הקוד הקודם היה `navigator.clipboard?.writeText(...)`, ולכן במצב הזה
// הלחיצה לא עשתה **כלום, בשקט**: בלי העתקה, בלי שגיאה, בלי סימן. וגם
// כשהיא כן עבדה לא היה שום משוב, אז אי אפשר היה להבחין בין השניים.
//
// ⚠️ וזה קרה על הסיסמה הזמנית — הערך היחיד במערכת שמוצג **פעם אחת בלבד**
// ואינו נשמר בשום מקום. העתקה שנכשלת בשקט שם פירושה משתמש שנוצר ואי
// אפשר להתחבר אליו.
//
// ============================================================
// שלוש דרכים, לפי סדר איכות
// ============================================================
//   1. Clipboard API — כשהוא קיים ומורשה.
//   2. `document.execCommand("copy")` — מיושן ומסומן כך בתקן, אבל הוא
//      **הדרך היחידה שעובדת ב-http רגיל**, וזה בדיוק המקרה שנשבר.
//   3. כישלון מוצהר — המתקשר יציג הודעה שתבקש לסמן ידנית.
//
// מחזיר Promise<boolean>. **לעולם לא זורק** — כישלון העתקה אינו סיבה
// להפיל מסך; הוא סיבה לומר שלא הצליח.

/** @returns {Promise<boolean>} האם ההעתקה הצליחה בפועל */
export async function copyText(text) {
  const value = String(text ?? "");
  if (!value) return false;

  // ---- 1. הדרך המודרנית ----
  // ⚠️ בתוך try: גם כשה-API קיים הוא נדחה כשהמסמך אינו ממוקד, או
  // כשההרשאה נשללה. הבטחה שנדחית בלי catch היא unhandled rejection.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch { /* ממשיכים לנפילה האחורית */ }
  }

  // ---- 2. הנפילה האחורית, לכתובות שאינן secure ----
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    // ⚠️ מחוץ למסך ולא `display:none`: אלמנט מוסתר אינו ניתן לבחירה,
    // ו-execCommand מעתיק **בחירה** — כלומר הוא היה מחזיר false.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);

    ta.select();
    ta.setSelectionRange(0, value.length);   // iOS מתעלם מ-select() לבדו
    const ok = document.execCommand("copy");

    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
