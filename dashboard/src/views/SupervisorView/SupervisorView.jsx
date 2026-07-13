// views/SupervisorView/SupervisorView.jsx — מנהל בקרה: ניהול תפעולי מלא.
// טבלת אתרים ממוינת/מסוננת, תקלות אחרונות, ותחזוקות פעילות.
import { useState, useMemo } from "react";
import { STATUS_COLORS, STATUS_LABELS, STATUSES, METRIC_COLORS } from "../../utils/constants";
import { cancelMaintenance } from "../../services/api";
import { useSupervisorStats } from "../../hooks/useSupervisorStats";
import PeriodTabs from "../../components/PeriodTabs/PeriodTabs";
import AnimatedNumber from "../../components/AnimatedNumber/AnimatedNumber";
import { fuzzyMatch, formatDate } from "../../utils/helpers";
import "./SupervisorView.css";

// עמודות הטבלה. numeric קובע יישור ומיון מספרי.
const COLUMNS = [
  { key: "code", label: "קוד" },
  { key: "name", label: "שם האתר" },
  { key: "status", label: "מצב" },
  { key: "operations", label: "פעולות", numeric: true },
  { key: "errors", label: "תקלות", numeric: true },
  { key: "failureRate", label: "אחוז כשל", numeric: true, suffix: "%" },
  { key: "availability", label: "זמינות", numeric: true, suffix: "%" },
  { key: "maintenanceHours", label: "תחזוקה", numeric: true, suffix: " ש'" },
  { key: "cycleTotal", label: "מונה", numeric: true },
  { key: "operationsSinceLastError", label: "פעולות מהתקלה", numeric: true },
];

function SupervisorView({ onSiteClick, dataVersion }) {
  const [period, setPeriod] = useState("week");
  const [sortKey, setSortKey] = useState("errors");
  const [sortDir, setSortDir] = useState("desc");
  const [statusFilters, setStatusFilters] = useState([]);   // בחירה מרובה — ריק = הכל
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(null);

  const { data, loading, error, refresh } = useSupervisorStats(period, dataVersion);

  const rows = useMemo(() => {
    if (!data) return [];

    const filtered = data.sites.filter((s) => {
      if (statusFilters.length > 0 && !statusFilters.includes(s.status)) return false;
      if (query && !fuzzyMatch(`${s.name} ${s.code}`, query)) return false;
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av ?? "").localeCompare(String(bv ?? ""), "he") * dir;
    });
  }, [data, statusFilters, query, sortKey, sortDir]);

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  async function handleCancelMaintenance(code) {
    setBusy(code);
    try {
      await cancelMaintenance(code);
      refresh();
    } catch (err) {
      alert("שגיאה: " + err.message);
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <div className="sv-skeleton">טוען נתונים תפעוליים…</div>;
  if (error && !data) return <div className="app-error">שגיאה: {error}</div>;
  if (!data) return null;

  const { summary } = data;

  // הכרטיסים האלה עמדו זה לצד זה ואמרו דברים שונים: "בתחזוקה" ו"ללא תקשורת"
  // תיארו את *המצב עכשיו*, ואילו "אתרים עם תקלות" ספר אתרים שהייתה בהם תקלה
  // *כלשהי בתקופה*. אתר שנפל והתאושש הופיע שם — ונראה כאילו הוא מושבת עכשיו.
  // עכשיו ארבעת הראשונים הם מצב נוכחי, והמצטבר עומד בנפרד ומצהיר על עצמו.
  const periodWord = { week: "בשבוע האחרון", month: "בחודש האחרון", year: "בשנה האחרונה" }[period];

  const cards = [
    { label: "סה\"כ אתרים", value: summary.totalSites, color: "var(--accent)", hint: "רשומים במערכת" },
    { label: "מושבתים כעת", value: summary.sitesInError ?? 0, color: STATUS_COLORS.error.dot, hint: "במצב תקלה ברגע זה" },
    { label: "בתחזוקה", value: summary.sitesInMaintenance, color: STATUS_COLORS.maintenance.dot, hint: "כעת" },
    { label: "ללא תקשורת", value: summary.sitesOffline, color: STATUS_COLORS.no_comm.dot, hint: "כעת" },
    // לא אדום (זה לא "מושבת עכשיו") ולא ענבר (זה לא תחזוקה) — גוון הכשל מהפלטה
    { label: "אתרים שהייתה בהם תקלה", value: summary.sitesWithErrors, color: METRIC_COLORS.failureRate, hint: periodWord },
  ];

  return (
    <div className="sv">
      {/* ===== בורר תקופה ===== */}
      <div className="sv-period">
        <PeriodTabs period={period} onChange={setPeriod} rangeLabel={data.label} />
      </div>

      {/* ===== סרגל סיכום ===== */}
      <div className="sv-summary">
        {cards.map((c, i) => (
          <div key={c.label} className="sv-card" style={{ "--c": c.color, animationDelay: `${i * 70}ms` }}>
            <span className="sv-card-value"><AnimatedNumber value={c.value} /></span>
            <span className="sv-card-label">{c.label}</span>
            {c.hint && <span className="sv-card-hint">{c.hint}</span>}
          </div>
        ))}
      </div>

      {/* ===== בקרות הטבלה ===== */}
      <div className="sv-controls">
        <input
          className="sv-search"
          type="search"
          placeholder="חיפוש לפי שם או קוד…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="sv-chips" role="group" aria-label="סינון לפי מצב (אפשר לבחור כמה)">
          <button
            className={`sv-chip ${statusFilters.length === 0 ? "is-active" : ""}`}
            onClick={() => setStatusFilters([])}
            aria-pressed={statusFilters.length === 0}
          >
            הכל
          </button>
          {STATUSES.map((s) => (
            <button
              key={s}
              className={`sv-chip ${statusFilters.includes(s) ? "is-active" : ""}`}
              style={{ "--c": STATUS_COLORS[s].dot }}
              aria-pressed={statusFilters.includes(s)}
              onClick={() => setStatusFilters((cur) => (
                cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]
              ))}
            >
              <i style={{ background: STATUS_COLORS[s].dot }} />
              {STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      {/* ===== טבלת האתרים ===== */}
      <section className="sv-panel">
        <div className="sv-tablewrap">
          <table className="sv-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className={`${c.numeric ? "num" : ""} ${sortKey === c.key ? "is-sorted" : ""}`}
                    onClick={() => toggleSort(c.key)}
                    title="לחצו למיון"
                  >
                    {c.label}
                    <span className="sv-sort">
                      {sortKey === c.key ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="sv-none">לא נמצאו אתרים</td>
                </tr>
              ) : (
                rows.map((s) => {
                  const c = STATUS_COLORS[s.status] || STATUS_COLORS.no_comm;
                  return (
                    <tr
                      key={s.code}
                      onClick={() => onSiteClick(s.code)}
                      style={{ "--row": c.dot }}
                    >
                      <td className="mono">{s.code}</td>
                      <td className="name">{s.name}</td>
                      <td>
                        <span className="sv-status" style={{ background: c.bg, color: c.text }}>
                          <i style={{ background: c.dot }} />
                          {STATUS_LABELS[s.status] || s.status}
                        </span>
                      </td>
                      <td className="num">{s.operations.toLocaleString()}</td>
                      <td className="num">
                        {s.errors > 0
                          ? <strong style={{ color: STATUS_COLORS.error.text }}>{s.errors}</strong>
                          : "0"}
                      </td>
                      <td className="num">{s.failureRate}%</td>
                      <td className="num">
                        {s.hasUptimeData ? `${s.availability}%` : "—"}
                      </td>
                      <td className="num">{s.maintenanceHours || 0}</td>
                      <td className="num">{s.cycleTotal.toLocaleString()}</td>
                      <td className="num">{s.operationsSinceLastError.toLocaleString()}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ===== תקלות אחרונות + תחזוקות פעילות ===== */}
      <div className="sv-bottom">
        <section className="sv-panel">
          <header className="sv-panel-head">
            <h3>תקלות אחרונות</h3>
            <p>10 התקלות האחרונות בכל המערכת</p>
          </header>

          {data.recentErrors.length === 0 ? (
            <p className="sv-good">✓ לא נרשמו תקלות</p>
          ) : (
            <ul className="sv-errors">
              {data.recentErrors.map((e, i) => (
                <li key={i} style={{ animationDelay: `${i * 50}ms` }}>
                  <span className="sv-err-dot" />
                  <div className="sv-err-main">
                    <span className="sv-err-site">{e.siteName}</span>
                    <span className="sv-err-time">{formatDate(e.startedAt)}</span>
                  </div>
                  <span className={`sv-err-dur ${e.ongoing ? "is-ongoing" : ""}`}>
                    {e.ongoing ? "פעילה כעת" : `${e.durationMinutes} דק'`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="sv-panel">
          <header className="sv-panel-head">
            <h3>תחזוקות פעילות</h3>
            <p>חלונות תחזוקה שהופעלו ידנית ועדיין בתוקף</p>
          </header>

          {data.activeMaintenances.length === 0 ? (
            <p className="sv-none-inline">אין תחזוקות פעילות</p>
          ) : (
            <ul className="sv-maint">
              {data.activeMaintenances.map((m) => (
                <li key={m.siteCode}>
                  <div className="sv-maint-main">
                    <span className="sv-maint-site">{m.siteName}</span>
                    <span className="sv-maint-meta">
                      הפעיל: {m.setBy} · פג ב-{formatDate(m.expiresAt)}
                    </span>
                    {m.reason && <span className="sv-maint-reason">{m.reason}</span>}
                  </div>
                  <button
                    className="sv-maint-cancel"
                    disabled={busy === m.siteCode}
                    onClick={() => handleCancelMaintenance(m.siteCode)}
                  >
                    {busy === m.siteCode ? "מבטל…" : "בטל"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default SupervisorView;
