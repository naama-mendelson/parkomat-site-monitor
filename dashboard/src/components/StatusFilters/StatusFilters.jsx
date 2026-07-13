// components/StatusFilters/StatusFilters.jsx — מוני סטטוס כפילטרים
import { STATUSES, STATUS_LABELS, STATUS_COLORS } from "../../utils/constants";
import "./StatusFilters.css";

function StatusFilters({ sites, activeFilter, onFilterChange }) {
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

  return (
    <div className="status-filters">
      {/* כפתור "הכל" */}
      <button
        className={`filter-btn ${activeFilter === null ? "active" : ""}`}
        onClick={() => onFilterChange(null)}
      >
        <span className="filter-count">{total}</span>
        <span className="filter-label">הכל</span>
      </button>

      {/* כפתור לכל מצב */}
      {STATUSES.map((status) => {
        const colors = STATUS_COLORS[status];
        const isActive = activeFilter === status;

        return (
          <button
            key={status}
            className={`filter-btn ${isActive ? "active" : ""}`}
            style={{
              "--filter-bg": colors.dot,
              "--filter-border": colors.dot,
              "--filter-text": "#ffffff",
            }}
            onClick={() => onFilterChange(isActive ? null : status)}
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