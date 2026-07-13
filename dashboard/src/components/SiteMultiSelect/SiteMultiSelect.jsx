// components/SiteMultiSelect/SiteMultiSelect.jsx — בחירת אתרים + סינון מצב + סף כשל
import { useState, useMemo } from "react";
import { STATUS_COLORS, STATUS_LABELS, STATUSES } from "../../utils/constants";
import { fuzzyMatch } from "../../utils/helpers";
import "./SiteMultiSelect.css";

/**
 * allSites       — [{ code, name, status }] (מהשרת)
 * selected       — קודי אתרים שנבחרו. ריק = כל האתרים.
 * statuses       — מצבים שנבחרו. ריק = כל המצבים.
 * minFailureRate — סף אחוז הכשל
 */
function SiteMultiSelect({
  allSites, selected, onSelectedChange,
  statuses, onStatusesChange,
  minFailureRate, onMinFailureRateChange,
  filteredCount,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () => (allSites || []).filter((s) => !query || fuzzyMatch(`${s.name} ${s.code}`, query)),
    [allSites, query],
  );

  const total = allSites?.length || 0;

  function toggleSite(code) {
    onSelectedChange(
      selected.includes(code)
        ? selected.filter((c) => c !== code)
        : [...selected, code],
    );
  }

  function toggleStatus(s) {
    onStatusesChange(
      statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s],
    );
  }

  return (
    <div className="sms">
      {/* --- אתרים --- */}
      <div className="sms-block">
        <button className="sms-trigger" onClick={() => setOpen((o) => !o)}>
          אתרים
          <span className="sms-count">
            {selected.length === 0 ? `כל ה-${total}` : `${selected.length}/${total}`}
          </span>
          <span className={`sms-caret ${open ? "is-open" : ""}`}>▾</span>
        </button>

        {open && (
          <div className="sms-panel">
            <input
              className="sms-search"
              type="search"
              placeholder="חיפוש אתר…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="sms-actions">
              <button onClick={() => onSelectedChange(visible.map((s) => s.code))}>
                בחר הכל
              </button>
              <button onClick={() => onSelectedChange([])}>נקה</button>
            </div>

            <ul className="sms-list">
              {visible.length === 0 ? (
                <li className="sms-none">לא נמצאו אתרים</li>
              ) : (
                visible.map((s) => {
                  const c = STATUS_COLORS[s.status] || STATUS_COLORS.no_comm;
                  // ריק = כל האתרים, ולכן הכל מסומן ויזואלית
                  const checked = selected.length === 0 || selected.includes(s.code);
                  return (
                    <li key={s.code}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.includes(s.code)}
                          onChange={() => toggleSite(s.code)}
                        />
                        <i style={{ background: c.dot }} />
                        <span className={`sms-name ${checked ? "" : "is-dim"}`}>{s.name}</span>
                        <span className="sms-code">{s.code}</span>
                      </label>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        )}
      </div>

      {/* --- מצב --- */}
      <div className="sms-block">
        <span className="sms-title">מצב</span>
        <div className="sms-statuses">
          {STATUSES.map((s) => (
            <button
              key={s}
              className={`sms-status ${statuses.includes(s) ? "is-active" : ""}`}
              onClick={() => toggleStatus(s)}
              title={STATUS_LABELS[s]}
            >
              <i style={{ background: STATUS_COLORS[s].dot }} />
              {STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      {/* --- סף כשל --- */}
      <div className="sms-block">
        <span className="sms-title">
          אחוז כשל מעל <strong>{minFailureRate}%</strong>
        </span>
        <input
          className="sms-range"
          type="range"
          min="0" max="50" step="1"
          value={minFailureRate}
          onChange={(e) => onMinFailureRateChange(Number(e.target.value))}
        />
      </div>

      {typeof filteredCount === "number" && (
        <p className="sms-summary">
          מציג <strong>{filteredCount}</strong> מתוך {total} אתרים
        </p>
      )}
    </div>
  );
}

export default SiteMultiSelect;
