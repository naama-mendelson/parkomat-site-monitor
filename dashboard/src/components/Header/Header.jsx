// components/Header/Header.jsx — Header עליון: לוגו, בורר תפקיד, חיפוש, dark/light
import StatusFilters from "../StatusFilters/StatusFilters";
import SearchBar from "../SearchBar/SearchBar";
import RoleSwitcher from "../RoleSwitcher/RoleSwitcher";
import "./Header.css";

function Header({
  sites,
  role,
  onRoleChange,
  activeFilters,
  onFilterChange,
  searchQuery,
  onSearchChange,
  darkMode,
  onToggleDarkMode,
  onAdmin,
}) {
  // החיפוש והפילטרים הם כלי עבודה של הבקר. למנהל הבקרה יש חיפוש/סינון
  // משלו בתוך הטבלה, ולמנהל הכללי אין בהם צורך — אז הם לא מוצגים שם.
  const isOperator = role === "operator";

  // ניהול האתרים (הוספה/עריכה/מחיקה) פתוח רק למנהל בקרה ומנהל כללי.
  // הבקר מנטר בלבד. השרת אוכף את זה גם הוא — הסתרה ב-UI אינה אבטחה.
  const canManage = role === "supervisor" || role === "executive";

  return (
    <header className="app-header">
      <div className="header-top">
        {/* לוגו המותג — מקור האמת לצבעי המערכת (ראה theme.css) */}
        <div className="header-logo">
          <img src="/parkomat-logo.png" alt="Parkomat" className="logo-img" />
          <div className="logo-text">
            <span className="logo-mark">Parkomat</span>
            <span className="logo-subtitle">SiteMonitor</span>
          </div>
        </div>

        <RoleSwitcher role={role} onChange={onRoleChange} />

        <div className="header-actions">
          {isOperator && <SearchBar value={searchQuery} onChange={onSearchChange} />}

          {canManage && (
            <button className="add-site-btn" onClick={onAdmin} title="ניהול אתרים">
              <span className="add-site-plus">⚙</span>
              ניהול אתרים
            </button>
          )}

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

      {/* מוני סטטוס כפילטרים — רק בתצוגת הבקר */}
      {isOperator && (
        <StatusFilters
          sites={sites}
          activeFilters={activeFilters}
          onFilterChange={onFilterChange}
        />
      )}
    </header>
  );
}

export default Header;
