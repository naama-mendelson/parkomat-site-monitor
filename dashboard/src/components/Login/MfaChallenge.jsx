// components/Login/MfaChallenge.jsx — הצעד השני בהתחברות.
//
// ============================================================
// ⚠️ המסך הזה נכתב **לפני** מסך הרישום, ובכוונה
// ============================================================
// מרגע שמשתמש רושם גורם שני, ה-session שלו נפתח ב-aal1 וצריך להעלות אותו.
// אילו הרישום היה עולה ראשון, המשתמש הראשון שנרשם היה מתנתק ומגיע למסך
// שאין בו איפה להקליד את הקוד — כלומר נועל את עצמו מהמערכת בפעולה שנועדה
// לאבטח אותה.
//
// ⚠️ **ויש כאן יציאה.** משתמש שאיבד את הטלפון חייב דרך החוצה שאינה "לסגור
// את הלשונית": בלי כפתור יציאה ה-session נשאר ב-localStorage, והמסך הזה
// יחזור בכל רענון לנצח. היציאה אינה מחלישה כלום — היא מחזירה לטופס
// ההתחברות, לא לדשבורד.
import { useEffect, useRef, useState } from "react";
import { listFactors, verifyCode } from "../../services/mfaDirect";
import { signOut } from "../../services/auth";
import "./Login.css";

function MfaChallenge({ onVerified }) {
  const [factorId, setFactorId] = useState(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    let alive = true;
    listFactors().then(({ factors, error: e }) => {
      if (!alive) return;
      if (e || !factors.length) { setError(e || "לא נמצא גורם אימות רשום"); return; }
      setFactorId(factors[0].id);
      inputRef.current?.focus();
    });
    return () => { alive = false; };
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (busy || !factorId) return;
    setBusy(true); setError("");
    const { ok, error: err } = await verifyCode(factorId, code);
    setBusy(false);
    if (ok) { onVerified?.(); return; }
    setError(err || "האימות נכשל");
    setCode("");
    inputRef.current?.focus();
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">אימות דו-שלבי</h1>
        <p className="login-sub">הקלד את הקוד בן שש הספרות מאפליקציית המאמת</p>

        <input
          ref={inputRef}
          className="login-field"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          // ⚠️ inputMode ולא type="number": type="number" מציג חצי גלגלת,
          // מאבד אפסים מובילים, ובאייפון פותח מקלדת עם נקודה עשרונית.
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          dir="ltr"
          style={{ textAlign: "center", letterSpacing: "0.4em", fontSize: "1.3rem" }}
          aria-label="קוד אימות"
        />

        {error && <p className="login-error" role="alert">{error}</p>}

        <button className="login-submit" type="submit" disabled={busy || code.length !== 6}>
          {busy ? "מאמת…" : "אישור"}
        </button>

        <p className="login-note">
          אין גישה למכשיר?{" "}
          <button
            type="button"
            onClick={() => signOut()}
            style={{ background: "none", border: 0, padding: 0, font: "inherit",
                     color: "inherit", textDecoration: "underline", cursor: "pointer" }}
          >
            יציאה
          </button>{" "}
          — ואז פנה למנהל לאיפוס הגורם.
        </p>
      </form>
    </div>
  );
}

export default MfaChallenge;
