// components/Vehicles/TechStats.jsx — "סטטיסטיקה" בטכנאים (22/10/2026): לתקופה — הצוות, השיאים, טבלה לפי טכנאי, ולפי אתר.
//
// הבעלת: "היסטוריה של אתרים שבהם כל אחד ביקר, וכמה שעות בממוצע נמצא טכנאי באתר, כמה כל אחד מהם, מי נוסע הכי מהר וכו' —
// תפרט הרבה מידע וכמה שיותר סטטיסטיקות". כל מי שמחובר רואה (בחירתה). המסד מחשב (tech_stats, site_visit_stats); כאן תרגום
// ומיון. לחיצה על טכנאי פותחת את ההיסטוריה שלו (TechHistoryDialog, ב-TechniciansView).
// ⚠️ נטען רק כשבוחרים את התקופה או התצוגה — לא כל דקה: הנתונים משתנים לאט, וכל טעינה סורקת את התקופה כולה.
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSiteVisitStats, fetchTechStats } from "../../services/dataSource";
import { clockText } from "../../utils/vehicles";
import { hmText } from "../../utils/techStats";
import {
  COLUMNS, PERIODS, dataNote, periodRange, records, siteLabel, siteTechsText, sortTechs, teamFacts, techLabel,
} from "../../utils/techReport";
import "./TechReport.css";

const NBSP = " ";

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

export default function TechStats({ period, onPeriod, onHistory }) {
  const [tab, setTab] = useState("techs");
  const [stats, setStats] = useState(null);
  const [sites, setSites] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState({ key: "km", dir: "desc" });
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

  const techs = useMemo(() => sortTechs(stats?.techs ?? [], sort.key, sort.dir), [stats, sort]);
  const recs = useMemo(() => records(stats?.techs ?? []), [stats]);
  const facts = teamFacts(stats?.team);
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

      {stats && (
        <p className="tr-team" aria-label="הצוות בתקופה">
          {facts.map((f, i) => (
            <span key={f.label} className="tr-fact"><b>{f.text}</b>{NBSP}{f.label}{i < facts.length - 1 ? `${NBSP}·` : ""}{" "}</span>
          ))}
        </p>
      )}

      {stats && tab === "techs" && (
        <>
          {recs.length > 0 && (
            <section aria-labelledby="tr-rec-h">
              <h3 id="tr-rec-h" className="tr-h">שיאים</h3>
              <ul className="tr-records">
                {recs.map((r) => (
                  <li key={r.key}>
                    <span className="tr-rec-label">{r.label}</span>
                    <button type="button" className="tr-link" onClick={() => onHistory(r.plate)}>{r.name}</button>
                    <span className="tr-rec-val">{r.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="tr-tech-h">
            <h3 id="tr-tech-h" className="tr-h">לפי טכנאי <span className="tr-h-hint">— לחיצה על שם פותחת את ההיסטוריה שלו</span></h3>
            {techs.length === 0 ? <p className="dp-muted">אין טכנאים ברשימה.</p> : (
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
            )}
            <p className="tr-foot">
              זמן באתר = מההגעה עד היציאה, לביקור של שתי דקות לפחות. מהירות ממוצעת = ק״מ לשעת נסיעה (כולל עמידה ברמזור).
              יציאה וסיום — ממוצע הימים שבהם נסע.
            </p>
          </section>
        </>
      )}

      {tab === "sites" && sites && (
        <section aria-labelledby="tr-site-h">
          <h3 id="tr-site-h" className="tr-h">לפי אתר <span className="tr-h-hint">— מי היה בכל אתר, כמה פעמים וכמה זמן</span></h3>
          {sites.length === 0 ? <p className="dp-muted">לא היו ביקורים באתרים בתקופה הזו.</p> : (
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
          )}
        </section>
      )}
    </div>
  );
}
