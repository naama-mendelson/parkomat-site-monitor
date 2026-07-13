// components/Heatmap/Heatmap.jsx — מפת חום: שורה לאתר, תא לכל יום/חודש
import { useState } from "react";
import "./Heatmap.css";

/**
 * data = { labels: [], rows: [{ siteCode, siteName, values: [] }], max }
 * color — צבע הבסיס; העוצמה נקבעת מהאטימות
 */
function Heatmap({ data, color = "var(--accent)" }) {
  const [hover, setHover] = useState(null);

  if (!data || !data.rows?.length) {
    return <p className="hm-empty">אין נתונים לתקופה זו</p>;
  }

  const { labels, rows, max } = data;

  // עוצמה 0..1. שורש ריבועי כדי שערכים נמוכים לא ייעלמו לגמרי
  // (סקאלה לינארית "מבליעה" יום עם פעולה אחת מול יום עם 50).
  const intensity = (v) => (max > 0 && v > 0 ? Math.sqrt(v / max) : 0);

  return (
    <div className="hm">
      <div
        className="hm-grid"
        style={{ gridTemplateColumns: `minmax(90px, 140px) repeat(${labels.length}, 1fr)` }}
      >
        {/* כותרת עמודות */}
        <span className="hm-corner" />
        {labels.map((l) => (
          <span key={l} className="hm-collabel">{l}</span>
        ))}

        {/* שורות */}
        {rows.map((row, r) => (
          <FragmentRow
            key={row.siteCode}
            row={row}
            r={r}
            color={color}
            intensity={intensity}
            labels={labels}
            hover={hover}
            setHover={setHover}
          />
        ))}
      </div>

      {/* מקרא עוצמה */}
      <div className="hm-scale">
        <span>פחות</span>
        {[0.1, 0.3, 0.55, 0.8, 1].map((f) => (
          <i key={f} style={{ background: color, opacity: 0.12 + f * 0.88 }} />
        ))}
        <span>יותר ({max})</span>
      </div>
    </div>
  );
}

function FragmentRow({ row, r, color, intensity, labels, hover, setHover }) {
  return (
    <>
      <span className="hm-rowlabel" title={row.siteName}>{row.siteName}</span>
      {row.values.map((v, i) => {
        const key = `${r}-${i}`;
        const t = intensity(v);
        return (
          <span
            key={key}
            className={`hm-cell ${hover === key ? "is-hover" : ""}`}
            // stagger: כל תא נכנס מעט אחרי קודמו — יוצר גל אלכסוני
            style={{
              background: color,
              opacity: v > 0 ? 0.12 + t * 0.88 : 0.05,
              animationDelay: `${(r * labels.length + i) * 12}ms`,
            }}
            onMouseEnter={() => setHover(key)}
            onMouseLeave={() => setHover(null)}
          >
            {hover === key && (
              <span className="hm-tip">
                {row.siteName} · {labels[i]}
                <strong>{v} פעולות</strong>
              </span>
            )}
          </span>
        );
      })}
    </>
  );
}

export default Heatmap;
