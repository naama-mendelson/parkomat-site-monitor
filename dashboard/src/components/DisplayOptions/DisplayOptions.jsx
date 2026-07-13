// components/DisplayOptions/DisplayOptions.jsx — אופציות תצוגה.
//
// שוכתב: קודם היה כאן תפריט שלא נסגר (בלי לחיצה בחוץ ובלי Escape), עם
// כותרות שלא אמרו *על מה* כל קטע משפיע, ועם מתג "תצוגה קומפקטית" שלא היה
// מחובר לכלום — אף רכיב לא קרא אותו. עכשיו כל קטע מצהיר במה הוא נוגע,
// לכל מדד יש נקודת צבע כמו בגרף, והחלון נסגר בלחיצה בחוץ.
import { useState, useRef, useEffect } from "react";
import { METRICS, METRIC_COLORS } from "../../utils/constants";
import "./DisplayOptions.css";

const SORTS = [
  { key: "desc", label: "מהגבוה לנמוך" },
  { key: "asc", label: "מהנמוך לגבוה" },
  { key: "alpha", label: "לפי שם" },
];

const TOP_N = [
  { value: 5, label: "5" },
  { value: 10, label: "10" },
  { value: 20, label: "20" },
  { value: 0, label: "הכל" },
];

function DisplayOptions({ options, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // סגירה בלחיצה מחוץ לחלון או ב-Escape — כמו בכל שאר הממשק
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const set = (patch) => onChange({ ...options, ...patch });

  function toggleMetric(key) {
    const has = options.metrics.includes(key);
    // חייב להישאר לפחות מדד אחד — גרף ריק הוא באג, לא בחירה
    if (has && options.metrics.length === 1) return;
    set({
      metrics: has
        ? options.metrics.filter((m) => m !== key)
        : [...options.metrics, key],
    });
  }

  const lastMetric = options.metrics.length === 1;

  return (
    <div className="do" ref={rootRef}>
      <button
        className={`do-trigger ${open ? "is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        ⚙ אופציות תצוגה
        <span className={`do-caret ${open ? "is-open" : ""}`}>▾</span>
      </button>

      {open && (
        <div className="do-panel" role="dialog" aria-label="אופציות תצוגה">
          {/* ===== מה מוצג בגרף המגמה ===== */}
          <section className="do-group">
            <span className="do-title">מדדים בגרף המגמה</span>
            <div className="do-metrics">
              {METRICS.map((m) => {
                const on = options.metrics.includes(m.key);
                const locked = on && lastMetric;
                return (
                  <button
                    key={m.key}
                    className={`do-metric ${on ? "is-on" : ""}`}
                    style={{ "--m": METRIC_COLORS[m.key] }}
                    onClick={() => toggleMetric(m.key)}
                    disabled={locked}
                    aria-pressed={on}
                    title={locked ? "חייב להישאר מדד אחד לפחות" : undefined}
                  >
                    <i className="do-swatch" />
                    {m.name}
                  </button>
                );
              })}
            </div>
            <span className="do-hint">הצבע כאן הוא הצבע שלו בגרף</span>
          </section>

          {/* ===== רשימת האתרים ===== */}
          <section className="do-group">
            <span className="do-title">רשימת האתרים</span>

            <div className="do-field">
              <label className="do-label" htmlFor="do-sort">סדר</label>
              <select
                id="do-sort"
                className="do-select"
                value={options.sort}
                onChange={(e) => set({ sort: e.target.value })}
              >
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>

            <div className="do-field">
              <span className="do-label">כמה אתרים</span>
              <div className="do-row">
                {TOP_N.map((t) => (
                  <button
                    key={t.value}
                    className={`do-pill ${options.topN === t.value ? "is-active" : ""}`}
                    onClick={() => set({ topN: t.value })}
                    aria-pressed={options.topN === t.value}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* ===== עיצוב הגרף ===== */}
          <section className="do-group">
            <span className="do-title">עיצוב הגרף</span>

            <label className="do-switch">
              <input
                type="checkbox"
                checked={options.showGrid}
                onChange={(e) => set({ showGrid: e.target.checked })}
              />
              <span className="do-track"><span className="do-knob" /></span>
              <span className="do-switch-text">
                קווי רשת
                <small>קווי עזר אופקיים לקריאת הערכים</small>
              </span>
            </label>

            <label className="do-switch">
              <input
                type="checkbox"
                checked={options.showValues}
                onChange={(e) => set({ showValues: e.target.checked })}
              />
              <span className="do-track"><span className="do-knob" /></span>
              <span className="do-switch-text">
                מספרים על הגרף
                <small>הערך המדויק ליד כל נקודה</small>
              </span>
            </label>
          </section>

          <span className="do-close-hint">לחצו מחוץ לחלון כדי לסגור</span>
        </div>
      )}
    </div>
  );
}

export default DisplayOptions;
