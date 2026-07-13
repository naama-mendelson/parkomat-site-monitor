// components/Header/Header.jsx — Header עליון: לוגו מותג, פילטרים, חיפוש, dark/light
import StatusFilters from "../StatusFilters/StatusFilters";
import SearchBar from "../SearchBar/SearchBar";
import "./Header.css";

function Header({
  sites,
  activeFilter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  darkMode,
  onToggleDarkMode,
  onAddSite,
}) {
  return (
    <header className="app-header">
      <div className="header-top">
        {/* לוגו מותג Parkomat — טקסט מעוצב על רקע כחול (#1B3A8C), ללא אימוג'י */}
        <div className="header-logo">
          <span className="logo-mark">Parkomat</span>
          <span className="logo-subtitle">SiteMonitor</span>
        </div>

        {/* פעולות: חיפוש + הוספת אתר + מצב כהה/בהיר */}
        <div className="header-actions">
          <SearchBar value={searchQuery} onChange={onSearchChange} />
          <button
            className="add-site-btn"
            onClick={onAddSite}
            title="הוסף אתר חדש"
          >
            <span className="add-site-plus">+</span>
            הוסף אתר
          </button>
          <button
            className="theme-toggle"
            onClick={onToggleDarkMode}
            title={darkMode ? "מצב בהיר" : "מצב כהה"}
            aria-label={darkMode ? "מעבר למצב בהיר" : "מעבר למצב כהה"}
          >
            {darkMode ? "☀" : "☾"}
          </button>
        </div>
      </div>

      {/* מוני סטטוס כפילטרים */}
      <StatusFilters
        sites={sites}
        activeFilter={activeFilter}
        onFilterChange={onFilterChange}
      />
    </header>
  );
}

export default Header;
