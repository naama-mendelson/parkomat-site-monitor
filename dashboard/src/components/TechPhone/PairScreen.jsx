// components/TechPhone/PairScreen.jsx — הטלפון נפתח מסריקת ה-QR שבכרטיס הטכנאי (21/10/2026).
//
// מתחבר בפרטים שב-QR, מחליף את הסיסמה בסיסמה שרק הטלפון יודע (services/techDevice), ומוחק את הפרטים מהכתובת.
// ⚠️ דפדפן שכבר מחובר כאדם (רכז שסרק בטעות את ה-QR במחשב שלו) — נשאל קודם: החיבור מוציא אותו מהחשבון שלו.
import { useEffect, useRef, useState } from "react";
import { pairThisDevice } from "../../services/techDevice";
import { isTechPhoneEmail } from "../../utils/techPhone";
import "./TechPhone.css";

export default function PairScreen({ cred, user, loading, onDone }) {
  const other = Boolean(user) && !isTechPhoneEmail(user.email);
  const [stage, setStage] = useState("wait");     // wait | ask | pairing | error
  const [error, setError] = useState(null);
  const started = useRef(false);

  const start = async () => {
    if (started.current) return;
    started.current = true;
    setStage("pairing");
    const r = await pairThisDevice(cred);
    if (r.ok) onDone();
    else { setError(r.error); setStage("error"); }
  };

  useEffect(() => {
    if (loading || stage !== "wait") return;
    if (other) setStage("ask");
    else start();
  }, [loading, other, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tp tp--center" dir="rtl">
      <img className="tp-logo tp-logo--big" src="/parkomat-logo.png" alt="Parkomat" />
      {stage === "ask" && (
        <section className="tp-off">
          <p><b>חיבור הטלפון של הטכנאי</b></p>
          <p>הדפדפן הזה מחובר כ-{user.email}. חיבור כטלפון של טכנאי יוציא אותו מהחשבון הזה.</p>
          <div className="tp-row">
            <button type="button" className="tp-primary" onClick={start}>לחבר כטלפון של טכנאי</button>
            <button type="button" onClick={onDone}>ביטול</button>
          </div>
        </section>
      )}
      {(stage === "wait" || stage === "pairing") && <p className="tp-idle" role="status">מחבר את הטלפון…</p>}
      {stage === "error" && (
        <section className="tp-off" role="alert">
          <p><b>החיבור נכשל.</b></p>
          <p>{error}</p>
          <div className="tp-row"><button type="button" onClick={onDone}>סגירה</button></div>
        </section>
      )}
    </div>
  );
}
