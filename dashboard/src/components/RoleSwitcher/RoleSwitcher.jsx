// components/RoleSwitcher/RoleSwitcher.jsx — בורר תפקיד (בקר / מנהל בקרה / מנהל כללי)
import "./RoleSwitcher.css";

// לא מיוצא: קובץ קומפוננטה שמייצא גם קבועים שובר את ה-fast-refresh של Vite.
const ROLES = [
  { key: "operator", label: "בקר", title: "ניטור תפעולי שוטף" },
  { key: "supervisor", label: "מנהל בקרה", title: "ניהול תפעולי ופירוט" },
  { key: "executive", label: "מנהל כללי", title: "תמונה עסקית ומגמות" },
];

const Icon = ({ name }) => {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" className="rs-icon" aria-hidden="true">
      {name === "operator" && (
        <>
          <rect x="2.5" y="3" width="15" height="11" rx="2" {...p} />
          <line x1="7" y1="17" x2="13" y2="17" {...p} />
        </>
      )}
      {name === "supervisor" && (
        <>
          <line x1="3" y1="5" x2="17" y2="5" {...p} />
          <line x1="3" y1="10" x2="17" y2="10" {...p} />
          <line x1="3" y1="15" x2="17" y2="15" {...p} />
        </>
      )}
      {name === "executive" && (
        <>
          <polyline points="3,14 7.5,9 11,12 17,5" {...p} />
          <polyline points="13,5 17,5 17,9" {...p} />
        </>
      )}
    </svg>
  );
};

function RoleSwitcher({ role, onChange }) {
  return (
    <nav className="rs" role="tablist" aria-label="בחירת תפקיד">
      {ROLES.map((r) => (
        <button
          key={r.key}
          role="tab"
          aria-selected={r.key === role}
          title={r.title}
          className={`rs-tab ${r.key === role ? "is-active" : ""}`}
          onClick={() => onChange(r.key)}
        >
          <Icon name={r.key} />
          <span className="rs-label">{r.label}</span>
        </button>
      ))}
    </nav>
  );
}

export default RoleSwitcher;
