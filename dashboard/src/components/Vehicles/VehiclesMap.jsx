// components/Vehicles/VehiclesMap.jsx — רכבי הטכנאים על מפה, מאיתוראן (20/10/2026).
//
// בעלת המוצר: "כל מידע אפשרי" → שלב ראשון: מפה חיה, ו"כל מי שמחובר" רואה. החלון נפתח מהכפתור הצף "רכבים" (App),
// כמו לוח הרמזור — מסך מלא, ו-Esc סוגר.
//
// ⚠️ **נטען רק כשפותחים** (React.lazy ב-App): Leaflet ותמונות המפה לא נכנסים לחבילה הראשית ולא נטענים במסכים אחרים.
// ⚠️ **שואל את המסד כל דקה, רק כשהחלון פתוח והלשונית נראית** — הסנכרון מאיתוראן רץ ב-Supabase בכל מקרה, ושאילתה
// ממסך מוסתר הייתה עומס בלי קורא (אותו כלל כמו ספירות הקריאות, 18/10).
// ⚠️ Leaflet בלי עטיפת React: המפה נבנית פעם אחת, והסמנים מתעדכנים במקום (setLatLng / setIcon / setContent) — בנייה
// מחדש בכל סבב הייתה סוגרת חלון פתוח של רכב ומאבדת את הזום של המשתמש.
// ⚠️ המצב ("בנסיעה", "לא מתעדכן", "חונה מאז") נקבע במסד (state, state_since); כאן רק מתורגם (utils/vehicles.js).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fetchVehicles } from "../../services/dataSource";
import {
  ageText, hasPosition, matchesVehicle, placeNames, placeText, powerAlert, rowAge, sortVehicles, stateCounts, stateOf,
  stateText, syncState, vehicleName,
} from "../../utils/vehicles";
import "./Vehicles.css";

const POLL_MS = 60_000;
const ISRAEL = [31.95, 34.85];

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// "לא מתעדכן" / "לא מדווח": המיקום הוא האחרון שידוע, לא בהכרח איפה שהרכב עכשיו
const isOld = (s) => s.tone === "silent" || s.tone === "stale";

function markerHtml(v, s) {
  // חץ לפי כיוון הנסיעה רק כשהרכב באמת בנסיעה (המסד אמר driving); אחרת עיגול
  const arrow = s.tone === "driving" && Number.isFinite(v.heading)
    ? `<span class="veh-arrow" style="transform: rotate(${Number(v.heading)}deg)"></span>` : "";
  return `<span class="veh-marker veh-marker--${s.tone}">${arrow}</span>`;
}

function popupHtml(v, s, now) {
  const places = placeNames(v);
  const old = isOld(s);
  const speed = s.tone === "driving" && Number.isFinite(v.speed) ? ` · ${v.speed} קמ"ש` : "";
  const power = powerAlert(v, now);
  const nav = hasPosition(v) ? `<a href="https://www.google.com/maps?q=${v.lat},${v.lon}" target="_blank" rel="noopener noreferrer">פתיחה במפות</a>` : "";
  return `<div class="veh-pop" dir="rtl">
    <div class="veh-pop-name">${esc(vehicleName(v))}</div>
    <div class="veh-pop-plate">${esc(v.plate)}${v.make || v.model ? ` · ${esc([v.make, v.model].filter(Boolean).join(" "))}` : ""}</div>
    <div class="veh-pop-state veh-tone--${s.tone}">${esc(stateText(v, now))}${speed}</div>
    ${power ? `<div class="veh-power">⚠ ${esc(power.text)}</div>` : ""}
    ${v.address ? `<div>${old ? "מקום אחרון: " : ""}${esc(v.address)}</div>` : ""}
    ${places.length ? `<div>${old ? "אזור אחרון" : "במקום"}: ${esc(places.join(", "))}</div>` : ""}
    ${old ? "" : `<div class="veh-pop-age">עודכן ${esc(ageText(v.located_at, now))}</div>`}
    ${nav}
  </div>`;
}

function SyncLine({ sync, now }) {
  const st = syncState(sync, now);
  if (st === "ok") return <span className="veh-sync">הסנכרון מאיתוראן: {ageText(sync.last_ok_at, now)}</span>;
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

function VehiclesMap({ onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const markers = useRef(new Map());
  const fitted = useRef(false);
  const rowRefs = useRef(new Map());

  const load = useCallback(async () => {
    try { setData(await fetchVehicles()); setError(null); }
    catch (e) { setError(e?.message || "טעינת הרכבים נכשלה"); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // המפה — פעם אחת
  useEffect(() => {
    const map = L.map(mapEl.current, { center: ISRAEL, zoom: 9, zoomControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    mapRef.current = map;
    // ⚠️ החלון משנה גודל (טלפון שמסתובב, רשימה שנפתחת) — בלי זה Leaflet מצייר חצי מפה אפורה
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(mapEl.current);
    const all = markers.current;
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; all.clear(); };
  }, []);

  // הסמנים — מתעדכנים במקום
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;
    const seen = new Set();
    for (const v of data.vehicles) {
      if (!hasPosition(v)) continue;
      seen.add(v.plate);
      const m = stateOf(v, data.now);
      const icon = L.divIcon({ className: "veh-marker-wrap", html: markerHtml(v, m), iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] });
      let mk = markers.current.get(v.plate);
      if (!mk) {
        mk = L.marker([v.lat, v.lon], { icon, title: vehicleName(v), alt: vehicleName(v), keyboard: false, riseOnHover: true }).addTo(map);
        mk.on("click", () => setSelected(v.plate));
        markers.current.set(v.plate, mk);
      } else {
        mk.setLatLng([v.lat, v.lon]);
        mk.setIcon(icon);
      }
      const html = popupHtml(v, m, data.now);
      if (mk.getPopup()) mk.setPopupContent(html); else mk.bindPopup(html, { maxWidth: 260 });
      // שם קבוע רק לרכבים שזזים — 38 תוויות על המפה (12 מהן במשרד) היו מסתירות אותה. "לא מתעדכן" אינו זז.
      const label = m.tone === "driving" || m.tone === "idle";
      if (label && mk.getTooltip()) mk.setTooltipContent(esc(vehicleName(v)));
      else if (label) mk.bindTooltip(esc(vehicleName(v)), { permanent: true, direction: "top", offset: [0, -12], className: "veh-label" });
      else if (mk.getTooltip()) mk.unbindTooltip();
      mk.setZIndexOffset(label ? 1000 : 0);
    }
    for (const [plate, mk] of markers.current) {
      if (!seen.has(plate)) { mk.remove(); markers.current.delete(plate); }
    }
    // התמקדות בכל הרכבים — רק בפעם הראשונה, אחר כך הזום של המשתמש
    if (!fitted.current && seen.size) {
      map.fitBounds(L.latLngBounds([...markers.current.values()].map((x) => x.getLatLng())), { padding: [40, 40], maxZoom: 14 });
      fitted.current = true;
    }
  }, [data]);

  // בחירה (מהרשימה או מהמפה) → המפה עפה לרכב, והשורה נגללת לתצוגה
  useEffect(() => {
    if (!selected) return;
    const mk = markers.current.get(selected);
    if (mk && mapRef.current) {
      mapRef.current.flyTo(mk.getLatLng(), Math.max(mapRef.current.getZoom(), 15), { duration: 0.6 });
      mk.openPopup();
    }
    rowRefs.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const now = data?.now;
  const sorted = useMemo(() => sortVehicles(data?.vehicles ?? [], now), [data, now]);
  const shown = useMemo(() => sorted.filter((v) => matchesVehicle(v, query)), [sorted, query]);
  const counts = useMemo(() => stateCounts(data?.vehicles ?? [], now), [data, now]);

  return (
    <div className="veh-overlay" role="dialog" aria-modal="true" aria-labelledby="veh-title">
      <div className="veh-panel">
        <header className="veh-head">
          <div className="veh-head-main">
            <h2 id="veh-title">רכבים</h2>
            {data && (
              <span className="veh-summary">
                <b className="veh-tone--driving">{counts.driving}</b> בנסיעה ·{" "}
                <b className="veh-tone--idle">{counts.idle}</b> מנוע דולק ·{" "}
                <b>{counts.parking}</b> {counts.parking === 1 ? "חונה" : "חונים"}
                {counts.silent ? <> · <b className="veh-tone--silent">{counts.silent}</b> {counts.silent === 1 ? "לא מתעדכן" : "לא מתעדכנים"}</> : null}
                {counts.stale ? <> · <b className="veh-tone--stale">{counts.stale}</b> {counts.stale === 1 ? "לא מדווח" : "לא מדווחים"}</> : null}
              </span>
            )}
            {data && syncState(data.sync, now) === "ok" && <SyncLine sync={data.sync} now={now} />}
          </div>
          <button type="button" className="veh-close" onClick={onClose} aria-label="סגירה">✕</button>
        </header>

        {data && syncState(data.sync, now) !== "ok" && <SyncLine sync={data.sync} now={now} />}
        {error && <p className="veh-warn" role="alert">{error}</p>}

        <div className="veh-body">
          <div className="veh-map" ref={mapEl} dir="ltr" />
          <aside className="veh-side">
            <input
              className="veh-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="חיפוש: שם, מספר רכב, כתובת"
              aria-label="חיפוש רכב"
            />
            {!data && !error && <p className="veh-empty">טוען…</p>}
            {data && !shown.length && <p className="veh-empty">{data.vehicles.length ? "אין רכב שמתאים לחיפוש" : "אין רכבים"}</p>}
            <ul className="veh-list">
              {shown.map((v) => {
                const m = stateOf(v, now);
                const where = placeText(v, now);
                const power = powerAlert(v, now);
                const age = rowAge(v, now);
                return (
                  <li key={v.plate}>
                    <button
                      type="button"
                      ref={(el) => { if (el) rowRefs.current.set(v.plate, el); else rowRefs.current.delete(v.plate); }}
                      className={`veh-row${selected === v.plate ? " is-selected" : ""}`}
                      onClick={() => setSelected(v.plate)}
                      disabled={!hasPosition(v)}
                    >
                      <span className={`veh-dot veh-dot--${m.tone}`} aria-hidden="true" />
                      <span className="veh-row-main">
                        <span className="veh-row-name">{vehicleName(v)}</span>
                        <span className="veh-row-sub">
                          <span className={`veh-tone--${m.tone}`}>{stateText(v, now)}</span>
                          {m.tone === "driving" && Number.isFinite(v.speed) ? ` · ${v.speed} קמ"ש` : ""}
                          {power ? <> · <span className="veh-power" title={power.text}>⚠ {power.name}</span></> : null}
                          {where ? ` · ${where}` : ""}
                        </span>
                      </span>
                      {age && <span className="veh-row-age">{age}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        </div>
      </div>
    </div>
  );
}

export default VehiclesMap;
