// components/AlertBell/AlertBell.jsx — מצב ההתראות הקוליות, ומתג ההשתקה.
//
// ==========================================================
// למה זה חייב להיות גלוי, ולא אייקון שקט בפינה
// ==========================================================
// אזעקה שקטה שאיש אינו יודע עליה גרועה מאין אזעקה: כולם מניחים שהם יישמעו
// אם משהו ייפול. דפדפנים חוסמים אודיו עד למחווה של המשתמש, ועל מסך קיר אף
// אחד לא לוחץ — כלומר בדיוק במקום שבו הצליל הכי חשוב, הוא מת כברירת מחדל.
//
// לכן במצב חסום זה אינו אייקון אלא **כפתור רחב עם טקסט**, בצבע אזהרה
// ובפעימה איטית. הלחיצה עליו היא גם ההסבר וגם התיקון — היא עצמה המחווה
// שמשחררת את האודיו.
//
// בשאר המצבים זה כפתור קומפקטי בגודל של שאר כפתורי ה-header, כי אז אין מה
// להתריע עליו — רק להראות שהמערכת חמושה.

import { useAlertAudio } from "../../hooks/useAlertAudio";
import "./AlertBell.css";

function BellIcon({ muted }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      {muted && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

function AlertBell() {
  const { state, onControlClick } = useAlertAudio();

  // אין Web Audio בדפדפן — אין מה להציג ואין מה להבטיח.
  if (state === "unsupported") return null;

  // ============================================================
  // ⚠️ הכיתוב אומר גם **איך לפתור את זה לתמיד**
  // ============================================================
  // "לחץ כדי להפעיל" נכון פעם אחת ומטעה בכל פעם אחריה: על מסך קיר שאיש
  // אינו נוגע בו, כל טעינה מחדש חוזרת לחסימה. הדפדפן מתיר אודיו בלי
  // מחווה כשניתנה לאתר הרשאת **Sound** — וזו הגדרה חד-פעמית לכל מחשב,
  // לא לחיצה בכל בוקר.
  //
  // ⚠️ ומאז התיקון ב-alerts.js תקלה שקרתה בזמן החסימה **אינה אובדת** —
  // היא מצלצלת ברגע שהאודיו נפתח. הכיתוב אומר גם את זה, אחרת נראה
  // שהתקלה עברה בשקט.
  const LOCKED_TITLE =
    "הדפדפן חוסם קול עד למגע ראשון בעמוד. תקלה שתקרה עד אז תצלצל " +
    "מיד כשייפתח — היא אינה אובדת.\n\n" +
    "כדי שזה יעבוד לבד בכל טעינה: הגדרות האתר בדפדפן ← Sound ← Allow.";

  if (state === "locked") {
    return (
      <button
        type="button"
        className="alert-bell alert-bell-locked"
        onClick={onControlClick}
        title={LOCKED_TITLE}
      >
        <span className="alert-bell-pulse" aria-hidden="true" />
        <BellIcon muted />
        <span className="alert-bell-text">לחץ להפעלת התראות קוליות</span>
      </button>
    );
  }

  const isMuted = state === "muted";
  return (
    <button
      type="button"
      className={`alert-bell alert-bell-compact${isMuted ? " is-muted" : ""}`}
      onClick={onControlClick}
      aria-pressed={!isMuted}
      title={
        isMuted
          ? "התראות קוליות מושתקות — לחץ להפעלה"
          : "התראות קוליות פעילות — לחץ להשתקה"
      }
      aria-label={isMuted ? "התראות קוליות מושתקות" : "התראות קוליות פעילות"}
    >
      <BellIcon muted={isMuted} />
      <span className={`alert-bell-dot${isMuted ? " is-off" : ""}`} aria-hidden="true" />
    </button>
  );
}

export default AlertBell;
