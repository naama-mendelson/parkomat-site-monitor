// components/Compliance/PmProfilesBoard.jsx — לוח פרופילי התחזוקה. מנהל בלבד (13/10/2026).
//
// בעלת המוצר: "כיון שיש תחזוקה שמתאימה להרבה אתרים אותו דבר — שנקשר את האתר לתחזוקה שמתאימה
// לו כמו ברמזור". שורה לכל פרופיל: השם, הרשימות שבו, והאתרים שבו. שינוי רשימה בפרופיל חל
// מהביקור הבא בכל אתרי הפרופיל. בתחתית — האתרים שאין להם פרופיל (מקבלים את ברירת המחדל).
//
// ⚠️ אתר בפרופיל אחד. הוספה של אתר שכבר בפרופיל אחר **מעבירה** אותו, והשורה אומרת מאיפה
// לפני השמירה — כמו "חבר לשורה אחרת" ברמזור. השרת אוכף (המפתח של pm_profile_sites הוא האתר).
// ⚠️ שמירה = שתי קריאות: שם ורשימות (עם updated_at שנטען — לוח ישן נדחה ב-PT409), ואז האתרים
// כמצב יעד. כשל באמצע אומר מה נשמר ומה לא, ולא "נכשל" סתם.
// שורות ולא קופסאות (בעלת המוצר מעדיפה ממשק מינימלי).
import { useEffect, useMemo, useState } from "react";
import {
  fetchPmProfiles, fetchPmTemplates, savePmProfile, deletePmProfile, setPmProfileSites,
} from "../../services/dataSource";
import "./PmProfilesBoard.css";

const norm = (s) => String(s ?? "").toLowerCase().replace(/["'״׳`\-–,.]/g, "").replace(/\s+/g, " ").trim();

export default function PmProfilesBoard({ active = true, onDirty, onSaved }) {
  const [data, setData] = useState(null);        // {profiles, unassigned}
  const [lists, setLists] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [rev, setRev] = useState(0);
  const [edit, setEdit] = useState(null);        // {id|null, name, expected, templateIds:Set, codes:[]}
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [armDelete, setArmDelete] = useState(null);
  const [showUnassigned, setShowUnassigned] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setLoadError("");
    Promise.all([fetchPmProfiles(), fetchPmTemplates()])
      .then(([d, l]) => { if (alive) { setData(d); setLists(l); } })
      .catch((e) => { if (alive) setLoadError(e?.message || "הלוח לא נטען"); });
    return () => { alive = false; };
  }, [active, rev]);

  useEffect(() => { onDirty?.(edit ? "יש פרופיל בעריכה שלא נשמר." : null); }, [edit, onDirty]);
  useEffect(() => () => onDirty?.(null), [onDirty]);

  // כל האתרים: מהפרופילים ומהשורה "בלי פרופיל" — קוד → {code, name, profile}
  const allSites = useMemo(() => {
    const m = new Map();
    for (const p of data?.profiles || []) for (const s of p.sites) m.set(s.code, { ...s, profile: p });
    for (const s of data?.unassigned || []) m.set(s.code, { ...s, profile: null });
    return m;
  }, [data]);
  const listName = (id) => lists.find((t) => t.id === id)?.name ?? `#${id}`;

  const begin = (p) => {
    setError(""); setNotice(""); setQuery(""); setArmDelete(null);
    setEdit(p
      ? { id: p.id, name: p.name, expected: p.updated_at, templateIds: new Set(p.template_ids), codes: p.sites.map((s) => s.code) }
      : { id: null, name: "", expected: null, templateIds: new Set(), codes: [] });
  };
  // ⚠️ כל שינוי בעריכה מנקה את השגיאה — "יש לבחור לפחות רשימה אחת" שנשארת אחרי שסימנו רשימה מטעה
  const toggleList = (id) => { setError(""); setEdit((e) => {
    const t = new Set(e.templateIds);
    if (t.has(id)) t.delete(id); else t.add(id);
    return { ...e, templateIds: t };
  }); };
  const addSite = (code) => { setError(""); setEdit((e) => (e.codes.includes(code) ? e : { ...e, codes: [...e.codes, code] })); setQuery(""); };
  const removeSite = (code) => setEdit((e) => ({ ...e, codes: e.codes.filter((c) => c !== code) }));

  const matches = useMemo(() => {
    const q = norm(query);
    if (!edit || !q) return [];
    return [...allSites.values()]
      .filter((s) => !edit.codes.includes(s.code) && (norm(s.code).includes(q) || norm(s.name).includes(q)))
      .slice(0, 12);
  }, [query, edit, allSites]);

  const save = async () => {
    const name = edit.name.trim();
    if (name.length < 2) { setError("שם הפרופיל — שני תווים לפחות"); return; }
    if (edit.templateIds.size === 0) { setError("יש לבחור לפחות רשימה אחת"); return; }
    setBusy(true); setError("");
    let id = edit.id;
    try {
      id = await savePmProfile(edit.id, name, [...edit.templateIds], edit.expected);
    } catch (e) { setError(e?.message || "השמירה נכשלה"); setBusy(false); return; }
    try {
      await setPmProfileSites(id, edit.codes);
      setNotice(`הפרופיל "${name}" נשמר — ${edit.codes.length} אתרים. חל מהביקור הבא.`);
      setEdit(null);
      onSaved?.();
    } catch (e) {
      // השם והרשימות כבר נשמרו — אומרים את זה, ומשאירים את העריכה פתוחה (עם המזהה) לשמירה חוזרת
      setError(`השם והרשימות נשמרו, אבל האתרים לא: ${e?.message || "שגיאה"}. אפשר לשמור שוב.`);
      setEdit((x) => ({ ...x, id, expected: null }));
    } finally {
      setBusy(false);
      setRev((r) => r + 1);
    }
  };
  const remove = async (p) => {
    if (armDelete !== p.id) { setArmDelete(p.id); return; }
    setBusy(true); setError("");
    try {
      const n = await deletePmProfile(p.id);
      setNotice(`הפרופיל "${p.name}" נמחק. ${n} אתרים חזרו לרשימת ברירת המחדל.`);
      setArmDelete(null);
      onSaved?.();
    } catch (e) { setError(e?.message || "המחיקה נכשלה"); }
    finally { setBusy(false); setRev((r) => r + 1); }
  };

  if (loadError) {
    return (
      <div className="pm-banner pm-banner--error" role="alert">
        {loadError}
        <button type="button" className="pm-btn pm-btn--inline" onClick={() => setRev((r) => r + 1)}>נסה שוב</button>
      </div>
    );
  }
  if (!data) return <p className="pm-muted">טוען את לוח הפרופילים…</p>;

  const editor = (
    <div className="pmp-edit">
      <label className="pm-field">
        <span>שם הפרופיל</span>
        <input className="pm-input" autoFocus maxLength={60} value={edit?.name ?? ""} disabled={busy}
          placeholder="למשל: פרקומט – הידראולית + דולי"
          onChange={(e) => { setError(""); setEdit((x) => ({ ...x, name: e.target.value })); }} />
      </label>
      <fieldset className="pmp-lists">
        <legend>רשימות</legend>
        {lists.map((t) => (
          <label key={t.id} className="pm-inline-check">
            <input type="checkbox" className="pm-checkbox pm-checkbox--sm" checked={!!edit?.templateIds.has(t.id)}
              disabled={busy} onChange={() => toggleList(t.id)} />
            <span>{t.name} · {t.item_count} פריטים</span>
          </label>
        ))}
      </fieldset>
      <div className="pmp-sites">
        <span className="pmp-label">אתרים ({edit?.codes.length ?? 0})</span>
        <ul className="pmp-site-list">
          {(edit?.codes || []).map((c) => {
            const s = allSites.get(c);
            const from = s?.profile && s.profile.id !== edit.id ? s.profile.name : null;
            return (
              <li key={c}>
                <span className="pmp-code">{c}</span> {s?.name || ""}
                {from && <span className="pmp-move"> · יעבור מ"{from}"</span>}
                <button type="button" className="pm-icon-btn pmp-x" aria-label={`הסרת ${c}`} disabled={busy}
                  onClick={() => removeSite(c)}>×</button>
              </li>
            );
          })}
        </ul>
        <input className="pm-input" type="search" value={query} disabled={busy}
          placeholder="+ הוספת אתר — קוד או שם" aria-label="הוספת אתר לפרופיל"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) { e.preventDefault(); addSite(matches[0].code); } }} />
        {matches.length > 0 && (
          <ul className="pmp-matches" role="listbox" aria-label="אתרים להוספה">
            {matches.map((s) => (
              <li key={s.code}>
                <button type="button" role="option" aria-selected="false" onClick={() => addSite(s.code)}>
                  <span className="pmp-code">{s.code}</span> {s.name}
                  {s.profile && <span className="pmp-move"> · עכשיו ב"{s.profile.name}"</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="pm-row">
        <button type="button" className="pm-btn pm-btn--primary" disabled={busy} onClick={save}>
          {busy ? "שומר…" : "שמירה"}</button>
        <button type="button" className="pm-btn pm-btn--ghost" disabled={busy} onClick={() => { setEdit(null); setError(""); }}>ביטול</button>
      </div>
    </div>
  );

  return (
    <div className="pmp">
      <div className="pm-banner pm-banner--info">
        כל אתר שייך לפרופיל אחד, והפרופיל קובע אילו רשימות הצוות ממלא בביקור. שינוי חל מהביקור הבא;
        ביקור שכבר פתוח ממשיך עם מה שהיה בפתיחתו.
      </div>
      {notice && <div className="pm-banner pm-banner--ok" role="status">{notice}</div>}
      {error && <div className="pm-banner pm-banner--error" role="alert">{error}</div>}

      <ul className="pmp-rows">
        {data.profiles.map((p) => (
          <li key={p.id} className="pmp-row" data-profile={p.id}>
            {edit?.id === p.id ? editor : (
              <>
                <div className="pmp-head">
                  <strong className="pmp-name">{p.name}</strong>
                  <span className="pm-muted">{p.sites.length} אתרים · {p.item_count} פריטים</span>
                  <span className="pmp-actions">
                    <button type="button" className="pm-btn pm-btn--ghost" disabled={busy || !!edit} onClick={() => begin(p)}>עריכה</button>
                    <button type="button" className="pm-btn pm-btn--ghost" disabled={busy || !!edit} onClick={() => remove(p)}>
                      {armDelete === p.id ? "ללחוץ שוב למחיקה" : "מחיקה"}</button>
                  </span>
                </div>
                <div className="pmp-line"><span className="pmp-label">רשימות:</span> {p.template_ids.map(listName).join(" · ") || "—"}</div>
                <div className="pmp-line">
                  <span className="pmp-label">אתרים:</span>{" "}
                  {p.sites.length ? p.sites.map((s) => `${s.code} ${s.name}`).join(" · ") : <span className="pm-muted">אין עדיין</span>}
                </div>
              </>
            )}
          </li>
        ))}
        {edit && edit.id == null && <li className="pmp-row pmp-row--new">{editor}</li>}
      </ul>
      {!edit && (
        <button type="button" className="pm-btn" disabled={busy} onClick={() => begin(null)}>+ פרופיל חדש</button>
      )}

      <div className="pmp-unassigned">
        <button type="button" className="pm-link" aria-expanded={showUnassigned}
          onClick={() => setShowUnassigned((s) => !s)}>
          בלי פרופיל ({data.unassigned.length}) — מקבלים את רשימת ברירת המחדל
        </button>
        {showUnassigned && (
          <p className="pmp-line">{data.unassigned.map((s) => `${s.code} ${s.name}`).join(" · ") || "—"}</p>
        )}
      </div>
    </div>
  );
}
