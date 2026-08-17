// components/ApiHealthBar/ApiHealthBar.jsx — פס כשכתובת ה-API שגויה.
//
// ============================================================
// פס ולא מסך חוסם — מאותו טעם כמו שלט הקול
// ============================================================
// ⚠️ בתצורה הנפוצה (`VITE_SUPABASE_DIRECT=true`) הקריאות **עובדות** גם
// כשה-API אינו נגיש — הן הולכות ישירות ל-Supabase. כלומר הדשבורד מציג
// נתונים אמיתיים ומעודכנים, ורק הכתיבות שבורות.
//
// מסך חוסם היה מוחק תמונה תקינה ומועילה בגלל תקלה חלקית. במסך קיר בחדר
// בקרה זה בדיוק ההיפך ממה שצריך: קול חסר או כתיבה חסומה משאירים את המידע
// על המסך; חלון חוסם מוחק גם אותו.
//
// ============================================================
// ⚠️ ומה שהפס אומר הוא **מה שבור**, ולא "יש שגיאה"
// ============================================================
// "תקלת תקשורת" היה שולח לבדוק את הרשת. הבעיה כאן היא כמעט תמיד ערך
// שנצרב בבנייה, וההודעה נוקבת בו בשמו — כי מי שרואה אותה הוא מי שבנה.
import { useEffect, useState } from "react";
import { probeApi, isRelative } from "../../services/apiHealth";
import { API_ROOT } from "../../services/api";
import { useDirect } from "../../services/dataSource";
import "./ApiHealthBar.css";

function ApiHealthBar() {
  const [verdict, setVerdict] = useState(null);

  // ⚠️ פעם אחת בעלייה, ולא בפולינג: תקלת **הגדרה** אינה משתנה תוך כדי
  // ריצה — היא נצרבה בבנייה. פולינג היה מוסיף בקשות ולא מידע. שרת שחזר
  // לחיים הוא מקרה אחר, ובשבילו יש כפתור מפורש.
  useEffect(() => {
    let cancelled = false;
    probeApi(API_ROOT).then((v) => { if (!cancelled) setVerdict(v); });
    return () => { cancelled = true; };
  }, []);

  if (!verdict || verdict.kind === "healthy") return null;

  // ⚠️ 'unhealthy' הוא ה-API שמדווח על עצמו — לא תקלת הגדרה, ולא באחריות
  // הפס הזה. הוא כבר מוצג בכל קריאה שנכשלת, והצגתו כאן הייתה מכריזה על
  // "כתובת שגויה" כשהכתובת נכונה לגמרי.
  if (verdict.kind === "unhealthy") return null;

  const isNotApi = verdict.kind === "not-api";

  return (
    <div className="api-health-bar" role="alert">
      <span className="api-health-icon" aria-hidden="true">⚠</span>

      <div className="api-health-text">
        <strong className="api-health-main">
          {isNotApi
            ? "כתובת ה-API שגויה — פעולות כתיבה לא יעבדו"
            : "אין קשר לשרת ה-API — פעולות כתיבה לא יעבדו"}
        </strong>

        <span className="api-health-sub">
          {/* ⚠️ מפרטים מה נשבר בפועל, ולא "חלק מהפעולות": מי שקורא צריך
              לדעת אם מה שהוא עומד לעשות עובד. */}
          רישום אתר · חלון תחזוקה · ניהול משתמשים · העוזר
          {useDirect && " · הצגת הנתונים עצמה תקינה (נקראת ישירות מ-Supabase)"}
        </span>

        <span className="api-health-detail">
          {isNotApi ? (
            <>
              {/* ⚠️ מסבירים למה **200 ולא שגיאה**: זה מה שהופך את הכשל
                  לבלתי מובן בלי ההסבר הזה. */}
              הכתובת <code>{API_ROOT || "(נתיב יחסי)"}/health</code> החזירה{" "}
              <code>{verdict.detail?.contentType || "לא-JSON"}</code> במקום JSON — כלומר
              שרת הקבצים ענה, לא ה-API.
              {isRelative(API_ROOT) && (
                <> צריך לקבוע <code>VITE_API_BASE</code> בזמן הבנייה.</>
              )}
            </>
          ) : (
            <>
              {/* ⚠️ שתי סיבות ולא אחת: הדפדפן אינו מבדיל בין שרת מכובה
                  לחסימת CORS, ואמירת אחת מהן בביטחון הייתה שולחת לחפש
                  במקום הלא נכון. */}
              לא הגיעה תשובה מ-<code>{API_ROOT || "(נתיב יחסי)"}/health</code>. שתי
              אפשרויות שאי אפשר להבחין ביניהן מהדפדפן: השרת אינו רץ, או
              ש-<code>DASHBOARD_ORIGIN</code> אינו כולל את הכתובת שממנה נטען הדף.
            </>
          )}
        </span>
      </div>

      <button
        type="button"
        className="api-health-retry"
        onClick={() => probeApi(API_ROOT).then(setVerdict)}
      >
        בדוק שוב
      </button>
    </div>
  );
}

export default ApiHealthBar;
