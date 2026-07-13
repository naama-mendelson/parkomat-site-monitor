// components/Leaderboard/Leaderboard.jsx — טבלת מובילים (מצטיינים / דורשי תשומת לב)
import "./Leaderboard.css";

const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * items    — [{ code, name, value, secondary }]
 * unit     — "%" למשל
 * color    — צבע הפס
 * tone     — "good" | "warn" (משפיע על הצבעוניות)
 * emptyText
 */
function Leaderboard({ title, subtitle, items, unit = "", color, tone = "good", emptyText }) {
  if (!items || items.length === 0) {
    return (
      <section className={`lb lb--${tone}`}>
        <header className="lb-head">
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </header>
        <p className="lb-empty">{emptyText || "אין נתונים להצגה"}</p>
      </section>
    );
  }

  // הפס היחסי מנורמל לערך הגבוה ברשימה, כדי שההשוואה תהיה ויזואלית
  const max = Math.max(...items.map((i) => i.value), 1);

  return (
    <section className={`lb lb--${tone}`}>
      <header className="lb-head">
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </header>

      <ol className="lb-list">
        {items.map((item, i) => (
          <li
            key={item.code}
            className="lb-item"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <span className="lb-rank">{MEDALS[i] || i + 1}</span>

            <div className="lb-main">
              <div className="lb-row">
                <span className="lb-name" title={item.name}>{item.name}</span>
                <strong className="lb-value" style={{ color }}>
                  {item.value.toLocaleString("he-IL", { maximumFractionDigits: 2 })}{unit}
                </strong>
              </div>

              <div className="lb-bar">
                <span
                  className="lb-fill"
                  style={{ width: `${(item.value / max) * 100}%`, background: color }}
                />
              </div>

              {item.secondary && <span className="lb-secondary">{item.secondary}</span>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default Leaderboard;
