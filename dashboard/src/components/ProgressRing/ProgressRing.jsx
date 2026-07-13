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
  const dash = (clamped / 100) * c;

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
