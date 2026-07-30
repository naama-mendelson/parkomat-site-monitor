// components/Login/Login.jsx — מסך ההתחברות.
//
// אינו מייבא supabase-js. כל האימות עובר דרך services/auth.js — ראה
// ההסבר על ה-seam שם.
import { useEffect, useState } from "react";
import { signIn, signInWithGoogle, enabledProviders } from "../../services/auth";
import "./Login.css";

// לוגו Google בצבעים הרשמיים. inline SVG ולא קובץ חיצוני: ה-CSP של
// הדשבורד חוסם מקורות חוץ, וגם אין סיבה לסבב רשת עבור אייקון.
function GoogleMark() {
  return (
    <svg className="login-google-mark" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H1.02v2.34A8.99 8.99 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H1.02a8.99 8.99 0 0 0 0 8.12l2.96-2.34z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A8.99 8.99 0 0 0 1.02 4.94l2.96 2.34C4.68 5.16 6.66 3.58 9 3.58z"/>
    </svg>
  );
}

function Login({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // ספק שאינו מופעל לא מקבל כפתור — לחיצה עליו הייתה מנווטת לעמוד שגיאה
  // ריק, ולא ניתן להציג הודעה אחרי שהדף עזב. ראה enabledProviders.
  const [google, setGoogle] = useState(false);

  // האם המשתמש ביקש במפורש את מסלול הסיסמה. כשאין Google אין מה לבקש —
  // showPassword מחשב את שני המצבים במקום אחד, כדי שהטופס לא יוכל להיעלם
  // ולהשאיר מסך בלי שום דרך להיכנס.
  const [pwMode, setPwMode] = useState(false);
  const showPassword = !google || pwMode;

  useEffect(() => {
    let alive = true;
    enabledProviders().then((p) => { if (alive) setGoogle(p.google); });
    return () => { alive = false; };
  }, []);

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

        {/* ============================================================
            Google ראשי, סיסמה מקופלת מתחתיו
            ============================================================
            קודם הסיסמה הייתה הדרך הראשית ו-Google נספח מתחתיה. זה הפוך:
            Google הוא לחיצה אחת בלי סיסמה לזכור ובלי סיסמה להחליף, והוא גם
            היחיד שמוכיח שהאדם באמת שולט בתיבת הדואר של פרקומט.

            כשהספק כבוי אין מה לקפל — הטופס מוצג ישר, אחרת המסך היה ריק. */}
        {google && (
          <>
            {/* type="button" ולא submit — אחרת לחיצה עליו שולחת את הטופס */}
            <button
              className="login-google"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const { error: err } = await signInWithGoogle();
                // הצלחה מנווטת את הדפדפן ל-Google, ולכן אין כאן מסלול
                // "הצליח": אם חזרנו לכאן בכלל — משהו נכשל.
                if (err) {
                  setError(err);
                  setBusy(false);
                }
              }}
            >
              <GoogleMark />
              המשך עם Google
            </button>

            <p className="login-note">
              כניסה אחת מספיקה — המסך נשאר מחובר.
            </p>

            {!pwMode && (
              <button className="login-alt" type="button" onClick={() => setPwMode(true)}>
                התחברות עם סיסמה
              </button>
            )}

            {pwMode && <div className="login-divider"><span>או</span></div>}
          </>
        )}

        {showPassword && (
          <>
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

            <button className="login-submit" type="submit" disabled={busy}>
              {busy ? "מתחבר…" : "התחבר"}
            </button>
          </>
        )}

        {/* role="alert" כדי שקורא מסך יכריז על הכשל ולא רק יצבע אותו.
            מחוץ לתנאי: שגיאת Google צריכה להופיע גם כשהטופס מקופל. */}
        {error && <p className="login-error" role="alert">{error}</p>}
      </form>
    </div>
  );
}

export default Login;
