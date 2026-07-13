// components/BarChart/BarChart.jsx — גרף עמודות ב-SVG טהור (בלי ספריות)
import "./BarChart.css";

const H = 100;          // גובה לוגי
const LABEL_H = 16;
const CHART_H = H - LABEL_H;

/**
 * bars       — [{ label, value }]
 * color      — צבע העמודות
 * highlight  — ערך שיודגש (למשל השעה העמוסה)
 * unit       — יחידה ב-tooltip ("פעולות")
 * everyLabel — הצג תווית כל N עמודות (לצירים צפופים כמו 24 שעות)
 */
function BarChart({ bars, color, highlight, unit = "", everyLabel = 1 }) {
  if (!bars || bars.length === 0) {
    return <p className="bc-empty">אין נתונים</p>;
  }

  const max = Math.max(1, ...bars.map((b) => b.value));
  const n = bars.length;
  const W = Math.max(240, n * 14);      // רוחב לוגי גדל עם מספר העמודות
  const slot = W / n;
  const barW = Math.max(3, slot * 0.62);

  const isEmpty = bars.every((b) => b.value === 0);
  if (isEmpty) return <p className="bc-empty">לא נרשמה פעילות</p>;

  return (
    <div className="bc">
      <svg
        className="bc-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="גרף פעילות"
      >
        <line
          x1="0" y1={CHART_H} x2={W} y2={CHART_H}
          stroke="var(--border-color)" strokeWidth="1" vectorEffect="non-scaling-stroke"
        />
        {bars.map((b, i) => {
          const h = (b.value / max) * (CHART_H - 4);
          const x = (i + 0.5) * slot - barW / 2;
          const isPeak = highlight !== undefined && b.value === highlight && b.value > 0;
          return (
            <rect
              key={i}
              x={x}
              y={CHART_H - h}
              width={barW}
              height={Math.max(b.value > 0 ? 2 : 0, h)}
              rx="1.5"
              fill={color}
              opacity={isPeak ? 1 : 0.62}
            >
              <title>{`${b.label}: ${b.value} ${unit}`}</title>
            </rect>
          );
        })}
      </svg>

      <div className="bc-labels" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
        {bars.map((b, i) => (
          <span key={i} className={i % everyLabel === 0 ? "" : "is-hidden"}>
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default BarChart;
