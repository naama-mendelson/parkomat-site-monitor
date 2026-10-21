// components/Vehicles/TechPhoneDialog.jsx — "טלפון" בכרטיס הטכנאי: QR לחיבור הטלפון שלו, ניתוק (21/10/2026, שלב 2).
//
// בעלת המוצר בחרה "סריקת QR מהכרטיס". ה-QR נושא קישור לדשבורד עם פרטי ההתחברות של הטלפון (אחרי #), נוצר כאן בדפדפן
// (qrcode-generator, chunk עצל) — הקישור לא יוצא לשום שירות. הסיסמה מוצגת פעם אחת: סגירת החלון מוחקת אותה, וחיבור
// נוסף הוא QR חדש. אחרי הסריקה הטלפון מחליף אותה, כך שצילום של ה-QR לא יעבוד שוב.
// ⚠️ "QR חדש" ו"ניתוק" בשתי לחיצות: הטלפון הנוכחי מתנתק מיד (המשתמש שלו מושבת במסד), גם באמצע עבודה.
// ⚠️ אחרי יצירת QR החלון שואל את הלוח כל 4 שניות, רק בזמן שהוא פתוח — כדי להגיד "✓ הטלפון התחבר" ברגע שנסרק.
import { useEffect, useRef, useState } from "react";
import { fetchTechBoard, provisionTechPhone, saveTechnician, unpairTechPhone } from "../../services/dataSource";
import { vehicleName } from "../../utils/vehicles";
import { pairLink, phoneStatus, qrPath } from "../../utils/techPhone";
import "./DispatchDialog.css";

const POLL_MS = 4000;

function Qr({ text }) {
  const [svg, setSvg] = useState(null);
  useEffect(() => {
    let alive = true;
    import("qrcode-generator").then(({ default: qrcode }) => {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      if (alive) setSvg(qrPath(qr));
    });
    return () => { alive = false; };
  }, [text]);
  if (!svg) return <div className="dp-qr dp-qr--wait">יוצר QR…</div>;
  return (
    <svg className="dp-qr" viewBox={`0 0 ${svg.size} ${svg.size}`} role="img" aria-label="QR לחיבור הטלפון" shapeRendering="crispEdges">
      <rect width={svg.size} height={svg.size} fill="#fff" />
      <path d={svg.d} fill="#000" />
    </svg>
  );
}

export default function TechPhoneDialog({ vehicle, tech, now, onClose, onChanged }) {
  const [name, setName] = useState(() => (tech ? tech.name : vehicleName(vehicle)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [qr, setQr] = useState(null);              // { link, name, at } — רק בזיכרון של החלון
  const [scanned, setScanned] = useState(false);
  const [armed, setArmed] = useState(null);        // "qr" | "unpair"
  const armTimer = useRef(null);
  const created = useRef(null);
  const effTech = tech ?? created.current;
  const status = phoneStatus(tech?.phone, now);
  const paired = Boolean(tech?.phone?.paired);

  useEffect(() => () => clearTimeout(armTimer.current), []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // אחרי QR: מחכים לסריקה (phone.seen_at מתמלא כשהטלפון פונה למסד)
  useEffect(() => {
    if (!qr || scanned || !effTech?.id) return undefined;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const b = await fetchTechBoard();
        const me = b?.technicians?.find((x) => x.id === effTech.id);
        if (alive && me?.phone?.seen_at) { setScanned(true); onChanged?.(); }
      } catch { /* ננסה שוב */ }
    }, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [qr, scanned, effTech?.id, onChanged]);

  const arm = (k) => {
    setArmed(k);
    clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmed(null), 4000);
  };

  async function makeQr() {
    if (paired && armed !== "qr") { arm("qr"); return; }
    setArmed(null);
    setBusy(true);
    setError(null);
    try {
      let id = effTech?.id ?? null;
      if (!id) {
        const r = await saveTechnician({ name: name.trim(), plate: vehicle.plate });
        created.current = { id: r.id, rev: r.rev, name: name.trim() };
        id = r.id;
      }
      const r = await provisionTechPhone(id);
      setQr({ link: pairLink(window.location.origin, r.email, r.password), name: r.name || name.trim(), warning: r.warning ?? null });
      setScanned(false);
      onChanged?.();
    } catch (e) {
      setError(e?.message || "יצירת ה-QR נכשלה — נסו שוב");
      if (e?.stale) onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  async function unpair() {
    if (armed !== "unpair") { arm("unpair"); return; }
    setArmed(null);
    setBusy(true);
    setError(null);
    try { await unpairTechPhone(effTech.id); setQr(null); onChanged?.(); onClose(); }
    catch (e) { setError(e?.message || "הניתוק נכשל — נסו שוב"); }
    finally { setBusy(false); }
  }

  const title = effTech?.name ?? (name.trim() || vehicleName(vehicle));

  return (
    <div className="dp-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dp dp--phone" role="dialog" aria-modal="true" aria-labelledby="tpd-title">
        <header className="dp-head">
          <h3 id="tpd-title">הטלפון של <span className="dp-who">{title}</span></h3>
          <button type="button" className="dp-x" aria-label="סגירה" onClick={onClose} disabled={busy}>✕</button>
        </header>

        {qr ? (
          <div className="dp-qr-box">
            <Qr text={qr.link} />
            {scanned ? (
              <p className="dp-ok" role="status">✓ הטלפון התחבר</p>
            ) : (
              <ol className="dp-steps">
                <li>לפתוח את המצלמה בטלפון של {qr.name} ולכוון ל-QR.</li>
                <li>לגעת בקישור שמופיע — הטלפון יתחבר לבד, ויראה את המשימות שלו.</li>
                <li className="dp-muted">ה-QR עובד לסריקה אחת. אחרי הסגירה הוא לא יוצג שוב.</li>
              </ol>
            )}
            {qr.warning && <p className="dp-hint">{qr.warning}</p>}
          </div>
        ) : (
          <>
            {!effTech && (
              <label className="dp-field">
                <span className="dp-label">מי הטכנאי ברכב הזה?</span>
                <input className="dp-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                <span className="dp-hint">נשמר לפעם הבאה · רכב {vehicle.plate}</span>
              </label>
            )}
            <p className={`dp-phone-st dp-phone-st--${status.key}`}>{status.text}</p>
            {paired && armed === "qr" && <p className="dp-open">QR חדש ינתק מיד את הטלפון שמחובר עכשיו.</p>}
          </>
        )}

        {error && <p className="dp-err" role="alert">{error}</p>}

        <footer className="dp-foot">
          {qr ? (
            <button type="button" className="dp-send" onClick={onClose}>{scanned ? "סגירה" : "סיימתי"}</button>
          ) : (
            <>
              <button type="button" className="dp-send" onClick={makeQr} disabled={busy || name.trim().length < 2}>
                {busy ? "יוצר…" : paired ? (armed === "qr" ? "QR חדש — לחיצה נוספת" : "QR חדש") : "יצירת QR לטלפון"}
              </button>
              {paired && (
                <button type="button" className={`dp-cancel${armed === "unpair" ? " is-armed" : ""}`} onClick={unpair} disabled={busy}>
                  {armed === "unpair" ? "לנתק? לחיצה נוספת" : "ניתוק טלפון"}
                </button>
              )}
              <button type="button" className="dp-cancel" onClick={onClose} disabled={busy}>סגירה</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
