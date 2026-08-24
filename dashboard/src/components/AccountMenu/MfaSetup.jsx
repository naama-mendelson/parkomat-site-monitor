// components/AccountMenu/MfaSetup.jsx — רישום גורם שני, מתוך תפריט החשבון.
//
// ============================================================
// למה כאן ולא במסך ניהול נפרד
// ============================================================
// גורם שני שייך למשתמש עצמו, לא לניהול: מנהל אינו יכול — ואינו צריך —
// לרשום טלפון של מישהו אחר. תפריט החשבון הוא כבר המקום שבו יושב "שינוי
// סיסמה", ושתי הפעולות הן אותו דבר בדיוק: מה שאני מחזיק כדי להיכנס.
//
// ⚠️ אינו מייבא supabase-js — הכל דרך services/mfaDirect.js (כלל 5).
import { useEffect, useState } from "react";
import { listFactors, startEnroll, confirmEnroll, removeFactor } from "../../services/mfaDirect";

function MfaSetup({ onChanged }) {
  const [factors, setFactors] = useState(null);   // null = עדיין נטען
  const [enroll, setEnroll] = useState(null);     // { id, qr, secret }
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  const refresh = () => listFactors().then(({ factors: f }) => setFactors(f));
  useEffect(() => { refresh(); }, []);

  async function begin() {
    setBusy(true); setError("");
    const r = await startEnroll();
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    setEnroll(r);
  }

  async function finish(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    const { ok, error: err } = await confirmEnroll(enroll.id, code);
    setBusy(false);
    if (!ok) { setError(err); setCode(""); return; }
    setEnroll(null); setCode("");
    await refresh();
    onChanged?.();
  }

  async function drop(id) {
    // ============================================================
    // ⚠️ אישור, ולא הסרה בלחיצה אחת
    // ============================================================
    // הסרת הגורם מורידה את החשבון בחזרה לסיסמה בלבד. זו הפעולה היחידה כאן
    // שמחלישה אבטחה, והיא נמצאת שתי לחיצות מהיציאה — כלומר בדיוק במקום
    // שבו לחיצה שגויה סבירה.
    if (!window.confirm("להסיר את האימות הדו-שלבי? החשבון יחזור להגנת סיסמה בלבד.")) return;
    setBusy(true); setError("");
    const { ok, error: err } = await removeFactor(id);
    setBusy(false);
    if (!ok) { setError(err); return; }
    await refresh();
    onChanged?.();
  }

  if (factors === null) return <div className="account-item" aria-busy="true">בודק…</div>;

  // ---- רשום ----
  if (factors.length && !enroll) {
    return (
      <div className="account-mfa">
        <div className="account-mfa-status account-mfa-status--on">אימות דו-שלבי פעיל</div>
        {error && <p className="account-mfa-error" role="alert">{error}</p>}
        <button className="account-item" onClick={() => drop(factors[0].id)} disabled={busy}>
          הסרת האימות הדו-שלבי
        </button>
      </div>
    );
  }

  // ---- באמצע רישום ----
  if (enroll) {
    return (
      <form className="account-mfa" onSubmit={finish}>
        <p className="account-mfa-step">1. סרוק באפליקציית מאמת (Google Authenticator, Authy, 1Password)</p>
        {/* ⚠️ ה-QR הוא data-URI של SVG שמגיע מ-Supabase — אין כאן ספריית QR
            ואין בקשה לשרת חיצוני. */}
        {enroll.qr && <img className="account-mfa-qr" src={enroll.qr} alt="קוד QR לרישום" width={180} height={180} />}

        <button type="button" className="account-mfa-link" onClick={() => setShowSecret((v) => !v)}>
          {showSecret ? "הסתר" : "אין מצלמה? הקלד את המפתח"}
        </button>
        {/* ⚠️ נדרש: מסך קיר בחדר בקרה אינו תמיד מול טלפון עם מצלמה פנויה. */}
        {showSecret && <code className="account-mfa-secret" dir="ltr">{enroll.secret}</code>}

        <p className="account-mfa-step">2. הקלד את הקוד שהאפליקציה מציגה</p>
        <input
          className="account-mfa-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          dir="ltr"
          aria-label="קוד אימות"
        />
        {error && <p className="account-mfa-error" role="alert">{error}</p>}
        <button className="account-item" type="submit" disabled={busy || code.length !== 6}>
          {busy ? "מאמת…" : "סיום"}
        </button>
        <button type="button" className="account-mfa-link" onClick={() => { setEnroll(null); setError(""); }}>
          ביטול
        </button>
      </form>
    );
  }

  // ---- לא רשום ----
  return (
    <div className="account-mfa">
      <div className="account-mfa-status">אימות דו-שלבי כבוי</div>
      {error && <p className="account-mfa-error" role="alert">{error}</p>}
      <button className="account-item" onClick={begin} disabled={busy}>
        {busy ? "מכין…" : "הפעלת אימות דו-שלבי"}
      </button>
    </div>
  );
}

export default MfaSetup;
