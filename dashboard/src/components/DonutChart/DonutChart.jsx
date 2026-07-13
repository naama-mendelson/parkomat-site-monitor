// components/DonutChart/DonutChart.jsx — טבעת יחסים ב-SVG טהור
import "./DonutChart.css";

const SIZE = 120;
const STROKE = 18;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

/**
 * slices     — [{ label, value, color }]
 * centerNote — טקסט קטן מתחת למספר המרכזי
 */
function DonutChart({ slices, centerNote }) {
  const total = slices.reduce((s, x) => s + x.value, 0);

  if (total === 0) {
    return <p className="donut-empty">אין נתונים לתקופה</p>;
  }

  // בונים את הטבעת ממקטעים רצופים לפי stroke-dasharray + offset
  let offset = 0;
  const arcs = slices.map((s) => {
    const len = (s.value / total) * C;
    const arc = { ...s, len, offset };
    offset += len;
    return arc;
  });

  return (
    <div className="donut">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="פילוח">
        {/* מסובבים ב-90-, כדי שהמקטע הראשון יתחיל מלמעלה */}
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          <circle
            cx={SIZE / 2} cy={SIZE / 2} r={R}
            fill="none" stroke="var(--bg-hover)" strokeWidth={STROKE}
          />
          {arcs.map((a) => (
            <circle
              key={a.label}
              cx={SIZE / 2} cy={SIZE / 2} r={R}
              fill="none"
              stroke={a.color}
              strokeWidth={STROKE}
              strokeDasharray={`${a.len} ${C - a.len}`}
              strokeDashoffset={-a.offset}
            >
              <title>{`${a.label}: ${a.value}`}</title>
            </circle>
          ))}
        </g>

        <text
          x="50%" y="47%"
          textAnchor="middle" dominantBaseline="middle"
          className="donut-total"
        >
          {total.toLocaleString()}
        </text>
        {centerNote && (
          <text x="50%" y="63%" textAnchor="middle" className="donut-note">
            {centerNote}
          </text>
        )}
      </svg>

      <ul className="donut-legend">
        {slices.map((s) => (
          <li key={s.label}>
            <span className="donut-dot" style={{ background: s.color }} />
            <span className="donut-label">{s.label}</span>
            <strong>{s.value.toLocaleString()}</strong>
            <span className="donut-pct">
              {Math.round((s.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default DonutChart;
