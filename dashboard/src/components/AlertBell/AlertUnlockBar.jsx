// components/AlertBell/AlertUnlockBar.jsx — הבקשה להפעיל קול, כשהדפדפן חוסם.
//
// ============================================================
// שלט מרכזי שנסוג מעצמו — ולמה לא אחד מהשניים בלבד
// ============================================================
// הפס בראש המסך היה קל מדי לפספס. שלט באמצע המסך הוא מה שנדרש: מי שפותח
// את התוכנה רואה אותו ולוחץ, וזהו.
//
// ⚠️ **אבל חלון שנשאר באמצע לנצח הוא מלכודת, ולא תיאורטית.** מסך קיר
// שמתאתחל בלילה — הפסקת חשמל, עדכון Windows — יעלה, ישחזר את הסשן,
// וייתקע על השלט **בלי להציג שום אתר** עד שמישהו יגיע פיזית בבוקר.
// תקלות יקרו והמסך יראה כפתור במקום את המערכת. זה גרוע יותר מקול שקט:
// קול חסר משאיר את המידע על המסך, חלון חוסם מוחק גם אותו.
//
// לכן שני שלבים:
//
//   1. **RETREAT_MS השניות הראשונות** — שלט מרכזי, על רקע מעומעם. בלתי
//      אפשרי לפספס. זה מכסה את המקרה האמיתי: אדם שפתח את התוכנה ומסתכל.
//   2. **אחריהן** — נסוג לפס דק בראש המסך. הדשבורד גלוי במלואו, והבקשה
//      עדיין שם. זה מכסה את מסך הקיר שאיש לא נמצא לידו.
//
// ⚠️ **הנסיגה מתוזמנת ולא מותנית בעכבר.** "נסוג רק אם אין תנועה" נשמע
// חכם ונכשל בדיוק במקרה שחשוב: במסך קיר אין תנועה לעולם, ולכן התנאי היה
// מתקיים תמיד — או לעולם לא, תלוי בניסוח. שעון פשוט מתנהג זהה בשני
// המצבים.
//
// ⚠️ **וכל מגע במסך משחרר, לא רק הכפתור.** useAlertAudio מאזין ל-
// pointerdown ול-keydown ברמת החלון, ולכן השלט נעלם ברגע שנוגעים במשהו —
// הוא אינו "עוד כפתור שצריך למצוא".
//
// ⚠️ ולא מוצג כשהמשתמש **השתיק** ביודעין: השתקה היא בחירה, ושלט שמנדנד
// למי שבחר בשקט הופך את עצמו לרעש שלומדים להתעלם ממנו — בדיוק מה שהורג
// גם את הצליל האמיתי.
import { useEffect, useState } from "react";
import { useAlertAudio } from "../../hooks/useAlertAudio";
import "./AlertUnlockBar.css";

// ⚠️ 25 שניות: מספיק בנדיבות למי שפתח את התוכנה ומסתכל עליה, וקצר מספיק
// שמסך קיר לא יבזבז דקות מוסתר. נמדד לפי הכוונה ולא לפי טעם — הזמן שבין
// "פתחתי" ל"קראתי מה כתוב ולחצתי".
const RETREAT_MS = 25000;

function AlertUnlockBar() {
  const { state, onControlClick } = useAlertAudio();
  const [retreated, setRetreated] = useState(false);

  // ⚠️ השעון מתחיל רק כשהשלט באמת מוצג. בלי התנאי הוא היה רץ גם כשהקול
  // כבר פעיל, ואז משתמש שהשתיק והחזיר היה מקבל את הפס הדק במקום השלט.
  useEffect(() => {
    if (state !== "locked" || retreated) return;
    const t = setTimeout(() => setRetreated(true), RETREAT_MS);
    return () => clearTimeout(t);
  }, [state, retreated]);

  if (state !== "locked") return null;

  const SUB = "הדפדפן חוסם קול עד למגע ראשון · תקלה שתקרה עד אז תצלצל מיד כשייפתח";

  // ---- שלב 2: נסוג לפס דק ----
  if (retreated) {
    return (
      <button
        type="button"
        className="alert-unlock-bar"
        onClick={onControlClick}
        // ⚠️ status ולא alert: זו הודעת מצב מתמשכת, ו-alert היה מקטיע קורא
        // מסך באמצע כל פעולה אחרת.
        role="status"
      >
        <span className="alert-unlock-icon" aria-hidden="true">🔔</span>
        <span className="alert-unlock-main">לחצו כאן להפעלת התראות קוליות</span>
        <span className="alert-unlock-sub">{SUB}</span>
      </button>
    );
  }

  // ---- שלב 1: שלט מרכזי ----
  return (
    <div className="alert-unlock-overlay" role="status">
      {/* ⚠️ הרקע עצמו לוחצי: מי שינסה "לסגור" בלחיצה בצד יקבל בדיוק את
          מה שהוא רצה — קול פעיל — במקום כלום. */}
      <button
        type="button"
        className="alert-unlock-backdrop"
        onClick={onControlClick}
        aria-label="הפעלת התראות קוליות"
        tabIndex={-1}
      />
      <div className="alert-unlock-card">
        <span className="alert-unlock-card-icon" aria-hidden="true">🔔</span>
        <h2 className="alert-unlock-card-title">הפעלת התראות קוליות</h2>
        <p className="alert-unlock-card-text">{SUB}</p>
        <button
          type="button"
          className="alert-unlock-card-btn"
          onClick={onControlClick}
          autoFocus
        >
          הפעל צליל תקלה
        </button>
        {/* ⚠️ אומרים שהשלט ייעלם מעצמו. בלי זה מי שממהר מרגיש חסום, ומסך
            קיר נראה כאילו הוא תקוע — שתי תחושות שגויות שקל למנוע במשפט. */}
        <p className="alert-unlock-card-note">
          ההודעה תיעלם מעצמה ותעבור לפס עליון · הדשבורד לא ייחסם
        </p>
      </div>
    </div>
  );
}

export default AlertUnlockBar;
