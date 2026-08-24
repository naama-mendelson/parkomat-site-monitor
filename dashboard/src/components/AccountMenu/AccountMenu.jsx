// components/AccountMenu/AccountMenu.jsx — מי מחובר, שינוי סיסמה, ויציאה.
//
// ============================================================
// למה תפריט ולא שני אייקונים
// ============================================================
// קודם היו כאן שני כפתורי אייקון בלבד — 👥 ו-⎋. שניהם היו חסרים את הדבר
// שהופך אותם למובנים: **מי מחובר עכשיו**. במסך משותף בחדר בקרה זו לא
// נוחות אלא הדבר החשוב — מי שמסתכל על המסך צריך לדעת בשם מי הוא פועל,
// כי כל פעולת תחזוקה נרשמת על שמו של המחובר.
//
// אינו מייבא supabase-js. הכל דרך services/auth.js — ראה ה-seam שם.
import { useEffect, useRef, useState } from "react";
import { currentUser, signOut, changePassword, MIN_PASSWORD_LENGTH } from "../../services/auth";
import "./AccountMenu.css";
import MfaSetup from "./MfaSetup";

// ⚠️ שתי קבוצות בלבד. supervisor/executive הן דרגות שבוטלו — הן נשארות
// במפה כדי שאסימון ישן שעדיין נושא אותן יציג "מנהל" ולא את המחרוזת
// הגולמית. שורה שנמחקת כאן הופכת דרגה ישנה למילה באנגלית על המסך.
const ROLE_LABELS = {
  operator: "בקר",
  manager: "מנהל",
  supervisor: "מנהל",     // בוטלה — ממופה למנהל
  executive: "מנהל",      // בוטלה — ממופה למנהל
};

// ============================================================
// רוחב התפריט יושב כאן ולא ב-CSS — בכוונה
// ============================================================
// חישוב המיקום למטה צריך לדעת את הרוחב האמיתי. אם ה-CSS יחזיק רוחב משלו,
// שני המספרים ייפרדו בשקט בעריכה הבאה והתפריט יחזור לצאת מהמסך.
const MENU_WIDTH = 260;
const GAP = 8;      // מרווח מהכפתור
const MARGIN = 8;   // מרווח מינימלי מקצה החלון

function AccountMenu() {
  const [user, setUser] = useState(null);
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);

  // מיקום מחושב במקום מיקום מוצהר ב-CSS.
  //
  // ============================================================
  // למה לא inset-inline-start / end
  // ============================================================
  // הגרסה הראשונה השתמשה ב-inset-inline-start: 0, והתפריט יצא מהמסך. הדף
  // הוא dir="rtl" ו-header-actions יושב ב-justify-content: space-between,
  // כלומר הכפתור נמצא בקצה **השמאלי** של החלון — ובעברית inline-start הוא
  // הקצה הימני, אז 260 הפיקסלים נפרשו שמאלה אל מחוץ לחלון.
  //
  // היפוך ל-end היה מתקן את המקרה הזה בלבד. מיקום מחושב וחתוך לגבולות
  // החלון נכון בכל כיוון ובכל מקום שהכפתור יימצא בו — כולל אחרי סידור מחדש
  // של הכותרת, שהוא בדיוק מה שהפיל את הגרסה הראשונה.
  const [pos, setPos] = useState(null);

  useEffect(() => { currentUser().then(setUser); }, []);

  useEffect(() => {
    if (!open) return;

    function place() {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();

      // מיושר לקצה הסוגר של הכפתור, ואז נחתך כך שלא ייצא משני הצדדים.
      const wanted = r.right - MENU_WIDTH;
      const maxLeft = window.innerWidth - MENU_WIDTH - MARGIN;
      const left = Math.max(MARGIN, Math.min(wanted, maxLeft));
      const top = r.bottom + GAP;

      // גובה: טופס הסיסמה מאריך את התפריט, ובחלון נמוך הוא היה נחתך למטה.
      setPos({ top, left, maxHeight: Math.max(160, window.innerHeight - top - MARGIN) });
    }

    place();
    // scroll ב-capture כדי לתפוס גם גלילה של מכל פנימי, לא רק של החלון.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, pwOpen]);

  // סגירה בלחיצה בחוץ וב-Escape. תפריט שנשאר פתוח על מסך קיר מסתיר תוכן
  // עד שמישהו יבוא ויסגור אותו ידנית.
  useEffect(() => {
    if (!open) return;

    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) close();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setPwOpen(false);   // הטופס נסגר יחד עם התפריט, ולא נשאר מלא בסיסמאות
    setMfaOpen(false);  // ואותו טעם: לא נפתחים בפעם הבאה באמצע רישום QR
  }

  if (!user) return null;

  return (
    <div className="account" ref={wrapRef}>
      <button
        ref={triggerRef}
        className="account-trigger"
        onClick={() => (open ? close() : setOpen(true))}
        title={user.email || "החשבון שלי"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="account-avatar" aria-hidden="true">
          {(user.email || "?").charAt(0).toUpperCase()}
        </span>
        <span className="account-role-chip">{ROLE_LABELS[user.role] || user.role}</span>
      </button>

      {/* לא מוצג עד שהמיקום חושב — אחרת פריים אחד מהבהב בפינה הלא נכונה. */}
      {open && pos && (
        <div
          className="account-menu"
          role="menu"
          style={{ top: pos.top, left: pos.left, width: MENU_WIDTH, maxHeight: pos.maxHeight }}
        >
          <div className="account-who">
            <span className="account-email">{user.email}</span>
            <span className="account-role">{ROLE_LABELS[user.role] || user.role}</span>
          </div>

          {!pwOpen && (
            <button className="account-item" role="menuitem" onClick={() => setPwOpen(true)}>
              שינוי סיסמה
            </button>
          )}

          {pwOpen && <PasswordForm onDone={close} />}

          {/* ⚠️ הגורם השני יושב ליד שינוי הסיסמה ולא במסך אחר: שתי
              הפעולות עונות על אותה שאלה — מה אני מחזיק כדי להיכנס. */}
          {!mfaOpen && !pwOpen && (
            <button className="account-item" role="menuitem" onClick={() => setMfaOpen(true)}>
              אימות דו-שלבי
            </button>
          )}

          {mfaOpen && <MfaSetup onChanged={close} />}

          <button className="account-item account-item--exit" role="menuitem" onClick={signOut}>
            יציאה
          </button>
        </div>
      )}
    </div>
  );
}

function PasswordForm({ onDone }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;

    // ============================================================
    // אישור הסיסמה נבדק כאן ולא בשרת — בכוונה
    // ============================================================
    // שגיאת הקלדה בסיסמה חדשה אינה משהו שהשרת יכול לזהות: שתי המחרוזות
    // תקינות מבחינתו. בלי הבדיקה הזו המשתמש היה מחליף סיסמה למשהו שהוא
    // אינו יודע, ומגלה זאת רק בכניסה הבאה — כשכבר אין לו דרך להיכנס.
    if (next !== confirm) {
      setError("שתי הסיסמאות החדשות אינן זהות");
      return;
    }

    setBusy(true);
    setError(null);

    const { error: err } = await changePassword(current, next);

    if (err) {
      setError(err);
      setBusy(false);
      return;
    }

    // לא משאירים סיסמאות ב-state אחרי שהן כבר לא נחוצות.
    setCurrent(""); setNext(""); setConfirm("");
    setDone(true);
    setBusy(false);
  }

  if (done) {
    return (
      <div className="account-pw-done" role="status">
        הסיסמה הוחלפה.
        <button type="button" className="account-item" onClick={onDone}>סגירה</button>
      </div>
    );
  }

  return (
    <form className="account-pw" onSubmit={submit}>
      {/* autoComplete מסומן כדי שמנהל הסיסמאות של הדפדפן יציע לעדכן את
          הרשומה הקיימת, ולא ייצור רשומה שנייה לאותו חשבון. */}
      <input
        type="password"
        placeholder="סיסמה נוכחית"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        disabled={busy}
        required
      />
      <input
        type="password"
        placeholder={`סיסמה חדשה (${MIN_PASSWORD_LENGTH} תווים לפחות)`}
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        disabled={busy}
        required
      />
      <input
        type="password"
        placeholder="שוב, לאימות"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        disabled={busy}
        required
      />

      {error && <p className="account-pw-error" role="alert">{error}</p>}

      <div className="account-pw-actions">
        <button type="submit" disabled={busy}>{busy ? "מחליף…" : "החלף"}</button>
        <button type="button" onClick={onDone} disabled={busy}>ביטול</button>
      </div>
    </form>
  );
}

export default AccountMenu;
