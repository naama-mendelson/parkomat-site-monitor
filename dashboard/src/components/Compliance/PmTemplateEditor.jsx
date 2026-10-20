// components/Compliance/PmTemplateEditor.jsx — עריכת רשימות הבדיקה של התחזוקה המונעת. עורך או מנהל.
//
// ⚠️ מ-07/10/2026 כמה רשימות: הבסיס (ברירת המחדל — מה שהיה "הרשימה" של D15), רשימה לכל סוג מעלית ומתקן, ולסוטפין.
// אילו רשימות אתר מקבל נקבע בלשונית התחזוקה של האתר (PmTab / PmSiteLists) ולפי סוגו.
//
// ⚠️ 19/10/2026 — כשהעורך נפתח מאתר, הוא מציג את **כל הרשימות של האתר אחת מתחת לשנייה** (בעלת המוצר, על עורך שהראה רק את
// "בסיס פרקומט — לובי וחשמל" בעוד הכפתור אמר 46: "צריך להיות הרבה יותר — מעלית הידראולית, מיטת XY, למה זה לא מוסף שם").
// הרשימות היו שם — בבורר, אחת בכל פעם — וזה בדיוק מה שלא נראה. לכל רשימה כותרת, ומתחתיה כמה אתרים חולקים אותה ("משותפת
// ל-52 אתרים"): הרשימות משותפות לכל האתרים מאותו סוג, ושינוי בהן חל על כולם. כל רשימה נשמרת לבדה (PmListEditor).
// הבורר נשאר: הבחירה הראשונה בו היא "הרשימות של האתר הזה", ובחירת רשימה אחת חוזרת לעורך של רשימה אחת, עם שינוי השם
// והסיווג לפי סוג (PmTemplateMeta), שאינם מוצגים בתצוגת האתר.
import { useEffect, useRef, useState } from "react";
import { fetchPmTemplates, createPmTemplate, renamePmTemplate } from "../../services/dataSource";
import ChoiceSelect from "../ChoiceSelect/ChoiceSelect";
import PmTemplateMeta from "./PmTemplateMeta";
import PmListEditor from "./PmListEditor";
import { groupTemplates, sharedLabel } from "../../utils/pmLists";

const SITE = "site";   // ערך הבורר של "הרשימות של האתר הזה" — לא מזהה רשימה

/**
 * @param {object} p
 * @param {boolean} [p.active=true] — הכלי גלוי. מעבר ל-true בלי שינויים → טעינה מחדש.
 * @param {{id: number, name: string}[]|null} [p.siteTemplates] — הרשימות של האתר (pm_site.templates, לפי הסדר). בלעדיהן — רשימה אחת.
 */
export default function PmTemplateEditor({ onSaved, onDirty, active = true, siteTemplates = null }) {
  const site = Array.isArray(siteTemplates) ? siteTemplates : [];
  const [lists, setLists] = useState(null);
  const [listsRev, setListsRev] = useState(0);
  // SITE = כל רשימות האתר; מזהה = רשימה אחת; null = רשימת ברירת המחדל (כך הטעינה הראשונה אינה מחכה לרשימת הרשימות)
  const [view, setView] = useState(site.length ? SITE : null);
  const [states, setStates] = useState({});     // מפתח מופע → { dirty, busy }
  const [reasons, setReasons] = useState({});   // מפתח מופע → "שינויים לא נשמרו" / null
  const [nameDraft, setNameDraft] = useState(null);   // {mode:'new'|'rename', value}
  const [listError, setListError] = useState("");
  useEffect(() => {
    let alive = true;
    fetchPmTemplates().then((l) => { if (alive) setLists(l); }).catch(() => { if (alive) setLists([]); });
    return () => { alive = false; };
  }, [listsRev]);
  const defaultId = lists?.find((t) => t.is_default)?.id ?? null;
  const siteMode = view === SITE && site.length > 0;
  const tplId = siteMode ? null : (view === SITE ? null : view);
  const current = siteMode ? null : lists?.find((t) => t.id === (tplId ?? defaultId)) ?? null;
  // ⚠️ רק המופעים שעל המסך עכשיו: רשימה שיצאה מהאתר באמצע טעינה הייתה משאירה busy במפה, והבורר היה ננעל לתמיד
  const shown = siteMode ? site.map((t) => `s${t.id}`) : ["one"];
  const dirty = shown.some((k) => states[k]?.dirty);
  const busy = shown.some((k) => states[k]?.busy);

  // "שינויים לא נשמרו" של אחת הרשימות → PmTab (שמירה מפני סגירת החלון)
  const onDirtyRef = useRef(onDirty);
  useEffect(() => { onDirtyRef.current = onDirty; }, [onDirty]);
  const reason = Object.values(reasons).find(Boolean) ?? null;
  useEffect(() => { onDirtyRef.current?.(reason); }, [reason]);
  useEffect(() => () => onDirtyRef.current?.(null), []);
  const dirtyFor = (k) => (r) => setReasons((m) => (m[k] === r ? m : { ...m, [k]: r }));
  const stateFor = (k) => (s) => setStates((m) => (m[k]?.dirty === s.dirty && m[k]?.busy === s.busy ? m : { ...m, [k]: s }));
  const saved = () => { setListsRev((x) => x + 1); onSaved?.(); };   // מספרי הפריטים והאתרים בבורר ובכותרות

  // מעבר תצוגה — נעול כשיש שינויים שלא נשמרו (אחרת הם נעלמים בשקט); המופעים הקודמים יורדים, והמצב שלהם מתאפס
  const pick = (v) => {
    const next = v === SITE ? SITE : (v === defaultId ? null : v);
    if (next === view) return;
    setStates({});
    setView(next);
  };
  const submitName = async () => {
    const value = (nameDraft?.value || "").trim();
    if (value.length < 2) { setListError("שם הרשימה — לפחות 2 תווים"); return; }
    setListError("");
    try {
      if (nameDraft.mode === "new") {
        const id = await createPmTemplate(value);
        setNameDraft(null);
        setListsRev((x) => x + 1);
        pick(id);
      } else {
        await renamePmTemplate(current.id, value);
        setNameDraft(null);
        setListsRev((x) => x + 1);
      }
    } catch (err) { setListError(err?.message || "הפעולה נכשלה"); }
  };

  const siteLists = site.map((t) => lists?.find((l) => l.id === t.id) ?? t);
  const siteItems = siteLists.reduce((n, t) => n + (Number(t.item_count) || 0), 0);
  const siteOption = site.length ? [{
    value: SITE, group: "האתר הזה",
    label: `הרשימות של האתר הזה · ${site.length} ${site.length === 1 ? "רשימה" : "רשימות"}${lists ? ` · ${siteItems} פריטים` : ""}`,
  }] : [];

  return (
    <div className="pm-tpl">
      <div className="pm-row pm-tpl-lists">
        {/* ⚠️ הרשימה המעוצבת ולא <select> (בעלת המוצר, 15/10/2026, על הרשימה הפתוחה: "תעצב את זה יפה") — את הרשימה
            של <select> מציירת מערכת ההפעלה. מקובץ: האתר הזה / בסיס / מעליות / רצפה ומרתף / אחר. */}
        <div className="pm-tpl-pick" title={dirty ? "יש שינויים שלא נשמרו — לשמור או לבטל לפני מעבר לרשימה אחרת" : undefined}>
          <span>רשימה</span>
          <ChoiceSelect name="pm_template" label="רשימת תחזוקה" value={siteMode ? SITE : String(tplId ?? defaultId ?? "")}
            disabled={busy || dirty || !lists} menuMinWidth={380}
            options={[...siteOption, ...groupTemplates(lists || []).flatMap((g) => g.templates.map((t) => ({
              value: String(t.id), group: g.label,
              label: `${t.name}${t.is_default ? " (ברירת מחדל)" : ""} · ${t.item_count} פריטים`,
            })))]}
            onChange={(v) => pick(v === SITE ? SITE : Number(v))} />
        </div>
        <button type="button" className="pm-btn pm-btn--ghost" disabled={busy || dirty}
          onClick={() => { setListError(""); setNameDraft({ mode: "new", value: "" }); }}>+ רשימה חדשה</button>
        <button type="button" className="pm-btn pm-btn--ghost" disabled={busy || dirty || !current}
          title={siteMode ? "שינוי שם — לבחור רשימה אחת בבורר" : undefined}
          onClick={() => { setListError(""); setNameDraft({ mode: "rename", value: current.name }); }}>שינוי שם</button>
      </div>
      {nameDraft && (
        <div className="pm-row pm-tpl-name">
          <input className="pm-input" autoFocus maxLength={60} value={nameDraft.value}
            placeholder={nameDraft.mode === "new" ? "שם הרשימה החדשה, למשל: דולי" : ""}
            onChange={(e) => setNameDraft({ ...nameDraft, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submitName(); if (e.key === "Escape") { e.stopPropagation(); setNameDraft(null); } }} />
          <button type="button" className="pm-btn pm-btn--primary" onClick={submitName}>
            {nameDraft.mode === "new" ? "יצירה" : "שמירת השם"}</button>
          <button type="button" className="pm-btn pm-btn--ghost" onClick={() => setNameDraft(null)}>ביטול</button>
        </div>
      )}
      {listError && <div className="pm-banner pm-banner--error" role="alert">{listError}</div>}
      {/* סיווג הרשימה לפי סוג האתר (15/10/2026) — רק בעורך של רשימה אחת */}
      {/* ⚠️ key לפי הרשימה: בלי זה הטופס שומר רגע את הסיווג של הרשימה הקודמת (ה-state נולד פעם אחת). ⚠️ עם קידומת:
          PmListEditor שלמטה הוא אח באותו הורה, ו-key זהה (המזהה לבדו) שכפל רכיב — שני טופסי סיווג על המסך (19/10/2026) */}
      {current && !nameDraft && <PmTemplateMeta key={`meta-${current.id}`} template={current} onSaved={() => setListsRev((x) => x + 1)} />}

      <div className="pm-banner pm-banner--info">
        שינויים חלים על ביקורים שייפתחו <strong>אחרי</strong> השמירה. ביקור שכבר פתוח ממשיך עם הרשימה שהייתה בעת פתיחתו.
      </div>

      {siteMode ? (
        <div className="pm-tpl-sites" data-testid="pm-tpl-site-lists">
          {siteLists.map((t) => (
            <section key={t.id} className="pm-tpl-site" data-template={t.id}>
              <PmListEditor tplId={t.id} active={active} onDirty={dirtyFor(`s${t.id}`)} onState={stateFor(`s${t.id}`)} onSaved={saved}
                head={(
                  <div className="pm-tpl-site-head">
                    <h4>{t.name}</h4>
                    <span className="pm-muted" data-testid="pm-tpl-shared">
                      {t.item_count != null ? `${t.item_count} פריטים · ` : ""}{sharedLabel(t)}
                    </span>
                  </div>
                )} />
            </section>
          ))}
        </div>
      ) : (
        <PmListEditor key={`list-${tplId ?? "default"}`} tplId={tplId} active={active} onDirty={dirtyFor("one")} onState={stateFor("one")} onSaved={saved} />
      )}
    </div>
  );
}
