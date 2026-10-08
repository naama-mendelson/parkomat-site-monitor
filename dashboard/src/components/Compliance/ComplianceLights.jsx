// components/Compliance/ComplianceLights.jsx — שתי המנורות בכרטיס: בודק מוסמך ותחזוקה מונעת.
//
// רכיב תצוגה טהור: מקבל את אובייקט ה-compliance (utils/compliance.js →
// toCompliance) ואינו יודע מאיפה הוא הגיע. אין כאן קריאה לשרת ואין כאן סף —
// הצבע הוחלט ב-SQL, וכאן רק מציירים אותו.
//
// ============================================================
// ⚠️ הצבע לעולם אינו הסימן היחיד
// ============================================================
// כל מנורה נושאת אייקון תחום (לוח עם וי / מפתח ברג) וגליף מצב — לכל אחד משבעת
// המצבים גליף משלו (GLYPH ב-utils/compliance.js). מנורה אדומה, כתומה וצהובה נבדלות
// גם בשחור-לבן, וגם למי שאינו מבחין בין הגוונים.
//
// ⚠️ ומנורה **לא נעלמת** כשהסטטוס לא נטען. היא הופכת ל-"?" מקווקו. מנורה
// חסרה נראית בדיוק כמו "אין מה לדווח" — וזה הלקח של 17/09, כשהמסך הפסיק
// להתעדכן חמישה ימים בלי שאיש שם לב.
//
// ⚠️ ההסתרה היחידה היא בחירה מפורשת: בלוח, הנורה של תחום מצוירת רק אחרי בחירה בבורר "בודק מוסמך"
// שבכותרת (08/10/2026). היא מגיעה דרך LampAreasContext, ולא מנתונים חסרים.
import { createContext, useContext } from "react";
import { COMPLIANCE_COLORS } from "../../utils/constants";
import {
  AREA_NAME, COMPLIANCE_AREAS, GLYPH, draftStale, isAwaiting, lampState, lightAria, lightTitle, markFor, markVisible,
  stateLabel,
} from "../../utils/compliance";
import { AreaIcon } from "./icons";
import "./ComplianceLights.css";

/**
 * אילו נורות מצוירות. ברירת המחדל — COMPLIANCE_AREAS (התחזוקה מוסתרת באתר החי). הלוח
 * (OperatorView) מספק כאן את התחומים שנבחר בהם משהו בכותרת; כל מקום אחר — טבלת מנהל הבקרה,
 * למשל — מקבל את ברירת המחדל ואינו מושפע מהבחירה.
 * ⚠️ הקשר ולא prop: כך SiteGrid ו-SiteCard לא צריכים להעביר הלאה משהו שאינו שלהם.
 */
export const LampAreasContext = createContext(COMPLIANCE_AREAS);

function colorVars(state) {
  const c = COMPLIANCE_COLORS[state];
  // ⚠️ מילוי, מסגרת וסימן — שמות של משתני CSS, והערכים ב-ComplianceLights.css לכל נושא.
  // "?" (unknown) אינו כאן בכוונה: הוא נצבע מה-CSS, מקווקו.
  return c ? { "--cl-fill": c.bg, "--cl-border": c.border, "--cl-ink": c.ink } : undefined;
}

/**
 * הגלולה בלבד — בלי כפתור, תווית או תגים. למקרא בחלון העזרה.
 * ⚠️ אותן מחלקות ואותו colorVars כמו המנורה בכרטיס, ולא ציור משלה: מקרא שמצויר
 * בנפרד היה ממשיך להראות את הצבע הישן ביום שמשנים את המנורה.
 */
export function LampSwatch({ state, area = "inspection" }) {
  return (
    <span className={`cl-swatch cl-lamp--${state}`} style={colorVars(state)} aria-hidden="true">
      <span className="cl-pill">
        <AreaIcon area={area} size={12} className="cl-icon" />
        <span className="cl-glyph">{GLYPH[state]}</span>
      </span>
    </span>
  );
}

function Lamp({ area, compliance, showText, nowIso, onOpen }) {
  const state = lampState(area, compliance);
  const stale = !!compliance?.stale && state !== "unknown";
  // ⚠️ compliance && — לא ?. בלבד: עבור null, `!null?.unknown` הוא true, ו-null.inspection
  // היה מפיל את כל רשת הכרטיסים. כל עזר ב-utils/compliance מתייחס ל-!c כ"לא נטען".
  const insp = area === "inspection" && compliance && !compliance.unknown ? compliance.inspection : null;
  const label = showText ? stateLabel(area, compliance) : "";
  // התווית כבר אומרת "ממתין לתסקיר נקי" כשהצהוב נובע מהמחזור — בלי שבב כפול
  const awaiting = isAwaiting(insp) && !label.includes("ממתין");
  const open = insp?.openDefects ?? 0;
  const notSubmitted = area === "pm" && draftStale(compliance, nowIso);

  return (
    <button
      type="button"
      className={`cl-lamp cl-lamp--${state}${stale ? " cl-lamp--stale" : ""}`}
      style={colorVars(state)}
      aria-label={lightAria(area, compliance, nowIso)}
      title={lightTitle(area, compliance, nowIso)}
      data-tab={area}
      onClick={(e) => {
        // ⚠️ הכרטיס כולו לחיץ (פותח את חלון האתר בלשונית הסקירה). בלי עצירה
        // הלחיצה על המנורה הייתה פותחת את הסקירה ולא את הלשונית שלה.
        e.stopPropagation();
        onOpen?.(area);
      }}
    >
      <span className="cl-pill">
        <AreaIcon area={area} size={12} className="cl-icon" />
        <span className="cl-glyph" aria-hidden="true">{GLYPH[state]}</span>
      </span>
      {open > 0 && (
        // ⚠️ תמיד ניטרלי — "למה העיגול אדום? זה מפריע" (בעלת המוצר, 06/10/2026)
        <span className="cl-badge" aria-hidden="true">
          {open}
        </span>
      )}
      {notSubmitted && <span className="cl-badge cl-badge--draft" aria-hidden="true">לא הוגש</span>}
      {showText && <span className="cl-label" aria-hidden="true">{label}</span>}
      {showText && awaiting && <span className="cl-await" aria-hidden="true">ממתין לנקי</span>}
    </button>
  );
}

/**
 * @param {object} props
 * @param {object|undefined} props.compliance — undefined במצב שרת → לא מצויר כלום
 * @param {"mini"|"compact"|"normal"|"expanded"} [props.density]
 * @param {(tab: "inspection"|"pm") => void} [props.onOpen]
 * @param {string} [props.nowIso] — לבדיקות; ברירת המחדל היא עכשיו
 */
export default function ComplianceLights({ compliance, density = "normal", onOpen, nowIso }) {
  // ⚠️ undefined בלבד, ולא כל ערך ריק: undefined = "המסלול הזה לא קיים"
  // (מצב שרת). {unknown:true} = "קיים ולא נטען" — ואז דווקא מציירים "?".
  const areas = useContext(LampAreasContext);
  if (compliance === undefined || areas.length === 0) return null;
  const now = nowIso ?? new Date().toISOString();
  const showText = density === "normal" || density === "expanded";
  return (
    <span className={`cl-lights cl-lights--${density}`} role="group" aria-label={areas.map((a) => AREA_NAME[a]).join(" ו")}>
      {/* ⚠️ מההקשר ולא רשימה קבועה: התחזוקה המונעת מוסתרת באתר החי, ובלוח — רק מה שנבחר בכותרת */}
      {areas.map((area) => (
        <Lamp key={area} area={area} compliance={compliance} showText={showText} nowIso={now} onOpen={onOpen} />
      ))}
    </span>
  );
}

/**
 * הסימן הקטן שליד נקודת המצב בכרטיס mini: הגרוע מבין שתי המנורות.
 * מצויר רק כשצריך לעשות משהו — צהוב, צהוב חזק, כתום, אדום או "?" (markVisible).
 * שחור-לבן, ירוק ואפור אינם מצוירים: ריבוע על כל כרטיס ברשת של 50 אתרים היה רק רעש.
 */
export function MiniMark({ compliance, onOpen, nowIso }) {
  const m = markFor(compliance, useContext(LampAreasContext));
  if (!markVisible(m)) return null;
  const now = nowIso ?? new Date().toISOString();
  return (
    <button
      type="button"
      className={`cl-mini cl-mini--${m.state}${m.stale ? " cl-lamp--stale" : ""}`}
      style={colorVars(m.state)}
      aria-label={lightAria(m.tab, compliance, now)}
      title={lightTitle(m.tab, compliance, now)}
      data-tab={m.tab}
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.(m.tab);
      }}
    >
      <span className="cl-mini-sq" aria-hidden="true">{GLYPH[m.state]}</span>
    </button>
  );
}
