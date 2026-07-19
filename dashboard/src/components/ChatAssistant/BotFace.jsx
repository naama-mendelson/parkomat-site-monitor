// components/ChatAssistant/BotFace.jsx — הדמות של העוזר.
//
// SVG בשורה (inline) ולא תמונה — כדי שה-CSS יוכל להנפיש חלקים ממנו: העיניים
// ממצמצות, הפה זז כשהוא "מדבר", והאנטנה מהבהבת. תמונה סטטית לא הייתה מושכת
// את העין, וזו בדיוק הבעיה שהתבקשתי לפתור.
//
// ============================================================
// הפרופורציות תוקנו אחרי שראיתי אותו על המסך
// ============================================================
// בגרסה הראשונה הראש היה קטן והמסך כמעט שחור — בגודל 30px הוא נקרא ככתם כהה,
// לא כדמות. בפינת מסך יש שנייה אחת לתפוס את העין, וכתם לא תופס.
//
// לכן: ראש גדול יותר ביחס למסגרת, מסך בהיר יותר (כחול-לילה ולא שחור), עיניים
// גדולות עם נצנוץ, וחיוך — כדי שגם ב-26px זה ייקרא מיד כבוט ידידותי.
//
// הצבעים מגיעים מ-currentColor ומטוקני המותג — הבוט משנה צבע עם ערכת הנושא
// ואינו מוסיף אף צבע חדש לפרויקט.

function BotFace({ size = 40, talking = false, className = "" }) {
  return (
    <svg
      className={`bot ${talking ? "is-talking" : ""} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      {/* אנטנה + נורה */}
      <line className="bot-antenna" x1="24" y1="3" x2="24" y2="9"
            stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle className="bot-blip" cx="24" cy="2.8" r="2.8" fill="var(--brand-lime)" />

      {/* אוזניים */}
      <rect x="1.5" y="20" width="4" height="10" rx="2" fill="currentColor" opacity="0.7" />
      <rect x="42.5" y="20" width="4" height="10" rx="2" fill="currentColor" opacity="0.7" />

      {/* ראש */}
      <rect className="bot-head" x="5" y="9" width="38" height="32" rx="11" fill="currentColor" />

      {/* מסך הפנים — כחול לילה, לא שחור: מספיק כהה לניגוד, בהיר מספיק
          כדי שלא ייקרא כחור בגודל קטן */}
      <rect x="9.5" y="13.5" width="29" height="23" rx="8" fill="#16233d" />

      {/* עיניים — גדולות, זו מה שהופך את זה לפרצוף */}
      <g className="bot-eyes">
        <circle className="bot-eye" cx="18" cy="22.5" r="4.2" fill="var(--brand-lime)" />
        <circle className="bot-eye" cx="30" cy="22.5" r="4.2" fill="var(--brand-lime)" />
      </g>

      {/* נצנוץ — נותן חיים */}
      <circle cx="19.5" cy="21" r="1.35" fill="#fff" opacity="0.95" />
      <circle cx="31.5" cy="21" r="1.35" fill="#fff" opacity="0.95" />

      {/* חיוך — קו מעוגל. כשהוא "מדבר" הוא נפתח לפה */}
      <path className="bot-smile" d="M18.5 30.5 Q24 34.5 29.5 30.5"
            stroke="var(--brand-lime)" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export default BotFace;
