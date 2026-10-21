// components/TechPhone/TechPhone.jsx — מה שהטכנאי רואה בטלפון (21/10/2026, שלב 2 של "צא ל:").
//
// בעלת המוצר: "בסופו של דבר אני רוצה שזה יצפצף לאותו טכנאי". הטלפון מחובר מסריקת ה-QR שבכרטיס, ומציג רק דבר אחד:
// המשימה הפתוחה שלו — לאן, מה, מי שלח ומתי, וניווט. לא את הדשבורד: המשתמש של הטלפון בתפקיד 'technician', שהמסד לא
// נותן לו לקרוא דבר חוץ מ-tech_me.
//
// ⚠️ שואל את tech_me כל 30 שניות, רק כשהמסך גלוי, ומיד כשחוזרים אליו. הצפצוף כשהאפליקציה סגורה — בשלב 4 (Web Push).
// ⚠️ ניתוק מהכרטיס מחזיר כאן 42501: המסך אומר מה לעשות (QR חדש מהרכז), ולא מנסה שוב לנצח.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTechMe } from "../../services/dataSource";
import { forgetDevice } from "../../services/techDevice";
import { destText, dispatchLine } from "../../utils/technicians";
import { navLink } from "../../utils/techPhone";
import "./TechPhone.css";

const POLL_MS = 30_000;

function Task({ d, now }) {
  const nav = navLink(d);
  return (
    <section className="tp-task" aria-label="המשימה">
      <p className="tp-task-k">משימה</p>
      <h2 className="tp-task-dest">{destText(d)}</h2>
      {d.details && <p className="tp-task-text">{d.details}</p>}
      <p className="tp-task-meta">{dispatchLine(d, now)}</p>
      {nav && <a className="tp-nav" href={nav} target="_blank" rel="noopener noreferrer">ניווט לאתר (Waze)</a>}
    </section>
  );
}

export default function TechPhone() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef(null);

  const load = useCallback(async () => {
    try { setMe(await fetchTechMe()); setError(null); }
    catch (e) { setError({ message: e?.message || "אין חיבור", code: e?.code ?? null }); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); clearTimeout(armTimer.current); };
  }, [load]);

  const unpaired = error?.code === "42501";
  const forget = () => {
    if (!armed) {
      setArmed(true);
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    forgetDevice();
  };

  return (
    <div className="tp" dir="rtl">
      <header className="tp-head">
        <img className="tp-logo" src="/parkomat-logo.png" alt="" />
        <div className="tp-who">
          <h1>{me?.name ?? (unpaired ? "הטלפון אינו מחובר" : "טוען…")}</h1>
          {me?.plate && <span>רכב {me.plate}</span>}
        </div>
      </header>

      {unpaired ? (
        <section className="tp-off" role="alert">
          <p><b>הטלפון נותק מהכרטיס של הטכנאי.</b></p>
          <p>כדי לחבר אותו שוב — לבקש מהרכז QR חדש, ולסרוק אותו במצלמה של הטלפון.</p>
        </section>
      ) : (
        <>
          {error && <p className="tp-warn" role="status">אין חיבור כרגע — מנסה שוב…</p>}
          {me && (me.dispatch ? <Task d={me.dispatch} now={me.now} /> : <p className="tp-idle">אין משימה כרגע</p>)}
        </>
      )}

      <footer className="tp-foot">
        <button type="button" className={armed ? "is-armed" : ""} onClick={forget}>
          {armed ? "לנתק את הטלפון הזה? לחיצה נוספת" : "ניתוק הטלפון הזה"}
        </button>
      </footer>
    </div>
  );
}
