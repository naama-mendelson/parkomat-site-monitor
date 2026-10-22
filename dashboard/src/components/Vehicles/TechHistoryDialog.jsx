// components/Vehicles/TechHistoryDialog.jsx — ההיסטוריה של טכנאי אחד לתקופה (22/10/2026): סיכום, האתרים שביקר בהם, כל יום,
// וכל הביקורים. נפתח מהסטטיסטיקה (לחיצה על שם) ומפירוט הכרטיס. המסד מחשב (tech_history); כאן תרגום בלבד.
// כל מי שמחובר רואה (בחירת הבעלת). ⚠️ רק רכבי השירות — רכב שהוצא מהרשימה מקבל מהמסד PT404.
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchTechHistory } from "../../services/dataSource";
import { clockText } from "../../utils/vehicles";
import { hmText, kmText } from "../../utils/techStats";
import { PERIODS, dayLabel, ilDayLabel, ilTime, periodRange, siteLabel, techLabel } from "../../utils/techReport";
import "./DispatchDialog.css";
import "./TechReport.css";

const NBSP = " ";

export default function TechHistoryDialog({ plate, period: initialPeriod = "30", onClose }) {
  const [period, setPeriod] = useState(initialPeriod);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    const { from, to } = periodRange(period, new Date().toISOString());
    setLoading(true);
    fetchTechHistory(plate, from, to)
      .then((d) => { if (n === seq.current) { setData(d); setError(null); } })
      .catch((e) => { if (n === seq.current) setError(e?.message || "טעינת ההיסטוריה נכשלה"); })
      .finally(() => { if (n === seq.current) setLoading(false); });
  }, [plate, period]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sum = useMemo(() => {
    if (!data) return null;
    const work = data.days.filter((d) => d.moved);
    const km = data.days.reduce((s, d) => s + (Number(d.km) || 0), 0);
    const total = data.sites.reduce((s, x) => s + (Number(x.total_s) || 0), 0);
    return {
      work: work.length, km, visits: data.visits_total ?? data.visits.length, sites: data.sites.length,
      avg: data.visits_total ? total / data.visits_total : null, total,
      max: data.days.reduce((m, d) => Math.max(m, Number(d.max_speed) || 0), 0) || null,
    };
  }, [data]);
  const name = data ? techLabel({ tech: data.tech, nickname: data.nickname, plate }) : plate;
  const now = new Date().toISOString();

  return (
    <div className="dp-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dp dp--wide" role="dialog" aria-modal="true" aria-labelledby="th-title" aria-busy={loading}>
        <header className="dp-head">
          <h3 id="th-title">{name} <span className="dp-code">· {plate}</span></h3>
          <button type="button" className="dp-x" aria-label="סגירה" onClick={onClose}>✕</button>
        </header>
        <div className="tv-seg tr-periods" role="group" aria-label="תקופה">
          {PERIODS.map((p) => (
            <button key={p.key} type="button" className={period === p.key ? "is-on" : ""} aria-pressed={period === p.key}
                    onClick={() => setPeriod(p.key)}>{p.label}</button>
          ))}
        </div>
        {loading && !data && <p className="dp-muted" role="status">טוען…</p>}
        {error && <p className="dp-err" role="alert">{error}</p>}

        {data && sum && (
          <>
            <p className="tr-team">
              {[
                [sum.work, "ימי עבודה"], [kmText(sum.km), "ק״מ"], [sum.visits, "ביקורים"], [sum.sites, "אתרים שונים"],
                [sum.avg == null ? "—" : hmText(sum.avg), "ממוצע באתר"], [hmText(sum.total), "סה״כ באתרים"],
                [sum.max ? `${sum.max} קמ״ש` : "—", "מהירות שיא"],
              ].map(([v, l], i, arr) => (
                <span key={l} className="tr-fact"><b>{v}</b>{NBSP}{l}{i < arr.length - 1 ? `${NBSP}·` : ""}{" "}</span>
              ))}
            </p>

            <section aria-labelledby="th-sites">
              <h4 id="th-sites" className="rs-sub">האתרים שביקר בהם</h4>
              {data.sites.length === 0 ? <p className="dp-muted">לא היו ביקורים באתרים בתקופה הזו.</p> : (
                <div className="tr-wrap">
                  <table className="tr-table">
                    <thead><tr><th scope="col">אתר</th><th scope="col">ביקורים</th><th scope="col">סה״כ</th><th scope="col">ממוצע</th><th scope="col">הארוך</th><th scope="col">אחרון</th></tr></thead>
                    <tbody>
                      {data.sites.map((s) => (
                        <tr key={s.code}>
                          <th scope="row">{siteLabel(s)} <span className="dp-code">· {s.code}</span></th>
                          <td>{s.n}</td><td>{hmText(s.total_s)}</td><td>{hmText(s.avg_s)}</td><td>{hmText(s.max_s)}</td><td>{clockText(s.last, now)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section aria-labelledby="th-days">
              <h4 id="th-days" className="rs-sub">יום אחר יום</h4>
              {data.days.length === 0 ? <p className="dp-muted">אין נתונים לתקופה הזו.</p> : (
                <div className="tr-wrap">
                  <table className="tr-table">
                    <thead><tr><th scope="col">יום</th><th scope="col">ק״מ</th><th scope="col">נסיעה</th><th scope="col">באתרים</th><th scope="col">ביקורים</th><th scope="col">יציאה–סיום</th><th scope="col">שיא</th></tr></thead>
                    <tbody>
                      {data.days.map((d) => (
                        <tr key={d.day} className={d.moved ? "" : "tr-quiet"}>
                          <th scope="row">{dayLabel(d.day)}</th>
                          <td>{d.moved ? kmText(d.km) : "לא נסע"}</td>
                          <td>{d.moved ? hmText(d.drive_s) : "—"}</td>
                          <td>{d.site_s ? hmText(d.site_s) : "—"}</td>
                          <td>{d.visits}</td>
                          <td dir="ltr" className="tr-ltr">{d.moved && d.first_move ? `${ilTime(d.first_move)}–${ilTime(d.last_move)}` : "—"}</td>
                          <td>{d.max_speed ? `${d.max_speed} קמ״ש` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section aria-labelledby="th-visits">
              <h4 id="th-visits" className="rs-sub">כל הביקורים ({data.visits_total ?? data.visits.length})</h4>
              {data.visits.length === 0 ? <p className="dp-muted">אין ביקורים.</p> : (
                <div className="tr-wrap">
                  <table className="tr-table">
                    <thead><tr><th scope="col">יום</th><th scope="col">אתר</th><th scope="col">שעות</th><th scope="col">משך</th></tr></thead>
                    <tbody>
                      {data.visits.map((v) => (
                        <tr key={`${v.code}-${v.from}`}>
                          <th scope="row">{ilDayLabel(v.from)}</th>
                          <td>{siteLabel(v)} <span className="dp-code">· {v.code}</span>{v.approx ? <span className="rs-tag">מיקום משוער</span> : null}</td>
                          <td>{v.open ? `מ-${ilTime(v.from)}` : <span dir="ltr" className="tr-ltr">{ilTime(v.from)}–{ilTime(v.to)}</span>}</td>
                          <td>{hmText(v.dur_s)}{v.open ? " · עכשיו שם" : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data.visits_total > data.visits.length && (
                <p className="tr-foot">מוצגים {data.visits.length} הביקורים האחרונים מתוך {data.visits_total}.</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
