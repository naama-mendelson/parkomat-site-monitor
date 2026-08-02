// components/Login/Login.jsx — מסך ההתחברות.
//
// אינו מייבא supabase-js. כל האימות עובר דרך services/auth.js — ראה
// ההסבר על ה-seam שם.
import { useState } from "react";
import { signIn } from "../../services/auth";
import "./Login.css";

function Login({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

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

        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? "מתחבר…" : "התחבר"}
        </button>

        {/* ה-session נשמר ומתחדש לבד (services/supabase.js), ולכן זו אמירה
            נכונה ולא הבטחה — במסך בקרה שפתוח ימים זה מה שמונע התנתקות. */}
        <p className="login-note">כניסה אחת מספיקה — המסך נשאר מחובר.</p>
      </form>
    </div>
  );
}

export default Login;
