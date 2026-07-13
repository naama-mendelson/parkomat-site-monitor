// components/DetailPanel/DetailPanel.jsx — פאנל פירוט אתר (נפתח בלחיצה על כרטיס)
import { useState } from "react";
import { STATUS_LABELS, STATUS_COLORS } from "../../utils/constants";
import { formatDate } from "../../utils/helpers";
import { startMaintenance, cancelMaintenance } from "../../services/api";
import { useSiteAnalytics } from "../../hooks/useSiteAnalytics";
import PeriodTabs from "../PeriodTabs/PeriodTabs";
import MetricCard from "../MetricCard/MetricCard";
import TrendIndicator from "../TrendIndicator/TrendIndicator";
import UptimeBar from "../UptimeBar/UptimeBar";
import Sparkline from "../Sparkline/Sparkline";
import InsightsModal from "../InsightsModal/InsightsModal";
import "./DetailPanel.css";

// דירוג לוגי לשבירת שוויון בין אירועים באותו חותם זמן (זהה לשרת).
// המציאות: operating מתחיל → הפעולה מתחילה → הפעולה מסתיימת → האתר חוזר ל-ready.
function phaseRank(item) {
  if (item.kind === "status") return item.status === "operating" ? 0 : 3;
  if (item.kind === "operation") return item.start_end === "start" ? 1 : 2;
  return 4;   // תחזוקה
}

// "תקלה אחת לכל X פעולות" — הופך אחוז כשל למשפט שמנהל מבין מיד.
function failureHint(operations, errors) {
  if (operations === 0) return "לא בוצעו פעולות בתקופה";
  if (errors === 0) return "לא נרשמו תקלות בתקופה";
  return `תקלה אחת לכל ${Math.round(operations / errors).toLocaleString()} פעולות`;
}

// משך זמן בין שני זמנים (started_at → ended_at) בעברית
function formatDuration(startIso, endIso) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} שניות`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} דקות`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} שעות`;
  return `${Math.floor(hr / 24)} ימים`;
}

// שלב חלון תחזוקה — לפי cancel וזמן התפוגה
function maintenancePhase(m) {
  if (m.cancelled_at) return "בוטלה";
  return new Date(m.expires_at).getTime() > Date.now() ? "פעילה" : "הסתיימה";
}

function DetailPanel({ detail, maintenance, onClose, onRefresh, dataVersion = 0 }) {
  const [maintName, setMaintName] = useState("");
  const [maintHours, setMaintHours] = useState(2);
  const [actionLoading, setActionLoading] = useState(false);
  const [period, setPeriod] = useState("week");   // ברירת מחדל: שבוע
  const [insightsOpen, setInsightsOpen] = useState(false);

  // ה-hook נקרא לפני ה-return המוקדם (כלל ה-hooks), ומטפל בעצמו ב-code ריק.
  // dataVersion עולה בכל הודעה חדשה מהאתר → שליפה מחדש, כך שהמספרים
  // תמיד משקפים את ה-DB ולא נשארים על ערך ישן.
  const { data: analytics, loading: analyticsLoading } = useSiteAnalytics(
    detail?.site?.code,
    period,
    dataVersion,
  );

  if (!detail) return null;

  const { site, statusHistory, maintenanceHistory, operations } = detail;
  const status = site.status;
  const colors = STATUS_COLORS[status] || STATUS_COLORS.no_comm;
  const label = STATUS_LABELS[status] || status;
  const isInMaintenance = maintenance?.inMaintenance;

  // לוג פעילות מאוחד — מהחדש לישן: שינויי מצב + תחזוקה ידנית + פעולות (כניסה/יציאה).
  // כל מקור עם שדה זמן שונה (started_at / occurred_at) → מנרמלים ל-`when` למיון אחיד.
  const logItems = [
    ...(statusHistory || []).map((r) => ({ kind: "status", when: r.started_at, ...r })),
    ...(maintenanceHistory || []).map((m) => ({ kind: "maintenance", when: m.started_at, ...m })),
    ...(operations || []).map((o) => ({ kind: "operation", when: o.occurred_at, ...o })),
  ].sort((a, b) => {
    if (a.when !== b.when) return a.when < b.when ? 1 : -1;   // מהחדש לישן
    // באותו חותם זמן: המאוחר *לוגית* קודם. הסוכן משדר state לפני operation,
    // אבל במציאות ה-ready קורה רק אחרי שהפעולה הסתיימה — ולכן ready חייב
    // להופיע מעל הודעת ה-end, ולא בתוך הפעולה. ראה phaseRank בשרת.
    return phaseRank(b) - phaseRank(a);
  });

  // הפעלת תחזוקה
  async function handleStartMaintenance() {
    if (!maintName.trim()) return alert("יש להזין שם");
    if (!(maintHours > 0)) return alert("משך התחזוקה חייב להיות מספר חיובי (שעות)");
    setActionLoading(true);
    try {
      await startMaintenance(site.code, maintName.trim(), maintHours);
      setMaintName("");
      onRefresh();
    } catch (err) {
      alert("שגיאה: " + err.message);
    } finally {
      setActionLoading(false);
    }
  }

  // ביטול תחזוקה
  async function handleCancelMaintenance() {
    setActionLoading(true);
    try {
      await cancelMaintenance(site.code);
      onRefresh();
    } catch (err) {
      alert("שגיאה: " + err.message);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        {/* כותרת */}
        <div className="detail-header">
          <div>
            <h2>{site.site_name}</h2>
            <span className="detail-code">קוד: {site.code}</span>
          </div>
          <button className="detail-close" onClick={onClose}>✕</button>
        </div>

        {/* מצב */}
        <div
          className="detail-status"
          style={{ background: colors.bg, color: colors.text }}
        >
          <span className="status-dot" style={{ background: colors.dot }} />
          {label}
        </div>

        {/* מידע */}
        <div className="detail-info">
          <div className="info-row">
            <span className="info-label">שינוי מצב ב:</span>
            <span>
              {(site.statusSince || site.last_seen)
                ? new Date(site.statusSince || site.last_seen).toLocaleTimeString("he-IL")
                : "—"}
            </span>
          </div>
        </div>

        {/* ===== נתוני תקופה: שבוע / חודש / שנה ===== */}
        <div className="detail-analytics">
          <PeriodTabs
            period={period}
            onChange={setPeriod}
            rangeLabel={analytics?.label}
          />

          {analyticsLoading && !analytics ? (
            <div className="analytics-skeleton">טוען נתונים…</div>
          ) : !analytics ? (
            <p className="analytics-empty">לא ניתן לטעון את נתוני התקופה</p>
          ) : (
            <div className={`analytics-body ${analyticsLoading ? "is-refreshing" : ""}`}>
              {/* 1. מדדי ליבה */}
              <div className="analytics-metrics">
                <MetricCard
                  label="פעולות חניה"
                  value={analytics.stats.operations.toLocaleString()}
                  hint="פעולות שהושלמו בתקופה"
                  trend={
                    <TrendIndicator
                      changePercent={analytics.trend.operations.changePercent}
                      higherIsBetter
                      comparisonLabel={analytics.comparisonLabel}
                    />
                  }
                />
                <MetricCard
                  label="תקלות"
                  value={analytics.stats.errors.toLocaleString()}
                  hint="פעמים שהאתר נכנס למצב מושבת"
                  trend={
                    <TrendIndicator
                      changePercent={analytics.trend.errors.changePercent}
                      higherIsBetter={false}
                      comparisonLabel={analytics.comparisonLabel}
                    />
                  }
                />
                <MetricCard
                  wide
                  label="אחוז כשל"
                  value={`${analytics.stats.failureRate}%`}
                  hint={failureHint(analytics.stats.operations, analytics.stats.errors)}
                  trend={
                    <TrendIndicator
                      changePercent={analytics.trend.failureRate.changePercent}
                      higherIsBetter={false}
                      comparisonLabel={analytics.comparisonLabel}
                    />
                  }
                />
              </div>

              {/* 2. זמינות */}
              <UptimeBar
                uptime={analytics.uptime}
                trend={
                  <TrendIndicator
                    changePercent={analytics.trend.availability.changePercent}
                    higherIsBetter
                    comparisonLabel={analytics.comparisonLabel}
                  />
                }
              />

              {/* 3. מונה מחזורים */}
              <section className="analytics-section">
                <h3>מונה מחזורים</h3>
                <p className="analytics-sub">
                  מונה המחזורים מגיע מהבקר ומייצג את הבלאי הפיזי של המכונה
                </p>
                <div className="analytics-metrics">
                  <MetricCard
                    wide
                    label="סך הכל מהבקר"
                    value={
                      analytics.cycles.totalFromPLC === null ||
                      analytics.cycles.totalFromPLC === undefined
                        ? "—"
                        : analytics.cycles.totalFromPLC.toLocaleString()
                    }
                    hint="המונה המצטבר של המכונה מאז ייצורה"
                  />
                </div>
              </section>

              {/* 4. גרף מגמה */}
              <section className="analytics-section">
                <h3>מגמת פעילות</h3>
                <p className="analytics-sub">פעולות ותקלות לאורך התקופה</p>
                <Sparkline points={analytics.chart} />
              </section>

              {/* 5. מעבר לסטטיסטיקה המלאה */}
              <button
                type="button"
                className="insights-open-btn"
                onClick={() => setInsightsOpen(true)}
              >
                הצג עוד מידע
                <span className="insights-open-hint">
                  כרטיסים מובילים · שעות עומס · משכי פעולה · השבתות
                </span>
              </button>
            </div>
          )}
        </div>

        {/* תחזוקה */}
        <div className="detail-maintenance">
          <h3>תחזוקה</h3>
          {isInMaintenance ? (
            <div className="maint-active">
              <p>
                תחזוקה פעילה — {maintenance.maintenance.set_by_name}
                <br />
                פג: {formatDate(maintenance.maintenance.expires_at)}
              </p>
              <button
                className="btn btn-danger"
                onClick={handleCancelMaintenance}
                disabled={actionLoading}
              >
                בטל תחזוקה
              </button>
            </div>
          ) : (
            <div className="maint-form">
              <input
                type="text"
                placeholder="שם מפעיל"
                value={maintName}
                onChange={(e) => setMaintName(e.target.value)}
                className="maint-input"
              />
              <div className="maint-duration-field">
                <input
                  type="number"
                  min="0.5"
                  step="0.5"
                  value={maintHours}
                  onChange={(e) => setMaintHours(Number(e.target.value))}
                  className="maint-hours-input"
                  aria-label="משך תחזוקה בשעות"
                />
                <span className="maint-unit">שעות</span>
              </div>
              <button
                className="btn btn-primary"
                onClick={handleStartMaintenance}
                disabled={actionLoading}
              >
                הכנס לתחזוקה
              </button>
            </div>
          )}
        </div>

        {/* לוג פעילות אחרון — שינויי מצב + תחזוקה + פעולות, מהחדש לישן */}
        <div className="detail-statuslog">
          <h3>לוג פעילות אחרון</h3>
          {logItems.length > 0 ? (
            <ul className="status-log">
              {logItems.map((item, i) => {
                // שורת פעולה — כניסה/יציאה, התחלה/סיום, כרטיס, זמן
                if (item.kind === "operation") {
                  const oc = STATUS_COLORS.operating;
                  const dir = { entry: "כניסה", exit: "יציאה" }[item.entry_exit] || item.entry_exit;
                  const phase = { start: "התחלה", end: "סיום" }[item.start_end] || item.start_end;
                  return (
                    <li
                      key={`o-${item.occurred_at}-${i}`}
                      className="log-row"
                      style={{ borderInlineStartColor: oc.dot }}
                    >
                      <span className="log-status">
                        <span className="status-dot" style={{ background: oc.dot }} />
                        <span style={{ color: oc.text }}>{dir}</span>
                      </span>
                      <span className="log-time" title={formatDate(item.occurred_at)}>
                        כרטיס {item.card_number || "—"} · {new Date(item.occurred_at).toLocaleTimeString("he-IL")}
                      </span>
                      <span
                        className="log-duration"
                        style={item.is_anomaly ? { color: "#f87171" } : undefined}
                      >
                        {phase}{item.is_anomaly ? " · אנומליה" : ""}
                      </span>
                    </li>
                  );
                }
                // שורת תחזוקה ידנית — עם מי הפעיל, משך, ומצב החלון
                if (item.kind === "maintenance") {
                  const c = STATUS_COLORS.maintenance;
                  return (
                    <li
                      key={`m-${item.started_at}-${i}`}
                      className="log-row"
                      style={{ borderInlineStartColor: c.dot }}
                    >
                      <span className="log-status">
                        <span className="status-dot" style={{ background: c.dot }} />
                        <span style={{ color: c.text }}>תחזוקה ידנית</span>
                      </span>
                      <span className="log-time" title={formatDate(item.started_at)}>
                        הפעיל {item.set_by_name} · {item.duration_hours} שע' · {new Date(item.started_at).toLocaleTimeString("he-IL")}
                      </span>
                      <span className="log-duration">{maintenancePhase(item)}</span>
                    </li>
                  );
                }
                // שורת שינוי מצב רגילה (כולל תחזוקת PLC)
                const c = STATUS_COLORS[item.status] || STATUS_COLORS.no_comm;
                const lbl = STATUS_LABELS[item.status] || item.status;
                return (
                  <li
                    key={`s-${item.started_at}-${i}`}
                    className="log-row"
                    style={{ borderInlineStartColor: c.dot }}
                  >
                    <span className="log-status">
                      <span className="status-dot" style={{ background: c.dot }} />
                      <span style={{ color: c.text }}>{lbl}</span>
                    </span>
                    <span className="log-time" title={formatDate(item.started_at)}>
                      התחיל {new Date(item.started_at).toLocaleTimeString("he-IL")}
                    </span>
                    <span className="log-duration">
                      {item.ended_at ? `נמשך ${formatDuration(item.started_at, item.ended_at)}` : "נוכחי"}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="ops-empty">אין פעילות</p>
          )}
        </div>
      </div>

      {/* מסך הסטטיסטיקה המלאה — משתף את התקופה הנבחרת ואת הסנכרון החי */}
      {insightsOpen && (
        <InsightsModal
          site={site}
          period={period}
          onPeriodChange={setPeriod}
          version={dataVersion}
          onClose={() => setInsightsOpen(false)}
        />
      )}
    </div>
  );
}

export default DetailPanel;