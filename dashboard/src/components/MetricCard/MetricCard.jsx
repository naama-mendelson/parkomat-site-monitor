// components/MetricCard/MetricCard.jsx — כרטיס מדד בודד: מספר גדול + תווית + הסבר
import "./MetricCard.css";

/**
 * label  — שם המדד בעברית ברורה ("פעולות חניה")
 * value  — המספר להצגה (כבר מעוצב)
 * hint   — הסבר קצר מתחת ("כמה פעולות הושלמו בתקופה")
 * trend  — קומפוננטת TrendIndicator (אופציונלי)
 * accent — הדגשת המספר בכחול המותג (למדד המרכזי)
 * peak   — הדגשה בליים של פרקומט. שמור ל**שיאים** (היום/השעה העמוסים):
 *          אלה אינם "המדד החשוב" אלא "כאן היה הכי הרבה", וצבע נפרד הוא מה
 *          שמאפשר לסרוק אותם במבט בלי לקרוא את התוויות.
 * wide   — הכרטיס תופס את כל רוחב הרשת (לשורה בודדת)
 */
function MetricCard({ label, value, hint, trend, accent, peak, wide, tone }) {
  return (
    <div className={`metric-card ${accent ? "is-accent" : ""} ${peak ? "is-peak" : ""} ${wide ? "is-wide" : ""}`}>
      {/* tone — פס צבע בקצה הכרטיס. משמש כשכמה כרטיסים שייכים לקבוצות
          שונות באותה רשת (כניסה מול יציאה), והתווית לבדה מחייבת לקרוא
          כל אחד כדי לדעת לאן הוא שייך. */}
      {tone && <span className="metric-tone" style={{ background: tone }} />}
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {hint && <span className="metric-hint">{hint}</span>}
      {trend && <div className="metric-trend">{trend}</div>}
    </div>
  );
}

export default MetricCard;
