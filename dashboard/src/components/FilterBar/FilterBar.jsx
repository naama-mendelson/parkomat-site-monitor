// components/FilterBar/FilterBar.jsx — סרגל הפילטרים: טווח, אתרים, פילוח, ייצוא
import { useState, useEffect } from "react";
import DateRangePicker from "../DateRangePicker/DateRangePicker";
import SiteMultiSelect from "../SiteMultiSelect/SiteMultiSelect";
import DisplayOptions from "../DisplayOptions/DisplayOptions";
import ExportMenu from "../ExportMenu/ExportMenu";
import { STATUS_LABELS } from "../../utils/constants";
import "./FilterBar.css";

// "פילוח" = איך מקבצים את הנתונים (לא סינון!). "חיתוך" היה שם מבלבל.
const GROUP_BY = [
  { key: "site", label: "אתר" },
  { key: "status", label: "מצב" },
  { key: "time", label: "זמן" },
];

const GRANULARITY = [
  { key: "day", label: "יומי" },
  { key: "week", label: "שבועי" },
  { key: "month", label: "חודשי" },
];

const SAVED_KEY = "parkomat.savedViews";

// localStorage עלול להיות חסום (מצב פרטי / iframe) — לא מפילים את הדף בגללו
function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  } catch {
    return [];
  }
}

function persistSaved(views) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(views));
  } catch {
    /* אין אחסון — התצוגות יחיו רק בזיכרון */
  }
}

function FilterBar({
  filters, onFiltersChange,
  display, onDisplayChange,
  data, loading, onPrint, onReset,
}) {
  const [saved, setSaved] = useState(loadSaved);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => { persistSaved(saved); }, [saved]);

  const set = (patch) => onFiltersChange({ ...filters, ...patch });

  function saveCurrent() {
    const name = prompt("שם לתצוגה השמורה:");
    if (!name?.trim()) return;
    setSaved((s) => [
      ...s.filter((v) => v.name !== name.trim()),
      { name: name.trim(), filters, display },
    ]);
  }

  function applySaved(v) {
    onFiltersChange(v.filters);
    onDisplayChange(v.display);
  }

  // ה"שבבים" של מה שפעיל כרגע — לחיצה על ✕ מסירה את הפילטר
  const chips = [];
  if (filters.sites.length) {
    chips.push({
      key: "sites",
      text: `${filters.sites.length} אתרים נבחרו`,
      clear: () => set({ sites: [] }),
    });
  }
  filters.statuses.forEach((s) =>
    chips.push({
      key: `st-${s}`,
      text: STATUS_LABELS[s] || s,
      clear: () => set({ statuses: filters.statuses.filter((x) => x !== s) }),
    }),
  );
  if (filters.minFailureRate > 0) {
    chips.push({
      key: "mfr",
      text: `כשל מעל ${filters.minFailureRate}%`,
      clear: () => set({ minFailureRate: 0 }),
    });
  }

  return (
    <div className="fb">
      {/* ===== שורה אחת: טווח · פילוח · רזולוציה · סינון · תצוגה · ייצוא ===== */}
      <div className="fb-main">
        <img src="/parkomat-logo.png" alt="" className="fb-logo" aria-hidden="true" />

        <DateRangePicker
          value={filters}
          onChange={(next) =>
            set({
              preset: next.preset,
              period: next.period,
              from: next.from,
              to: next.to,
            })
          }
          summary={data?.label}
          days={data?.daysCount}
        />

        <span className="fb-sep" />

        {/* פילוח = איך מקבצים את הנתונים. זה *לא* סינון. */}
        <label className="fb-field">
          <span>פילוח לפי</span>
          <select value={filters.groupBy} onChange={(e) => set({ groupBy: e.target.value })}>
            {GROUP_BY.map((g) => (
              <option key={g.key} value={g.key}>{g.label}</option>
            ))}
          </select>
        </label>

        <label className="fb-field">
          <span>רזולוציה</span>
          <select value={filters.granularity} onChange={(e) => set({ granularity: e.target.value })}>
            {GRANULARITY.map((g) => (
              <option key={g.key} value={g.key}>{g.label}</option>
            ))}
          </select>
        </label>

        <button
          className={`fb-filter-btn ${expanded ? "is-open" : ""}`}
          onClick={() => setExpanded((e) => !e)}
        >
          סינון אתרים {expanded ? "▴" : "▾"}
        </button>

        <div className="fb-right">
          <DisplayOptions options={display} onChange={onDisplayChange} />
          <ExportMenu data={data} onPrint={onPrint} />
        </div>
      </div>

      {/* ===== סינון אתרים (מתקפל) ===== */}
      {expanded && (
        <div className="fb-sites">
          <SiteMultiSelect
            allSites={data?.allSites || []}
            selected={filters.sites}
            onSelectedChange={(sites) => set({ sites })}
            statuses={filters.statuses}
            onStatusesChange={(statuses) => set({ statuses })}
            minFailureRate={filters.minFailureRate}
            onMinFailureRateChange={(minFailureRate) => set({ minFailureRate })}
            filteredCount={data?.filteredSitesCount}
          />
        </div>
      )}

      {/* ===== שורת מצב ===== */}
      <div className="fb-status">
        <span className="fb-summary">
          {loading ? (
            <span className="fb-loading">מעדכן…</span>
          ) : data ? (
            <>
              מציג <strong>{data.filteredSitesCount}</strong> מתוך {data.totalSitesInSystem} אתרים
              {" · "}<strong>{data.label}</strong>
            </>
          ) : null}
        </span>

        <div className="fb-chips">
          {chips.map((c) => (
            <span key={c.key} className="fb-chip">
              {c.text}
              <button onClick={c.clear} aria-label="הסר">✕</button>
            </span>
          ))}

          {saved.map((v) => (
            <span key={v.name} className="fb-chip fb-chip--saved">
              <button className="fb-chip-apply" onClick={() => applySaved(v)}>
                ★ {v.name}
              </button>
              <button
                onClick={() => setSaved((s) => s.filter((x) => x.name !== v.name))}
                aria-label="מחק תצוגה"
              >
                ✕
              </button>
            </span>
          ))}

          <button className="fb-save" onClick={saveCurrent}>שמור תצוגה</button>
          {(chips.length > 0 || filters.preset !== "month") && (
            <button className="fb-reset" onClick={onReset}>אפס פילטרים</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default FilterBar;
