// components/PeriodTabs/PeriodTabs.jsx — בורר התקופה (שבוע / חודש / שנה)
import "./PeriodTabs.css";

const PERIODS = [
  { key: "week", label: "שבוע" },
  { key: "month", label: "חודש" },
  { key: "year", label: "שנה" },
];

// period: התקופה הפעילה | rangeLabel: הטווח בפועל ("יולי 2026"), מהשרת
function PeriodTabs({ period, onChange, rangeLabel }) {
  return (
    <div className="period-tabs">
      <div className="period-tabs-row" role="tablist">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            role="tab"
            aria-selected={p.key === period}
            className={`period-tab ${p.key === period ? "is-active" : ""}`}
            onClick={() => onChange(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* הטווח בפועל — כדי שיהיה ברור בדיוק אילו נתונים מוצגים */}
      {rangeLabel && <div className="period-range">מציג נתונים עבור: <strong>{rangeLabel}</strong></div>}
    </div>
  );
}

export default PeriodTabs;
