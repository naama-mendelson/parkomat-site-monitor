// components/Compliance/PmTemplateMeta.jsx — סיווג רשימת תחזוקה: קטגוריה, ולאילו סוגי אתר היא מתאימה (15/10/2026).
//
// בעלת המוצר: "תסדר את זה לפי סוגים — XY, X או Y, מעלית כזו, מעלית כזו". כאן אומרים על כל רשימה: לאיזו קטגוריה היא
// שייכת — ולפיה היא מופיעה בבחירה של האתר (מתקן / מעליות / אחר) ובבורר — ולאילו סוגי מעלית / מתקן / מערכת / קונזול היא
// מתאימה. ⚠️ מ-20/10/2026 ההתאמה היא **רמז בלבד** ("לפי סוג האתר" בלשונית): אתר מקבל רק מה שנבחר לו ("עד שלא בוחרים
// אין כלום"). עד אז רשימה חלה מעצמה על כל אתר מהסוג.
// ⚠️ רשימת ברירת המחדל היא הבסיס של הרובוטיים — אין לה סיווג, והמסד מסרב לשנות אותו.
import { useEffect, useState } from "react";
import { setPmTemplateMeta } from "../../services/dataSource";
import ChoiceSelect from "../ChoiceSelect/ChoiceSelect";
import { PM_CATEGORIES, typeKeyOptions } from "../../utils/pmLists";

const KEYS = typeKeyOptions();

export default function PmTemplateMeta({ template, onSaved }) {
  const [category, setCategory] = useState(template?.category ?? "other");
  const [keys, setKeys] = useState(new Set(template?.auto_for ?? []));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);     // { ok, text }
  useEffect(() => {
    setCategory(template?.category ?? "other");
    setKeys(new Set(template?.auto_for ?? []));
    setMsg(null);
  }, [template?.id, template?.category, (template?.auto_for ?? []).join(",")]);
  if (!template) return null;
  if (template.is_default) {
    return <p className="pm-muted pm-tpl-meta-note">רשימת הבסיס מגיעה לכל אתר רובוטי, בלי בחירה ובלי סיווג לפי סוג.</p>;
  }
  const dirty = category !== (template.category ?? "other")
    || [...keys].sort().join(",") !== (template.auto_for ?? []).slice().sort().join(",");
  const toggle = (k) => setKeys((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await setPmTemplateMeta(template.id, category, [...keys]);
      setMsg({ ok: true, text: "הסיווג נשמר — באתרים מהסוגים האלה הרשימה תוצג כמתאימה. הבחירה עצמה נעשית בלשונית האתר." });
      onSaved?.();
    } catch (e) { setMsg({ ok: false, text: e?.message || "השמירה נכשלה" }); }
    finally { setBusy(false); }
  };
  // מערכת וקונזול — 19/10/2026: גם הם סוגים שרשימה יכולה להתאים להם
  const groups = [{ key: "lift", label: "סוגי מעלית" }, { key: "floor", label: "סוגי מתקן" },
    { key: "system", label: "מערכת הפעלה" }, { key: "console", label: "קונזול" }];
  return (
    <div className="pm-tpl-meta" data-testid="pm-tpl-meta">
      <div className="pm-row pm-tpl-meta-row">
        <span className="pm-tpl-meta-cap">קטגוריה</span>
        <ChoiceSelect name="pm_category" label="קטגוריה של הרשימה" value={category}
          options={PM_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))} onChange={setCategory} />
      </div>
      <div className="pm-tpl-meta-keys">
        <span className="pm-tpl-meta-cap">מתאימה ל</span>
        {groups.map((g) => (
          <div key={g.key} className="pm-tpl-meta-group">
            <span className="pm-muted">{g.label}:</span>
            <div className="pm-chips" role="group" aria-label={g.label}>
              {KEYS.filter((o) => o.group === g.key).map((o) => (
                <label key={o.value} className={`pm-chip${keys.has(o.value) ? " is-on" : ""}`}>
                  <input type="checkbox" checked={keys.has(o.value)} disabled={busy} onChange={() => toggle(o.value)} data-key={o.value} />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
        {keys.size === 0 && <p className="pm-muted">בלי סוג — לא תוצג כמתאימה לאף אתר, ועדיין אפשר לבחור אותה לכל אתר.</p>}
      </div>
      <div className="pm-row">
        <button type="button" className="pm-btn pm-btn--primary" disabled={busy || !dirty} onClick={save}>{busy ? "שומר…" : "שמירת הסיווג"}</button>
        {msg && <span className={msg.ok ? "pm-status pm-status--saved" : "pm-error-text"} role="status">{msg.text}</span>}
      </div>
    </div>
  );
}
