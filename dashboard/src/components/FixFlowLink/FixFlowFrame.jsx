// components/FixFlowLink/FixFlowFrame.jsx — ספריית התקלות, בתוך הדשבורד.
//
// ============================================================
// ⚠️ למה לא לשונית חדשה
// ============================================================
// נמדד מהשטח: "מפריע לי שהטיפול בתקלות נפתח בטאב חדש ואי אפשר לחזור ממנו
// לעמוד הבית". ל-FixFlow אין כפתור חזרה — היא אפליקציה נפרדת שמוגשת מתוך
// הדשבורד, והקוד שלה אינו כאן — ולכן מי שהגיע אליה נשאר עם לשונית שאין
// ממנה דרך חזרה, בדיוק באמצע טיפול בתקלה.
//
// כאן היא נפתחת **בתוך** הדשבורד: כותרת עם "חזרה", והדשבורד ממתין מאחור
// על כל מה שהיה פתוח בו. סגירה מחזירה בדיוק לאותו מקום, בלי טעינה מחדש.
//
// ⚠️ **אותו origin, ולכן זה עובד בכלל:** FixFlow מוגשת מ-`/fixflow` של
// אותו אתר, וההתחברות ב-localStorage משותפת. דומיין נפרד היה מסך התחברות
// שני בתוך מסגרת.
//
// ⚠️ **והלשונית לא נעלמה** — היא כפתור בכותרת. מי שרוצה את הספרייה על מסך
// שני עדיין יכול, וזו הייתה כנראה הסיבה שזה נבנה ככה מלכתחילה.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import "./FixFlowFrame.css";

export default function FixFlowFrame({ url, title, onClose }) {
  // ⚠️ Escape סוגר — ובשלב ה-capture: הכרטיס ולוחות אחרים מאזינים ל-Escape
  // ברמת החלון, ובלי העצירה כאן לחיצה אחת הייתה סוגרת גם אותם.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // ============================================================
  // ⚠️ portal ל-body — אחרת המסגרת נפתחת בגודל הכרטיס
  // ============================================================
  // נמדד על המסך: "זה צריך להיפתח יותר גדול". הכפתור יושב בתוך כרטיס האתר,
  // ולכרטיס יש `filter: saturate(...)` (ו-`transform` בריחוף). כל אחד משניהם
  // יוצר containing block חדש, ואז `position: fixed` נמדד **ביחס לכרטיס**
  // ולא למסך — כלומר "מסך מלא" יצא 318×198 פיקסלים.
  //
  // ⚠️ תיקון ב-CSS של הכרטיס לא היה נכון כאן: ה-`filter` הוא עיצוב מכוון
  // (עמעום כרטיסים שאינם בפוקוס), וכל רכיב עתידי שייפתח מתוך כרטיס היה נופל
  // שוב. הפורטל מוציא את המסגרת מההיררכיה — היא בת של `body`.
  return createPortal(
    <div className="fff" onClick={(e) => e.stopPropagation()}>
      <header className="fff-head">
        <button type="button" className="fff-back" onClick={onClose}>
          <span aria-hidden="true">→</span> חזרה לדשבורד
        </button>
        <span className="fff-title">{title}</span>
        {/* ⚠️ קישור אמיתי ולא כפתור: כך Ctrl+לחיצה, גלגלת ו"פתח בחלון חדש"
            עובדים כרגיל — למי שבאמת רוצה מסך שני. */}
        <a className="fff-tab" href={url} target="_blank" rel="noreferrer">פתיחה בלשונית ↗</a>
      </header>
      <iframe className="fff-frame" src={url} title={title} />
    </div>,
    document.body,
  );
}
