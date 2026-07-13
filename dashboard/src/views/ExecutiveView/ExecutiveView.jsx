// views/ExecutiveView/ExecutiveView.jsx — מנהל כללי: רשת bento יוקרתית.
// לכל חלונית גודל ותוכן משלה. הצבעוניות אחידה: כחול המותג להדגשה,
// וצבעי מצב סמנטיים בלבד היכן שיש להם משמעות.
import { useState, useMemo } from "react";
import {
  STATUS_COLORS, STATUS_LABELS, STATUSES, DIRECTION_COLORS, METRICS, METRIC_COLORS,
} from "../../utils/constants";
import { useExecutiveStats } from "../../hooks/useExecutiveStats";
import FilterBar from "../../components/FilterBar/FilterBar";
import ChartTypeSwitcher from "../../components/ChartTypeSwitcher/ChartTypeSwitcher";
import ReportView from "../../components/ReportView/ReportView";
import Panel from "../../components/Panel/Panel";
import OperationsChart from "../../components/OperationsChart/OperationsChart";
import StatTiles from "../../components/StatTiles/StatTiles";
import KpiCard from "../../components/KpiCard/KpiCard";
import ProgressRing from "../../components/ProgressRing/ProgressRing";
import LineChart from "../../components/LineChart/LineChart";
import DonutChart from "../../components/DonutChart/DonutChart";
import BarChart from "../../components/BarChart/BarChart";
import Heatmap from "../../components/Heatmap/Heatmap";
import Leaderboard from "../../components/Leaderboard/Leaderboard";
import Logo from "../../components/Logo/Logo";
import "./ExecutiveView.css";

// מפת צבעי המדדים משותפת (utils/constants) ולא מוגדרת כאן — כך אותו מדד
// נראה זהה במנהל הכללי, בבקרה ובפאנל הפירוט.
const ERR_COLOR = METRIC_COLORS.errors;
const OK_COLOR = METRIC_COLORS.availability;
const MNT_COLOR = METRIC_COLORS.maintenance;
const BRAND = METRIC_COLORS.operations;  // כחול המותג — צבע ההדגשה היחיד
const TOTAL_COLOR = BRAND;               // סה"כ פעולות = מדד הפעולות, אותו כחול

const DEFAULT_FILTERS = {
  preset: "month", period: "month", from: "", to: "",
  sites: [], statuses: [], minFailureRate: 0,
  groupBy: "site", granularity: "day",
};

const DEFAULT_DISPLAY = {
  chartType: "line",
  metrics: ["operations", "errors"],
  showGrid: true, showValues: false,
  sort: "desc", topN: 10,
};

function failureSentence(operations, errors) {
  if (operations === 0) return "לא בוצעו פעולות בטווח";
  if (errors === 0) return "לא נרשמה אף תקלה";
  return `תקלה אחת לכל ${Math.round(operations / errors).toLocaleString()} פעולות`;
}

function ExecutiveView({ dataVersion }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [display, setDisplay] = useState(DEFAULT_DISPLAY);
  const [reportOpen, setReportOpen] = useState(false);
  const [opsMode, setOpsMode] = useState("standard");
  const [expanded, setExpanded] = useState(null);        // איזו חלונית פרושה

  const query = useMemo(() => {
    const q = {
      sites: filters.sites,
      statuses: filters.statuses,
      minFailureRate: filters.minFailureRate,
      groupBy: filters.groupBy,
      granularity: filters.granularity,
    };
    if (filters.from && filters.to) {
      q.from = filters.from;
      q.to = filters.to;
    } else {
      q.period = filters.period || "month";
    }
    return q;
  }, [filters]);

  const { data, loading, error } = useExecutiveStats(query, dataVersion);

  const series = useMemo(
    () => display.metrics.map((key) => ({
      key,
      name: METRICS.find((m) => m.key === key)?.name || key,
      color: METRIC_COLORS[key] || BRAND,
    })),
    [display.metrics],
  );

  const groups = useMemo(() => {
    if (!data?.groups) return [];
    const primary = display.metrics[0] || "operations";
    const sorted = [...data.groups].sort((a, b) => {
      if (display.sort === "alpha") return String(a.label).localeCompare(String(b.label), "he");
      const d = (a[primary] || 0) - (b[primary] || 0);
      return display.sort === "asc" ? d : -d;
    });
    return display.topN > 0 ? sorted.slice(0, display.topN) : sorted;
  }, [data, display.sort, display.topN, display.metrics]);

  function resetFilters() {
    setFilters(DEFAULT_FILTERS);
    setDisplay(DEFAULT_DISPLAY);
  }

  // ===== מצבי קצה =====
  if (error && !data) {
    return <div className="ex"><div className="app-error">שגיאה: {error}</div></div>;
  }

  if (loading && !data) {
    return (
      <div className="ex-skeleton">
        <div className="ex-skel-brand">
          <Logo size={38} variant="pulse" />
          <span>טוען נתוני מערכת…</span>
        </div>
        <div className="ex-skel-bar" />
        <div className="ex-skel-row">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="ex-skel-card" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
        <div className="ex-skel-chart" />
      </div>
    );
  }

  if (!data) return null;

  const { kpis, trend, sitesByStatus, comparisonLabel } = data;
  const t = (key, higherIsBetter) => ({
    changePercent: trend[key].changePercent, higherIsBetter, comparisonLabel,
  });

  const statusSlices = STATUSES
    .filter((s) => sitesByStatus[s] > 0)
    .map((s) => ({
      label: STATUS_LABELS[s], value: sitesByStatus[s], color: STATUS_COLORS[s].dot,
    }));

  const isEmpty = data.filteredSitesCount === 0;
  const primaryMetric = display.metrics[0] || "operations";

  // ==========================================================
  // הגדרת החלוניות במקום אחד — כך הרשת והמסך המלא מציגים
  // בדיוק את אותו תוכן, בלי לשכפל אותו.
  // ==========================================================
  const PANELS = [
    {
      id: "ops",
      title: "סטטיסטיקת פעולות",
      subtitle: data.label,
      span: 8, tall: true,
      actions: (
        <div className="ops-toggle" role="group" aria-label="תצוגת הגרף">
          <button className={opsMode === "standard" ? "is-active" : ""}
            onClick={() => setOpsMode("standard")}>רגיל</button>
          <button className={opsMode === "stacked" ? "is-active" : ""}
            onClick={() => setOpsMode("stacked")}>מוערם</button>
        </div>
      ),
      render: () => (
        <>
          <OperationsChart points={data.chart} mode={opsMode} />
          <StatTiles
            tiles={[
              { label: "כניסות", value: kpis.totalEntries ?? 0, color: DIRECTION_COLORS.entry, hint: "רכבים שנכנסו" },
              { label: "יציאות", value: kpis.totalExits ?? 0, color: DIRECTION_COLORS.exit, hint: "רכבים שיצאו" },
              { label: "סה\"כ פעולות", value: kpis.totalOperations, color: TOTAL_COLOR, hint: "כניסות + יציאות" },
            ]}
          />
        </>
      ),
    },
    {
      id: "availability",
      title: "זמינות המערכת",
      subtitle: "כמה מהזמן האתרים היו זמינים לקבל רכבים",
      span: 4, tall: true,
      render: () => (
        <div className="ex-avail">
          <ProgressRing percent={kpis.avgAvailability} size={138} stroke={12}
            color={OK_COLOR} label="זמינות ממוצעת" />
          <div className="ex-avail-stats">
            <div>
              <span className="ex-avail-v" style={{ color: MNT_COLOR }}>
                {kpis.totalMaintenanceHours}
              </span>
              <span className="ex-avail-l">שעות תחזוקה</span>
              <span className="ex-avail-h">מתוכנן — לא כשל</span>
            </div>
            <div>
              <span className="ex-avail-v" style={{ color: ERR_COLOR }}>
                {kpis.totalDowntimeHours}
              </span>
              <span className="ex-avail-l">שעות השבתה</span>
              <span className="ex-avail-h">האתר לא יכול היה לפעול</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "trend",
      title: "מגמה לאורך זמן",
      subtitle: `רזולוציה ${{ day: "יומית", week: "שבועית", month: "חודשית" }[data.granularity]} · ${data.chart.length} נקודות`,
      span: 8,
      actions: (
        <ChartTypeSwitcher type={display.chartType}
          onChange={(chartType) => setDisplay((d) => ({ ...d, chartType }))} />
      ),
      render: () => (
        <LineChart points={data.chart} series={series} type={display.chartType}
          showGrid={display.showGrid} showValues={display.showValues} />
      ),
    },
    {
      id: "status",
      title: "התפלגות מצבי האתרים",
      subtitle: "איך מתחלקים האתרים כרגע",
      span: 4,
      render: () => <DonutChart slices={statusSlices} centerNote="אתרים" />,
    },
    {
      id: "top",
      title: "🏆 האתרים המצטיינים",
      subtitle: "הזמינות הגבוהה ביותר",
      span: 4,
      render: () => (
        <Leaderboard
          title="" subtitle=""
          items={data.topPerformers.map((p) => ({
            code: p.code, name: p.name, value: p.availability,
            secondary: `${p.operations.toLocaleString()} פעולות`,
          }))}
          unit="%" color={OK_COLOR} tone="good"
          emptyText="אין עדיין נתוני זמינות"
        />
      ),
    },
    {
      id: "worst",
      title: "⚠️ דורשים תשומת לב",
      subtitle: "אחוז הכשל הגבוה ביותר",
      span: 4,
      render: () => (
        <Leaderboard
          title="" subtitle=""
          items={data.worstPerformers.map((p) => ({
            code: p.code, name: p.name, value: p.failureRate,
            secondary: `${p.errors} תקלות`,
          }))}
          unit="%" color={ERR_COLOR} tone="warn"
          emptyText="✓ לא נרשמו תקלות באף אתר"
        />
      ),
    },
    {
      id: "breakdown",
      title: `פילוח ${{ site: "לפי אתר", status: "לפי מצב", time: "לפי זמן" }[data.groupBy]}`,
      subtitle: display.topN > 0 && data.groups.length > display.topN
        ? `מוצגים ${display.topN} מתוך ${data.groups.length}`
        : `${data.groups.length} קבוצות`,
      span: 4,
      render: (isFull) => (
        <>
          <BarChart
            bars={groups.map((g) => ({
              label: data.groupBy === "status" ? (STATUS_LABELS[g.key] || g.label) : g.label,
              value: g[primaryMetric] || 0,
            }))}
            color={METRIC_COLORS[primaryMetric] || BRAND}
            unit={METRICS.find((m) => m.key === primaryMetric)?.name || ""}
          />

          {/* הטבלה המלאה נחשפת רק כשהחלונית פרושה — ברשת אין לה מקום */}
          {isFull && (
            <table className="ex-table">
              <thead>
                <tr>
                  <th>{{ site: "אתר", status: "מצב", time: "תקופה" }[data.groupBy]}</th>
                  <th>אתרים</th><th>פעולות</th><th>תקלות</th>
                  <th>אחוז כשל</th><th>זמינות</th><th>תחזוקה</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key}>
                    <td className="name">
                      {data.groupBy === "status" ? (STATUS_LABELS[g.key] || g.label) : g.label}
                    </td>
                    <td>{g.sites}</td>
                    <td>{g.operations.toLocaleString()}</td>
                    <td>{g.errors}</td>
                    <td>{g.failureRate}%</td>
                    <td>{g.availability}%</td>
                    <td>{g.maintenanceHours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ),
    },
    {
      id: "heatmap",
      title: "מפת פעילות",
      subtitle: "ככל שכהה יותר — עמוס יותר",
      span: 12,
      render: () => <Heatmap data={data.heatmap} color={BRAND} />,
    },
  ];

  const expandedPanel = PANELS.find((p) => p.id === expanded);

  return (
    <div className="ex">
      <header className="ex-head">
        <div>
          <h1>תמונת מצב מערכתית</h1>
          <p>לחצו על ⤢ בכל חלונית כדי לפרוש אותה על כל המסך</p>
        </div>
      </header>

      <FilterBar
        filters={filters} onFiltersChange={setFilters}
        display={display} onDisplayChange={setDisplay}
        data={data} loading={loading}
        onPrint={() => setReportOpen(true)} onReset={resetFilters}
      />

      {isEmpty ? (
        <div className="ex-empty">
          <Logo size={46} variant="ghost" />
          <strong>אין נתונים בטווח הנבחר</strong>
          <p>נסה להרחיב את טווח התאריכים או לשחרר את סינון האתרים.</p>
          <button onClick={resetFilters}>אפס פילטרים</button>
        </div>
      ) : (
        <div className={`ex-content ${loading ? "is-refreshing" : ""}`}>
          {/* ===== רצועת ה-KPI ===== */}
          <section className="ex-kpis">
            <KpiCard label="סה&quot;כ פעולות" value={kpis.totalOperations}
              hint="רכבים שטופלו בטווח" accent={BRAND} trend={t("operations", true)} delay={0} />
            <KpiCard label="זמינות ממוצעת" value={kpis.avgAvailability} decimals={1} suffix="%"
              hint="מהזמן שהאתרים היו זמינים" accent={OK_COLOR} trend={t("availability", true)} delay={70} />
            <KpiCard label="אחוז כשל" value={kpis.avgFailureRate} decimals={2} suffix="%"
              hint={failureSentence(kpis.totalOperations, kpis.totalErrors)}
              accent={ERR_COLOR} trend={t("failureRate", false)} delay={140} />
            <KpiCard label="אתרים פעילים" value={kpis.activeSites}
              hint={`מתוך ${kpis.totalSites} אתרים בסינון`} accent={BRAND} delay={210} />
          </section>

          {/* ===== רשת ה-bento ===== */}
          <div className="ex-bento">
            {PANELS.map((p, i) => (
              <Panel
                key={p.id}
                index={i}
                id={p.id}
                title={p.title}
                subtitle={p.subtitle}
                span={p.span}
                tall={p.tall}
                actions={p.actions}
                expanded={false}
                onExpand={setExpanded}
              >
                {p.render(false)}
              </Panel>
            ))}
          </div>
        </div>
      )}

      {/* חלונית פרושה על כל המסך */}
      {expandedPanel && (
        <Panel
          id={expandedPanel.id}
          title={expandedPanel.title}
          subtitle={expandedPanel.subtitle}
          actions={expandedPanel.actions}
          expanded
          onClose={() => setExpanded(null)}
        >
          {expandedPanel.render(true)}
        </Panel>
      )}

      {reportOpen && <ReportView data={data} onClose={() => setReportOpen(false)} />}
    </div>
  );
}

export default ExecutiveView;
