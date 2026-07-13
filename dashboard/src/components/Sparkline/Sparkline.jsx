// components/Sparkline/Sparkline.jsx — גרף מגמה קטן ב-SVG טהור (בלי ספריות)
import { STATUS_COLORS } from "../../utils/constants";
import "./Sparkline.css";

const W = 300;          // רוחב לוגי (ה-SVG נמתח לרוחב הפאנל)
const H = 70;
const LABEL_H = 14;     // מקום לתוויות הציר
const CHART_H = H - LABEL_H;

const OPS_COLOR = STATUS_COLORS.operating.dot;   // כחול — פעולות
const ERR_COLOR = STATUS_COLORS.error.dot;       // אדום — תקלות

// עד 4 תוויות על הציר, כדי לא לצפף
function labelIndexes(n) {
  if (n <= 4) return [...Array(n).keys()];
  const step = (n - 1) / 3;
  return [0, 1, 2, 3].map((i) => Math.round(i * step));
}

function Sparkline({ points }) {
  if (!points || points.length === 0) {
    return <p className="spark-empty">אין נתונים לתקופה זו</p>;
  }

  const totalOps = points.reduce((s, p) => s + p.operations, 0);
  const totalErrs = points.reduce((s, p) => s + p.errors, 0);

  if (totalOps === 0 && totalErrs === 0) {
    return <p className="spark-empty">לא נרשמה פעילות בתקופה זו</p>;
  }

  const n = points.length;
  // סקאלה משותפת לשני הסדרות — כך היחס ביניהן נשאר אמיתי (מעט תקלות = קו נמוך).
  const max = Math.max(1, ...points.map((p) => Math.max(p.operations, p.errors)));

  const slot = W / n;
  const barW = Math.max(2, slot * 0.55);
  const cx = (i) => (i + 0.5) * slot;
  const y = (v) => CHART_H - (v / max) * CHART_H;

  const errLine = points.map((p, i) => `${cx(i)},${y(p.errors)}`).join(" ");
  const showIdx = labelIndexes(n);

  return (
    <div className="spark">
      <div className="spark-legend">
        <span><i style={{ background: OPS_COLOR }} /> פעולות</span>
        <span><i style={{ background: ERR_COLOR }} /> תקלות</span>
      </div>

      <svg
        className="spark-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`מגמה: ${totalOps} פעולות, ${totalErrs} תקלות`}
      >
        {/* קו בסיס */}
        <line x1="0" y1={CHART_H} x2={W} y2={CHART_H}
              stroke="var(--border-color)" strokeWidth="1" vectorEffect="non-scaling-stroke" />

        {/* עמודות הפעולות */}
        {points.map((p, i) => (
          <rect
            key={`b${i}`}
            x={cx(i) - barW / 2}
            y={y(p.operations)}
            width={barW}
            height={Math.max(0, CHART_H - y(p.operations))}
            fill={OPS_COLOR}
            rx="1"
          >
            <title>{`${p.label}: ${p.operations} פעולות, ${p.errors} תקלות`}</title>
          </rect>
        ))}

        {/* קו התקלות */}
        {totalErrs > 0 && (
          <polyline
            points={errLine}
            fill="none"
            stroke={ERR_COLOR}
            strokeWidth="1.75"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {/* left (ולא insetInlineStart): ה-SVG הוא LTR, ו-insetInlineStart ב-RTL
          היה ממקם את התווית מהצד הנגדי — כלומר במראה הפוכה מהנקודה. */}
      <div className="spark-labels">
        {showIdx.map((i) => (
          <span key={i} style={{ left: `${(cx(i) / W) * 100}%` }}>
            {points[i].label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default Sparkline;
