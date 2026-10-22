// components/Vehicles/DispatchDialog.jsx — "צא ל:" מכרטיס הטכנאי (21/10/2026).
//
// בעלת המוצר: "על כל כרטיס יהיה כפתור משימה שכתוב שם 'צא ל:', ואז SELECT עם כל שמות האתרים — שמתחילים להקליד את שם האתר
// פחות או יותר וזה מביא את השם, בוחרים בשם האתר, ואז זה שואל אותו מה המשימה, ויש מקום לכתיבת טקסט חופשי".
//
// • "לאן?" — שדה חיפוש ורשימה מתחתיו (combobox: הפוקוס נשאר בשדה, החיצים מזיזים את השורה הפעילה, Enter בוחר, Esc מנקה).
//   הרשימה בתוך החלון ולא ב-portal: החלון שלנו, והרשימה היא חלק מהטופס. בלי הקלדה — אתרים בתקלה ועם קריאה פתוחה. השורה
//   האחרונה "מקום אחר: …" — יעד שאינו אתר (המחסן, ספק), כמו שהמסד מקבל.
// • "מה המשימה?" — טקסט חופשי, עד 500 תווים (הגבול של tech_dispatch).
// • רכב שעוד אין לו טכנאי — החלון שואל קודם את השם (הצעה מהכינוי באיתוראן), ושומר אותו לפעם הבאה (tech_save).
// • ⚠️ client_id לכל טיוטה: שליחה חוזרת אחרי שהתשובה אבדה מחזירה את אותה שליחה. מתחדש בכל שינוי בטיוטה — אחרת טיוטה
//   שתוקנה אחרי תשובה שאבדה הייתה מחזירה בשקט את השליחה הישנה (הלקח של המשימות, 12/10).
// • ⚠️ הרקע לא סוגר כשיש טיוטה — רק ✕ / ביטול / Esc. לחיצה בצד המסך באמצע הקלדה לא מוחקת אותה (הלקח של ניהול האתרים).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { dispatchTech, queueNextTask, saveTechnician } from "../../services/dataSource";
import { vehicleName } from "../../utils/vehicles";
import { destText, dispatchSites } from "../../utils/technicians";
import "./DispatchDialog.css";

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const MAX_DETAILS = 500;
const siteLabel = (s) => String(s?.site_name ?? s?.name ?? "").trim() || s?.code;

export default function DispatchDialog({ vehicle, tech, sites, siteKeys, callsBySite, onClose, onSent, onStale }) {
  const uid = useId();
  const [name, setName] = useState(() => (tech ? tech.name : vehicleName(vehicle)));
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState(null);          // {site} או {place}
  const [details, setDetails] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const clientId = useRef(newId());
  const created = useRef(null);                         // טכנאי שנוצר בניסיון קודם שנכשל אחר כך בשליחה
  const inputRef = useRef(null);
  const nameRef = useRef(null);
  const listRef = useRef(null);
  const pressOnBackdrop = useRef(false);
  const detailsRef = useRef(null);
  const focusNext = useRef(null);                       // אחרי בחירה — המשימה; אחרי "שינוי" — החיפוש

  const effTech = tech ?? created.current;
  const open = tech?.dispatch ?? null;
  const q = query.trim();
  const results = useMemo(() => dispatchSites(sites, query, callsBySite, siteKeys), [sites, query, callsBySite, siteKeys]);
  const placeOk = q.length >= 2 && q.length <= 80;
  const options = useMemo(() => [
    ...results.map((s) => ({ kind: "site", site: s })),
    ...(placeOk ? [{ kind: "place", place: q }] : []),
  ], [results, placeOk, q]);
  const dirty = Boolean(q || chosen || details.trim() || (!tech && name.trim() !== vehicleName(vehicle)));

  // כל שינוי בטיוטה — מזהה בקשה חדש
  const touch = () => { clientId.current = newId(); setError(null); };

  useEffect(() => { (tech ? inputRef : nameRef).current?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-i="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const choose = (o) => {
    touch();
    setChosen(o.kind === "site" ? { site: o.site } : { place: o.place });
    setQuery("");
    focusNext.current = detailsRef;
  };
  const unchoose = () => {
    touch();
    setChosen(null);
    focusNext.current = inputRef;
  };
  useEffect(() => {
    const r = focusNext.current;
    focusNext.current = null;
    r?.current?.focus({ preventScroll: true });
  }, [chosen]);

  const close = () => { if (!busy) onClose(); };

  const onComboKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (options[active]) choose(options[active]); }
    else if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }); // ⚠️ בלי מערך תלויות: close קורא את busy העדכני

  const canSend = Boolean(chosen) && !busy && name.trim().length >= 2;

  // mode = "next": המשימה הבאה (21/10/2026) — לטכנאי שכבר יש משימה; היא תתחיל כשייצא מהאתר של הנוכחית
  async function send(mode = "now") {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      let id = effTech?.id ?? null;
      let rev = effTech?.rev ?? null;
      if (!id) {
        const r = await saveTechnician({ name: name.trim(), plate: vehicle.plate });
        created.current = { id: r.id, rev: r.rev, name: name.trim() };
        id = r.id;
        rev = r.rev;
      }
      const req = {
        id, rev, clientId: clientId.current,
        siteCode: chosen.site ? chosen.site.code : null,
        place: chosen.place ?? null,
        details: details.trim() || null,
      };
      if (mode === "next") await queueNextTask(req); else await dispatchTech(req);
      onSent?.();
    } catch (e) {
      setError(e?.message || "השליחה נכשלה — נסה שוב");
      if (e?.stale) onStale?.();
    } finally {
      setBusy(false);
    }
  }

  const listId = `${uid}-list`;
  const optId = (i) => `${uid}-opt-${i}`;
  const calls = (s) => Number(callsBySite?.[s.id]?.open) || 0;
  const fault = (s) => s.monitored !== false && s.status === "error";

  return (
    <div className="dp-overlay" role="presentation"
      onMouseDown={(e) => { pressOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressOnBackdrop.current && !dirty) close(); }}>
      <div className="dp" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`}>
        <header className="dp-head">
          <h3 id={`${uid}-title`}>משימה חדשה <span className="dp-who">· {effTech?.name ?? (name.trim() || vehicleName(vehicle))}</span></h3>
          <button type="button" className="dp-x" aria-label="סגירה" onClick={close} disabled={busy}>✕</button>
        </header>

        {open && (
          <p className="dp-open">
            יש לו משימה פתוחה: <b>{destText(open)}</b>. אפשר להוסיף את זו כמשימה הבאה — היא תתחיל לבד כשייצא מהאתר —
            או להחליף את הנוכחית.
            {tech?.next && <> המשימה הבאה שכבר נקבעה (<b>{destText(tech.next)}</b>) תוחלף.</>}
          </p>
        )}

        {!effTech && (
          <label className="dp-field">
            <span className="dp-label">מי הטכנאי ברכב הזה?</span>
            <input ref={nameRef} className="dp-input" value={name} maxLength={60}
              onChange={(e) => { touch(); setName(e.target.value); }} />
            <span className="dp-hint">נשמר לפעם הבאה · רכב {vehicle.plate}</span>
          </label>
        )}

        <div className="dp-field">
          <label className="dp-label" htmlFor={`${uid}-q`}>לאן?</label>
          {chosen ? (
            <div className="dp-chosen">
              {chosen.site ? (
                <span><b>{siteLabel(chosen.site)}</b> <span className="dp-code">{chosen.site.code}</span></span>
              ) : (
                <span><span className="dp-muted">מקום אחר:</span> <b>{chosen.place}</b></span>
              )}
              <button type="button" className="dp-link" onClick={unchoose} disabled={busy}>שינוי</button>
            </div>
          ) : (
            <>
              <input id={`${uid}-q`} ref={inputRef} className="dp-input" type="search" autoComplete="off" enterKeyHint="search"
                role="combobox" aria-expanded={options.length > 0} aria-controls={listId} aria-autocomplete="list"
                aria-activedescendant={options[active] ? optId(active) : undefined}
                placeholder="שם אתר, רחוב או קוד" value={query}
                onChange={(e) => { touch(); setQuery(e.target.value); }} onKeyDown={onComboKey} />
              {!q && <p className="dp-hint">{results.length ? "אתרים בתקלה ועם קריאה פתוחה — או להקליד שם" : "להקליד שם אתר, רחוב או קוד"}</p>}
              {options.length > 0 && (
                <ul id={listId} ref={listRef} className="dp-list" role="listbox" aria-label="אתרים">
                  {options.map((o, i) => (
                    <li key={o.kind === "site" ? o.site.code : "__place"} id={optId(i)} data-i={i} role="option"
                      aria-selected={i === active} className={`dp-opt${i === active ? " is-active" : ""}${o.kind === "place" ? " dp-opt--place" : ""}`}
                      onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(o)}>
                      {o.kind === "site" ? (
                        <>
                          <span className="dp-opt-name">{siteLabel(o.site)}</span>
                          <span className="dp-code">{o.site.code}</span>
                          {fault(o.site) && <span className="dp-badge dp-badge--fault">בתקלה</span>}
                          {calls(o.site) > 0 && <span className="dp-badge dp-badge--call">{calls(o.site) === 1 ? "קריאה פתוחה" : `${calls(o.site)} קריאות`}</span>}
                        </>
                      ) : (
                        <span className="dp-opt-name"><span className="dp-muted">מקום אחר:</span> {o.place}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {q && !results.length && <p className="dp-hint">אין אתר כזה{placeOk ? " — אפשר לשלוח ל\"מקום אחר\"" : ""}</p>}
            </>
          )}
        </div>

        <label className="dp-field">
          <span className="dp-label">מה המשימה?</span>
          <textarea id={`${uid}-details`} ref={detailsRef} className="dp-input dp-text" rows={4} maxLength={MAX_DETAILS} value={details}
            placeholder="למשל: מעלית 2 תקועה, הדייר מחכה בלובי"
            onChange={(e) => { touch(); setDetails(e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
          {details.length > MAX_DETAILS - 60 && <span className="dp-hint">{details.length}/{MAX_DETAILS}</span>}
        </label>

        {error && <p className="dp-err" role="alert">{error}</p>}

        <footer className="dp-foot">
          {open ? (
            <>
              <button type="button" className="dp-send" onClick={() => send("next")} disabled={!canSend}>
                {busy ? "שומר…" : "הוספה כמשימה הבאה"}
              </button>
              <button type="button" className="dp-cancel dp-replace" onClick={() => send("now")} disabled={!canSend}>החלפה ושליחה</button>
            </>
          ) : (
            <button type="button" className="dp-send" onClick={() => send("now")} disabled={!canSend}>
              {busy ? "שולח…" : "שליחה"}
            </button>
          )}
          <button type="button" className="dp-cancel" onClick={close} disabled={busy}>ביטול</button>
        </footer>
      </div>
    </div>
  );
}

