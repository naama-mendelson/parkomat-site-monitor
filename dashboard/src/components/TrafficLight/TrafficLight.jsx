// components/TrafficLight/TrafficLight.jsx — לוח הרמזור.
//
// ============================================================
// לוח חופשי בסגנון Monday: שורות, עמודות שהמשתמש מגדיר, תאים חופשיים
// ============================================================
// ⚠️ **העמודות אינן עמודות SQL.** "הוסף עמודה" מהדפדפן היה אומר DDL
// מהדפדפן; כאן עמודה היא שורה בטבלת הגדרות והתאים ב-JSONB. ההסבר
// המלא ב-`db/traffic-light.postgres.sql`.
//
// ⚠️ **וההרשאה אינה כאן.** `app.require_manager()` בתוך כל פונקציה קורא
// את התפקיד מהטבלה; קוד המנהל שהמסך מבקש הוא צעד אישור לפני פעולה
// בלתי-הפיכה, לא ההגנה. אותו דפוס כמו ניהול האתרים.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdmin } from "../../hooks/useAdmin";
import Logo from "../Logo/Logo";
import {
  fetchBoard, addColumn, updateColumn, deleteColumn,
  addRow, deleteRow, setCell, pasteRows,
} from "../../services/trafficLightDirect";
import "./TrafficLight.css";

// ⚠️ הצבעים לקוחים מלוח Monday המקורי בכוונה — הלוח הזה נועד להחליף
// גיליון שכבר קיים שם, ומי שיסתכל על שניהם צריך לזהות את אותו ערך.
const STATUS_COLORS = [
  "#00c875", "#fdab3d", "#e2445c", "#0086c0", "#a25ddc",
  "#579bfc", "#ff642e", "#9cd326", "#787d80", "#333333",
];

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
// לכל אות, ובלוח של 40 שורות זה מאות בקשות בזמן הקלדה אחת. אותו נימוק
// בדיוק שבגללו ריסנו את הסוכן היום.
function Cell({ column, value, onSave, readOnly }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => { setDraft(value ?? ""); }, [value]);

  if (column.kind === "status") {
    const opts = Array.isArray(column.options) ? column.options : [];
    const hit = opts.find((o) => o.value === value);
    return (
      <select
        className="tl-status"
        style={hit ? { background: hit.color, color: "#fff" } : undefined}
        value={value ?? ""}
        disabled={readOnly}
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
        disabled={readOnly}
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
      value={draft}
      readOnly={readOnly}
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
              <input
                className="tl-opt-color"
                type="color"
                value={o.color}
                onChange={(e) => setOptions((all) =>
                  all.map((x, j) => j === i ? { ...x, color: e.target.value } : x))}
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

export default function TrafficLight({ onClose }) {
  const { unlocked, unlock, checking, error: unlockError, roleGated, role } = useAdmin();
  const [code, setCode] = useState("");

  const [board, setBoard] = useState({ columns: [], rows: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editCol, setEditCol] = useState(null);
  const pasteRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setBoard(await fetchBoard()); setErr(null); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ⚠️ כל פעולה עוברת דרך העטיפה הזו: היא נועלת את המסך, מרעננת, ומציגה
  // שגיאה. בלעדיה כל אחת מעשר הפעולות הייתה חוזרת על אותן ארבע שורות —
  // וזו בדיוק הרשימה שמישהו ישכח להרחיב.
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
        if (v !== "") cells[c.key] = c.kind === "number" ? Number(v) || v : v;
      });
      return cells;
    });

    await run(() => pasteRows(payload));
  }, [columns, run]);

  // ===== שער התפקיד =====
  if (!unlocked && roleGated) {
    return (
      <div className="tl-overlay" onClick={onClose}>
        <div className="tl-lock" onClick={(e) => e.stopPropagation()}>
          <div className="tl-lock-icon"><Logo size={40} /></div>
          <h2>רמזור</h2>
          {checking ? <p>בודק הרשאות…</p> : (
            <>
              <p>עריכת הלוח מותרת למנהלים בלבד.</p>
              <p className="tl-lock-role">התפקיד שלך: {role === "manager" ? "מנהל" : "בקר"}</p>
            </>
          )}
          <div className="tl-lock-actions">
            <button type="button" className="tl-btn" onClick={onClose}>סגור</button>
          </div>
        </div>
      </div>
    );
  }

  // ===== שער הקוד =====
  if (!unlocked) {
    return (
      <div className="tl-overlay" onClick={onClose}>
        <div className="tl-lock" onClick={(e) => e.stopPropagation()}>
          <div className="tl-lock-icon"><Logo size={40} /></div>
          <h2>רמזור</h2>
          <p>הזיני את קוד המנהל כדי לערוך את הלוח.</p>
          <form onSubmit={(e) => { e.preventDefault(); unlock(code); }}>
            <input
              type="password"
              placeholder="קוד מנהל"
              autoComplete="current-password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
            {unlockError && <p className="tl-err">{unlockError}</p>}
            <div className="tl-lock-actions">
              <button type="button" className="tl-btn-ghost" onClick={onClose}>ביטול</button>
              <button type="submit" className="tl-btn" disabled={checking || !code}>
                {checking ? "בודק…" : "כניסה"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ===== הלוח =====
  return (
    <div className="tl-overlay" onClick={onClose}>
      <div className="tl-panel" onClick={(e) => e.stopPropagation()}>
        <header className="tl-head">
          <h2>רמזור</h2>
          <div className="tl-head-actions">
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
            <button type="button" className="tl-close" onClick={onClose} aria-label="סגור">✕</button>
          </div>
        </header>

        {/* ⚠️ שורת השגיאה דביקה בראש הגלילה. הגרסה של פאנל הניהול לימדה
            שהודעה שדורשת לגלול אליה נקראת כמו "לא קרה כלום". */}
        {err && <div className="tl-err-bar">{err}</div>}

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

        <div className="tl-scroll">
          {loading ? (
            <p className="tl-empty">טוען…</p>
          ) : columns.length === 0 ? (
            <p className="tl-empty">
              הלוח ריק. התחילי ב־<strong>+ עמודה</strong>, ואז <strong>+ שורה</strong>
              — או הדביקי ישירות אחרי שהגדרת עמודות.
            </p>
          ) : (
            <table className="tl-table">
              <thead>
                <tr>
                  <th className="tl-th-num">#</th>
                  {columns.map((c) => (
                    <th key={c.id} style={{ minWidth: c.width }}>
                      <button
                        type="button"
                        className="tl-th-btn"
                        onClick={() => setEditCol(editCol === c.id ? null : c.id)}
                        title="לחצי לעריכת העמודה"
                      >
                        {c.label}
                        <span className="tl-th-kind">{KINDS.find((k) => k.key === c.kind)?.label}</span>
                      </button>
                      {editCol === c.id && (
                        <ColumnEditor
                          column={c}
                          onClose={() => setEditCol(null)}
                          onSave={(patch) => { setEditCol(null); run(() => updateColumn(c.id, patch)); }}
                          onDelete={() => { setEditCol(null); run(() => deleteColumn(c.id)); }}
                        />
                      )}
                    </th>
                  ))}
                  <th className="tl-th-act" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id}>
                    <td className="tl-td-num">{i + 1}</td>
                    {columns.map((c) => (
                      <td key={c.key}>
                        <Cell
                          column={c}
                          value={r.cells?.[c.key]}
                          readOnly={busy}
                          onSave={(v) => run(() => setCell(r.id, c.key, v))}
                        />
                      </td>
                    ))}
                    <td className="tl-td-act">
                      <button
                        type="button"
                        className="tl-mini tl-mini--danger"
                        disabled={busy}
                        title="מחק שורה"
                        onClick={() => { if (confirm("למחוק את השורה?")) run(() => deleteRow(r.id)); }}
                      >✕</button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td className="tl-empty" colSpan={columns.length + 2}>אין שורות עדיין.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <footer className="tl-foot">
          <span>{rows.length} שורות · {columns.length} עמודות</span>
          {busy && <span className="tl-busy">שומר…</span>}
        </footer>
      </div>
    </div>
  );
}
