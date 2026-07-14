// components/LineChart/LineChart.jsx — גרף רב-סוגי ב-SVG טהור: קו · עמודות · נקודות.
// הקו מגיע תמיד עם מילוי מדורג מתחתיו (זה היה פעם סוג נפרד בשם "שטח"),
// מצויר בעקומה חלקה, ומצייר את עצמו בכניסה.
import { useState } from "react";
import "./LineChart.css";

const W = 720;
const H = 260;
const PAD = { top: 20, right: 16, bottom: 28, left: 16 };
const IN_W = W - PAD.left - PAD.right;
const IN_H = H - PAD.top - PAD.bottom;

// שם המשפחה של המדד קובע את הסקאלה שלו.
// קריטי: אילו נירמלנו כל סדרה לשיא *שלה*, תקלה בודדת הייתה מגיעה לגובה
// זהה ל-140 פעולות — שקר ויזואלי. מדדים באותה יחידה חולקים סקאלה.
const familyOf = (key) => {
  if (key === "availability" || key === "failureRate") return "percent";
  if (key === "maintenanceHours") return "hours";
  return "count";
};

/**
 * עקומה חלקה (Fritsch–Carlson): נראית הרבה יותר יוקרתית מקו שבור,
 * אבל *בלי* לשקר — האלגוריתם מונע "התנפחות" מעבר לערכים האמיתיים.
 * עקומת Bézier נאיבית הייתה מציירת בליטה מעל 9 בין שתי נקודות של 9,
 * כלומר ערך שלא קיים בנתונים. כאן זה לא יכול לקרות.
 */
function smoothPath(pts) {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M ${pts[0].x} ${pts[0].y}`;
  if (n === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;

  // שיפועי המיתרים בין נקודות סמוכות
  const dx = [], dy = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    dy[i] = pts[i + 1].y - pts[i].y;
    slope[i] = dx[i] === 0 ? 0 : dy[i] / dx[i];
  }

  // משיקים — מאופסים בכל נקודת קיצון, וזה מה ששומר על המונוטוניות
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0
      ? 0
      : (slope[i - 1] + slope[i]) / 2;
  }
  m[n - 1] = slope[n - 2];

  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      m[i] = (3 * a * slope[i]) / h;
      m[i + 1] = (3 * b * slope[i]) / h;
    }
  }

  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const t = dx[i] / 3;
    d += ` C ${pts[i].x + t} ${pts[i].y + m[i] * t}`
       + ` ${pts[i + 1].x - t} ${pts[i + 1].y - m[i + 1] * t}`
       + ` ${pts[i + 1].x} ${pts[i + 1].y}`;
  }
  return d;
}

function LineChart({
  points,
  series,
  type = "line",
  showGrid = true,
  showValues = false,
}) {
  const [hover, setHover] = useState(null);

  if (!points || points.length === 0) {
    return <p className="lc-empty">אין נתונים בטווח הנבחר</p>;
  }

  // "area" הישן = "קו" (המילוי כלול בו ממילא)
  const mode = type === "area" ? "line" : type;
  const n = points.length;

  // סקאלה לכל משפחת יחידות
  const maxByFamily = {};
  for (const s of series) {
    const f = familyOf(s.key);
    const m = Math.max(...points.map((p) => p[s.key] || 0));
    maxByFamily[f] = Math.max(maxByFamily[f] || 0, m);
  }
  for (const f of Object.keys(maxByFamily)) {
    if (maxByFamily[f] <= 0) maxByFamily[f] = 1;
  }

  const families = [...new Set(series.map((s) => familyOf(s.key)))];
  const mixedUnits = families.length > 1;

  const x = (i) => (n === 1 ? PAD.left + IN_W / 2 : PAD.left + (i / (n - 1)) * IN_W);
  const yOf = (s) => (v) =>
    PAD.top + IN_H - ((v || 0) / maxByFamily[familyOf(s.key)]) * IN_H;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: PAD.top + IN_H - f * IN_H,
    value: Math.round(maxByFamily[families[0]] * f),
  }));

  const labelStep = Math.max(1, Math.ceil(n / 7));

  // רוחב עמודה כשמצב 'bar' — מחולק בין הסדרות
  const slot = IN_W / Math.max(1, n);
  const barW = Math.max(2, (slot * 0.62) / series.length);
  const BASE = PAD.top + IN_H;

  return (
    <div className="lc">
      <div className="lc-legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        {mixedUnits && (
          <span className="lc-note" title="לכל יחידה סקאלה משלה">
            ⓘ מדדים ביחידות שונות — לכל יחידה סקאלה משלה
          </span>
        )}
      </div>

      <div className="lc-plot">
        <svg viewBox={`0 0 ${W} ${H}`} className="lc-svg" role="img" aria-label="גרף מגמה">
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`lc-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.34" />
                <stop offset="70%" stopColor={s.color} stopOpacity="0.06" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {showGrid &&
            grid.map((g, i) => (
              <g key={i}>
                <line x1={PAD.left} y1={g.y} x2={W - PAD.right} y2={g.y} className="lc-grid" />
                <text x={PAD.left - 4} y={g.y - 3} className="lc-gridlabel">{g.value}</text>
              </g>
            ))}

          {series.map((s, si) => {
            const y = yOf(s);
            const coords = points.map((p, i) => ({ x: x(i), y: y(p[s.key]) }));
            const linePath = smoothPath(coords);
            // המילוי הוא אותה עקומה בדיוק, סגורה אל קו הבסיס
            const areaPath = `${linePath} L ${x(n - 1)} ${BASE} L ${x(0)} ${BASE} Z`;

            return (
              // ה-key כולל את הסוג ומספר הנקודות: החלפת תצוגה או טווח
              // מרכיבה את הקבוצה מחדש, ולכן האנימציה רצה שוב במקום לקפוא.
              <g key={`${mode}-${s.key}-${n}`}>
                {/* --- עמודות --- */}
                {mode === "bar" &&
                  points.map((p, i) => {
                    const h = BASE - y(p[s.key]);
                    const offset = (si - (series.length - 1) / 2) * barW;
                    return (
                      <rect
                        key={i}
                        className="lc-bar"
                        x={x(i) + offset - barW / 2}
                        y={y(p[s.key])}
                        width={barW}
                        height={Math.max(0, h)}
                        fill={s.color}
                        rx="1.5"
                        style={{ animationDelay: `${i * 25}ms` }}
                      />
                    );
                  })}

                {/* --- קו + מילוי --- */}
                {mode === "line" && (
                  <>
                    <path
                      d={areaPath}
                      fill={`url(#lc-${s.key})`}
                      className="lc-area"
                      style={{ animationDelay: `${si * 90 + 260}ms` }}
                    />
                    {/* אין כאן vectorEffect="non-scaling-stroke", ובכוונה.
                        הוא היה כאן קודם, והוא מתנגש עם pathLength: כשהוא מופעל,
                        הדפדפן מפרש stroke-dasharray: 1 כ*פיקסל אחד* במקום כאורך
                        הנתיב המלא — והקו נחתך לפני הנקודה האחרונה. זה לא נראה
                        כמו באג באנימציה אלא כמו נתון חסר בגרף.
                        בלעדיו עובי הקו מתכווץ/מתרחב קלות עם גודל ה-SVG — מחיר
                        זניח לעומת גרף שמציג את כל הנקודות. */}
                    <path
                      d={linePath}
                      fill="none"
                      stroke={s.color}
                      strokeWidth="2.5"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      className="lc-line"
                      pathLength="1"                 /* מאפשר לצייר את הקו בלי לדעת את אורכו */
                      style={{ animationDelay: `${si * 90}ms` }}
                    />
                  </>
                )}

                {/* --- נקודות --- */}
                {mode !== "bar" &&
                  points.map((p, i) => (
                    <circle
                      key={i}
                      cx={x(i)}
                      cy={y(p[s.key])}
                      r={hover === i ? 5.5 : mode === "points" ? 4 : 3}
                      fill={s.color}
                      className="lc-dot"
                      style={{ animationDelay: `${si * 90 + i * 26 + 200}ms` }}
                    />
                  ))}

                {/* --- ערכים על הגרף --- */}
                {showValues &&
                  points.map((p, i) => (
                    <text
                      key={i}
                      x={x(i)}
                      y={y(p[s.key]) - 7}
                      className="lc-valuelabel"
                      fill={s.color}
                    >
                      {p[s.key] || 0}
                    </text>
                  ))}
              </g>
            );
          })}

          {hover !== null && (
            <line x1={x(hover)} y1={PAD.top} x2={x(hover)} y2={BASE} className="lc-cursor" />
          )}

          {/* אזורי היט */}
          {points.map((p, i) => (
            <rect
              key={`h${i}`}
              x={x(i) - slot / 2}
              y={PAD.top}
              width={Math.max(8, slot)}
              height={IN_H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}

          {points.map((p, i) =>
            i % labelStep === 0 || i === n - 1 ? (
              <text key={`l${i}`} x={x(i)} y={H - 8} className="lc-xlabel">{p.label}</text>
            ) : null,
          )}
        </svg>

        {/* left ולא insetInlineStart — ה-SVG הוא LTR והדף RTL */}
        {hover !== null && (
          <div className="lc-tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}>
            <strong>{points[hover].label}</strong>
            {series.map((s) => (
              <span key={s.key}>
                <i style={{ background: s.color }} />
                {s.name}: <b>{points[hover][s.key] ?? "—"}</b>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default LineChart;
