// ============================================================
// הסכם השירות של האתר — מתוך לוח הרמזור
// ============================================================
// ⚠️ **זה לא תצוגה בלבד, וזו הנקודה.** שעות ההסכם קובעות מתי הזמינות
// בכלל נמדדת, ולכן אתר שאינו מחובר לשורה ברמזור מחושב 24/7 — כלומר
// תקלה בשבת באתר בסיסי נספרת ככשל מלא. עד עכשיו החיבור נעשה בהקלדת
// קוד לתוך הלוח, וזה דבר שצריך לזכור לעשות; כאן הוא נעשה מהמקום שבו
// שואלים את השאלה.
//
// ⚠️ **החיבור הוא לפי קוד ולא לפי שם, ונמדד למה.** התאמה לפי שם נתנה
// 5 מתוך 23, ושתי המלכודות שלה חמורות: "ז'בוטינסקי" מול "ז'בוטניסקי"
// לא מתאימים לעולם **בשקט**, ו"הירקון 72" מול "הירקון 224" הם בניינים
// שונים שהתאמה מקורבת הייתה מזווגת. זיווג שגוי מדווח זמינות של אתר
// אחד על חשבון אחר.
import { useEffect, useMemo, useState } from "react";
import { useAdmin } from "../../hooks/useAdmin";
import CodePrompt from "../TrafficLight/CodePrompt";
import { fetchBoard, setCell, addRow } from "../../services/trafficLightDirect";
import "./ServiceAgreement.css";

const CODE_LABEL = "קוד אתר";
const KIND_LABEL = "להתייחס כ";

// שעות ההסכם — אותו מקור אמת כמו `app.service_windows` ב-SQL.
// ⚠️ כפילות מודעת: כאן זה טקסט למסך, שם זה חישוב. מה שאסור הוא ששניהם
// יהיו *חישוב* בשני מקומות.
const HOURS = {
  basic: "א׳–ה׳ 08:00–17:00",
  ext: "א׳–ה׳ 07:00–22:00 · ו׳ 08:00–13:00",
  vip: "א׳–ה׳ 07:00–22:00 · ו׳–ש׳ 08:00–22:00",
};

const KIND_NAMES = { basic: "בסיסי", ext: "מורחב", vip: "VIP" };

// ⚠️ **עמודת סטטוס נערכת ברשימה סגורה ולא בהקלדה.** "VIP " או "Vip"
// אינם מוכרים ל-`app.service_agreement`, והאתר היה חוזר בשקט לחישוב
// 24/7 — בדיוק הכשל שהמסך הזה קיים כדי למנוע. אותו נימוק שהוציא את
// בורר התעבורה בסוכן מתיבת טקסט לרשימה.
function FieldEditor({ column, value, disabled, onSave }) {
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => { setDraft(value ?? ""); }, [value]);

  if (column.kind === "status") {
    const opts = Array.isArray(column.options) ? column.options : [];
    return (
      <select
        className="sa-select sa-select--cell"
        value={String(draft ?? "")}
        disabled={disabled}
        onChange={(e) => { setDraft(e.target.value); onSave(e.target.value); }}
      >
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>{o.label || o.value}</option>
        ))}
      </select>
    );
  }

  if (column.kind === "checkbox") {
    return (
      <input
        type="checkbox"
        checked={draft === true}
        disabled={disabled}
        onChange={(e) => { setDraft(e.target.checked); onSave(e.target.checked); }}
      />
    );
  }

  // ⚠️ שמירה ב-blur ולא בכל הקשה: שמירה לכל תו היא עשרות קריאות רשת
  // על מילוי שדה אחד, ובחיבור איטי היא גם מייצרת סדר כתיבה שאינו
  // בהכרח סדר ההקלדה.
  return (
    <input
      className="sa-cell-input"
      type="text"
      value={String(draft ?? "")}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (String(draft ?? "") !== String(value ?? "")) onSave(draft); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
    />
  );
}

export default function ServiceAgreement({ site }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState("");

  // ⚠️ **אותו שער בדיוק כמו בלוח עצמו**, ולא שני מנגנונים שנראים זהים.
  // ‏`useAdmin` מאמת מול התפקיד, ו-`app.require_manager()` במסד הוא מה
  // שבאמת דוחה כתיבה — הקוד כאן הוא נוחות.
  const { unlocked, unlock, checking, error: unlockError } = useAdmin();
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchBoard()
      .then((b) => { if (alive) setBoard(b); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  const { codeKey, kindKey, nameKey, row, columns } = useMemo(() => {
    if (!board) return {};
    const cols = board.columns || [];
    const ck = cols.find((c) => c.label === CODE_LABEL)?.key;
    const kk = cols.find((c) => c.label === KIND_LABEL)?.key;
    const nk = cols[0]?.key;
    const r = ck
      ? (board.rows || []).find(
          (x) => String(x.cells?.[ck] ?? "").trim() === String(site.code))
      : null;
    return { codeKey: ck, kindKey: kk, nameKey: nk, row: r, columns: cols };
  }, [board, site.code]);

  // ⚠️ **שורה חדשה היא המקרה הרגיל, לא החריג.** ברוב האתרים אין שורה
  // בלוח כלל — הלוח נבנה מרשימת לקוחות ולא מרשימת האתרים המנוטרים.
  // דרישה למצוא שורה קיימת הייתה אומרת שכדי לחבר אתר צריך קודם ליצור
  // לו שורה בלוח, כלומר בדיוק הצעד שצריך לזכור ושבגללו 23 אתרים לא
  // חוברו.
  const NEW_ROW = "__new__";

  // ⚠️ **שמירה לפי תא ולא לפי שורה**, כמו בלוח עצמו: שליחת השורה
  // כולה הופכת כל שמירה לדריסה של מה שעורך אחר כתב בתא אחר.
  async function saveCell(rowId, key, value) {
    setBusy(true);
    setError(null);
    try {
      await setCell(rowId, key, value);
      setBoard(await fetchBoard());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    if (!choice || !codeKey) return;
    setBusy(true);
    setError(null);
    try {
      let rowId = Number(choice);

      if (choice === NEW_ROW) {
        rowId = Number(await addRow(null));

        // ⚠️ **השם נכתב לפני הקוד, וזה לא סגנון.** אם הכתיבה השנייה
        // תיכשל, שורה עם שם ובלי קוד היא שורה שאפשר לראות ולתקן ביד;
        // שורה עם קוד ובלי שם היא שורה אלמונית שנראית כמו תקלה בלוח.
        if (nameKey) await setCell(rowId, nameKey, String(site.site_name ?? ""));
      }

      await setCell(rowId, codeKey, String(site.code));
      setBoard(await fetchBoard());
      setPicking(false);
      setChoice("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !board) {
    return <div className="sa sa--err">טעינת הרמזור נכשלה: {error}</div>;
  }
  if (!board) return <div className="sa sa--dim">טוען הסכם שירות…</div>;

  if (!codeKey) {
    return (
      <div className="sa sa--err">
        אין בלוח הרמזור עמודת "{CODE_LABEL}" — בלעדיה אי אפשר לחבר אתר לשורה.
      </div>
    );
  }

  // ===== מחובר =====
  if (row) {
    const kind = String(row.cells?.[kindKey] ?? "").trim().toLowerCase();
    // ⚠️ ערך שאיננו מכירים מוצג כפי שהוא ולא נבלע לברירת מחדל: הוא
    // הסיבה שהזמינות של האתר הזה עדיין מחושבת 24/7, וההודאה בכך היא
    // מה שיגרום למישהו לתקן.
    const known = Object.prototype.hasOwnProperty.call(HOURS, kind);

    return (
      <div className="sa">
        <div className="sa-head">
          <span className="sa-title">הסכם שירות</span>
          <span className={`sa-kind sa-kind--${known ? kind : "unknown"}`}>
            {known ? KIND_NAMES[kind] : (kind || "לא הוגדר")}
          </span>
        </div>

        <div className="sa-hours">
          {known
            ? HOURS[kind]
            : "ההסכם בלוח אינו אחד מ-basic / ext / vip — הזמינות מחושבת 24/7"}
        </div>

        {known && (
          <div className="sa-note">
            הזמינות נמדדת <b>רק בתוך השעות האלה</b>. זמן מחוץ להן אינו נספר —
            לא לטובה ולא לרעה.
          </div>
        )}

        {/* ⚠️ **בעריכה כל העמודות מוצגות, גם הריקות.** בתצוגה שדה ריק
            הוא רעש; בעריכה הוא בדיוק מה שבאו למלא, והסתרתו הייתה
            הופכת את המסך הזה לחצי-עורך שאי אפשר לסמוך עליו. */}
        <dl className="sa-fields">
          {columns
            .filter((c) => c.label !== CODE_LABEL && c.key !== nameKey)
            .map((c) => {
              const v = row.cells?.[c.key];
              if (!editing && !String(v ?? "").trim()) return null;
              return (
                <div className="sa-field" key={c.key}>
                  <dt>{c.label}</dt>
                  <dd>
                    {editing
                      ? <FieldEditor
                          column={c}
                          value={v}
                          disabled={busy}
                          onSave={(next) => saveCell(row.id, c.key, next)}
                        />
                      : String(v)}
                  </dd>
                </div>
              );
            })}
        </dl>

        <div className="sa-foot">
          <span className="sa-linked">
            מחובר לשורה: <b>{String(row.cells?.[nameKey] ?? "—")}</b>
          </span>

          {editing ? (
            <button type="button" className="sa-btn sa-btn--ghost"
                    onClick={() => setEditing(false)} disabled={busy}>
              סיום עריכה
            </button>
          ) : (
            <button type="button" className="sa-btn sa-btn--ghost"
                    onClick={() => (unlocked ? setEditing(true) : setAsking(true))}>
              ערוך שורה
            </button>
          )}
        </div>

        {error && <div className="sa-err">{error}</div>}

        {asking && (
          <CodePrompt
            checking={checking}
            error={unlockError}
            onClose={() => setAsking(false)}
            onUnlock={async (code) => {
              const ok = await unlock(code);
              // ⚠️ `!== false` ולא `if (ok)` — זרוע אחת של `useAdmin`
              // מחזירה `undefined` בהצלחה, ואז `if (ok)` היה משאיר את
              // התיבה פתוחה אחרי קוד **נכון**. אותו ניסוח בדיוק כמו
              // בלוח עצמו, ובכוונה.
              if (ok !== false) { setAsking(false); setEditing(true); }
            }}
          />
        )}
      </div>
    );
  }

  // ===== לא מחובר =====
  // ⚠️ הרשימה מציעה **רק שורות פנויות**. שורה שכבר נושאת קוד אחר
  // תיקח את הזמינות של אתר אחר אם ידרסו אותה, ולכן היא אינה מוצעת.
  const free = (board.rows || []).filter(
    (r) => !String(r.cells?.[codeKey] ?? "").trim());

  return (
    <div className="sa">
      <div className="sa-head">
        <span className="sa-title">הסכם שירות</span>
        <span className="sa-kind sa-kind--unknown">לא מחובר</span>
      </div>

      <div className="sa-note">
        האתר אינו מחובר לשורה ברמזור, ולכן הזמינות שלו מחושבת <b>24/7</b> —
        גם בשעות שאין בהן שירות.
      </div>

      {!picking ? (
        <button type="button" className="sa-btn" onClick={() => setPicking(true)}>
          חבר לשורה ברמזור
        </button>
      ) : (
        <div className="sa-pick">
          <select
            className="sa-select"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            disabled={busy}
          >
            <option value="">בחרי שורה…</option>
            {/* ⚠️ ראשון ברשימה: ברוב האתרים אין שורה בלוח בכלל, ולכן
                זו הבחירה הצפויה ולא החריגה. */}
            <option value={NEW_ROW}>
              ➕ צור שורה חדשה — {site.site_name}
            </option>
            {free.map((r) => (
              <option key={r.id} value={r.id}>
                {String(r.cells?.[nameKey] ?? `שורה ${r.id}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="sa-btn"
            onClick={link}
            disabled={!choice || busy}
          >
            {busy ? "מחבר…" : "חבר"}
          </button>
          <button
            type="button"
            className="sa-btn sa-btn--ghost"
            onClick={() => { setPicking(false); setChoice(""); }}
            disabled={busy}
          >
            ביטול
          </button>
        </div>
      )}

      {/* ⚠️ השגיאה מוצגת כפי שהיא. "מנהלים בלבד" מגיע מ-
          `app.require_manager()` במסד, ולא מהמסך — הודעה מנוסחת מחדש
          כאן הייתה מסתירה איזו שכבה סירבה. */}
      {error && <div className="sa-err">{error}</div>}

      {picking && free.length === 0 && (
        <div className="sa-dim">
          כל השורות בלוח כבר מחוברות לאתרים — תיווצר שורה חדשה.
        </div>
      )}
    </div>
  );
}
