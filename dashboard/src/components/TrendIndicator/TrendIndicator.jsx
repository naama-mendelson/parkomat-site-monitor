// components/TrendIndicator/TrendIndicator.jsx — חץ + אחוז שינוי מול התקופה הקודמת
import "./TrendIndicator.css";

/**
 * changePercent   — אחוז השינוי (null = אי אפשר לחשב)
 * higherIsBetter  — האם עלייה היא דבר טוב (פעולות/זמינות = כן, תקלות/כשל = לא)
 * comparisonLabel — "לעומת השבוע הקודם" / "לעומת יוני" / "לעומת 2025"
 *
 * הצבע נקבע לפי המשמעות ולא לפי הכיוון: תקלות שעלו = אדום, גם שהחץ למעלה.
 */
function TrendIndicator({ changePercent, higherIsBetter, comparisonLabel }) {
  if (changePercent === null || changePercent === undefined) {
    return <div className="trend trend-none">אין נתוני השוואה</div>;
  }

  const flat = changePercent === 0;
  const up = changePercent > 0;
  const good = flat ? null : up === higherIsBetter;

  const tone = flat ? "flat" : good ? "good" : "bad";
  const arrow = flat ? "→" : up ? "↑" : "↓";

  return (
    <div className={`trend trend-${tone}`}>
      <span className="trend-value">
        <span className="trend-arrow">{arrow}</span>
        {Math.abs(changePercent)}%
      </span>
      <span className="trend-label">{comparisonLabel}</span>
    </div>
  );
}

export default TrendIndicator;
