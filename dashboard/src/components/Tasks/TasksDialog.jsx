// components/Tasks/TasksDialog.jsx — המשימות של אתר: רשימה אחת של פתוחות, ⏳ / V / X ליד כל אחת,
// ו"בוצעו" מקופל למטה, עם ההיסטוריה של כל משימה.
//
// בעלת המוצר, 06/10/2026: "טבלה צומחת… יראו בטבלה איזה משתמש הזין את המשימה… המשימה
// לא תימחק, אלא תסומן כבוצעה ותיזרק למקום שלא מציג אותה, למטה". ו-11/10/2026: "שלכל אתר
// יהיה כפתור משימות שיהיה אופציה להוסיף משימה אופציה לעשות משימה בטיפול אופצייה לסמן V...
// שלוש אופציות... כתוב את זה יפה ושיראו את כל ההסטוריה של המשימות". בחרה כפתור אחד לאתר
// (לא אחד לכל סוג).
//
// ⚠️ **הסוג חזר, עם "מוקד"** (12/10/2026, ערב: "שיהיה: קשרי לקוחות / טכני / מוקד"). בבוקר אותו יום
// הוסר ("תעיף את זה"). בחירה בבורר של שלושה חלקים, בשורה שמתחת לשדה, ליד "הוספה" — בלי ברירת מחדל:
// סוג שאיש לא בחר הוא נתון שקרי. הבחירה נשארת למשימה הבאה באותו חלון. בכל שורה הסוג בעמודה משלו (בטלפון —
// תווית מעל המשימה). משימה בלי סוג (נפתחה בשעות שלא הייתה בחירה) — תא ריק.
// ⚠️ ובאותו ערב — "תעצב את הכל בצורה יותר מסודרת": הטופס בשתי שורות, השורות ברשת של שלוש עמודות.
//
// ⚠️ **⏳ / V / X ליד כל משימה** (12/10/2026: "אני רוצה שיהיה X ו-V ליד כל משימה וסימון של
// בתהליך"). בחרה: רשימה אחת עם סימון "בתהליך" (לא שני חלקים, כמו מ-11/10), X = מחיקה לגמרי
// (לא "בוטלה"), ו-V ו-X — "רק sherut, כולם רואים": מי שאינו רשאי רואה אותם אפורים, ולחיצה אומרת
// למה (מתחת לשורה). אותו יום, אחר כך: "תן אופציה למנהלים למחוק משימה" — X לכל מנהל (ו-sherut@);
// V נשאר רק sherut@. ⏳ — לכל איש צוות, ולחיצה שנייה מבטלת אותו.
//
// ⚠️ אין כאן החלטה על הרשאה: מי רשאי — `can_close` (V) ו-`can_delete` (X) מגיעים מה-SQL
// (app.can_close_task, app.can_delete_task), והכפתור צובע ומסביר לפיהם. תנאי כאן היה נראה כמו הגנה
// ואפשר לעקוף אותו בשורת fetch אחת — ה-RPC הוא שדוחה.
//
// ⚠️ V ו-X אינם הפיכים ("בוצעה" סופי; מחיקה — המשימה וההיסטוריה שלה), ולכן לחיצה ראשונה רק
// מבקשת אישור, בתוך הכפתור עצמו, לכמה שניות. בלי חלון קופץ. ⏳ הפיך — בלחיצה אחת.
//
// ⚠️ "בוצעו" מקופל: המשימה שנעשתה "נזרקת למקום שלא מציג אותה, למטה" (06/10). בלחיצה נפתחת
// ההיסטוריה — כל מה שבוצע, ולכל משימה כל המעברים שלה, מי ומתי (גם פתוחה מראה את שלה).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  fetchTasks, addTask, startTask, unstartTask, markTaskDone, deleteTask,
  hasTaskCode, setTaskCode, verifyAdminCode,
} from "../../services/dataSource";
import { newId } from "../../utils/complianceFiles";
import {
  splitOpen, taskState, taskNow, historyText, openSummary, kindLabel, TASK_STATE_LABEL, TASK_KINDS,
} from "../../utils/tasks";
import "./Tasks.css";

const CONFIRM_MS = 4000;
// כמה מאלה שבוצעו נטענות מראש; "הצגת כולן" טוענת את השאר (null = בלי תקרה)
const DONE_FIRST = 200;
// ⚠️ ההסברים בלבד — ההחלטה ב-SQL: V ב-app.can_close_task (רק sherut@), X ב-app.can_delete_task (כל מנהל,
// ו-sherut@ — 12/10/2026: "תן אופציה למנהלים למחוק משימה"). אם כלל שם משתנה, גם המשפט שלו.
// ⚠️ ומאז 12/10/2026 (ערב) — גם כל מי שמזין את קוד המנהל (app.task_code_ok): "מי שיודע את הסיסמה יוכל לסמן
// במשימות כמו השירות". לחיצה על V/X אפורים פותחת שדה קוד מתחת לשורה, במקום ההסבר.
const NO_RIGHTS = {
  done: "רק sherut@parkomat.co.il יכול לסמן בוצע, או מי שמזין את קוד המנהל",
  delete: "רק מנהל יכול למחוק משימה, או מי שמזין את קוד המנהל",
};
// מי רשאי — מה שה-SQL החזיר לשורה. ⚠️ can_delete חסר (מסד שעוד לא קיבל את 12/10) — לפי can_close, כמו קודם.
const allowed = (t, what) => (what === "done" ? t.can_close : (t.can_delete ?? t.can_close)) === true;
// ⚠️ לחיצה שנייה שמגיעה מהר מזה אחרי החימוש אינה אישור — היא חלק מלחיצה כפולה (או נגיעה כפולה). בלי
// זה דאבל-קליק על X מוחק משימה וכל ההיסטוריה שלה בלי שאיש ראה "למחוק?" (נמצא בסקירה, 12/10/2026).
const ARM_MIN_MS = 600;
// "קשרי לקוחות, טכני או מוקד" — מהרשימה עצמה, כדי שסוג שנוסף יופיע גם כאן
const KIND_NAMES = TASK_KINDS.map(kindLabel);
const NEED_KIND = `יש לבחור סוג משימה — ${KIND_NAMES.slice(0, -1).join(", ")} או ${KIND_NAMES[KIND_NAMES.length - 1]}`;

/**
 * שורת משימה: הגוף, ומתחתיו **המצב עכשיו ומי קבע אותו** — "בתהליך · ע״י naamam · 12/10 10:20 · נפתחה
 * ע״י dana · 12/10 10:14". ⚠️ לא כל השרשרת (בעלת המוצר, 12/10/2026: "לא רוצה לראות את הלוג אלא מה
 * המצב עכשיו. ומי עשה את זה. שתיהיה מעוצב יותר ברור") — היא עדיין נשמרת (task_history), ומוצגת
 * בריחוף על השורה. `note` — הסבר לשורה הזו.
 */
function TaskRow({ t, state, note, below, children }) {
  const now = taskNow(t);
  const kind = kindLabel(t.kind);
  return (
    <li className="tk-row" data-state={state} data-id={t.id}>
      {/* הסוג — עמודה משלו בתחילת השורה, כך שהסוגים עומדים זה מתחת לזה (בטלפון — תווית מעל המשימה).
          ⚠️ גם בלי סוג התא נשאר, ריק: בלעדיו המשימה הייתה זזה לעמודת הסוג ושוברת את היישור */}
      <span className="tk-kind" data-kind={t.kind || "none"} aria-hidden={kind ? undefined : "true"}>{kind}</span>
      <div className="tk-row-main">
        <p className="tk-text">{t.body}</p>
        <p className="tk-meta" title={`היסטוריה: ${historyText(t)}`}>
          <span className="tk-badge" data-state={now.state}>{now.label}</span>
          {now.state === "todo" ? (
            <span className="tk-now">נפתחה ע״י <b className="tk-who">{now.opened.by}</b> · <bdi className="tk-when">{now.opened.when}</bdi></span>
          ) : (
            <>
              <span className="tk-now">ע״י <b className="tk-who">{now.by}</b> · <bdi className="tk-when">{now.when}</bdi></span>
              <span className="tk-opened">· נפתחה ע״י {now.opened.by} · <bdi>{now.opened.when}</bdi></span>
            </>
          )}
        </p>
      </div>
      {children && <div className="tk-actions">{children}</div>}
      {/* ⚠️ ליד השורה שנלחצה, לא בראש החלון: בטלפון, אחרי גלילה למשימה נמוכה, השורה העליונה מחוץ למסך —
          והלחיצה על V/X אפורים "לא עשתה כלום" (נמדד בסקירה: 6 משימות פתוחות מספיקות). */}
      {note && <p className="tk-row-msg" role="alert">{note}</p>}
      {below}
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
  const kindName = useId();                         // שם קבוצת הרדיו של הסוג — ייחודי לחלון
  // מונה ל"יש לבחור סוג": הודעה זהה פעמיים לא הייתה נקראת שוב בקורא מסך; key חדש מרנדר אותה מחדש
  const [errTick, setErrTick] = useState(0);
  const kindsRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // ⚠️ נפרד מ-loadError: הטעינה שאחרי פעולה שנכשלה מצליחה — ומאפסת את loadError, כלומר
  // "המשימה כבר בוצעה" היה נמחק לפני שמישהו קרא אותו (נמדד בדפדפן).
  const [actError, setActError] = useState("");
  // { id, what: "done" | "delete", at } — הלחיצה הראשונה על V או X, שמחכה לאישור (at — מתי חומש)
  const [confirm, setConfirm] = useState(null);
  // { id, msg } — הסבר שמוצג מתחת לשורה שנלחצה (V/X אפורים)
  const [rowMsg, setRowMsg] = useState(null);
  // קוד המנהל: האם כבר הוזן בחלון הזה (נשמר בזיכרון של tasksDirect, עד רענון), ו-{ id, what } —
  // השורה שבה נפתח שדה הקוד
  const [unlocked, setUnlocked] = useState(hasTaskCode);
  const [codeFor, setCodeFor] = useState(null);
  const [codeVal, setCodeVal] = useState("");
  const [codeErr, setCodeErr] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
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
  // "יש לבחור סוג" — גם מסגרת אדומה סביב הבחירה, כדי שהעין תגיע אליה ולא רק להודעה
  const kindMissing = saveError === NEED_KIND;

  const submit = async (e) => {
    e.preventDefault();
    if (!canAdd) return;
    // ⚠️ אומרים למה, ולא כפתור "הוספה" מושבת בשקט — והפוקוס עובר לבורר, כך שמקלדת ממשיכה משם בחיצים
    if (!kind) {
      setSaveError(NEED_KIND);
      setErrTick((n) => n + 1);
      kindsRef.current?.querySelector("input")?.focus({ preventScroll: true });
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
    setRowMsg(null);
    setCodeFor(null);
    try {
      await fn(t.id);
      await load();
      onChanged?.();
    } catch (err) {
      // ⚠️ קוד שהוזן כאן ונדחה במסד — כנראה הוחלף בינתיים בפאנל הניהול. שוכחים אותו, כדי שהלחיצה הבאה
      // תבקש אותו שוב במקום להיכשל שוב ושוב בשקט.
      if (hasTaskCode() && /אין הרשאה/.test(err.message)) {
        setTaskCode(null);
        setUnlocked(false);
        setActError(`${err.message} — ייתכן שקוד המנהל הוחלף. יש להזין אותו שוב.`);
      } else {
        setActError(err.message);
      }
      await load();
      onChanged?.();
    } finally {
      setBusyId(null);
    }
  };

  const isConfirm = (t, what) => confirm?.id === t.id && confirm.what === what;
  // רשאי — לפי הזהות (מה שה-SQL החזיר לשורה), או כי קוד המנהל כבר הוזן בחלון הזה
  const may = (t, what) => allowed(t, what) || unlocked;
  // V / X: מי שאינו רשאי — שדה לקוד המנהל מתחת לשורה; לחיצה ראשונה — מבקשת אישור; שנייה — שולחת.
  // ⚠️ השנייה נחשבת רק אם היא לחיצה בפני עצמה: לא חלק מלחיצה כפולה (e.detail > 1), ולא פחות מ-ARM_MIN_MS
  // אחרי החימוש. (מקש Enter שמוחזק — נחסם ב-onKeyDown, ראו closeBtn.)
  const ask = (t, what, fn, e) => {
    if (!may(t, what)) {
      setRowMsg(null);
      setConfirm(null);
      setCodeFor({ id: t.id, what });
      setCodeVal("");
      setCodeErr("");
      return;
    }
    setRowMsg(null);
    setCodeFor(null);
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

  // הקוד נבדק מול המסד (verify_admin_code — הגיבוב לא מגיע לדפדפן), ורק אחרי אישור נשמר ומבצע את מה
  // שנלחץ. ⚠️ בלי לחיצת אישור נוספת: הזנת הקוד ו"אישור" הן כבר שתי פעולות מכוונות.
  const submitCode = async (e, t) => {
    e.preventDefault();
    if (!codeVal || codeBusy || !codeFor) return;
    setCodeBusy(true);
    setCodeErr("");
    try {
      if (!(await verifyAdminCode(codeVal))) { setCodeErr("קוד שגוי"); return; }
      setTaskCode(codeVal);
      setUnlocked(true);
      const what = codeFor.what;
      setCodeFor(null);
      setCodeVal("");
      await act(t, what === "done" ? markTaskDone : deleteTask);
    } catch (err) {
      setCodeErr(err.message || "אימות הקוד נכשל");
    } finally {
      setCodeBusy(false);
    }
  };
  const codeForm = (t) => codeFor?.id === t.id && (
    <form className="tk-code" onSubmit={(e) => submitCode(e, t)}>
      <label className="tk-code-label" htmlFor={`${kindName}-code`}>
        {codeFor.what === "done" ? "קוד מנהל — כדי לסמן בוצע" : "קוד מנהל — כדי למחוק"}
      </label>
      <div className="tk-code-row">
        <input id={`${kindName}-code`} className="tk-input tk-code-input" type="password" autoComplete="off"
          autoFocus value={codeVal} disabled={codeBusy}
          onChange={(e) => { setCodeVal(e.target.value); setCodeErr(""); }} />
        <button type="submit" className="tk-btn tk-btn--primary" disabled={!codeVal || codeBusy}>
          {codeBusy ? "בודק…" : "אישור"}
        </button>
        <button type="button" className="tk-link" onClick={() => setCodeFor(null)}>ביטול</button>
      </div>
      {codeErr && <p className="tk-code-err" role="alert">{codeErr}</p>}
    </form>
  );

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
    const ok = may(t, what);
    return (
      <button type="button"
        className={`tk-ico tk-ico--${isDone ? "done" : "del"}${pending ? " is-confirm" : ""}${ok ? "" : " is-locked"}`}
        aria-disabled={ok ? undefined : "true"} disabled={busyId === t.id}
        onClick={(e) => ask(t, what, isDone ? markTaskDone : deleteTask, e)}
        // ⚠️ Enter מוחזק חוזר על עצמו, וכל חזרה היא לחיצה — הראשונה מחמשת והבאות היו מאשרות
        onKeyDown={(e) => { if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault(); }}
        title={!ok ? NO_RIGHTS[what] : pending ? "לחיצה נוספת מאשרת" : isDone ? "בוצע" : "מחיקה"}
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

        {/* ⚠️ שתי שורות (12/10/2026, ערב: "תעצב את הכל בצורה יותר מסודרת" — על שורה אחת עם השדה, שלוש
            גלולות בגובה אחר ו"הוספה"): מה — ברוחב מלא; מתחת — הסוג ו"הוספה". השגיאה בתוך הטופס, מעל הקו */}
        <form className="tk-add" onSubmit={submit}>
          {/* ⚠️ כל שינוי בטיוטה (טקסט או סוג) — client_id חדש. בלי זה: שליחה שהתחייבה ותשובתה אבדה, ואז
              החלפת סוג ו"הוספה" שוב — המסד מזהה את אותו client_id ומחזיר את הראשונה, עם הסוג הישן, בשקט
              (נמצא בסקירה). שליחה חוזרת של אותה טיוטה בדיוק — אותו מזהה, משימה אחת. */}
          <input ref={inputRef} className="tk-input" type="text" maxLength={2000} value={body}
            placeholder="משימה חדשה…" aria-label="משימה חדשה"
            onChange={(e) => { setBody(e.target.value); clientId.current = newId(); }} />
          <div className="tk-add-row">
            <span className="tk-kind-cap" aria-hidden="true">סוג</span>
            <div ref={kindsRef} className={`tk-kinds${kindMissing ? " is-missing" : ""}`} role="radiogroup" aria-label="סוג המשימה"
              aria-invalid={kindMissing || undefined} aria-describedby={kindMissing ? `${kindName}-err` : undefined}>
              {TASK_KINDS.map((k) => (
                <label key={k} className="tk-kind-opt">
                  <input type="radio" name={kindName} value={k} checked={kind === k}
                    onChange={() => { setKind(k); setSaveError(""); clientId.current = newId(); }} />
                  <span>{kindLabel(k)}</span>
                </label>
              ))}
            </div>
            <button type="submit" className="tk-btn tk-btn--primary" disabled={!canAdd}>{saving ? "מוסיף…" : "הוספה"}</button>
          </div>
          {saveError && <p key={errTick} id={`${kindName}-err`} className="tk-error" role="alert">{saveError}</p>}
        </form>
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
                  <TaskRow key={t.id} t={t} state={state} note={rowMsg?.id === t.id ? rowMsg.msg : null}
                    below={codeForm(t)}>
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
