// components/AlertBell/AlertUnlockBar.jsx — הפעלת ההתראות הקוליות. חובה.
//
// ============================================================
// ⚠️ החלון אינו נעלם מעצמו — החלטת בעלת המוצר, 22/09/2026
// ============================================================
// "אני רוצה שיהיו חייבים לאשר הפעלת התראות". עד אז השלט המרכזי נסוג אחרי
// 25 שניות לפס דק בראש המסך — ומסך יכול היה לעבוד יום שלם בלי קול, כך
// שתקלה צלצלה בשום מקום. עכשיו: כל עוד הקול חסום, השלט באמצע המסך, ואין
// דרך לעבוד מאחוריו בלי ללחוץ.
//
// ⚠️ **המחיר, והוא הוסבר ונבחר ביודעין:** מסך קיר שמתאתחל בלילה (הפסקת
// חשמל, עדכון Windows) יעלה ויחכה לחיצה עד שמישהו יגיע. הקוד הקודם נמנע
// מזה בכוונה. שני דברים מקטינים את המחיר:
//   - **הרקע מעומעם ולא אטום** — המידע על האתרים עדיין נראה מאחור, רק
//     אי אפשר ללחוץ עליו.
//   - **הרשאת Sound באתר** (הגדרות האתר בדפדפן ← Sound ← Allow) נותנת לקול
//     לעבוד בלי מגע בכל טעינה — ואז החלון פשוט לא מופיע. זה הפתרון למסך
//     קיר, והשלט אומר אותו במפורש.
//
// ⚠️ **גם למי שאישר בעבר.** פעם זכרנו "אישר פעם אחת" ב-localStorage ולא
// הצגנו לו כלום — והקול נשאר חסום עד המגע הראשון, כלומר בדיוק "עובדים בלי
// קול". מדיניות ה-autoplay דורשת מגע **בכל טעינה**; אין מה לזכור.
//
// ⚠️ **כל מגע משחרר**, לא רק הכפתור: useAlertAudio מאזין ל-pointerdown
// ול-keydown ברמת החלון, והרקע עצמו לחיץ. מי שמנסה "לסגור" בלחיצה בצד
// מקבל בדיוק את מה שנדרש — קול פעיל.
//
// ⚠️ ולא מוצג כשהמשתמש **השתיק** ביודעין: השתקה היא בחירה גלויה (הפעמון
// מסומן), ולא מצב שהדפדפן כפה.
import { useAlertAudio } from "../../hooks/useAlertAudio";
import "./AlertUnlockBar.css";

function AlertUnlockBar() {
  const { state, onControlClick } = useAlertAudio();
  if (state !== "locked") return null;

  const SUB = "חובה להפעיל את צליל התקלה כדי להמשיך · תקלה שקרתה עד עכשיו תצלצל מיד כשהקול ייפתח";

  return (
    <div className="alert-unlock-overlay" role="alertdialog" aria-modal="true" aria-labelledby="alert-unlock-title">
      <button
        type="button"
        className="alert-unlock-backdrop"
        onClick={onControlClick}
        aria-label="הפעלת התראות קוליות"
        tabIndex={-1}
      />
      <div className="alert-unlock-card">
        {/* ⚠️ אותו סימן ואותה היררכיה כמו במסך ההתחברות — ולא וריאציה
            חדשה. שלט שקופץ באמצע המסך על רקע מעומעם הוא בדיוק הרגע שבו
            משתמש שואל "מה זה הדבר הזה"; סימן מוכר עונה על כך לפני שקוראים
            מילה. עיצוב משלו היה נראה כמו חלון של תוכנה אחרת. */}
        <div className="alert-unlock-brand">
          <img src="/parkomat-logo.png" alt="Parkomat" className="alert-unlock-logo" />
          <div className="alert-unlock-brand-text">
            <span className="alert-unlock-mark">Parkomat</span>
            <span className="alert-unlock-submark">SiteMonitor</span>
          </div>
        </div>
        <span className="alert-unlock-card-icon" aria-hidden="true">🔔</span>
        <h2 id="alert-unlock-title" className="alert-unlock-card-title">הפעלת התראות קוליות</h2>
        <p className="alert-unlock-card-text">{SUB}</p>
        <button
          type="button"
          className="alert-unlock-card-btn"
          onClick={onControlClick}
          autoFocus
        >
          הפעל צליל תקלה
        </button>
        {/* ⚠️ אומרים איך לא לראות את זה שוב — אחרת מסך קיר נראה תקוע, ומי
            שממהר מחפש איך "לעקוף". התשובה הנכונה היא הרשאה, לא עקיפה. */}
        <p className="alert-unlock-card-note">
          כדי שהחלון לא יופיע בכל פתיחה: הגדרות האתר בדפדפן ← Sound ← Allow
        </p>
      </div>
    </div>
  );
}

export default AlertUnlockBar;
