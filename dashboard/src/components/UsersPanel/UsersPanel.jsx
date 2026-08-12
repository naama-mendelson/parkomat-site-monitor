// components/UsersPanel/UsersPanel.jsx — הזמנת משתמשים.
//
// פתוח לכל מי שמחובר, לפי החלטת מוצר. אין כאן בדיקת תפקיד — לא בשכחה:
// הסתרה ב-UI אינה אבטחה, והשרת הוא זה שאוכף (requireAuth ב-routes.js).
// אם ההחלטה תשתנה, המקום לשנות אותה הוא השרת, וכאן רק התצוגה תעקוב.
import { useEffect, useState } from "react";
import { inviteUser, fetchUsers } from "../../services/api";
import "./UsersPanel.css";

function UsersPanel({ onClose }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // הסיסמה הזמנית של ההזמנה האחרונה. מוצגת עד שסוגרים אותה — היא מוחזרת
  // פעם אחת בלבד ולא נשמרת בשום מקום, ולכן רענון מאבד אותה לתמיד.
  const [invited, setInvited] = useState(null);

  async function load() {
    try {
      const data = await fetchUsers();
      setUsers(data.users || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleInvite(e) {
    e.preventDefault();
    if (busy || !email.trim()) return;

    setBusy(true);
    setError(null);
    setInvited(null);

    try {
      const res = await inviteUser(email.trim());
      setInvited({ email: res.user.email, tempPassword: res.tempPassword });
      setEmail("");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="users-overlay" onClick={onClose}>
      <div className="users-panel" onClick={(e) => e.stopPropagation()}>
        <header className="users-head">
          <h2>משתמשים</h2>
          <button className="users-close" onClick={onClose} aria-label="סגירה">✕</button>
        </header>

        <p className="users-hint">
          כל מי שמחובר יכול לצרף משתמש נוסף. המשתמש החדש נוצר בתפקיד <strong>בקר</strong>.
        </p>

        <form className="users-invite" onSubmit={handleInvite}>
          <input
            type="email"
            placeholder="אימייל של מי שרוצים לצרף"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            required
          />
          <button type="submit" disabled={busy || !email.trim()}>
            {busy ? "מצרף…" : "צרף"}
          </button>
        </form>

        {error && <p className="users-error" role="alert">{error}</p>}

        {/* ============================================================
            הסיסמה הזמנית — מוצגת פעם אחת, ואומרים זאת במפורש
            ============================================================
            היא אינה נשמרת בשרת ולא ב-DB. משתמש שיסגור את החלון בלי להעתיק
            אותה יאבד אותה, ולכן האזהרה היא חלק מהתצוגה ולא הערה בקוד. */}
        {invited && (
          <div className="users-invited" role="status">
            <strong>נוצר משתמש {invited.email}</strong>
            <p>העבירו לו את הסיסמה הזמנית. היא מוצגת <u>פעם אחת בלבד</u> ואינה נשמרת:</p>
            <code className="users-temp-pw">{invited.tempPassword}</code>
            <button
              className="users-copy"
              type="button"
              onClick={() => navigator.clipboard?.writeText(invited.tempPassword)}
            >
              העתק
            </button>
          </div>
        )}

        <h3 className="users-list-title">
          {loading ? "טוען…" : `${users.length} משתמשים במערכת`}
        </h3>

        <ul className="users-list">
          {users.map((u) => (
            <li key={u.id}>
              <span className="users-email">{u.email}</span>
              <span className={`users-role users-role--${u.role}`}>{ROLE_LABELS[u.role] || u.role}</span>
              <span className="users-seen">
                {u.lastSignInAt ? `נכנס ${new Date(u.lastSignInAt).toLocaleDateString("he-IL")}` : "טרם נכנס"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ⚠️ שתי קבוצות בלבד — ראה ההסבר ב-AccountMenu. הדרגות שבוטלו ממופות
// למנהל כדי שאסימון ישן לא יציג מחרוזת גולמית.
const ROLE_LABELS = {
  operator: "בקר",
  manager: "מנהל",
  supervisor: "מנהל",
  executive: "מנהל",
};

export default UsersPanel;
