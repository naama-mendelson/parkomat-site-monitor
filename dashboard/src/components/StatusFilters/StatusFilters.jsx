// components/StatusFilters/StatusFilters.jsx — מוני סטטוס כפילטרים.
// בחירה *מרובה*: אפשר לסמן "מוכן" + "בפעולה" + "מושבת" יחד, ולראות רק אותם.
// רשימה ריקה = הכל (ולכן "הכל" הוא פשוט ניקוי הבחירה).
import { STATUSES, STATUS_LABELS, STATUS_COLORS } from "../../utils/constants";
import "./StatusFilters.css";

function StatusFilters({ sites, activeFilters = [], onFilterChange }) {
  // ספירת אתרים לפי מצב
  const counts = {};
  for (const s of STATUSES) {
    counts[s] = 0;
  }
  for (const site of sites) {
    if (counts[site.status] !== undefined) {
      counts[site.status]++;
    }
  }
  const total = sites.length;
  const showingAll = activeFilters.length === 0;

  // לחיצה על מצב מוסיפה/מסירה אותו מהבחירה — לא מחליפה אותה
  const toggle = (status) => {
    onFilterChange(
      activeFilters.includes(status)
        ? activeFilters.filter((s) => s !== status)
        : [...activeFilters, status],
    );
  };

  return (
    <div className="status-filters" role="group" aria-label="סינון לפי מצב (אפשר לבחור כמה)">
      {/* "הכל" = בלי סינון */}
      <button
        className={`filter-btn ${showingAll ? "active" : ""}`}
        onClick={() => onFilterChange([])}
        aria-pressed={showingAll}
      >
        <span className="filter-count">{total}</span>
        <span className="filter-label">הכל</span>
      </button>

      {/* כפתור לכל מצב — ניתן לסמן כמה יחד */}
      {STATUSES.map((status) => {
        const colors = STATUS_COLORS[status];
        const isActive = activeFilters.includes(status);

        return (
          <button
            key={status}
            className={`filter-btn ${isActive ? "active" : ""}`}
            style={{
              "--filter-bg": colors.dot,
              "--filter-border": colors.dot,
              "--filter-text": "#ffffff",
            }}
            onClick={() => toggle(status)}
            aria-pressed={isActive}
          >
            <span className="filter-count">{counts[status]}</span>
            <span className="filter-label">{STATUS_LABELS[status]}</span>
          </button>
        );
      })}
    </div>
  );
}

export default StatusFilters;
