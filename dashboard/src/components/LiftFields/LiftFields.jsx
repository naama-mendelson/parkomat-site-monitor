// components/LiftFields/LiftFields.jsx — סוג המעלית של אתר: אחת או שתיים, ולכל אחת הקונזול כשהסוג פותח אותו.
//
// בעלת המוצר, 12/10/2026: "אני רוצה שתהיה אופציה להוסיף עוד מעלית. יש אתרים שיש בהם שתי מעליות. וכן
// בסוגי מעליות להוסיף סוג בשם מספריים הידראולית ותעצב את הSELECT יותר יפה וחדשני". בחרה: עד שתיים;
// המספריים בלי קונזול; רשימה נפתחת מעוצבת (ChoiceSelect).
//
// משמש בשני הטפסים — הוספת אתר (variant="form") ושורת העריכה בניהול אתרים (variant="row").
// ⚠️ אין כאן החלטה: הכללים (מה חובה, מה חסר) ב-shared/lift-types.mjs (liftsProblem), והמסד אוכף אותם.
//   • הקונזול — שני חלקים במסגרת אחת (אורכי / רוחבי), רק בסוגים שפותחים אותו. החלפה לסוג בלי קונזול
//     מנקה אותו: ערך שנשאר בלי שדה שמראה אותו היה נשלח בלי שמישהו ראה.
//   • "+ עוד מעלית" — רק כשלראשונה יש סוג (שנייה בלי ראשונה אסורה גם במסד), ועד MAX_LIFTS.
//   • "✕ הסרה" — רק בשנייה. הראשונה חובה ואין לה הסרה.
import { useId } from "react";
import ChoiceSelect from "../ChoiceSelect/ChoiceSelect";
import { LIFT_CONSOLES, LIFT_TYPES, MAX_LIFTS, liftNeedsConsole } from "../../../../shared/lift-types.mjs";
import "./LiftFields.css";

const TYPE_OPTIONS = LIFT_TYPES.map((t) => ({ value: t.key, label: t.label }));
// ⚠️ "לא הוגדר" — אפשרות אמיתית כשהראשונה אינה חובה (מאז 12/10/2026 בערב: "תעשה שלא יהיה חייבים לבחור
// מה סוג המעלית"), כמו "לא הוגדר" של סוג המתקן ושל המערכת. רק כשאין שנייה: שנייה בלי ראשונה אסורה.
const NONE_LABEL = "לא הוגדר";
const NONE = { value: "", label: NONE_LABEL };

/**
 * @param {object} p
 * @param {{type: string, console: string}[]} p.lifts — לפחות אחת (ריקה = "" ו-"")
 * @param {(lifts: {type: string, console: string}[]) => void} p.onChange
 * @param {boolean} [p.required] — הראשונה חובה. ⚠️ מאז 12/10/2026 בערב — false בשני הטפסים; נשאר פרמטר
 *   כדי שהחלטה הפוכה תהיה שינוי של מילה.
 * @param {"form"|"row"} [p.variant]
 */
export default function LiftFields({ lifts, onChange, required = false, variant = "form" }) {
  const uid = useId();
  const list = lifts?.length ? lifts : [{ type: "", console: "" }];
  const many = list.length > 1;
  const set = (i, patch) => onChange(list.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className={`lf lf--${variant}`} data-count={list.length}>
      {list.map((l, i) => {
        const n = i + 1;
        const title = many ? `מעלית ${n}` : "סוג מעלית";
        const optional = i === 0 && !required;
        const options = optional && !many ? [NONE, ...TYPE_OPTIONS] : TYPE_OPTIONS;
        // "✕ הסרה": בטופס — בשורת הכותרת, מול השם; בשורת העריכה (עמודת כותרת צרה) — בסוף השורה
        const remove = i > 0 && (
          <button type="button" className="lf-remove" onClick={() => onChange(list.slice(0, i))}
            aria-label={`הסרת מעלית ${n}`}>✕ הסרה</button>
        );
        return (
          <div className="lf-lift" key={i} data-lift={n}>
            <div className="lf-head">
              <span className="lf-title">
                {title}{i === 0 && required && <b className="lf-req" aria-hidden="true"> *</b>}
              </span>
              {variant === "form" && remove}
            </div>
            <div className="lf-body">
              <ChoiceSelect
                name={i === 0 ? "lift_type" : `lift${n}_type`}
                label={many ? `סוג מעלית ${n}` : "סוג מעלית"}
                value={l.type || ""}
                options={options}
                placeholder={optional ? NONE_LABEL : "— לבחור —"}
                onChange={(v) => set(i, { type: v, console: liftNeedsConsole(v) ? l.console : "" })}
              />
              {liftNeedsConsole(l.type) && (
                <div className="lf-console" role="radiogroup" aria-label={many ? `קונזול — מעלית ${n}` : "קונזול"}
                  data-name={i === 0 ? "lift_console" : `lift${n}_console`}>
                  {LIFT_CONSOLES.map((c) => (
                    <label key={c.key} className="lf-seg">
                      <input type="radio" name={`${uid}-console-${n}`} value={c.key} checked={l.console === c.key}
                        onChange={() => set(i, { console: c.key })} />
                      <span>{c.label}</span>
                    </label>
                  ))}
                </div>
              )}
              {variant === "row" && remove}
            </div>
          </div>
        );
      })}
      {list.length < MAX_LIFTS && list[0]?.type && (
        <button type="button" className="lf-add" onClick={() => onChange([...list, { type: "", console: "" }])}>
          + עוד מעלית
        </button>
      )}
    </div>
  );
}
