// components/ActivityLog/ActivityLog.jsx — לוג פעילות מלא: ציר זמן מאוחד
// (פעולות · שינויי מצב · תחזוקה), מקובץ לפי ימים, עם סינון.
import { useMemo, useState } from "react";
import { STATUS_COLORS, STATUS_LABELS } from "../../utils/constants";
import "./ActivityLog.css";

const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// מערך ריק קבוע — `|| []` היה יוצר הפניה חדשה בכל render ומבטל את ה-useMemo.
const NO_ENTRIES = [];

const ENTRY_COLOR = STATUS_COLORS.operating.dot;
const EXIT_COLOR = STATUS_COLORS.maintenance.dot;

const FILTERS = [
  { key: "all", label: "הכל" },
  { key: "operation", label: "פעולות" },
  { key: "status", label: "שינויי מצב" },
  { key: "maintenance", label: "תחזוקה" },
];

// משך בשניות → טקסט קצר וקריא
function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `${seconds} שנ'`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} דק'`;
  const h = Math.floor(m / 60);
  const restM = m % 60;
  if (h < 24) return restM ? `${h} שע' ${restM} דק'` : `${h} שע'`;
  return `${Math.floor(h / 24)} ימים`;
}

// כותרת יום: "היום" / "אתמול" / "12.7.2026 · ראשון"
function dayHeading(dateKey) {
  const d = new Date(`${dateKey}T12:00:00`);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (same(d, today)) return "היום";
  if (same(d, yesterday)) return "אתמול";
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} · ${WEEKDAYS[d.getDay()]}`;
}

const dayKeyOf = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// כל שורה מתורגמת לתצוגה אחידה: צבע, כותרת, פירוט, תג-צד.
function describe(e) {
  if (e.kind === "operation") {
    const isEntry = e.entryExit === "entry";
    const color = isEntry ? ENTRY_COLOR : EXIT_COLOR;
    const dir = isEntry ? "כניסת רכב" : "יציאת רכב";
    const phase = e.startEnd === "start" ? "התחילה" : "הושלמה";

    const details = [];
    details.push(e.card ? `כרטיס ${e.card}` : "ללא כרטיס");
    if (e.isAnomaly) details.push("אנומליה");

    return {
      color,
      icon: isEntry ? "↓" : "↑",
      title: `${dir} ${phase}`,
      details: details.join(" · "),
      badge: e.startEnd === "start" ? "התחלה" : "סיום",
      badgeTone: e.isAnomaly ? "danger" : "normal",
    };
  }

  if (e.kind === "maintenance") {
    const c = STATUS_COLORS.maintenance;
    const cancelled = Boolean(e.cancelledAt);
    const details = [`הפעיל: ${e.setBy}`, `משך מתוכנן: ${e.durationHours} שע'`];
    if (e.reason) details.push(`סיבה: ${e.reason}`);

    return {
      color: c.dot,
      icon: "⚙",
      title: cancelled ? "חלון תחזוקה (בוטל)" : "חלון תחזוקה הופעל",
      details: details.join(" · "),
      badge: "תחזוקה ידנית",
      badgeTone: "normal",
    };
  }

  // שינוי מצב
  const c = STATUS_COLORS[e.status] || STATUS_COLORS.no_comm;
  const label = STATUS_LABELS[e.status] || e.status;
  const dur = fmtDuration(e.durationSeconds);

  return {
    color: c.dot,
    icon: "●",
    title: `המצב השתנה ל: ${label}`,
    details: e.endedAt ? `נמשך ${dur}` : "המצב הנוכחי",
    badge: e.endedAt ? dur : "נוכחי",
    badgeTone: e.status === "error" ? "danger" : "normal",
  };
}

function ActivityLog({ log }) {
  const [filter, setFilter] = useState("all");

  const entries = log?.entries || NO_ENTRIES;

  const visible = useMemo(
    () => (filter === "all" ? entries : entries.filter((e) => e.kind === filter)),
    [entries, filter],
  );

  // קיבוץ לימים, תוך שמירה על הסדר (מהחדש לישן)
  const days = useMemo(() => {
    const map = new Map();
    for (const e of visible) {
      const k = dayKeyOf(e.at);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
    }
    return [...map.entries()];
  }, [visible]);

  const counts = log?.counts || { operations: 0, status: 0, maintenance: 0 };
  const countFor = (key) => ({
    all: counts.operations + counts.status + counts.maintenance,
    operation: counts.operations,
    status: counts.status,
    maintenance: counts.maintenance,
  }[key]);

  return (
    <div className="alog">
      {/* סינון */}
      <div className="alog-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`alog-chip ${filter === f.key ? "is-active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            <span className="alog-chip-count">{countFor(f.key)}</span>
          </button>
        ))}
      </div>

      {log?.truncated && (
        <p className="alog-truncated">
          מוצגים {entries.length} האירועים האחרונים בתקופה
        </p>
      )}

      {days.length === 0 ? (
        <p className="alog-empty">אין אירועים להצגה בתקופה זו</p>
      ) : (
        <div className="alog-timeline">
          {days.map(([dayKey, items]) => (
            <section key={dayKey} className="alog-day">
              <header className="alog-day-head">
                <span className="alog-day-title">{dayHeading(dayKey)}</span>
                <span className="alog-day-count">{items.length} אירועים</span>
              </header>

              <ul className="alog-items">
                {items.map((e, i) => {
                  const d = describe(e);
                  return (
                    <li key={`${e.kind}-${e.at}-${i}`} className="alog-item">
                      {/* ציר הזמן: נקודה + קו */}
                      <span className="alog-marker" style={{ background: d.color }}>
                        <span className="alog-icon">{d.icon}</span>
                      </span>

                      <div className="alog-content">
                        <div className="alog-row-top">
                          <span className="alog-title" style={{ color: d.color }}>
                            {d.title}
                          </span>
                          <time className="alog-time">
                            {new Date(e.at).toLocaleTimeString("he-IL", {
                              hour: "2-digit", minute: "2-digit", second: "2-digit",
                            })}
                          </time>
                        </div>
                        <span className="alog-details">{d.details}</span>
                      </div>

                      {d.badge && (
                        <span className={`alog-badge alog-badge--${d.badgeTone}`}>
                          {d.badge}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default ActivityLog;
