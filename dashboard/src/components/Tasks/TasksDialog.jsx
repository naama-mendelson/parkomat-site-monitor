// components/Tasks/TasksDialog.jsx — טבלת המשימות של אתר אחד מסוג אחד (קשרי לקוחות / טכני).
//
// בעלת המוצר, 06/10/2026: "טבלה צומחת… יראו בטבלה איזה משתמש הזין את המשימה… המשימה
// לא תימחק, אלא תסומן כבוצעה ותיזרק למקום שלא מציג אותה, למטה" — ו"משימות קשרי לקוחות
// וטכני… עבור כל כרטיס": שני כפתורים בכל כרטיס, וכל אחד פותח את הטבלה הזו.
//
// ⚠️ אין כאן החלטה על הרשאה: מי רשאי לסמן — `can_close` מגיע מה-SQL (app.can_close_task),
// והכפתור מוצג לפיו. תנאי כאן היה נראה כמו הגנה ואפשר לעקוף אותו בשורת fetch אחת.
//
// ⚠️ "בוצע" אינו הפיך (אין "פתיחה מחדש" — המשימה לא נמחקת ולא חוזרת), ולכן לחיצה
// ראשונה רק מבקשת אישור, בתוך הכפתור עצמו, לכמה שניות. בלי חלון קופץ.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTasks, addTask, markTaskDone, TASK_KIND_LABEL } from "../../services/dataSource";
import { newId } from "../../utils/complianceFiles";
import { formatStampIL } from "../../utils/compliance";
import "./Tasks.css";

const CONFIRM_MS = 4000;

/**
 * @param {object} p
 * @param {{code:string, site_name?:string}} p.site
 * @param {"customer"|"technical"} p.kind
 * @param {number} [p.rev] — עולה כשהגיע אירוע משימות; טוען מחדש
 * @param {() => void} p.onClose
 * @param {() => void} [p.onChanged] — אחרי כתיבה (ההורה מרענן את המספרים בכפתורים)
 */
export default function TasksDialog({ site, kind, rev = 0, onClose, onChanged }) {
  const title = `משימות ${TASK_KIND_LABEL[kind]}`;
  const siteName = site.site_name || site.code;

  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const clientId = useRef(newId());
  const confirmTimer = useRef(null);
  const overlayRef = useRef(null);
  const pressedOnOverlay = useRef(false);
  const inputRef = useRef(null);

  const load = useCallback(() => fetchTasks({ kind, siteCode: site.code })
    .then((d) => { setData(d); setLoadError(""); })
    .catch((e) => setLoadError(e.message)), [kind, site.code]);

  useEffect(() => { load(); }, [load, rev]);
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  // Escape סוגר — רק כשאין עוד חלון מעליו
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      const all = document.querySelectorAll(".tk-overlay");
      if (all[all.length - 1] !== overlayRef.current) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const canAdd = body.trim().length >= 2 && !saving;

  const submit = async (e) => {
    e.preventDefault();
    if (!canAdd) return;
    setSaving(true);
    setSaveError("");
    try {
      await addTask({ kind, body: body.trim(), siteCode: site.code, clientId: clientId.current });
      clientId.current = newId();        // רק אחרי הצלחה — ניסיון חוזר שולח את אותו מזהה
      setBody("");
      await load();
      onChanged?.();
      inputRef.current?.focus({ preventScroll: true });
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const onDone = async (t) => {
    if (confirmId !== t.id) {
      setConfirmId(t.id);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), CONFIRM_MS);
      return;
    }
    clearTimeout(confirmTimer.current);
    setConfirmId(null);
    setBusyId(t.id);
    try {
      await markTaskDone(t.id);
      await load();
      onChanged?.();
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const open = data?.open ?? [];
  const done = data?.done ?? [];
  const doneTotal = data?.doneTotal ?? 0;

  return (
    <div className="tk-overlay" ref={overlayRef}
      onPointerDown={(e) => { pressedOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedOnOverlay.current) onClose(); }}>
      <div className="tk-dialog" role="dialog" aria-modal="true" aria-label={`${title} — ${siteName}`} dir="rtl">
        <header className="tk-head">
          <div className="tk-head-text">
            <h2 className="tk-title">{title}</h2>
            <span className="tk-site">{siteName} · {open.length === 0 ? "אין משימות פתוחות" : `${open.length} פתוחות`}</span>
          </div>
          <button type="button" className="tk-close" onClick={onClose} aria-label="סגירה">✕</button>
        </header>

        <form className="tk-add" onSubmit={submit}>
          <input ref={inputRef} className="tk-input" type="text" maxLength={2000} value={body}
            placeholder="משימה חדשה…" aria-label="משימה חדשה" onChange={(e) => setBody(e.target.value)} />
          <button type="submit" className="tk-btn tk-btn--primary" disabled={!canAdd}>{saving ? "מוסיף…" : "הוספה"}</button>
        </form>
        {saveError && <p className="tk-error" role="alert">{saveError}</p>}
        {loadError && (
          <p className="tk-error" role="alert">
            {loadError} <button type="button" className="tk-link" onClick={load}>נסה שוב</button>
          </p>
        )}

        <div className="tk-body">
          {!data && !loadError && <p className="tk-muted">טוען…</p>}
          {data && open.length > 0 && (
            <table className="tk-table">
              <thead>
                <tr>
                  <th className="tk-c-date">תאריך</th>
                  <th>משימה</th>
                  <th>הוזן ע״י</th>
                  <th className="tk-c-act"><span className="tk-sr">פעולה</span></th>
                </tr>
              </thead>
              <tbody>
                {open.map((t) => (
                  <tr key={t.id} className="tk-row">
                    <td className="tk-c-date" data-label="תאריך">{formatStampIL(t.created_at)}</td>
                    <td className="tk-c-body" data-label="משימה">{t.body}</td>
                    <td data-label="הוזן ע״י">{t.created_by}</td>
                    <td className="tk-c-act">
                      {t.can_close && (
                        <button type="button" className={`tk-btn tk-btn--done${confirmId === t.id ? " is-confirm" : ""}`}
                          disabled={busyId === t.id} onClick={() => onDone(t)}
                          aria-label={confirmId === t.id ? `אישור: המשימה "${t.body}" בוצעה` : `סימון המשימה "${t.body}" כבוצעה`}>
                          {busyId === t.id ? "…" : confirmId === t.id ? "לאשר? ✓" : "בוצע"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data && open.length === 0 && <p className="tk-empty">✓ אין משימות פתוחות</p>}

          {data && doneTotal > 0 && (
            <div className="tk-done">
              <button type="button" className="tk-collapse" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                בוצעו ({doneTotal}) <span aria-hidden="true">{showDone ? "▴" : "▾"}</span>
              </button>
              {showDone && (
                <ul className="tk-done-list">
                  {done.map((t) => (
                    <li key={t.id} className="tk-done-row">
                      <span className="tk-done-body"><span className="tk-check" aria-hidden="true">✓</span> {t.body}</span>
                      <span className="tk-muted">
                        הוזן ע״י {t.created_by} · בוצע ע״י {t.done_by} ב-{formatStampIL(t.done_at)}
                      </span>
                    </li>
                  ))}
                  {doneTotal > done.length && (
                    <li className="tk-muted">מוצגות {done.length} האחרונות מתוך {doneTotal}</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
