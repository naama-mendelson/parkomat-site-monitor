// components/Login/Login.jsx — מסך ההתחברות.
//
// אינו מייבא supabase-js. כל האימות עובר דרך services/auth.js — ראה
// ההסבר על ה-seam שם.
import { useState } from "react";
import { signIn, sendMagicLink, requestPasswordReset } from "../../services/auth";
import "./Login.css";

function Login({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // ⚠️ מצב נפרד ולא שימוש ב-error: שליחה מוצלחת אינה שגיאה, והצגתה
  // באדום הייתה נראית ככשל בדיוק כשהכול עבד.
  const [sent, setSent] = useState(false);
  // ⚠️ מצב נפרד מ-sent: שתי הפעולות שולחות מייל, אבל ההודעה שונה —
  // "קישור כניסה" מול "קישור לאיפוס סיסמה". הודעה אחת לשתיהן הייתה
  // משאירה את המשתמשת לא בטוחה מה בדיוק נשלח לה.
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    const { user, error: err } = await signIn(email, password);

    // ההודעה מגיעה כבר מנוסחת מ-services/auth.js — היא לא מבדילה בין
    // "אימייל לא קיים" ל"סיסמה שגויה", כדי לא לגלות אילו חשבונות קיימים.
    if (err) {
      setError(err);
      setBusy(false);
      return;
    }

    // לא מכבים busy בהצלחה: המסך מתחלף, וכיבוי היה מבליח את הכפתור לרגע.
    onSignedIn?.(user);
  }

  // ============================================================
  // קישור כניסה — לא דורש סיסמה, ולא דורש הזמנה
  // ============================================================
  // ⚠️ הכפתור אינו submit ולכן אינו מפעיל את ולידציית ה-required של הטופס.
  // בלי הבדיקה כאן, לחיצה עם שדה ריק הייתה שולחת בקשה על מחרוזת ריקה
  // ומחזירה שגיאה מ-GoTrue במקום משפט מובן.
  async function handleMagicLink() {
    if (busy) return;
    if (!email.trim()) {
      setError("יש להזין אימייל כדי לקבל קישור כניסה");
      return;
    }

    setBusy(true);
    setError(null);

    const { error: err } = await sendMagicLink(email);
    setBusy(false);

    if (err) { setError(err); return; }
    setSent(true);
  }

  // ⚠️ שולח קישור **איפוס** ולא קישור כניסה. ההבדל מהותי: קישור כניסה
  // מחבר ומשאיר את הסיסמה הישנה — כלומר מי ששכח אותה יישאר תקוע באותו
  // מקום בפעם הבאה. קישור איפוס פותח את מסך קביעת הסיסמה.
  async function handleForgot() {
    setError(null);
    setSent(false);
    setBusy(true);
    const { error: err } = await requestPasswordReset(email);
    setBusy(false);
    if (err) return setError(err);
    setResetSent(true);
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">
          <img src="/parkomat-logo.png" alt="Parkomat" className="login-logo" />
          <div className="login-brand-text">
            <span className="login-mark">Parkomat</span>
            <span className="login-sub">SiteMonitor</span>
          </div>
        </div>

        <h1 className="login-title">התחברות</h1>

        <label className="login-field">
          <span>אימייל</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            autoFocus
            disabled={busy}
          />
        </label>

        <label className="login-field">
          <span>סיסמה</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={busy}
          />
        </label>

        {/* role="alert" כדי שקורא מסך יכריז על הכשל ולא רק יצבע אותו */}
        {error && <p className="login-error" role="alert">{error}</p>}

        {/* ⚠️ הודעת ההצלחה **אינה** משתמשת ב-login-error: שליחה שהצליחה
            אינה כשל, והצגתה באדום הייתה נראית כשגיאה בדיוק כשהכול עבד. */}
        {resetSent && (
          <p className="login-sent" role="status">
            נשלח קישור לאיפוס סיסמה ל-<strong>{email.trim()}</strong>.
            <span>הקישור תקף לשעה, ופותח מסך לבחירת סיסמה חדשה.</span>
          </p>
        )}

        {sent && (
          <p className="login-sent" role="status">
            נשלח קישור כניסה ל-<strong>{email.trim()}</strong>.
            <span>הקישור תקף לשעה, ופותח את המערכת בלחיצה אחת.</span>
          </p>
        )}

        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? "מתחבר…" : "התחבר"}
        </button>

        {/* ==========================================================
            קישור כניסה למייל — בלי סיסמה ובלי הזמנה
            ==========================================================
            ⚠️ type="button" ולא submit. בתוך <form> ברירת המחדל של כפתור
            היא submit, והכפתור הזה היה שולח את טופס הסיסמה במקום לבקש
            קישור — כלומר "אימייל או סיסמה שגויים" על לחיצה עליו.

            מוצג **מתחת** לסיסמה ולא מעליה: מי שכבר יש לו סיסמה ממשיך
            בהרגלו, ומי שנכנס בפעם הראשונה מגיע לכאן ממילא — ואצלו שדה
            הסיסמה ריק בכל מקרה. */}
        <div className="login-divider"><span>או</span></div>

        <button
          className="login-magic"
          type="button"
          disabled={busy}
          onClick={handleMagicLink}
        >
          <span className="login-magic-icon" aria-hidden="true">✉</span>
          שלחו לי קישור כניסה
        </button>

        {/* ⚠️ **זה היה חסר לגמרי.** שינוי סיסמה רגיל דורש את הנוכחית,
            ולכן מי ששכח אותה היה נעול בחוץ וזקוק למישהו עם מפתח ה-Secret
            של הפרויקט. זה קרה בפועל. */}
        <button
          className="login-forgot"
          type="button"
          disabled={busy}
          onClick={handleForgot}
        >
          שכחתי את הסיסמה
        </button>

        {/* ה-session נשמר ומתחדש לבד (services/supabase.js), ולכן זו אמירה
            נכונה ולא הבטחה — במסך בקרה שפתוח ימים זה מה שמונע התנתקות. */}
        <p className="login-note">
          כניסה אחת מספיקה — המסך נשאר מחובר.
          {/* אמירה מפורשת ולא הסתרה: מי שמנסה כתובת פרטית יקבל שגיאה מ-GoTrue
              בלי הסבר, ועדיף שידע מראש. הכלל נאכף במסד, לא כאן. */}
          <br />כניסה בכתובת <strong>@parkomat.co.il</strong> בלבד.
        </p>
      </form>
    </div>
  );
}

export default Login;
