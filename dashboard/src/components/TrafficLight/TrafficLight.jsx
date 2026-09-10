// components/TrafficLight/TrafficLight.jsx — לוח הרמזור.
//
// ============================================================
// לוח חופשי בסגנון Monday: שורות, עמודות שהמשתמש מגדיר, תאים חופשיים
// ============================================================
// ⚠️ **העמודות אינן עמודות SQL.** "הוסף עמודה" מהדפדפן היה אומר DDL
// מהדפדפן; כאן עמודה היא שורה בטבלת הגדרות והתאים ב-JSONB. ההסבר
// המלא ב-`db/traffic-light.postgres.sql`.
//
// ============================================================
// ⚠️ הצפייה פתוחה לכולם. **רק העריכה** מאחורי קוד.
// ============================================================
// הגרסה הראשונה חסמה את הכניסה עצמה, וזה היה הפוך: הלוח הזה הוא מידע
// תפעולי שכל בקר צריך לראות — מי לקוח VIP, מי איש הקשר, מה סוג ההסכם.
// חסימת הצפייה הופכת אותו לגיליון שרק מנהל רואה, כלומר לגיליון שאיש
// לא משתמש בו.
//
// ⚠️ **וההגנה אינה הקוד.** `app.require_manager()` בתוך כל פונקציה קורא
// את התפקיד **מהטבלה**; בקר שינסה לשמור יקבל 403 מהמסד גם אם הקוד
// בידיו. הקוד הוא צעד אישור לפני עריכה, בדיוק כמו בניהול האתרים.
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdmin } from "../../hooks/useAdmin";
import {
  fetchBoard, addColumn, updateColumn, deleteColumn,
  addRow, deleteRow, setCell, pasteRows,
} from "../../services/trafficLightDirect";
import "./TrafficLight.css";

// ============================================================
// ⚠️ הפלטה של Monday, במלואה — ולא בורר צבעים חופשי
// ============================================================
// הלוח הזה נועד להחליף לוח Monday קיים, ומי שיסתכל על שניהם צריך
// לזהות את אותו ערך לפי הצבע. בורר RGB חופשי נותן 16 מיליון גוונים
// ואף אחד מהם אינו "הירוק של Monday" — כלומר הוא הופך התאמה מדויקת
// לניחוש. רשימה סגורה מבטיחה שהצבעים **זהים**.
//
// ⚠️ ובורר חופשי נשאר בכל זאת, בפינה: לוח שאין בו את הגוון שצריך הוא
// לוח שמכריח פשרה. הרשימה היא ברירת המחדל, לא כלא.
const MONDAY_PALETTE = [
  // ירוקים
  "#00c875", "#037f4c", "#9cd326", "#cab641",
  // צהוב־כתום
  "#ffcb00", "#fdab3d", "#ff642e", "#7f5347",
  // אדומים־ורודים
  "#e2445c", "#bb3354", "#ff158a", "#ff5ac4",
  "#ff7575", "#ffadad", "#ff7ab2", "#faa1f1",
  // סגולים
  "#a25ddc", "#784bd1", "#401694", "#7e3b8a",
  "#bda8f9", "#c4c4c4", "#9aadbd", "#68a1bd",
  // כחולים
  "#0086c0", "#579bfc", "#225091", "#175a63",
  "#66ccff", "#4eccc6", "#a1e3f6", "#5559df",
  // ניטרליים
  "#808080", "#787d80", "#333333", "#7e7e7e",
];

// ברירת המחדל לערך חדש — רצה על הפלטה לפי הסדר, כדי ששני ערכים
// עוקבים לא יקבלו את אותו צבע.
const STATUS_COLORS = MONDAY_PALETTE;

// ============================================================
// בורר צבע — לוח משבצות, כמו ב-Monday
// ============================================================
function ColorPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="tl-cp">
      <button
        type="button"
        className="tl-cp-btn"
        style={{ background: value }}
        onClick={() => setOpen((v) => !v)}
        aria-label="בחירת צבע"
        title="בחירת צבע"
      />
      {open && (
        <>
          {/* ⚠️ שכבה שקופה שסוגרת בלחיצה בחוץ. בלעדיה הלוח נשאר פתוח
              ומכסה את השורות שמתחתיו. */}
          <span className="tl-cp-back" onClick={() => setOpen(false)} />
          <span className="tl-cp-pop" onClick={(e) => e.stopPropagation()}>
            <span className="tl-cp-grid">
              {MONDAY_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`tl-cp-sw${c === value ? " is-on" : ""}`}
                  style={{ background: c }}
                  title={c}
                  aria-label={c}
                  onClick={() => { onChange(c); setOpen(false); }}
                />
              ))}
            </span>
            <label className="tl-cp-custom">
              <span>מותאם</span>
              <input
                type="color"
                value={value}
                onChange={(e) => onChange(e.target.value)}
              />
            </label>
          </span>
        </>
      )}
    </span>
  );
}

const KINDS = [
  { key: "text",     label: "טקסט" },
  { key: "status",   label: "סטטוס (צבע)" },
  { key: "number",   label: "מספר" },
  { key: "date",     label: "תאריך" },
  { key: "checkbox", label: "וי" },
  { key: "link",     label: "קישור" },
];

// ============================================================
// תא — הפקד משתנה לפי סוג העמודה
// ============================================================
// ⚠️ **השמירה ב-blur ולא בכל הקשה.** שמירה על כל תו הייתה מייצרת בקשה
// לכל אות, ובלוח של 40 שורות זה מאות בקשות בהקלדה אחת. אותו נימוק
// בדיוק שבגללו רוסן הסוכן.
//
// ⚠️ ובמצב צפייה הערך מוצג כטקסט ולא כשדה מנוטרל: שדה אפור נראה כמו
// תקלה, וטקסט נראה כמו מידע.
function Cell({ column, value, onSave, readOnly }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => { setDraft(value ?? ""); }, [value]);

  const opts = Array.isArray(column.options) ? column.options : [];
  const hit = opts.find((o) => o.value === value);

  if (readOnly) {
    if (column.kind === "status") {
      return hit
        ? <span className="tl-status tl-status--ro" style={{ background: hit.color }}>{hit.label}</span>
        : <span className="tl-ro tl-ro--dim">—</span>;
    }
    if (column.kind === "checkbox") {
      return <span className="tl-ro">{value === true ? "✓" : ""}</span>;
    }
    if (column.kind === "link" && value) {
      return <a className="tl-ro tl-ro--link" href={String(value)} target="_blank" rel="noreferrer">{String(value)}</a>;
    }
    // ⚠️ הערך המלא ב-title: מרגע שהתא נחתך, זו הדרך היחידה לראות
    // ערך ארוך בלי להיכנס למצב עריכה.
    return <span className="tl-ro" title={value ? String(value) : undefined}>{value ?? ""}</span>;
  }

  if (column.kind === "status") {
    return (
      <select
        className="tl-status"
        style={hit ? { background: hit.color, color: "#fff" } : undefined}
        value={value ?? ""}
        onChange={(e) => onSave(e.target.value || null)}
      >
        <option value="">—</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }

  if (column.kind === "checkbox") {
    return (
      <input
        type="checkbox"
        className="tl-check"
        checked={value === true}
        onChange={(e) => onSave(e.target.checked ? true : null)}
      />
    );
  }

  const type = column.kind === "number" ? "number"
             : column.kind === "date"   ? "date"
             : "text";

  return (
    <input
      className="tl-input"
      type={type}
      title={draft ? String(draft) : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (String(draft) === String(value ?? "")) return;
        if (column.kind === "number") {
          const n = draft === "" ? null : Number(draft);
          onSave(Number.isFinite(n) ? n : null);
        } else {
          onSave(draft === "" ? null : draft);
        }
      }}
      // ⚠️ Enter שומר ומשחרר מיקוד — בלוח כזה מקלידים ברצף, והעכבר
      // הוא מה שמאט. Escape מחזיר את הערך המקורי.
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { setDraft(value ?? ""); e.currentTarget.blur(); }
      }}
    />
  );
}

// ============================================================
// עורך עמודה — שם, סוג, ואפשרויות הסטטוס
// ============================================================
function ColumnEditor({ column, onSave, onDelete, onClose }) {
  const [label, setLabel] = useState(column.label);
  const [kind, setKind] = useState(column.kind);
  const [options, setOptions] = useState(
    Array.isArray(column.options) ? column.options : []);

  const addOption = () => setOptions((o) => [...o, {
    value: `o${Date.now()}`,
    label: "ערך חדש",
    color: STATUS_COLORS[o.length % STATUS_COLORS.length],
  }]);

  return (
    <div className="tl-pop" onClick={(e) => e.stopPropagation()}>
      <label className="tl-pop-row">
        <span>שם</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
      </label>

      <label className="tl-pop-row">
        <span>סוג</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
        </select>
      </label>

      {kind === "status" && (
        <div className="tl-opts">
          <div className="tl-opts-head">
            <span>אפשרויות</span>
            <button type="button" className="tl-mini" onClick={addOption}>+ ערך</button>
          </div>
          {options.map((o, i) => (
            <div key={o.value} className="tl-opt">
              <ColorPicker
                value={o.color}
                onChange={(col) => setOptions((all) =>
                  all.map((x, j) => j === i ? { ...x, color: col } : x))}
              />
              <input
                className="tl-opt-label"
                value={o.label}
                onChange={(e) => setOptions((all) =>
                  all.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
              />
              <button
                type="button"
                className="tl-mini tl-mini--danger"
                onClick={() => setOptions((all) => all.filter((_, j) => j !== i))}
              >✕</button>
            </div>
          ))}
          {options.length === 0 && <p className="tl-hint">אין ערכים — הוסיפי לפחות אחד.</p>}
        </div>
      )}

      <div className="tl-pop-actions">
        {/* ⚠️ מחיקת עמודה **אינה מוחקת את התאים** — הערכים נשארים תחת
            המפתח הישן, והוספה מחדש מחזירה אותם. נאמר כאן במפורש, אחרת
            אף אחד לא יעז ללחוץ. */}
        <button
          type="button"
          className="tl-btn-ghost tl-btn--danger"
          onClick={() => { if (confirm(`למחוק את העמודה "${column.label}"?\nהנתונים נשמרים ויחזרו אם תוסיפי עמודה כזו שוב.`)) onDelete(); }}
        >מחק עמודה</button>
        <span className="tl-spacer" />
        <button type="button" className="tl-btn-ghost" onClick={onClose}>ביטול</button>
        <button
          type="button"
          className="tl-btn"
          onClick={() => onSave({ label, kind, options })}
        >שמור</button>
      </div>
    </div>
  );
}

// ============================================================
// חלונית הקוד — עם עין
// ============================================================
// ⚠️ **העין קיימת כי קוד שמוקלד עיוור נכשל ואיש לא יודע למה.** שדה
// סיסמה שמראה נקודות בלבד הופך שגיאת הקלדה אחת ל"הקוד לא נכון", וזו
// תשובה שאי אפשר לעשות איתה כלום. כאן אפשר פשוט להסתכל.
//
// ⚠️ ומתחיל **מוסתר**, לא גלוי: הלוח נפתח לעיתים מול מסך משותף.
function CodePrompt({ onUnlock, onClose, checking, error }) {
  const [code, setCode] = useState("");
  const [shown, setShown] = useState(false);

  return (
    <div className="tl-code-back" onClick={onClose}>
      <form
        className="tl-code"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onUnlock(code); }}
      >
        <h3>מצב עריכה</h3>
        <p>הזיני את קוד המנהל כדי לערוך את הלוח.</p>

        <div className="tl-code-field">
          <input
            type={shown ? "text" : "password"}
            placeholder="קוד מנהל"
            autoComplete="current-password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
          <button
            type="button"
            className="tl-eye"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? "הסתר את הקוד" : "הצג את הקוד"}
            title={shown ? "הסתר" : "הצג"}
          >
            {shown ? (
              // עין חצויה — מוצג כרגע, לחיצה תסתיר
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"
                      fill="none" stroke="currentColor" strokeWidth="1.7" />
                <circle cx="12" cy="12" r="2.7" fill="none" stroke="currentColor" strokeWidth="1.7" />
                <path d="M4 20L20 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"
                      fill="none" stroke="currentColor" strokeWidth="1.7" />
                <circle cx="12" cy="12" r="2.7" fill="none" stroke="currentColor" strokeWidth="1.7" />
              </svg>
            )}
          </button>
        </div>

        {error && <p className="tl-err">{error}</p>}

        <div className="tl-lock-actions">
          <button type="button" className="tl-btn-ghost" onClick={onClose}>ביטול</button>
          <button type="submit" className="tl-btn" disabled={checking || !code}>
            {checking ? "בודק…" : "פתח עריכה"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function TrafficLight({ onClose }) {
  const { unlocked, unlock, checking, error: unlockError, roleGated, role } = useAdmin();

  // ⚠️ **דגל מקומי ולא `lock()` מה-hook.** בזרוע הישירה `lock` היא
  // פונקציה ריקה בכוונה — שם אין מה לנעול, כי הפאנל מתפרק בכל סגירה.
  // כאן הלוח **נשאר פתוח** אחרי היציאה ממצב עריכה, ולכן צריך מתג משלו;
  // בלעדיו כפתור "נעל" היה נראה כאילו הוא עובד ולא משנה דבר.
  const [editMode, setEditMode] = useState(false);

  const [board, setBoard] = useState({ columns: [], rows: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editCol, setEditCol] = useState(null);
  const [askCode, setAskCode] = useState(false);
  const pasteRef = useRef(null);

  // ⚠️ מצב עריכה דורש **גם** קוד וגם תפקיד. `roleGated` אומר שהמסד לא
  // יקבל כתיבה מהמשתמש הזה בשום מקרה, ואז הקוד חסר משמעות.
  const canEdit = unlocked && editMode;

  const load = useCallback(async () => {
    setLoading(true);
    try { setBoard(await fetchBoard()); setErr(null); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ⚠️ **Escape סוגר — וזה נחוץ דווקא עכשיו.** הלוח תופס את כל המסך,
  // ולכן אין עוד "מחוץ לחלון" ללחוץ עליו. בלי מקש מילוט הדרך היחידה
  // לצאת היא ה-✕ בפינה.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // חלונית הקוד ועורך העמודה נסגרים ראשונים — Escape שסוגר את
      // הכול בבת אחת מאבד למשתמשת את מה שהיא באמצע.
      if (askCode) { setAskCode(false); return; }
      if (editCol) { setEditCol(null); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askCode, editCol, onClose]);

  // ⚠️ כל פעולה עוברת דרך העטיפה הזו: נועלת, מרעננת, ומציגה שגיאה.
  // בלעדיה כל אחת מעשר הפעולות הייתה חוזרת על אותן ארבע שורות — וזו
  // בדיוק הרשימה שמישהו ישכח להרחיב.
  const run = useCallback(async (fn) => {
    setBusy(true);
    try { await fn(); await load(); setErr(null); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }, [load]);

  const columns = board.columns;
  const rows = board.rows;

  // ⚠️ הדבקה מ-Excel/Monday: טאבים בין תאים, שורות חדשות בין שורות.
  // זו הדרך שבה הלוח באמת ימולא, ולכן היא קריאה אחת ולא מאות.
  const handlePaste = useCallback(async (text) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) return;
    if (columns.length === 0) { setErr("צריך להגדיר עמודות לפני הדבקה."); return; }

    const payload = lines.map((line) => {
      const parts = line.split("\t");
      const cells = {};
      columns.forEach((c, i) => {
        const v = (parts[i] ?? "").trim();
        if (v !== "") cells[c.key] = c.kind === "number" ? (Number(v) || v) : v;
      });
      return cells;
    });

    await run(() => pasteRows(payload));
  }, [columns, run]);

  return (
    <div className="tl-overlay" onClick={onClose}>
      <div className="tl-panel" onClick={(e) => { setEditCol(null); e.stopPropagation(); }}>
        <header className="tl-head">
          <h2>רמזור</h2>

          {/* ⚠️ המצב נאמר במפורש. לוח שנראה ניתן לעריכה ואינו כזה מייצר
              הקלדה שנעלמת בלי הסבר — וזו התלונה הכי שקטה שיש. */}
          <span className={`tl-mode ${canEdit ? "tl-mode--edit" : ""}`}>
            {canEdit ? "מצב עריכה" : "צפייה בלבד"}
          </span>

          <div className="tl-head-actions">
            {canEdit ? (
              <>
                <button
                  type="button"
                  className="tl-btn-ghost"
                  disabled={busy}
                  onClick={() => run(async () => {
                    const label = prompt("שם העמודה החדשה:");
                    if (!label) throw new Error("בוטל");
                    await addColumn(label, "text", []);
                  })}
                >+ עמודה</button>
                <button
                  type="button"
                  className="tl-btn"
                  disabled={busy}
                  onClick={() => run(() => addRow(null))}
                >+ שורה</button>
                <button
                  type="button"
                  className="tl-btn-ghost"
                  onClick={() => { setEditMode(false); setEditCol(null); }}
                  title="חזרה לצפייה בלבד"
                >נעל</button>
              </>
            ) : (
              <button
                type="button"
                className="tl-btn"
                onClick={() => setAskCode(true)}
                title={roleGated ? "עריכה מותרת למנהלים בלבד" : "פתיחת מצב עריכה"}
              >עריכה</button>
            )}
            <button type="button" className="tl-close" onClick={onClose} aria-label="סגור">✕</button>
          </div>
        </header>

        {/* ⚠️ שורת השגיאה דביקה בראש הגלילה. הודעה שדורשת לגלול אליה
            נקראת כמו "לא קרה כלום" — זה כבר נמדד בפאנל הניהול. */}
        {err && <div className="tl-err-bar">{err}</div>}

        {/* ⚠️ נאמר לפני שמקלידים קוד, לא אחרי: המסד ידחה כתיבה מבקר גם
            עם הקוד הנכון, ובלי המשפט הזה זה נראה כמו "הקוד לא עובד". */}
        {roleGated && askCode === false && (
          <div className="tl-note">
            התפקיד שלך: {role === "manager" ? "מנהל" : "בקר"} — עריכה מותרת למנהלים בלבד.
          </div>
        )}

        {canEdit && (
          <div className="tl-paste">
            <label htmlFor="tl-paste-box">הדבקה מ-Excel או מ-Monday (טאבים בין עמודות):</label>
            <textarea
              id="tl-paste-box"
              ref={pasteRef}
              rows={2}
              placeholder="הדביקי כאן ולחצי 'הוסף שורות'"
              disabled={busy || columns.length === 0}
            />
            <button
              type="button"
              className="tl-btn-ghost"
              disabled={busy || columns.length === 0}
              onClick={() => {
                const t = pasteRef.current?.value ?? "";
                if (t.trim()) { handlePaste(t); pasteRef.current.value = ""; }
              }}
            >הוסף שורות</button>
          </div>
        )}

        <div className="tl-scroll">
          {loading ? (
            <p className="tl-empty">טוען…</p>
          ) : columns.length === 0 ? (
            <p className="tl-empty">
              {canEdit
                ? <>הלוח ריק. התחילי ב־<strong>+ עמודה</strong>, ואז <strong>+ שורה</strong> — או הדביקי ישירות אחרי שהגדרת עמודות.</>
                : <>הלוח ריק עדיין.</>}
            </p>
          ) : (
            <table className="tl-table">
              <thead>
                <tr>
                  <th className="tl-th-num">#</th>
                  {columns.map((c) => (
                    // ⚠️ `width` ולא `minWidth`: עם `table-layout: fixed`
                    // זה הרוחב **בפועל**, והתוכן נחתך במקום למתוח את
                    // העמודה. `minWidth` נתן לתא של 60 תווים לייצר עמודה
                    // של 600px ולדחוק את כל השאר — וזה מה שנראה על המסך.
                    <th key={c.id} style={{ width: c.width, maxWidth: c.width }}>
                      {canEdit ? (
                        <button
                          type="button"
                          className="tl-th-btn"
                          onClick={(e) => { e.stopPropagation(); setEditCol(editCol === c.id ? null : c.id); }}
                          title="לחצי לעריכת העמודה"
                        >
                          {c.label}
                          <span className="tl-th-kind">{KINDS.find((k) => k.key === c.kind)?.label}</span>
                        </button>
                      ) : (
                        <span className="tl-th-btn tl-th-btn--ro">{c.label}</span>
                      )}
                      {canEdit && editCol === c.id && (
                        <ColumnEditor
                          column={c}
                          onClose={() => setEditCol(null)}
                          onSave={(patch) => { setEditCol(null); run(() => updateColumn(c.id, patch)); }}
                          onDelete={() => { setEditCol(null); run(() => deleteColumn(c.id)); }}
                        />
                      )}
                    </th>
                  ))}

                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id}>
                    {/* ============================================================
                        ⚠️ המחיקה יושבת כאן ולא בסוף השורה
                        ============================================================
                        היא הייתה בעמודה האחרונה, ועם עשר עמודות זה אומר
                        לגלול עד הסוף כדי למחוק שורה — כלומר כפתור שקיים
                        ואי אפשר להגיע אליו. תא מספר השורה **קפוא משמאל**
                        ולכן הוא תמיד גלוי, בדיוק כמו ב-Monday.

                        ⚠️ והמספר מתחלף ב-✕ רק בריחוף: ✕ קבוע על כל שורה
                        הופך מחיקה ללחיצה מקרית, ומספר שנעלם תמיד מקשה
                        לספור. */}
                    <td className="tl-td-num">
                      <span className="tl-rownum">{i + 1}</span>
                      {canEdit && (
                        <button
                          type="button"
                          className="tl-rowdel"
                          disabled={busy}
                          title="מחק שורה"
                          aria-label={`מחק שורה ${i + 1}`}
                          onClick={() => { if (confirm("למחוק את השורה?")) run(() => deleteRow(r.id)); }}
                        >✕</button>
                      )}
                    </td>
                    {columns.map((c) => (
                      <td key={c.key}>
                        <Cell
                          column={c}
                          value={r.cells?.[c.key]}
                          readOnly={!canEdit || busy}
                          onSave={(v) => run(() => setCell(r.id, c.key, v))}
                        />
                      </td>
                    ))}

                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td className="tl-empty" colSpan={columns.length + 1}>אין שורות עדיין.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <footer className="tl-foot">
          <span>{rows.length} שורות · {columns.length} עמודות</span>
          {busy && <span className="tl-busy">שומר…</span>}
        </footer>

        {askCode && (
          <CodePrompt
            checking={checking}
            error={unlockError}
            onClose={() => setAskCode(false)}
            onUnlock={async (code) => {
              const ok = await unlock(code);
              // ⚠️ נסגר רק בהצלחה. סגירה בכל מקרה הייתה מחזירה את
              // המשתמשת ללוח בלי לומר שהקוד נדחה.
              if (ok !== false) { setEditMode(true); setAskCode(false); }
            }}
          />
        )}
      </div>
    </div>
  );
}
