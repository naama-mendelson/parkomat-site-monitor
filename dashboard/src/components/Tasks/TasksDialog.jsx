// components/Tasks/TasksDialog.jsx — המשימות של אתר: רשימה אחת של פתוחות, ⏳ / V / X ליד כל אחת,
// ו"בוצעו" מקופל למטה, עם ההיסטוריה של כל משימה.
//
// בעלת המוצר, 06/10/2026: "טבלה צומחת… יראו בטבלה איזה משתמש הזין את המשימה… המשימה
// לא תימחק, אלא תסומן כבוצעה ותיזרק למקום שלא מציג אותה, למטה". ו-11/10/2026: "שלכל אתר
// יהיה כפתור משימות שיהיה אופציה להוסיף משימה אופציה לעשות משימה בטיפול אופצייה לסמן V...
// שלוש אופציות... כתוב את זה יפה ושיראו את כל ההסטוריה של המשימות". בחרה כפתור אחד לאתר
// (לא אחד לכל סוג).
//
// ⚠️ **אין בחירת סוג** (12/10/2026, על "קשרי לקוחות / טכני" בטופס: "תעיף את זה"). משימה נשמרת
// בלי סוג, ושורה לא מציגה סוג. שדה הטקסט ו"הוספה" — שורה אחת.
//
// ⚠️ **⏳ / V / X ליד כל משימה** (12/10/2026: "אני רוצה שיהיה X ו-V ליד כל משימה וסימון של
// בתהליך"). בחרה: רשימה אחת עם סימון "בתהליך" (לא שני חלקים, כמו מ-11/10), X = מחיקה לגמרי
// (לא "בוטלה"), ו-V ו-X — "רק sherut, כולם רואים": מי שאינו רשאי רואה אותם אפורים, ולחיצה אומרת
// למה. ⏳ — לכל איש צוות, ולחיצה שנייה מבטלת אותו.
//
// ⚠️ אין כאן החלטה על הרשאה: מי רשאי — `can_close` מגיע מה-SQL (app.can_close_task, שקובע גם את
// task_delete), והכפתור צובע ומסביר לפיו. תנאי כאן היה נראה כמו הגנה ואפשר לעקוף אותו בשורת
// fetch אחת — ה-RPC הוא שדוחה.
//
// ⚠️ V ו-X אינם הפיכים ("בוצעה" סופי; מחיקה — המשימה וההיסטוריה שלה), ולכן לחיצה ראשונה רק
// מבקשת אישור, בתוך הכפתור עצמו, לכמה שניות. בלי חלון קופץ. ⏳ הפיך — בלחיצה אחת.
//
// ⚠️ "בוצעו" מקופל: המשימה שנעשתה "נזרקת למקום שלא מציג אותה, למטה" (06/10). בלחיצה נפתחת
// ההיסטוריה — כל מה שבוצע, ולכל משימה כל המעברים שלה, מי ומתי (גם פתוחה מראה את שלה).
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTasks, addTask, startTask, unstartTask, markTaskDone, deleteTask } from "../../services/dataSource";
import { newId } from "../../utils/complianceFiles";
import { splitOpen, taskState, historySteps, openSummary, TASK_STATE_LABEL } from "../../utils/tasks";
import "./Tasks.css";

const CONFIRM_MS = 4000;
// כמה מאלה שבוצעו נטענות מראש; "הצגת כולן" טוענת את השאר (null = בלי תקרה)
const DONE_FIRST = 200;
// ⚠️ ההסבר בלבד — ההחלטה ב-SQL (app.can_close_task). אם הכלל שם משתנה, גם המשפט הזה.
const NO_RIGHTS = "רק החשבון sherut@parkomat.co.il יכול לסמן בוצע או למחוק משימה";
// ⚠️ לחיצה שנייה שמגיעה מהר מזה אחרי החימוש אינה אישור — היא חלק מלחיצה כפולה (או נגיעה כפולה). בלי
// זה דאבל-קליק על X מוחק משימה וכל ההיסטוריה שלה בלי שאיש ראה "למחוק?" (נמצא בסקירה, 12/10/2026).
const ARM_MIN_MS = 600;

/** שורת משימה: הגוף, ומתחתיו כל המעברים — "נפתחה … ← בתהליך … ← בוצעה …". `note` — הסבר לשורה הזו. */
function TaskRow({ t, state, note, children }) {
  const steps = historySteps(t);
  return (
    <li className="tk-row" data-state={state} data-id={t.id}>
      <div className="tk-row-main">
        <p className="tk-text">
          {state === "done" && <span className="tk-check" aria-hidden="true">✓ </span>}
          {state === "in_progress" && <span className="tk-prog" title={TASK_STATE_LABEL.in_progress}>⏳ </span>}
          {t.body}
        </p>
        <p className="tk-meta">
          {steps.map((s, i) => (
            <span key={i} className="tk-step" data-action={s.action}>
              {i > 0 && <span className="tk-arrow" aria-hidden="true">←</span>}
              {s.label} <bdi className="tk-when">{s.when}</bdi>{s.by && <> ע״י {s.by}</>}
            </span>
          ))}
        </p>
      </div>
      {children && <div className="tk-actions">{children}</div>}
      {/* ⚠️ ליד השורה שנלחצה, לא בראש החלון: בטלפון, אחרי גלילה למשימה נמוכה, השורה העליונה מחוץ למסך —
          והלחיצה על V/X אפורים "לא עשתה כלום" (נמדד בסקירה: 6 משימות פתוחות מספיקות). */}
      {note && <p className="tk-row-msg" role="alert">{note}</p>}
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // ⚠️ נפרד מ-loadError: הטעינה שאחרי פעולה שנכשלה מצליחה — ומאפסת את loadError, כלומר
  // "המשימה כבר בוצעה" היה נמחק לפני שמישהו קרא אותו (נמדד בדפדפן).
  const [actError, setActError] = useState("");
  // { id, what: "done" | "delete", at } — הלחיצה הראשונה על V או X, שמחכה לאישור (at — מתי חומש)
  const [confirm, setConfirm] = useState(null);
  // { id, msg } — הסבר שמוצג מתחת לשורה שנלחצה (V/X אפורים)
  const [rowMsg, setRowMsg] = useState(null);
  const actErrorRef = useRef(null);
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
  // ⚠️ שגיאת פעולה ("המשימה כבר בוצעה") מוצגת בראש החלון — ומי שגלל לשורה נמוכה לא היה רואה אותה
  useEffect(() => {
    if (actError) actErrorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [actError]);
  // ההסבר מתחת לשורה — וגם אם השורה בתחתית המסך, ההסבר שנוסף מתחתיה נגלל לתוכו
  useEffect(() => {
    if (rowMsg) overlayRef.current?.querySelector(`.tk-row[data-id="${rowMsg.id}"] .tk-row-msg`)?.scrollIntoView?.({ block: "nearest" });
  }, [rowMsg]);

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
    setActError("");
    try {
      await addTask({ body: body.trim(), siteCode: site.code, clientId: clientId.current });
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

  // כל מעבר: נועל את השורה, שולח, טוען מחדש. ⚠️ כשל (למשל "המשימה כבר בוצעה" — מישהו אחר
  // סגר אותה בינתיים) נאמר, והרשימה נטענת בכל זאת כדי להראות את המצב האמיתי.
  const act = async (t, fn) => {
    setBusyId(t.id);
    setActError("");
    setRowMsg(null);
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

  const isConfirm = (t, what) => confirm?.id === t.id && confirm.what === what;
  // V / X: מי שאינו רשאי — הסבר מתחת לשורה, בלי שליחה; לחיצה ראשונה — מבקשת אישור; שנייה — שולחת.
  // ⚠️ השנייה נחשבת רק אם היא לחיצה בפני עצמה: לא חלק מלחיצה כפולה (e.detail > 1), ולא פחות מ-ARM_MIN_MS
  // אחרי החימוש. (מקש Enter שמוחזק — נחסם ב-onKeyDown, ראו closeBtn.)
  const ask = (t, what, fn, e) => {
    if (!t.can_close) {
      setRowMsg({ id: t.id, msg: NO_RIGHTS });
      return;
    }
    setRowMsg(null);
    if (!isConfirm(t, what)) {
      setConfirm({ id: t.id, what, at: performance.now() });
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirm(null), CONFIRM_MS);
      return;
    }
    if ((e?.detail ?? 1) > 1 || performance.now() - confirm.at < ARM_MIN_MS) return;
    clearTimeout(confirmTimer.current);
    setConfirm(null);
    act(t, fn);
  };

  const { todo, inProgress } = splitOpen(data?.open ?? []);
  // ⚠️ רשימה אחת, בסדר שהגיע מה-SQL (מהוותיקה לחדשה) — "בתהליך" הוא סימון על השורה, לא חלק נפרד
  const open = data?.open ?? [];
  const done = data?.done ?? [];
  const doneTotal = data?.doneTotal ?? 0;

  const progBtn = (t, on) => (
    <button type="button" className={`tk-ico tk-ico--prog${on ? " is-on" : ""}`} aria-pressed={on}
      disabled={busyId === t.id} onClick={() => act(t, on ? unstartTask : startTask)}
      title={on ? "בתהליך — לחיצה מבטלת את הסימון" : "סימון בתהליך"}
      aria-label={on ? `ביטול הסימון "בתהליך" של "${t.body}"` : `סימון "${t.body}" בתהליך`}>
      <span className="tk-ico-g" aria-hidden="true">⏳</span>
    </button>
  );
  const closeBtn = (t, what) => {
    const pending = isConfirm(t, what);
    const isDone = what === "done";
    return (
      <button type="button"
        className={`tk-ico tk-ico--${isDone ? "done" : "del"}${pending ? " is-confirm" : ""}${t.can_close ? "" : " is-locked"}`}
        aria-disabled={t.can_close ? undefined : "true"} disabled={busyId === t.id}
        onClick={(e) => ask(t, what, isDone ? markTaskDone : deleteTask, e)}
        // ⚠️ Enter מוחזק חוזר על עצמו, וכל חזרה היא לחיצה — הראשונה מחמשת והבאות היו מאשרות
        onKeyDown={(e) => { if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault(); }}
        title={!t.can_close ? NO_RIGHTS : pending ? "לחיצה נוספת מאשרת" : isDone ? "בוצע" : "מחיקה"}
        aria-label={pending
          ? (isDone ? `אישור: המשימה "${t.body}" בוצעה` : `אישור: מחיקת המשימה "${t.body}"`)
          : (isDone ? `סימון המשימה "${t.body}" כבוצעה` : `מחיקת המשימה "${t.body}"`)}>
        {isDone ? "✓" : "✕"}
        {/* ⚠️ השאלה בבועה מעל הכפתור, מחוץ לזרימה: כפתור שמתרחב (69–72px) היה מכסה את המקום של השכן —
            ולחיצה "מתקנת" על השכן הייתה מאשרת את הפעולה הבלתי הפיכה (נמדד בסקירה, 12/10/2026) */}
        {pending && <span className="tk-ask" aria-hidden="true">{isDone ? "לאשר?" : "למחוק?"}</span>}
      </button>
    );
  };

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
          <button type="submit" className="tk-btn tk-btn--primary" disabled={!canAdd}>{saving ? "מוסיף…" : "הוספה"}</button>
        </form>
        {saveError && <p className="tk-error" role="alert">{saveError}</p>}
        {actError && <p className="tk-error" role="alert" ref={actErrorRef}>{actError}</p>}
        {loadError && (
          <p className="tk-error" role="alert">
            {loadError} <button type="button" className="tk-link" onClick={load}>נסה שוב</button>
          </p>
        )}

        <div className="tk-body">
          {!data && !loadError && <p className="tk-muted">טוען…</p>}
          {data && open.length === 0 && <p className="tk-empty">✓ אין משימות פתוחות</p>}

          {open.length > 0 && (
            <ul className="tk-list tk-open" aria-label="משימות פתוחות">
              {open.map((t) => {
                const state = taskState(t);
                return (
                  <TaskRow key={t.id} t={t} state={state} note={rowMsg?.id === t.id ? rowMsg.msg : null}>
                    {progBtn(t, state === "in_progress")}
                    {closeBtn(t, "done")}
                    {closeBtn(t, "delete")}
                  </TaskRow>
                );
              })}
            </ul>
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
