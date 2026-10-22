// components/Vehicles/TechStats.jsx — "סטטיסטיקה" בטכנאים (22/10/2026): לתקופה — הצוות, השיאים, השוואה, יום העבודה, ולפי אתר.
//
// הבעלת: "היסטוריה של אתרים שבהם כל אחד ביקר, וכמה שעות בממוצע נמצא טכנאי באתר, כמה כל אחד מהם, מי נוסע הכי מהר וכו' —
// תפרט הרבה מידע וכמה שיותר סטטיסטיקות". כל מי שמחובר רואה (בחירתה). המסד מחשב (tech_stats, site_visit_stats); כאן תרגום
// ומיון. לחיצה על טכנאי פותחת את ההיסטוריה שלו (TechHistoryDialog, ב-TechniciansView).
// ⚠️ נטען רק כשבוחרים את התקופה או התצוגה — לא כל דקה: הנתונים משתנים לאט, וכל טעינה סורקת את התקופה כולה.
//
// 22/10/2026, אחרי שראתה את הטבלה: "לא רוצה כזו תצוגה, אני רוצה תצוגה ויזואלית, מעניינת, צבעונית וברורה". עכשיו: אריחי
// הצוות, כרטיסי שיאים, עמודות השוואה למדד אחד בכל פעם, ציר יום העבודה, ואיך עובר היום (נסיעה / באתרים / השאר). הטבלה
// המלאה נשארה מאחורי כפתור — כל המספרים, וגם קריאה בלי צבע.
// צבע לפי משפחת המדד (מרחק ונסיעה / אתרים / מהירות / שעות), קבוע; הטקסט תמיד בצבעי הטקסט, לא בצבע הנתון.
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSiteVisitStats, fetchTechStats } from "../../services/dataSource";
import { clockText } from "../../utils/vehicles";
import { hmText, initials, kmText } from "../../utils/techStats";
import {
  COLUMNS, METRICS, MIX_PARTS, PERIODS, SITE_METRICS, barRows, clockAxis, dataNote, mixRows, periodRange, recordFamily,
  records, siteBarRows, siteLabel, siteTechsText, sortTechs, spanRows, techLabel,
} from "../../utils/techReport";
import "./TechReport.css";

// ── אייקונים קטנים (SVG בקו; לא אימוג'י — כל מערכת מציירת אימוג'י אחרת) ──
const PATHS = {
  road: "M6 21 10 3M18 21 14 3M12 6v2M12 11v2M12 16v2",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  pin: "M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  building: "M5 21V5l7-2v18M12 8l7 2v11M3 21h18M8 9h1M8 13h1M8 17h1M15 13h1M15 17h1",
  hourglass: "M7 3h10M7 21h10M8 3v3c0 2 4 4 4 6s-4 4-4 6v3M16 3v3c0 2-4 4-4 6s4 4 4 6v3",
  calendar: "M4 6h16v15H4zM4 10h16M8 3v4M16 3v4",
  gauge: "M4 17a8 8 0 1 1 16 0M12 17l4.5-5.5",
  trophy: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4",
};
function Icon({ name }) {
  return (
    <svg className="ts-svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const FAMILY_ICON = { road: "road", site: "pin", speed: "gauge", time: "clock" };

function SortHead({ col, sort, onSort }) {
  const on = sort.key === col.key;
  return (
    <th scope="col" aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={`tr-sort${on ? " is-on" : ""}`} onClick={() => onSort(col.key)}>
        {col.label}{on ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}

/** בורר מדד — כפתורי "גלולה" עם נקודה בצבע המשפחה. */
function MetricChips({ list, value, onChange, label }) {
  return (
    <div className="ts-chips" role="radiogroup" aria-label={label}>
      {list.map((m) => (
        <button key={m.key} type="button" role="radio" aria-checked={value === m.key}
                className={`ts-chip ts-f--${m.family ?? "site"}`} onClick={() => onChange(m.key)}>{m.label}</button>
      ))}
    </div>
  );
}

/** אריחי הצוות. */
function TeamTiles({ team }) {
  if (!team) return null;
  const tiles = [
    { key: "km", family: "road", icon: "road", value: kmText(team.km ?? 0), label: "ק״מ" },
    { key: "drive", family: "road", icon: "clock", value: hmText(team.drive_s ?? 0), label: "בנסיעה" },
    { key: "visits", family: "site", icon: "pin", value: String(team.visits ?? 0), label: "ביקורים באתרים" },
    { key: "sites", family: "site", icon: "building", value: String(team.sites ?? 0), label: "אתרים שונים" },
    { key: "avg", family: "site", icon: "hourglass", value: team.visit_avg_s == null ? "—" : hmText(team.visit_avg_s), label: "זמן ממוצע באתר" },
    { key: "days", family: "time", icon: "calendar", value: String(team.work_days ?? 0), label: "ימי עבודה" },
  ];
  return (
    <ul className="ts-kpis" aria-label="הצוות בתקופה">
      {tiles.map((t) => (
        <li key={t.key} className={`ts-kpi ts-f--${t.family}`} data-k={t.key}>
          <span className="ts-ico"><Icon name={t.icon} /></span>
          <span className="ts-kpi-text">
            <span className="ts-kpi-val">{t.value}</span>
            <span className="ts-kpi-label">{t.label}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** עמודות השוואה: מדד אחד, מהמוביל למטה. */
function Bars({ techs, metricKey, onHistory }) {
  const { metric, rows, missing } = barRows(techs, metricKey);
  if (!rows.length) return <p className="dp-muted">אין נתון ל{metric.label} בתקופה הזו.</p>;
  return (
    <>
      <ol className={`ts-bars ts-f--${metric.family}`} aria-label={`השוואה: ${metric.label}`}>
        {rows.map((r) => (
          <li key={r.plate} className="ts-bar-row" data-plate={r.plate}>
            <span className={`ts-rank${r.rank <= 3 ? ` ts-rank--top ts-rank--${r.rank}` : ""}`} aria-hidden="true">{r.rank}</span>
            <button type="button" className="tr-link ts-name" onClick={() => onHistory(r.plate)}>{r.name}</button>
            <span className="ts-track" title={`${r.name}: ${r.text}`}>
              <span className="ts-bar" style={{ "--p": r.pct }} />
              <span className="ts-val">{r.text}</span>
            </span>
          </li>
        ))}
      </ol>
      {missing > 0 && <p className="tr-foot">{missing === 1 ? "טכנאי אחד" : `${missing} טכנאים`} בלי נתון בתקופה הזו.</p>}
    </>
  );
}

/** ציר יום העבודה: מתי יוצא ומתי מסיים, בממוצע. הבוקר בצד ימין, כמו כל השורה. */
function WorkdayChart({ techs, onHistory }) {
  const axis = clockAxis(techs);
  const rows = spanRows(techs, axis);
  if (!axis || !rows.length) return <p className="dp-muted">אין עדיין ימי עבודה בתקופה הזו.</p>;
  const last = axis.ticks.length - 1;
  return (
    <div className="ts-gantt" role="list" aria-label="יום עבודה ממוצע: יציאה וסיום">
      <div className="ts-g-row ts-g-axis" aria-hidden="true">
        <span />
        <span className="ts-g-track">
          {axis.ticks.map((t, i) => (
            <span key={t.label} className={`ts-g-ticklabel${i === 0 ? " is-first" : ""}${i === last ? " is-last" : ""}${i % 2 ? " is-minor" : ""}`}
                  style={{ "--x": `${t.pct}%` }}>{t.label}</span>
          ))}
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.plate} className="ts-g-row" role="listitem" data-plate={r.plate}>
          <span className="ts-g-who">
            <button type="button" className="tr-link ts-name" onClick={() => onHistory(r.plate)}>{r.name}</button>
            <span className="ts-g-times"><span dir="ltr">{r.first}–{r.last}</span> · {r.len}</span>
          </span>
          <span className="ts-g-track" title={`${r.name}: יוצא ${r.first}, מסיים ${r.last}, יום של ${r.len}`}>
            {axis.ticks.map((t) => <span key={t.label} className="ts-g-tick" style={{ "--x": `${t.pct}%` }} />)}
            <span className="ts-g-bar" style={{ "--s": `${r.start}%`, "--w": `${r.width}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** איך עובר יום עבודה ממוצע: נסיעה / באתרים / השאר. */
function MixChart({ techs, onHistory }) {
  const rows = mixRows(techs);
  if (!rows.length) return <p className="dp-muted">אין עדיין ימי עבודה בתקופה הזו.</p>;
  return (
    <>
      <p className="ts-legend">
        {MIX_PARTS.map((p) => <span key={p.key} className={`ts-sw ts-sw--${p.key}`}>{p.label}</span>)}
      </p>
      <ol className="ts-mixes" aria-label="איך עובר יום עבודה ממוצע">
        {rows.map((r) => (
          <li key={r.plate} className="ts-mix-row" data-plate={r.plate}>
            <button type="button" className="tr-link ts-name" onClick={() => onHistory(r.plate)}>{r.name}</button>
            <span className="ts-mix" aria-label={r.mix.parts.map((p) => `${p.label} ${hmText(p.s)}`).join(", ")}>
              {r.mix.parts.filter((p) => p.pct >= 0.5).map((p) => (
                <span key={p.key} className={`ts-seg ts-seg--${p.key}`} style={{ flexGrow: p.pct }}
                      title={`${p.label}: ${hmText(p.s)} (${Math.round(p.pct)}%)`}>
                  {p.pct >= 14 ? `${Math.round(p.pct)}%` : ""}
                </span>
              ))}
            </span>
            <span className="ts-mix-total">{hmText(r.mix.total)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function TechTable({ techs, sort, onSort, onHistory }) {
  return (
    <div className="tr-wrap">
      <table className="tr-table">
        <thead>
          <tr>
            {COLUMNS.map((c) => <SortHead key={c.key} col={c} sort={sort} onSort={onSort} />)}
            <th scope="col">האתר שביקר בו הכי הרבה</th>
          </tr>
        </thead>
        <tbody>
          {techs.map((t) => (
            <tr key={t.plate} data-plate={t.plate}>
              <th scope="row"><button type="button" className="tr-link" onClick={() => onHistory(t.plate)}>{techLabel(t)}</button></th>
              {COLUMNS.slice(1).map((c) => <td key={c.key}>{c.text(t)}</td>)}
              <td>{t.top_site ? `${siteLabel(t.top_site)} (${t.top_site.n})` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SiteBars({ sites, metricKey, onHistory }) {
  const { rows } = siteBarRows(sites, metricKey);
  const now = new Date().toISOString();
  return (
    <ol className="ts-bars ts-f--site" aria-label="אתרים">
      {rows.map((r) => (
        <li key={r.site.code} className="ts-bar-row ts-site-row" data-code={r.site.code}>
          <span className={`ts-rank${r.rank <= 3 ? ` ts-rank--top ts-rank--${r.rank}` : ""}`} aria-hidden="true">{r.rank}</span>
          <span className="ts-site-name">{siteLabel(r.site)} <span className="dp-code">· {r.site.code}</span></span>
          <span className="ts-track" title={`${siteLabel(r.site)}: ${r.text}`}>
            <span className="ts-bar" style={{ "--p": r.pct }} />
            <span className="ts-val">{r.text}</span>
          </span>
          <span className="ts-site-more">
            {(r.site.techs ?? []).map((t) => (
              <button key={t.plate} type="button" className="ts-tchip" onClick={() => onHistory(t.plate)}
                      title={`${techLabel(t)}: ${t.n === 1 ? "ביקור אחד" : `${t.n} ביקורים`}`}>
                <span className="ts-tchip-ava" aria-hidden="true">{initials(techLabel(t))}</span>
                {techLabel(t)}<span className="ts-tchip-n">×{t.n}</span>
              </button>
            ))}
            <span className="ts-site-facts">
              ממוצע {hmText(r.site.avg_s)} · הארוך {hmText(r.site.max_s)} · אחרון {clockText(r.site.last, now)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function TechStats({ period, onPeriod, onHistory }) {
  const [tab, setTab] = useState("techs");
  const [stats, setStats] = useState(null);
  const [sites, setSites] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState({ key: "km", dir: "desc" });
  const [metric, setMetric] = useState("km");
  const [siteMetric, setSiteMetric] = useState("visits");
  const [showTable, setShowTable] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    const { from, to } = periodRange(period, new Date().toISOString());
    setLoading(true);
    Promise.allSettled([fetchTechStats(from, to), fetchSiteVisitStats(from, to)]).then(([s, v]) => {
      if (n !== seq.current) return;          // תקופה אחרת נבחרה בינתיים
      setLoading(false);
      if (s.status === "fulfilled") setStats(s.value);
      if (v.status === "fulfilled") setSites(v.value);
      const bad = [s, v].find((x) => x.status === "rejected");
      setError(bad ? bad.reason?.message || "טעינת הסטטיסטיקה נכשלה" : null);
    });
  }, [period]);

  const list = useMemo(() => stats?.techs ?? [], [stats]);
  const techs = useMemo(() => sortTechs(list, sort.key, sort.dir), [list, sort]);
  const recs = useMemo(() => records(list), [list]);
  const note = dataNote(stats);
  const onSort = (key) => setSort((cur) => (cur.key === key
    ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
    : { key, dir: key === "name" || key === "first_min" ? "asc" : "desc" }));
  const now = new Date().toISOString();

  return (
    <div className="tr" aria-busy={loading}>
      <div className="tr-bar">
        <div className="tv-seg" role="group" aria-label="תקופה">
          {PERIODS.map((p) => (
            <button key={p.key} type="button" className={period === p.key ? "is-on" : ""} aria-pressed={period === p.key}
                    onClick={() => onPeriod(p.key)}>{p.label}</button>
          ))}
        </div>
        <div className="tv-seg" role="group" aria-label="סטטיסטיקה לפי">
          <button type="button" className={tab === "techs" ? "is-on" : ""} aria-pressed={tab === "techs"} onClick={() => setTab("techs")}>לפי טכנאי</button>
          <button type="button" className={tab === "sites" ? "is-on" : ""} aria-pressed={tab === "sites"} onClick={() => setTab("sites")}>לפי אתר</button>
        </div>
        {loading && <span className="tr-loading" role="status">טוען…</span>}
      </div>
      {note && <p className="tr-note">{note}</p>}
      {error && <p className="veh-warn" role="alert">{error}</p>}

      {stats && tab === "techs" && (
        <>
          <TeamTiles team={stats.team} />

          {recs.length > 0 && (
            <section aria-labelledby="tr-rec-h">
              <h3 id="tr-rec-h" className="tr-h">מי הכי</h3>
              <ul className="ts-recs">
                {recs.map((r) => (
                  <li key={r.key} className={`ts-rec ts-f--${recordFamily(r.key)}`} data-k={r.key}>
                    <span className="ts-ico"><Icon name={r.key === "first_min" ? "clock" : FAMILY_ICON[recordFamily(r.key)]} /></span>
                    <span className="ts-rec-text">
                      <span className="tr-rec-label">{r.label}</span>
                      <button type="button" className="tr-link ts-rec-name" onClick={() => onHistory(r.plate)}>{r.name}</button>
                      <span className="tr-rec-val">{r.text}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {list.length === 0 ? <p className="dp-muted">אין טכנאים ברשימה.</p> : (
            <>
              <section aria-labelledby="ts-cmp-h" className="ts-panel">
                <h3 id="ts-cmp-h" className="tr-h">השוואה בין הטכנאים <span className="tr-h-hint">— לחיצה על שם פותחת את ההיסטוריה שלו</span></h3>
                <MetricChips list={METRICS} value={metric} onChange={setMetric} label="מה להשוות" />
                <Bars techs={list} metricKey={metric} onHistory={onHistory} />
              </section>

              <section aria-labelledby="ts-day-h" className="ts-panel ts-f--time">
                <h3 id="ts-day-h" className="tr-h">יום העבודה <span className="tr-h-hint">— יציאה וסיום בממוצע, בימים שבהם נסע</span></h3>
                <WorkdayChart techs={list} onHistory={onHistory} />
              </section>

              <section aria-labelledby="ts-mix-h" className="ts-panel">
                <h3 id="ts-mix-h" className="tr-h">איך עובר יום עבודה <span className="tr-h-hint">— בממוצע, מהיציאה עד הסיום</span></h3>
                <MixChart techs={list} onHistory={onHistory} />
              </section>

              <section aria-labelledby="tr-tech-h">
                <button type="button" className="ts-more" aria-expanded={showTable} aria-controls="ts-table"
                        onClick={() => setShowTable((x) => !x)}>
                  {showTable ? "הסתרת הטבלה ▴" : "כל המספרים בטבלה ▾"}
                </button>
                <div id="ts-table" hidden={!showTable}>
                  <h3 id="tr-tech-h" className="tr-h">לפי טכנאי</h3>
                  <TechTable techs={techs} sort={sort} onSort={onSort} onHistory={onHistory} />
                  <p className="tr-foot">
                    זמן באתר = מההגעה עד היציאה, לביקור של שתי דקות לפחות. מהירות ממוצעת = ק״מ לשעת נסיעה (כולל עמידה ברמזור).
                    יציאה וסיום — ממוצע הימים שבהם נסע.
                  </p>
                </div>
              </section>
            </>
          )}
        </>
      )}

      {tab === "sites" && sites && (
        <section aria-labelledby="tr-site-h" className="ts-panel">
          <h3 id="tr-site-h" className="tr-h">לפי אתר <span className="tr-h-hint">— מי היה בכל אתר, כמה פעמים וכמה זמן</span></h3>
          {sites.length === 0 ? <p className="dp-muted">לא היו ביקורים באתרים בתקופה הזו.</p> : (
            <>
              <MetricChips list={SITE_METRICS} value={siteMetric} onChange={setSiteMetric} label="לפי מה לסדר" />
              <SiteBars sites={sites} metricKey={siteMetric} onHistory={onHistory} />
              <button type="button" className="ts-more" aria-expanded={showTable} aria-controls="ts-site-table"
                      onClick={() => setShowTable((x) => !x)}>
                {showTable ? "הסתרת הטבלה ▴" : "כל המספרים בטבלה ▾"}
              </button>
              <div id="ts-site-table" hidden={!showTable}>
                <div className="tr-wrap">
                  <table className="tr-table">
                    <thead>
                      <tr>
                        <th scope="col">אתר</th><th scope="col">ביקורים</th><th scope="col">טכנאים</th><th scope="col">זמן ממוצע</th>
                        <th scope="col">סה״כ</th><th scope="col">הארוך</th><th scope="col">אחרון</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sites.map((s) => (
                        <tr key={s.code} data-code={s.code}>
                          <th scope="row">{siteLabel(s)} <span className="dp-code">· {s.code}</span></th>
                          <td>{s.visits}</td>
                          <td className="tr-wide">{siteTechsText(s)}</td>
                          <td>{hmText(s.avg_s)}</td>
                          <td>{hmText(s.total_s)}</td>
                          <td>{hmText(s.max_s)}</td>
                          <td>{clockText(s.last, now)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
