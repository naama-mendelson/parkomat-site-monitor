// components/Compliance/PmSiteLists.jsx — אילו רשימות תחזוקה האתר מקבל (07/10/2026).
//
// בעלת המוצר: "יש דברים שמשותפים כמעט לכל האתרים, ויש פעולות תחזוקה שרלוונטיות לסוג
// המתקן". שורה אחת: שמות הרשימות. מנהל — "שינוי", ותיבות סימון לכל רשימה.
//
// ⚠️ אתר שלא שויך מקבל את רשימת ברירת המחדל (כמו לפני שהיו רשימות), והשורה אומרת
// את זה — אחרת "משותף" נראה כמו בחירה שמישהו עשה.
// ⚠️ ביקור שכבר פתוח אינו משתנה: הפריטים שלו צולמו בפתיחה. השינוי חל מהביקור הבא.
import { useState } from "react";
import { fetchPmTemplates, setPmSiteTemplates } from "../../services/dataSource";

export default function PmSiteLists({ code, templates = [], assigned = false, isManager = false, onChanged }) {
  const [edit, setEdit] = useState(null);      // null | { lists, chosen:Set }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const open = async () => {
    setError("");
    setBusy(true);
    try {
      const lists = await fetchPmTemplates();
      const chosen = new Set(templates.map((t) => t.id));
      setEdit({ lists, chosen });
    } catch (e) { setError(e?.message || "הרשימות לא נטענו"); }
    finally { setBusy(false); }
  };
  const toggle = (id) => setEdit((e) => {
    const chosen = new Set(e.chosen);
    if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
    return { ...e, chosen };
  });
  const save = async () => {
    setError("");
    setBusy(true);
    try {
      // סדר הרשימות נקבע במסד (seq), לא בסדר הסימון
      await setPmSiteTemplates(code, edit.lists.filter((t) => edit.chosen.has(t.id)).map((t) => t.id));
      setEdit(null);
      onChanged?.();
    } catch (e) { setError(e?.message || "השמירה נכשלה"); }
    finally { setBusy(false); }
  };

  return (
    <section className="pm-card">
      <div className="pm-site-lists">
        <span>רשימות תחזוקה:</span>
        <span className="pm-site-lists-names">{templates.map((t) => t.name).join(" · ") || "—"}</span>
        {!assigned && <span className="pm-muted">(ברירת מחדל)</span>}
        {isManager && !edit && (
          <button type="button" className="pm-btn pm-btn--ghost" disabled={busy} onClick={open}>שינוי</button>
        )}
      </div>
      {edit && (
        <div className="pm-site-lists-edit">
          {edit.lists.map((t) => (
            <label key={t.id}>
              <input type="checkbox" checked={edit.chosen.has(t.id)} onChange={() => toggle(t.id)} disabled={busy} />
              <span>{t.name} · {t.item_count} פריטים</span>
            </label>
          ))}
          {edit.chosen.size === 0 && (
            <p className="pm-muted">בלי סימון — האתר יקבל את רשימת ברירת המחדל.</p>
          )}
          <p className="pm-muted">חל מהביקור הבא. ביקור שכבר פתוח ממשיך עם מה שהיה בפתיחתו.</p>
          <div className="pm-row">
            <button type="button" className="pm-btn pm-btn--primary" disabled={busy} onClick={save}>
              {busy ? "שומר…" : "שמירה"}</button>
            <button type="button" className="pm-btn pm-btn--ghost" disabled={busy} onClick={() => setEdit(null)}>ביטול</button>
          </div>
        </div>
      )}
      {error && <div className="pm-banner pm-banner--error" role="alert">{error}</div>}
    </section>
  );
}
