// components/KpiCard/KpiCard.jsx — כרטיס KPI גדול למסך המנהל הכללי
import AnimatedNumber from "../AnimatedNumber/AnimatedNumber";
import TrendIndicator from "../TrendIndicator/TrendIndicator";
import "./KpiCard.css";

/**
 * label      — שם המדד ("סה\"כ פעולות חניה")
 * value      — המספר (מונפש)
 * decimals   — ספרות אחרי הנקודה
 * suffix     — "%", "שעות"
 * hint       — משפט מסביר
 * accent     — צבע ההדגשה (גם ל-glow וגם ל-gradient)
 * trend      — { changePercent, higherIsBetter, comparisonLabel }
 * visual     — אלמנט ויזואלי מימין (למשל ProgressRing)
 * delay      — השהיית כניסה (ל-stagger)
 */
function KpiCard({
  label, value, decimals = 0, suffix = "", hint,
  accent = "var(--accent)", trend, visual, delay = 0,
}) {
  return (
    <article
      className="kpi"
      style={{ "--kpi-accent": accent, animationDelay: `${delay}ms` }}
    >
      {/* זוהר עדין ברקע — נותן את התחושה ה"יוקרתית" בלי להפריע לקריאוּת */}
      <span className="kpi-glow" aria-hidden="true" />

      <div className="kpi-body">
        <span className="kpi-label">{label}</span>

        <div className="kpi-value">
          <AnimatedNumber value={value} decimals={decimals} suffix={suffix} />
        </div>

        {hint && <p className="kpi-hint">{hint}</p>}

        {trend && (
          <div className="kpi-trend">
            <TrendIndicator
              changePercent={trend.changePercent}
              higherIsBetter={trend.higherIsBetter}
              comparisonLabel={trend.comparisonLabel}
            />
          </div>
        )}
      </div>

      {visual && <div className="kpi-visual">{visual}</div>}
    </article>
  );
}

export default KpiCard;
