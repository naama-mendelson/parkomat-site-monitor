// components/Compliance/PmTemplateEditor.jsx — עריכת רשימת הבדיקה של התחזוקה המונעת. מנהל בלבד.
//
// ⚠️ מ-07/10/2026 כמה רשימות: משותפת (ברירת המחדל — מה שהיה "הרשימה" של D15), רשימה
// לכל סוג מתקן, ולסוטפין. העורך עורך רשימה אחת בכל פעם; אילו רשימות אתר מקבל נקבע
// בלשונית התחזוקה של האתר (PmTab). אתר שלא שויך מקבל את ברירת המחדל, כמו קודם.
//
// פתיחת ביקור **מצלמת** את הפריטים הפעילים,
// ולכן שינוי כאן חל רק על ביקורים שייפתחו אחרי השמירה — ביקור פתוח ממשיך
// עם מה שהיה בעת פתיחתו, והמסך אומר את זה במפורש.
//
// השמירה שולחת את **מצב היעד** כולו (pm_template_save): פריט עם id מתעדכן,
// בלי id נוסף, ומה שלא נשלח מושבת — לא נמחק, כי ביקורים קיימים מצביעים עליו.
//
// ⚠️ כלל הצילום משוקף כאן מה-CHECK בטבלה (pm_checklist_items_photo_shape),
// כדי שהמנהל לא יגלה אותו רק בשגיאה אחרי השמירה:
//   • סימון בלבד          → 0 תמונות
//   • צילום, חובה          → לפחות תמונה אחת
//   • צילום, רשות          → 0 (פריט רשות לא יכול לדרוש תמונות)
// השרת אוכף בכל מקרה; כאן רק לא מאפשרים להגיע למצב שהוא ידחה.
//
// קבוצה (07/10/2026): שדה של הפריט ("יחידת כוח", "מעלית אנכית"). פריטים רצופים עם אותה
// קבוצה הם שורה אחת בביקור, שנפתחת בלחיצה ונהיית ירוקה כשהושלמה. ריק = קבוצה בשם הרשימה.
// פריט חדש מקבל את הקבוצה של הפריט האחרון — כך מוסיפים לקבוצה בלי להקליד אותה שוב.
//
// ⚠️ סך התמונות הנדרשות בביקור (סכום min_photos של פריטי החובה) מוגבל ל-40 —
// התקרה של pm_visit_photo_add. רשימה שדורשת יותר נשמרה בעבר בלי מילה, וכל
// ביקור שנפתח ממנה, בכל האתרים (D15), לא היה יכול להיות מוגש לעולם.
//
// ⚠️ שמירה מעורך ישן נדחית. הרשימה נשלחת כמצב יעד שלם, כך שעורך שנטען לפני
// שמנהל אחר שמר היה מבטל את השמירה שלו בשקט: פריטים שהוסיף מושבתים, ופריטים
// שהסיר חוזרים. לכן נשלח `version` — ה-updated_at המאוחר שנטען — והשרת
// משווה אותו לנוכחי (PT409). העורך גם נטען מחדש כשפותחים אותו שוב בלי שינויים.
//
// ⚠️ ובזמן טעינה מחדש (פתיחה חוזרת, אחרי שמירה, "טעינת הרשימה העדכנית") הכול
// נעול (`reloading`). התשובה מחליפה את השורות כולן: עריכה שהוקלדה בינתיים
// הייתה נעלמת בלי מילה, ושמירה שנייה לפני שהגרסה החדשה הגיעה הייתה נשלחת עם
// האסימון הישן — ונדחית כ"עודכנה בינתיים ע״י" המנהל עצמו.
import { useEffect, useRef, useState } from "react";
import { fetchPmTemplate, savePmTemplate, fetchPmTemplates, createPmTemplate, renamePmTemplate } from "../../services/dataSource";
import { formatStampIL } from "../../utils/compliance";
import { newId } from "../../utils/complianceFiles";
import {
  HINT_MAX, KIND_LABEL, LABEL_MAX, LABEL_MIN, MAX_PHOTOS_PER_ITEM, MAX_PHOTOS_PER_VISIT, PHOTO_TOTAL_WARN,
  TEMPLATE_MAX_ITEMS, templatePhotoTotal,
} from "./PmUtils";

// צורת הכלל — פונקציה אחת שכל שינוי עובר דרכה
function shape(r) {
  if (r.kind === "check" || !r.required) return r.min_photos === 0 ? r : { ...r, min_photos: 0 };
  if (r.min_photos < 1) return { ...r, min_photos: 1 };
  return r;
}

const SECTION_MAX = 60;
const serialize = (rows) => JSON.stringify((rows || []).map((r) => ({
  id: r.id ?? null, label: r.label.trim(), hint: r.hint.trim(), kind: r.kind, required: r.required, min_photos: r.min_photos,
  section: r.section.trim(),
})));

function rowError(r) {
  const n = r.label.trim().length;
  if (n < LABEL_MIN) return "שם הפריט — שני תווים לפחות";
  if (n > LABEL_MAX) return `שם הפריט ארוך מדי (עד ${LABEL_MAX})`;
  if (r.hint.trim().length > HINT_MAX) return `ההסבר ארוך מדי (עד ${HINT_MAX})`;
  if (r.section.trim().length > SECTION_MAX) return `שם הקבוצה ארוך מדי (עד ${SECTION_MAX})`;
  return "";
}

/**
 * @param {object} p
 * @param {boolean} [p.active=true] — הכלי גלוי. מעבר ל-true בלי שינויים → טעינה מחדש.
 */
export default function PmTemplateEditor({ onSaved, onDirty, active = true }) {
  const [rows, setRows] = useState(null);           // null = טוען
  const [base, setBase] = useState(serialize([]));
  const [meta, setMeta] = useState(null);           // {by, at} — העדכון האחרון
  const [version, setVersion] = useState(null);     // ה-updated_at המאוחר שנטען ('' = ריקה) — לבדיקת השרת
  const [stale, setStale] = useState(false);        // השרת דחה: מנהל אחר שמר מאז שנטענה
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [reloading, setReloading] = useState(false);   // טעינה מחדש בדרך — הכול נעול (ראה הכותרת)
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [focusKey, setFocusKey] = useState(null);
  const [touched, setTouched] = useState(false);
  // הרשימות (07/10/2026). tplId == null = רשימת ברירת המחדל — כמו לפני שהיו רשימות,
  // וכך הטעינה הראשונה אינה מחכה לרשימת הרשימות.
  const [lists, setLists] = useState(null);
  const [listsRev, setListsRev] = useState(0);
  const [tplId, setTplId] = useState(null);
  const [nameDraft, setNameDraft] = useState(null);   // {mode:'new'|'rename', value}
  const [listError, setListError] = useState("");
  useEffect(() => {
    let alive = true;
    fetchPmTemplates().then((l) => { if (alive) setLists(l); }).catch(() => { if (alive) setLists([]); });
    return () => { alive = false; };
  }, [listsRev]);
  const defaultId = lists?.find((t) => t.is_default)?.id ?? null;
  const current = lists?.find((t) => t.id === (tplId ?? defaultId)) ?? null;

  // ⚠️ הנעילה נדלקת **יחד** עם הבקשה (באותו רינדור), ולא בתוך האפקט: אפקט רץ
  // אחרי הציור, ובפריים שביניהם השדות היו פתוחים.
  const reload = () => { setReloading(true); setAttempt((x) => x + 1); };

  useEffect(() => {
    let alive = true;
    setLoadError("");
    fetchPmTemplate(tplId)
      .then((list) => {
        if (!alive) return;
        const next = list.map((t) => shape({
          key: `id:${t.id}`, id: t.id, label: t.label || "", hint: t.hint || "", section: t.section || "",
          kind: t.kind || "check", required: !!t.required, min_photos: Number(t.min_photos) || 0,
        }));
        const last = list.reduce((a, t) => (!a || (t.updated_at || "") > (a.updated_at || "") ? t : a), null);
        setRows(next);
        setBase(serialize(next));
        setMeta(last ? { by: last.updated_by, at: last.updated_at } : null);
        setVersion(last?.updated_at || "");
        setStale(false);
        setSaveError("");
        setTouched(false);
      })
      .catch((err) => { if (alive) setLoadError(err?.message || "רשימת הבדיקה לא נטענה"); })
      .finally(() => { if (alive) setReloading(false); });
    return () => { alive = false; };
  }, [attempt, tplId]);

  const dirty = rows != null && serialize(rows) !== base;
  const busy = saving || reloading;

  // ⚠️ הכלי נשאר מורכב (מוסתר) כל עוד הלשונית פתוחה — בלי זה, מי שפותח אותו
  // שוב אחרי שעה עורך את מה שהיה לפני שעה.
  const prevActive = useRef(active);
  useEffect(() => {
    if (active && !prevActive.current && rows != null && !dirty && !busy) { setReloading(true); setAttempt((x) => x + 1); }
    prevActive.current = active;
  }, [active, rows, dirty, busy]);

  const onDirtyRef = useRef(onDirty);
  useEffect(() => { onDirtyRef.current = onDirty; }, [onDirty]);
  const reason = dirty ? "שינויים ברשימת הבדיקה לא נשמרו." : null;
  useEffect(() => { onDirtyRef.current?.(reason); }, [reason]);
  useEffect(() => () => onDirtyRef.current?.(null), []);

  const edit = (key, fields) => {
    setSavedMsg("");
    setRows((rs) => rs.map((r) => (r.key === key ? shape({ ...r, ...fields }) : r)));
  };
  const move = (i, d) => setRows((rs) => {
    const j = i + d;
    if (j < 0 || j >= rs.length) return rs;
    const next = rs.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const add = () => {
    const key = newId();
    setRows((rs) => [...rs, { key, id: null, label: "", hint: "", section: rs.length ? rs[rs.length - 1].section : "",
      kind: "check", required: true, min_photos: 0 }]);
    setFocusKey(key);
    setSavedMsg("");
  };
  const remove = (key) => { setRows((rs) => rs.filter((r) => r.key !== key)); setSavedMsg(""); };

  const errors = (rows || []).map(rowError);
  const sections = [...new Set((rows || []).map((r) => r.section.trim()).filter(Boolean))];
  const sectionsId = `pm-tpl-sections-${tplId ?? "default"}`;
  const photoTotal = templatePhotoTotal(rows);
  const tooManyPhotos = photoTotal > MAX_PHOTOS_PER_VISIT;
  const invalid = errors.some(Boolean) || (rows || []).length > TEMPLATE_MAX_ITEMS || tooManyPhotos;

  const save = async () => {
    setTouched(true);
    if (invalid || busy) return;
    setSaving(true);
    setSaveError("");
    const sent = rows;
    try {
      const n = await savePmTemplate(sent.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        label: r.label.trim(),
        hint: r.hint.trim() || null,
        section: r.section.trim() || null,
        kind: r.kind,
        required: r.required,
        min_photos: r.min_photos,
      })), version, tplId);
      setListsRev((x) => x + 1);   // מספר הפריטים בבורר
      setSavedMsg(`נשמר — ${n} פריטים פעילים. חל על ביקורים שייפתחו מעכשיו.`);
      // ⚠️ מה שנשלח הוא עכשיו הבסיס (ולא "שינויים שלא נשמרו"), והעורך נעול עד
      // שהטעינה מחדש מביאה את ה-id של הפריטים החדשים ואת האסימון החדש. שמירה
      // נוספת עם האסימון הקודם הייתה נדחית כהתנגשות של המנהל עם עצמו.
      setBase(serialize(sent));
      reload();
      onSaved?.();
    } catch (err) {
      if (err?.code === "PT409") setStale(true);
      setSaveError(err?.message || "השמירה נכשלה");
    } finally {
      setSaving(false);
    }
  };

  // מעבר רשימה — נעול כשיש שינויים שלא נשמרו (אחרת הם נעלמים בשקט), ונועל את הכול עד שהיא נטענת.
  const pick = (id) => {
    const next = id === defaultId ? null : id;
    if (next === tplId) return;
    setSavedMsg(""); setSaveError(""); setStale(false);
    setReloading(true);
    setTplId(next);
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
  const listBar = (
    <>
      <div className="pm-row pm-tpl-lists">
        <label className="pm-tpl-pick">
          <span>רשימה</span>
          <select value={String(tplId ?? defaultId ?? "")} disabled={busy || dirty || !lists}
            onChange={(e) => pick(Number(e.target.value))}
            title={dirty ? "יש שינויים שלא נשמרו — לשמור או לבטל לפני מעבר לרשימה אחרת" : undefined}>
            {(lists || []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.is_default ? " (ברירת מחדל)" : ""} · {t.item_count} פריטים
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="pm-btn pm-btn--ghost" disabled={busy || dirty}
          onClick={() => { setListError(""); setNameDraft({ mode: "new", value: "" }); }}>+ רשימה חדשה</button>
        <button type="button" className="pm-btn pm-btn--ghost" disabled={busy || dirty || !current}
          onClick={() => { setListError(""); setNameDraft({ mode: "rename", value: current.name }); }}>שינוי שם</button>
      </div>
      {nameDraft && (
        <div className="pm-row pm-tpl-name">
          <input className="pm-input" autoFocus maxLength={60} value={nameDraft.value}
            placeholder={nameDraft.mode === "new" ? "שם הרשימה החדשה, למשל: דולי" : ""}
            onChange={(e) => setNameDraft({ ...nameDraft, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") submitName(); if (e.key === "Escape") setNameDraft(null); }} />
          <button type="button" className="pm-btn pm-btn--primary" onClick={submitName}>
            {nameDraft.mode === "new" ? "יצירה" : "שמירת השם"}</button>
          <button type="button" className="pm-btn pm-btn--ghost" onClick={() => setNameDraft(null)}>ביטול</button>
        </div>
      )}
      {listError && <div className="pm-banner pm-banner--error" role="alert">{listError}</div>}
    </>
  );

  if (loadError) {
    return (
      <div className="pm-banner pm-banner--error" role="alert">
        {loadError}
        <button type="button" className="pm-btn pm-btn--inline" onClick={reload}>נסה שוב</button>
      </div>
    );
  }
  if (!rows) return <p className="pm-muted">טוען את רשימת הבדיקה…</p>;

  return (
    <div className="pm-tpl">
      {listBar}
      <div className="pm-banner pm-banner--info">
        שינויים חלים על ביקורים שייפתחו <strong>אחרי</strong> השמירה. ביקור שכבר פתוח ממשיך עם הרשימה שהייתה בעת פתיחתו.
      </div>
      {meta?.at && <p className="pm-meta">עודכנה לאחרונה ע״י {meta.by || "—"} ב-{formatStampIL(meta.at)}</p>}
      {reloading && <p className="pm-muted" role="status">טוען את הרשימה העדכנית מהשרת…</p>}

      <datalist id={sectionsId}>{sections.map((x) => <option key={x} value={x} />)}</datalist>
      {rows.length === 0 ? (
        <p className="pm-muted">הרשימה ריקה. בלי פריטים אי אפשר לפתוח ביקור תחזוקה.</p>
      ) : (
        <ol className="pm-tpl-list">
          {rows.map((r, i) => (
            <li key={r.key} className={`pm-tpl-row${touched && errors[i] ? " pm-tpl-row--bad" : ""}`}>
              {r.section.trim() && (i === 0 || rows[i - 1].section.trim() !== r.section.trim()) && (
                <div className="pm-tpl-group">{r.section.trim()}</div>
              )}
              <div className="pm-tpl-top">
                <span className="pm-tpl-num" aria-hidden="true">{i + 1}</span>
                <label className="pm-field pm-tpl-label">
                  <span className="pm-sr">שם פריט {i + 1}</span>
                  <input className="pm-input" type="text" value={r.label} maxLength={LABEL_MAX}
                    placeholder="שם הפריט, למשל: בדיקת מפלס שמן" autoFocus={focusKey === r.key} disabled={busy}
                    onChange={(e) => edit(r.key, { label: e.target.value })} />
                </label>
              </div>
              <label className="pm-field">
                <span className="pm-sr">הסבר לפריט {i + 1}</span>
                <input className="pm-input" type="text" value={r.hint} maxLength={HINT_MAX}
                  placeholder="הסבר לטכנאי (רשות)" disabled={busy} onChange={(e) => edit(r.key, { hint: e.target.value })} />
              </label>

              <div className="pm-tpl-bar">
                <div className="pm-tpl-opts">
                  <label className="pm-field pm-tpl-sec">
                    <span>קבוצה</span>
                    <input className="pm-input" type="text" list={sectionsId} value={r.section} maxLength={SECTION_MAX}
                      placeholder="ריק = שם הרשימה" disabled={busy} onChange={(e) => edit(r.key, { section: e.target.value })} />
                  </label>
                  <label className="pm-field pm-tpl-kind">
                    <span>סוג</span>
                    <select className="pm-input" value={r.kind} disabled={busy} onChange={(e) => edit(r.key, { kind: e.target.value })}>
                      {Object.entries(KIND_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select>
                  </label>
                  <label className="pm-inline-check">
                    <input type="checkbox" className="pm-checkbox pm-checkbox--sm" checked={r.required}
                      disabled={busy} onChange={(e) => edit(r.key, { required: e.target.checked })} />
                    <span>חובה</span>
                  </label>
                  {r.kind !== "check" && (
                    <div className="pm-stepper" role="group" aria-label={`מספר תמונות מינימלי לפריט ${i + 1}`}>
                      <span>תמונות לפחות</span>
                      <button type="button" className="pm-icon-btn" aria-label="פחות"
                        disabled={busy || !r.required || r.min_photos <= 1}
                        onClick={() => edit(r.key, { min_photos: r.min_photos - 1 })}>−</button>
                      <output className="pm-stepper-val">{r.min_photos}</output>
                      <button type="button" className="pm-icon-btn" aria-label="יותר"
                        disabled={busy || !r.required || r.min_photos >= MAX_PHOTOS_PER_ITEM}
                        onClick={() => edit(r.key, { min_photos: r.min_photos + 1 })}>+</button>
                    </div>
                  )}
                </div>
                <div className="pm-tpl-move">
                  <button type="button" className="pm-icon-btn" aria-label={`העברת פריט ${i + 1} למעלה`}
                    disabled={busy || i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="pm-icon-btn" aria-label={`העברת פריט ${i + 1} למטה`}
                    disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="pm-btn pm-btn--danger" disabled={busy} onClick={() => remove(r.key)}>
                    הסרה
                  </button>
                </div>
              </div>
              {r.kind !== "check" && !r.required && (
                <small className="pm-hint">פריט רשות אינו יכול לדרוש תמונות — הטכנאי יצלם אם ירצה.</small>
              )}
              {touched && errors[i] && <span className="pm-field-err">{errors[i]}</span>}
            </li>
          ))}
        </ol>
      )}

      {rows.length > TEMPLATE_MAX_ITEMS && (
        <div className="pm-banner pm-banner--error">עד {TEMPLATE_MAX_ITEMS} פריטים ברשימה.</div>
      )}
      {tooManyPhotos ? (
        <div className="pm-banner pm-banner--error pm-tpl-photos" role="alert">
          סך התמונות הנדרשות בביקור ({photoTotal}) עולה על {MAX_PHOTOS_PER_VISIT} — אף ביקור לא יוכל
          להיות מוגש. יש להוריד את מספר התמונות הנדרש בפריטים.
        </div>
      ) : photoTotal > PHOTO_TOTAL_WARN && (
        <div className="pm-banner pm-banner--warn pm-tpl-photos" role="status">
          כל ביקור יידרש ל-{photoTotal} תמונות לפחות. נפח התמונות בביקור מוגבל ל-15MB — בערך 16 עד 40
          תמונות, לפי הצילום — ומעבר לו התמונות הבאות נדחות וההגשה נחסמת.
        </div>
      )}
      {saveError && (
        <div className="pm-banner pm-banner--error" role="alert">
          הרשימה לא נשמרה — {saveError}
          {stale && (
            <button type="button" className="pm-btn pm-btn--inline"
              disabled={busy}
              onClick={() => { if (!dirty || window.confirm("לטעון את הרשימה העדכנית? השינויים שלא נשמרו כאן יימחקו.")) reload(); }}>
              טעינת הרשימה העדכנית
            </button>
          )}
        </div>
      )}
      {savedMsg && !dirty && <div className="pm-banner pm-banner--ok" role="status">{savedMsg}</div>}

      <div className="pm-row">
        <button type="button" className="pm-btn" onClick={add} disabled={busy}>+ הוספת פריט</button>
        <button type="button" className="pm-btn pm-btn--primary" onClick={save} disabled={busy || !dirty}>
          {saving ? "שומר…" : "שמירת הרשימה"}
        </button>
        {dirty && !busy && (
          <button type="button" className="pm-btn pm-btn--ghost"
            onClick={() => { setRows(JSON.parse(base).map((b, n) => ({ ...b, key: b.id ? `id:${b.id}` : `n:${n}` }))); setTouched(false); }}>
            ביטול השינויים
          </button>
        )}
      </div>
      {touched && invalid && <span className="pm-field-err">יש לתקן את הפריטים המסומנים לפני השמירה.</span>}
    </div>
  );
}
