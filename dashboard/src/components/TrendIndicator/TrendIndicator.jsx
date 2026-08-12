// components/TrendIndicator/TrendIndicator.jsx — חץ + אחוז שינוי מול התקופה הקודמת
import "./TrendIndicator.css";

/**
 * changePercent   — אחוז השינוי (null = אי אפשר לחשב)
 * previous        — הערך בתקופה הקודמת (לזיהוי עלייה מאפס)
 * hasComparison   — האם בכלל היו נתונים בתקופה הקודמת
 * higherIsBetter  — האם עלייה היא דבר טוב (פעולות/זמינות = כן, תקלות/כשל = לא)
 * comparisonLabel — "לעומת השבוע הקודם" / "לעומת יוני" / "לעומת 2025"
 *
 * הצבע נקבע לפי המשמעות ולא לפי הכיוון: תקלות שעלו = אדום, גם שהחץ למעלה.
 */
function TrendIndicator({
  changePercent, previous, hasComparison, higherIsBetter, comparisonLabel,
}) {
  // ==========================================================
  // עלייה מאפס אינה "אין נתוני השוואה"
  // ==========================================================
  // ⚠️ נתפס על המסך: אתר 2438 הראה 5 תקלות מול **0 בשבוע הקודם**, ובמקום
  // להבליט את זה הכרטיס אמר "אין נתוני השוואה". הפעולות באותו כרטיס דווקא
  // הציגו ↑50%, ולכן זה נקרא כנתון חסר ולא כשינוי.
  //
  // מתמטית הוא צודק: (5-0)/0 אינו מוגדר, ולכן percentChange מחזיר null.
  // אבל **null מבטא שני דברים שונים לגמרי**:
  //
  //   אין תקופה קודמת בכלל      → באמת אין מה להשוות   (hasComparison=false)
  //   הייתה תקופה, והערך היה 0  → **יש מה לומר**: זה עלה מאפס
  //
  // והמקרה השני הוא בדיוק החשוב ביותר במסך הזה: אתר שלא היו בו תקלות
  // והתחילו בו תקלות. הצגתו כ"אין נתונים" מסתירה את מה שהמסך נועד להראות.
  //
  // ⚠️ אחוז לא מוצג כאן בכוונה — כל מספר שיוצג יהיה המצאה. מה שנאמר הוא
  // מה שידוע: הערך הקודם היה אפס.
  const fromZero =
    (changePercent === null || changePercent === undefined) &&
    hasComparison && previous === 0;

  if (fromZero) {
    return (
      <div className={`trend trend-${higherIsBetter ? "good" : "bad"}`}>
        <span className="trend-value">
          <span className="trend-arrow">↑</span>
          מ-0
        </span>
        <span className="trend-label">{comparisonLabel}</span>
      </div>
    );
  }

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
