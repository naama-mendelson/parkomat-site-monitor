// components/StatTiles/StatTiles.jsx — אריחי סיכום מתחת לגרף: תווית קטנה + מספר ענק
import AnimatedNumber from "../AnimatedNumber/AnimatedNumber";
import "./StatTiles.css";

/** tiles — [{ label, value, color }] */
function StatTiles({ tiles }) {
  return (
    <div className="st">
      {tiles.map((t, i) => (
        <div key={t.label} className="st-tile" style={{ animationDelay: `${i * 80}ms` }}>
          <span className="st-label">{t.label}</span>
          <span className="st-value" style={{ color: t.color }}>
            <AnimatedNumber value={t.value} />
          </span>
          {t.hint && <span className="st-hint">{t.hint}</span>}
        </div>
      ))}
    </div>
  );
}

export default StatTiles;
