// components/UptimeBar/UptimeBar.jsx — זמינות האתר: אחוז ראשי, שורה צבעונית ופירוט שעות
import { UPTIME_COLORS } from "../../utils/constants";
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

  // המקטעים בשורה הצבעונית — בצבעי המצב המערכתיים (מוכן ירוק, בפעולה כחול),
  // אותם צבעים בדיוק כמו בתגית המצב ובדונאט. מה שמבהיר שהכחול הוא חלק
  // מהזמינות אינו הגוון אלא שורות-המשנה במקרא (ראה rows למטה).
  const segments = [
    {
      key: "ready", hours: readyHours, color: UPTIME_COLORS.availableReady,
      title: `מוכן — ${formatHours(readyHours)} (חלק מהזמינות)`,
    },
    {
      key: "operating", hours: operatingHours, color: UPTIME_COLORS.availableOperating,
      title: `בפעולה — ${formatHours(operatingHours)} (חלק מהזמינות)`,
    },
    {
      key: "error", hours: errorHours, color: UPTIME_COLORS.error,
      title: `מושבת — ${formatHours(errorHours)}`,
    },
    {
      key: "maintenance", hours: maintenanceHours, color: UPTIME_COLORS.maintenance,
      title: `בתחזוקה — ${formatHours(maintenanceHours)}`,
    },
    {
      key: "no_comm", hours: noCommHours, color: UPTIME_COLORS.no_comm,
      title: `ללא תקשורת — ${formatHours(noCommHours)}`,
    },
  ].filter((s) => s.hours > 0);

  // ==========================================================
  // הכלל של המקרא: לכל מקטע בפס יש שורה משלו. בלי יוצאי דופן.
  // ==========================================================
  // 'בפעולה' הוא כחול ומהווה חלק מהזמינות — שילוב שנראה סותר, ובאמת בלבל.
  // נוסו שני פתרונות: קודם להשאיר את הכחול בלי שורה במקרא (ואז הוא נקרא
  // כמשהו שאינו זמינות, למרות שהוא רובה), ואחר כך לצבוע אותו בירוק כהה
  // (ואז השאלה הפכה ל"מה הירוק הכהה הזה?"). שניהם אותו כשל: מקטע בפס בלי
  // שורה משלו במקרא.
  //
  // מה שעובד: 'זמין לשירות' הוא כותרת עם הסיכום, ומתחתיה **שתי שורות-משנה**
  // — 'מוכן' ו'בפעולה' — כל אחת בצבע המדויק של המקטע שלה. אפשר להצביע על
  // כל צבע בפס, לרדת למקרא, ולמצוא אותו בשם. ברגע שיש הסבר, הצבע חופשי
  // להיות הצבע המערכתי הנכון.
  const rows = [
    {
      key: "available",
      label: "זמין לשירות",
      explain: "האתר היה זמין לקבל רכבים",
      hours: availableHours,
      color: UPTIME_COLORS.availableReady,
      // שורות-המשנה הן ההסבר לשני המקטעים הירוקים בפס.
      children: [
        { key: "ready", label: "מוכן", hours: readyHours, color: UPTIME_COLORS.availableReady },
        { key: "operating", label: "בפעולה", hours: operatingHours, color: UPTIME_COLORS.availableOperating },
      ],
    },
    {
      key: "error",
      label: "מושבת",
      explain: "האתר לא יכול היה לפעול עקב תקלה",
      hours: errorHours,
      color: UPTIME_COLORS.error,
    },
    {
      key: "maintenance",
      label: "בתחזוקה",
      explain: "עבודות תחזוקה מתוכננות",
      hours: maintenanceHours,
      color: UPTIME_COLORS.maintenance,
    },
    {
      key: "no_comm",
      label: "ללא תקשורת",
      explain: "לא התקבל מידע מהאתר",
      hours: noCommHours,
      color: UPTIME_COLORS.no_comm,
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
            title={s.title}
          />
        ))}
      </div>

      {/* הפירוט */}
      <ul className="uptime-rows">
        {rows.map((r) => (
          <li key={r.key} className="uptime-row-group">
            <div className="uptime-row">
              <span className="uptime-dot" style={{ background: r.color }} />
              <div className="uptime-row-text">
                <span className="uptime-row-label">{r.label}</span>
                <span className="uptime-row-explain">{r.explain}</span>
              </div>
              <div className="uptime-row-nums">
                <strong>{Math.round(pct(r.hours) * 10) / 10}%</strong>
                <span>{formatHours(r.hours)}</span>
              </div>
            </div>

            {/* שורות-משנה: אחת לכל מקטע בפס, בצבע המדויק שלו. מוצגות רק
                כשיש בהן ממש — קטגוריה על אפס לא צריכה פירוט. */}
            {r.children && r.hours > 0 && (
              <ul className="uptime-subrows">
                {r.children.map((c) => (
                  <li key={c.key} className="uptime-subrow">
                    <span className="uptime-dot uptime-dot-sm" style={{ background: c.color }} />
                    <span className="uptime-subrow-label">{c.label}</span>
                    <div className="uptime-row-nums">
                      <strong>{Math.round(pct(c.hours) * 10) / 10}%</strong>
                      <span>{formatHours(c.hours)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
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
