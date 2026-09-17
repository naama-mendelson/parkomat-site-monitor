// components/StaleBanner — אומר בקול שהמסך מציג נתונים ישנים.
//
// ============================================================
// ⚠️ הכשל שזה בא לסגור, פעמיים
// ============================================================
// 26.07 — השרת למטה 15 שעות. 22.08 — עוד 14.7. בשני המקרים לא אבד נתון
// אחד: HiveMQ שמר את התור ומסר אותו בהפעלה הבאה. מה שאבד היה **הידיעה**.
// המסך הראה מצב בן 14 שעות, נראה תקין לחלוטין, ואיש לא ידע עד הבוקר.
//
// ⚠️ וזה החמיר דווקא כשהמעבר ל-Supabase הצליח: הדשבורד קורא ישירות
// מ-PostgREST, ולכן הוא ממשיך לעבוד מצוין בזמן שהקליטה מתה. כל המסכים
// נטענים, כל המספרים מוצגים — הם פשוט מאתמול.
import { useEffect, useState } from "react";
import { fetchServerHealth } from "../../services/dataSource";
import "./StaleBanner.css";

// ⚠️ 5 דקות ולא דקה. כל אתר פועם כל 60 שניות, והנמדד הוא הפעימה הטרייה
// ביותר מכל האתרים — כלומר חמש דקות שבהן **אף אחד** לא פעם. סף צמוד יותר
// היה מבהב על תקלת רשת חולפת — ובאנר שמבהב הוא באנר שמפסיקים לראות.
// (עד 17/09/2026 נמדד אות החיים של master; הוא יצא משימוש — ראה healthDirect.js.)
const STALE_AFTER_SECONDS = 300;

// כל 60 שניות. אין טעם בתדירות גבוהה יותר: הבעיה שמחפשים נמדדת בשעות,
// והבדיקה עצמה היא קריאת RPC לכל לקוח פתוח.
const POLL_MS = 60 * 1000;

function humanAge(seconds) {
  if (seconds === null || seconds === undefined) return "";
  if (seconds < 3600) return `${Math.round(seconds / 60)} דקות`;
  const h = seconds / 3600;
  if (h < 24) return h < 2 ? "שעה" : `${Math.round(h)} שעות`;
  const d = Math.round(h / 24);
  return d === 1 ? "יממה" : `${d} ימים`;
}

function StaleBanner() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const h = await fetchServerHealth(STALE_AFTER_SECONDS);
        if (!cancelled) setHealth(h);
      } catch {
        // ⚠️ כשל בבדיקה עצמה **אינו** מוצג כתקלה בשרת. חוסר רשת אצל
        // המשתמשת, או תקלה חולפת ב-Supabase, אינם אומרים דבר על הקליטה —
        // ובאנר אדום שגוי הוא הדרך הבטוחה לגרום למישהו להתעלם מהאמיתי.
        if (!cancelled) setHealth(null);
      }
    }

    check();
    const id = setInterval(check, POLL_MS);
    // בחזרה לטאב בודקים מיד: מחשב שנרדם לא הריץ את הטיימר, והנתון על
    // המסך ישן בדיוק כמו הזמן שעבר.
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // ⚠️ שלושה מצבים ולא שניים, ו-`unknown` הוא החשוב שבהם: כשאין אף פעימה
  // (אף אתר עוד לא חובר ישירות), להכריז "מת" היה מציג אזהרה אדומה על מצב
  // תקין — כלומר בדיוק ההתראה שמלמדת להתעלם מהמסך.
  if (!health || health.unknown || health.alive !== false) return null;

  const age = humanAge(health.ageSeconds);

  return (
    <div className="stale-banner" role="alert">
      <span className="stale-banner-dot" aria-hidden="true" />
      <div>
        <strong>הנתונים במסך אינם מתעדכנים.</strong>{" "}
        {age
          ? `אף אתר לא דיווח כבר ${age}.`
          : "אף אתר אינו מדווח."}
        {/* ⚠️ המשפט הזה חייב להישאר. בלעדיו הבאנר קורא כמו "המידע אבד",
            וזו מסקנה שגויה שגוררת פעולות מיותרות. הסוכן שומר תור על הדיסק
            של מחשב האתר, והתור שורד גם ניתוק וגם הפסקת חשמל. */}
        <span className="stale-banner-note">
          {" "}ההודעות נשמרות במחשבי האתרים ולא אבדו — הן ייקלטו כשהחיבור יחזור.
        </span>
        {/* ============================================================
            ⚠️ ההוראה, ולא רק ההודעה
            ============================================================
            הבאנר אמר "השרת אינו מדווח" ועצר שם. מי שקורא אותו יודע שיש
            בעיה ואינו יודע מה לעשות איתה — ואז הוא ממתין, בדיוק כפי שקרה
            ב-22/08 (14.7 שעות) וב-27/08 (2.5 ימים).

            ⚠️ **17/09/2026: ההוראה הקודמת הפכה למסוכנת.** היא אמרה ללחוץ על
            „הפעל את Parkomat” ב-DELL008. השרת יצא משימוש, והפעלתו מחזירה קוד
            ישן שדורס את ה-SQL בייצור — וזה בדיוק מה שהשבית באותו יום את
            הכתיבה של כל האתרים. לכן ההוראה אומרת במפורש **לא** להפעיל אותו.

            כשאף אתר לא פועם, התקלה מרכזית (Supabase, או פונקציה שנדרסה) ולא
            במחשבי האתרים — ואין לה תיקון בלחיצה. מה שנשאר הוא לפנות למי
            שמחזיק את המערכת. */}
        <div className="stale-banner-do">
          מה לעשות: לפנות לאחראי/ת המערכת. <strong>אין להפעיל את השרת
          ב-DELL008</strong> — הוא יצא משימוש, והפעלתו משביתה את הדיווח של
          האתרים.
        </div>
      </div>
    </div>
  );
}

export default StaleBanner;
