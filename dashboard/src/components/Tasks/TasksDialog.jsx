// components/Tasks/TasksDialog.jsx — המשימות של אתר: לביצוע → בטיפול → בוצעו, עם ההיסטוריה של כל אחת.
//
// בעלת המוצר, 06/10/2026: "טבלה צומחת… יראו בטבלה איזה משתמש הזין את המשימה… המשימה
// לא תימחק, אלא תסומן כבוצעה ותיזרק למקום שלא מציג אותה, למטה". ו-11/10/2026: "שלכל אתר
// יהיה כפתור משימות שיהיה אופציה להוסיף משימה אופציה לעשות משימה בטיפול אופצייה לסמן V...
// שלוש אופציות... כתוב את זה יפה ושיראו את כל ההסטוריה של המשימות". בחרה כפתור אחד לאתר
// (לא אחד לכל סוג), והסוג — קשרי לקוחות / טכני — נבחר לכל משימה בהוספה.
//
// ⚠️ אין כאן החלטה על הרשאה: מי רשאי לסמן — `can_close` מגיע מה-SQL (app.can_close_task),
// והכפתור מוצג לפיו. תנאי כאן היה נראה כמו הגנה ואפשר לעקוף אותו בשורת fetch אחת.
//
// ⚠️ "בוצע" אינו הפיך (אין "פתיחה מחדש" — המשימה לא נמחקת ולא חוזרת), ולכן לחיצה
// ראשונה רק מבקשת אישור, בתוך הכפתור עצמו, לכמה שניות. בלי חלון קופץ. "לטיפול" הפיך
// ("החזרה לביצוע") — ולכן בלחיצה אחת.
//
// ⚠️ "בוצעו" מקופל: המשימה שנעשתה "נזרקת למקום שלא מציג אותה, למטה" (06/10). בלחיצה נפתחת
// ההיסטוריה — כל מה שבוצע, ולכל משימה כל המעברים שלה, מי ומתי (גם פתוחה מראה את שלה).
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTasks, addTask, startTask, unstartTask, markTaskDone, TASK_KINDS, TASK_KIND_LABEL } from "../../services/dataSource";
import { newId } from "../../utils/complianceFiles";
import { splitOpen, historySteps, openSummary, TASK_STATE_LABEL } from "../../utils/tasks";
import "./Tasks.css";

const CONFIRM_MS = 4000;
// כמה מאלה שבוצעו נטענות מראש; "הצגת כולן" טוענת את השאר (null = בלי תקרה)
const DONE_FIRST = 200;

/** שורת משימה: הגוף, ומתחתיו הסוג וכל המעברים — "נפתחה … ← הועברה לטיפול … ← בוצעה …". */
function TaskRow({ t, state, children }) {
  const steps = historySteps(t);
  return (
    <li className="tk-row" data-state={state} data-id={t.id}>
      <div className="tk-row-main">
        <p className="tk-text">
          {state === "done" && <span className="tk-check" aria-hidden="true">✓ </span>}
          {t.body}
        </p>
        <p className="tk-meta">
          <span className="tk-kind" data-kind={t.kind}>{TASK_KIND_LABEL[t.kind] ?? t.kind}</span>
          {steps.map((s, i) => (
            <span key={i} className="tk-step" data-action={s.action}>
              {i > 0 && <span className="tk-arrow" aria-hidden="true">←</span>}
              {s.label} <bdi className="tk-when">{s.when}</bdi>{s.by && <> ע״י {s.by}</>}
            </span>
          ))}
        </p>
      </div>
      {children && <div className="tk-actions">{children}</div>}
    </li>
  );
}

/**
 * @param {object} p
 * @param {{code:string, site_name?:string}} p.site
 * @param {number} [p.rev] — עולה כשהגיע אירוע משימות; טוען מחדש
 * @param {() => void} p.onClose
 * @param {() => void} [p.onChanged] — אחרי כתיבה (ההורה מרענן את המספר בכפתור)
 */
export default function TasksDialog({ site, rev = 0, onClose, onChanged }) {
  const siteName = site.site_name || site.code;

  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState(null);           // ⚠️ בלי ברירת מחדל — הסוג נבחר
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // ⚠️ נפרד מ-loadError: הטעינה שאחרי פעולה שנכשלה מצליחה — ומאפסת את loadError, כלומר
  // "המשימה כבר בוצעה" היה נמחק לפני שמישהו קרא אותו (נמדד בדפדפן).
  const [actError, setActError] = useState("");
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const clientId = useRef(newId());
  const confirmTimer = useRef(null);
  const overlayRef = useRef(null);
  const pressedOnOverlay = useRef(false);
  const inputRef = useRef(null);

  const load = useCallback(() => fetchTasks({ siteCode: site.code, doneLimit: allDone ? null : DONE_FIRST })
    .then((d) => { setData(d); setLoadError(""); })
    .catch((e) => setLoadError(e.message)), [site.code, allDone]);

  useEffect(() => { load(); }, [load, rev]);
  // ⚠️ פוקוס לשדה רק עם עכבר: בטלפון הוא מקפיץ מקלדת שמסתירה את הרשימה, ומי שפתח כדי לקרוא
  // אינו רוצה להקליד.
  useEffect(() => {
    if (window.matchMedia?.("(pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true });
  }, []);
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
    if (!kind) {
      setSaveError("יש לבחור סוג משימה — קשרי לקוחות או טכני");
      return;
    }
    setSaving(true);
    setSaveError("");
    setActError("");
    try {
      await addTask({ kind, body: body.trim(), siteCode: site.code, clientId: clientId.current });
      clientId.current = newId();        // רק אחרי הצלחה — ניסיון חוזר שולח את אותו מזהה
      setBody("");                       // הסוג נשאר: המשימה הבאה בדרך כלל מאותו סוג
      await load();
      onChanged?.();
      inputRef.current?.focus({ preventScroll: true });
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // כל מעבר: נועל את השורה, שולח, טוען מחדש. ⚠️ כשל (למשל "המשימה כבר בוצעה" — מישהו אחר
  // סגר אותה בינתיים) נאמר, והרשימה נטענת בכל זאת כדי להראות את המצב האמיתי.
  const act = async (t, fn) => {
    setBusyId(t.id);
    setActError("");
    try {
      await fn(t.id);
      await load();
      onChanged?.();
    } catch (err) {
      setActError(err.message);
      await load();
      onChanged?.();
    } finally {
      setBusyId(null);
    }
  };

  const onDone = (t) => {
    if (confirmId !== t.id) {
      setConfirmId(t.id);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), CONFIRM_MS);
      return;
    }
    clearTimeout(confirmTimer.current);
    setConfirmId(null);
    act(t, markTaskDone);
  };

  const { todo, inProgress } = splitOpen(data?.open ?? []);
  const done = data?.done ?? [];
  const doneTotal = data?.doneTotal ?? 0;

  const doneBtn = (t) => t.can_close && (
    <button type="button" className={`tk-btn tk-btn--done${confirmId === t.id ? " is-confirm" : ""}`}
      disabled={busyId === t.id} onClick={() => onDone(t)}
      aria-label={confirmId === t.id ? `אישור: המשימה "${t.body}" בוצעה` : `סימון המשימה "${t.body}" כבוצעה`}>
      {confirmId === t.id ? "לאשר? ✓" : "✓ בוצע"}
    </button>
  );

  return (
    <div className="tk-overlay" ref={overlayRef}
      onPointerDown={(e) => { pressedOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedOnOverlay.current) onClose(); }}>
      <div className="tk-dialog" role="dialog" aria-modal="true" aria-label={`משימות — ${siteName}`} dir="rtl">
        <header className="tk-head">
          <div className="tk-head-text">
            <h2 className="tk-title">משימות</h2>
            <span className="tk-site">{siteName}{data && <> · {openSummary({ todo, inProgress })}</>}</span>
          </div>
          <button type="button" className="tk-close" onClick={onClose} aria-label="סגירה">✕</button>
        </header>

        <form className="tk-add" onSubmit={submit}>
          <input ref={inputRef} className="tk-input" type="text" maxLength={2000} value={body}
            placeholder="משימה חדשה…" aria-label="משימה חדשה" onChange={(e) => setBody(e.target.value)} />
          <div className="tk-add-row">
            <div className="tk-kinds" role="radiogroup" aria-label="סוג המשימה">
              {TASK_KINDS.map((k) => (
                <label key={k} className="tk-kind-opt">
                  <input type="radio" name="tk-kind" value={k} checked={kind === k}
                    onChange={() => { setKind(k); setSaveError(""); }} />
                  <span>{TASK_KIND_LABEL[k]}</span>
                </label>
              ))}
            </div>
            <button type="submit" className="tk-btn tk-btn--primary" disabled={!canAdd}>{saving ? "מוסיף…" : "הוספה"}</button>
          </div>
        </form>
        {saveError && <p className="tk-error" role="alert">{saveError}</p>}
        {actError && <p className="tk-error" role="alert">{actError}</p>}
        {loadError && (
          <p className="tk-error" role="alert">
            {loadError} <button type="button" className="tk-link" onClick={load}>נסה שוב</button>
          </p>
        )}

        <div className="tk-body">
          {!data && !loadError && <p className="tk-muted">טוען…</p>}
          {data && todo.length === 0 && inProgress.length === 0 && <p className="tk-empty">✓ אין משימות פתוחות</p>}

          {todo.length > 0 && (
            <section className="tk-sec" data-state="todo">
              <h3 className="tk-sec-head"><span className="tk-mark" aria-hidden="true" />{TASK_STATE_LABEL.todo}
                <span className="tk-sec-n">{todo.length}</span></h3>
              <ul className="tk-list">
                {todo.map((t) => (
                  <TaskRow key={t.id} t={t} state="todo">
                    <button type="button" className="tk-btn tk-btn--start" disabled={busyId === t.id}
                      onClick={() => act(t, startTask)} aria-label={`העברת המשימה "${t.body}" לטיפול`}>
                      לטיפול
                    </button>
                    {doneBtn(t)}
                  </TaskRow>
                ))}
              </ul>
            </section>
          )}

          {inProgress.length > 0 && (
            <section className="tk-sec" data-state="in_progress">
              <h3 className="tk-sec-head"><span className="tk-mark" aria-hidden="true" />{TASK_STATE_LABEL.in_progress}
                <span className="tk-sec-n">{inProgress.length}</span></h3>
              <ul className="tk-list">
                {inProgress.map((t) => (
                  <TaskRow key={t.id} t={t} state="in_progress">
                    <button type="button" className="tk-link tk-unstart" disabled={busyId === t.id}
                      onClick={() => act(t, unstartTask)} aria-label={`החזרת המשימה "${t.body}" ללביצוע`}>
                      החזרה לביצוע
                    </button>
                    {doneBtn(t)}
                  </TaskRow>
                ))}
              </ul>
            </section>
          )}

          {data && doneTotal > 0 && (
            <section className="tk-sec tk-sec--done" data-state="done">
              <button type="button" className="tk-collapse" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                <span className="tk-mark" aria-hidden="true" />{TASK_STATE_LABEL.done}
                <span className="tk-sec-n">{doneTotal}</span>
                <span className="tk-chev" aria-hidden="true">{showDone ? "▴" : "▾"}</span>
              </button>
              {showDone && (
                <ul className="tk-list">
                  {done.map((t) => <TaskRow key={t.id} t={t} state="done" />)}
                </ul>
              )}
              {showDone && doneTotal > done.length && (
                <p className="tk-muted tk-more">
                  מוצגות {done.length} האחרונות מתוך {doneTotal} ·{" "}
                  <button type="button" className="tk-link" onClick={() => setAllDone(true)}>הצגת כולן</button>
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
