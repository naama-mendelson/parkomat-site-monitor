// components/Vehicles/siteLayer.js — שכבת האתרים על מפת הטכנאים (20/10/2026).
//
// בעלת המוצר: "רק מיקומים ולאיזה אתרים הם קרובים", ואחר כך: הצעה משוערת מהכתובת לכל אתר, שעורך מאשר או מתקן על המפה.
// סמן מרובע קטן לכל אתר עם מיקום; משוער (לפי רחוב / אזור) — מסגרת מקווקווה. לעורך, בחלון האתר:
//   • "אישור המיקום" — אותן קואורדינטות, והמקור הופך ל"מאושר";
//   • "הזזה" — גוררים את הסמן, ואז "שמירה כאן" / "ביטול";
//   • אתר בלי מיקום — מצב סימון: לחיצה על המפה, ואז "שמירה כאן".
// ⚠️ Leaflet בלי React, כמו המפה עצמה: סמנים מתעדכנים במקום, והלחצנים בחלון מחוברים כשהוא נפתח (popupopen).
// ⚠️ השמירה עצמה (וההרשאה) — במסד: public.site_geo_set (עורך בלבד; מסך ישן מקבל שגיאה במקום לדרוס).
import L from "leaflet";
import { SITE_GEO, siteGeoKey } from "../../utils/vehicles";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * @param map      מפת Leaflet
 * @param opts.canEdit  () => boolean — האם המשתמש עורך (נקרא בכל פתיחת חלון, כי התפקיד יכול להיטען אחרי המפה)
 * @param opts.onSave   (site, lat, lon) => Promise<site מעודכן> — זורק עם הודעה בעברית בכישלון
 */
export function createSiteLayer(map, { canEdit, onSave }) {
  const group = L.layerGroup();
  const markers = new Map();        // code → marker
  let byCode = new Map();           // code → site
  let visible = false;
  let pick = null;                  // { site, marker } — מצב סימון של אתר בלי מיקום

  const iconFor = (s) => L.divIcon({
    className: "veh-site-wrap",
    html: `<span class="veh-site veh-site--${siteGeoKey(s)}"></span>`,
    iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -9],
  });

  // מה החלון אומר, ואילו לחצנים בו. mode: "view" / "move" (גרירה) / "confirm-move" (אחרי גרירה) / "pick"
  function popupHtml(s, mode, msg) {
    const key = siteGeoKey(s);
    const edit = canEdit();
    const actions = !edit ? "" : mode === "move"
      ? `<div class="veh-site-hint">גררו את הסמן למקום הנכון</div><div class="veh-site-actions"><button type="button" data-act="cancel">ביטול</button></div>`
      : mode === "confirm-move" || mode === "pick"
        ? `<div class="veh-site-actions"><button type="button" class="is-primary" data-act="save">שמירה כאן</button><button type="button" data-act="cancel">ביטול</button></div>`
        : `<div class="veh-site-actions">${key !== "manual" ? `<button type="button" class="is-primary" data-act="confirm">אישור המיקום</button>` : ""}<button type="button" data-act="move">הזזה</button></div>`;
    return `<div class="veh-pop veh-site-pop" dir="rtl">
      <div class="veh-pop-name">${esc(s.name)}</div>
      <div class="veh-pop-plate">${esc(s.code)}${s.monitored === false ? " · בלי בקר" : ""}</div>
      <div class="veh-site-state veh-site-state--${key}">${esc(mode === "pick" ? "המיקום החדש" : SITE_GEO[key].label)}</div>
      ${msg ? `<div class="veh-site-msg" role="alert">${esc(msg)}</div>` : ""}
      ${actions}
    </div>`;
  }

  // ⚠️ onclick ולא addEventListener: החלון יכול להיפתח שוב על אותו תוכן (openPopup על חלון פתוח), ומאזין שני היה שומר פעמיים
  function wire(marker, s, mode) {
    const el = marker.getPopup()?.getElement();
    if (!el) return;
    el.querySelectorAll("button[data-act]").forEach((b) => {
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.disabled = true;
        act(marker, s, b.dataset.act, mode);
      };
    });
  }

  function setPopup(marker, s, mode, msg) {
    const html = popupHtml(s, mode, msg);
    if (marker.getPopup()) marker.setPopupContent(html); else marker.bindPopup(html, { maxWidth: 260, autoPan: true });
    marker.off("popupopen").on("popupopen", () => wire(marker, s, marker._siteMode || "view"));
    marker._siteMode = mode;
    if (marker.isPopupOpen()) wire(marker, s, mode);
  }

  async function save(marker, s, lat, lon) {
    try {
      const saved = await onSave(s, lat, lon);
      const next = { ...s, ...saved };
      byCode.set(next.code, next);
      if (pick && pick.site.code === s.code) { map.removeLayer(pick.marker); pick = null; map.getContainer().classList.remove("is-picking"); }
      upsert(next, true);
    } catch (e) {
      setPopup(marker, s, marker._siteMode, e?.message || "השמירה נכשלה");
      marker.openPopup();
    }
  }

  function act(marker, s, what, mode) {
    if (what === "confirm") return save(marker, s, s.lat, s.lon);
    if (what === "move") {
      marker.dragging?.enable();
      setPopup(marker, s, "move");
      marker.openPopup();
      marker.once("dragend", () => { setPopup(marker, s, "confirm-move"); marker.openPopup(); });
      return;
    }
    if (what === "save") {
      const ll = marker.getLatLng();
      return save(marker, s, +ll.lat.toFixed(6), +ll.lng.toFixed(6));
    }
    if (what === "cancel") {
      if (mode === "pick") return cancelPick();
      marker.off("dragend");
      marker.dragging?.disable();
      if (Number.isFinite(s.lat)) marker.setLatLng([s.lat, s.lon]);
      setPopup(marker, s, "view");
      marker.openPopup();
    }
  }

  function upsert(s, open = false) {
    let mk = markers.get(s.code);
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) {
      if (mk) { group.removeLayer(mk); markers.delete(s.code); }
      return;
    }
    if (!mk) {
      mk = L.marker([s.lat, s.lon], { icon: iconFor(s), title: s.name, alt: s.name, keyboard: false, draggable: false });
      markers.set(s.code, mk);
      group.addLayer(mk);
    } else {
      mk.dragging?.disable();
      mk.setLatLng([s.lat, s.lon]);
      mk.setIcon(iconFor(s));
    }
    setPopup(mk, s, "view");
    if (open && visible) mk.openPopup();
  }

  function cancelPick() {
    if (!pick) return;
    map.removeLayer(pick.marker);
    map.getContainer().classList.remove("is-picking");
    map.off("click", onPickClick);
    pick = null;
  }

  function onPickClick(e) {
    if (!pick) return;
    pick.marker.setLatLng(e.latlng);
    if (!map.hasLayer(pick.marker)) pick.marker.addTo(map);
    setPopup(pick.marker, pick.site, "pick");
    pick.marker.openPopup();
  }

  return {
    /** כל האתרים (מ-site_locations_list). מעדכן במקום; אתר שאיבד מיקום — יורד מהמפה. */
    setSites(list) {
      byCode = new Map((list || []).map((s) => [s.code, s]));
      for (const code of [...markers.keys()]) if (!byCode.has(code)) { group.removeLayer(markers.get(code)); markers.delete(code); }
      for (const s of byCode.values()) upsert(s);
    },
    show() { if (!visible) { group.addTo(map); visible = true; } },
    hide() { if (visible) { map.removeLayer(group); visible = false; } cancelPick(); },
    /** עפים לאתר ופותחים את החלון שלו; false כשאין לו מיקום */
    focus(code) {
      const mk = markers.get(code);
      if (!mk) return false;
      this.show();
      map.flyTo(mk.getLatLng(), Math.max(map.getZoom(), 16), { duration: 0.6 });
      mk.openPopup();
      return true;
    },
    /** מצב סימון לאתר בלי מיקום: הלחיצה הבאה על המפה מציבה סמן זמני, ואז "שמירה כאן" */
    startPick(site) {
      cancelPick();
      this.show();
      const marker = L.marker(map.getCenter(), { icon: iconFor({ ...site, lat: 0, lon: 0, source: "manual" }), draggable: true, keyboard: false });
      marker.on("dragend", () => { setPopup(marker, site, "pick"); marker.openPopup(); });
      pick = { site, marker };
      map.getContainer().classList.add("is-picking");
      map.on("click", onPickClick);
    },
    cancelPick,
    picking: () => (pick ? pick.site : null),
    destroy() { cancelPick(); if (visible) map.removeLayer(group); markers.clear(); },
  };
}
