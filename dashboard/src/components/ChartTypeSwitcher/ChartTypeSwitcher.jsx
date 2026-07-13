// components/ChartTypeSwitcher/ChartTypeSwitcher.jsx — החלפת סוג הגרף.
//
// היו כאן ארבעה סוגים, אבל "קו" ו"שטח" ציירו את אותו קו בדיוק — "שטח" רק
// הוסיף מילוי כמעט שקוף מתחתיו. שני כפתורים, תצוגה אחת. עכשיו הקו *תמיד*
// מגיע עם המילוי, ונשארו שלושה סוגים שבאמת שונים זה מזה.
import "./ChartTypeSwitcher.css";

const TYPES = [
  { key: "line", label: "קו" },
  { key: "bar", label: "עמודות" },
  { key: "points", label: "נקודות" },
];

const Icon = ({ name }) => {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
      {name === "line" && (
        <>
          <polygon points="3,14 7,8 11,11 17,4 17,16 3,16" fill="currentColor" opacity="0.25" stroke="none" />
          <polyline points="3,14 7,8 11,11 17,4" {...p} />
        </>
      )}
      {name === "bar" && (
        <>
          <line x1="5" y1="16" x2="5" y2="10" {...p} />
          <line x1="10" y1="16" x2="10" y2="5" {...p} />
          <line x1="15" y1="16" x2="15" y2="12" {...p} />
        </>
      )}
      {name === "points" && (
        <>
          <circle cx="4" cy="14" r="1.7" fill="currentColor" stroke="none" />
          <circle cx="9" cy="8" r="1.7" fill="currentColor" stroke="none" />
          <circle cx="13" cy="11" r="1.7" fill="currentColor" stroke="none" />
          <circle cx="17" cy="5" r="1.7" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
};

function ChartTypeSwitcher({ type, onChange }) {
  // "area" הישן מתמפה ל"קו" — כדי שהעדפה שמורה לא תשאיר כפתור בלי סימון
  const active = type === "area" ? "line" : type;

  return (
    <div className="cts" role="group" aria-label="סוג גרף">
      {TYPES.map((t) => (
        <button
          key={t.key}
          className={`cts-btn ${t.key === active ? "is-active" : ""}`}
          onClick={() => onChange(t.key)}
          title={t.label}
          aria-pressed={t.key === active}
        >
          <Icon name={t.key} />
        </button>
      ))}
    </div>
  );
}

export default ChartTypeSwitcher;
