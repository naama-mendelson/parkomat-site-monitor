// components/Header/Header.jsx — Header עליון: לוגו, בורר תפקיד, חיפוש, dark/light
import { useEffect, useState } from "react";
import PushSettings from "../PushSettings/PushSettings";
import HelpPanel from "../HelpPanel/HelpPanel";
// ⚠️ **התראות push אינן קיימות במחשב — לא מוסתרות, פשוט לא נבנות.**
// זו בקשת המשתמשת, ויש לה נימוק: התראה למחשב שפתוח על הדשבורד ממילא היא
// כפילות של הצליל שכבר יש שם. וגם באייפון ההרשאה זמינה **רק** באפליקציה
// מותקנת, ולכן כפתור בלשונית היה מבטיח מה שלא יכול לקרות.
//
// ⚠️ ואין לבלבל עם התראת הקול: היא עובדת בכל מקום שבו האפליקציה פתוחה,
// כולל במחשב, והיא אינה נוגעת לזה כלל.
import { isInstalledApp } from "../../services/pushDirect";
import SiteFilterTile from "../SiteFilterTile/SiteFilterTile";
import StatusFilters from "../StatusFilters/StatusFilters";
import FilterGroup from "../FilterGroup/FilterGroup";
import { STATUS_LABELS } from "../../utils/constants";
import ComplianceFilters from "../ComplianceFilters/ComplianceFilters";
import TasksFilter from "../TasksFilter/TasksFilter";
import { tasksViewActive } from "../../utils/tasks";
import { countSitesWithOpenCalls } from "../../utils/serviceCalls";
import { countMultipliers, countRobotic, matchesBoardKind, nextSiteKind, DEFAULT_SITE_KIND, SITE_KIND_ROBOTIC, SITE_KIND_MULTIPLIERS } from "../../utils/multipliers";
import { countRepeatSites } from "../../utils/repeatFaults";
import { complianceActiveCount } from "../../utils/compliance";
import SearchBar from "../SearchBar/SearchBar";
import RoleSwitcher from "../RoleSwitcher/RoleSwitcher";
import AlertBell from "../AlertBell/AlertBell";
import UsersPanel from "../UsersPanel/UsersPanel";
import FieldReports from "../FieldReports/FieldReports";
import { useDirect } from "../../services/dataSource";
import AccountMenu from "../AccountMenu/AccountMenu";
import { useAuth } from "../../hooks/useAuth";
import "./Header.css";

function Header({
  sites,
  role,
  onRoleChange,
  activeFilters,
  typeFilter,
  onTypeFilterChange,
  systemFilter,
  onSystemFilterChange,
  tierFilter,
  onTierFilterChange,
  liftFilter = "",
  onLiftFilterChange,
  onFilterChange,
  searchQuery,
  onSearchChange,
  darkMode,
  onToggleDarkMode,
  onAdmin,
  complianceView,
  onComplianceViewChange,
  siteKind = DEFAULT_SITE_KIND,   // "רובוטיים" / "מכפילים" — תמיד אחד מהם בלוח (בעלת המוצר, 19/10/2026)
  onSiteKindChange,
  showRepeat = false,             // "תקלות חוזרות" — לחוץ: רק אתרים עם הסימון ↻ (19/10/2026)
  onShowRepeatChange,
  tasksView,
  onTasksViewChange,
  taskCounts = null,
  showOpenCalls,
  onShowOpenCallsChange,
  callCounts = null,
}) {
  // החיפוש והפילטרים הם כלי עבודה של הבקר. למנהל הבקרה יש חיפוש/סינון
  // משלו בתוך הטבלה, ולמנהל הכללי אין בהם צורך — אז הם לא מוצגים שם.
  const isOperator = role === "operator";   // ⚠️ role כאן הוא התצוגה (בקר / מנהל בקרה / מנהל כללי), לא תפקיד המשתמש
  // מסך המשתמשים — מנהל בלבד (19/10/2026: "הוספת משתמשים ומחיקת משתמשים" אינן של עורך; list_users דוחה ממילא)
  const { user: me } = useAuth();
  const isUserManager = me?.role === "manager";

  // ניהול האתרים (הוספה/עריכה/מחיקה) פתוח רק למנהל בקרה ומנהל כללי.
  // הבקר מנטר בלבד. השרת אוכף את זה גם הוא — הסתרה ב-UI אינה אבטחה.
  const canManage = role === "supervisor" || role === "executive";

  // צירוף משתמשים פתוח לכל מי שמחובר (החלטת מוצר), ולכן הכפתור אינו תלוי
  // בתפקיד — בשונה מ"ניהול אתרים" שמעליו. השרת הוא שאוכף בשני המקרים
  // (requireAuth ב-api/routes.js); הסתרה ב-UI אינה אבטחה.
  const [usersOpen, setUsersOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);

  // ⚠️ נפתח גם מהחלון הקופץ של דיווח חדש. אירוע חלון ולא prop: הרכיב
  // שם יושב ב-App, וזה ב-Header — השחלת callback בין שני עצים היא צימוד
  // שאין בו צורך.
  // ⚠️ המזהה נשמר, לא רק הפתיחה: בלעדיו החלונית נפתחת ולא ברור על
  // מה בדיוק לחצו, ומי שיש לו עשרים דיווחים בתיבה מחפש אותו ביד.
  const [openReportId, setOpenReportId] = useState(null);

  useEffect(() => {
    const open = (e) => {
      setOpenReportId(e?.detail?.reportId ?? null);
      setReportsOpen(true);
    };
    window.addEventListener('parkomat:open-reports', open);
    return () => window.removeEventListener('parkomat:open-reports', open);
  }, []);

  // ============================================================
  // ⚠️ בטלפון השדר תפס יותר מחצי המסך
  // ============================================================
  // נמדד: ~490px מתוך 850 — הלוגו, החיפוש, שישה מוני סטטוס ושתי רשימות
  // סינון, לפני שנראה ולו כרטיס אחד. בשולחן העבודה זה נכון: הכול נגיש
  // במבט. בטלפון זה הופך את המסך הראשי למסך סינון.
  //
  // ⚠️ **מקופל ולא מוסתר.** המונים הם גם הפילטרים — הסתרתם הייתה מוחקת
  // יכולת, לא רק תצוגה. הכפתור אומר כמה פילטרים פעילים, כדי שמצב מסונן
  // לא ייראה כמו רשימה חלקית בלי סיבה.
  // ⚠️ נפתח מכפתור ולא קופץ מעצמו: לדפדפן יש הזדמנות אחת לבקש הרשאה,
  // ומי שיחסום כי לא הבין — לא נוכל לשאול אותו שוב לעולם.
  const [pushOpen, setPushOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // ============================================================
  // ההזמנה — פעם אחת, בכניסה השנייה
  // ============================================================
  // ⚠️ **בניתי את הפאנל ולא את הדרך אליו, וזה היה פער אמיתי:** אף אחד
  // לא מחפש כפתור חדש בשדר. תכונה שאיש אינו מגלה שווה כמו תכונה שאינה.
  //
  // ⚠️ ובכניסה **השנייה** ולא הראשונה, וזו לא העדפת נוחות: לדפדפן יש
  // הזדמנות אחת לבקש הרשאה. מי שיראה את זה לפני שהבין מה המערכת עושה
  // ילחץ "חסום" — ואז **אי אפשר לשאול אותו שוב לעולם**.
  //
  // ⚠️ ופעם אחת בלבד. באנר שחוזר בכל כניסה הוא מה שמלמד ללחוץ "לא"
  // אוטומטית, וכך גם על הבקשה האמיתית.
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    // ⚠️ וההזמנה גם היא לא קופצת במחשב: פאנל שמסביר שצריך להתקין הוא
    // בדיוק ה"אזכור" שהתבקש לא להיות שם.
    if (!isInstalledApp()) return;
    // רק מי שטרם נשאל. "denied" ו-"granted" אינם מקרה להזמנה.
    if (Notification.permission !== "default") return;
    // ⚠️ **חוזר עד שיש החלטה, ולא פעם אחת.** קודם סימנתי "הוזמן" וזהו —
    // אבל מי שסגר את החלון בלי לבחור פשוט לא קיבל התראות ולא ידע למה.
    // עכשיו נשמרת רק **החלטה מפורשת**: אישור, או "לא, תודה".
    //
    // ⚠️ וזה בטוח: Notification.permission נשאר 'default' כל עוד לא נשאל,
    // ולכן מי שאישר או חסם כבר יצא בשומר שמעל ואינו רואה את זה שוב.
    if (localStorage.getItem("push-declined") === "1") return;

    // ============================================================
    // ⚠️ מי שכבר מחובר — נשאל **מיד**, ולא בכניסה השנייה
    // ============================================================
    // הספירה נבנתה כדי לא לשאול מישהו לפני שהבין מה המערכת עושה. **מי
    // שמשתמש בה שבועות כבר מבין** — והוא גם אינו עובר יותר בטופס
    // ההתחברות, כי ה-session שמור. כלומר ההשהיה הייתה דוחה בדיוק את מי
    // שאין סיבה לדחות, ולטעינה נוספת שאולי לא תבוא בקרוב.
    //
    // ההבחנה: session שמור ב-localStorage **בזמן העלייה** פירושו משתמש
    // חוזר. מי שאין לו הגיע עכשיו דרך הטופס, ולו כן מגיעה ההשהיה.
    const returning = Object.keys(localStorage)
      .some((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));

    const visits = Number(localStorage.getItem("visit-count") || 0) + 1;
    localStorage.setItem("visit-count", String(visits));
    if (!returning && visits < 2) return;

    // ⚠️ השהיה קצרה: פאנל שנפתח באותו רגע שהמסך נטען נקרא כתקלה, לא
    // כהצעה — והמשתמשת סוגרת אותו לפני שקראה.
    const t = setTimeout(() => setPushOpen(true), 1500);
    return () => clearTimeout(t);
  }, []);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // ⚠️ גלילה סוגרת את הסינון. הוא נפתח מעל הכרטיסים ותופס כחצי מסך, ולכן
  // מי שמתחיל לגלול כבר סיים איתו — והשארתו פתוחה פירושה לגלול "מתחת"
  // לתפריט שכבר לא רלוונטי.
  //
  // ⚠️ capture: true על window, ולא מאזין על אלמנט מסוים: הגלילה כאן קורית
  // ברשת הכרטיסים ולא ב-document, ואירוע scroll **אינו מבעבע**. בלי שלב
  // ה-capture המאזין פשוט לא היה נורה.
  //
  // ⚠️ ורק כשהתפריט פתוח — מאזין קבוע היה רץ בכל גלילה במסך, לנצח, כדי
  // לבדוק דגל שברוב הזמן כבוי.
  useEffect(() => {
    if (!filtersOpen) return;

    // ============================================================
    // ⚠️ תקופת חסד — בלעדיה התפריט לא נפתח בכלל אחרי גלילה
    // ============================================================
    // פתיחת התפריט **מזיזה את הפריסה** (הוא דוחף את הכרטיסים למטה),
    // והדפדפן יורה על כך אירוע scroll מיד. המאזין סגר את התפריט באותו
    // רגע, ולכן במסך שכבר גולל הלחיצה נראתה כאילו אינה עושה כלום.
    //
    // ⚠️ נמדד: זה קרה **רק** כשהמסך גולל. בראש הדף אין לאן להזיז, לא נורה
    // אירוע, והכול עבד — כלומר הבדיקה שלי במצב לא-גלול הייתה עיוורת לזה.
    //
    // 250ms מכסות את תזוזת הפריסה ואת האינרציה שאחרי הלחיצה, והן קצרות
    // מכדי שמישהו יספיק לגלול בכוונה ולצפות שייסגר.
    const readyAt = performance.now() + 250;
    // ============================================================
    // ⚠️ ולא כל אירוע scroll הוא גלילה של המשתמשת (08/10/2026)
    // ============================================================
    // פתיחת רשימת "בודק מוסמך" בתוך התפריט יורה scroll על המסמך **בלי שהמסמך זז** (נמדד ב-Chrome,
    // גם בלי focus). מי שפתחה את התפריט וחשבה שנייה לפני הנגיעה — מעבר לתקופת החסד — ראתה את כל
    // התפריט נסגר עם הרשימה, מתחת לאצבע. ולכן:
    //   • גלילה **בתוך הכותרת** (הרשימה גוללת בתוך עצמה בטלפון נמוך) — אינה "סיימתי עם התפריט";
    //   • scroll על המסמך שלא הזיז אותו — אינו גלילה.
    // גלילה אמיתית — של המסמך, או של רשת הכרטיסים (שם היא קורית בפועל) — עדיין סוגרת.
    const startY = window.scrollY;
    const close = (e) => {
      if (performance.now() < readyAt) return;
      const t = e.target;
      if (t instanceof Element && t.closest(".app-header")) return;
      const doc = t === document || t === document.documentElement || t === document.body;
      if (doc && Math.abs(window.scrollY - startY) < 8) return;
      setFiltersOpen(false);
    };
    window.addEventListener("scroll", close, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", close, { capture: true });
  }, [filtersOpen]);
  // ⚠️ אריחי המצב, הסוג, "בודק מוסמך", "משימות", "קריאות פתוחות" ו"תקלות חוזרות" סופרים את מה שהלוח מראה — הסוג שנבחר
  // (רובוטיים או מכפילים); אחרת "הכל · 206" מעל לוח של 78 כרטיסים. שני אריחי הסוג עצמם סופרים כל אחד את כל האתרים מסוגו.
  // ⚠️ "קריאות פתוחות" לחוץ — הלוח מראה רק אתרים עם קריאה פתוחה, משני הסוגים, ולכן גם הספירות כאן (הסקירה של 19/10:
  // בלי הסינון לפי קריאה "הכל" ספר 208 מעל לוח של 14). ⚠️ ורק כשמספרי הקריאות נטענו — כמו OperatorView, שבלעדיהם לא
  // מסנן; אחרת הכותרת והלוח היו סותרים זה את זה עד הטעינה (ואחרי כשל — עד 5 דקות).
  const callsMode = Boolean(onShowOpenCallsChange && showOpenCalls === true && callCounts);
  const boardSites = (sites ?? []).filter((s) => matchesBoardKind(s, siteKind, callsMode)
    && (!callsMode || (callCounts[s.id]?.open ?? 0) > 0));
  const openCallSites = countSitesWithOpenCalls(sites ?? [], callCounts ?? {});
  // מסנן המצב אינו חל בלוח "מכפילים" (OperatorView) — ולכן גם לא נספר שם. ⚠️ חוץ מ"קריאות פתוחות" לחוץ: שם הלוח מראה
  // גם רובוטיים, והמצב חל עליהם (הסקירה של 19/10 — בלי זה "בתקלה" לא סינן כלום כשהסוג השמור היה מכפילים)
  const statusApplies = callsMode || siteKind !== SITE_KIND_MULTIPLIERS;
  const activeCount = (statusApplies ? (activeFilters?.length ?? 0) : 0) +
    (typeFilter && typeFilter !== "all" ? 1 : 0) +
    (systemFilter && systemFilter !== "all" ? 1 : 0) +
    (tierFilter && tierFilter !== "all" ? 1 : 0) +
    (liftFilter ? 1 : 0) +
    complianceActiveCount(complianceView) +
    // ⚠️ נספר רק "מכפילים" — "רובוטיים" הוא ברירת המחדל (כמו "בודק מוסמך" ו"משימות": נספר רק מה ששונה ממנה)
    (onSiteKindChange && siteKind === SITE_KIND_MULTIPLIERS && !callsMode ? 1 : 0) +
    (onShowRepeatChange && showRepeat === true ? 1 : 0) +
    (onTasksViewChange ? tasksViewActive(tasksView) : 0) +
    (onShowOpenCallsChange && showOpenCalls === true ? 1 : 0);

  // שלושת המלבנים (19/10/2026) — מה פעיל בכל אחד, בשורה שמתחת לשם; מסומן כשמשהו שונה מברירת המחדל
  const statusN = statusApplies ? (activeFilters?.length ?? 0) : 0;
  const statusSummary = !statusApplies ? "לא חל על מכפילים" : statusN === 0 ? "הכל" : statusN <= 2 ? activeFilters.map((st) => STATUS_LABELS[st] ?? st).join(" + ") : `${statusN} מצבים`;
  const infoN = [typeFilter && typeFilter !== "all", systemFilter && systemFilter !== "all", tierFilter && tierFilter !== "all", !!liftFilter].filter(Boolean).length;
  const infoSummary = infoN === 0 ? "הכל" : infoN === 1 ? "מסנן אחד" : `${infoN} מסננים`;
  const extrasN = complianceActiveCount(complianceView) + (onTasksViewChange ? tasksViewActive(tasksView) : 0) +
    (onShowRepeatChange && showRepeat === true ? 1 : 0);
  const extrasSummary = extrasN === 0 ? "כבויים" : extrasN === 1 ? "אחד פעיל" : `${extrasN} פעילים`;

  return (
    <header className="app-header">
      <div className="header-top">
        {/* לוגו המותג — מקור האמת לצבעי המערכת (ראה theme.css) */}
        <div className="header-logo">
          <img src="/parkomat-logo.png" alt="Parkomat" className="logo-img" />
          <div className="logo-text">
            <span className="logo-mark">Parkomat</span>
            <span className="logo-subtitle">SiteMonitor</span>
          </div>
        </div>

        <RoleSwitcher role={role} onChange={onRoleChange} />

        <div className="header-actions">
          {isOperator && <SearchBar value={searchQuery} onChange={onSearchChange} />}

          {/* מצב ההתראות הקוליות. מוצג בכל התפקידים — אזעקה חסומה היא בעיה
              של המסך, לא של התפקיד שמסתכל בו. */}
          <AlertBell />

          {/* משימות — לא כאן: שני כפתורים בכל כרטיס (בעלת המוצר, 06/10/2026). */}

          {/* ⚠️ כאן היה כפתור "דורש טיפול" של הבודק (רשימה למנהלים) — הוסר לבקשת בעלת
              המוצר, 06/10/2026: "אני בכלל לא רוצה כזה דבר". המנורות בכרטיסים הן הערוץ. */}
          {/* ⚠️ התראות push — **רק באפליקציה מותקנת.** במחשב הכפתור אינו
              נבנה כלל, ולכן אין שום אזכור להתראות שם.
              נפרד מהפעמון בכוונה: הפעמון הוא הצליל באפליקציה פתוחה. */}
          {isInstalledApp() && (
            <button className="theme-toggle" onClick={() => setPushOpen(true)}
                    title="התראות תקלה בטלפון" aria-label="התראות תקלה">🔔</button>
          )}


          {/* ⚠️ פתוח לכולם, בלי תלות בתפקיד: מי שצריך הסבר על מספר הוא
              בדיוק מי שאין לו הרשאות. עזרה מאחורי הרשאה היא עזרה שאינה
              מגיעה למי שזקוק לה. */}
          <button className="theme-toggle" onClick={() => setHelpOpen(true)}
                  title="איך קוראים את הדשבורד" aria-label="עזרה">?</button>

          {canManage && (
            <button className="add-site-btn" onClick={onAdmin} title="ניהול אתרים">
              <span className="add-site-plus">⚙</span>
              ניהול אתרים
            </button>
          )}

          {/* ⚠️ פתוח לכל מי שמחובר, ובכוונה: כל אחד מדווח, וגם המנהלת
              בשטח לא פחות מהאחרים. מי רואה **מה** נקבע ב-RLS ולא כאן —
              הסתרת כפתור אינה הרשאה. */}
          {/* ⚠️ מוסתר במצב שרת: לתכונה הזו אין זרוע שרת — היא נולדה אחרי
              שהמתג הוכרע. כפתור שנפתח למסך שייכשל הוא הדרך האמינה לגרום
              למישהו להסיק שהמערכת שבורה. ראה dataSource. */}
          {useDirect && (
            <button
              className="theme-toggle"
              onClick={() => setReportsOpen(true)}
              title="כתבו לנו — תקלה, הערה או רעיון"
              aria-label="כתבו לנו"
            >
              📮
            </button>
          )}

          {isUserManager && (
            <button
              className="theme-toggle"
              onClick={() => setUsersOpen(true)}
              title="משתמשים — צירוף וצפייה"
              aria-label="משתמשים"
            >
              👥
            </button>
          )}

          {/* מי מחובר, שינוי סיסמה, ויציאה. החליף כפתור ⎋ בודד שלא אמר בשם
              מי המסך פועל — וזה מה שנרשם על כל פעולת תחזוקה. */}
          <AccountMenu />

          <button
            className="theme-toggle"
            onClick={onToggleDarkMode}
            title={darkMode ? "מצב בהיר" : "מצב כהה"}
            aria-label={darkMode ? "מעבר למצב בהיר" : "מעבר למצב כהה"}
          >
            {darkMode ? "☀" : "☾"}
          </button>
        </div>
      </div>

      {usersOpen && <UsersPanel onClose={() => setUsersOpen(false)} />}

      {reportsOpen && (
        <FieldReports
          sites={sites}
          openReportId={openReportId}
          onClose={() => { setReportsOpen(false); setOpenReportId(null); }}
        />
      )}

      {pushOpen && <PushSettings onClose={() => setPushOpen(false)} />}
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}

      {/* מוני סטטוס כפילטרים — רק בתצוגת הבקר */}
      {isOperator && (
        <button
          type="button"
          className="header-filters-toggle"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          <span>סינון ותצוגה{activeCount ? ` · ${activeCount} פעילים` : ""}</span>
          <span className="header-filters-chevron" aria-hidden="true">
            {filtersOpen ? "▲" : "▼"}
          </span>
        </button>
      )}

      {isOperator && (
        <div className={`header-filters${filtersOpen ? " is-open" : ""}`}>
          {/* ⚠️ 19/10/2026 — שני אריחי סוג ושלושה מלבנים (בעלת המוצר: "אני רוצה מלבנים שמכל אחד מהם נובע כמה דברים — מצבים
              (הכל, מוכן, בפעולה, בתקלה, בתחזוקה, אין תקשורת), מידע (סוג, מעליות, סוג שירות), תוספים (בודק מוסמך, תחזוקה
              מונעת, קריאות); ושני ריבועים, מכפילים ורובוטיים, שעליהם מתבצעים בעצם הריבועים"). בתשובות שלה: גם "מערכת" במידע,
              ו"משימות" ו"תקלות חוזרות" בתוספים. עד אז — שורה אחת של 14 אריחים. הרכיבים עצמם לא השתנו: הם עברו לחלוניות. */}
          <div className="status-filters header-groups" role="group" aria-label="סינון הלוח">
            {/* "רובוטיים" / "מכפילים" (בעלת המוצר, 19/10/2026: "תוסיף סינון רובוטיים וזה נמצא אוטומטית. אם לוחצים על
                מכפילים — רואים רק מכפילים; אם מסירים מכפילים — הרובוטיים חוזרים; אם לוחצים על רובוטיים ומכפילים קיים —
                מכפילים נעלמים ורק רובוטיים נשאר"). שני אריחים, תמיד אחד מהם פעיל; המספר הגדול — כמה אתרים מהסוג. עד אז
                (18/10) מתג אחד, "מכפילים גלויים", שהוסיף את המכפילים לצד הרובוטיים. הבחירה נזכרת לכל מכשיר (useSiteKind). */}
            {/* ⚠️ כש"קריאות פתוחות" לחוץ הסוג אינו חל, ולכן אף אחד משני האריחים אינו מודגש; לחיצה על אחד מהם יוצאת
                מ"קריאות פתוחות" ומראה את הסוג הזה (19/10/2026) */}
            {onSiteKindChange && [SITE_KIND_ROBOTIC, SITE_KIND_MULTIPLIERS].map((k) => {
              const on = siteKind === k && !callsMode;
              const n = k === SITE_KIND_ROBOTIC ? countRobotic(sites) : countMultipliers(sites);
              const label = k === SITE_KIND_ROBOTIC ? "רובוטיים" : "מכפילים";
              return (
                <button key={k} type="button" data-kind={k}
                  className={`filter-btn kind-head-btn ${k === SITE_KIND_ROBOTIC ? "rb-head-btn" : "mx-head-btn"}${on ? " active" : ""}`}
                  aria-pressed={on}
                  aria-label={`${label} (${k === SITE_KIND_ROBOTIC ? "אתרים עם בקר" : "אתרים בלי בקר"}) — ${n}`}
                  onClick={() => { if (callsMode) { onShowOpenCallsChange(false); onSiteKindChange(k); } else onSiteKindChange(nextSiteKind(siteKind, k)); }}>
                  <span className="filter-count">{n}</span>
                  <span className="filter-label">{label}</span>
                </button>
              );
            })}
            {/* "קריאות פתוחות" — סינון נפרד, לא בתוך "תוספים" (בעלת המוצר, 19/10/2026: "קריאות פתוחות שים אותם בתור סינון
                נפרד, ושלוחצים על זה זה שם את הקריאות הפתוחות גם של המכפילים וגם של הרובוטיים"). לחוץ — כל אתר עם קריאה
                פתוחה, משני הסוגים, עם הסטופר וצבע ההחמרה; לא לחוץ (ברירת המחדל, 18/10) — בלי סימון קריאות. המספר הגדול —
                כמה אתרים יש להם קריאה פתוחה, משני הסוגים. */}
            {onShowOpenCallsChange && (
              <button type="button" className={`filter-btn oc-head-btn${showOpenCalls === true ? " active" : ""}`}
                aria-pressed={showOpenCalls === true}
                aria-label={`קריאות פתוחות, רובוטיים ומכפילים — ${openCallSites} אתרים`}
                onClick={() => onShowOpenCallsChange(!(showOpenCalls === true))}>
                <span className="filter-count">{openCallSites}</span>
                <span className="filter-label">קריאות פתוחות</span>
              </button>
            )}
            <FilterGroup title="מצבים" summary={statusSummary} active={statusN > 0} className="fg-status">
              <StatusFilters sites={boardSites} activeFilters={activeFilters} onFilterChange={onFilterChange} />
            </FilterGroup>
            <FilterGroup title="מידע" summary={infoSummary} active={infoN > 0} className="fg-info">
              <SiteFilterTile
                sites={boardSites}
                typeFilter={typeFilter}
                systemFilter={systemFilter}
                tierFilter={tierFilter}
                onTypeChange={onTypeFilterChange}
                onSystemChange={onSystemFilterChange}
                onTierChange={onTierFilterChange}
                liftFilter={liftFilter}
                onLiftChange={onLiftFilterChange}
              />
            </FilterGroup>
            <FilterGroup title="תוספים" summary={extrasSummary} active={extrasN > 0} className="fg-extras">
              {/* "בודק מוסמך" — נפתח לרשימה, בוחרים מה לראות, נסגר; בחירה מדליקה גם את הנורה בכרטיסים
                  (בעלת המוצר, 08/10/2026) */}
              {onComplianceViewChange && (
                <ComplianceFilters sites={boardSites} value={complianceView} onChange={onComplianceViewChange} />
              )}
              {/* "משימות" — אותה רשימה; מלכתחילה "בלי משימות" (בעלת המוצר, 18/10/2026: "מלכתחילה שלא יוצגו", לפי סוג) */}
              {onTasksViewChange && (
                <TasksFilter sites={boardSites} bySite={taskCounts} value={tasksView} onChange={onTasksViewChange} />
              )}
              {/* "תקלות חוזרות" (בעלת המוצר, 19/10/2026: "סינון של כאלו שהתקלות שיש להם את הסימון הזה של תקלות חוזרות").
                  כמו "קריאות פתוחות": כיתוב קבוע, לחוץ — רק אתרים עם הסימון ↻; המספר הגדול — כמה אתרים בלוח יש להם אותו. */}
              {onShowRepeatChange && (
                <button type="button" className={`filter-btn rf-head-btn${showRepeat === true ? " active" : ""}`}
                  aria-pressed={showRepeat === true}
                  aria-label={`תקלות חוזרות — ${countRepeatSites(boardSites)} אתרים`}
                  onClick={() => onShowRepeatChange(!(showRepeat === true))}>
                  <span className="filter-count">{countRepeatSites(boardSites)}</span>
                  <span className="filter-label">תקלות חוזרות</span>
                </button>
              )}
              {/* ⚠️ כאן ישב "קריאות היום" (14/10/2026) — הוסר לבקשת בעלת המוצר, 18/10/2026 ("תעיף את זה"), כשנוסף
                  "קריאות פתוחות". לשחזור: git show 76664a6:dashboard/src/components/Header/Header.jsx */}
            </FilterGroup>
          </div>
        </div>
      )}
    </header>
  );
}

export default Header;
