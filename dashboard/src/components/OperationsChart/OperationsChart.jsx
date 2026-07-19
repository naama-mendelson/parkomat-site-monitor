// components/OperationsChart/OperationsChart.jsx — גרף פעולות: כניסות · יציאות · תקלות · תחזוקה
// שני מצבים: Standard (עמודות זו לצד זו) ו-Stacked (מוערמות).
// SVG טהור, בלי ספריות.
import { useState } from "react";
import { DIRECTION_COLORS, METRIC_COLORS } from "../../utils/constants";
import "./OperationsChart.css";

// ==========================================================
// שלוש סדרות ספירה — ואחת שהיא לא
// ==========================================================
// כניסות, יציאות ותקלות נמדדות כולן ביחידה אחת: *כמות*. הן חולקות ציר Y.
//
// תחזוקה נמדדת ב**שעות**, ולכן היא לא. להעמיד "5 תקלות" ו-"5 שעות תחזוקה" על
// אותו ציר זה לשקר ויזואלי — העין משווה גבהים, והגבהים אינם ברי-השוואה. לכן
// לתחזוקה יש **ציר ימני משלה**, והיא מצוירת כקו ולא כעמודה, כדי שיהיה מיד ברור
// שהיא מדד אחר ולא עוד עמודה באותה משפחה.
const COUNT_SERIES = [
  { key: "entries", name: "כניסות", color: DIRECTION_COLORS.entry },
  { key: "exits",   name: "יציאות", color: DIRECTION_COLORS.exit },
  { key: "errors",  name: "תקלות",  color: METRIC_COLORS.errors },
];

const MAINT = {
  key: "maintenanceHours",
  name: "תחזוקה",
  color: METRIC_COLORS.maintenanceHours,
  unit: "שע'",
};

// רק כניסות ויציאות נערמות. תקלה **אינה פעולה** — ערימה שלה לתוך העמודה הייתה
// שוברת את המשמעות של "גובה העמודה = סך הפעולות", והופכת את הגרף למטעה.
const STACKABLE = ["entries", "exits"];

const W = 760;
const H = 260;
const PAD = { top: 14, right: 8, bottom: 26, left: 34 };
const MAINT_AXIS_W = 34;   // מקום לציר הימני — רק כשתחזוקה מוצגת

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

  // מה מוצג. תחזוקה כבויה כברירת מחדל — היא "אופציה להוספה", ורוב הזמן היא 0
  // ורק מוסיפה רעש. השאר דולקים.
  const [shown, setShown] = useState({
    entries: true,
    exits: true,
    errors: true,
    maintenanceHours: false,
  });

  if (!points || points.length === 0) {
    return <p className="oc-empty">אין נתונים בטווח הנבחר</p>;
  }

  const toggle = (key) => setShown((s) => ({ ...s, [key]: !s[key] }));

  const isStacked = mode === "stacked";
  const n = points.length;

  const activeCounts = COUNT_SERIES.filter((s) => shown[s.key]);
  const showMaint = shown[MAINT.key];

  // הסדרות שנערמות בפועל = הנערמות שגם מסומנות
  const stackKeys = STACKABLE.filter((k) => shown[k]);
  // תקלות אף פעם לא בערימה — הן עמודה נפרדת לצד הערימה
  const soloKeys = activeCounts.filter((s) => !STACKABLE.includes(s.key)).map((s) => s.key);

  const padRight = PAD.right + (showMaint ? MAINT_AXIS_W : 0);
  const IN_W = W - PAD.left - padRight;
  const IN_H = H - PAD.top - PAD.bottom;

  // ===== ציר שמאל: ספירות =====
  const stackedTotals = points.map((p) => stackKeys.reduce((sum, k) => sum + (p[k] || 0), 0));
  const soloValues = points.flatMap((p) => soloKeys.map((k) => p[k] || 0));

  const rawMax = Math.max(
    0,
    ...(isStacked ? stackedTotals : points.flatMap((p) => activeCounts.map((s) => p[s.key] || 0))),
    ...(isStacked ? soloValues : []),
  );
  const max = niceMax(rawMax);

  // ===== ציר ימין: שעות תחזוקה =====
  // סולם נפרד לגמרי. גם כשכל הערכים 0 שומרים על מקסימום מינימלי, אחרת הקו
  // נצמד לתחתית ונראה כאילו חסר.
  const maintRaw = Math.max(0, ...points.map((p) => p[MAINT.key] || 0));
  const maintMax = niceMax(maintRaw > 0 ? maintRaw : 1);

  const slot = IN_W / n;
  const cx = (i) => PAD.left + (i + 0.5) * slot;
  const y = (v) => PAD.top + IN_H - (v / max) * IN_H;
  const h = (v) => (IN_H * v) / max;
  const yMaint = (v) => PAD.top + IN_H - (v / maintMax) * IN_H;

  // כמה "עמודות" יש בקבוצה: במוערם — ערימה אחת + כל סדרת סולו.
  // ברגיל — עמודה לכל סדרה פעילה.
  const columns = isStacked
    ? (stackKeys.length ? 1 : 0) + soloKeys.length
    : activeCounts.length;

  const groupW = slot * (columns <= 1 ? 0.42 : 0.62);
  const barW = columns > 0 ? groupW / columns : 0;

  // ==========================================================
  // פורמט הסימונים בציר הימני — לא טריוויאלי
  // ==========================================================
  // שעות תחזוקה הן לרוב שברים קטנים (0.06 שע'). עיגול קבוע לספרה אחת הפך את
  // חמשת הסימונים ל-"0 / 0 / 0.1 / 0.1 / 0.1" — ציר שמראה את אותו מספר שלוש
  // פעמים ולא אומר כלום. מספר הספרות נגזר מהסקאלה עצמה.
  const maintDigits = maintMax >= 10 ? 0 : maintMax >= 1 ? 1 : 2;
  const fmtMaint = (v) => v.toFixed(maintDigits);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: PAD.top + IN_H - f * IN_H,
    value: Math.round(max * f),
    maint: fmtMaint(maintMax * f),
  }));

  const step = Math.max(1, Math.ceil(n / 8));

  // קו התחזוקה
  const maintPath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${cx(i)} ${yMaint(p[MAINT.key] || 0)}`)
    .join(" ");

  const legend = [...COUNT_SERIES, MAINT];

  return (
    <div className="oc">
      {/* המקרא הוא גם המתגים — לחיצה מוסיפה/מסירה סדרה */}
      <div className="oc-legend">
        {legend.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`oc-chip ${shown[s.key] ? "is-on" : ""}`}
            onClick={() => toggle(s.key)}
            aria-pressed={shown[s.key]}
          >
            <i style={{ background: s.color }} />
            {s.name}
            {s.key === MAINT.key && <em>שע'</em>}
          </button>
        ))}
        {isStacked && stackKeys.length > 1 && (
          <span className="oc-note">גובה הערימה = סך הפעולות</span>
        )}
      </div>

      <div className="oc-plot">
        <svg viewBox={`0 0 ${W} ${H}`} className="oc-svg" role="img" aria-label="גרף פעולות">
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.left} y1={t.y} x2={W - padRight} y2={t.y} className="oc-grid" />
              <text x={PAD.left - 8} y={t.y + 3} className="oc-ytick">{t.value}</text>

              {/* ציר ימני — שעות. צבוע בענבר כדי שיהיה חד-משמעי למי הוא שייך. */}
              {showMaint && (
                <text
                  x={W - padRight + 8}
                  y={t.y + 3}
                  className="oc-ytick oc-ytick--maint"
                  fill={MAINT.color}
                >
                  {t.maint}
                </text>
              )}
            </g>
          ))}

          {points.map((p, i) => {
            const gx = cx(i) - groupW / 2;
            let col = 0;

            return (
              <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                {/* ===== הערימה (כניסות/יציאות) ===== */}
                {isStacked && stackKeys.length > 0 && (() => {
                  const x = gx + col * barW;
                  col++;
                  let acc = 0;
                  return stackKeys.map((key, si) => {
                    const v = p[key] || 0;
                    const yTop = y(acc + v);
                    acc += v;
                    const s = COUNT_SERIES.find((x2) => x2.key === key);
                    return (
                      <rect
                        key={key}
                        className="oc-bar"
                        x={x}
                        y={yTop}
                        width={Math.max(2, barW - 2)}
                        height={h(v)}
                        fill={s.color}
                        rx="3"
                        style={{ animationDelay: `${i * 30 + si * 60}ms` }}
                      />
                    );
                  });
                })()}

                {/* ===== עמודות בודדות =====
                    במוערם: רק התקלות (הן לא נערמות).
                    ברגיל: כל סדרה פעילה, זו לצד זו. */}
                {(isStacked ? soloKeys : activeCounts.map((s) => s.key)).map((key, si) => {
                  const s = COUNT_SERIES.find((x2) => x2.key === key);
                  const v = p[key] || 0;
                  const x = gx + (isStacked ? col + si : si) * barW;
                  return (
                    <rect
                      key={key}
                      className="oc-bar"
                      x={x}
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

          {/* ===== תחזוקה — קו על הציר הימני =====
              מקווקו ובצבע אחר: כדי שאף אחד לא יקרא אותו כעוד עמודה על ציר השמאל. */}
          {showMaint && (
            <>
              <path d={maintPath} className="oc-maint-line" stroke={MAINT.color} fill="none" />
              {points.map((p, i) => (
                <circle
                  key={`m${i}`}
                  cx={cx(i)}
                  cy={yMaint(p[MAINT.key] || 0)}
                  r="3"
                  fill={MAINT.color}
                  className="oc-maint-dot"
                />
              ))}
            </>
          )}

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

            {activeCounts.map((s) => (
              <span key={s.key}>
                <i style={{ background: s.color }} />
                {s.name}: <b>{points[hover][s.key] ?? 0}</b>
              </span>
            ))}

            {showMaint && (
              <span>
                <i style={{ background: MAINT.color }} />
                {MAINT.name}: <b>{points[hover][MAINT.key] ?? 0} {MAINT.unit}</b>
              </span>
            )}

            {/* הסה"כ תמיד ב-tooltip — גם כשהוא לא עמודה נפרדת */}
            <span className="oc-tip-total">
              סה"כ פעולות: <b>{points[hover].operations ?? 0}</b>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default OperationsChart;
