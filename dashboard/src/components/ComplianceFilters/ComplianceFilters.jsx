// components/ComplianceFilters/ComplianceFilters.jsx — "בודק מוסמך" בסינון שבכותרת: אריח שנפתח לרשימה.
//
// בעלת המוצר (08/10/2026): "כשלוחצים על בודק מוסמך יפתח תפריט מתחת, ואז יצטרכו לבחור מה רואים, ואז
// זה יסגר בסיום הבחירה". ואחר כך: "תעשה את זה יותר יפה" — על האריח. ולפני כן: הנורה בכרטיס "מופיעה
// רק כשמסמנים", כל המצבים מופיעים תמיד (גם 0), ו"אין נתונים" / "לא נטען" — "תעיף את זה, זה לא קיים".
//
// ⚠️ תפריט משלנו ולא <select>: הרשימה של <select> מצוירת על ידי מערכת ההפעלה — לבנה, בלי צבע ובלי
// הנורה — ואי אפשר לעצב אותה. כאן כל שורה נושאת את הנורה של המצב (LampSwatch, אותה מנורה כמו בכרטיס),
// והאריח הסגור נראה כמו אריחי המצב שלידו: מספר גדול, שם, וצבע המצב כשנבחר.
// ההתנהגות של הרשימה (מקלדת, סגירה, מיקום בטלפון) — ב-FilterPicker, משותפת ל"משימות" (18/10/2026).
// ⚠️ בחירה אחת בכל פעם, כמו הבוררים שלידו. המודל (only) תומך בכמה — הממשק לא מציע.
//
// אין כאן החלטה על מצב: השורות, המפתחות, הספירה והסינון ב-utils/compliance.js.
import { AreaIcon } from "../Compliance/icons";
import { LampSwatch } from "../Compliance/ComplianceLights";
import {
  AREA_NAME, COMPLIANCE_AREAS, COMPLIANCE_FILTER_ROWS, DEFAULT_COMPLIANCE_VIEW, complianceFilterCounts,
} from "../../utils/compliance";
import FilterPicker from "./FilterPicker";

const OFF = "__off__";
const ALL = "__all__";

function AreaPicker({ area, sites, counts, value, onPick }) {
  const on = value?.show === true;
  const row = COMPLIANCE_FILTER_ROWS[area].find((r) => r.key === value?.only?.[0]);
  const current = !on ? OFF : row ? row.key : ALL;

  const items = [
    { value: OFF, label: `בלי ${AREA_NAME[area]}`, hint: "בלי נורות בכרטיסים", cls: "cf-item--off", mark: "○" },
    { value: ALL, label: "כל האתרים", n: sites.length, cls: "cf-item--all", mark: <AreaIcon area={area} size={14} /> },
    ...COMPLIANCE_FILTER_ROWS[area].map((r) => ({
      value: r.key, label: r.label, n: counts[r.key], title: r.title, mark: <LampSwatch state={r.swatch} area={area} />,
    })),
  ];

  return (
    <FilterPicker
      items={items}
      current={current}
      onPick={onPick}
      btnClass={`cf-area-btn cf-area-btn--in-${area}${on ? " active" : ""}${row ? ` cf-area-btn--${row.key}` : ""}`}
      ariaLabel={`${AREA_NAME[area]}: ${items.find((it) => it.value === current).label}`}
      menuLabel={`${AREA_NAME[area]} — מה להציג`}
      head={(open) => (
        <>
          {row ? (
            // נבחר מצב — כמו אריח מצב: המספר הגדול הוא כמה אתרים מוצגים עכשיו
            <span className="filter-count cf-head"><LampSwatch state={row.swatch} area={area} /> {counts[row.key]}</span>
          ) : (
            <span className="filter-count cf-head" aria-hidden="true"><AreaIcon area={area} size={22} /></span>
          )}
          <span className="filter-label cf-name">
            {row ? row.label : AREA_NAME[area]}
            <span className={`cf-chevron${open ? " is-open" : ""}`} aria-hidden="true">▾</span>
          </span>
          {/* מתחת לשם — מה המצב: מי שבחר מצב רואה מאיזה תחום הוא, ומי שבחר "כל האתרים" רואה שזה פעיל */}
          {row && <span className="cf-sub">{AREA_NAME[area]}</span>}
          {on && !row && <span className="cf-sub">כל האתרים</span>}
        </>
      )}
    />
  );
}

function ComplianceFilters({ sites, value = DEFAULT_COMPLIANCE_VIEW, onChange, areas = COMPLIANCE_AREAS }) {
  const counts = complianceFilterCounts(sites, areas);
  return areas.map((area) => (
    <AreaPicker
      key={area}
      area={area}
      sites={sites}
      counts={counts[area]}
      value={value[area]}
      onPick={(v) => onChange({ ...value, [area]: v === OFF ? { show: false, only: [] } : { show: true, only: v === ALL ? [] : [v] } })}
    />
  ));
}

export default ComplianceFilters;
