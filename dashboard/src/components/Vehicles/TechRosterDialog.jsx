// components/Vehicles/TechRosterDialog.jsx — "ניהול טכנאים" (22/10/2026): מנהל בלבד. טכנאי = שם + הרכב שלו באיתוראן.
//
// הבעלת: "תן אופציה להוסיף עוד טכנאי ולמחוק וכו' — רק למי שהוא מנהל". מחליף את "רכבים ברשימה" (21/10/2026, עורך ומנהל).
// המסד מחליט (tech_roster / tech_roster_set / tech_roster_remove, require_manager); כאן רק בוחרים.
//   • הוספה: שם + רכב מאיתוראן שאינו ברשימה. הרכב מופיע מיד בכל מקום, בשם הזה.
//   • שינוי שם: בשורה. רכב ברשימה בלי שם מהלוח מוצג בכינוי באיתוראן; שמירת שם יוצרת לו טכנאי.
//   • הסרה: בשתי לחיצות (4 שניות). יוצא מהרשימה ומושבת — עם הטלפון שלו. ההיסטוריה נשמרת. עם משימה פתוחה — המסד מסרב.
// ⚠️ טיוטה (שם בעריכה או טכנאי חדש שהוקלד) לא נסגרת בלחיצה על הרקע או ב-Esc — רק ב"סגירה".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchRoster, removeRosterTech, saveRosterTech } from "../../services/dataSource";
import { vehicleName } from "../../utils/vehicles";
import ChoiceSelect from "../ChoiceSelect/ChoiceSelect";
import "./DispatchDialog.css";
import "./TechReport.css";

const ARM_MS = 4000;

export default function TechRosterDialog({ onClose, onChanged }) {
  const [data, setData] = useState(null);          // { techs, available }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);          // plate בפעולה, או "new"
  const [editing, setEditing] = useState(null);    // { plate, name }
  const [armed, setArmed] = useState(null);        // plate שמחכה ללחיצה שנייה על "הסרה"
  const [newName, setNewName] = useState("");
  const [newPlate, setNewPlate] = useState("");
  const [note, setNote] = useState(null);
  const armTimer = useRef(null);

  const load = useCallback(async () => {
    try { setData(await fetchRoster()); setError(null); }
    catch (e) { setError(e?.message || "טעינת רשימת הטכנאים נכשלה"); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => clearTimeout(armTimer.current), []);

  const dirty = !!editing || newName.trim() !== "" || newPlate !== "";
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || busy) return;
      if (editing) { setEditing(null); return; }
      if (!dirty) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, dirty, editing, onClose]);

  const vehicleOptions = useMemo(() => (data?.available ?? []).map((v) => ({
    value: v.plate, label: `${vehicleName({ plate: v.plate, name: v.nickname })} · ${v.plate}`,
  })), [data]);

  async function run(plate, fn, okText) {
    setBusy(plate); setError(null); setNote(null);
    try {
      const r = await fn();
      await load();
      onChanged?.();
      if (okText && r?.changed !== false) setNote(okText);
      return true;
    } catch (e) {
      setError(e?.message || "הפעולה נכשלה — נסו שוב");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function saveName() {
    if (!editing) return;
    const name = editing.name.trim();
    if (name.length < 2) { setError("שם הטכנאי: 2 תווים לפחות"); return; }
    if (await run(editing.plate, () => saveRosterTech(editing.plate, name), `השם נשמר: ${name}`)) setEditing(null);
  }

  async function add() {
    const name = newName.trim();
    if (name.length < 2) { setError("שם הטכנאי: 2 תווים לפחות"); return; }
    if (!newPlate) { setError("יש לבחור את הרכב של הטכנאי"); return; }
    if (await run("new", () => saveRosterTech(newPlate, name), `${name} נוסף לרשימה`)) { setNewName(""); setNewPlate(""); }
  }

  function onRemove(t) {
    if (armed !== t.plate) {
      setArmed(t.plate);
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(null), ARM_MS);
      return;
    }
    clearTimeout(armTimer.current);
    setArmed(null);
    run(t.plate, () => removeRosterTech(t.plate), `${t.name || vehicleName({ plate: t.plate, name: t.nickname })} הוסר מהרשימה`);
  }

  const techs = data?.techs ?? [];
  return (
    <div className="dp-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !busy && !dirty) onClose(); }}>
      <div className="dp dp--roster" role="dialog" aria-modal="true" aria-labelledby="rs-title">
        <header className="dp-head">
          <h3 id="rs-title">ניהול טכנאים</h3>
          <button type="button" className="dp-x" aria-label="סגירה" onClick={onClose} disabled={!!busy}>✕</button>
        </header>
        <p className="dp-hint">
          כל טכנאי הוא שם והרכב שלו באיתוראן. רק הטכנאים ברשימה מופיעים בדשבורד: בכרטיסים, במפה, ב"טכנאי באתר" ובסטטיסטיקה.
          הסרה מוציאה מהרשימה ומנתקת את הטלפון שלו, וההיסטוריה שלו נשמרת.
        </p>

        {!data && !error && <p className="dp-muted" role="status">טוען…</p>}
        {data && (
          <>
            <h4 className="rs-sub">הטכנאים ברשימה ({techs.length})</h4>
            <ul className="rs-list" aria-label="הטכנאים ברשימה">
              {techs.map((t) => {
                const shown = t.name || vehicleName({ plate: t.plate, name: t.nickname });
                const isEdit = editing?.plate === t.plate;
                return (
                  <li key={t.plate} className="rs-row" data-plate={t.plate}>
                    {isEdit ? (
                      <form className="rs-edit" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
                        <input className="dp-input" value={editing.name} autoFocus maxLength={60} aria-label={`השם של ${shown}`}
                               onChange={(e) => setEditing({ ...editing, name: e.target.value })} disabled={!!busy} />
                        <button type="submit" className="rs-btn rs-btn--main" disabled={!!busy}>{busy === t.plate ? "שומר…" : "שמירה"}</button>
                        <button type="button" className="rs-btn" onClick={() => setEditing(null)} disabled={!!busy}>ביטול</button>
                      </form>
                    ) : (
                      <>
                        <span className="rs-name">
                          <b>{shown}</b>
                          <span className="dp-code"> · {t.plate}</span>
                          {!t.name && <span className="rs-tag">שם מאיתוראן</span>}
                          {t.in_ituran === false && <span className="rs-tag rs-tag--warn">לא נמצא כרגע באיתוראן</span>}
                          {t.open_task && <span className="rs-tag">משימה פתוחה</span>}
                          {t.phone && <span className="rs-tag">טלפון מחובר</span>}
                        </span>
                        <span className="rs-acts">
                          <button type="button" className="rs-btn" disabled={!!busy}
                                  onClick={() => { setEditing({ plate: t.plate, name: t.name || shown }); setArmed(null); setError(null); setNote(null); }}>
                            שינוי שם
                          </button>
                          <button type="button" className={`rs-btn rs-btn--del${armed === t.plate ? " is-armed" : ""}`} disabled={!!busy}
                                  aria-label={armed === t.plate ? `לחיצה נוספת מסירה את ${shown}` : `הסרת ${shown}`} onClick={() => onRemove(t)}>
                            {busy === t.plate ? "מסיר…" : armed === t.plate ? "להסיר?" : "הסרה"}
                          </button>
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
              {techs.length === 0 && <li className="rs-empty dp-muted">אין טכנאים ברשימה — מסך הטכנאים ריק</li>}
            </ul>

            <form className="rs-add" onSubmit={(e) => { e.preventDefault(); add(); }} aria-labelledby="rs-add-title">
              <h4 id="rs-add-title" className="rs-sub">הוספת טכנאי</h4>
              <div className="rs-add-row">
                <input className="dp-input" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60}
                       placeholder="שם הטכנאי" aria-label="שם הטכנאי" disabled={!!busy} />
                <div className="rs-pick">
                  <ChoiceSelect value={newPlate} options={vehicleOptions} onChange={setNewPlate} label="הרכב של הטכנאי"
                                placeholder={vehicleOptions.length ? "— הרכב שלו באיתוראן —" : "אין רכבים פנויים באיתוראן"}
                                name="roster-vehicle" disabled={!!busy || vehicleOptions.length === 0} menuMinWidth={260} />
                </div>
                <button type="submit" className="dp-send" disabled={!!busy || !newName.trim() || !newPlate}>
                  {busy === "new" ? "מוסיף…" : "הוספה"}
                </button>
              </div>
            </form>
          </>
        )}

        {note && <p className="rs-note" role="status">{note}</p>}
        {error && <p className="dp-err" role="alert">{error}</p>}

        <footer className="dp-foot">
          <button type="button" className="dp-cancel" onClick={onClose} disabled={!!busy}>סגירה</button>
        </footer>
      </div>
    </div>
  );
}
