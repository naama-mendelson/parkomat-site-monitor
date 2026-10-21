// components/Vehicles/FleetListDialog.jsx — "רכבים ברשימה" (21/10/2026): אילו רכבים מאיתוראן מופיעים בדשבורד.
//
// מהשירות, דרך הבעלת: אין צורך שיופיעו הרכבים של עובדי המשרד, ההתקנות וכו'. הבעלת: "אל תציג אותם" — רכב שלא
// מסומן כאן לא מופיע בשום מקום (כרטיסים, מפה, "צריכים טכנאי עכשיו", "טכנאי באתר" בלוח). המסד מחליט (fleet_shown);
// כאן רק בוחרים. עורך ומנהל בלבד — fleet_list / fleet_shown_set הם require_editor, ובקר לא רואה את הכפתור.
// ⚠️ שמירה של הרשימה כולה, עם הרשימה שנראתה (seen): עורך אחר ששמר בינתיים → הודעה וטעינה מחדש, לא דריסה שקטה.
// ⚠️ טיוטה לא נסגרת בלחיצה על הרקע או ב-Esc — רק ב"ביטול" (כמו "צא ל:").
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchFleet, saveFleet } from "../../services/dataSource";
import { vehicleName } from "../../utils/vehicles";
import "./DispatchDialog.css";

const norm = (s) => String(s ?? "").replace(/["'״׳]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

export default function FleetListDialog({ onClose, onSaved }) {
  const [data, setData] = useState(null);              // { vehicles: [{plate, nickname, shown}], shown: [plate] }
  const [picked, setPicked] = useState(() => new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await fetchFleet();
      setData(d);
      setPicked(new Set(d.shown));
      return true;
    } catch (e) {
      setError(e?.message || "טעינת רשימת הרכבים נכשלה");
      return false;
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(() => {
    if (!data) return false;
    if (picked.size !== data.shown.length) return true;
    return data.shown.some((p) => !picked.has(p));
  }, [data, picked]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy && !dirty) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, dirty, onClose]);

  const rows = useMemo(() => {
    const q = norm(query);
    // fleet_list מחזיר nickname (הכינוי באיתוראן); vehicleName מוריד ממנו את מספר הרכב
    const all = (data?.vehicles ?? []).map((v) => ({ plate: v.plate, name: vehicleName({ plate: v.plate, name: v.nickname }) }));
    return q ? all.filter((r) => norm(r.name).includes(q) || r.plate.includes(q)) : all;
  }, [data, query]);
  // רכב שברשימה ונעלם מאיתוראן — מוצג למטה, כדי שאפשר יהיה להוריד אותו
  const missing = useMemo(() => {
    const known = new Set((data?.vehicles ?? []).map((v) => v.plate));
    return (data?.shown ?? []).filter((p) => !known.has(p));
  }, [data]);

  const toggle = (plate) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(plate)) next.delete(plate); else next.add(plate);
    return next;
  });

  async function save() {
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveFleet([...picked], data.shown);
      onSaved?.();
      onClose();
    } catch (e) {
      if (e?.stale) {
        await load();
        setError("רשימת הרכבים השתנתה בינתיים אצל מישהו אחר — נטענה מחדש. יש לסמן שוב ולשמור.");
      } else {
        setError(e?.message || "השמירה נכשלה — נסו שוב");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dp-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !busy && !dirty) onClose(); }}>
      <div className="dp dp--fleet" role="dialog" aria-modal="true" aria-labelledby="fl-title">
        <header className="dp-head">
          <h3 id="fl-title">רכבים ברשימה</h3>
          <button type="button" className="dp-x" aria-label="סגירה" onClick={onClose} disabled={busy}>✕</button>
        </header>
        <p className="dp-hint">רק רכבים מסומנים מופיעים בדשבורד: בכרטיסים, במפה, ב"צריכים טכנאי עכשיו" וב"טכנאי באתר".</p>

        {!data && !error && <p className="dp-muted" role="status">טוען…</p>}
        {data && (
          <>
            <input className="dp-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="חיפוש: שם או מספר רכב" aria-label="חיפוש רכב" />
            <ul className="dp-list fl-list" aria-label="רכבים">
              {rows.map((r) => (
                <li key={r.plate}>
                  <label className={`fl-row${picked.has(r.plate) ? " is-on" : ""}`}>
                    <input type="checkbox" checked={picked.has(r.plate)} onChange={() => toggle(r.plate)} disabled={busy} />
                    <span className="fl-name">{r.name}</span>
                    <span className="dp-code">{r.plate}</span>
                  </label>
                </li>
              ))}
              {!query && missing.map((p) => (
                <li key={p}>
                  <label className={`fl-row${picked.has(p) ? " is-on" : ""}`}>
                    <input type="checkbox" checked={picked.has(p)} onChange={() => toggle(p)} disabled={busy} />
                    <span className="fl-name dp-muted">לא נמצא כרגע באיתוראן</span>
                    <span className="dp-code">{p}</span>
                  </label>
                </li>
              ))}
              {rows.length === 0 && <li className="fl-empty dp-muted">לא נמצא רכב</li>}
            </ul>
            <p className="dp-hint" role="status">
              מסומנים {picked.size} מתוך {data.vehicles.length}
              {picked.size === 0 ? " — אם לא יסומן אף רכב, מסך הטכנאים יהיה ריק." : ""}
            </p>
          </>
        )}

        {error && <p className="dp-err" role="alert">{error}</p>}

        <footer className="dp-foot">
          <button type="button" className="dp-send" onClick={save} disabled={!data || busy || !dirty}>
            {busy ? "שומר…" : "שמירה"}
          </button>
          <button type="button" className="dp-cancel" onClick={onClose} disabled={busy}>ביטול</button>
        </footer>
      </div>
    </div>
  );
}
