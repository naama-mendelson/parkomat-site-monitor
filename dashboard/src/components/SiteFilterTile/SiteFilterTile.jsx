// components/SiteFilterTile/SiteFilterTile.jsx — ריבוע סינון בשורת המצבים.
//
// ============================================================
// למה ריבוע אחד עם שני בוררים, ולא שורה שנייה של צ'יפים
// ============================================================
// הניסיון הראשון היה שורת צ'יפים נפרדת מתחת למצבים. היא עבדה, והיא הוסיפה
// שורה שלמה למסך בשביל שני שדות שברוב הזמן מכוונים ל"הכל".
//
// ⚠️ **ריבוע אחד בשורה הקיימת מרוויח את המקום שלו רק אם הוא גם מראה מתי
// הוא פעיל.** בורר שמסנן בלי סימן גלוי הוא הדרך הבטוחה לגרום למישהו לחשוב
// שאתרים נעלמו. לכן הריבוע נצבע ומקבל מסגרת ברגע שנבחר בו משהו, בדיוק כמו
// כפתור מצב פעיל.
//
// ============================================================
// בורר יחיד לכל ממד — ולא בחירה מרובה
// ============================================================
// כפתורי המצב הם בחירה מרובה ("מוכן"+"מושבת" יחד). כאן זו בחירה יחידה,
// ובכוונה: שאלת הסוג היא "תראה לי את הדולי", לא "תראה לי דולי או מצבט".
// שני ממדים × בחירה יחידה נכנסים לרוחב של ריבוע; בחירה מרובה הייתה
// מחייבת תפריט נפתח, וזה כבר לא ריבוע בשורה.
import {
  SITE_TYPE_GROUPS, SITE_TYPES, GROUP_PREFIX, siteTypeGroup, matchesTypeValue,
} from "../../../../shared/site-types.mjs";
import { CONTROL_SYSTEMS } from "../../../../shared/control-systems.mjs";
import { TIER_OPTIONS, TIER_LABELS } from "../../utils/constants";
import "./SiteFilterTile.css";

// ⚠️ המפתח לאתרים בלי סוג. לא מחרוזת ריקה — היא כבר תפוסה ל"הכל", ומיזוגן
// היה הופך "אין סוג" ל"לא מסונן" בשקט.
export const NO_TYPE = "__none__";

// ⚠️ אותו כלל בדיוק למערכת שלא הוגדרה — ומפתח נפרד, כי "אין סוג" ו"אין
// מערכת" הם שני חוסרים שונים ואפשר שיהיו באותו אתר.
export const NO_SYSTEM = "__nosys__";

function SiteFilterTile({
  sites, typeFilter = "", systemFilter = "", tierFilter = "",
  onTypeChange, onSystemChange, onTierChange,
}) {
  // סופרים כדי להציג את המספר ליד כל אפשרות. בורר שמראה "מצבט" ומחזיר
  // רשימה ריקה נראה שבור; "מצבט (0)" אומר את האמת מראש.
  const typeCounts = { [NO_TYPE]: 0 };
  for (const t of SITE_TYPES) typeCounts[t.key] = 0;
  // מונה לכל משפחה — סכום הדגמים שלה.
  const groupCounts = Object.fromEntries(SITE_TYPE_GROUPS.map((g) => [g.key, 0]));
  const tierCounts = {};
  for (const t of TIER_OPTIONS) tierCounts[t] = 0;
  const systemCounts = { [NO_SYSTEM]: 0 };
  for (const s of CONTROL_SYSTEMS) systemCounts[s.key] = 0;

  for (const s of sites) {
    const k = s.plc_type || NO_TYPE;
    if (typeCounts[k] !== undefined) typeCounts[k]++;
    const g = siteTypeGroup(s.plc_type);
    if (g && groupCounts[g] !== undefined) groupCounts[g]++;
    if (tierCounts[s.tier] !== undefined) tierCounts[s.tier]++;
    const sys = s.control_system || NO_SYSTEM;
    if (systemCounts[sys] !== undefined) systemCounts[sys]++;
  }

  const active = Boolean(typeFilter || systemFilter || tierFilter);

  return (
    <div className={`filter-btn site-filter-tile ${active ? "active" : ""}`}>
      <select
        className="sft-select"
        value={typeFilter}
        onChange={(e) => onTypeChange(e.target.value)}
        aria-label="סינון לפי סוג מתקן"
      >
        <option value="">כל הסוגים</option>

        {/* ==========================================================
            שורת המשפחה היא **אפשרות נבחרת**, לא כותרת
            ==========================================================
            ⚠️ **וזו אינה בחירת עיצוב אלא מגבלה של HTML:** התווית של
            `<optgroup>` — הפס האפור — אינה ניתנת ללחיצה בשום דפדפן. היא
            כותרת ותו לא. לכן הגרסה הקודמת נאלצה להוסיף שורת "כל ה…" בתוך
            כל קבוצה, וזו בדיוק הכפילות שלא רצויה.
            כאן אין optgroup כלל: שורת המשפחה היא <option> שנראית ככותרת
            (רקע אפור, ללא הזחה) ו**נבחרת** — לחיצה עליה מציגה את כל דגמיה.

            ⚠️ משפחה עם דגם יחיד מקבלת **שורה אחת בלבד.** "דולי" ו"דולי"
            זו מתחת לזו הן אותה תוצאה פעמיים; השורה היחידה נושאת את מפתח
            הדגם, שהוא ממילא שקול לסינון המשפחה כשיש רק אחד. */}
        {SITE_TYPE_GROUPS.map((g) => {
          const single = g.types.length === 1;
          return [
            <option
              // ⚠️ קידומת `grp-` — **מפתח המשפחה ומפתח הדגם זהים.** "XY" הוא
              // גם שם משפחה וגם שם דגם, וכך גם "דולי", ולכן React קיבל שני
              // ילדים באותו key. האזהרה בקונסולה אינה קוסמטית: React מזהה
              // ילדים לפי key, ושני ילדים באותו מפתח עלולים להתמזג או להיעלם
              // בעדכון — כלומר אפשרות שנעלמת מהבורר בלי סיבה נראית.
              key={`grp-${g.key}`}
              value={single ? g.types[0].key : `${GROUP_PREFIX}${g.key}`}
              className="sft-group-row"
            >
              {g.label} ({groupCounts[g.key]})
            </option>,
            // ⚠️ ההזחה היא רווחים קשיחים ולא CSS: דפדפנים אינם מכבדים
            // padding על <option> ברשימה הנפתחת של מערכת ההפעלה.
            ...(single ? [] : g.types.map((t) => (
              <option key={t.key} value={t.key}>
                {"   "}{t.label} ({typeCounts[t.key]})
              </option>
            ))),
          ];
        })}

        {/* ⚠️ מוצג רק כשיש כאלה — אבל היום זה **כל** האתרים, כי כולם נרשמו
            לפני שהשדה נוסף. זו רשימת המטלות למילוי הסוג, לא רעש. */}
        {typeCounts[NO_TYPE] > 0 && (
          <option value={NO_TYPE}>לא הוגדר ({typeCounts[NO_TYPE]})</option>
        )}
      </select>

      {/* ==========================================================
          ⚠️ המערכת היא בורר נפרד, ולא עוד שורות בתוך "סוגים"
          ==========================================================
          אותו סוג אצל שני יצרנים הוא שתי מכונות שונות — זו הסיבה שהשדה
          נוסף מלכתחילה (17/09/2026). אילו המערכת הייתה עוד אפשרות ברשימת
          הסוגים, בחירה אחת הייתה מבטלת את השנייה, ו"XY של ביטנקם" —
          בדיוק השאלה שבגללה השדה קיים — לא הייתה ניתנת לשאילה. */}
      <select
        className="sft-select"
        value={systemFilter}
        onChange={(e) => onSystemChange(e.target.value)}
        aria-label="סינון לפי מערכת הפעלה"
      >
        <option value="">כל המערכות</option>
        {CONTROL_SYSTEMS.map((s) => (
          <option key={s.key} value={s.key}>{s.key} ({systemCounts[s.key]})</option>
        ))}
        {/* ⚠️ מוצג רק כשיש כאלה. היום אין — כל 37 האתרים מולאו — ולכן
            שורה קבועה כאן הייתה רעש שמלמד להתעלם מהרשימה. */}
        {systemCounts[NO_SYSTEM] > 0 && (
          <option value={NO_SYSTEM}>לא הוגדר ({systemCounts[NO_SYSTEM]})</option>
        )}
      </select>

      <select
        className="sft-select"
        value={tierFilter}
        onChange={(e) => onTierChange(e.target.value)}
        aria-label="סינון לפי רמת שירות"
      >
        <option value="">כל הרמות</option>
        {TIER_OPTIONS.map((t) => (
          <option key={t} value={t}>{TIER_LABELS[t]} ({tierCounts[t] || 0})</option>
        ))}
      </select>

      <span className="sft-caption">סוג, מערכת ורמה</span>
    </div>
  );
}

/**
 * האם האתר עובר את שני הסינונים.
 *
 * ⚠️ מיוצא כדי שהריבוע והתצוגה יסכימו על הכלל — ובעיקר על אתר בלי סוג,
 * שהוא כרגע המקרה של כל 13 האתרים.
 */
export function matchesSiteFilters(site, typeFilter, tierFilter, systemFilter = "") {
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
  return true;
}

export default SiteFilterTile;
