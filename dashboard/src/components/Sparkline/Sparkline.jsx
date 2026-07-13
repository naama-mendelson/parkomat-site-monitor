// components/Sparkline/Sparkline.jsx — גרף מגמה קטן ב-SVG טהור (בלי ספריות)
import { STATUS_COLORS } from "../../utils/constants";
import "./Sparkline.css";

const W = 300;          // רוחב לוגי (ה-SVG נמתח לרוחב הפאנל)
const H = 70;
const LABEL_H = 14;     // מקום לתוויות הציר
const CHART_H = H - LABEL_H;

const OPS_COLOR = STATUS_COLORS.operating.dot;      // כחול — פעולות
const ERR_COLOR = STATUS_COLORS.error.dot;          // אדום — תקלות
const MNT_COLOR = STATUS_COLORS.maintenance.dot;    // צהוב — תחזוקה

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

  const sum = (key) => points.reduce((s, p) => s + (p[key] || 0), 0);
  const totalOps = sum("operations");
  const totalErrs = sum("errors");
  const totalMnt = sum("maintenance");

  if (totalOps === 0 && totalErrs === 0 && totalMnt === 0) {
    return <p className="spark-empty">לא נרשמה פעילות בתקופה זו</p>;
  }

  const n = points.length;
  // סקאלה משותפת לכל הסדרות — כך היחס ביניהן נשאר אמיתי.
  const max = Math.max(
    1,
    ...points.map((p) => Math.max(p.operations, p.errors, p.maintenance || 0)),
  );

  const slot = W / n;
  const barW = Math.max(2, slot * 0.55);
  const thinW = Math.max(1.5, barW * 0.32);   // תקלות/תחזוקה — צרות, מצוירות מלפנים
  const cx = (i) => (i + 0.5) * slot;
  const y = (v) => CHART_H - (v / max) * CHART_H;

  // גובה מינימלי לערך שאינו אפס. בלעדיו תקלה בודדת מול עשרות פעולות
  // (סקאלה משותפת) נצמדת לקו הבסיס ופשוט לא נראית.
  const MIN_H = 4;
  const barH = (v) => (v > 0 ? Math.max(MIN_H, CHART_H - y(v)) : 0);

  const showIdx = labelIndexes(n);

  return (
    <div className="spark">
      <div className="spark-legend">
        <span><i style={{ background: OPS_COLOR }} /> פעולות</span>
        <span><i style={{ background: ERR_COLOR }} /> תקלות</span>
        <span><i style={{ background: MNT_COLOR }} /> תחזוקה</span>
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
            y={CHART_H - barH(p.operations)}
            width={barW}
            height={barH(p.operations)}
            fill={OPS_COLOR}
            rx="1"
          >
            <title>
              {`${p.label}: ${p.operations} פעולות · ${p.errors} תקלות · ${p.maintenance || 0} תחזוקה`}
            </title>
          </rect>
        ))}

        {/* תקלות (אדום) ותחזוקה (צהוב) — צרות, מלפנים, בגובה מינימלי כדי
            שאירוע בודד מול עשרות פעולות עדיין ייראה. משוכות מעט לצדדים
            כדי שלא יסתירו זו את זו כשקרו באותו יום. */}
        {points.map((p, i) =>
          p.errors > 0 ? (
            <rect
              key={`e${i}`}
              x={cx(i) - thinW - 0.6}
              y={CHART_H - barH(p.errors)}
              width={thinW}
              height={barH(p.errors)}
              fill={ERR_COLOR}
              rx="0.8"
            >
              <title>{`${p.label}: ${p.errors} תקלות`}</title>
            </rect>
          ) : null,
        )}

        {points.map((p, i) =>
          p.maintenance > 0 ? (
            <rect
              key={`m${i}`}
              x={cx(i) + 0.6}
              y={CHART_H - barH(p.maintenance)}
              width={thinW}
              height={barH(p.maintenance)}
              fill={MNT_COLOR}
              rx="0.8"
            >
              <title>{`${p.label}: ${p.maintenance} כניסות לתחזוקה`}</title>
            </rect>
          ) : null,
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
