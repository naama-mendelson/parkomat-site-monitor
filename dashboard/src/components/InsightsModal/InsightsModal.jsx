// components/InsightsModal/InsightsModal.jsx — מסך "עוד מידע":
// חמישה מסכי משנה (סקירה · פעילות · כרטיסים · אמינות · לוג), מעל בורר תקופה משותף.
import { useEffect, useState } from "react";
import { STATUS_COLORS, DIRECTION_COLORS } from "../../utils/constants";
import { useSiteInsights } from "../../hooks/useSiteInsights";
import PeriodTabs from "../PeriodTabs/PeriodTabs";
import MetricCard from "../MetricCard/MetricCard";
import BarChart from "../BarChart/BarChart";
import DonutChart from "../DonutChart/DonutChart";
import ActivityLog from "../ActivityLog/ActivityLog";
import SectionNav from "./SectionNav";
import "./InsightsModal.css";

const ENTRY_COLOR = DIRECTION_COLORS.entry;   // כחול — כניסות
const EXIT_COLOR = DIRECTION_COLORS.exit;     // סגול — יציאות (לא צהוב! זה הצבע של תחזוקה)

// צבע סדרת ה"פעולות" בגרפי הפעילות — כאן מדובר בפעילות כוללת, לא בכיוון תנועה.
const ACTIVITY_COLOR = STATUS_COLORS.operating.dot;

// שניות → טקסט קריא ("1 דק' 18 שנ'" / "45 שניות")
function fmtSeconds(s) {
  if (s === null || s === undefined) return "—";
  if (s < 60) return `${Math.round(s)} שניות`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest === 0 ? `${m} דקות` : `${m} דק' ${rest} שנ'`;
}

// שעות → טקסט קריא
function fmtHours(h) {
  if (!h) return "0";
  if (h < 1) return `${Math.round(h * 60)} דקות`;
  return `${Math.round(h * 10) / 10} שעות`;
}

function InsightsModal({ site, period, onPeriodChange, version, onClose, initialSection = "overview" }) {
  const [section, setSection] = useState(initialSection);
  const { data, loading, error } = useSiteInsights(site.code, period, { version });

  // סגירה ב-Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const logCount = data
    ? data.log.counts.operations + data.log.counts.status + data.log.counts.maintenance
    : null;

  const sections = [
    { key: "overview", label: "סקירה" },
    { key: "activity", label: "פעילות" },
    { key: "cards", label: "כרטיסים", badge: data?.cards.uniqueCards },
    { key: "reliability", label: "אמינות" },
    { key: "log", label: "לוג", badge: logCount },
  ];

  return (
    <div className="insights-overlay" onClick={onClose}>
      <div className="insights-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">

        {/* ===== כותרת ===== */}
        <header className="insights-header">
          <div>
            <h2>{site.site_name}</h2>
            <span className="insights-code">קוד אתר: {site.code}</span>
          </div>
          <button className="insights-close" onClick={onClose} aria-label="סגירה">✕</button>
        </header>

        {/* ===== ניווט: תקופה + מסך ===== */}
        <div className="insights-nav">
          <PeriodTabs period={period} onChange={onPeriodChange} rangeLabel={data?.label} />
          <SectionNav sections={sections} active={section} onChange={setSection} />
        </div>

        {/* ===== תוכן ===== */}
        {loading && !data ? (
          <p className="insights-state">טוען נתונים…</p>
        ) : error && !data ? (
          <p className="insights-state insights-error">{error}</p>
        ) : !data ? null : (
          <div key={section} className={`insights-body ${loading ? "is-refreshing" : ""}`}>

            {/* ---------- סקירה ---------- */}
            {section === "overview" && (
              <>
                <div className="insights-kpis">
                  <MetricCard label="סך פעולות" value={data.totals.operations.toLocaleString()} hint="פעולות חניה שהושלמו" accent />
                  <MetricCard label="כניסות" value={data.totals.entries.toLocaleString()} hint="רכבים שנכנסו לחניון" />
                  <MetricCard label="יציאות" value={data.totals.exits.toLocaleString()} hint="רכבים שיצאו מהחניון" />
                  <MetricCard label="כרטיסים ייחודיים" value={data.cards.uniqueCards.toLocaleString()} hint="כמה כרטיסים שונים השתמשו באתר" />
                  <MetricCard label="ימי פעילות" value={data.totals.activeDays.toLocaleString()} hint="ימים שבהם נרשמה פעולה" />
                  <MetricCard label="אנומליות" value={data.totals.anomalies.toLocaleString()} hint="פעולות שנרשמו במצב לא תקין" />
                </div>

                <section className="insights-card">
                  <h3>כניסות מול יציאות</h3>
                  <p className="insights-sub">חלוקת הפעולות לפי כיוון התנועה</p>
                  <DonutChart
                    centerNote="פעולות"
                    slices={[
                      { label: "כניסות", value: data.totals.entries, color: ENTRY_COLOR },
                      { label: "יציאות", value: data.totals.exits, color: EXIT_COLOR },
                    ]}
                  />
                  {data.totals.entries !== data.totals.exits && (
                    <p className="insights-note">
                      הפרש של {Math.abs(data.totals.entries - data.totals.exits)} —
                      {data.totals.entries > data.totals.exits
                        ? " יש רכבים שנכנסו וטרם יצאו"
                        : " יש יציאות של רכבים שנכנסו לפני התקופה"}
                    </p>
                  )}
                </section>
              </>
            )}

            {/* ---------- פעילות ---------- */}
            {section === "activity" && (
              <>
                <section className="insights-card">
                  <h3>פעילות לפי שעה ביום</h3>
                  <p className="insights-sub">באילו שעות החניון עמוס — מסייע לתכנון כוח אדם ותחזוקה</p>
                  <BarChart
                    bars={data.activity.byHour.map((h) => ({ label: String(h.hour), value: h.operations }))}
                    color={ACTIVITY_COLOR}
                    highlight={data.activity.busiestHour?.operations}
                    unit="פעולות"
                    everyLabel={3}
                  />
                  {data.activity.busiestHour && (
                    <p className="insights-note">
                      השעה העמוסה ביותר: <strong>{data.activity.busiestHour.hour}:00</strong> —
                      {" "}{data.activity.busiestHour.operations} פעולות
                    </p>
                  )}
                </section>

                <section className="insights-card">
                  <h3>פעילות לפי יום בשבוע</h3>
                  <p className="insights-sub">אילו ימים עמוסים יותר</p>
                  <BarChart
                    bars={data.activity.byWeekday.map((w) => ({ label: w.label, value: w.operations }))}
                    color={ACTIVITY_COLOR}
                    unit="פעולות"
                  />
                </section>

                <section className="insights-card">
                  <h3>שיאים וקצב</h3>
                  <div className="insights-kpis">
                    <MetricCard
                      label="היום העמוס ביותר"
                      value={data.activity.busiestDay ? String(data.activity.busiestDay.operations) : "—"}
                      hint={data.activity.busiestDay ? `${data.activity.busiestDay.label} — פעולות ביום זה` : "אין פעילות בתקופה"}
                    />
                    <MetricCard label="ממוצע יומי" value={String(data.activity.dailyAverage)} hint="פעולות בממוצע ליום פעילות" />
                    <MetricCard
                      label="השעה העמוסה"
                      value={data.activity.busiestHour ? `${data.activity.busiestHour.hour}:00` : "—"}
                      hint={data.activity.busiestHour ? `${data.activity.busiestHour.operations} פעולות בשעה זו` : "אין פעילות"}
                    />
                  </div>
                </section>
              </>
            )}

            {/* ---------- כרטיסים ---------- */}
            {section === "cards" && (
              <section className="insights-card">
                <h3>הכרטיסים הפעילים ביותר</h3>
                <p className="insights-sub">מי השתמש באתר הכי הרבה בתקופה</p>
                {data.cards.top.length > 0 ? (
                  <>
                    <table className="insights-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>כרטיס</th>
                          <th>סך פעולות</th>
                          <th>כניסות</th>
                          <th>יציאות</th>
                          <th>שימוש אחרון</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.cards.top.map((c, i) => (
                          <tr key={c.card}>
                            <td className="rank">{i + 1}</td>
                            <td className="card-num">{c.card}</td>
                            <td><strong>{c.total}</strong></td>
                            <td><span className="pill" style={{ background: ENTRY_COLOR }}>{c.entries}</span></td>
                            <td><span className="pill" style={{ background: EXIT_COLOR }}>{c.exits}</span></td>
                            <td className="muted">
                              {c.lastAt ? new Date(c.lastAt).toLocaleString("he-IL", {
                                day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                              }) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="insights-note">
                      {data.cards.withCard.toLocaleString()} פעולות בוצעו עם כרטיס מזוהה
                      {data.cards.withoutCard > 0 && `, ו-${data.cards.withoutCard.toLocaleString()} ללא כרטיס`}
                    </p>
                  </>
                ) : (
                  <p className="insights-note">לא נרשמו פעולות עם כרטיס מזוהה בתקופה זו</p>
                )}
              </section>
            )}

            {/* ---------- אמינות ---------- */}
            {section === "reliability" && (
              <>
                <section className="insights-card">
                  <h3>משך פעולת חניה</h3>
                  <p className="insights-sub">כמה זמן לוקח למכונה להשלים פעולה, מרגע ההתחלה ועד הסיום</p>
                  {data.durations ? (
                    <div className="insights-kpis">
                      <MetricCard label="משך ממוצע" value={fmtSeconds(data.durations.averageSeconds)} hint="הזמן הטיפוסי לפעולה" accent />
                      <MetricCard label="חציון" value={fmtSeconds(data.durations.medianSeconds)} hint="מחצית מהפעולות מהירות מזה" />
                      <MetricCard label="הפעולה המהירה" value={fmtSeconds(data.durations.shortestSeconds)} hint="המשך הקצר ביותר שנמדד" />
                      <MetricCard label="הפעולה האיטית" value={fmtSeconds(data.durations.longestSeconds)} hint="המשך הארוך ביותר שנמדד" />
                    </div>
                  ) : (
                    <p className="insights-note">לא נמדדו פעולות שלמות בתקופה זו</p>
                  )}
                </section>

                <section className="insights-card">
                  <h3>השבתות ותקלות</h3>
                  <p className="insights-sub">כמה זמן האתר לא היה זמין עקב תקלה</p>
                  <div className="insights-kpis">
                    <MetricCard label="אירועי השבתה" value={String(data.downtime.incidents)} hint="פעמים שהאתר נכנס למצב מושבת" />
                    <MetricCard label="סך זמן השבתה" value={fmtHours(data.downtime.totalHours)} hint="סך הזמן שהאתר לא פעל" />
                    <MetricCard
                      label="ההשבתה הארוכה"
                      value={fmtHours(data.downtime.longestHours)}
                      hint={data.downtime.longestAt
                        ? `החלה ב-${new Date(data.downtime.longestAt).toLocaleDateString("he-IL")}`
                        : "לא היו השבתות"}
                    />
                    <MetricCard label="זמן תיקון ממוצע" value={fmtHours(data.downtime.averageHours)} hint="כמה זמן בממוצע לוקח לחזור לפעילות" />
                  </div>
                  {data.downtime.incidents === 0 && (
                    <p className="insights-note insights-good">✓ לא נרשמו השבתות בתקופה זו</p>
                  )}
                </section>

                <section className="insights-card">
                  <h3>תחזוקה</h3>
                  <p className="insights-sub">
                    זמן תחזוקה הוא <strong>מתוכנן</strong> — הוא נמדד בנפרד מהשבתות, ותקלות
                    שקרו במהלכו אינן נספרות באחוז הכשל
                  </p>
                  <div className="insights-kpis">
                    <MetricCard
                      label="כניסות לתחזוקה"
                      value={String(data.maintenance.plcEntries)}
                      hint="פעמים שהאתר עבר למצב תחזוקה"
                    />
                    <MetricCard
                      label="סך זמן בתחזוקה"
                      value={fmtHours(data.maintenance.totalHours)}
                      hint="סך הזמן שהאתר היה בתחזוקה"
                    />
                    <MetricCard
                      label="התחזוקה הארוכה"
                      value={fmtHours(data.maintenance.longestHours)}
                      hint="חלון התחזוקה הארוך ביותר"
                    />
                    <MetricCard
                      label="חלונות ידניים"
                      value={String(data.maintenance.manualWindows)}
                      hint="תחזוקה שהופעלה מהדשבורד (השאר דווחו מהבקר)"
                    />
                  </div>

                  {data.maintenance.recentWindows.length > 0 && (
                    <table className="insights-table">
                      <thead>
                        <tr>
                          <th>מי הפעיל</th>
                          <th>מתי</th>
                          <th>משך מתוכנן</th>
                          <th>סיבה</th>
                          <th>סטטוס</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.maintenance.recentWindows.map((w, i) => (
                          <tr key={i}>
                            <td className="card-num">{w.setBy}</td>
                            <td className="muted">
                              {new Date(w.startedAt).toLocaleString("he-IL", {
                                day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                              })}
                            </td>
                            <td>{w.durationHours} שע'</td>
                            <td className="muted">{w.reason || "—"}</td>
                            <td>{w.cancelled ? "בוטל" : "הופעל"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {data.maintenance.plcEntries === 0 && data.maintenance.manualWindows === 0 && (
                    <p className="insights-note">לא נרשמה תחזוקה בתקופה זו</p>
                  )}
                </section>
              </>
            )}

            {/* ---------- לוג ---------- */}
            {section === "log" && (
              <section className="insights-card">
                <h3>לוג פעילות מלא</h3>
                <p className="insights-sub">
                  כל האירועים בתקופה — כניסות ויציאות, שינויי מצב וחלונות תחזוקה, מהחדש לישן
                </p>
                <ActivityLog log={data.log} />
              </section>
            )}

          </div>
        )}
      </div>
    </div>
  );
}

export default InsightsModal;
