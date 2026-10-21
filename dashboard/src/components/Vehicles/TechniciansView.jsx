// components/Vehicles/TechniciansView.jsx — "טכנאים": כרטיס לכל טכנאי, או מפה שקטה (20–21/10/2026).
//
// בעלת המוצר: "כל מידע אפשרי" → מפה חיה; "רק מיקומים ולאיזה אתרים הם קרובים"; "שהרכבים יקראו לעמוד הזה טכנאים וזה יהיה
// סינון למעלה"; ו-21/10: "אופציה לראות מפה של מיקומים אבל בלי מפה אמיתית מבלבלת מתחת, ואופציה לראות כרטיס לכל טכנאי — איפה
// הוא נמצא, האם הוא באתר (אם הרכב שלו חונה ליד אתר שלנו), ועוד כל פרט וסטטיסטיקה".
//
// ⚠️ שאילתה אחת לשתי התצוגות: vehicles_live_list פעם בדקה, רק כשהתצוגה פתוחה והלשונית נראית. היא מחזירה גם את הסיכום
// היומי לכל רכב (stats) ואת האתרים שצריכים טכנאי (alerts) — הכול מחושב במסד; כאן רק מתורגם.
// ולידה tech_board (21/10/2026, "צא ל:"): מי משויך לאיזה רכב והמשימה הפתוחה. מי שלא בפיילוט מקבל {enabled: false} והמסך
// בלי "צא ל:", כמו קודם.
// ⚠️ נטען רק כשפותחים (React.lazy ב-App): Leaflet והכרטיסים לא נכנסים לחבילה הראשית.
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchTechBoard, fetchVehicles } from "../../services/dataSource";
import { useAuth } from "../../hooks/useAuth";
import { canEdit } from "../../utils/roles";
import { ageText, syncState } from "../../utils/vehicles";
import { alertRows, groupCounts, groupLabel, GROUPS } from "../../utils/techStats";
import FleetListDialog from "./FleetListDialog";
import FleetMap from "./FleetMap";
import TechCards from "./TechCards";
import "./Vehicles.css";
import "./TechCards.css";

const POLL_MS = 60_000;
const VIEW_KEY = "parkomat.techView";
const NBSP = " ";

function readView(uid) {
  try { return localStorage.getItem(`${VIEW_KEY}:${uid}`) === "map" ? "map" : "cards"; } catch { return "cards"; }
}
function writeView(uid, v) {
  try { localStorage.setItem(`${VIEW_KEY}:${uid}`, v); } catch { /* חסום — נשאר לביקור הזה בלבד */ }
}

function SyncLine({ sync, now }) {
  const st = syncState(sync, now);
  if (st === "ok") return <span className="veh-sync">איתוראן: עודכן {ageText(sync.last_ok_at, now)}</span>;
  if (st === "never") return <p className="veh-warn" role="status">הסנכרון עם איתוראן עוד לא הופעל — אין עדיין מיקומים.</p>;
  if (st === "late") {
    return <p className="veh-warn" role="status">לא היה סנכרון מוצלח מאיתוראן {ageText(sync.last_ok_at, now)} — המיקומים עלולים להיות ישנים.</p>;
  }
  return (
    <p className="veh-warn" role="alert">
      הסנכרון האחרון מאיתוראן נכשל: {sync.last_error || "שגיאה לא ידועה"}
      {sync.last_ok_at ? ` — המיקומים מ${ageText(sync.last_ok_at, now)}.` : "."}
    </p>
  );
}

export default function TechniciansView({ sites }) {
  const { user } = useAuth();
  const uid = user?.id ?? "anon";
  const [view, setViewState] = useState(() => readView(uid));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [board, setBoard] = useState(null);          // לוח הטכנאים: מי משויך לאיזה רכב והמשימה הפתוחה ("צא ל:")
  const [boardError, setBoardError] = useState(null);
  const [focusPlate, setFocusPlate] = useState(null);
  const [fleetOpen, setFleetOpen] = useState(false);   // "רכבים ברשימה" — עורך ומנהל (21/10/2026)
  const editable = canEdit(user?.role);

  useEffect(() => { setViewState(readView(uid)); }, [uid]);
  const setView = useCallback((v) => { setViewState(v); writeView(uid, v); }, [uid]);

  // ⚠️ שתי השאילתות יחד, וכל אחת נכשלת לבד: לוח שלא נטען לא מסתיר את המיקומים, ולהפך. לוח שנכשל משאיר את הקודם.
  const load = useCallback(async () => {
    const [veh, brd] = await Promise.allSettled([fetchVehicles(), fetchTechBoard()]);
    if (veh.status === "fulfilled") { setData(veh.value); setError(null); }
    else setError(veh.reason?.message || "טעינת הרכבים נכשלה");
    if (brd.status === "fulfilled") { setBoard(brd.value); setBoardError(null); }
    else setBoardError(brd.reason?.message || "טעינת המשימות נכשלה");
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  const now = data?.now;
  const counts = useMemo(() => groupCounts(data?.vehicles ?? [], now), [data, now]);
  const alerts = useMemo(() => alertRows(data?.alerts, data?.vehicles, now), [data, now]);
  const onMap = useCallback((plate) => { setFocusPlate(plate); setView("map"); }, [setView]);
  const onFocused = useCallback(() => setFocusPlate(null), []);

  const summary = GROUPS.filter((g) => g.key !== "unknown" || counts.unknown > 0).filter((g) => counts[g.key] > 0 || g.key === "site" || g.key === "move");

  return (
    <section className="tv" aria-labelledby="tv-title">
      <header className="tv-head">
        <div className="tv-title-row">
          <h2 id="tv-title">טכנאים</h2>
          <div className="tv-seg" role="group" aria-label="תצוגה">
            <button type="button" className={view === "cards" ? "is-on" : ""} aria-pressed={view === "cards"} onClick={() => setView("cards")}>כרטיסים</button>
            <button type="button" className={view === "map" ? "is-on" : ""} aria-pressed={view === "map"} onClick={() => setView("map")}>מפה</button>
          </div>
          {editable && (
            <button type="button" className="tv-fleet-btn" onClick={() => setFleetOpen(true)} aria-haspopup="dialog">רכבים ברשימה</button>
          )}
        </div>
        {data && (
          <p className="tv-summary">
            {summary.map((g, i) => (
              <span key={g.key} className="tv-sum-item">
                <b className={`tv-tone--${g.key}`}>{counts[g.key]}</b>{NBSP}{groupLabel(g.key, counts[g.key])}{i < summary.length - 1 ? `${NBSP}·` : ""}{" "}
              </span>
            ))}
            {syncState(data.sync, now) === "ok" && <SyncLine sync={data.sync} now={now} />}
          </p>
        )}
      </header>

      {data && syncState(data.sync, now) !== "ok" && <SyncLine sync={data.sync} now={now} />}
      {data?.sync?.stats_error && (
        <p className="veh-warn" role="status">הסטטיסטיקה של היום לא התעדכנה בסנכרון האחרון — המיקומים כן. ({data.sync.stats_error})</p>
      )}

      {/* ⚠️ גם כשהטעינה הראשונה נכשלה (board עדיין null): בלי השורה, "צא ל:" פשוט לא מופיע, בלי שום סימן למה.
          מי שלא בפיילוט אינו "כשל" — הוא מקבל {enabled: false} ואין שורה. */}
      {boardError && board?.enabled !== false && (
        <p className="veh-warn" role="status">
          {board ? "המשימות של הטכנאים לא התעדכנו — מוצג המצב מהטעינה הקודמת." : "המשימות של הטכנאים לא נטענו — מנסה שוב בעוד דקה."} ({boardError})
        </p>
      )}

      {view === "cards"
        ? <TechCards data={data} error={error} sites={sites} onMap={onMap} board={board} onBoardChanged={load} />
        : <FleetMap data={data} error={error} onReload={load} focusPlate={focusPlate} onFocused={onFocused} alerts={alerts} />}
      {fleetOpen && <FleetListDialog onClose={() => setFleetOpen(false)} onSaved={load} />}
    </section>
  );
}
