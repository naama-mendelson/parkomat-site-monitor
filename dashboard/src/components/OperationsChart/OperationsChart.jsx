// components/OperationsChart/OperationsChart.jsx — גרף פעולות: כניסות · יציאות · סה"כ
// שני מצבים: Standard (עמודות זו לצד זו) ו-Stacked (מוערמות).
// SVG טהור, בלי ספריות.
import { useState } from "react";
import { DIRECTION_COLORS } from "../../utils/constants";
import "./OperationsChart.css";

// שתי סדרות בלבד — כחול וליים של הלוגו.
// עמודת "סה\"כ" הוסרה: היא תמיד כניסות+יציאות, כלומר כפילות. הסכום מופיע
// בגדול באריח שמתחת לגרף וב-tooltip. פחות צבעים, יותר בהירות.
const SERIES = [
  { key: "entries", name: "כניסות", color: DIRECTION_COLORS.entry },
  { key: "exits", name: "יציאות", color: DIRECTION_COLORS.exit },
];

const W = 760;
const H = 260;
const PAD = { top: 14, right: 8, bottom: 26, left: 34 };
const IN_W = W - PAD.left - PAD.right;
const IN_H = H - PAD.top - PAD.bottom;

// מספרים עגולים לציר Y (0, 40, 80, 120, 160…) — כמו בגרף מקצועי
function niceMax(value) {
  if (value <= 0) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const m = step * pow;
    if (m >= value) return m;
  }
  return 10 * pow;
}

function OperationsChart({ points, mode = "standard" }) {
  const [hover, setHover] = useState(null);

  if (!points || points.length === 0) {
    return <p className="oc-empty">אין נתונים בטווח הנבחר</p>;
  }

  const isStacked = mode === "stacked";
  const n = points.length;

  const stackKeys = ["entries", "exits"];
  const visibleSeries = SERIES;

  const rawMax = isStacked
    ? Math.max(...points.map((p) => (p.entries || 0) + (p.exits || 0)))
    : Math.max(...points.flatMap((p) => SERIES.map((s) => p[s.key] || 0)));

  const max = niceMax(rawMax);

  const slot = IN_W / n;
  const cx = (i) => PAD.left + (i + 0.5) * slot;
  const y = (v) => PAD.top + IN_H - (v / max) * IN_H;
  const h = (v) => (IN_H * v) / max;

  // מוערם: עמודה אחת. רגיל: שתי עמודות זו לצד זו.
  const groupW = slot * (isStacked ? 0.42 : 0.56);
  const barW = isStacked ? groupW : groupW / SERIES.length;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: PAD.top + IN_H - f * IN_H,
    value: Math.round(max * f),
  }));

  // עד 8 תוויות על ציר X
  const step = Math.max(1, Math.ceil(n / 8));

  return (
    <div className="oc">
      <div className="oc-legend">
        {visibleSeries.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        {isStacked && <span className="oc-note">גובה העמודה = סך הפעולות</span>}
      </div>

      <div className="oc-plot">
        <svg viewBox={`0 0 ${W} ${H}`} className="oc-svg" role="img" aria-label="גרף פעולות">
          {/* קווי רשת אופקיים בלבד — נקי, כמו בגרף מקצועי */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y} className="oc-grid" />
              <text x={PAD.left - 8} y={t.y + 3} className="oc-ytick">{t.value}</text>
            </g>
          ))}

          {points.map((p, i) => {
            const gx = cx(i) - groupW / 2;

            if (isStacked) {
              // עמודה אחת: כניסות למטה, יציאות מעליהן. הגובה הכולל = סך הפעולות.
              let acc = 0;
              return (
                <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  {stackKeys.map((key, si) => {
                    const v = p[key] || 0;
                    const yTop = y(acc + v);
                    acc += v;
                    const s = SERIES.find((x) => x.key === key);
                    return (
                      <rect
                        key={key}
                        className="oc-bar"
                        x={gx}
                        y={yTop}
                        width={barW}
                        height={h(v)}
                        fill={s.color}
                        rx="3"
                        style={{ animationDelay: `${i * 30 + si * 60}ms` }}
                      />
                    );
                  })}
                </g>
              );
            }

            // Standard — כניסות ויציאות זו לצד זו
            return (
              <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                {SERIES.map((s, si) => {
                  const v = p[s.key] || 0;
                  return (
                    <rect
                      key={s.key}
                      className="oc-bar"
                      x={gx + si * barW}
                      y={y(v)}
                      width={Math.max(2, barW - 2)}
                      height={h(v)}
                      fill={s.color}
                      rx="3"
                      style={{ animationDelay: `${i * 30 + si * 55}ms` }}
                    />
                  );
                })}
              </g>
            );
          })}

          {/* תוויות ציר X */}
          {points.map((p, i) =>
            i % step === 0 || i === n - 1 ? (
              <text key={`l${i}`} x={cx(i)} y={H - 7} className="oc-xtick">{p.label}</text>
            ) : null,
          )}
        </svg>

        {/* left ולא insetInlineStart — ה-SVG הוא LTR והדף RTL */}
        {hover !== null && (
          <div className="oc-tip" style={{ left: `${(cx(hover) / W) * 100}%` }}>
            <strong>{points[hover].label}</strong>
            {visibleSeries.map((s) => (
              <span key={s.key}>
                <i style={{ background: s.color }} />
                {s.name}: <b>{points[hover][s.key] ?? 0}</b>
              </span>
            ))}
            {/* הסה"כ תמיד ב-tooltip — גם כשהוא לא עמודה נפרדת */}
            <span className="oc-tip-total">
              סה"כ: <b>{points[hover].operations ?? 0}</b>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default OperationsChart;
