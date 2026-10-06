// components/Compliance/ComplianceLights.jsx — שתי המנורות בכרטיס: בודק מוסמך ותחזוקה מונעת.
//
// רכיב תצוגה טהור: מקבל את אובייקט ה-compliance (utils/compliance.js →
// toCompliance) ואינו יודע מאיפה הוא הגיע. אין כאן קריאה לשרת ואין כאן סף —
// הצבע הוחלט ב-SQL, וכאן רק מציירים אותו.
//
// ============================================================
// ⚠️ הצבע לעולם אינו הסימן היחיד
// ============================================================
// כל מנורה נושאת אייקון תחום (לוח עם וי / מפתח ברג) וגליף מצב (✓ ! ✕ ○ ?).
// מנורה אדומה ומנורה ירוקה נבדלות גם בשחור-לבן, וגם למי שאינו מבחין בין
// אדום לירוק.
//
// ⚠️ ומנורה **לא נעלמת** כשהסטטוס לא נטען. היא הופכת ל-"?" מקווקו. מנורה
// חסרה נראית בדיוק כמו "אין מה לדווח" — וזה הלקח של 17/09, כשהמסך הפסיק
// להתעדכן חמישה ימים בלי שאיש שם לב.
import { COMPLIANCE_COLORS } from "../../utils/constants";
import {
  COMPLIANCE_AREAS, GLYPH, PM_ENABLED, draftStale, isAwaiting, lampState, lightAria, lightTitle, markFor, markVisible,
  stateLabel,
} from "../../utils/compliance";
import { AreaIcon } from "./icons";
import "./ComplianceLights.css";


function colorVars(state) {
  const c = COMPLIANCE_COLORS[state];
  // ⚠️ רקע שקוף (bg, 8–10%) ולא הצבע המלא (dot): "זה אדום מדי חזק, תעשה את זה יותר
  // שקוף" (בעלת המוצר, 06/10/2026 — כשכל 60 האתרים נעשו אדומים), ואחר כך "עדיין מדי
  // חזק" — ולכן גם המסגרת חצי-שקופה. הצבע נושא רק הסימן.
  return c ? { "--cl-fill": c.bg, "--cl-border": c.border } : undefined;
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
  const overdue = insp?.overdueDefects ?? 0;
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
        <span className={`cl-badge${overdue > 0 ? " cl-badge--overdue" : ""}`} aria-hidden="true">
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
  if (compliance === undefined) return null;
  const now = nowIso ?? new Date().toISOString();
  const showText = density === "normal" || density === "expanded";
  return (
    <span className={`cl-lights cl-lights--${density}`} role="group" aria-label={PM_ENABLED ? "בודק מוסמך ותחזוקה מונעת" : "בודק מוסמך"}>
      {/* ⚠️ COMPLIANCE_AREAS ולא רשימה קבועה: התחזוקה המונעת מוסתרת באתר החי (utils/compliance) */}
      {COMPLIANCE_AREAS.map((area) => (
        <Lamp key={area} area={area} compliance={compliance} showText={showText} nowIso={now} onOpen={onOpen} />
      ))}
    </span>
  );
}

/**
 * הסימן הקטן שליד נקודת המצב בכרטיס mini: הגרוע מבין שתי המנורות.
 * מצויר רק לצהוב, אדום או "?" — ירוק ואפור אינם דורשים תשומת לב, וריבוע
 * ירוק על כל כרטיס ברשת של 50 אתרים היה רק רעש.
 */
export function MiniMark({ compliance, onOpen, nowIso }) {
  const m = markFor(compliance);
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
