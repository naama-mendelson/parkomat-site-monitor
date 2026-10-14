// components/Compliance/PmProfilesBoard.jsx — לוח פרופילי התחזוקה. מנהל בלבד (13/10/2026).
//
// בעלת המוצר: "כיון שיש תחזוקה שמתאימה להרבה אתרים אותו דבר — שנקשר את האתר לתחזוקה שמתאימה
// לו כמו ברמזור". שורה לכל פרופיל: השם, הרשימות שבו, והאתרים שבו. שינוי רשימה בפרופיל חל
// מהביקור הבא בכל אתרי הפרופיל. בתחתית — האתרים שאין להם פרופיל (מקבלים את ברירת המחדל).
//
// ⚠️ אתר בפרופיל אחד. הוספה של אתר שכבר בפרופיל אחר **מעבירה** אותו, והשורה אומרת מאיפה
// לפני השמירה — כמו "חבר לשורה אחרת" ברמזור. השרת אוכף (המפתח של pm_profile_sites הוא האתר).
// ⚠️ שמירה = קריאה אחת (pm_profile_save עם האתרים), בטרנזקציה אחת. updated_at שנטען נבדק, והוא זז גם
// כששינו אתרים של הפרופיל ממקום אחר — לוח ישן נדחה ב-PT409 ולא מחזיר אתר שמנהל אחר הזיז. האתרים נשלחים
// רק כשהשתנו (או בפרופיל חדש), כדי ששינוי שם לא ייגע בהם בכלל (סקירה, 13/10/2026; עד אז שתי קריאות).
// שורות ולא קופסאות (בעלת המוצר מעדיפה ממשק מינימלי).
import { useEffect, useMemo, useState } from "react";
import {
  fetchPmProfiles, fetchPmTemplates, savePmProfile, deletePmProfile,
} from "../../services/dataSource";
import "./PmProfilesBoard.css";

const norm = (s) => String(s ?? "").toLowerCase().replace(/["'״׳`\-–,.]/g, "").replace(/\s+/g, " ").trim();
// ⚠️ אותו מספר כמו ב-TasksDialog: לחיצה שנייה שמגיעה מוקדם מזה אינה אישור אלא דאבל-קליק
const ARM_MIN_MS = 600;

export default function PmProfilesBoard({ active = true, rev: outerRev = 0, onDirty, onSaved }) {
  const [data, setData] = useState(null);        // {profiles, unassigned}
  const [lists, setLists] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [rev, setRev] = useState(0);
  const [edit, setEdit] = useState(null);        // {id|null, name, expected, templateIds:Set, codes:[]}
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [armDelete, setArmDelete] = useState(null);   // { id, at } | null
  // ⚠️ "ללחוץ שוב למחיקה" מתפרק אחרי 5 שניות — לחיצה מקרית דקות אחר כך לא תמחק פרופיל (סקירה, 13/10/2026)
  useEffect(() => {
    if (armDelete == null) return undefined;
    const t = setTimeout(() => setArmDelete(null), 5000);
    return () => clearTimeout(t);
  }, [armDelete]);
  const [showUnassigned, setShowUnassigned] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setLoadError("");
    Promise.all([fetchPmProfiles(), fetchPmTemplates()])
      .then(([d, l]) => { if (alive) { setData(d); setLists(l); } })
      .catch((e) => { if (alive) setLoadError(e?.message || "הלוח לא נטען"); });
    return () => { alive = false; };
    // ⚠️ outerRev: שינוי פרופיל של אתר בשורה שמעל (PmSiteLists) מזיז את updated_at של שני פרופילים.
    // בלי טעינה מחדש כאן, השמירה הבאה מהלוח הזה תידחה ב-PT409 — בלי שאיש נגע בלוח.
  }, [active, rev, outerRev]);

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
      ? { id: p.id, name: p.name, expected: p.updated_at, templateIds: new Set(p.template_ids),
          codes: p.sites.map((s) => s.code), loaded: p.sites.map((s) => s.code) }
      : { id: null, name: "", expected: null, templateIds: new Set(), codes: [], loaded: null });
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
    const same = (a, b) => a && b && a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
    const codes = edit.loaded && same(edit.codes, edit.loaded) ? null : edit.codes;
    try {
      await savePmProfile(edit.id, name, [...edit.templateIds], edit.expected, codes);
      setNotice(`הפרופיל "${name}" נשמר — ${edit.codes.length} אתרים. חל מהביקור הבא.`);
      setEdit(null);
      onSaved?.();
      setRev((r) => r + 1);
    } catch (e) {
      // ⚠️ שום דבר לא נשמר (טרנזקציה אחת) — העריכה נשארת פתוחה. לוח ישן: לטעון מחדש ולערוך שוב.
      setError(e?.message || "השמירה נכשלה");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (p, e) => {
    if (armDelete?.id !== p.id) { setArmDelete({ id: p.id, at: performance.now() }); return; }
    // ⚠️ השנייה נחשבת רק אם היא לחיצה בפני עצמה: לא החצי השני של דאבל-קליק, ולא מיד אחרי החימוש.
    // בלי זה דאבל-קליק רגיל מוחק פרופיל, וכל אתריו נופלים לרשימת ברירת המחדל (כמו ב-TasksDialog).
    if ((e?.detail ?? 1) > 1 || performance.now() - armDelete.at < ARM_MIN_MS) return;
    setBusy(true); setError("");
    try {
      const n = await deletePmProfile(p.id, p.updated_at ?? null);
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

  // ⚠️ הודעת השגיאה חיה ליד הכפתור שגרם לה. היא הייתה בראש הלוח, ועם אחד-עשר פרופילים סירוב על
  // אחד מהתחתונים הוצג מחוץ למסך — "שמירה" נראה מת. (אותו לקח כמו K9 במשימות.)
  // ⚠️ וכפתור טעינה מחדש: אחרי PT409 (הלוח התיישן) expected נשאר ישן, ובלי טעינה מחדש כל ניסיון
  // נוסף ייכשל באותה שגיאה — עד שסוגרים את חלון האתר.
  const errorBanner = error ? (
    <div className="pm-banner pm-banner--error" role="alert">
      {error}
      <button type="button" className="pm-btn pm-btn--inline" disabled={busy}
        onClick={() => { setEdit(null); setError(""); setArmDelete(null); setRev((r) => r + 1); }}>
        לטעון את הלוח מחדש
      </button>
    </div>
  ) : null;

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
      {errorBanner}
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
      {/* בעריכה הבאנר יושב בתוך העורך, ליד הכפתור. כאן רק שגיאות שאין להן עורך פתוח (מחיקה). */}
      {!edit && errorBanner}

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
                    {/* ⚠️ השאלה היא בועה מעל הכפתור ולא טקסט בתוכו: טקסט ארוך יותר מזיז את "עריכה"
                        שלידו, ואז "תיקון" בלחיצה על השכן מאשר מחיקה (אותו לקח כמו .tk-ask במשימות) */}
                    <button type="button" className="pm-btn pm-btn--ghost pmp-del" disabled={busy || !!edit}
                      aria-pressed={armDelete?.id === p.id}
                      onKeyDown={(ev) => { if (ev.repeat && (ev.key === "Enter" || ev.key === " ")) ev.preventDefault(); }}
                      onClick={(ev) => remove(p, ev)}>
                      מחיקה
                      {armDelete?.id === p.id && <span className="pmp-ask" aria-hidden="true">ללחוץ שוב למחיקה</span>}
                    </button>
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
