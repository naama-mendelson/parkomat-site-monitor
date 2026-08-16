// components/UsersPanel/UsersPanel.jsx — ניהול משתמשים.
//
// ⚠️ **למנהלים בלבד**, והשרת הוא שאוכף (`requireManager` ב-routes.js על
// invite / list / PATCH / DELETE). אין כאן בדיקת תפקיד — לא בשכחה:
// הסתרה ב-UI אינה אבטחה. בקר שיפתח את הפאנל יקבל 403 ויראה את הסיבה,
// וזה עדיף על תפריט שנעלם בלי הסבר.
import { useEffect, useRef, useState } from "react";
import { inviteUser, fetchUsers, setUserActive, setUserRole, deleteUser } from "../../services/api";
import { copyText } from "../../utils/clipboard";
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
  // איזה משתמש בתהליך עדכון — כדי לחסום לחיצה כפולה על אותה שורה בלבד,
  // ולא על כל הרשימה.
  const [updatingId, setUpdatingId] = useState(null);
  // ⚠️ ברירת המחדל היא בקר ולא מנהל: שגיאת השמטה בטופס צריכה ליפול לצד
  // המצמצם. מי שמזמין מנהל עושה זאת במודע.
  const [inviteRole, setInviteRole] = useState("operator");
  // מצב ההעתקה: null | "ok" | "fail". שלושה מצבים ולא שניים — ראה handleCopy.
  const [copied, setCopied] = useState(null);
  const pwRef = useRef(null);

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
    // ⚠️ בלי זה "✓ הועתק" מההזמנה הקודמת נשאר על המסך מעל סיסמה **חדשה**
    // שטרם הועתקה — כלומר אישור שקרי, על הערך שאסור לטעות בו.
    setCopied(null);

    try {
      const res = await inviteUser(email.trim(), inviteRole);
      setInvited({ email: res.user.email, tempPassword: res.tempPassword });
      setEmail("");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ============================================================
  // השבתה והחזרה — והשגיאה מוצגת כפי שהיא
  // ============================================================
  // ⚠️ השרת מסרב להשבית את המנהל הפעיל האחרון ואת המבצע עצמו, ומחזיר
  // סיבה בעברית. **הכפתור אינו מנסה לחזות את המקרים האלה ולהסתיר את
  // עצמו** — הסתרה מלמדת שהכלל אינו קיים, והמשתמשת לא תדע למה.
  // הכלל חי במקום אחד (auth/deactivation.js), וכאן רק מציגים את תשובתו.
  async function handleToggle(user) {
    setUpdatingId(user.id);
    setError(null);
    try {
      await setUserActive(user.id, !user.is_active);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdatingId(null);
    }
  }

  // ⚠️ השרת מסרב להוריד את המנהל הפעיל האחרון ואת המבצע עצמו, ומחזיר
  // סיבה. הכפתור אינו מנסה לחזות זאת — הסתרה מלמדת שהכלל אינו קיים.
  async function handleRole(user) {
    setUpdatingId(user.id);
    setError(null);
    try {
      await setUserRole(user.id, user.role === "manager" ? "operator" : "manager");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdatingId(null);
    }
  }

  // ============================================================
  // מחיקה — ואישור, כי אין ממנה חזרה
  // ============================================================
  // ⚠️ **זה המקום היחיד בפאנל שמבקש אישור, וזה מכוון.** השבתה, החזרה
  // ושינוי דרגה כולן הפיכות בלחיצה אחת, ואישור עליהן היה הופך לרעש שלוחצים
  // עליו אוטומטית — ואז גם האישור הזה יאבד את משמעותו.
  //
  // ⚠️ והאישור נוקב ב**כתובת**, לא ב"האם למחוק?": ברשימה של כמה שורות
  // דומות, אישור גנרי אינו מאפשר לוודא שנלחצה השורה הנכונה. וזו בדיוק
  // הטעות שאי אפשר לתקן כאן.
  async function handleDelete(user) {
    const ok = window.confirm(
      `למחוק לצמיתות את ${user.email}?\n\n` +
      "המשתמש יימחק גם מ-Supabase ולא יוכל להתחבר. אין דרך לבטל — " +
      "החזרה אפשרית רק בהזמנה מחדש.\n\n" +
      "להשבתה זמנית והפיכה יש להשתמש בכפתור \"השבת\"."
    );
    if (!ok) return;

    setUpdatingId(user.id);
    setError(null);
    try {
      await deleteUser(user.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdatingId(null);
    }
  }

  // ============================================================
  // העתקת הסיסמה הזמנית — ומשוב, כי בלעדיו אי אפשר לדעת
  // ============================================================
  // ⚠️ הקוד הקודם היה `navigator.clipboard?.writeText(...)` בלי await
  // ובלי משוב. ה-`?.` הפך אותו ל**כלום שקט** בכל כתובת שאינה localhost
  // או HTTPS — כלומר בדיוק כשפותחים את הדשבורד ממחשב אחר ברשת. הלחיצה
  // לא עשתה דבר, ולא היה שום סימן לכך.
  //
  // ⚠️ וזה קרה על הערך היחיד במערכת שמוצג פעם אחת ואינו נשמר בשום מקום.
  // העתקה שנכשלת בשקט כאן = משתמש שנוצר ואי אפשר להתחבר אליו.
  //
  // שלוש מצבים מוצגים, ולא שניים: "העתק" / "✓ הועתק" / "סמנו והעתיקו".
  // המצב השלישי הוא ההודאה שההעתקה האוטומטית לא זמינה — עם הסיבה.
  async function handleCopy() {
    const ok = await copyText(invited.tempPassword);
    setCopied(ok ? "ok" : "fail");
    // ⚠️ בכישלון מסמנים את הטקסט **בשבילה**, כדי שנשארה רק הקשה אחת.
    if (!ok) selectPassword();
    // ההודעה נעלמת מעצמה רק בהצלחה. כישלון נשאר על המסך — הוא דורש פעולה.
    if (ok) setTimeout(() => setCopied(null), 2500);
  }

  /** מסמן את הסיסמה במלואה — המסלול הידני, שעובד תמיד. */
  function selectPassword() {
    const el = pwRef.current;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  return (
    <div className="users-overlay" onClick={onClose}>
      <div className="users-panel" onClick={(e) => e.stopPropagation()}>
        <header className="users-head">
          <h2>משתמשים</h2>
          <button className="users-close" onClick={onClose} aria-label="סגירה">✕</button>
        </header>

        <p className="users-hint">
          מנהל בלבד יכול לצרף, לשנות דרגה, להשבית ולמחוק. אין הרשמה עצמית —
          משתמש נכנס רק אם צירפו אותו, ורק בכתובת <strong>@parkomat.co.il</strong>.
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
          {/* ⚠️ בורר ולא תיבת סימון: "מנהל" ו"בקר" הם שתי אפשרויות שוות
              במשקל, ותיבה מסומנת/לא-מסומנת הייתה מציגה אחת מהן כברירת מחדל
              שקופה. כאן שתיהן נאמרות. */}
          <select
            className="users-role-select"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            disabled={busy}
            aria-label="תפקיד המשתמש החדש"
          >
            <option value="operator">בקר</option>
            <option value="manager">מנהל</option>
          </select>
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
            {/* ⚠️ לחיצה על הסיסמה מסמנת אותה במלואה. זה המסלול שעובד
                **תמיד**, גם כשההעתקה האוטומטית נחסמה — ולכן הוא קיים ולא
                רק הכפתור. */}
            <code
              className="users-temp-pw"
              ref={pwRef}
              onClick={selectPassword}
              title="לחיצה מסמנת את הסיסמה"
            >
              {invited.tempPassword}
            </code>
            <button
              className="users-copy"
              type="button"
              onClick={handleCopy}
            >
              {copied === "ok" ? "✓ הועתק" : copied === "fail" ? "סמנו והעתיקו" : "העתק"}
            </button>
            {/* ⚠️ כשההעתקה נכשלת אומרים **למה**, ולא רק "נכשל": בלי הסיבה
                זה נראה כמו תקלה אקראית, והמשתמשת תנסה שוב באותה כתובת
                ותיכשל שוב. */}
            {copied === "fail" && (
              <p className="users-copy-hint">
                הדפדפן חסם העתקה אוטומטית (קורה כשהכתובת אינה <code>localhost</code> או HTTPS).
                הסיסמה כבר מסומנת — <kbd>Ctrl</kbd>+<kbd>C</kbd>.
              </p>
            )}
          </div>
        )}

        <h3 className="users-list-title">
          {loading ? "טוען…" : `${users.length} משתמשים במערכת`}
        </h3>

        <ul className="users-list">
          {users.map((u) => (
            <li key={u.id} className={u.is_active === false ? "is-disabled" : ""}>
              <span className="users-email">{u.email}</span>
              <span className={`users-role users-role--${u.role}`}>{ROLE_LABELS[u.role] || u.role}</span>
              <span className="users-seen">
                {/* ⚠️ משתמש מושבת מסומן במפורש ולא נעלם מהרשימה: הוא עדיין
                    מופיע בכל שורת ביקורת, ומי שמחפש אותו צריך למצוא אותו. */}
                {u.is_active === false
                  ? "מושבת"
                  : u.lastSignInAt
                    ? `נכנס ${new Date(u.lastSignInAt).toLocaleDateString("he-IL")}`
                    : "טרם נכנס"}
              </span>
              <button
                className="users-toggle"
                onClick={() => handleRole(u)}
                disabled={updatingId === u.id || u.is_active === false}
                title={u.is_active === false
                  ? "משתמש מושבת — יש להחזיר אותו לפעילות תחילה"
                  : u.role === "manager" ? "הורד לבקר" : "העלה למנהל"}
              >
                {u.role === "manager" ? "↓ בקר" : "↑ מנהל"}
              </button>
              <button
                className="users-toggle"
                onClick={() => handleToggle(u)}
                disabled={updatingId === u.id}
              >
                {updatingId === u.id ? "…" : u.is_active === false ? "החזר" : "השבת"}
              </button>
              {/* ⚠️ **מחיקה נפרדת ויזואלית מהשבתה, ולא כפתור נוסף באותו משקל.**
                  השבתה הפיכה בלחיצה; מחיקה מסירה גם את המשתמש ב-Supabase ואין
                  ממנה חזרה. שני כפתורים זהים זה לצד זה מזמינים בדיוק את הלחיצה
                  הלא נכונה. */}
              <button
                className="users-delete"
                onClick={() => handleDelete(u)}
                disabled={updatingId === u.id}
                title={`מחיקה מוחלטת של ${u.email} — אין דרך חזרה`}
              >
                {updatingId === u.id ? "…" : "מחק"}
              </button>
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
