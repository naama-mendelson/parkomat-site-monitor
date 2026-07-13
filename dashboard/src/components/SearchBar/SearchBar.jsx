// components/SearchBar/SearchBar.jsx — חיפוש fuzzy לפי שם/קוד אתר
import "./SearchBar.css";

function SearchBar({ value, onChange }) {
  return (
    <div className="search-bar">
      <span className="search-icon">🔍</span>
      <input
        type="text"
        className="search-input"
        placeholder="חיפוש אתר..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className="search-clear" onClick={() => onChange("")}>
          ✕
        </button>
      )}
    </div>
  );
}

export default SearchBar;