// components/ActivityLog/ActivityLog.jsx — לוג פעילות מלא: ציר זמן מאוחד
// (פעולות · שינויי מצב · תחזוקה), מקובץ לפי ימים, עם סינון.
import { useMemo, useState } from "react";
import { STATUS_COLORS, STATUS_LABELS, DIRECTION_COLORS } from "../../utils/constants";
import "./ActivityLog.css";

const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// מערך ריק קבוע — `|| []` היה יוצר הפניה חדשה בכל render ומבטל את ה-useMemo.
const NO_ENTRIES = [];

// סיווג לקטגוריית הסינון. קריטי: תחזוקה מגיעה משני מקורות —
// חלון ידני (kind='maintenance') *וגם* מצב תחזוקה מה-PLC (kind='status').
// בלי הסיווג הזה, סינון "תחזוקה" היה מפספס את התחזוקה שמדווחת מהבקר.
// הקטגוריות זרות זו לזו, ולכן אירוע לא נספר פעמיים.
function categoryOf(e) {
  if (e.kind === "operation") return "operation";
  if (e.kind === "maintenance") return "maintenance";
  return e.status === "maintenance" ? "maintenance" : "status";
}

// ==========================================================
// 'בפעולה' מוצג רק במסנן "שינויי מצב"
// ==========================================================
// כל כניסת רכב מייצרת גם מעבר מצב ל'בפעולה' וגם הודעת פעולה. בציר הזמן המאוחד
// ("הכל") זה הופיע פעמיים ברצף — "המצב השתנה ל: בפעולה" ומיד "כניסת רכב" — וזה
// רעש שמטשטש את מה שבאמת קרה.
//
// אבל במסנן "שינויי מצב" זה לא רעש אלא התוכן עצמו: היסטוריית מצבים שחסר בה
// המצב הנפוץ ביותר אינה היסטוריית מצבים. לכן השרת שולח את הכל, ואנחנו מסתירים
// רק היכן שזה מפריע.
//
// ==========================================================
// 'בפעולה' מוסתר, 'מוכן' לא — וזו החלטה, לא חוסר עקביות
// ==========================================================
// שניהם נולדים יחד עם פעולה: MODE 1→2/3 מייצר state=operating + operation/start,
// ו-MODE 2/3→1 מייצר operation/end + state=ready. אבל הערך שלהם שונה:
//
//   • 'בפעולה' אינו מוסיף כלום מעל "כניסת רכב התחילה" — אותו רגע בדיוק, ופחות
//     מידע (בלי כיוון ובלי כרטיס). זה רעש, ולכן הוא מוסתר.
//
//   • 'מוכן' כן מוסיף: הוא נושא את **משך ההמתנה עד הפעולה הבאה** — שעתיים
//     וחצי, חמש שעות. זו התקופה שבין הפעולות, ואין שום שורה אחרת שמספרת
//     אותה. ניסיון להסתיר גם אותו השאיר פעולות צמודות זו לזו כאילו האתר לא
//     עמד ריק ביניהן — הסתרה של מידע אמיתי, לא של רעש.
//
// הסדר בין 'מוכן' לבין הסיום נקבע ב-phaseRank (queries.js): 'מוכן' מעל, כי
// ברשימה יורדת "מעל" = מאוחר יותר, והאתר מוכן *אחרי* שהפעולה נסגרה.
//
// ⚠️ ההסתרה מותנית בקיום פעולה תואמת. הסוכן משדר גם resync — הודעת state
// לבדה, בלי פעולה — בעלייה, בחזרת הברוקר ובחזרת הגשר. הסתרה עיוורת הייתה
// מוחקת את האירוע היחיד, והלוג היה סותר את הכרטיס: הכרטיס "בפעולה" והשורה
// העליונה "מוכן" מלפני שעות (אתר 1348, 26/07 — מקטע שנפתח ב-23:30 ולא נראה).
//
// ההחלטה עצמה מגיעה **מהשרת**, בדגל explainedByOp. היא הצטלבות של שתי
// רשימות עם סבילות זמן, והמונה שעל הצ'יפ נספר לפי אותה סבילות ב-SQL. חישוב
// מקומי כאן היה עותק שני שיסטה מהראשון, והצ'יפ היה מפסיק להתאים לשורות.

const FILTERS = [
  { key: "all", label: "הכל" },
  { key: "operation", label: "פעולות" },
  { key: "status", label: "שינויי מצב" },
  { key: "maintenance", label: "תחזוקה" },
];

// משך בשניות → טקסט קצר וקריא
function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `${seconds} שנ'`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} דק'`;
  const h = Math.floor(m / 60);
  const restM = m % 60;
  if (h < 24) return restM ? `${h} שע' ${restM} דק'` : `${h} שע'`;
  return `${Math.floor(h / 24)} ימים`;
}

// כותרת יום: "היום" / "אתמול" / "12.7.2026 · ראשון"
function dayHeading(dateKey) {
  const d = new Date(`${dateKey}T12:00:00`);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (same(d, today)) return "היום";
  if (same(d, yesterday)) return "אתמול";
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} · ${WEEKDAYS[d.getDay()]}`;
}

const dayKeyOf = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// כל שורה מתורגמת לתצוגה אחידה: צבע, כותרת, פירוט, תג-צד.
function describe(e) {
  if (e.kind === "operation") {
    const isEntry = e.entryExit === "entry";
    const color = isEntry ? DIRECTION_COLORS.entry : DIRECTION_COLORS.exit;
    const dir = isEntry ? "כניסת רכב" : "יציאת רכב";

    // ==========================================================
    // "הושלמה" רק כשהיא באמת הושלמה
    // ==========================================================
    // הסוכן סוגר פעולה בכל מעבר MODE, כולל מעבר לתקלה — ולכן רכב שנתקע
    // באמצע נרשם כ-end רגיל. הלוג הציג "יציאת רכב הושלמה" בדיוק ברגע
    // שהרכב נתקע: היפוך משמעות, לא ניסוח לא מדויק.
    //
    // השרת מסמן ב-interruptedBy את המצב שקטע (error / maintenance), או null
    // כשהפעולה הושלמה. נמדד: 71% מהתקלות קורות תוך כדי פעולה, ותחזוקה קוטעת
    // עוד 7 פעולות — פחות, אבל רכב שנתקע כי מישהו העביר לתחזוקה אינו "הושלם"
    // יותר מרכב שנתקע בתקלה.
    const cut = e.interruptedBy;
    const phase = e.startEnd === "start"
      ? "התחילה"
      : cut === "error" ? "נקטעה בתקלה"
      : cut === "maintenance" ? "נקטעה בתחזוקה"
      : "הושלמה";

    const details = [];
    details.push(e.card ? `כרטיס ${e.card}` : "ללא כרטיס");
    if (cut) details.push("הרכב לא סיים את המעבר");
    if (e.isAnomaly) details.push("אנומליה");

    return {
      // פעולה שנקטעה נצבעת בצבע המצב שקטע אותה — היא אירוע כשל, לא תנועה
      // תקינה, והצבע מספר *מה* קטע בלי לקרוא את הטקסט.
      color: cut ? (STATUS_COLORS[cut]?.dot ?? STATUS_COLORS.error.dot) : color,
      icon: isEntry ? "↓" : "↑",
      title: `${dir} ${phase}`,
      details: details.join(" · "),
      badge: e.startEnd === "start" ? "התחלה" : cut ? "נקטעה" : "סיום",
      // תחזוקה אינה תקלה, ולכן היא אינה נצבעת אדום — היא עדיין קטיעה.
      badgeTone: e.isAnomaly || cut === "error" ? "danger"
        : cut === "maintenance" ? "warn" : "normal",
    };
  }

  if (e.kind === "maintenance") {
    const c = STATUS_COLORS.maintenance;
    const cancelled = Boolean(e.cancelledAt);
    const details = [`הפעיל: ${e.setBy}`, `משך מתוכנן: ${e.durationHours} שע'`];
    if (e.reason) details.push(`סיבה: ${e.reason}`);

    return {
      color: c.dot,
      icon: "⚙",
      title: cancelled ? "חלון תחזוקה (בוטל)" : "חלון תחזוקה הופעל",
      details: details.join(" · "),
      badge: "תחזוקה ידנית",
      badgeTone: "normal",
    };
  }

  // שינוי מצב
  const c = STATUS_COLORS[e.status] || STATUS_COLORS.no_comm;
  const label = STATUS_LABELS[e.status] || e.status;
  const dur = fmtDuration(e.durationSeconds);
  const isPlcMaintenance = e.status === "maintenance";

  return {
    color: c.dot,
    icon: isPlcMaintenance ? "⚙" : "●",
    // ניסוח אחיד לכל שינויי המצב, כולל תחזוקה: "המצב השתנה ל: בתחזוקה".
    // ה-⚙ ו-"דווח מהבקר" מבחינים אותו מחלון תחזוקה ידני (kind='maintenance').
    title: `המצב השתנה ל: ${label}`,
    details: isPlcMaintenance
      ? `דווח מהבקר · ${e.endedAt ? `נמשך ${dur}` : "עדיין בתחזוקה"}`
      : e.endedAt ? `נמשך ${dur}` : "המצב הנוכחי",
    badge: e.endedAt ? dur : "נוכחי",
    badgeTone: e.status === "error" ? "danger" : "normal",
  };
}

function ActivityLog({ log }) {
  const [filter, setFilter] = useState("all");

  const entries = log?.entries || NO_ENTRIES;

  const visible = useMemo(() => {
    // "שינויי מצב" — כל שינויי המצב של האתר: 'בפעולה' כלול, *וגם* מעבר
    // ל'בתחזוקה' שדווח מהבקר (הוא שינוי מצב לכל דבר). אותו אירוע מופיע גם
    // במסנן "תחזוקה" — שתי עדשות על אותו אירוע, לא ספירה כפולה בטעות.
    if (filter === "status") return entries.filter((e) => e.kind === "status");
    // ==========================================================
    // "הכל" — 'בפעולה' לא מופיע כאן. נקודה.
    // ==========================================================
    // קודם ההסתרה הייתה **מותנית** בקיום פעולה תואמת (explainedByOp), מתוך
    // חשש שמקטע 'בפעולה' יתום ייעלם. בפועל זה יצר בדיוק את הרעש שההסתרה
    // באה למנוע: כשההתאמה נכשלה — הודעות שהגיעו בפער של דקות, פריקת תור
    // אחרי נתק — השורה חזרה להופיע לצד הפעולה שלה, ולפעמים במרחק כזה
    // שנראה כאילו מדובר בשני אירועים שונים.
    //
    // הכלל פשוט יותר וגם מה שהתכנון התכוון אליו מלכתחילה: **'בפעולה' הוא
    // תוכן של מסנן "שינויי מצב", לא של ציר הזמן המאוחד.** מי שרוצה את
    // היסטוריית המצבים המלאה לוחץ על הצ'יפ הזה ומקבל אותה שלמה.
    //
    // שאר המצבים נשארים מותנים: 'מוכן' נושא את משך ההמתנה עד הפעולה הבאה
    // ואין שורה אחרת שמספרת אותה, ותקלה/נתק/תחזוקה הם אירועים בפני עצמם.
    if (filter === "all") {
      return entries.filter(
        (e) => !e.explainedByOp && !(e.kind === "status" && e.status === "operating")
      );
    }
    return entries.filter((e) => categoryOf(e) === filter);
  }, [entries, filter]);

  // קיבוץ לימים, תוך שמירה על הסדר (מהחדש לישן)
  const days = useMemo(() => {
    const map = new Map();
    for (const e of visible) {
      const k = dayKeyOf(e.at);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
    }
    return [...map.entries()];
  }, [visible]);

  const counts = log?.counts || { operations: 0, status: 0, statusAll: 0, maintenance: 0 };
  const countFor = (key) => ({
    // "הכל" סופר בדיוק את מה שמוצג בו: פעולות + שינויי מצב שאינם 'בפעולה' +
    // תחזוקה.
    //
    // ⚠️ orphanOperating הוסר מכאן במכוון. הוא נספר כשמקטעי 'בפעולה' יתומים
    // עדיין הוצגו כאן; מרגע ש'בפעולה' אינו מופיע ב"הכל" כלל, הוספתו הייתה
    // הופכת את המספר על הצ'יפ לגדול ממספר השורות שנפתחות — וצ'יפ שלא מסכים
    // עם מה שהוא פותח הוא בדיוק סוג הפרט שמאבד אמון במסך כולו.
    // השדה עדיין מגיע מהשרת ומשמש את מסנן "שינויי מצב".
    all: counts.operations + counts.status + counts.maintenance,
    operation: counts.operations,
    // "שינויי מצב" סופר *כולל* 'בפעולה' (counts.statusAll), כדי שהמספר על הצ'יפ
    // יתאים לכמות השורות שייפתחו. ה-?? מגן על שרת ישן שעדיין לא שולח statusAll.
    status: counts.statusAll ?? counts.status,
    maintenance: counts.maintenance,
  }[key]);

  return (
    <div className="alog">
      {/* סינון */}
      <div className="alog-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`alog-chip ${filter === f.key ? "is-active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            <span className="alog-chip-count">{countFor(f.key)}</span>
          </button>
        ))}
      </div>

      {log?.truncated && (
        <p className="alog-truncated">
          מוצגים {entries.length} האירועים האחרונים בתקופה
        </p>
      )}

      {days.length === 0 ? (
        <p className="alog-empty">אין אירועים להצגה בתקופה זו</p>
      ) : (
        <div className="alog-timeline">
          {days.map(([dayKey, items]) => (
            <section key={dayKey} className="alog-day">
              <header className="alog-day-head">
                <span className="alog-day-title">{dayHeading(dayKey)}</span>
                <span className="alog-day-count">{items.length} אירועים</span>
              </header>

              <ul className="alog-items">
                {items.map((e, i) => {
                  const d = describe(e);
                  return (
                    <li key={`${e.kind}-${e.at}-${i}`} className="alog-item">
                      {/* ציר הזמן: נקודה + קו */}
                      <span className="alog-marker" style={{ background: d.color }}>
                        <span className="alog-icon">{d.icon}</span>
                      </span>

                      <div className="alog-content">
                        <div className="alog-row-top">
                          <span className="alog-title" style={{ color: d.color }}>
                            {d.title}
                          </span>
                          {/* שם האתר — מוצג רק בלוג המצרף (כל האתרים) */}
                          {e.siteName && <span className="alog-site">{e.siteName}</span>}
                          <time className="alog-time">
                            {new Date(e.at).toLocaleTimeString("he-IL", {
                              hour: "2-digit", minute: "2-digit", second: "2-digit",
                            })}
                          </time>
                        </div>
                        <span className="alog-details">{d.details}</span>
                      </div>

                      {d.badge && (
                        <span className={`alog-badge alog-badge--${d.badgeTone}`}>
                          {d.badge}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default ActivityLog;
