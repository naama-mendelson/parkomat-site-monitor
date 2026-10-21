// components/TechPhone/TechPhone.jsx — מה שהטכנאי רואה בטלפון (21/10/2026, שלבים 2 ו-4 של "צא ל:").
//
// בעלת המוצר: "בסופו של דבר אני רוצה שזה יצפצף לאותו טכנאי". הטלפון מחובר מסריקת ה-QR שבכרטיס, ומציג רק דבר אחד:
// המשימה הפתוחה שלו — לאן, מה, מי שלח ומתי, וניווט. לא את הדשבורד: המשתמש של הטלפון בתפקיד 'technician', שהמסד לא
// נותן לו לקרוא דבר חוץ מ-tech_me.
//
// • "הפעלת צפצוף" (שלב 4): Web Push. כשנשלחת משימה הטלפון מצפצף ורוטט גם כשהאפליקציה סגורה, וחוזר כל 2 דקות עד 3
//   פעמים — עד "קיבלתי". ההרשאה דורשת לחיצה, ולכן כפתור. הרשאה שכבר ניתנה — המנוי נשלח למסד שוב בכל כניסה (syncTechPush).
// • "קיבלתי": מפסיק את הצפצוף, והכרטיס אצל הרכז אומר "קיבל 10:43".
// ⚠️ שואל את tech_me כל 30 שניות, רק כשהמסך גלוי, מיד כשחוזרים אליו, ומיד כשמגיע צפצוף והאפליקציה פתוחה (הודעה מה-SW).
// ⚠️ ניתוק מהכרטיס מחזיר כאן 42501: המסך אומר מה לעשות (QR חדש מהרכז), ולא מנסה שוב לנצח.
import { useCallback, useEffect, useRef, useState } from "react";
import { ackDispatch, fetchTechMe } from "../../services/dataSource";
import { enableTechPush, syncTechPush, techPushState } from "../../services/techPush";
import { forgetDevice } from "../../services/techDevice";
import { destText, dispatchLine } from "../../utils/technicians";
import { clockText } from "../../utils/vehicles";
import { navLink } from "../../utils/techPhone";
import "./TechPhone.css";

const POLL_MS = 30_000;

function Task({ d, now, onAck, acking, ackError }) {
  const nav = navLink(d);
  return (
    <section className="tp-task" aria-label="המשימה">
      <p className="tp-task-k">משימה</p>
      <h2 className="tp-task-dest">{destText(d)}</h2>
      {d.details && <p className="tp-task-text">{d.details}</p>}
      <p className="tp-task-meta">{dispatchLine(d, now)}</p>
      {d.acked_at ? (
        <p className="tp-acked">✓ קיבלת ב-{clockText(d.acked_at, now)}</p>
      ) : (
        <button type="button" className="tp-ack" onClick={onAck} disabled={acking}>{acking ? "שולח…" : "קיבלתי"}</button>
      )}
      {ackError && <p className="tp-warn" role="alert">{ackError}</p>}
      {nav && <a className="tp-nav" href={nav} target="_blank" rel="noopener noreferrer">ניווט לאתר (Waze)</a>}
    </section>
  );
}

// הצפצוף: מה המצב בטלפון הזה, ומה לעשות
function PushBar({ state, busy, error, onEnable }) {
  if (state === "granted") return <p className="tp-push tp-push--on">✓ צפצוף מופעל — הטלפון יצפצף כשתגיע משימה</p>;
  if (state === "denied") {
    return (
      <p className="tp-push tp-push--off" role="alert">
        הצפצוף חסום בהגדרות הטלפון. להפעלה: הגדרות ← אפליקציות ← Chrome (או האפליקציה) ← התראות ← לאפשר.
      </p>
    );
  }
  if (state === "unsupported") {
    return <p className="tp-push tp-push--off">הטלפון הזה לא תומך בצפצוף מהדפדפן. כדאי להתקין את האפליקציה מתפריט Chrome (⋮ ← התקנה).</p>;
  }
  return (
    <div className="tp-push tp-push--ask">
      <p>כדי שהטלפון יצפצף כשתגיע משימה — צריך להפעיל צפצוף, פעם אחת.</p>
      <button type="button" className="tp-primary" onClick={onEnable} disabled={busy}>{busy ? "מפעיל…" : "הפעלת צפצוף"}</button>
      {error && <p className="tp-warn" role="alert">{error}</p>}
    </div>
  );
}

export default function TechPhone() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [armed, setArmed] = useState(false);
  const [push, setPush] = useState(() => techPushState());
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState(null);
  const [acking, setAcking] = useState(false);
  const [ackError, setAckError] = useState(null);
  const armTimer = useRef(null);
  const synced = useRef(false);

  const load = useCallback(async () => {
    try { setMe(await fetchTechMe()); setError(null); }
    catch (e) { setError({ message: e?.message || "אין חיבור", code: e?.code ?? null }); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    const onMsg = (e) => { if (e?.data?.type === "dispatch") load(); };
    document.addEventListener("visibilitychange", onVis);
    navigator.serviceWorker?.addEventListener?.("message", onMsg);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      navigator.serviceWorker?.removeEventListener?.("message", onMsg);
      clearTimeout(armTimer.current);
    };
  }, [load]);

  // הרשאה שכבר ניתנה — לוודא פעם אחת שהמסד מכיר את המנוי (אחרי QR חדש המנויים הקודמים נמחקו)
  useEffect(() => {
    if (!me || synced.current || push !== "granted") return;
    synced.current = true;
    syncTechPush().catch(() => { synced.current = false; });
  }, [me, push]);

  const enable = async () => {
    setPushBusy(true);
    setPushError(null);
    try { setPush(await enableTechPush()); load(); }
    catch (e) { setPushError(e?.message || "ההפעלה נכשלה — נסו שוב"); }
    finally { setPushBusy(false); }
  };

  const ack = async () => {
    if (!me?.dispatch) return;
    setAcking(true);
    setAckError(null);
    try { await ackDispatch(me.dispatch.id); await load(); }
    catch (e) { setAckError(e?.message || "לא נשלח — נסו שוב"); if (e?.code === "PT409" || e?.code === "PT404") load(); }
    finally { setAcking(false); }
  };

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
          {me && <PushBar state={push} busy={pushBusy} error={pushError} onEnable={enable} />}
          {me && (me.dispatch
            ? <Task d={me.dispatch} now={me.now} onAck={ack} acking={acking} ackError={ackError} />
            : <p className="tp-idle">אין משימה כרגע</p>)}
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
