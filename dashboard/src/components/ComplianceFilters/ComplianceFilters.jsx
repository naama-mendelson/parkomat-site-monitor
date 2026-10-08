// components/ComplianceFilters/ComplianceFilters.jsx — "בודק מוסמך" בסינון שבכותרת: אריח שנפתח לרשימה.
//
// בעלת המוצר (08/10/2026), אחרי סרגל בצד בשלוש גרסאות: "כשלוחצים על בודק מוסמך יפתח תפריט מתחת, ואז
// יצטרכו לבחור מה רואים, ואז זה יסגר בסיום הבחירה". ולפני כן: הנורה בכרטיס "מופיעה רק כשמסמנים",
// כל המצבים מופיעים תמיד (גם 0), ו"אין נתונים" / "לא נטען" — "תעיף את זה, זה לא קיים".
//
// ⚠️ <select> אמיתי ולא תפריט משלנו: זה בדיוק "נפתח מתחת, בוחרים, נסגר" — כמו שלושת הבוררים של
// SiteFilterTile שלידו — ובטלפון הוא נפתח כבורר של הטלפון. הבורר שקוף ומכסה את כל האריח, כך שלחיצה
// בכל מקום עליו פותחת אותו; מה שנראה הוא הסמל, שם התחום והבחירה הנוכחית.
// ⚠️ בחירה אחת בכל פעם, כמו הבוררים שלידו. המודל (only) תומך בכמה — הממשק לא מציע.
//
// אין כאן החלטה על מצב: השורות, המפתחות, הספירה והסינון ב-utils/compliance.js.
import { AreaIcon } from "../Compliance/icons";
import {
  AREA_NAME, COMPLIANCE_AREAS, COMPLIANCE_FILTER_ROWS, DEFAULT_COMPLIANCE_VIEW, complianceFilterCounts,
} from "../../utils/compliance";
import "./ComplianceFilters.css";

const OFF = "";
const ALL = "__all__";

function ComplianceFilters({ sites, value = DEFAULT_COMPLIANCE_VIEW, onChange, areas = COMPLIANCE_AREAS }) {
  const counts = complianceFilterCounts(sites, areas);
  return areas.map((area) => {
    const on = value[area]?.show === true;
    const key = value[area]?.only?.[0];
    const row = COMPLIANCE_FILTER_ROWS[area].find((r) => r.key === key);
    const current = !on ? OFF : row ? row.key : ALL;
    const choice = !on ? null : row ? `${row.label} (${counts[area][row.key]})` : "כל האתרים";
    const pick = (v) => onChange({ ...value, [area]: v === OFF ? { show: false, only: [] } : { show: true, only: v === ALL ? [] : [v] } });
    return (
      <div key={area} className={`filter-btn cf-area-btn${on ? " active" : ""}`}>
        <span className="filter-count cf-area-icon" aria-hidden="true"><AreaIcon area={area} size={22} /></span>
        <span className="filter-label">{AREA_NAME[area]}</span>
        {choice && <span className="cf-choice">{choice}</span>}
        <select
          className="cf-select"
          value={current}
          onChange={(e) => pick(e.target.value)}
          aria-label={`${AREA_NAME[area]} — מה להציג`}
        >
          {/* ⚠️ "בלי" ולא רק "הכל": "הכל" מציג את הנורות בלי לסנן, "בלי" מחזיר לברירת המחדל — בלי
              נורות. בלי האפשרות הזו לא הייתה דרך לכבות, חוץ מרענון הדף. */}
          <option value={OFF}>בלי {AREA_NAME[area]}</option>
          <option value={ALL}>כל האתרים ({sites.length})</option>
          {COMPLIANCE_FILTER_ROWS[area].map((r) => (
            <option key={r.key} value={r.key}>{r.label} ({counts[area][r.key]})</option>
          ))}
        </select>
      </div>
    );
  });
}

export default ComplianceFilters;
