// components/InsightsModal/SectionNav.jsx — ניווט בין מסכי המידע
import "./SectionNav.css";

// אייקונים קטנים ב-SVG טהור — נקיים, חדים בכל גודל, בלי ספריות.
const Icon = ({ name }) => {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
  return (
    <svg className="sn-icon" viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
      {name === "overview" && (
        <>
          <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" {...p} />
          <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" {...p} />
          <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" {...p} />
          <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" {...p} />
        </>
      )}
      {name === "activity" && (
        <>
          <line x1="4" y1="16.5" x2="4" y2="10" {...p} />
          <line x1="8.7" y1="16.5" x2="8.7" y2="5" {...p} />
          <line x1="13.3" y1="16.5" x2="13.3" y2="12" {...p} />
          <line x1="17" y1="16.5" x2="17" y2="7.5" {...p} />
        </>
      )}
      {name === "cards" && (
        <>
          <rect x="2.5" y="4" width="15" height="12" rx="2" {...p} />
          <line x1="2.5" y1="8" x2="17.5" y2="8" {...p} />
          <line x1="7" y1="8" x2="7" y2="16" {...p} />
        </>
      )}
      {name === "reliability" && (
        <>
          <circle cx="10" cy="10" r="7.2" {...p} />
          <polyline points="10,5.6 10,10 13,11.8" {...p} />
        </>
      )}
      {name === "log" && (
        <>
          <circle cx="4.5" cy="5.5" r="1.6" {...p} />
          <circle cx="4.5" cy="14.5" r="1.6" {...p} />
          <line x1="9" y1="5.5" x2="17" y2="5.5" {...p} />
          <line x1="9" y1="14.5" x2="17" y2="14.5" {...p} />
          <line x1="4.5" y1="7.6" x2="4.5" y2="12.4" {...p} />
        </>
      )}
    </svg>
  );
};

function SectionNav({ sections, active, onChange }) {
  return (
    <nav className="sn" role="tablist">
      {sections.map((s) => (
        <button
          key={s.key}
          role="tab"
          aria-selected={s.key === active}
          className={`sn-tab ${s.key === active ? "is-active" : ""}`}
          onClick={() => onChange(s.key)}
        >
          <Icon name={s.key} />
          <span className="sn-label">{s.label}</span>
          {s.badge !== undefined && s.badge !== null && (
            <span className="sn-badge">{s.badge}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

export default SectionNav;
