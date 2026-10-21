// components/Vehicles/FleetMap.jsx — "טכנאים" › מפה: איפה כל טכנאי, על מפה שקטה (20–21/10/2026).
//
// בעלת המוצר (21/10): "מפה של מיקומים, אבל בלי מפה אמיתית מבלבלת מתחת". לכן ברירת המחדל היא **בלי שכבת רחובות**: רקע
// שקט, האתרים שלנו כנקודות אפורות קטנות (הם נקודות הייחוס), שמות הערים במרכז האתרים שלהן, האתרים שצריכים טכנאי (תקלה /
// קריאה פתוחה) בטבעת אדומה או כתומה, והטכנאים בעיגולים עם ראשי תיבות. המתג "רחובות" מחזיר את מפת OpenStreetMap כשצריך —
// ובפרט כדי לסמן או להזיז מיקום של אתר ("אתרים במפה" מדליק אותו לבד: אי אפשר לסמן כניסה לחניון בלי רחובות).
//
// ⚠️ הנתונים מגיעים מהתצוגה שמעליה (TechniciansView שואלת את vehicles_live_list פעם בדקה) — כאן אין שאילתה של רכבים.
// ⚠️ Leaflet בלי עטיפת React: המפה נבנית פעם אחת, והסמנים מתעדכנים במקום — בנייה מחדש הייתה סוגרת חלון פתוח ומאבדת זום.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fetchSiteLocations, saveSiteLocation } from "../../services/dataSource";
import { useAuth } from "../../hooks/useAuth";
import { canEdit } from "../../utils/roles";
import {
  ageText, hasPosition, matchesVehicle, nearList, placeNames, powerAlert, rowAge, sortVehicles, stateOf, stateText,
  vehicleName, SITE_GEO, siteGeoKey, siteGeoCounts, sitesNeedingCheck,
} from "../../utils/vehicles";
import { cardGroup, whereInfo } from "../../utils/techStats";
import { corePoints, declutter, placeLabels } from "../../utils/declutter";
import { parseSiteAddress } from "../../../../shared/site-address.mjs";
import { createSiteLayer } from "./siteLayer";
import "./Vehicles.css";

const ISRAEL = [31.95, 34.85];
const NBSP = " ";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// "לא מתעדכן" / "לא מדווח": המיקום הוא האחרון שידוע, לא בהכרח איפה שהרכב עכשיו
const isOld = (s) => s.tone === "silent" || s.tone === "stale";

// תווית לכל טכנאי (21/10/2026, "שלא יהיו אחד על השני"): נקודה בצבע המצב + השם, וקוד האתר כשהוא באתר. התווית ממורכזת על
// המיקום שלה (CSS), כדי שהפריסה תעבוד על המרכז והמידות שלה במסך.
// חץ לפי כיוון הנסיעה רק כשהרכב באמת בנסיעה (המסד אמר driving) — מסתובב סביב מרכז הנקודה ויוצא ממנה.
function pillHtml(v, s, site) {
  const arrow = s.tone === "driving" && Number.isFinite(v.heading)
    ? `<i class="veh-pill-arrow" style="transform: translate(-50%, -50%) rotate(${Number(v.heading)}deg) translateY(-9px)"></i>` : "";
  const tone = site ? "site" : s.tone;
  return `<span class="veh-pill veh-pill--${tone}${s.tone === "silent" ? " is-silent" : ""}${s.tone === "stale" ? " is-stale" : ""}">`
    + `<span class="veh-pill-dot">${arrow}</span><span class="veh-pill-name">${esc(vehicleName(v))}</span>`
    + `${site ? `<span class="veh-pill-site">${esc(site.code)}</span>` : ""}</span>`;
}
const TONE_COLOR = { driving: "#15803d", idle: "#b45309", parking: "#2563eb", silent: "#6b7280", stale: "#9ca3af", unknown: "#9ca3af", site: "#0f766e" };
const RANK = { site: 0, move: 0, park: 1, silent: 2, unknown: 2, stale: 3 };

function popupHtml(v, s, now) {
  const places = placeNames(v);
  const old = isOld(s);
  const speed = s.tone === "driving" && Number.isFinite(v.speed) ? ` · ${v.speed} קמ"ש` : "";
  const power = powerAlert(v, now);
  const near = nearList(v);
  const where = whereInfo(v, now);
  const nav = hasPosition(v) ? `<a href="https://www.google.com/maps?q=${v.lat},${v.lon}" target="_blank" rel="noopener noreferrer">פתיחה במפות</a>` : "";
  // ⚠️ מילה אחת לכל שדה, בשורה ובחלון: "כתובת" = מה שאיתוראן כתבו; "מקום" = האזור באיתוראן (הסקירה, 20/10)
  return `<div class="veh-pop" dir="rtl">
    <div class="veh-pop-name">${esc(vehicleName(v))}</div>
    <div class="veh-pop-plate">${esc(v.plate)}${v.make || v.model ? ` · ${esc([v.make, v.model].filter(Boolean).join(" "))}` : ""}</div>
    ${where.group === "site" ? `<div class="veh-pop-site">${esc(where.title)}${where.sub.length ? ` · ${esc(where.sub.join(" · "))}` : ""}</div>` : ""}
    <div class="veh-pop-state veh-tone--${s.tone}">${esc(stateText(v, now))}${speed}</div>
    ${power ? `<div class="veh-power">⚠ ${esc(power.text)}</div>` : ""}
    ${v.address ? `<div>${old ? "כתובת אחרונה: " : ""}${esc(v.address)}</div>` : ""}
    ${places.length ? `<div>${old ? "מקום אחרון" : "במקום"}: ${esc(places.join(", "))}</div>` : ""}
    ${near.length && where.group !== "site" ? `<div class="veh-pop-near">אתרים קרובים: ${near.map((n) => `${esc(n.label)}${NBSP}·${NBSP}${esc(n.dist)}`).join(", ")}</div>` : ""}
    ${old ? "" : `<div class="veh-pop-age">עודכן ${esc(ageText(v.located_at, now))}</div>`}
    ${nav}
  </div>`;
}

/** שמות הערים — במרכז האתרים של כל עיר (שניים לפחות), כנקודת ייחוס במפה בלי רחובות. */
function cityLabels(sites) {
  const by = new Map();
  for (const s of sites || []) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const city = parseSiteAddress(s.name).city;
    if (!city) continue;
    const c = by.get(city) ?? { n: 0, lat: 0, lon: 0 };
    by.set(city, { n: c.n + 1, lat: c.lat + s.lat, lon: c.lon + s.lon });
  }
  return [...by].filter(([, c]) => c.n >= 2).map(([city, c]) => ({ city, lat: c.lat / c.n, lon: c.lon / c.n, n: c.n }));
}

export default function FleetMap({ data, error, onReload, focusPlate, onFocused, alerts }) {
  const { user } = useAuth();
  const editable = canEdit(user?.role);
  const editableRef = useRef(editable);
  editableRef.current = editable;

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [showSites, setShowSites] = useState(false);
  // ⚠️ המפה על כל הדף (21/10/2026, בעלת המוצר: "כדי שיהיה יותר ברור תעשה את זה על כל הדף יותר בגדול"): הרשימה בצד מוסתרת
  // כברירת מחדל, ונפתחת ב"רשימה" — או לבד, כשעובדים על מיקומי אתרים (הלשונית "אתרים לבדיקה" גרה בה).
  const [showList, setShowList] = useState(false);
  const [streets, setStreets] = useState(false);
  const [tab, setTab] = useState("tech");             // "tech" / "sites" — הלשונית בצד, כשהאתרים מוצגים
  const [siteList, setSiteList] = useState(null);
  const [siteError, setSiteError] = useState(null);
  const [picking, setPicking] = useState(null);       // אתר בלי מיקום שמסמנים עכשיו
  const [height, setHeight] = useState(null);
  const rootRef = useRef(null);
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const tiles = useRef(null);
  const refLayer = useRef(null);
  const siteLayer = useRef(null);
  const markers = useRef(new Map());
  const truePos = useRef(new Map());     // plate → [lat, lon] — המקום האמיתי (התווית עצמה עלולה לזוז ממנו)
  const meta = useRef(new Map());        // plate → { rank, color }
  const leaders = useRef(null);
  const cityMarks = useRef([]);
  const fitted = useRef(false);
  const rowRefs = useRef(new Map());

  // ⚠️ "שלא יהיו אחד על השני": אחרי כל זום, ריענון או שינוי גודל — כל תווית במקום הפנוי הקרוב לנקודה האמיתית שלה
  // (utils/declutter.js), ופס דק מהתווית לנקודה כשהיא זזה. שמות ערים שמתנגשים בתווית או בעיר גדולה יותר — מוסתרים.
  const relayout = useCallback(() => {
    const map = mapRef.current;
    if (!map || !leaders.current) return;
    const items = [];
    for (const [plate, mk] of markers.current) {
      const ll = truePos.current.get(plate);
      const el = mk.getElement()?.querySelector(".veh-pill");
      if (!ll || !el) continue;
      const p = map.latLngToContainerPoint(ll);
      items.push({ key: plate, x0: p.x, y0: p.y, w: el.offsetWidth, h: el.offsetHeight, rank: meta.current.get(plate)?.rank ?? 2 });
    }
    const size = map.getSize();
    const out = declutter(items, { bounds: { x0: 4, y0: 4, x1: size.x - 4, y1: size.y - 4 } });
    leaders.current.clearLayers();
    for (const it of out) {
      const mk = markers.current.get(it.key);
      const at = map.containerPointToLatLng([it.x, it.y]);
      mk.setLatLng(at);
      if (Math.hypot(it.x - it.x0, it.y - it.y0) > 6) {
        const ll = truePos.current.get(it.key);
        L.polyline([ll, at], { weight: 1.5, color: "#64748b", opacity: 0.75, interactive: false, className: "veh-leader" }).addTo(leaders.current);
        L.circleMarker(ll, { radius: 3.5, weight: 1.5, color: "#ffffff", fillColor: meta.current.get(it.key)?.color ?? "#64748b",
          fillOpacity: 1, interactive: false, className: "veh-true" }).addTo(leaders.current);
      }
    }
    const labels = [];
    for (const c of cityMarks.current) {
      const el = c.marker.getElement()?.querySelector(".veh-city");
      if (!el) continue;
      const p = map.latLngToContainerPoint(c.latlng);
      labels.push({ key: c.city, x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight, weight: c.n });
    }
    const keep = placeLabels(labels, out.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h })));
    for (const c of cityMarks.current) {
      const el = c.marker.getElement();
      if (el) el.style.visibility = keep.has(c.city) ? "" : "hidden";
    }
  }, []);

  // כל הטכנאים שיש להם מיקום — או רק הליבה (התצוגה הראשונה: גוש דן ממלא את המסך, לא אשקלון וירושלים)
  const fitFleet = useCallback((all, animate = true) => {
    const map = mapRef.current;
    const pts = [...truePos.current.values()].map(([lat, lon]) => ({ lat, lon }));
    if (!map || !pts.length) return;
    const use = all ? pts : corePoints(pts);
    map.fitBounds(L.latLngBounds(use.map((p) => [p.lat, p.lon])), { padding: [50, 50], maxZoom: 14, animate });
  }, []);

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

  // Esc — רק מבטל סימון של אתר
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
    onReload?.();
    return saved;
  }, [onReload]);

  // המפה — פעם אחת. ⚠️ בלי שכבת רחובות כברירת מחדל (למטה); refLayer = האתרים כנקודות ייחוס, הערים והאתרים שצריכים טכנאי.
  useEffect(() => {
    const map = L.map(mapEl.current, { center: ISRAEL, zoom: 9, zoomControl: true });
    tiles.current = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    refLayer.current = L.layerGroup().addTo(map);
    leaders.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    siteLayer.current = createSiteLayer(map, { canEdit: () => editableRef.current, onSave: onSaveSite });
    map.on("zoomend", relayout);
    // ⚠️ התצוגה משנה גודל (טלפון שמסתובב, לשונית שנפתחת) — בלי זה Leaflet מצייר חצי מפה אפורה
    // ⚠️ בפריים הבא ולא בתוך ההתראה: הפריסה מזיזה סמנים, ושינוי בתוך ה-callback יורה "ResizeObserver loop completed"
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { map.invalidateSize(); relayout(); }); });
    ro.observe(mapEl.current);
    const all = markers.current;
    return () => {
      // ⚠️ באג מוכר ב-Leaflet: אחרי זום מונפש מתוזמנת קריאה בעוד 250 מ"ש (_onZoomTransitionEnd), והיא רצה גם אחרי
      // map.remove() ונופלת על "_leaflet_pos" — מי שיוצא מהמפה באמצע זום קיבל שגיאה (נמצא בבדיקת הדפדפן). כך היא חוזרת מיד.
      map._animatingZoom = false;
      cancelAnimationFrame(raf); ro.disconnect(); map.off("zoomend", relayout); siteLayer.current?.destroy(); siteLayer.current = null;
      map.remove(); mapRef.current = null; leaders.current = null; all.clear();
    };
  }, [onSaveSite, relayout]);

  useEffect(() => {
    const map = mapRef.current, t = tiles.current;
    if (!map || !t) return;
    if (streets && !map.hasLayer(t)) t.addTo(map);
    if (!streets && map.hasLayer(t)) map.removeLayer(t);
  }, [streets]);

  // רשימת האתרים — פעם אחת: נקודות הייחוס של המפה, שמות הערים, ושכבת העריכה ("אתרים במפה")
  useEffect(() => {
    let alive = true;
    fetchSiteLocations()
      .then((list) => { if (alive) { setSiteList(list); setSiteError(null); } })
      .catch((e) => { if (alive) setSiteError(e?.message || "טעינת מיקומי האתרים נכשלה"); });
    return () => { alive = false; };
  }, []);

  useEffect(() => { if (siteList) siteLayer.current?.setSites(siteList); }, [siteList]);

  useEffect(() => {
    if (!showSites) { siteLayer.current?.hide(); setPicking(null); return; }
    siteLayer.current?.show();
    setStreets(true);
  }, [showSites]);

  // שכבת הייחוס: אתרים (נקודות), ערים (שם), אתרים שצריכים טכנאי (טבעת). נבנית מחדש כשהרשימה או ההתראות משתנות.
  useEffect(() => {
    const g = refLayer.current;
    if (!g) return;
    g.clearLayers();
    if (!siteList) return;
    const need = new Map((alerts || []).map((a) => [a.code, a]));
    cityMarks.current = cityLabels(siteList).map((c) => ({
      city: c.city, n: c.n, latlng: L.latLng(c.lat, c.lon),
      marker: L.marker([c.lat, c.lon], {
        interactive: false, keyboard: false, zIndexOffset: -1000,
        icon: L.divIcon({ className: "veh-city-wrap", html: `<span class="veh-city">${esc(c.city)}</span>`, iconSize: [0, 0] }),
      }).addTo(g),
    }));
    for (const s of siteList) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      const a = need.get(s.code);
      const dot = L.circleMarker([s.lat, s.lon], a
        ? { radius: 8, weight: 3, color: a.fault ? "#dc2626" : "#d97706", fillColor: a.fault ? "#fecaca" : "#fde68a", fillOpacity: 0.9, className: `veh-ref veh-ref--${a.fault ? "fault" : "call"}` }
        : { radius: 3, weight: 0, fillColor: "#64748b", fillOpacity: 0.45, className: "veh-ref" });
      const near = a?.nearest?.[0];
      const label = a
        ? `${a.fault ? "בתקלה" : a.calls > 1 ? `${a.calls} קריאות פתוחות` : "קריאה פתוחה"} · ${s.name}${near ? ` — הכי קרוב: ${near.name} · ${near.dist}` : ""}`
        : s.name;
      dot.bindTooltip(esc(label), { direction: "top", className: "veh-ref-tip" });
      dot.addTo(g);
    }
    relayout();
  }, [siteList, alerts, relayout]);

  // הסמנים של הרכבים — מתעדכנים במקום
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;
    const seen = new Set();
    for (const v of data.vehicles) {
      if (!hasPosition(v)) continue;
      seen.add(v.plate);
      const m = stateOf(v, data.now);
      const group = cardGroup(v, data.now);
      const site = group === "site" ? v.at_site : null;
      truePos.current.set(v.plate, [v.lat, v.lon]);
      meta.current.set(v.plate, { rank: RANK[group] ?? 2, color: TONE_COLOR[site ? "site" : m.tone] ?? "#64748b" });
      const icon = L.divIcon({ className: "veh-pill-wrap", html: pillHtml(v, m, site), iconSize: [0, 0], iconAnchor: [0, 0], popupAnchor: [0, -12] });
      let mk = markers.current.get(v.plate);
      if (!mk) {
        mk = L.marker([v.lat, v.lon], { icon, title: vehicleName(v), alt: vehicleName(v), keyboard: false, riseOnHover: true }).addTo(map);
        mk.on("click", () => setSelected(v.plate));
        markers.current.set(v.plate, mk);
      } else {
        mk.setIcon(icon);
      }
      const html = popupHtml(v, m, data.now);
      if (mk.getPopup()) mk.setPopupContent(html); else mk.bindPopup(html, { maxWidth: 280 });
      mk.setZIndexOffset(group === "site" || group === "move" || group === "idle" ? 1000 : group === "stale" ? -500 : 0);
    }
    for (const [plate, mk] of markers.current) {
      if (!seen.has(plate)) { mk.remove(); markers.current.delete(plate); truePos.current.delete(plate); meta.current.delete(plate); }
    }
    // התמקדות בליבת הצי — רק בפעם הראשונה, אחר כך הזום של המשתמש. ⚠️ fitBounds בלי שינוי זום לא יורה zoomend — ולכן
    // הפריסה נקראת גם כאן.
    if (!fitted.current && seen.size) { fitFleet(false, false); fitted.current = true; }
    relayout();
  }, [data, fitFleet, relayout]);

  // בחירה (מהרשימה או מהמפה) → המפה עפה לרכב, והשורה נגללת לתצוגה
  useEffect(() => {
    if (!selected) return;
    const mk = markers.current.get(selected);
    const ll = truePos.current.get(selected);
    if (mk && ll && mapRef.current) {
      mapRef.current.flyTo(ll, Math.max(mapRef.current.getZoom(), 15), { duration: 0.6 });
      mapRef.current.once("moveend", () => mk.openPopup());
    }
    rowRefs.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // "במפה" מכרטיס טכנאי — בוחרים אותו כשהסמן שלו כבר קיים
  useEffect(() => {
    if (!focusPlate || !data) return;
    if (markers.current.has(focusPlate)) { fitted.current = true; setSelected(focusPlate); onFocused?.(); }
  }, [focusPlate, data, onFocused]);

  const now = data?.now;
  const sorted = useMemo(() => sortVehicles(data?.vehicles ?? [], now), [data, now]);
  const shown = useMemo(() => sorted.filter((v) => matchesVehicle(v, query)), [sorted, query]);
  const toCheck = useMemo(() => sitesNeedingCheck(siteList), [siteList]);
  const geo = useMemo(() => siteGeoCounts(siteList), [siteList]);

  const openSite = (s) => {
    if (siteGeoKey(s) !== "none") { siteLayer.current?.focus(s.code); return; }
    if (!editable) return;
    setStreets(true);
    siteLayer.current?.startPick(s);
    setPicking(s);
  };

  return (
    <div className="veh-panel" ref={rootRef} style={height ? { "--veh-h": `${height}px` } : undefined}>
      <div className="veh-toolbar">
        <span className="veh-legend" aria-hidden="true">
          <i className="veh-lg veh-lg--driving" /> בנסיעה
          <i className="veh-lg veh-lg--site" /> באתר
          <i className="veh-lg veh-lg--parking" /> חונה
          <i className="veh-lg veh-lg--fault" /> צריך טכנאי
        </span>
        <span className="veh-toolbar-btns">
          <button type="button" className={`veh-sites-btn veh-list-btn${showList ? " is-on" : ""}`} aria-pressed={showList}
            onClick={() => setShowList((x) => !x)}>
            רשימה
          </button>
          <button type="button" className="veh-sites-btn veh-all-btn" onClick={() => fitFleet(true)} title="להציג את כל הטכנאים שיש להם מיקום">
            כולם
          </button>
          <button type="button" className={`veh-sites-btn veh-streets-btn${streets ? " is-on" : ""}`} aria-pressed={streets}
            onClick={() => setStreets((v) => !v)}>
            רחובות
          </button>
          <button type="button" className={`veh-sites-btn${showSites ? " is-on" : ""}`} aria-pressed={showSites}
            onClick={() => { setShowSites((v) => !v); setTab((t) => (showSites ? "tech" : t)); }}>
            אתרים במפה
          </button>
        </span>
      </div>

      {error && <p className="veh-warn" role="alert">{error}</p>}
      {picking && (
        <p className="veh-pick" role="status">
          לחצו על המפה במקום של <b>{picking.name}</b>, ואז "שמירה כאן".
          <button type="button" onClick={() => { siteLayer.current?.cancelPick(); setPicking(null); }}>ביטול</button>
        </p>
      )}

      <div className={`veh-body${showList || showSites ? "" : " no-side"}`}>
        <div className={`veh-map${streets ? "" : " is-schematic"}`} ref={mapEl} dir="ltr" />
        {(showList || showSites) && <aside className="veh-side">
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
                  const w = whereInfo(v, now);
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
                        <span className={`veh-dot veh-dot--${w.group === "site" ? "site" : m.tone}`} aria-hidden="true" />
                        <span className="veh-row-main">
                          <span className="veh-row-name">{vehicleName(v)}</span>
                          <span className="veh-row-sub">
                            <span className={`veh-tone--${w.group === "site" ? "site" : m.tone}`}>{w.title}</span>
                            {power ? <> · <span className="veh-power" title={power.text}>⚠ {power.name}</span></> : null}
                            {w.sub[0] ? ` · ${w.sub[0]}` : ""}
                          </span>
                          {w.sub[1] && <span className="veh-row-near">{w.sub[1]}</span>}
                        </span>
                        {age && <span className="veh-row-age">{age}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </aside>}
      </div>
    </div>
  );
}
