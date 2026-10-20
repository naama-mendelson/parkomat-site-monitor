// components/Login/LoginCode.jsx — הצעד השני בהתחברות: קוד בן 4 ספרות שנשלח למייל (20/10/2026).
//
// בעלת המוצר: "כל פעם כשמישהו רוצה להיכנס לדשבורד נשלח לו מהדשבורד למייל שהוא חיבר כשהוא נרשם מייל עם קוד בן 4
// ספרות". המסך נפתח אחרי הסיסמה, שולח את הקוד מעצמו, ומחכה לו.
//
// ⚠️ **פתיחה מחדש של המסך אינה שולחת קוד נוסף** כשיש קוד בתוקף (רענון, לשונית שנייה) — המסד עונה 'pending', והמסך
// אומר שהקוד כבר נשלח. "שלח קוד חדש" מפורש, ופעם בדקה לכל היותר.
//
// ⚠️ **ויש כאן יציאה**, מאותה סיבה כמו במסך האימות הקודם: מי שאין לו גישה למייל חייב דרך החוצה שאינה "לסגור את
// הלשונית" — אחרת ה-session נשאר ב-localStorage והמסך הזה חוזר בכל רענון.
import { useCallback, useEffect, useRef, useState } from "react";
import { sendLoginCode, verifyLoginCode } from "../../services/loginCodeDirect";
import { signOut } from "../../services/auth";
import { CODE_LENGTH, codeDigits, needsNewCode, sentText, verifyErrorText } from "../../utils/loginCode";
import "./Login.css";

function LoginCode({ email, onVerified }) {
  const [sent, setSent] = useState(null);          // תשובת השליחה האחרונה שהצליחה
  const [sending, setSending] = useState(true);
  const [digits, setDigits] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);       // הקוד שבידיו כבר אינו טוב — צריך חדש
  const [busy, setBusy] = useState(false);
  // ⚠️ מועד ולא מונה שיורד: לשונית ברקע מאטה טיימרים, ומונה של "פחות אחד בכל שנייה" היה מפגר אחרי הזמן האמיתי
  const [resendAt, setResendAt] = useState(0);
  const [, setTick] = useState(0);
  const resendIn = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
  const setResendIn = (s) => setResendAt(Date.now() + Math.max(0, Number(s) || 0) * 1000);
  const inputRef = useRef(null);
  const busyRef = useRef(false);
  // ⚠️ ב-ref ולא בתלויות: AuthGate מעביר פונקציה חדשה בכל רינדור (כל חידוש אסימון), ו-send שתלויה בה הייתה שולחת
  // בקשה חדשה בכל פעם
  const doneRef = useRef(onVerified);
  doneRef.current = onVerified;

  const focus = () => setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);

  const send = useCallback(async (resend) => {
    setSending(true);
    setError("");
    const r = await sendLoginCode({ resend });
    setSending(false);
    if (r.status === "verified" || r.status === "not_required") { doneRef.current(); return; }
    if (r.error) {
      setError(r.error);
      if (typeof r.resend_in === "number") setResendIn(r.resend_in);
      return;
    }
    setSent(r);
    setStale(false);
    setResendIn(Number(r.resend_in) || 0);
    setDigits("");
    focus();
  }, []);

  // שליחה אחת בפתיחה. ⚠️ ב-StrictMode זה רץ פעמיים בפיתוח — השנייה מקבלת 'pending' מהמסד, ולא נשלח מייל שני.
  useEffect(() => { send(false); }, [send]);

  useEffect(() => {
    if (resendAt <= Date.now()) return undefined;
    const t = setInterval(() => {
      setTick((n) => n + 1);
      if (Date.now() >= resendAt) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [resendAt]);

  async function submit(code) {
    if (busyRef.current || code.length !== CODE_LENGTH) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const r = await verifyLoginCode(code);
    if (r.ok) { await doneRef.current(); return; }   // נשאר "בודק…" עד שהדשבורד עולה במקום המסך
    busyRef.current = false;
    setBusy(false);
    setError(verifyErrorText(r));
    setStale(needsNewCode(r));
    setDigits("");
    focus();
  }

  function onChange(e) {
    const d = codeDigits(e.target.value);
    setDigits(d);
    if (d.length === CODE_LENGTH) submit(d);   // ארבע ספרות — שולחים מיד, בלי לחיצה
  }

  const canResend = !sending && resendIn <= 0;

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => { e.preventDefault(); submit(digits); }}>
        <div className="login-brand">
          <img src="/parkomat-logo.png" alt="Parkomat" className="login-logo" />
          <div className="login-brand-text">
            <span className="login-mark">Parkomat</span>
            <span className="login-sub">SiteMonitor</span>
          </div>
        </div>

        <h1 className="login-title">קוד כניסה</h1>
        <p className="login-code-info" aria-live="polite">
          {sending && !sent ? "שולחים קוד למייל…" : sentText(sent, email)}
        </p>

        <label className="login-field">
          <span>קוד בן {CODE_LENGTH} ספרות</span>
          <input
            ref={inputRef}
            className="login-code-input"
            value={digits}
            onChange={onChange}
            // ⚠️ inputMode ולא type="number": type="number" מאבד אפסים מובילים, ובאייפון פותח מקלדת עם נקודה
            inputMode="numeric"
            autoComplete="one-time-code"
            // ⚠️ בלי maxLength: הדבקה של שורת הנושא ("קוד הכניסה לדשבורד: 0427") נחתכה לפני הספרות. codeDigits מגביל ל-4.
            placeholder={"0".repeat(CODE_LENGTH)}
            dir="ltr"
            disabled={busy}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? "login-code-error" : undefined}
          />
        </label>

        {error && <p className="login-error" id="login-code-error" role="alert">{error}</p>}

        <button className="login-submit" type="submit" disabled={busy || digits.length !== CODE_LENGTH}>
          {busy ? "בודק…" : "כניסה"}
        </button>

        <div className="login-code-actions">
          <button type="button" className={`login-link${stale ? " is-strong" : ""}`}
                  disabled={!canResend} onClick={() => send(true)}>
            {sending && sent ? "שולח…" : resendIn > 0 ? `שלח קוד חדש (${resendIn})` : "שלח קוד חדש"}
          </button>
          <button type="button" className="login-link" onClick={() => signOut()}>יציאה</button>
        </div>

        <p className="login-note">
          לא הגיע? כדאי לבדוק גם בדואר הזבל. השולח: <bdi>dashboard@parkomat.co.il</bdi>
        </p>
      </form>
    </div>
  );
}

export default LoginCode;

/** כשהבדיקה אם צריך קוד נכשלה (רשת) — לא מנחשים: מנסים שוב, או יוצאים. */
export function LoginCodeCheckFailed({ message, onRetry }) {
  return (
    <div className="login-screen">
      <div className="login-card">
        <h1 className="login-title">לא הצלחנו לבדוק את ההתחברות</h1>
        <p className="login-error" role="alert">{message || "אין חיבור"}</p>
        <button className="login-submit" type="button" onClick={onRetry}>נסו שוב</button>
        <div className="login-code-actions">
          <button type="button" className="login-link" onClick={() => signOut()}>יציאה</button>
        </div>
      </div>
    </div>
  );
}
