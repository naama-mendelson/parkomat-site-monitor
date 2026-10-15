// components/ServiceCalls/ServiceCallsDialog.jsx — הקריאות הפתוחות של אתר בוויזנט, ושינוי סטטוס וסוג.
//
// בעלת המוצר, 13/10/2026: "סימון על כרטיס האתר", ושינוי — "כל אחד". המייל ממחלקת השירות: המוקדנים רואים שהמערכת
// תקולה, ואולי אף דייר לא פתח קריאה — ולכן הקריאות לצד נתוני המערכת.
//
// ⚠️ המעטפת היא של חלון המשימות (tk-overlay / tk-dialog / tk-head): SiteGrid מתעלם מלחיצה בתוך .tk-overlay, ובלי
// זה סגירת החלון הייתה מקפלת את הכרטיס שמתחתיו.
//
// ⚠️ אין כאן החלטה על הרשאה ולא על "פתוחה": מה פתוח — ב-SQL (לפי רשימת הסטטוסים של ויזנט); מי רשאי לשנות —
// המסד. שינוי נשלח לוויזנט קודם — דרך ממסר, מחשב באתר בישראל (15/10/2026) — ונרשם אצלנו רק אחרי שאישרו.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchServiceCalls, fetchRecentServiceCalls, fetchServiceCallLookups, updateServiceCall, refreshServiceCallLookups,
  fetchWizenetRelayStatus,
} from "../../services/dataSource";
import { callerName, openedLabel, optionsFor, callText, parkingDetail, callsSummary, israelLabel, dupInfo, SERVICE_CALLS_WRITE } from "../../utils/serviceCalls";
import "../Tasks/Tasks.css";
import FaultTimer from "../SiteCard/FaultTimer";
import "./ServiceCalls.css";

/**
 * @param {object} p
 * @param {{code:string, site_name?:string}} p.site
 * @param {number} [p.rev] — עולה כשהגיע אירוע קריאות; טוען מחדש
 * @param {() => void} p.onClose
 * @param {() => void} [p.onChanged] — אחרי שינוי (ההורה מרענן את הסימון בכרטיס)
 */
export default function ServiceCallsDialog({ site = null, recent = false, rev = 0, onClose, onChanged }) {
  // ⚠️ שני מצבים (14/10/2026): אתר אחד — הקריאות **הפתוחות** שלו; "קריאות היום" — כל מה שהגיע
  // ב-24 השעות, כולל סגורות וכולל קודים שאין להם אתר אצלנו. בלי המצב השני, יום שלם של 22 קריאות
  // הופיע כגלולה אחת על כרטיס אחד.
  const siteName = recent ? "24 השעות האחרונות" : (site.site_name || site.code);
  const [calls, setCalls] = useState(null);
  const [lookups, setLookups] = useState({ status: [], type: [] });
  const [loadError, setLoadError] = useState("");
  // ⚠️ לכל קריאה בנפרד (סקירה, 15/10/2026): שינוי דרך הממסר לוקח שניות, ולפעמים יותר. עם דגל אחד, סיום של קריאה א'
  // שחרר את הבורר של ב' באמצע השליחה שלה (והוא הציג את הערך הישן — הזמנה ללחוץ שוב), ותחילת ב' מחקה את השגיאה של א'.
  const [busy, setBusy] = useState(() => new Set());        // מספרי הקריאות שבשליחה
  const [rowErrors, setRowErrors] = useState({});           // { [ticket]: msg }
  const setRowError = (ticket, msg) => setRowErrors((m) => {
    const next = { ...m };
    if (msg) next[ticket] = msg; else delete next[ticket];
    return next;
  });
  const setBusyFor = (ticket, on) => setBusy((b) => {
    const next = new Set(b);
    if (on) next.add(ticket); else next.delete(ticket);
    return next;
  });
  const [listsBusy, setListsBusy] = useState(false);
  const [listsMsg, setListsMsg] = useState(null);   // { ok, text }
  // ⚠️ null = לא ידוע (עוד לא נטען, או שהשאלה נכשלה) — אז הבורר פעיל, והמסד יסרב בהודעה ברורה אם אין ממסר.
  // רק "0 חיים" ידוע מאפיר אותו מראש: בלי זה הלחיצה הייתה מסתיימת בסירוב, בלי שום רמז לפני.
  const [relay, setRelay] = useState(null);         // { alive, enabled }
  const overlayRef = useRef(null);
  const pressedOnOverlay = useRef(false);

  // ⚠️ גם מהכרטיס — 24 שעות: פתוחות בכל גיל, ומה שנסגר היום. "מה קרה כאן היום" ולא רק "מה פתוח".
  const load = useCallback(() => (recent ? fetchRecentServiceCalls(24) : fetchServiceCalls(site.code, 24))
    .then((c) => { setCalls(c); setLoadError(""); })
    .catch((e) => setLoadError(e.message)), [recent, site?.code]);

  useEffect(() => { load(); }, [load, rev]);
  useEffect(() => { fetchServiceCallLookups().then(setLookups).catch(() => {}); }, []);
  const loadRelay = useCallback(() => {
    if (SERVICE_CALLS_WRITE) fetchWizenetRelayStatus().then(setRelay).catch(() => setRelay(null));
  }, []);
  useEffect(() => { loadRelay(); }, [loadRelay]);
  const noRelay = relay?.alive === 0;

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
    setBusyFor(c.ticket, true);
    setRowError(c.ticket, null);
    try {
      const r = await updateServiceCall(c.ticket, field, value);
      if (r?.warning) setRowError(c.ticket, r.warning);
      onChanged?.();
    } catch (e) {
      setRowError(c.ticket, e.message);
    } finally {
      // ⚠️ טוענים גם אחרי כשל: הבורר חוזר לערך האמיתי, ולא נשאר על מה שנבחר ולא נשמר
      await load();
      loadRelay();
      setBusyFor(c.ticket, false);
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
      setListsMsg({ ok: true, text: r?.result || "הרשימות נטענו" });
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
    // ⚠️ בלי ממסר אי אפשר לעדכן את ויזנט (ראו SERVICE_CALLS_WRITE) — מציגים את הערך ולא בורר שנתקע
    if (!SERVICE_CALLS_WRITE) {
      const val = curName || cur;
      return val ? <span className="sc-field-val" title={label}>{val}</span> : null;
    }
    return (
      <label className="sc-field">
        <span className="sc-field-cap">{label}</span>
        <select className="sc-select" value={cur ?? ""} disabled={busy.has(c.ticket) || list.length === 0 || noRelay}
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
              {/* ⚠️ ברשימת "היום" חלק מהקריאות סגורות — "N פתוחות" היה שקר על המספר שלידו */}
              {siteName}{calls && <> · {calls.length ? callsSummary(calls) : "אין קריאות"}</>}
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
            {SERVICE_CALLS_WRITE && (
              <button type="button" className="tk-link" disabled={listsBusy || noRelay} onClick={reloadLists}>
                {listsBusy ? "טוען מוויזנט…" : "טעינת הרשימות מוויזנט"}
              </button>
            )}
          </p>
        )}
        {listsMsg && <p className={listsMsg.ok ? "tk-muted sc-note" : "tk-error"} role="status">{listsMsg.text}</p>}
        {/* ⚠️ שורה אחת, ורק כשיש מה לשנות: בלי קריאות אין בורר, ואין מה להסביר */}
        {SERVICE_CALLS_WRITE && noRelay && calls?.length > 0 && (
          <p className="tk-muted sc-note" role="status">אין כרגע ממסר פעיל לוויזנט — אי אפשר לשנות סטטוס או סוג</p>
        )}

        <div className="tk-body">
          {!calls && !loadError && <p className="tk-muted">טוען…</p>}
          {calls && calls.length === 0 && (
            <p className="tk-empty">{recent ? "לא הגיעו קריאות ב-24 השעות האחרונות" : "✓ אין קריאות פתוחות, ולא היו היום"}</p>
          )}
          {calls?.length > 0 && (
            <ul className="tk-list sc-list" aria-label={recent ? "קריאות מ-24 השעות האחרונות" : "קריאות פתוחות"}>
              {calls.map((c) => {
                const dup = dupInfo(c);
                return (
                <li key={c.ticket} className={`sc-row${c.open === false ? " sc-row--closed" : ""}`}
                  data-ticket={c.ticket} aria-busy={busy.has(c.ticket) || undefined}>
                  <div className="sc-top">
                    {c.open != null && (
                      <span className={`sc-state${c.open ? " sc-state--open" : ""}`}>{c.open ? "פתוחה" : "סגורה"}</span>
                    )}
                    {/* ⚠️ סטופר רק לפתוחה: על קריאה שנסגרה "כמה זמן היא פתוחה" חסר משמעות */}
                    {c.open && c.opened_utc && <FaultTimer since={c.opened_utc} tone="call" />}
                    <span className="sc-when"><bdi>{openedLabel(c)}</bdi></span>
                    <span className="sc-ticket">קריאה <bdi>{c.ticket}</bdi></span>
                    {/* ⚠️ אותו אדם לחץ כמה פעמים — שורה אחת, והמספר נאמר ולא מוסתר */}
                    {dup && <span className="sc-dup" title={dup.title} aria-label={dup.title}>{dup.mark}</span>}
                    {/* ⚠️ "חניה" רק כשהיא מוסיפה מידע (קוד מלא עם מתקן/כרטיס). מאז 08/10 מגיע קוד
                        הפרויקט לבדו, והוא כבר כתוב כקוד האתר — "חניה 3452" ליד "אתר 3452" הוא רעש. */}
                    {parkingDetail(c) && <span className="sc-parking">חניה <bdi>{parkingDetail(c)}</bdi></span>}
                  </div>
                  {/* ⚠️ קוד בלי אתר אצלנו — נאמר במפורש. אלה רבע מהקריאות ביום הראשון, והן לא
                      מופיעות בשום מקום אחר בדשבורד */}
                  {recent && (
                    <div className="sc-site">
                      {c.site_code
                        ? <>אתר <bdi>{c.site_code}</bdi> · {c.site_name}</>
                        : <span className="sc-site--none">קוד <bdi>{c.project || "—"}</bdi> — אין אתר כזה במערכת</span>}
                    </div>
                  )}
                  {/* ⚠️ בלי שם ובלי טלפון אין שורה: "—" לבדו הוא רעש (בעלת המוצר, 14/10/2026) */}
                  {(callerName(c) !== "—" || c.phone) && (
                    <div className="sc-who">
                      {callerName(c) !== "—" && <b>{callerName(c)}</b>}
                      {c.phone && <a className="sc-phone" href={`tel:${String(c.phone).replace(/[^\d+]/g, "")}`}><bdi>{c.phone}</bdi></a>}
                    </div>
                  )}
                  {/* ⚠️ טקסט מנוקה: ויזנט שולחים HTML, והטלפון חוזר בתוך ההערות */}
                  {callText(c).map((line, i) => (
                    <p key={i} className={i === 0 ? "sc-text" : "sc-notes"}>{line}</p>
                  ))}
                  <div className="sc-fields">
                    {picker(c, "status")}
                    {picker(c, "type")}
                    {busy.has(c.ticket) && <span className="tk-muted sc-busy">נשלח לוויזנט…</span>}
                  </div>
                  {c.changed_by && (
                    <p className="sc-changed">שונה מהדשבורד ע״י {String(c.changed_by).replace(/@parkomat\.co\.il$/i, "")}
                      {" · "}<bdi>{israelLabel(c.changed_at)}</bdi></p>
                  )}
                  {rowErrors[c.ticket] && <p className="tk-row-msg sc-row-msg" role="alert">{rowErrors[c.ticket]}</p>}
                </li>
                );
              })}
            </ul>
          )}
          {/* ⚠️ גם הרענון עובר דרך WIZEAPI — חסום מחוץ לישראל, ולכן דרך הממסר */}
          {!noLists && SERVICE_CALLS_WRITE && (
            <p className="sc-foot">
              <button type="button" className="tk-link" disabled={listsBusy || noRelay} onClick={reloadLists}>
                {listsBusy ? "טוען מוויזנט…" : "רענון רשימות הסטטוסים והסוגים מוויזנט"}
              </button>
            </p>
          )}

        </div>
      </div>
    </div>
  );
}
