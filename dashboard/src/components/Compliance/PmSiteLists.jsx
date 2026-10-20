// components/Compliance/PmSiteLists.jsx — מה נבחר לאתר: הבסיס, ובחירה מרובה לכל קבוצה (20/10/2026).
//
// בעלת המוצר: "אני רוצה שתעשה רשימה ויצטרכו לבחור מה אנו רוצים. יש כמובן בסיס — זה נמצא לכל האתרים. ואז צריך לבחור
// XY וכו' (בחירה מרובה). ואז צריך לבחור מעליות (בחירה מרובה). עד שלא בוחרים אין כלום עדיין. יש כמה SELECTS, שם בוחרים
// בכל אחד מה שצריך, ולפי זה נוצרת התחזוקה המונעת". ובתשובותיה: כל האתרים מתחילים מאפס, הבחירה בלשונית הזו, והבסיס
// לרובוטיים בלבד.
//
// - שורת "בסיס": רק לאתר רובוטי, קבועה — לא בחירה (app.pm_site_template_ids מוסיף אותה מעצמו).
// - שורה לכל קבוצה (מתקן / מעליות / אחר — PM_CHOICE_GROUPS) עם ChoiceSelect מרובה. בקר רואה טקסט.
// - שינוי נשמר רק ב"שמירה": זו רשימת הבדיקה של הביקור הבא, ובחירה בטעות לא צריכה לשנות אותה מיד.
// - מתחת: "לפי סוג האתר" — לכל מאפיין בתג הכרטיס, איזו רשימה מתאימה לו ואם נבחרה (רמז, לא שיוך).
// ⚠️ עד 20/10 כאן הייתה שורה "רשימות תחזוקה: A · B (אוטומטי לפי סוג האתר)" ו"שינוי" עם תיבות ופרופיל. הסוג והפרופיל כבר
// אינם קובעים, ולכן גם בורר הפרופיל ירד. ⚠️ ביקור שכבר פתוח אינו משתנה — הפריטים שלו צולמו בפתיחה.
import { useEffect, useState } from "react";
import { fetchPmTemplates, setPmSiteTemplates } from "../../services/dataSource";
import ChoiceSelect from "../ChoiceSelect/ChoiceSelect";
import { choiceGroups, baseTemplate, chosenIds, visitItemCount, coverageRows } from "../../utils/pmLists";

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ⚠️ 19/10/2026 — "לפי סוג האתר": שורה לכל מאפיין שבתג הכרטיס (מתקן, מערכת, מעלית, קונזול) ומה מכסה אותו. בעלת המוצר,
// על "XY · ביטנקם · הידראולית בוכנה 1 · קונזול אורכי": "צריך בתחזוקה לראות שיש מענה גם ל…". מאפיין בלי רשימה נפרדת —
// "מכוסה ברשימות הכלליות" (תשובתה: "אין צורך בתחזוקה נפרדת"), לא "חסר". רשימה שמתאימה ולא נבחרה — נאמר במפורש.
function CoverageRow({ row }) {
  return (
    <li className={`pm-cover-row is-${row.state}`} data-key={row.key} data-state={row.state}>
      <span className="pm-cover-key">{row.label} —</span>
      <span className="pm-cover-val">
        {row.state === "covered" && row.assigned.join(" · ")}
        {row.state === "general" && <span className="pm-muted">מכוסה ברשימות הכלליות</span>}
        {row.unassigned.length > 0 && (
          <span className="pm-cover-off">{row.state === "covered" ? " · " : ""}יש רשימה ({row.unassigned.join(", ")}) — לא נבחרה לאתר</span>
        )}
      </span>
    </li>
  );
}

/**
 * @param {object} p
 * @param {string} p.code
 * @param {{id:number,name:string}[]} p.templates — pm_site.templates: מה שהאתר מקבל עכשיו (כולל הבסיס לרובוטי)
 * @param {boolean} p.robotic — pm_site.site.monitored: לרובוטי יש בסיס
 * @param {boolean} p.editable — עורך / מנהל
 * @param {() => void} [p.onChanged] — אחרי שמירה (הלשונית טוענת מחדש)
 * @param {(reason: string|null) => void} [p.onDirty] — בחירה שלא נשמרה, לשומר הסגירה של החלון
 * @param {number} [p.rev] — עולה כשהרשימות עצמן השתנו בעורך (רשימה חדשה, שם, פריטים) — אז טוענים אותן מחדש
 */
export default function PmSiteLists({ code, templates = [], robotic = true, typeCoverage = null, editable = false, onChanged, onDirty, rev = 0 }) {
  const cover = coverageRows(typeCoverage);
  const [all, setAll] = useState(null);          // null = טוען; false = לא נטען
  const [draft, setDraft] = useState(null);      // null = כמו שנשמר; אחרת מערך מזהים
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // ⚠️ גם כש-rev עולה: רשימה שנוצרה בעורך שבתחתית הלשונית חייבת להופיע כאן בלי לסגור את החלון. טעינה חוזרת שנכשלה
  // משאירה את מה שנטען — לא הופכת את הבחירה ל"לא נטען".
  useEffect(() => {
    let alive = true;
    fetchPmTemplates().then((l) => { if (alive && Array.isArray(l)) setAll(l); else if (alive) setAll((a) => (Array.isArray(a) ? a : false)); })
      .catch(() => { if (alive) setAll((a) => (Array.isArray(a) ? a : false)); });
    return () => { alive = false; };
  }, [rev]);

  // ⚠️ אחרי שמירה — מה שנשמר, עד שהלשונית נטענת מחדש עם הרשימות החדשות. בלעדיו הבחירה הישנה הבהבה רגע אחרי "שמירה".
  const tplKey = templates.map((t) => t.id).join(",");
  const [savedNow, setSavedNow] = useState(null);
  useEffect(() => { setSavedNow(null); }, [tplKey]);
  const saved = savedNow ?? (Array.isArray(all) ? chosenIds(templates, all) : []);
  const current = draft ?? saved;
  const dirty = draft != null && !sameList([...draft].sort((a, b) => a - b), [...saved].sort((a, b) => a - b));
  useEffect(() => { onDirty?.(dirty ? "בחירת רשימות התחזוקה של האתר לא נשמרה." : null); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onDirty?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setError(""); setBusy(true);
    try { await setPmSiteTemplates(code, current); setSavedNow(current); setDraft(null); onChanged?.(); }
    catch (e) { setError(e?.message || "השמירה נכשלה"); }
    finally { setBusy(false); }
  };

  const base = Array.isArray(all) ? baseTemplate(all) : null;
  const groups = Array.isArray(all) ? choiceGroups(all) : [];
  const count = Array.isArray(all) ? visitItemCount(all, current, robotic) : null;
  const nothing = !robotic && current.length === 0;

  return (
    <section className="pm-card pm-choose" data-testid="pm-site-lists">
      <h3 className="pm-h3">רשימות התחזוקה של האתר</h3>
      {all === null && <p className="pm-muted">טוען רשימות…</p>}
      {all === false && (
        <>
          <p className="pm-site-lists"><span>מקבל עכשיו:</span>
            <span className="pm-site-lists-names">{templates.map((t) => t.name).join(" · ") || "—"}</span></p>
          <div className="pm-banner pm-banner--error" role="alert">הרשימות לא נטענו — אי אפשר לשנות את הבחירה כרגע.</div>
        </>
      )}
      {Array.isArray(all) && (
        <div className="pm-choose-rows">
          {robotic && base && (
            <div className="pm-choose-row" data-group="base">
              <span className="pm-choose-cap">בסיס</span>
              <span className="pm-choose-base"><b>{base.name}</b> <span className="pm-muted">· {base.item_count} פריטים · לכל האתרים הרובוטיים</span></span>
            </div>
          )}
          {groups.map((g) => {
            const ids = g.templates.map((t) => t.id);
            const mine = current.filter((id) => ids.includes(id));
            return (
              <div key={g.key} className="pm-choose-row" data-group={g.key}>
                <span className="pm-choose-cap" id={`pm-choose-${g.key}`}>{g.label}</span>
                {editable ? (
                  <ChoiceSelect multiple label={g.label} name={`pm_choose_${g.key}`} placeholder="לא נבחר" disabled={busy}
                    menuMinWidth={300} value={mine.map(String)}
                    options={g.templates.map((t) => ({ value: String(t.id), label: t.name, hint: `${t.item_count} פריטים` }))}
                    onChange={(v) => {
                      const keep = current.filter((id) => !ids.includes(id));
                      setDraft([...keep, ...v.map(Number)]);
                    }} />
                ) : (
                  <span className={mine.length ? "pm-site-lists-names" : "pm-muted"} data-testid={`pm-choose-text-${g.key}`}>
                    {g.templates.filter((t) => mine.includes(t.id)).map((t) => t.name).join(" · ") || "לא נבחר"}
                  </span>
                )}
              </div>
            );
          })}
          <p className={nothing ? "pm-hint pm-hint--warn" : "pm-muted"} data-testid="pm-choose-count">
            {nothing ? "לא נבחרה תחזוקה לאתר — עד שבוחרים, אין ממה לפתוח ביקור." : `בביקור: ${count} פריטים`}
          </p>
          {editable && dirty && (
            <>
              <div className="pm-row">
                <button type="button" className="pm-btn pm-btn--primary" disabled={busy} onClick={save}>{busy ? "שומר…" : "שמירה"}</button>
                <button type="button" className="pm-btn pm-btn--ghost" disabled={busy} onClick={() => setDraft(null)}>ביטול</button>
              </div>
              <p className="pm-muted">חל מהביקור הבא. ביקור שכבר פתוח ממשיך עם מה שהיה בפתיחתו.</p>
            </>
          )}
        </div>
      )}
      {cover.length > 0 && (
        <div className="pm-cover" data-testid="pm-type-coverage">
          <span className="pm-cover-cap">לפי סוג האתר:</span>
          <ul className="pm-cover-list">
            {cover.map((r) => <CoverageRow key={r.key} row={r} />)}
          </ul>
        </div>
      )}
      {error && <div className="pm-banner pm-banner--error" role="alert">{error}</div>}
    </section>
  );
}
