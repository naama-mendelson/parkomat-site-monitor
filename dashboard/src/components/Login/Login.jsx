// components/Login/Login.jsx — מסך ההתחברות.
//
// אינו מייבא supabase-js. כל האימות עובר דרך services/auth.js — ראה
// ההסבר על ה-seam שם.
import { useState } from "react";
import { signIn } from "../../services/auth";
// ⚠️ מיובא ישירות מהמנוע ולא דרך hook: הוא חי מחוץ ל-React בכוונה, ומסך
// ההתחברות אינו צריך להירשם למצב שלו — רק לשחרר פעם אחת.
import { unlockAudio } from "../../utils/audio/alerts";
import "./Login.css";

function Login({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;

    // ============================================================
    // ⚠️ משחררים את האודיו **כאן**, ולפני ה-await
    // ============================================================
    // הדפדפן מתיר להפעיל קול רק בתוך מחווה של המשתמש, ובמסך קיר שאיש
    // אינו נוגע בו המחווה הזו פשוט לא מגיעה — ואז תקלה עוברת בשקט.
    //
    // ההתחברות היא המחווה **היחידה שמובטחת**: אין דרך להיכנס למערכת
    // בלעדיה. לכן זו נקודת השחרור הטובה ביותר שיש.
    //
    // ⚠️ **ולפני ה-await, וזה לא סגנון.** הרשאת המחווה תקפה רק בתוך
    // הטיפול באירוע; אחרי המתנה לרשת (מאות מילישניות) חלק מהדפדפנים כבר
    // אינם רואים את הקריאה כמחווה, ו-resume() נדחה. שחרור אחרי signIn
    // היה עובד בפיתוח מול שרת מקומי מהיר ונשבר באתר.
    //
    // ⚠️ ומשחררים גם כשההתחברות תיכשל — זה בסדר: השחרור אינו מדליף כלום
    // ואינו משמיע דבר בפני עצמו. התניה על הצלחה הייתה מחזירה את התלות
    // ב-await שממנה בדיוק ברחנו.
    unlockAudio(true);

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
        <p className="login-note">
          כניסה אחת מספיקה — המסך נשאר מחובר.
          {/* אמירה מפורשת ולא הסתרה: מי שמנסה כתובת פרטית יקבל שגיאה מ-GoTrue
              בלי הסבר, ועדיף שידע מראש. הכלל נאכף במסד, לא כאן. */}
          <br />כניסה בכתובת <strong>@parkomat.co.il</strong> בלבד.
          {/* ============================================================
              ⚠️ השורה הזו מחליפה את "שכחתי את הסיסמה" — ואינה קישוט
              ============================================================
              שתי אפשרויות המייל הוסרו במלואן (החלטת מוצר). המשמעות היא
              שלמסך הזה **אין** שום מסלול התאוששות עצמי: מי ששכח סיסמה
              ולא יידע למי לפנות פשוט ינסה שוב ושוב.

              מסך שמסיר אפשרות חייב לומר מה בא במקומה. מסלול ההתאוששות
              היחיד הוא מנהל שמנפיק סיסמה חדשה, ולכן הוא כתוב כאן. */}
          <br />שכחתם את הסיסמה? פנו למנהל — הוא מנפיק סיסמה חדשה.
        </p>
      </form>
    </div>
  );
}

export default Login;
