// components/Login/ResetPassword.jsx — קביעת סיסמה חדשה אחרי איפוס.
//
// ============================================================
// למה מסך נפרד ולא שדה בתפריט המשתמש
// ============================================================
// ⚠️ שינוי סיסמה רגיל **דורש את הנוכחית** — הדשבורד רץ על מסך משותף
// בחדר בקרה, ובלי אימות כל מי שעובר ליד יכול לנעל בחוץ את בעל החשבון.
//
// המסך הזה הוא היוצא מן הכלל היחיד, והוא מוצג **רק** אחרי שהמשתמש הגיע
// מקישור שנשלח לתיבת המייל שלו. ההוכחה שהוא הוא היא הגישה למייל.
//
// ⚠️ ולכן הוא חוסם את כל השאר: כל עוד הוא פתוח אין דרך לדלג ממנו
// לדשבורד. מסך שאפשר לסגור היה משאיר משתמש מחובר עם סיסמה שאינו יודע.
import { useState } from "react";
import { setNewPassword, MIN_PASSWORD_LENGTH } from "../../services/auth";
import Logo from "../Logo/Logo";
import "./Login.css";

function ResetPassword({ onDone }) {
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    // ⚠️ אישור כפול: שגיאת הקלדה כאן נועלת בחוץ, ואין למי לפנות.
    if (pass !== again) return setError("שתי הסיסמאות אינן זהות");

    setBusy(true);
    const { error: err } = await setNewPassword(pass);
    setBusy(false);

    if (err) return setError(err);
    onDone();
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <Logo size={44} />
        <h1 className="login-title">קביעת סיסמה חדשה</h1>
        <p className="login-sub">הגעת מקישור איפוס — יש לבחור סיסמה חדשה</p>

        <label className="login-field">
          <span>סיסמה חדשה</span>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoFocus
            autoComplete="new-password"
          />
        </label>

        <label className="login-field">
          <span>שוב, לאימות</span>
          <input
            type="password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            autoComplete="new-password"
          />
        </label>

        <p className="login-hint">לפחות {MIN_PASSWORD_LENGTH} תווים</p>

        {error && <p className="login-error" role="alert">{error}</p>}

        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? "שומר…" : "שמור והמשך"}
        </button>
      </form>
    </div>
  );
}

export default ResetPassword;
