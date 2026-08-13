// components/ActivityLog/ActivityLog.jsx — לוג פעילות מלא: ציר זמן מאוחד
// (פעולות · שינויי מצב · תחזוקה), מקובץ לפי ימים, עם סינון.
import { useEffect, useMemo, useState } from "react";
// דרך המתג: במצב ישיר הדשבורד שולף שורות גולמיות מ-Supabase ומריץ עליהן
// את **אותה** buildActivityLog שהשרת מריץ (shared/timeline.mjs).
import { fetchActivity } from "../../services/dataSource";
import { STATUS_COLORS, STATUS_LABELS, DIRECTION_COLORS } from "../../utils/constants";
import "./ActivityLog.css";

const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// מערך ריק קבוע — `|| []` היה יוצר הפניה חדשה בכל render ומבטל את ה-useMemo.
const NO_ENTRIES = [];

// ==========================================================
// הסינון עבר לשרת — וכאן לא נשאר ממנו כלום, בכוונה
// ==========================================================
// היו כאן שני דברים: `categoryOf` (סיווג לקטגוריה) והכלל של "הכל". שניהם
// היו **עותק שני** של מה שהשרת כבר ידע, ושני עותקים של אותו כלל נפרדים ביום
// שבו מישהו יתקן אחד מהם. התסמין הוא הגרוע ביותר במסך הזה: מספר על הצ'יפ
// שאינו שווה למספר השורות שנפתחות.
//
// אבל הסיבה המכריעה מעשית ולא סגנונית: **הסינון בדפדפן סינן את החיתוך, לא
// את התקופה.** השרת החזיר 300 שורות אחרונות ואז המסנן רץ עליהן, ולכן —
//
//   • "7 הימים האחרונים" הראה בערך יממה. נמדד: 3,124 שורות בשבוע מול תקרה
//     של 300.
//   • לחיצה על "תחזוקה" הציגה רק תחזוקה שבמקרה נכנסה ל-300 החדשות. אתר שהיה
//     בתחזוקה לפני חמישה ימים לא הופיע, והמסך לא רמז שמשהו חסר.
//
// עכשיו השרת בונה את הציר המלא, מסנן, ורק אז חותך לעמוד — ראה LOG_FILTERS
// ב-db/queries.js. כאן נשארה תצוגה בלבד.
//
// שני כללים שכדאי לדעת שהם שם ולמה, כי הם נראים כמו חוסר עקביות:
//   • **'בפעולה' אינו מופיע ב"הכל"** — הוא נולד באותה שנייה עם "כניסת רכב
//     התחילה" ואינו מוסיף עליו כלום (פחות מידע: בלי כיוון ובלי כרטיס).
//     במסנן "שינויי מצב" הוא כן מופיע — שם זה התוכן, לא הרעש.
//   • **'מוכן' כן מופיע**, למרות שגם הוא נולד יחד עם סיום פעולה: הוא נושא את
//     משך ההמתנה עד הפעולה הבאה, ואין שורה אחרת שמספרת אותה.

// הצ'יפים. המונים מגיעים מהשרת ונספרים מאותו ציר שנפתח, ולכן הם שווים בהגדרה
// למספר השורות — לא במקרה ולא בקירוב.
//
// ⚠️ הקטגוריות **אינן** זרות זו לזו, וזה מכוון: מעבר ל'בתחזוקה' מהבקר נספר גם
// ב"שינויי מצב" וגם ב"תחזוקה", ופעולה שנקטעה בתקלה נספרת גם ב"פעולות" וגם
// ב"תקלות". אלה עדשות על אותו אירוע, לא ספירה כפולה בטעות.
const FILTERS = [
  { key: "all", label: "הכל" },
  { key: "operation", label: "פעולות" },
  { key: "entry", label: "כניסות" },
  { key: "exit", label: "יציאות" },
  // "תקלות" כולל גם את מקטע התקלה וגם את הפעולה שנקטעה בגללו: נמדד ש-71%
  // מהתקלות קורות תוך כדי פעולה, ומסנן שמראה רק את המקטע מספר חצי סיפור —
  // שהמתקן נפל, בלי מי היה בתוכו.
  { key: "error", label: "תקלות" },
  { key: "no_comm", label: "ניתוקים" },
  // ⚠️ שני צ'יפים ולא אחד, והם **זרים זה לזה**: repair + maintenance הם כל
  // התחזוקה, בלי חפיפה. "תפעול תקלה" קודם — הוא השאלה שנשאלת בפועל
  // ("כמה פעמים טיפלו בתקלה"), בעוד תחזוקה שגרתית היא הרקע.
  { key: "repair", label: "תפעול תקלה" },
  { key: "maintenance", label: "תחזוקה" },
  { key: "status", label: "שינויי מצב" },
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
    // ==========================================================
    // "נקטעה" ⟶ "הושלמה בתחזוקה"
    // ==========================================================
    // רכב שנתקע בתקלה אינו נשאר תקוע: מעבירים ללא-אוטומט ומכניסים אותו ידנית.
    // כשאחרי התקלה בא מצב תחזוקה, המעבר הושלם — רק לא בדרך הרגילה. "נקטעה"
    // לבדה מספרת חצי סיפור, ובדיוק את החצי המדאיג.
    const cut = e.interruptedBy;
    const rescued = cut === "error" && e.resolvedInMaintenance;

    // ==========================================================
    // התחלה שלא הגיע אליה סיום
    // ==========================================================
    // הסוכן מזהה פעולה לפי **שינוי** ב-MODE. כשהרגיסטר נתקע במצב הפעולה לא
    // נשלחת הודעת סיום — לא מאוחר, לעולם לא. נמדד באתר 2438: 21 שעות ו-26
    // דקות ב-'בפעולה' רצוף, ואז 'מוכן'.
    //
    // בלי המילים האלה השורה נראית כמו **נתון חסר** במקום כמו מכונה תקועה,
    // וזו בדיוק המסקנה ההפוכה. 6 מקרים כאלה בכל הנתונים.
    //
    // ⚠️ pending אינו unfinished: זו הפעולה האחרונה בטווח, וייתכן שהיא רצה
    // כרגע. "לא הושלמה" עליה היה קביעה שאין לנו בסיס לה.
    const phase = e.startEnd === "start"
      ? (e.unfinished ? "התחילה ולא הושלמה" : "התחילה")
      : rescued ? "הושלמה בתחזוקה"
      : cut === "error" ? "נקטעה בתקלה"
      : cut === "maintenance" ? "נקטעה בתחזוקה"
      : "הושלמה";

    const details = [];
    details.push(e.card ? `כרטיס ${e.card}` : "ללא כרטיס");
    if (e.unfinished) details.push("לא התקבלה הודעת סיום — המכונה נשארה במצב 'בפעולה'");
    else if (e.pending) details.push("טרם הסתיימה בטווח שנבחר");
    if (rescued) details.push("הרכב הועבר ידנית בתפעול תקלה");
    else if (cut) details.push("הרכב לא סיים את המעבר");
    if (e.isAnomaly) details.push("אנומליה");

    return {
      // פעולה שנקטעה נצבעת בצבע המצב שקטע אותה — היא אירוע כשל, לא תנועה
      // תקינה, והצבע מספר *מה* קטע בלי לקרוא את הטקסט.
      // פעולה שנקטעה נצבעת בצבע המצב שקטע אותה. אבל כזו שהושלמה בתחזוקה
      // אינה אירוע כשל — הרכב עבר — ולכן היא חוזרת לצבע הכיוון.
      color: e.unfinished ? (STATUS_COLORS.error.dot)
        : rescued ? color
        : cut ? (STATUS_COLORS[cut]?.dot ?? STATUS_COLORS.error.dot) : color,
      icon: isEntry ? "↓" : "↑",
      title: `${dir} ${phase}`,
      details: details.join(" · "),
      badge: e.startEnd === "start"
        ? (e.unfinished ? "ללא סיום" : e.pending ? "בתהליך" : "התחלה")
        : rescued ? "בתחזוקה" : cut ? "נקטעה" : "סיום",
      // תחזוקה אינה תקלה, ולכן היא אינה נצבעת אדום — היא עדיין קטיעה.
      badgeTone: e.unfinished ? "danger"
        : e.pending ? "warn"
        : rescued ? "warn"
        : e.isAnomaly || cut === "error" ? "danger"
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
  // ==========================================================
  // תחזוקה אחרי תקלה נקראת בשמה
  // ==========================================================
  // ⚠️ "המצב השתנה ל: בתחזוקה" מיד אחרי מקטע תקלה קורא כאילו התקלה נגמרה
  // ומשהו אחר התחיל. בפועל זו **אותה השבתה שנמשכת** — מישהו הגיע לטפל.
  // הכלל נגזר בשרת (afterError ב-shared/timeline.mjs) ולא כאן, כדי ששתי
  // הזרועות והמסכים האחרים יסכימו עליו.
  const isRepair = isPlcMaintenance && e.afterError;

  return {
    // צבע התחזוקה נשמר גם לתפעול תקלה: הוא עדיין תחזוקה לכל חישוב, וצביעה
    // באדום הייתה נספרת בעין כתקלה נוספת על אותה השבתה.
    color: c.dot,
    icon: isPlcMaintenance ? "⚙" : "●",
    // ==========================================================
    // שתי התחזוקות נקראות בלוג באותה צורה — אחרת אינן נקראות כזוג
    // ==========================================================
    // ⚠️ קודם היה כאן "תפעול תקלה" מול "המצב השתנה ל: בתחזוקה". שתי צורות
    // שונות לגמרי, ולכן מי שסורק את הלוג אינו רואה שתי קטגוריות של אותו
    // דבר — הוא רואה אירוע מיוחד אחד, ועוד שינוי מצב רגיל.
    //
    // עכשיו שתיהן שם עצם קצר, כמו במסך הזמינות ובתובנות: **תפעול תקלה**
    // מול **תחזוקה**. אותן שתי מילים בכל מקום במערכת.
    //
    // ⚠️ שאר שינויי המצב (מוכן / מושבת / מנותק) **נשארים** בניסוח
    // "המצב השתנה ל: …". הם באמת מעברים, ותחזוקה היא הדבר היחיד שיש לו
    // שתי משמעויות שצריך להבחין ביניהן.
    title: isPlcMaintenance
      ? (isRepair ? "תפעול תקלה" : "תחזוקה")
      : `המצב השתנה ל: ${label}`,
    // ==========================================================
    // תיאור התקלה מהבקר — ראשון, לפני המשך
    // ==========================================================
    // ⚠️ עד היום כל התקלות נראו זהות: "המצב השתנה ל: מושבת · נמשך 4 דק'".
    // אי אפשר היה לדעת אם זו תקלת חיישן, כרטיס שלא נקרא או תקלה מכנית —
    // ולכן גם לא לקבץ תקלות לפי סוג.
    //
    // מוצג **ראשון** כי הוא התוכן; המשך התקלה הוא ההקשר.
    //
    // ⚠️ null נבדק ולא falsy: '' פירושו שהבקר נשאל והחזיר ריק, ו-null
    // פירושו שלא נשאל כלל (תקלה היסטורית, סוכן ישן, בקר בלי התכונה).
    // שניהם אינם מציגים טקסט, אבל הם אינם אותו דבר — ואם יוצג פעם הסבר
    // למשתמש, הוא יהיה שונה.
    details: [
      e.faultText ? `"${e.faultText}"` : null,
      isRepair
        ? `החל מיד עם סיום התקלה · ${e.endedAt ? `נמשך ${dur}` : "עדיין בתפעול"}`
        : isPlcMaintenance
          ? `דווח מהבקר · ${e.endedAt ? `נמשך ${dur}` : "עדיין בתחזוקה"}`
          : e.endedAt ? `נמשך ${dur}` : "המצב הנוכחי",
    ].filter(Boolean).join(" · "),
    badge: e.endedAt ? dur : "נוכחי",
    badgeTone: e.status === "error" ? "danger" : isRepair ? "warn" : "normal",
  };
}

const PAGE = 300;

/**
 * @param log     העמוד הראשון, כפי שהגיע מוטמע בתשובת ה-insights
 * @param code    קוד האתר, או null ללוג המצרף (כל האתרים)
 * @param period  week | month | year — נדרש כדי שהדפדוף ישאל על אותה תקופה
 */
function ActivityLog({ log, code = null, period = "week" }) {
  const [filter, setFilter] = useState("all");
  const [cardInput, setCardInput] = useState("");
  const [card, setCard] = useState("");

  // page מחזיק את מה שנטען מעבר לעמוד הראשון. null = "עוד לא שאלנו כלום,
  // הצג את מה שהגיע עם ה-insights".
  const [page, setPage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // ==========================================================
  // כל שינוי במסנן או בחיפוש — שאילתה חדשה, לא סינון מקומי
  // ==========================================================
  // ⚠️ הבקשות עלולות לחזור מחוץ לסדר: לחיצה מהירה על שני צ'יפים יכולה
  // להחזיר את התשובה של הראשון *אחרי* של השני, והמסך היה מציג רשימה שאינה
  // תואמת לצ'יפ המסומן. `stale` מבטל תשובה שכבר אינה רלוונטית.
  useEffect(() => {
    // ברירת המחדל כבר בידינו מה-insights — אין טעם לשאול עליה שוב בפתיחה.
    if (filter === "all" && !card) { setPage(null); setError(null); return; }

    let stale = false;
    setBusy(true);
    setError(null);
    fetchActivity(code, { period, filter, card, offset: 0, limit: PAGE })
      .then((r) => { if (!stale) setPage(r); })
      .catch((e) => { if (!stale) setError(e.message || "שגיאה בטעינת הלוג"); })
      .finally(() => { if (!stale) setBusy(false); });
    return () => { stale = true; };
  }, [code, period, filter, card]);

  // התקופה או האתר התחלפו — העמוד שנטען שייך לשאלה הקודמת.
  useEffect(() => { setPage(null); }, [code, period]);

  const view = page || log;
  const entries = view?.entries || NO_ENTRIES;
  const counts = view?.counts || {};

  const loadMore = () => {
    setBusy(true);
    setError(null);
    fetchActivity(code, { period, filter, card, offset: entries.length, limit: PAGE })
      .then((r) =>
        // מצרפים לרשימה הקיימת במקום להחליף — "טען עוד" הוא המשך, לא עמוד נפרד.
        setPage((prev) => ({ ...r, entries: [...(prev?.entries || log?.entries || []), ...r.entries] }))
      )
      .catch((e) => setError(e.message || "שגיאה בטעינת הלוג"))
      .finally(() => setBusy(false));
  };

  // קיבוץ לימים, תוך שמירה על הסדר (מהחדש לישן)
  const days = useMemo(() => {
    const map = new Map();
    for (const e of entries) {
      const k = dayKeyOf(e.at);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
    }
    return [...map.entries()];
  }, [entries]);

  const submitCard = (ev) => { ev.preventDefault(); setCard(cardInput.trim()); };

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
            {/* המונה מגיע מהשרת ונספר מאותו ציר שנפתח. בזמן טעינה של מסנן אחר
                הוא עדיין תקף — הוא מתאר את התקופה, לא את העמוד. */}
            <span className="alog-chip-count">{counts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* חיפוש כרטיס — התשובה ל"מה עשה כרטיס 7 השבוע", שקודם דרשה גלילה ידנית */}
      <form className="alog-search" onSubmit={submitCard}>
        <input
          type="text"
          className="alog-search-input"
          placeholder="חיפוש לפי מספר כרטיס"
          value={cardInput}
          onChange={(e) => setCardInput(e.target.value)}
          inputMode="numeric"
        />
        <button type="submit" className="alog-search-btn">חפש</button>
        {card && (
          <button
            type="button"
            className="alog-search-clear"
            onClick={() => { setCardInput(""); setCard(""); }}
          >
            נקה · כרטיס {card}
          </button>
        )}
      </form>

      {error && <p className="alog-error">{error}</p>}

      {view?.capped && (
        <p className="alog-truncated">
          התקופה גדולה מכדי לטעון במלואה — המספרים והרשימה חלקיים.
        </p>
      )}

      {days.length === 0 && !busy ? (
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

      {/* ==========================================================
          "טען עוד" — ולא גלילה אינסופית
          ==========================================================
          הרשימה יכולה להיות אלפי שורות (נמדד: 2,363 בשבוע, ~13,000 בחודש).
          טעינת הכול בבת אחת היא מגה-בייטים ברשת ואלפי צמתים ב-DOM; גלילה
          אינסופית מסתירה כמה נשאר. כפתור מפורש עם המספר עונה על שתיהן. */}
      {view?.truncated && (
        <button className="alog-more" onClick={loadMore} disabled={busy}>
          {busy ? "טוען…" : `טען עוד · מוצגים ${entries.length} מתוך ${view.total}`}
        </button>
      )}

      {busy && !view?.truncated && <p className="alog-empty">טוען…</p>}
    </div>
  );
}

export default ActivityLog;
