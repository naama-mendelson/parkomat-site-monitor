// components/SiteFilterTile/SiteFilterTile.jsx — ארבעת אריחי "מידע" בכותרת: סוג, מערכת, סוג שירות, מעלית.
//
// ⚠️ **אריח מרוויח את המקום שלו רק אם הוא גם מראה מתי הוא פעיל.** בורר שמסנן בלי סימן גלוי הוא הדרך הבטוחה לגרום
// למישהו לחשוב שאתרים נעלמו. לכן אריח שנבחר בו משהו נצבע ומקבל מסגרת, בדיוק כמו כפתור מצב פעיל, ומראה את הבחירה ואת
// מספר האתרים שלה.
//
// ⚠️ **בחירה יחידה לכל ממד — ולא בחירה מרובה.** כפתורי המצב הם בחירה מרובה ("מוכן"+"מושבת" יחד). כאן ובכוונה לא:
// שאלת הסוג היא "תראה לי את הדולי", לא "תראה לי דולי או מצבט".
import {
  SITE_TYPE_GROUPS, SITE_TYPES, GROUP_PREFIX, siteTypeGroup, matchesTypeValue,
} from "../../../../shared/site-types.mjs";
import { CONTROL_SYSTEMS } from "../../../../shared/control-systems.mjs";
import { LIFT_TYPES, NO_LIFT, matchesLiftFilter, siteLifts } from "../../../../shared/lift-types.mjs";
import { TIER_OPTIONS, TIER_LABELS, TIER_UNLINKED, TIER_BOARD_STATES } from "../../utils/constants";
import FilterPicker from "../ComplianceFilters/FilterPicker";
import "./SiteFilterTile.css";

// ⚠️ "לא חובר" ומצבי הרמזור נספרים ונבחרים כאן, אף שאינם דרגה: בלעדיהם אתר
// כזה לא היה נספר תחת אף רמה — סכום המונים היה קטן ממספר האתרים — ולא הייתה
// דרך למצוא את האתרים שעוד צריך לחבר לרמזור.
const TIER_FILTER = [...TIER_OPTIONS, TIER_UNLINKED, ...TIER_BOARD_STATES];

// ⚠️ המפתח לאתרים בלי סוג. לא מחרוזת ריקה — היא כבר תפוסה ל"הכל", ומיזוגן
// היה הופך "אין סוג" ל"לא מסונן" בשקט.
export const NO_TYPE = "__none__";

// ⚠️ אותו כלל בדיוק למערכת שלא הוגדרה — ומפתח נפרד, כי "אין סוג" ו"אין
// מערכת" הם שני חוסרים שונים ואפשר שיהיו באותו אתר.
export const NO_SYSTEM = "__nosys__";

function SiteFilterTile({
  sites, typeFilter = "", systemFilter = "", tierFilter = "", liftFilter = "",
  onTypeChange, onSystemChange, onTierChange, onLiftChange,
}) {
  // סופרים כדי להציג את המספר ליד כל אפשרות. בורר שמראה "מצבט" ומחזיר
  // רשימה ריקה נראה שבור; "מצבט (0)" אומר את האמת מראש.
  const typeCounts = { [NO_TYPE]: 0 };
  for (const t of SITE_TYPES) typeCounts[t.key] = 0;
  // מונה לכל משפחה — סכום הדגמים שלה.
  const groupCounts = Object.fromEntries(SITE_TYPE_GROUPS.map((g) => [g.key, 0]));
  const tierCounts = {};
  for (const t of TIER_FILTER) tierCounts[t] = 0;
  const systemCounts = { [NO_SYSTEM]: 0 };
  for (const s of CONTROL_SYSTEMS) systemCounts[s.key] = 0;
  const liftCounts = { [NO_LIFT]: 0 };
  for (const l of LIFT_TYPES) liftCounts[l.key] = 0;

  for (const s of sites) {
    const k = s.plc_type || NO_TYPE;
    if (typeCounts[k] !== undefined) typeCounts[k]++;
    const g = siteTypeGroup(s.plc_type);
    if (g && groupCounts[g] !== undefined) groupCounts[g]++;
    if (tierCounts[s.tier] !== undefined) tierCounts[s.tier]++;
    const sys = s.control_system || NO_SYSTEM;
    if (systemCounts[sys] !== undefined) systemCounts[sys]++;
    // ⚠️ אתר אחד נספר פעם אחת לכל סוג, גם כששתי המעליות שלו מאותו סוג — כמו הסינון, שמחזיר אותו פעם אחת
    const lifts = [...new Set(siteLifts(s).map((l) => l.type))];
    if (lifts.length === 0) liftCounts[NO_LIFT]++;
    for (const t of lifts) if (liftCounts[t] !== undefined) liftCounts[t]++;
  }

  // ============================================================
  // ⚠️ ארבעה אריחים כמו המצבים, כל אחד נפתח לרשימה מעוצבת (19/10/2026)
  // ============================================================
  // בעלת המוצר, על הרשימה של <select> (מצוירת על ידי מערכת ההפעלה, לבנה-כחולה): "תעצב את זה יותר מודרני ויפה", ו"את כל
  // הסוגים, כל המערכות, כל הרמות, כל המעליות — תעשה כמו שעושים עם המצבים". עד אז ריבוע אחד עם ארבעה <select>. עכשיו —
  // ארבעה אריחים (מספר גדול + שם), FilterPicker כמו "בודק מוסמך" ו"משימות": בחירה אחת, ✓, חיצים/Enter/Esc. האפשרויות,
  // הספירות והכללים (משפחה כשורה נבחרת, "לא הוגדר" רק כשיש או כשנבחר) — אותם כמו ב-<select> שהיה.
  const total = sites.length;
  const typeItems = [{ value: "", label: "כל הסוגים", n: total, mark: "" }];
  for (const g of SITE_TYPE_GROUPS) {
    const single = g.types.length === 1;
    typeItems.push({ value: single ? g.types[0].key : `${GROUP_PREFIX}${g.key}`, label: g.label, n: groupCounts[g.key], mark: "", cls: "info-family" });
    if (!single) for (const t of g.types) typeItems.push({ value: t.key, label: t.label, n: typeCounts[t.key], mark: "", cls: "info-sub" });
  }
  if (typeCounts[NO_TYPE] > 0 || typeFilter === NO_TYPE) typeItems.push({ value: NO_TYPE, label: "לא הוגדר", n: typeCounts[NO_TYPE], mark: "" });
  const systemItems = [{ value: "", label: "כל המערכות", n: total, mark: "" },
    ...CONTROL_SYSTEMS.map((c) => ({ value: c.key, label: c.key, n: systemCounts[c.key], mark: "" }))];
  if (systemCounts[NO_SYSTEM] > 0 || systemFilter === NO_SYSTEM) systemItems.push({ value: NO_SYSTEM, label: "לא הוגדר", n: systemCounts[NO_SYSTEM], mark: "" });
  const tierItems = [{ value: "", label: "כל הרמות", n: total, mark: "" },
    ...TIER_FILTER.filter((t) => TIER_OPTIONS.includes(t) || tierCounts[t] > 0 || tierFilter === t)
      .map((t) => ({ value: t, label: TIER_LABELS[t], n: tierCounts[t] || 0, mark: "" }))];
  const liftItems = [{ value: "", label: "כל המעליות", n: total, mark: "" },
    ...LIFT_TYPES.map((l) => ({ value: l.key, label: l.label, n: liftCounts[l.key], mark: "" }))];
  if (liftCounts[NO_LIFT] > 0 || liftFilter === NO_LIFT) liftItems.push({ value: NO_LIFT, label: "לא הוגדר", n: liftCounts[NO_LIFT], mark: "" });

  const tile = (key, cls, dim, aria, value, items, onChange) => {
    const cur = items.find((it) => it.value === value) ?? items[0];
    const chosen = value !== "" && cur.value === value;
    return (
      <FilterPicker key={key} items={items} current={value} onPick={onChange} menuLabel={aria}
        btnClass={`info-tile ${cls}${chosen ? " active" : ""}`}
        ariaLabel={`${aria} — ${chosen ? `${cur.label} (${cur.n})` : items[0].label}`}
        head={(open) => (
          <>
            <span className="filter-count">{chosen ? cur.n : total}</span>
            <span className="filter-label cf-name">
              {chosen ? cur.label : items[0].label}
              <span className={`cf-chevron${open ? " is-open" : ""}`} aria-hidden="true">▾</span>
            </span>
            {chosen && <span className="cf-sub">{dim}</span>}
          </>
        )}
      />
    );
  };

  return (
    <>
      {tile("type", "sft-type", "סוג", "סינון לפי סוג מתקן", typeFilter, typeItems, onTypeChange)}
      {/* ⚠️ המערכת נפרדת מהסוג: אותו סוג אצל שני יצרנים הוא שתי מכונות שונות — "XY של ביטנקם" חייב להיות שאילה אחת */}
      {tile("system", "sft-system", "מערכת", "סינון לפי מערכת הפעלה", systemFilter, systemItems, onSystemChange)}
      {tile("tier", "sft-tier", "סוג שירות", "סינון לפי רמת שירות", tierFilter, tierItems, onTierChange)}
      {onLiftChange && tile("lift", "sft-lift", "מעלית", "סינון לפי סוג מעלית", liftFilter, liftItems, onLiftChange)}
    </>
  );
}

/**
 * האם האתר עובר את שני הסינונים.
 *
 * ⚠️ מיוצא כדי שהריבוע והתצוגה יסכימו על הכלל — ובעיקר על אתר בלי סוג,
 * שהוא כרגע המקרה של כל 13 האתרים.
 */
export function matchesSiteFilters(site, typeFilter, tierFilter, systemFilter = "", liftFilter = "") {
  // ⚠️ "לא הוגדר" מטופל כאן ולא ב-matchesTypeValue: הוא אינו סוג אלא
  // **היעדר** סוג, והכנסתו לרשימת הסוגים המשותפת הייתה הופכת אותו לערך
  // שאפשר לשמור במסד.
  if (typeFilter === NO_TYPE) {
    if (site.plc_type) return false;
  } else if (!matchesTypeValue(site.plc_type, typeFilter)) {
    return false;
  }
  // ⚠️ אותו טיפול כמו ב"לא הוגדר" של הסוג, ומאותו נימוק: היעדר מערכת אינו
  // מערכת בשם "ריק", והשוואה רגילה הייתה מסננת אותו החוצה בשקט.
  if (systemFilter === NO_SYSTEM) {
    if (site.control_system) return false;
  } else if (systemFilter && site.control_system !== systemFilter) {
    return false;
  }
  if (tierFilter && site.tier !== tierFilter) return false;
  if (!matchesLiftFilter(site, liftFilter)) return false;
  return true;
}

export default SiteFilterTile;
