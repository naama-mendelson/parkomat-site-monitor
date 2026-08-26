// components/Header/Header.jsx — Header עליון: לוגו, בורר תפקיד, חיפוש, dark/light
import { useEffect, useState } from "react";
import PushSettings from "../PushSettings/PushSettings";
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
import SearchBar from "../SearchBar/SearchBar";
import RoleSwitcher from "../RoleSwitcher/RoleSwitcher";
import AlertBell from "../AlertBell/AlertBell";
import UsersPanel from "../UsersPanel/UsersPanel";
import FieldReports from "../FieldReports/FieldReports";
import AccountMenu from "../AccountMenu/AccountMenu";
import "./Header.css";

function Header({
  sites,
  role,
  onRoleChange,
  activeFilters,
  typeFilter,
  onTypeFilterChange,
  tierFilter,
  onTierFilterChange,
  onFilterChange,
  searchQuery,
  onSearchChange,
  darkMode,
  onToggleDarkMode,
  onAdmin,
}) {
  // החיפוש והפילטרים הם כלי עבודה של הבקר. למנהל הבקרה יש חיפוש/סינון
  // משלו בתוך הטבלה, ולמנהל הכללי אין בהם צורך — אז הם לא מוצגים שם.
  const isOperator = role === "operator";

  // ניהול האתרים (הוספה/עריכה/מחיקה) פתוח רק למנהל בקרה ומנהל כללי.
  // הבקר מנטר בלבד. השרת אוכף את זה גם הוא — הסתרה ב-UI אינה אבטחה.
  const canManage = role === "supervisor" || role === "executive";

  // צירוף משתמשים פתוח לכל מי שמחובר (החלטת מוצר), ולכן הכפתור אינו תלוי
  // בתפקיד — בשונה מ"ניהול אתרים" שמעליו. השרת הוא שאוכף בשני המקרים
  // (requireAuth ב-api/routes.js); הסתרה ב-UI אינה אבטחה.
  const [usersOpen, setUsersOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);

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
    const close = () => { if (performance.now() >= readyAt) setFiltersOpen(false); };
    window.addEventListener("scroll", close, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", close, { capture: true });
  }, [filtersOpen]);
  const activeCount = (activeFilters?.length ?? 0) +
    (typeFilter && typeFilter !== "all" ? 1 : 0) +
    (tierFilter && tierFilter !== "all" ? 1 : 0);

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

          {/* ⚠️ התראות push — **רק באפליקציה מותקנת.** במחשב הכפתור אינו
              נבנה כלל, ולכן אין שום אזכור להתראות שם.
              נפרד מהפעמון בכוונה: הפעמון הוא הצליל באפליקציה פתוחה. */}
          {isInstalledApp() && (
            <button className="theme-toggle" onClick={() => setPushOpen(true)}
                    title="התראות תקלה בטלפון" aria-label="התראות תקלה">🔔</button>
          )}


          {canManage && (
            <button className="add-site-btn" onClick={onAdmin} title="ניהול אתרים">
              <span className="add-site-plus">⚙</span>
              ניהול אתרים
            </button>
          )}

          {/* ⚠️ פתוח לכל מי שמחובר, ובכוונה: כל אחד מדווח, וגם המנהלת
              בשטח לא פחות מהאחרים. מי רואה **מה** נקבע ב-RLS ולא כאן —
              הסתרת כפתור אינה הרשאה. */}
          <button
            className="theme-toggle"
            onClick={() => setReportsOpen(true)}
            title="כתבו לנו — תקלה, הערה או רעיון"
            aria-label="כתבו לנו"
          >
            📮
          </button>

          <button
            className="theme-toggle"
            onClick={() => setUsersOpen(true)}
            title="משתמשים — צירוף וצפייה"
            aria-label="משתמשים"
          >
            👥
          </button>

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
        <FieldReports sites={sites} onClose={() => setReportsOpen(false)} />
      )}

      {pushOpen && <PushSettings onClose={() => setPushOpen(false)} />}

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
        <StatusFilters
          sites={sites}
          activeFilters={activeFilters}
          onFilterChange={onFilterChange}
          trailing={
            <SiteFilterTile
              sites={sites}
              typeFilter={typeFilter}
              tierFilter={tierFilter}
              onTypeChange={onTypeFilterChange}
              onTierChange={onTierFilterChange}
            />
          }
        />
        </div>
      )}
    </header>
  );
}

export default Header;
