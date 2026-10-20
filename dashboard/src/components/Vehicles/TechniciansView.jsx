// components/Vehicles/TechniciansView.jsx — "טכנאים": רכבי הטכנאים מאיתוראן על מפה ורשימה, ולאיזה אתרים הם קרובים (20/10/2026).
//
// בעלת המוצר: "כל מידע אפשרי" → מפה חיה ש"כל מי שמחובר" רואה; "רק מיקומים ולאיזה אתרים הם קרובים"; ואחר כך: "שהרכבים יקראו
// לעמוד הזה טכנאים וזה יהיה סינון למעלה לצד הקריאות פתוחות". לכן זה אינו חלון צף יותר: האריח "טכנאים" בכותרת מחליף את כרטיסי
// האתרים בתצוגה הזו, והכותרת נשארת מעליה (App → renderView). אין ✕ ואין Esc שסוגר — חוזרים בלחיצה על אריח אחר.
//
// ⚠️ **נטען רק כשפותחים** (React.lazy ב-App): Leaflet ותמונות המפה לא נכנסים לחבילה הראשית.
// ⚠️ **שואל את המסד כל דקה, רק כשהתצוגה פתוחה והלשונית נראית** — הסנכרון מאיתוראן רץ ב-Supabase בכל מקרה.
// ⚠️ Leaflet בלי עטיפת React: המפה נבנית פעם אחת, והסמנים מתעדכנים במקום — בנייה מחדש הייתה סוגרת חלון פתוח ומאבדת זום.
// ⚠️ המצב ("בנסיעה", "לא מתעדכן", "חונה מאז") והאתרים הקרובים נקבעים במסד (state, state_since, near); כאן רק מתורגמים.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fetchVehicles, fetchSiteLocations, saveSiteLocation } from "../../services/dataSource";
import { useAuth } from "../../hooks/useAuth";
import { canEdit } from "../../utils/roles";
import {
  ageText, hasPosition, matchesVehicle, nearList, nearText, placeNames, placeText, powerAlert, rowAge, sortVehicles, stateCounts, stateOf,
  stateText, syncState, vehicleName, SITE_GEO, siteGeoKey, siteGeoCounts, sitesNeedingCheck,
} from "../../utils/vehicles";
import { createSiteLayer } from "./siteLayer";
import "./Vehicles.css";

const POLL_MS = 60_000;
const ISRAEL = [31.95, 34.85];
const NBSP = " ";

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
  const near = nearList(v);
  const nav = hasPosition(v) ? `<a href="https://www.google.com/maps?q=${v.lat},${v.lon}" target="_blank" rel="noopener noreferrer">פתיחה במפות</a>` : "";
  // ⚠️ מילה אחת לכל שדה, בשורה ובחלון: "כתובת" = מה שאיתוראן כתבו; "מקום" = האזור באיתוראן (הסקירה, 20/10)
  return `<div class="veh-pop" dir="rtl">
    <div class="veh-pop-name">${esc(vehicleName(v))}</div>
    <div class="veh-pop-plate">${esc(v.plate)}${v.make || v.model ? ` · ${esc([v.make, v.model].filter(Boolean).join(" "))}` : ""}</div>
    <div class="veh-pop-state veh-tone--${s.tone}">${esc(stateText(v, now))}${speed}</div>
    ${power ? `<div class="veh-power">⚠ ${esc(power.text)}</div>` : ""}
    ${v.address ? `<div>${old ? "כתובת אחרונה: " : ""}${esc(v.address)}</div>` : ""}
    ${places.length ? `<div>${old ? "מקום אחרון" : "במקום"}: ${esc(places.join(", "))}</div>` : ""}
    ${near.length ? `<div class="veh-pop-near">אתרים קרובים: ${near.map((n) => `${esc(n.label)}${NBSP}·${NBSP}${esc(n.dist)}`).join(", ")}</div>` : ""}
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

/** שורת הסיכום: כל פריט ("4 בנסיעה") לא נשבר באמצע, והנקודה צמודה לפריט שלפניה (הסקירה: בטלפון "לא" נשאר בשורה אחת ו"מתעדכנים" בבאה) */
function Summary({ counts }) {
  const items = [
    { k: "driving", n: counts.driving, label: "בנסיעה", show: true },
    { k: "idle", n: counts.idle, label: "עם מנוע דולק", show: true },
    { k: "parking", n: counts.parking, label: counts.parking === 1 ? "חונה" : "חונים", show: true },
    { k: "silent", n: counts.silent, label: counts.silent === 1 ? "לא מתעדכן" : "לא מתעדכנים", show: counts.silent > 0 },
    { k: "unknown", n: counts.unknown, label: "לא ידוע", show: counts.unknown > 0 },
    { k: "stale", n: counts.stale, label: counts.stale === 1 ? "לא מדווח" : "לא מדווחים", show: counts.stale > 0 },
  ].filter((x) => x.show);
  return (
    <span className="veh-summary">
      {items.map((x, i) => (
        <Fragment key={x.k}>
          <span className="veh-sum-item"><b className={`veh-tone--${x.k === "stale" ? "stale" : x.k}`}>{x.n}</b>{NBSP}{x.label}{i < items.length - 1 ? `${NBSP}·` : ""}</span>
          {i < items.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>
  );
}

function TechniciansView() {
  const { user } = useAuth();
  const editable = canEdit(user?.role);
  const editableRef = useRef(editable);
  editableRef.current = editable;

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [showSites, setShowSites] = useState(false);
  const [tab, setTab] = useState("tech");             // "tech" / "sites" — הלשונית בצד, כשהאתרים מוצגים
  const [siteList, setSiteList] = useState(null);
  const [siteError, setSiteError] = useState(null);
  const [picking, setPicking] = useState(null);       // אתר בלי מיקום שמסמנים עכשיו
  const [height, setHeight] = useState(null);
  const rootRef = useRef(null);
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const siteLayer = useRef(null);
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

  // הגובה: מה שנשאר במסך מתחת לכותרת. במסך צר — המפה למעלה והרשימה מתחתיה, בגובה טבעי (CSS)
  useLayoutEffect(() => {
    const fit = () => {
      const top = rootRef.current?.getBoundingClientRect().top ?? 0;
      setHeight(Math.max(460, Math.round(window.innerHeight - Math.max(0, top) - 12)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Esc — רק מבטל סימון של אתר (התצוגה עצמה לא נסגרת: חוזרים בלחיצה על אריח בכותרת)
  useEffect(() => {
    if (!picking) return undefined;
    const onKey = (e) => { if (e.key === "Escape") { siteLayer.current?.cancelPick(); setPicking(null); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [picking]);

  // שמירת מיקום של אתר (עורך): המסד בודק הרשאה ומסך ישן; אחרי שמירה — הרשימה מתעדכנת, והאתרים הקרובים נטענים מחדש
  const onSaveSite = useCallback(async (site, lat, lon) => {
    const saved = await saveSiteLocation(site.code, lat, lon, site.set_at ?? "");
    setSiteList((list) => (list || []).map((s) => (s.code === site.code ? { ...s, ...saved } : s)));
    setPicking((p) => (p && p.code === site.code ? null : p));
    load();
    return saved;
  }, [load]);

  // המפה — פעם אחת
  useEffect(() => {
    const map = L.map(mapEl.current, { center: ISRAEL, zoom: 9, zoomControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    mapRef.current = map;
    siteLayer.current = createSiteLayer(map, { canEdit: () => editableRef.current, onSave: onSaveSite });
    // ⚠️ התצוגה משנה גודל (טלפון שמסתובב, לשונית שנפתחת) — בלי זה Leaflet מצייר חצי מפה אפורה
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(mapEl.current);
    const all = markers.current;
    return () => { ro.disconnect(); siteLayer.current?.destroy(); siteLayer.current = null; map.remove(); mapRef.current = null; all.clear(); };
  }, [onSaveSite]);

  // שכבת האתרים: נטענת בפעם הראשונה שמדליקים, ומתעדכנת אחרי כל שמירה
  useEffect(() => {
    if (!showSites) { siteLayer.current?.hide(); setPicking(null); return; }
    siteLayer.current?.show();
    if (siteList) return;
    let alive = true;
    fetchSiteLocations()
      .then((list) => { if (alive) { setSiteList(list); setSiteError(null); } })
      .catch((e) => { if (alive) setSiteError(e?.message || "טעינת מיקומי האתרים נכשלה"); });
    return () => { alive = false; };
  }, [showSites, siteList]);

  useEffect(() => { if (siteList) siteLayer.current?.setSites(siteList); }, [siteList]);

  // הסמנים של הרכבים — מתעדכנים במקום
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
      if (mk.getPopup()) mk.setPopupContent(html); else mk.bindPopup(html, { maxWidth: 280 });
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
    // התמקדות ברכבים — רק בפעם הראשונה, אחר כך הזום של המשתמש
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
  const toCheck = useMemo(() => sitesNeedingCheck(siteList), [siteList]);
  const geo = useMemo(() => siteGeoCounts(siteList), [siteList]);

  const openSite = (s) => {
    if (siteGeoKey(s) !== "none") { siteLayer.current?.focus(s.code); return; }
    if (!editable) return;
    siteLayer.current?.startPick(s);
    setPicking(s);
  };

  return (
    <section className="veh-panel" ref={rootRef} style={height ? { "--veh-h": `${height}px` } : undefined} aria-labelledby="veh-title">
      <header className="veh-head">
        <div className="veh-head-main">
          <h2 id="veh-title">טכנאים</h2>
          {data && <Summary counts={counts} />}
          {data && syncState(data.sync, now) === "ok" && <SyncLine sync={data.sync} now={now} />}
        </div>
        <button type="button" className={`veh-sites-btn${showSites ? " is-on" : ""}`} aria-pressed={showSites}
          onClick={() => { setShowSites((v) => !v); setTab((t) => (showSites ? "tech" : t)); }}>
          אתרים במפה
        </button>
      </header>

      {data && syncState(data.sync, now) !== "ok" && <SyncLine sync={data.sync} now={now} />}
      {error && <p className="veh-warn" role="alert">{error}</p>}
      {picking && (
        <p className="veh-pick" role="status">
          לחצו על המפה במקום של <b>{picking.name}</b>, ואז "שמירה כאן".
          <button type="button" onClick={() => { siteLayer.current?.cancelPick(); setPicking(null); }}>ביטול</button>
        </p>
      )}

      <div className="veh-body">
        <div className="veh-map" ref={mapEl} dir="ltr" />
        <aside className="veh-side">
          {showSites && (
            <div className="veh-tabs" role="tablist" aria-label="רשימה">
              <button type="button" role="tab" aria-selected={tab === "tech"} className={tab === "tech" ? "is-on" : ""} onClick={() => setTab("tech")}>טכנאים</button>
              <button type="button" role="tab" aria-selected={tab === "sites"} className={tab === "sites" ? "is-on" : ""} onClick={() => setTab("sites")}>
                אתרים לבדיקה{siteList ? ` · ${toCheck.length}` : ""}
              </button>
            </div>
          )}

          {showSites && tab === "sites" ? (
            <div className="veh-sites">
              {siteError && <p className="veh-warn" role="alert">{siteError}</p>}
              {!siteList && !siteError && <p className="veh-empty">טוען אתרים…</p>}
              {siteList && (
                <p className="veh-sites-sum">
                  {geo.house} לפי הכתובת · {geo.street + geo.area} משוערים · {geo.manual} מאושרים · {geo.none} בלי מיקום
                </p>
              )}
              {siteList && !editable && toCheck.length > 0 && <p className="veh-empty">עורך יכול לאשר או לתקן מיקום על המפה.</p>}
              {siteList && !toCheck.length && <p className="veh-empty">לכל האתרים יש מיקום מדויק.</p>}
              <ul className="veh-list">
                {toCheck.map((s) => {
                  const key = siteGeoKey(s);
                  return (
                    <li key={s.code}>
                      <button type="button" className={`veh-row veh-site-row${picking?.code === s.code ? " is-selected" : ""}`}
                        onClick={() => openSite(s)} disabled={key === "none" && !editable}>
                        <span className={`veh-site veh-site--${key}`} aria-hidden="true" />
                        <span className="veh-row-main">
                          <span className="veh-row-name">{s.name}</span>
                          <span className="veh-row-sub">{s.code} · {SITE_GEO[key].label}{key === "none" && editable ? " · סימון על המפה" : ""}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <>
              <input
                className="veh-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="חיפוש: שם, מספר רכב, כתובת, אתר"
                aria-label="חיפוש טכנאי"
              />
              {!data && !error && <p className="veh-empty">טוען…</p>}
              {data && !shown.length && <p className="veh-empty">{data.vehicles.length ? "אין טכנאי שמתאים לחיפוש" : "אין רכבים"}</p>}
              <ul className="veh-list">
                {shown.map((v) => {
                  const m = stateOf(v, now);
                  const st = stateText(v, now);
                  const where = placeText(v, now);
                  const power = powerAlert(v, now);
                  const age = rowAge(v, now);
                  const near = nearText(v);
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
                            {/* המילה בצבע המצב; "מאז 17:45" בצבע הטקסט המשני — הצבע לבדו לא עמד ב-4.5:1 בשורה מסומנת */}
                            <span className={`veh-tone--${m.tone}`}>{m.label}</span>{st.length > m.label.length ? st.slice(m.label.length) : ""}
                            {m.tone === "driving" && Number.isFinite(v.speed) ? ` · ${v.speed} קמ"ש` : ""}
                            {power ? <> · <span className="veh-power" title={power.text}>⚠ {power.name}</span></> : null}
                            {where ? ` · ${where}` : ""}
                          </span>
                          {near && <span className="veh-row-near">{near}</span>}
                        </span>
                        {age && <span className="veh-row-age">{age}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}


export default TechniciansView;
