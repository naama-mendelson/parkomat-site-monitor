// components/ServiceCalls/ServiceCallsDialog.jsx — הקריאות של אתר בוויזנט (הפתוחות, ו"להיסטוריה" — אלה שנסגרו),
// "קריאות היום", ושינוי סטטוס וסוג.
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
  fetchServiceCalls, fetchServiceCallHistory, fetchRecentServiceCalls, fetchServiceCallLookups, updateServiceCall,
  refreshServiceCallLookups, fetchWizenetRelayStatus,
} from "../../services/dataSource";
import {
  callerName, openedLabel, optionsFor, callText, parkingDetail, callsSummary, siteCallsSummary, movedNote, israelLabel,
  dupInfo, SERVICE_CALLS_WRITE,
} from "../../utils/serviceCalls";
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
  // ⚠️ שלוש רשימות. מהכרטיס — הקריאות **הפתוחות** של האתר, ו"להיסטוריה" מחליף לאלה שנסגרו (15/10/2026, בעלת המוצר:
  // "יראו רק קריאות פתוחות ויהיה כפתור שכתוב עליו להסטוריה"). עד אז החלון מהכרטיס הראה גם את מה שנסגר היום.
  // "קריאות היום" (recent, 14/10) — כל מה שהגיע ב-24 השעות וכל פתוחה בכל גיל, כולל קודים שאין להם אתר אצלנו.
  const [view, setView] = useState("open");        // "open" | "history" — באתר אחד בלבד
  const mode = recent ? "recent" : view;
  const siteName = recent ? "24 השעות האחרונות" : (site.site_name || site.code);
  const title = mode === "history" ? "היסטוריית קריאות" : "קריאות שירות";
  const [calls, setCalls] = useState(null);
  const [total, setTotal] = useState(null);        // בהיסטוריה: כמה נסגרו בכלל — הרשימה עצמה עד 100
  // ⚠️ השינוי המוצלח האחרון — { c, from }. השורה "עברה להיסטוריה" **נגזרת** ממנו מול הרשימה שעל המסך (movedText),
  // ולא נקבעת מהטעינה שאחרי השינוי: האירוע שהשינוי עצמו מפרסם (Realtime) מתחיל טעינה משלו, וכשהיא מאוחרת יותר
  // הטעינה של השינוי נזרקת — והשורה לא הופיעה, אחת מכמה סגירות (סקירה, 15/10/2026). וכך גם קריאה שחזרה לרשימה
  // (מישהו פתח אותה מחדש) — השורה נעלמת לבד, ולא נשארת לשקר מעליה.
  const [moved, setMoved] = useState(null);
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
  const dialogRef = useRef(null);
  const pressedOnOverlay = useRef(false);

  // ⚠️ כל טעינה ממוספרת, ורק האחרונה נכנסת למסך. בלי זה, החלפה ל"היסטוריה" באמצע טעינה — או שינוי שעבר דרך
  // הממסר ונגמר אחרי ההחלפה — הייתה שמה את הרשימה הקודמת מתחת לכותרת החדשה.
  const seq = useRef(0);
  const load = useCallback(() => {
    const my = ++seq.current;
    const req = mode === "history" ? fetchServiceCallHistory(site.code)
      : (mode === "recent" ? fetchRecentServiceCalls(24) : fetchServiceCalls(site.code)).then((c) => ({ calls: c, total: null }));
    return req.then((r) => {
      if (my !== seq.current) return;
      setCalls(r.calls);
      setTotal(r.total);
      setLoadError("");
    }, (e) => {
      if (my === seq.current) setLoadError(e.message);
    });
  }, [mode, site?.code]);
  // הטעינה של מה שמוצג **עכשיו** — לסוף שינוי, שיכול להימשך שניות (ראו change)
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => { load(); }, [load, rev]);

  const switchView = (v) => {
    seq.current++;           // ⚠️ טעינה של התצוגה הקודמת שעוד בדרך — כבר לא נכנסת
    setView(v);
    setCalls(null);          // "טוען…", ולא הרשימה הקודמת מתחת לכותרת החדשה
    setTotal(null);
    setMoved(null);
    setLoadError("");
  };
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
    const from = mode;
    setBusyFor(c.ticket, true);
    setRowError(c.ticket, null);
    setMoved(null);
    try {
      const r = await updateServiceCall(c.ticket, field, value);
      if (r?.warning) setRowError(c.ticket, r.warning);
      setMoved({ c, from });
      onChanged?.();
    } catch (e) {
      setRowError(c.ticket, e.message);
    } finally {
      // ⚠️ טוענים גם אחרי כשל: הבורר חוזר לערך האמיתי, ולא נשאר על מה שנבחר ולא נשמר.
      // ⚠️ loadRef ולא load: השינוי עובר דרך הממסר ולוקח שניות, ובינתיים אפשר לעבור ל"היסטוריה" ובחזרה.
      await loadRef.current();
      loadRelay();
      setBusyFor(c.ticket, false);
      // ⚠️ הבורר היה מושבת בזמן השליחה, והמיקוד נפל לדף — וכשהשורה יצאה מהרשימה, אין לאן לחזור. מחזירים אותו לחלון:
      // לבורר של אותה קריאה אם היא עוד כאן, ואחרת לחלון עצמו. בלי זה, Tab הבא יוצא לדף שמאחורי החלון. רק כשהמיקוד
      // עדיין "בשום מקום": מי שעבר בינתיים לשורה אחרת נשאר שם.
      setTimeout(() => {
        const dlg = dialogRef.current, a = document.activeElement;
        if (!dlg || (a && a !== document.body)) return;
        const sel = dlg.querySelector(`.sc-row[data-ticket="${CSS.escape(String(c.ticket))}"] select[data-field="${field}"]`);
        (sel && !sel.disabled ? sel : dlg).focus({ preventScroll: true });
      }, 0);
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
      await loadRef.current();
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
        <select className="sc-select" data-field={field} value={cur ?? ""} disabled={busy.has(c.ticket) || list.length === 0 || noRelay}
          aria-label={`${label} של קריאה ${c.ticket}`}
          onChange={(e) => change(c, field, e.target.value)}>
          {cur == null && <option value="">—</option>}
          {optionsFor(list, cur, curName).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
    );
  };

  // השורה "עברה להיסטוריה" — רק אם הקריאה באמת לא ברשימה שעל המסך, ובאותה תצוגה שבה שונתה (ראו moved)
  const movedText = moved && moved.from === mode && calls && !calls.some((x) => x.ticket === moved.c.ticket)
    ? movedNote(moved.c, mode) : "";

  return (
    <div className="tk-overlay" ref={overlayRef}
      onPointerDown={(e) => { pressedOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedOnOverlay.current) onClose(); }}>
      <div className="tk-dialog sc-dialog" role="dialog" aria-modal="true" aria-label={`${title} — ${siteName}`} dir="rtl"
        ref={dialogRef} tabIndex={-1}>
        <header className="tk-head">
          <div className="tk-head-text">
            <h2 className="tk-title">{title}</h2>
            <span className="tk-site">
              {/* ⚠️ ברשימת "היום" חלק מהקריאות סגורות — "N פתוחות" היה שקר על המספר שלידו */}
              {siteName}{calls && <> · {recent
                ? (calls.length ? callsSummary(calls) : "אין קריאות")
                : siteCallsSummary(view, calls, total)}</>}
            </span>
          </div>
          {!recent && (
            <button type="button" className="sc-view-btn" onClick={() => switchView(view === "history" ? "open" : "history")}>
              {view === "history" ? "לקריאות הפתוחות" : "להיסטוריה"}
            </button>
          )}
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
        {/* ⚠️ תמיד במסך, ורק הטקסט משתנה: אזור הודעות שנוסף **יחד** עם הטקסט שלו לא תמיד מוקרא (VoiceOver בעיקר).
            ריק — הוא מוסתר בלי להיעלם מעץ הנגישות (ServiceCalls.css). */}
        <p className="tk-muted sc-note sc-moved" role="status" aria-live="polite">{movedText}</p>

        <div className="tk-body">
          {!calls && !loadError && <p className="tk-muted">טוען…</p>}
          {calls && calls.length === 0 && (
            <p className="tk-empty">{mode === "recent" ? "לא הגיעו קריאות ב-24 השעות האחרונות"
              : mode === "history" ? "אין קריאות שנסגרו" : "✓ אין קריאות פתוחות"}</p>
          )}
          {calls?.length > 0 && (
            <ul className="tk-list sc-list"
              aria-label={mode === "recent" ? "קריאות מ-24 השעות האחרונות" : mode === "history" ? "קריאות שנסגרו" : "קריאות פתוחות"}>
              {calls.map((c) => {
                const dup = dupInfo(c);
                return (
                // ⚠️ "פתוחה"/"סגורה" ודהייה — רק ב"קריאות היום", שבה הן מעורבבות. בחלון של אתר כל השורות באותו מצב,
                // ומילה זהה על כל שורה היא רעש (והיסטוריה דהויה כולה רק קשה לקריאה).
                <li key={c.ticket} className={`sc-row${mode === "recent" && c.open === false ? " sc-row--closed" : ""}`}
                  data-ticket={c.ticket} aria-busy={busy.has(c.ticket) || undefined}>
                  <div className="sc-top">
                    {mode === "recent" && c.open != null && (
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
          {/* ⚠️ ההיסטוריה עד 100 — ונאמר, כדי שהשאר לא ייעלמו בשקט */}
          {mode === "history" && calls && total > calls.length && (
            <p className="tk-muted sc-more">מוצגות {calls.length} האחרונות מתוך {total}</p>
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
