// components/ProgressRing/ProgressRing.jsx — טבעת התקדמות (SVG טהור)
import { useCountUp } from "../../hooks/useCountUp";
import "./ProgressRing.css";

/**
 * percent — 0..100
 * size    — קוטר בפיקסלים
 * color   — צבע הקשת
 * label   — טקסט קטן מתחת למספר
 */
function ProgressRing({ percent, size = 120, stroke = 10, color, label }) {
  const animated = useCountUp(percent ?? 0, 1600);

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, animated));

  // strokeLinecap="round" מתארך כל קצה קשת ב-stroke/2, ולכן קשת של 98%
  // "נסגרת" ונראית מלאה (הפער הזעיר מתמלא ע"י שני הכובעים). מקזזים את בליטת
  // שני הכובעים (סה"כ stroke) מהאורך המצויר, כך שהאורך ה*נראה* (קשת+כובעים)
  // תואם לאחוז האמיתי — ופער קטן שוב נראה. ב-100% אין פער, אז לא מקזזים.
  const capOverhang = clamped >= 99.95 ? 0 : stroke;
  const dash = Math.max(0, (clamped / 100) * c - capOverhang);

  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {/* מסובבים ב-90- כדי שהקשת תתחיל מלמעלה */}
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2} cy={size / 2} r={r}
            fill="none" strokeWidth={stroke}
            className="ring-track"
          />
          <circle
            cx={size / 2} cy={size / 2} r={r}
            fill="none"
            stroke={color || "var(--accent)"}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c - dash}`}
            className="ring-arc"
          />
        </g>
      </svg>

      <div className="ring-center">
        <strong className="ring-percent">
          {animated.toLocaleString("he-IL", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}
          <span>%</span>
        </strong>
        {label && <span className="ring-label">{label}</span>}
      </div>
    </div>
  );
}

export default ProgressRing;
