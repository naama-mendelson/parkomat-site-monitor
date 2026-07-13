// components/UptimeBar/UptimeBar.jsx — זמינות האתר: אחוז ראשי, שורה צבעונית ופירוט שעות
import { STATUS_COLORS } from "../../utils/constants";
import "./UptimeBar.css";

// עיצוב שעות בעברית קריאה: "12.5 שעות" / "45 דקות"
function formatHours(hours) {
  if (hours <= 0) return "0";
  if (hours < 1) return `${Math.round(hours * 60)} דקות`;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} שעות`;
}

function UptimeBar({ uptime, trend }) {
  const {
    readyHours, operatingHours, errorHours,
    maintenanceHours, noCommHours, totalHours, availabilityPercent,
  } = uptime;

  // אין מקטעי מצב בטווח — אין מה לחשב, ואסור להציג 0% שנראה כמו כשל.
  if (!totalHours || totalHours <= 0) {
    return (
      <section className="uptime">
        <header className="uptime-head">
          <h3>זמינות האתר</h3>
          <p className="uptime-sub">כמה מהזמן האתר היה זמין לקבל רכבים</p>
        </header>
        <p className="uptime-empty">אין נתוני מצב לתקופה זו</p>
      </section>
    );
  }

  const availableHours = readyHours + operatingHours;
  const pct = (h) => (h / totalHours) * 100;

  // המקטעים בשורה הצבעונית — לפי חמשת המצבים, בצבעי המערכת.
  const segments = [
    { key: "ready", hours: readyHours, color: STATUS_COLORS.ready.dot },
    { key: "operating", hours: operatingHours, color: STATUS_COLORS.operating.dot },
    { key: "error", hours: errorHours, color: STATUS_COLORS.error.dot },
    { key: "maintenance", hours: maintenanceHours, color: STATUS_COLORS.maintenance.dot },
    { key: "no_comm", hours: noCommHours, color: STATUS_COLORS.no_comm.dot },
  ].filter((s) => s.hours > 0);

  // הפירוט — מקובץ לארבע קטגוריות שמנהל מבין מיד.
  const rows = [
    {
      key: "available",
      label: "זמין לשירות",
      explain: "האתר היה זמין לקבל רכבים",
      hours: availableHours,
      color: STATUS_COLORS.ready.dot,
      detail: `מוכן ${formatHours(readyHours)} · בפעולה ${formatHours(operatingHours)}`,
    },
    {
      key: "error",
      label: "מושבת",
      explain: "האתר לא יכול היה לפעול עקב תקלה",
      hours: errorHours,
      color: STATUS_COLORS.error.dot,
    },
    {
      key: "maintenance",
      label: "בתחזוקה",
      explain: "עבודות תחזוקה מתוכננות",
      hours: maintenanceHours,
      color: STATUS_COLORS.maintenance.dot,
    },
    {
      key: "no_comm",
      label: "ללא תקשורת",
      explain: "לא התקבל מידע מהאתר",
      hours: noCommHours,
      color: STATUS_COLORS.no_comm.dot,
    },
  ];

  return (
    <section className="uptime">
      <header className="uptime-head">
        <h3>זמינות האתר</h3>
        <p className="uptime-sub">כמה מהזמן האתר היה זמין לקבל רכבים</p>
      </header>

      {/* המספר הראשי */}
      <div className="uptime-hero">
        <strong className="uptime-percent">{availabilityPercent}%</strong>
        <span className="uptime-hero-text">
          האתר היה זמין לשירות {availabilityPercent}% מהזמן
        </span>
        {trend && <div className="uptime-hero-trend">{trend}</div>}
      </div>

      {/* השורה הצבעונית */}
      <div className="uptime-bar" role="img" aria-label={`זמינות ${availabilityPercent}%`}>
        {segments.map((s) => (
          <span
            key={s.key}
            className="uptime-seg"
            style={{ width: `${pct(s.hours)}%`, background: s.color }}
          />
        ))}
      </div>

      {/* הפירוט */}
      <ul className="uptime-rows">
        {rows.map((r) => (
          <li key={r.key} className="uptime-row">
            <span className="uptime-dot" style={{ background: r.color }} />
            <div className="uptime-row-text">
              <span className="uptime-row-label">{r.label}</span>
              <span className="uptime-row-explain">{r.explain}</span>
              {r.detail && r.hours > 0 && (
                <span className="uptime-row-detail">{r.detail}</span>
              )}
            </div>
            <div className="uptime-row-nums">
              <strong>{Math.round(pct(r.hours) * 10) / 10}%</strong>
              <span>{formatHours(r.hours)}</span>
            </div>
          </li>
        ))}
      </ul>

      <p className="uptime-total">
        סך הזמן שנמדד בתקופה: {formatHours(totalHours)}
      </p>
    </section>
  );
}

export default UptimeBar;
