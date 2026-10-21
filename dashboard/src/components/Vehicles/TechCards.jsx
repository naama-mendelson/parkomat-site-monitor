// components/Vehicles/TechCards.jsx — "טכנאים" › כרטיסים: כרטיס לכל טכנאי (21/10/2026).
//
// בעלת המוצר: "לכל טכנאי רואים איפה הוא נמצא, האם הוא נמצא באתר (אם הרכב שלו חונה ליד אתר שלנו), ועוד כל פרט וסטטיסטיקה
// שאתה יכול להביא — תהיה יצירתי ותחשוב גדול, חזק ויפה". לכל כרטיס:
//   • איפה עכשיו — באתר (מאיזו שעה, וכמה זמן), בנסיעה, חונה, או "לא מתעדכן" עם המקום האחרון;
//   • כשהוא באתר — מצב האתר (בתקלה + הטקסט מהבקר), והקריאות והמשימות הפתוחות שם, בלחיצה;
//   • היום — ק"מ, זמן נסיעה, ביקורים באתרים, מתי יצא לדרך; ציר היום (נסיעה / באתר / חונה / אין קליטה); רשימת הביקורים;
//   • השבוע — עמודה לכל יום.
// מעל הכרטיסים: "צריכים טכנאי עכשיו" — אתרים בתקלה או עם קריאה פתוחה, ומי כבר שם או מי הכי קרוב; והצוות היום.
//
// ⚠️ הכרטיס הוא לפי רכב באיתוראן. השם — של הטכנאי המשויך לרכב (technicians, לוח הרכז), ובלי שיוך — הכינוי באיתוראן.
// "צא ל:" (21/10/2026, בעלת המוצר: "שכל כרטיס יהיה סוג של ניהול הטכנאי") — DispatchDialog; רכב בלי טכנאי מקבל אחד בשליחה
// הראשונה. רק בפיילוט (settings.technicians_board) ורק לעורך / מנהל.
// ⚠️ כל ההחלטות במסד (vehicle-stats.postgres.sql); utils/techStats.js מתרגם.
import { useEffect, useMemo, useRef, useState } from "react";
import { endDispatch } from "../../services/dataSource";
import { useTasks } from "../Tasks/TasksContext";
import { useServiceCalls } from "../ServiceCalls/ServiceCallsContext";
import { ageText, clockText, hasPosition, powerAlert, vehicleName } from "../../utils/vehicles";
import {
  cardGroup, groupCounts, groupLabel, GROUPS, hhmm, hmText, initials, kmText, matchesCard, sortCards, teamToday,
  timeline, visitRows, weekBars, weekTotals, whereInfo,
} from "../../utils/techStats";
import { destText, dispatchLine, techByPlate } from "../../utils/technicians";
import { siteKey } from "../../utils/siteSearch";
import DispatchDialog from "./DispatchDialog";
import TechPhoneDialog from "./TechPhoneDialog";
import { phoneStatus } from "../../utils/techPhone";

const NBSP = " ";
const FILTERS = ["all", "site", "move", "idle", "park", "silent"];
const LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g]));

function SiteState({ site, tasks, calls }) {
  if (!site) return null;
  const open = Number(calls?.bySite?.[site.id]?.open) || 0;
  const tk = Number(tasks?.bySite?.[site.id]?.open) || 0;
  const fault = site.monitored !== false && (site.displayStatus ?? site.status) === "error";
  const maint = site.monitored !== false && (site.displayStatus ?? site.status) === "maintenance";
  if (!fault && !maint && !open && !tk) return null;
  return (
    <div className="tc-site">
      {fault && (
        <p className="tc-site-fault">
          <b>האתר בתקלה</b>{site.currentFaultText ? <>: <span>{site.currentFaultText}</span></> : null}
        </p>
      )}
      {maint && <p className="tc-site-maint"><b>האתר בתחזוקה</b></p>}
      {(open > 0 || tk > 0) && (
        <p className="tc-site-btns">
          {open > 0 && calls?.openSite && (
            <button type="button" className="tc-pill tc-pill--call" onClick={() => calls.openSite(site)}>
              {open === 1 ? "קריאה פתוחה" : `${open} קריאות פתוחות`}
            </button>
          )}
          {tk > 0 && tasks?.openSite && (
            <button type="button" className="tc-pill" onClick={() => tasks.openSite(site)}>
              {tk === 1 ? "משימה פתוחה" : `${tk} משימות פתוחות`}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

function Timeline({ stats }) {
  const tl = timeline(stats);
  if (!tl) return null;
  const t = stats.today;
  const aria = `ציר היום: ${hmText(t?.drive_s)} בנסיעה, ${hmText(t?.site_s)} באתרים`;
  return (
    <div className="tc-tl" role="img" aria-label={aria}>
      <div className="tc-tl-bar" dir="ltr">
        {tl.blocks.map((b, i) => (
          <span key={i} className={`tc-tl-b tc-k--${b.kind}`} style={{ left: `${b.left}%`, width: `${b.width}%` }} title={b.title} />
        ))}
        {tl.now != null && <span className="tc-tl-now" style={{ left: `${tl.now}%` }} />}
      </div>
      <div className="tc-tl-ticks" dir="ltr" aria-hidden="true">
        {tl.ticks.map((x) => <span key={x.label + x.at} style={{ left: `${x.at}%` }}>{x.label}</span>)}
      </div>
    </div>
  );
}

function Week({ stats }) {
  const bars = weekBars(stats);
  if (!bars.length) return null;
  const tot = weekTotals(stats);
  return (
    <div className="tc-week">
      <div className="tc-week-bars" dir="ltr" aria-hidden="true">
        {bars.map((b) => (
          <span key={b.day} className={`tc-wb${b.today ? " is-today" : ""}${b.tracked ? "" : " is-empty"}`}
            title={b.tracked ? `${b.day.slice(8, 10)}/${b.day.slice(5, 7)}: ${kmText(b.km)} ק״מ · ${b.visits} ביקורים` : `${b.day.slice(8, 10)}/${b.day.slice(5, 7)}: לא נאסף`}>
            <i style={{ height: `${b.h}%` }} />
            <em>{b.label}</em>
          </span>
        ))}
      </div>
      <p className="tc-week-sum">
        {tot.days > 1
          ? <>השבוע: <b>{kmText(tot.km)}</b> ק״מ · <b>{tot.visits}</b> ביקורים</>
          : "השבוע — הנתונים נאספים מהיום"}
      </p>
    </div>
  );
}

// המשימה הפתוחה של הטכנאי (21/10/2026): לאן, מה, מתי ומי שלח — ולעורך "סיום" ו"ביטול". ⚠️ "ביטול" בשתי לחיצות (4 שניות),
// כמו X במשימות: לחיצה אחת בטעות לא מוחקת שליחה.
function TaskBlock({ d, now, canSend, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef(null);
  useEffect(() => () => clearTimeout(armTimer.current), []);
  const end = async (kind) => {
    if (kind === "cancelled" && !armed) {
      setArmed(true);
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(armTimer.current);
    setArmed(false);
    setBusy(true);
    setErr(null);
    try { await endDispatch(d.id, kind); onChanged?.(); }
    catch (e) { setErr(e?.message || "הפעולה נכשלה"); if (e?.stale) onChanged?.(); }
    finally { setBusy(false); }
  };
  return (
    <div className="tc-task" aria-label="המשימה הפתוחה">
      <p className="tc-task-dest"><span className="tc-task-k">משימה:</span> {destText(d)}</p>
      {d.details && <p className="tc-task-text">{d.details}</p>}
      <p className="tc-task-meta">{dispatchLine(d, now)}</p>
      {canSend && (
        <span className="tc-task-btns">
          <button type="button" onClick={() => end("done")} disabled={busy}>סיום משימה</button>
          <button type="button" className={armed ? "is-armed" : ""} onClick={() => end("cancelled")} disabled={busy}>
            {armed ? "לבטל? לחיצה נוספת" : "ביטול"}
          </button>
        </span>
      )}
      {err && <p className="tc-task-err" role="alert">{err}</p>}
    </div>
  );
}

function TechCard({ v, now, site, tasks, calls, onMap, flash, setRef, tech, canSend, onSend, onPhone, onBoardChanged }) {
  const name = tech?.name || vehicleName(v);
  const w = whereInfo(v, now);
  const power = powerAlert(v, now);
  const t = v.stats?.today;
  const visits = visitRows(v.stats, now);
  const model = [v.make, v.model].filter(Boolean).join(" ");
  return (
    <article ref={setRef} className={`tc-card tc-g--${w.group}${flash ? " is-flash" : ""}`} aria-label={`${name} — ${w.title}`}>
      <header className="tc-head">
        <span className="tc-ava" aria-hidden="true">{initials(name)}</span>
        <div className="tc-id">
          <h3 className="tc-name">{name}</h3>
          <span className="tc-plate">{v.plate}{model ? ` · ${model}` : ""}</span>
        </div>
        <span className="tc-chip">{LABEL[w.group]?.label ?? ""}</span>
      </header>

      {tech?.dispatch && <TaskBlock d={tech.dispatch} now={now} canSend={canSend} onChanged={onBoardChanged} />}

      <div className="tc-where">
        <p className="tc-where-title">
          {w.title}{w.code ? <span className="tc-code">{NBSP}· {w.code}</span> : null}
        </p>
        {w.sub.map((x) => <p key={x} className="tc-where-sub">{x}</p>)}
        {w.approx && <p className="tc-note">מיקום האתר משוער (לפי הרחוב) — ייתכן שהוא חונה ליד, לא בו</p>}
        {power && <p className="tc-power">⚠ {power.text}</p>}
        <SiteState site={site} tasks={tasks} calls={calls} />
      </div>

      <div className="tc-stats">
        <div className="tc-stat"><b>{kmText(t?.km)}</b><span>ק״מ היום</span></div>
        <div className="tc-stat"><b>{t ? hhmm(t.drive_s) : "—"}</b><span>שעות בנסיעה</span></div>
        <div className="tc-stat"><b>{visits.length}</b><span>{visits.length === 1 ? "ביקור באתר" : "ביקורים באתרים"}</span></div>
        <div className="tc-stat"><b>{t?.first_move ? clockText(t.first_move, now) : "—"}</b><span>יצא לדרך</span></div>
      </div>

      <Timeline stats={v.stats} />

      {visits.length > 0 && (
        <ul className="tc-visits" aria-label="הביקורים של היום">
          {visits.map((x) => (
            <li key={x.code + x.from} className={x.open ? "is-open" : ""}>
              <b>{x.label}</b>
              <span dir="ltr">{x.from}{x.to ? `–${x.to}` : ""}</span>
              <span>{x.open ? `עכשיו · ${x.dur}` : x.dur}</span>
            </li>
          ))}
        </ul>
      )}

      <Week stats={v.stats} />

      <footer className="tc-foot">
        <span>{w.group === "stale" ? "" : `דיווח ${ageText(v.located_at, now)}`}{t?.max_speed ? ` · מהירות שיא ${t.max_speed} קמ"ש` : ""}</span>
        <span className="tc-foot-btns">
          {canSend && <button type="button" className="tc-go" onClick={() => onSend(v)}>צא ל:</button>}
          {canSend && (() => {
            const ph = phoneStatus(tech?.phone, now);
            return (
              <button type="button" className={`tc-phone tc-phone--${ph.key}`} title={ph.text} aria-label={`טלפון — ${ph.text}`}
                onClick={() => onPhone(v)}>
                {ph.key === "ok" ? "טלפון ✓" : "טלפון"}
              </button>
            );
          })()}
          {hasPosition(v) && <button type="button" onClick={() => onMap(v.plate)}>במפה</button>}
          {hasPosition(v) && <a href={`https://www.google.com/maps?q=${v.lat},${v.lon}`} target="_blank" rel="noopener noreferrer">ניווט</a>}
        </span>
      </footer>
    </article>
  );
}

function AlertStrip({ alerts, siteByCode, calls, goTo }) {
  return (
    <section className="tc-alerts" aria-labelledby="tc-alerts-title">
      <h3 id="tc-alerts-title">צריכים טכנאי עכשיו <span>· {alerts.length}</span></h3>
      <ul>
        {alerts.map((a) => {
          const site = siteByCode.get(a.code);
          const faultText = a.fault ? site?.currentFaultText : null;
          return (
            <li key={a.code} className={`tc-alert ${a.fault ? "is-fault" : "is-call"}`}>
              <p className="tc-alert-site">
                <b>{a.label}</b> <span className="tc-code">{a.code}</span>
                {a.fault && <span className="tc-badge tc-badge--fault">בתקלה</span>}
                {a.calls > 0 && <span className="tc-badge tc-badge--call">{a.calls === 1 ? "קריאה פתוחה" : `${a.calls} קריאות`}</span>}
              </p>
              {faultText && <p className="tc-alert-text">{faultText}</p>}
              {a.onSite.length > 0 ? (
                <p className="tc-alert-who">
                  <span className="tc-ok">טכנאי באתר:</span>{" "}
                  {a.onSite.map((n) => <button key={n.plate} type="button" className="tc-link" onClick={() => goTo(n.plate)}>{n.name}</button>)}
                </p>
              ) : !a.located ? (
                <p className="tc-alert-who tc-muted">לאתר אין מיקום במפה</p>
              ) : a.nearest.length ? (
                <p className="tc-alert-who">
                  הכי קרוב:{" "}
                  {a.nearest.map((n, i) => (
                    <span key={n.plate}>
                      <button type="button" className="tc-link" onClick={() => goTo(n.plate)}>{n.name}</button>
                      {NBSP}<span className="tc-muted">{n.dist}{n.state ? ` · ${n.state}` : ""}</span>{i < a.nearest.length - 1 ? " · " : ""}
                    </span>
                  ))}
                </p>
              ) : (
                <p className="tc-alert-who tc-muted">אין טכנאי עם מיקום</p>
              )}
              {a.calls > 0 && site && calls?.openSite && (
                <button type="button" className="tc-pill tc-pill--call tc-alert-btn" onClick={() => calls.openSite(site)}>לקריאות</button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function TechCards({ data, error, sites, alerts, onMap, board, onBoardChanged }) {
  const tasks = useTasks();
  const calls = useServiceCalls();
  // "צא ל:" (21/10/2026): רק בפיילוט של לוח הטכנאים, ורק לעורך / מנהל (המסד מחליט — tech_board.can_edit)
  const canSend = board?.enabled === true && board.canEdit === true;
  const techs = useMemo(() => techByPlate(board?.enabled ? board.technicians : null), [board]);
  const siteKeys = useMemo(() => (sites || []).map(siteKey), [sites]);
  const [sending, setSending] = useState(null);       // הרכב שהחלון שלו פתוח
  const [phoneFor, setPhoneFor] = useState(null);     // הרכב שחלון הטלפון שלו פתוח (שלב 2)
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [flash, setFlash] = useState(null);
  const refs = useRef(new Map());
  const timer = useRef(null);
  const now = data?.now;
  const vehicles = useMemo(() => data?.vehicles ?? [], [data]);
  const siteByCode = useMemo(() => new Map((sites || []).map((s) => [s.code, s])), [sites]);
  const counts = useMemo(() => groupCounts(vehicles, now), [vehicles, now]);
  const team = useMemo(() => teamToday(vehicles), [vehicles]);
  const sorted = useMemo(() => sortCards(vehicles, now).filter((v) => matchesCard(v, query)), [vehicles, now, query]);
  const active = sorted.filter((v) => cardGroup(v, now) !== "stale");
  const stale = sorted.filter((v) => cardGroup(v, now) === "stale");
  const shown = filter === "all" ? active : active.filter((v) => cardGroup(v, now) === filter);

  const goTo = (plate) => {
    setFilter("all");
    setQuery("");
    setFlash(plate);
    requestAnimationFrame(() => refs.current.get(plate)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(null), 2400);
  };

  const card = (v) => (
    <TechCard key={v.plate} v={v} now={now} site={v.at_site ? siteByCode.get(v.at_site.code) : null}
      tasks={tasks} calls={calls} onMap={onMap} flash={flash === v.plate}
      tech={techs.get(v.plate) ?? null} canSend={canSend} onSend={setSending} onPhone={setPhoneFor} onBoardChanged={onBoardChanged}
      setRef={(el) => { if (el) refs.current.set(v.plate, el); else refs.current.delete(v.plate); }} />
  );

  return (
    <div className="tc">
      {alerts.length > 0 && <AlertStrip alerts={alerts} siteByCode={siteByCode} calls={calls} goTo={goTo} />}

      {data && (
        <section className="tc-team" aria-label="הצוות היום">
          <div className="tc-team-stat"><b>{kmText(team.km)}</b><span>ק״מ היום</span></div>
          <div className="tc-team-stat"><b>{hhmm(team.driveS)}</b><span>שעות נסיעה (כולם)</span></div>
          <div className="tc-team-stat"><b>{team.visits}</b><span>ביקורים באתרים</span></div>
          <div className="tc-team-stat"><b>{team.sites}</b><span>אתרים שונים</span></div>
          <div className="tc-team-stat"><b>{team.firstMove ? clockText(team.firstMove, now) : "—"}</b><span>היציאה הראשונה</span></div>
          <div className="tc-team-stat"><b>{team.moved}</b><span>יצאו לדרך היום</span></div>
        </section>
      )}

      <div className="tc-tools">
        <div className="tc-filters" role="group" aria-label="סינון">
          {FILTERS.map((k) => {
            const n = k === "all" ? active.length : counts[k];
            if (k !== "all" && !n && filter !== k) return null;
            return (
              <button key={k} type="button" className={`tc-filter tc-f--${k}${filter === k ? " is-on" : ""}`} aria-pressed={filter === k}
                onClick={() => setFilter(k)}>
                {k === "all" ? "הכול" : groupLabel(k, n)} <b>{n}</b>
              </button>
            );
          })}
        </div>
        <input className="tc-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש: שם, מספר רכב, אתר" aria-label="חיפוש טכנאי" />
      </div>

      {!data && !error && <p className="veh-empty">טוען…</p>}
      {error && <p className="veh-warn" role="alert">{error}</p>}
      {data && !shown.length && (
        <p className="veh-empty">{vehicles.length ? "אין טכנאי שמתאים לסינון" : "אין רכבים"}</p>
      )}
      <div className="tc-grid">{shown.map(card)}</div>

      {stale.length > 0 && (
        <details className="tc-stale">
          <summary>לא מדווחים · {stale.length} <span className="tc-muted">— לא שלחו מיקום יותר מיממה</span></summary>
          <div className="tc-grid">{stale.map(card)}</div>
        </details>
      )}

      {sending && canSend && (
        <DispatchDialog vehicle={sending} tech={techs.get(sending.plate) ?? null} sites={sites} siteKeys={siteKeys}
          callsBySite={calls?.bySite ?? null}
          onClose={() => setSending(null)}
          onSent={() => { setSending(null); onBoardChanged?.(); }}
          onStale={onBoardChanged} />
      )}
      {phoneFor && canSend && (
        <TechPhoneDialog vehicle={phoneFor} tech={techs.get(phoneFor.plate) ?? null} now={now}
          onClose={() => setPhoneFor(null)} onChanged={onBoardChanged} />
      )}
    </div>
  );
}
