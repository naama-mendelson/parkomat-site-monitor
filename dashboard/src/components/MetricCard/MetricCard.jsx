// components/MetricCard/MetricCard.jsx — כרטיס מדד בודד: מספר גדול + תווית + הסבר
import "./MetricCard.css";

/**
 * label  — שם המדד בעברית ברורה ("פעולות חניה")
 * value  — המספר להצגה (כבר מעוצב)
 * hint   — הסבר קצר מתחת ("כמה פעולות הושלמו בתקופה")
 * trend  — קומפוננטת TrendIndicator (אופציונלי)
 * accent — הדגשת המספר (למדד המרכזי)
 * wide   — הכרטיס תופס את כל רוחב הרשת (לשורה בודדת)
 */
function MetricCard({ label, value, hint, trend, accent, wide }) {
  return (
    <div className={`metric-card ${accent ? "is-accent" : ""} ${wide ? "is-wide" : ""}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {hint && <span className="metric-hint">{hint}</span>}
      {trend && <div className="metric-trend">{trend}</div>}
    </div>
  );
}

export default MetricCard;
