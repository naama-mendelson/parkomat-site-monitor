// components/Compliance/PmSiteLists.jsx — רשימות התחזוקה של האתר: לפי הסוג, ובחירה מרובה לשינוי (15/10/2026).
//
// בעלת המוצר: "אני רוצה שתסווג לפי מה שמסומן הסוג של האתר. אם יש שתי סוגי מעליות אז שיהיה את התחזוקה גם של זה
// וגם של זה… תסדר את זה לפי סוגים — XY, X או Y, מעלית כזו, מעלית כזו — ואפשר יהיה לעשות בחירה מרובה. אבל
// מלכתחילה תשים לכל אתר את מה שמתאים לו, ואפשר יהיה להוסיף ולשנות".
//
// שורה ראשונה: "רשימות תחזוקה: A · B · C (אוטומטי לפי סוג האתר)". שנייה: "פרופיל: X" (הפרופילים נשארו — ללוח,
// ולאתרים בלי שדות סוג: מכפילים, סוטפין). מנהל — "שינוי", ואז כל הרשימות מקובצות לפי קטגוריה (בסיס / מעליות /
// רצפה ומרתף / אחר) עם תיבות סימון, מה שהאתר מקבל עכשיו מסומן מראש, ומתחת בורר הפרופיל. "שמירה" אחת: שינוי
// בתיבות נכתב כשיוך ידני לאתר (pm_site_templates_set — גובר על הסוג ועל הפרופיל); שינוי בפרופיל נכתב בנפרד.
// "חזרה לאוטומטי" מוחקת את הידני. ⚠️ הבסיס נעול: בלי לובי וחשמל אין ביקור שלם. ⚠️ ביקור שכבר פתוח אינו משתנה.
import { useState } from "react";
import { fetchPmTemplates, fetchPmProfiles, setPmSiteTemplates, setPmSiteProfile } from "../../services/dataSource";
import ChoiceSelect from "../ChoiceSelect/ChoiceSelect";
import { groupTemplates, sourceLabel, initialSelection, lockedIds, typeKeyLabel, coverageRows } from "../../utils/pmLists";

const NONE = "";
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// ⚠️ 19/10/2026 — "לפי סוג האתר": שורה לכל מאפיין שבתג הכרטיס (מתקן, מערכת, מעלית, קונזול) ומה מכסה אותו. בעלת המוצר,
// על "XY · ביטנקם · הידראולית בוכנה 1 · קונזול אורכי": "צריך בתחזוקה לראות שיש מענה גם ל…". מאפיין בלי רשימה נפרדת —
// "מכוסה ברשימות הכלליות" (תשובתה: "אין צורך בתחזוקה נפרדת"), לא "חסר". רשימה שהוצאה מהאתר — נאמר במפורש.
function CoverageRow({ row }) {
  return (
    <li className={`pm-cover-row is-${row.state}`} data-key={row.key} data-state={row.state}>
      <span className="pm-cover-key">{row.label} —</span>
      <span className="pm-cover-val">
        {row.state === "covered" && row.assigned.join(" · ")}
        {row.state === "general" && <span className="pm-muted">מכוסה ברשימות הכלליות</span>}
        {row.unassigned.length > 0 && (
          <span className="pm-cover-off">{row.state === "covered" ? " · " : ""}יש רשימה ({row.unassigned.join(", ")}) — לא משויכת לאתר</span>
        )}
      </span>
    </li>
  );
}

export default function PmSiteLists({ code, profile = null, templates = [], source = "default", typeKeys = [], typeCoverage = null, isManager = false, onChanged }) {
  const cover = coverageRows(typeCoverage);
  const [edit, setEdit] = useState(null);      // null | { all, profiles, chosen:Set, initial:Set, profileId:string }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const open = async () => {
    setError(""); setBusy(true);
    try {
      const [all, { profiles }] = await Promise.all([fetchPmTemplates(), fetchPmProfiles()]);
      const initial = initialSelection(templates);
      setEdit({ all, profiles, chosen: new Set(initial), initial, profileId: profile ? String(profile.id) : NONE });
    } catch (e) { setError(e?.message || "הרשימות לא נטענו"); }
    finally { setBusy(false); }
  };
  const toggle = (id) => setEdit((e) => {
    const chosen = new Set(e.chosen);
    if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
    return { ...e, chosen };
  });
  const run = async (fn) => {
    setError(""); setBusy(true);
    try { await fn(); setEdit(null); onChanged?.(); }
    catch (e) { setError(e?.message || "השמירה נכשלה"); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => {
    const locked = lockedIds(edit.all);
    const want = new Set([...locked, ...edit.chosen]);
    const wasProfile = profile ? String(profile.id) : NONE;
    // ⚠️ הרשימות נכתבות כידני רק כשהן שונו: אחרת בחירת פרופיל לבדה הייתה "נועלת" את הרשימות של היום כידני
    if (!sameSet(want, new Set([...locked, ...edit.initial]))) await setPmSiteTemplates(code, [...want]);
    if (edit.profileId !== wasProfile) await setPmSiteProfile(code, edit.profileId === NONE ? null : Number(edit.profileId));
  });
  const clearManual = () => run(() => setPmSiteTemplates(code, []));

  const names = templates.map((t) => t.name).join(" · ") || "—";
  const locked = edit ? lockedIds(edit.all) : new Set();
  const groups = edit ? groupTemplates(edit.all) : [];
  const hint = typeKeys.length ? typeKeys.map(typeKeyLabel).join(" · ") : "לאתר אין סוג מתקן או סוג מעלית";
  const profileOptions = edit
    ? [{ value: NONE, label: "בלי פרופיל" }, ...edit.profiles.map((p) => ({ value: String(p.id), label: `${p.name} · ${p.item_count} פריטים` }))]
    : [];

  return (
    <section className="pm-card">
      <div className="pm-site-lists">
        <span>רשימות תחזוקה:</span>
        <span className="pm-site-lists-names" data-testid="pm-site-lists-names">{names}</span>
        <span className="pm-muted" data-testid="pm-site-lists-source">({sourceLabel(source)})</span>
        {isManager && !edit && (
          <button type="button" className="pm-btn pm-btn--ghost" disabled={busy} onClick={open}>שינוי</button>
        )}
      </div>
      {cover.length > 0 && (
        <div className="pm-cover" data-testid="pm-type-coverage">
          <span className="pm-cover-cap">לפי סוג האתר:</span>
          <ul className="pm-cover-list">
            {cover.map((r) => <CoverageRow key={r.key} row={r} />)}
          </ul>
        </div>
      )}
      <div className="pm-site-lists pm-muted">
        <span>פרופיל:</span>
        <span data-testid="pm-profile-name">{profile ? profile.name : "בלי פרופיל"}</span>
        {source !== "profile" && profile && <span>(הרשימות {source === "explicit" ? "נבחרו ידנית" : "לפי סוג האתר"}, לא מהפרופיל)</span>}
      </div>
      {edit && (
        <div className="pm-site-lists-edit" data-testid="pm-site-lists-edit">
          <p className="pm-muted">סוג האתר: {hint}. סמני מה שהאתר הזה צריך — שתי מעליות מסוגים שונים = שתי רשימות.</p>
          {groups.map((g) => (
            <fieldset key={g.key} className="pm-lists-group" data-category={g.key}>
              <legend>{g.label}</legend>
              {g.templates.map((t) => {
                const isLocked = locked.has(t.id);
                const on = isLocked || edit.chosen.has(t.id);
                return (
                  <label key={t.id} className={`pm-inline-check pm-lists-item${on ? " is-on" : ""}`}>
                    <input type="checkbox" className="pm-checkbox pm-checkbox--sm" checked={on} disabled={isLocked || busy}
                      onChange={() => toggle(t.id)} data-template={t.id} />
                    <span className="pm-lists-item-name">{t.name}</span>
                    <span className="pm-muted">· {t.item_count} פריטים{isLocked ? " · לכולם" : ""}</span>
                  </label>
                );
              })}
            </fieldset>
          ))}
          <div className="pm-site-lists pm-lists-profile">
            <span>פרופיל תחזוקה</span>
            {/* ⚠️ placeholder מפורש: ChoiceSelect לעולם אינו מציג אפשרות שערכה "" על הכפתור הסגור */}
            <ChoiceSelect label="פרופיל תחזוקה" value={edit.profileId} options={profileOptions} placeholder="בלי פרופיל"
              onChange={(v) => setEdit((e) => ({ ...e, profileId: v }))} />
            <span className="pm-muted">— לאתר בלי סוג (מכפילים, סוטפין); רשימה שסומנה כאן גוברת עליו</span>
          </div>
          <p className="pm-muted">חל מהביקור הבא. ביקור שכבר פתוח ממשיך עם מה שהיה בפתיחתו.</p>
          <div className="pm-row">
            <button type="button" className="pm-btn pm-btn--primary" disabled={busy} onClick={save}>{busy ? "שומר…" : "שמירה"}</button>
            {source === "explicit" && (
              <button type="button" className="pm-btn pm-btn--ghost" disabled={busy} title="מחיקת הבחירה הידנית — הרשימות ייגזרו שוב מסוג האתר (או מהפרופיל)"
                onClick={clearManual}>חזרה לאוטומטי</button>
            )}
            <button type="button" className="pm-btn pm-btn--ghost" disabled={busy} onClick={() => setEdit(null)}>ביטול</button>
          </div>
        </div>
      )}
      {error && <div className="pm-banner pm-banner--error" role="alert">{error}</div>}
    </section>
  );
}
