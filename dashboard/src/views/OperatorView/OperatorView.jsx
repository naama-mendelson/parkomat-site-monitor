// views/OperatorView/OperatorView.jsx — דשבורד הבקר: ניטור שוטף של כלל האתרים.
// הועבר מ-App.jsx ללא שינוי התנהגות; הסינון והחיפוש מגיעים מה-Header.
import { useMemo } from "react";
import SiteGrid from "../../components/SiteGrid/SiteGrid";
import { LampAreasContext } from "../../components/Compliance/ComplianceLights";
import { matchesSiteFilters } from "../../components/SiteFilterTile/SiteFilterTile";
import { fuzzyMatch } from "../../utils/helpers";
import { makeCompareSites } from "../../utils/sortSites";
import { useServiceCalls } from "../../components/ServiceCalls/ServiceCallsContext";
import { DEFAULT_COMPLIANCE_VIEW, lampAreasFor, matchesComplianceView } from "../../utils/compliance";
import { matchesBoardKind, DEFAULT_SITE_KIND, SITE_KIND_MULTIPLIERS } from "../../utils/multipliers";
import { matchesRepeatView, compareByRepeat } from "../../utils/repeatFaults";
import { DEFAULT_TASKS_VIEW, matchesTasksView } from "../../utils/tasks";
import { matchesOpenCallsView } from "../../utils/serviceCalls";
import "./OperatorView.css";

function OperatorView({
  sites, loading, error, onRetry, activeFilters = [], typeFilter = "", systemFilter = "", tierFilter = "", liftFilter = "",
  complianceView = DEFAULT_COMPLIANCE_VIEW, siteKind = DEFAULT_SITE_KIND, showRepeat = false, tasksView = DEFAULT_TASKS_VIEW, taskCounts = null,
  searchQuery, onSiteClick,
}) {
  // ⚠️ לפני ה-return המוקדמים — hook חייב לרוץ בכל רינדור. ומערך יציב: בלעדי useMemo, כל רינדור
  // של הלוח היה נותן ערך חדש להקשר ומרנדר מחדש את כל המנורות בכל הכרטיסים.
  const lampAreas = useMemo(() => lampAreasFor(complianceView), [complianceView]);
  const calls = useServiceCalls();

  // ============================================================
  // ⚠️ שגיאה **אינה** מוחקת מסך שיש בו נתונים
  // ============================================================
  // כאן היה `if (error)` יחיד, והוא היה היחיד מבין שלוש התצוגות שמתנהג כך:
  // SupervisorView ו-ExecutiveView שניהם בודקים `error && !data`. התוצאה
  // בפועל — תקלת רשת חולפת אחת החליפה 13 כרטיסי אתר תקינים, שכבר היו
  // בזיכרון, בשורה אדומה אחת. הנתונים לא אבדו; רק הסירוב להציג אותם.
  //
  // ⚠️ אבל **לא פשוט להסתיר את השגיאה.** בדיוק מזה מזהיר ההערה ב-App.jsx:
  // "מסך שנראה תקין ומשקר" הוא הכשל הגרוע ביותר במסך ניטור. לכן הנתונים
  // נשארים, והשגיאה עוברת לפס עליון שאומר במפורש שהמוצג אינו טרי.
  if (loading && sites.length === 0) return <div className="app-loading">טוען אתרים...</div>;
  // ⚠️ **כפתור, ולא רק הודעה.** מסך ריק שאומר "שגיאה" ואינו מציע דבר
  // גורר רענון ידני של הדף — ורענון מאבד את הסינון, את הגלילה ואת
  // התצוגה שנבחרה. ניסיון חוזר במקום עולה לחיצה אחת ואינו מאבד כלום.
  if (error && sites.length === 0) {
    return (
      <div className="app-error">
        <div>{error}</div>
        <button className="app-error-retry" onClick={onRetry}>נסה שוב</button>
      </div>
    );
  }

  const callsMode = calls?.show === true;
  const filtered = sites.filter((site) => {
    // רשימה ריקה = בלי סינון. אחרת: האתר צריך להיות באחד מהמצבים שנבחרו.
    // ⚠️ **`displayStatus` ולא `status`** — אותו ערך שהצ'יפ על הכרטיס
    // מציג. באתר דו-מערכתי `status` הוא המצב של המערכת הטובה (זה
    // שמחשב זמינות), והצ'יפ מציג את הגרועה; סינון לפי `status` היה
    // מסתיר מ"תחזוקה" אתר שכתוב עליו "תחזוקה" — כלומר הסרגל והכרטיס
    // היו סותרים זה את זה על אותו מסך.
    const shown = site.displayStatus ?? site.status;
    // "רובוטיים" / "מכפילים" בכותרת (19/10/2026): רק הסוג שנבחר בלוח, בשום סינון אחר — אין מצב של שניהם יחד.
    // ⚠️ חוץ מ"קריאות פתוחות" לחוץ: אז כל אתר עם קריאה פתוחה, משני הסוגים (בעלת המוצר, 19/10/2026).
    if (!matchesBoardKind(site, siteKind, callsMode)) return false;
    // "תקלות חוזרות" (19/10/2026): לחוץ — רק אתרים עם הסימון ↻
    if (!matchesRepeatView(site, showRepeat)) return false;
    // ⚠️ אתר בלי בקר מחובר (07/10/2026) אינו בשום מצב: מופיע ב"הכל", ולא בסינון לפי מצב —
    // אחרת "אין תקשורת" היה מראה אותו, כי זה מה שנשאר במסד כברירת מחדל.
    // ⚠️ ובלוח "מכפילים" מסנן המצב אינו חל (הסקירה של 19/10/2026): למכפיל אין מצב, ו"בתקלה" שנשאר מסומן היה מרוקן את הלוח.
    // ⚠️ וכש"קריאות פתוחות" מביא גם מכפילים — המצב חל רק על הרובוטיים; מכפיל עם קריאה פתוחה עובר.
    // ⚠️ ובמצב הזה המצב חל גם כשהסוג השמור הוא מכפילים (הסקירה של 19/10) — אותו תנאי כמו statusApplies בכותרת.
    if ((callsMode || siteKind !== SITE_KIND_MULTIPLIERS) && activeFilters.length > 0) {
      if (site.monitored === false) { if (!callsMode) return false; }
      else if (!activeFilters.includes(shown)) return false;
    }
    // ⚠️ הכלל עצמו חי ב-SiteFilterTile ומיוצא — כך הסרגל והתצוגה מסכימים על
    // מה קורה עם אתר בלי סוג, במקום להגדיר את זה פעמיים.
    if (!matchesSiteFilters(site, typeFilter, tierFilter, systemFilter, liftFilter)) return false;
    // "בודק מוסמך" בכותרת — מצטלב עם המצב והסוג ("וגם"). ⚠️ אתר בלי בקר **כן** נכלל כאן:
    // בשבילו הוא קיים במערכת (בודק, תחזוקה ומשימות).
    if (!matchesComplianceView(site, complianceView)) return false;
    // "משימות" בכותרת (18/10/2026): "כל הפתוחות" או סוג — רק אתרים עם משימה פתוחה כזו. ⚠️ כל עוד המספרים לא נטענו
    // (taskCounts null) — לא מסננים: אחרת הלוח מתרוקן לרגע בכל טעינה, ונשאר ריק אם השאלה נכשלה.
    if (taskCounts && !matchesTasksView(taskCounts[site.id], tasksView)) return false;
    // "קריאות פתוחות" בכותרת (18/10/2026): לחוץ — רק אתרים עם קריאה פתוחה. `calls` null (כבוי / עוד לא נטען) — לא מסננים.
    if (calls && !matchesOpenCallsView(calls.bySite[site.id], calls.show)) return false;
    if (searchQuery && !fuzzyMatch(`${site.site_name} ${site.code}`, searchQuery)) return false;
    return true;
  });

  // ⚠️ אתר עם קריאה פתוחה בוויזנט עולה מיד אחרי המצב (בעלת המוצר, 14/10/2026). בינארי.
  // ⚠️ `calls` הוא null כשהתכונה כבויה או שהספירה עוד לא נטענה — ואז מתקבל בדיוק הסדר הקודם,
  // ולא רשת שמתהפכת ברגע שהספירה מגיעה בלי שאיש הבין למה.
  // ⚠️ **בלי useMemo כאן, בכוונה:** השורה הזו יושבת אחרי ה-return המוקדמים של טעינה/שגיאה (33, 37),
  // והוק שם נקרא בתנאי. וממילא `filtered` הוא מערך חדש בכל רינדור, כך שאין מה לשמר.
  // ⚠️ 18/10/2026: רק כש"קריאות פתוחות" לחוץ. לא לחוץ — לא רואים קריאות, אז קריאה גם לא מקדמת אתר: סדר שזז בגלל דבר
  // שאינו על המסך נראה אקראי.
  const byPriority = makeCompareSites(calls?.show ? (s) => calls.bySite[s.id]?.open ?? 0 : null);
  // "תקלות חוזרות" לחוץ (19/10/2026) — המספר על ↻ הוא המפתח הראשון, הגבוה ביותר קודם; לא לחוץ — הסדר הרגיל.
  const ordered = [...filtered].sort(showRepeat === true ? compareByRepeat(byPriority) : byPriority);

  return (
    <div className="operator-view">
      {/* ⚠️ הפס נשאר עד שהשליפה הבאה מצליחה — הוא אינו מודעה חולפת אלא
          מצב. רענון רץ כל 60 שניות, ולכן הוא נעלם מעצמו כשהרשת חוזרת. */}
      {error && (
        <div className="op-stale" role="status">
          ⚠️ העדכון האחרון נכשל — ייתכן שהמוצג אינו מעודכן
          <span className="op-stale-detail">{error}</span>
        </div>
      )}
      {/* רק תחום שנבחר בו משהו בכותרת — הנורה שלו מצוירת בכרטיסים של הלוח (ורק שם: טבלת המפקח לא מושפעת) */}
      <LampAreasContext.Provider value={lampAreas}>
        <SiteGrid sites={ordered} onSiteClick={onSiteClick} />
      </LampAreasContext.Provider>
    </div>
  );
}

export default OperatorView;
