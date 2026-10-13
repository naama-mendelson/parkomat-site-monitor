// components/ServiceCalls/ServiceCallsDialog.jsx — הקריאות הפתוחות של אתר בוויזנט, ושינוי סטטוס וסוג.
//
// בעלת המוצר, 13/10/2026: "סימון על כרטיס האתר", ושינוי — "כל אחד". המייל ממחלקת השירות: המוקדנים רואים שהמערכת
// תקולה, ואולי אף דייר לא פתח קריאה — ולכן הקריאות לצד נתוני המערכת.
//
// ⚠️ המעטפת היא של חלון המשימות (tk-overlay / tk-dialog / tk-head): SiteGrid מתעלם מלחיצה בתוך .tk-overlay, ובלי
// זה סגירת החלון הייתה מקפלת את הכרטיס שמתחתיו.
//
// ⚠️ אין כאן החלטה על הרשאה ולא על "פתוחה": מה פתוח — ב-SQL (לפי רשימת הסטטוסים של ויזנט); מי רשאי לשנות —
// פונקציית ה-Edge מול המסד. שינוי נשלח לוויזנט קודם, ונרשם אצלנו רק אחרי שאישרו.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchServiceCalls, fetchServiceCallLookups, updateServiceCall, refreshServiceCallLookups } from "../../services/dataSource";
import { callerName, openedLabel, optionsFor } from "../../utils/serviceCalls";
import "../Tasks/Tasks.css";
import "./ServiceCalls.css";

/**
 * @param {object} p
 * @param {{code:string, site_name?:string}} p.site
 * @param {number} [p.rev] — עולה כשהגיע אירוע קריאות; טוען מחדש
 * @param {() => void} p.onClose
 * @param {() => void} [p.onChanged] — אחרי שינוי (ההורה מרענן את הסימון בכרטיס)
 */
export default function ServiceCallsDialog({ site, rev = 0, onClose, onChanged }) {
  const siteName = site.site_name || site.code;
  const [calls, setCalls] = useState(null);
  const [lookups, setLookups] = useState({ status: [], type: [] });
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(null);           // מספר הקריאה שבעדכון
  const [rowError, setRowError] = useState(null);   // { ticket, msg }
  const [listsBusy, setListsBusy] = useState(false);
  const [listsMsg, setListsMsg] = useState(null);   // { ok, text }
  const overlayRef = useRef(null);
  const pressedOnOverlay = useRef(false);

  const load = useCallback(() => fetchServiceCalls(site.code)
    .then((c) => { setCalls(c); setLoadError(""); })
    .catch((e) => setLoadError(e.message)), [site.code]);

  useEffect(() => { load(); }, [load, rev]);
  useEffect(() => { fetchServiceCallLookups().then(setLookups).catch(() => {}); }, []);

  // Escape סוגר — רק כשאין חלון אחר מעליו (אותו כלל כמו בחלון המשימות)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      const all = document.querySelectorAll(".tk-overlay");
      if (all[all.length - 1] !== overlayRef.current) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const change = async (c, field, value) => {
    if (!value || value === (field === "status" ? c.status_id : c.type_id)) return;
    setBusy(c.ticket);
    setRowError(null);
    try {
      const r = await updateServiceCall(c.ticket, field, value);
      if (r?.warning) setRowError({ ticket: c.ticket, msg: r.warning });
      onChanged?.();
    } catch (e) {
      setRowError({ ticket: c.ticket, msg: e.message });
    } finally {
      // ⚠️ טוענים גם אחרי כשל: הבורר חוזר לערך האמיתי, ולא נשאר על מה שנבחר ולא נשמר
      await load();
      setBusy(null);
    }
  };

  // טעינת הרשימות מוויזנט אל המסד (דרך הממסר), ואז קריאתן מחדש. ⚠️ כאן ולא בפאנל הניהול: הצורך עולה בדיוק
  // כשמסתכלים על קריאה עם סטטוס בלי שם, וכל איש צוות רשאי (המסד אוכף).
  const reloadLists = async () => {
    setListsBusy(true);
    setListsMsg(null);
    try {
      const r = await refreshServiceCallLookups();
      setLookups(await fetchServiceCallLookups());
      await load();
      setListsMsg({ ok: true, text: `נטענו ${r?.status ?? 0} סטטוסים ו-${r?.type ?? 0} סוגי קריאה` });
    } catch (e) {
      setListsMsg({ ok: false, text: e.message });
    } finally {
      setListsBusy(false);
    }
  };

  const noLists = lookups.status.length === 0 && lookups.type.length === 0;
  const picker = (c, field) => {
    const list = field === "status" ? lookups.status : lookups.type;
    const cur = field === "status" ? c.status_id : c.type_id;
    const curName = field === "status" ? c.status_name : c.type_name;
    const label = field === "status" ? "סטטוס" : "סוג";
    return (
      <label className="sc-field">
        <span className="sc-field-cap">{label}</span>
        <select className="sc-select" value={cur ?? ""} disabled={busy === c.ticket || list.length === 0}
          aria-label={`${label} של קריאה ${c.ticket}`}
          onChange={(e) => change(c, field, e.target.value)}>
          {cur == null && <option value="">—</option>}
          {optionsFor(list, cur, curName).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
    );
  };

  return (
    <div className="tk-overlay" ref={overlayRef}
      onPointerDown={(e) => { pressedOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedOnOverlay.current) onClose(); }}>
      <div className="tk-dialog sc-dialog" role="dialog" aria-modal="true" aria-label={`קריאות שירות — ${siteName}`} dir="rtl">
        <header className="tk-head">
          <div className="tk-head-text">
            <h2 className="tk-title">קריאות שירות</h2>
            <span className="tk-site">
              {siteName}{calls && <> · {calls.length ? `${calls.length} פתוחות בוויזנט` : "אין קריאות פתוחות"}</>}
            </span>
          </div>
          <button type="button" className="tk-close" onClick={onClose} aria-label="סגירה">✕</button>
        </header>

        {loadError && (
          <p className="tk-error" role="alert">
            {loadError} <button type="button" className="tk-link" onClick={load}>נסה שוב</button>
          </p>
        )}
        {noLists && calls?.length > 0 && (
          <p className="tk-muted sc-note">
            רשימות הסטטוסים והסוגים של ויזנט עוד לא נטענו — אי אפשר לשנות כרגע.{" "}
            <button type="button" className="tk-link" disabled={listsBusy} onClick={reloadLists}>
              {listsBusy ? "טוען מוויזנט…" : "טעינת הרשימות מוויזנט"}
            </button>
          </p>
        )}
        {listsMsg && <p className={listsMsg.ok ? "tk-muted sc-note" : "tk-error"} role="status">{listsMsg.text}</p>}

        <div className="tk-body">
          {!calls && !loadError && <p className="tk-muted">טוען…</p>}
          {calls && calls.length === 0 && <p className="tk-empty">✓ אין קריאות פתוחות</p>}
          {calls?.length > 0 && (
            <ul className="tk-list sc-list" aria-label="קריאות פתוחות">
              {calls.map((c) => (
                <li key={c.ticket} className="sc-row" data-ticket={c.ticket} aria-busy={busy === c.ticket || undefined}>
                  <div className="sc-top">
                    <span className="sc-ticket">קריאה <bdi>{c.ticket}</bdi></span>
                    <span className="sc-when"><bdi>{openedLabel(c)}</bdi></span>
                    {c.parking_code && <span className="sc-parking">חניה <bdi>{c.parking_code}</bdi></span>}
                  </div>
                  <div className="sc-who">
                    <b>{callerName(c)}</b>
                    {c.phone && <a className="sc-phone" href={`tel:${String(c.phone).replace(/[^\d+]/g, "")}`}><bdi>{c.phone}</bdi></a>}
                  </div>
                  {c.complaint && <p className="sc-text">{c.complaint}</p>}
                  {c.notes && <p className="sc-notes">{c.notes}</p>}
                  <div className="sc-fields">
                    {picker(c, "status")}
                    {picker(c, "type")}
                    {busy === c.ticket && <span className="tk-muted sc-busy">שומר בוויזנט…</span>}
                  </div>
                  {c.changed_by && (
                    <p className="sc-changed">שונה מהדשבורד ע״י {String(c.changed_by).replace(/@parkomat\.co\.il$/i, "")}
                      {" · "}<bdi>{openedLabel({ opened_at: c.changed_at })}</bdi></p>
                  )}
                  {rowError?.ticket === c.ticket && <p className="tk-row-msg sc-row-msg" role="alert">{rowError.msg}</p>}
                </li>
              ))}
            </ul>
          )}
          {!noLists && (
            <p className="sc-foot">
              <button type="button" className="tk-link" disabled={listsBusy} onClick={reloadLists}>
                {listsBusy ? "טוען מוויזנט…" : "רענון רשימות הסטטוסים והסוגים מוויזנט"}
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
