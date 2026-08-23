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

// ⚠️ 5 דקות ולא דקה. השרת כותב אות חיים כל 20 שניות, כלומר 15 החמצות
// רצופות. סף צמוד יותר היה מבהב על כל הפעלה מחדש של הקונטיינר — ובאנר
// שמבהב הוא באנר שמפסיקים לראות אחרי יומיים.
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

  // ⚠️ שלושה מצבים ולא שניים, ו-`unknown` הוא החשוב שבהם: שרת שטרם נפרס
  // עם התכונה מחזיר NULL, ולהכריז עליו "מת" היה מציג אזהרה אדומה על מערכת
  // תקינה לגמרי — כלומר בדיוק ההתראה שמלמדת להתעלם מהמסך.
  if (!health || health.unknown || health.alive !== false) return null;

  const age = humanAge(health.ageSeconds);

  return (
    <div className="stale-banner" role="alert">
      <span className="stale-banner-dot" aria-hidden="true" />
      <div>
        <strong>הנתונים במסך אינם מתעדכנים.</strong>{" "}
        {age
          ? `השרת אינו מדווח על עצמו כבר ${age}.`
          : "השרת אינו מגיב."}
        {/* ⚠️ המשפט הזה חייב להישאר. בלעדיו הבאנר קורא כמו "המידע אבד",
            וזו מסקנה שגויה שגוררת פעולות מיותרות. */}
        <span className="stale-banner-note">
          {" "}ההודעות מהאתרים ממתינות ולא אבדו — הן ייקלטו כשהשרת יחזור.
        </span>
      </div>
    </div>
  );
}

export default StaleBanner;
