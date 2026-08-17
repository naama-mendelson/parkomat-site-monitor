// components/InsightsModal/InsightsModal.jsx — מסך "עוד מידע":
// חמישה מסכי משנה (סקירה · פעילות · כרטיסים · אמינות · לוג), מעל בורר תקופה משותף.
import { Fragment, useEffect, useState } from "react";
import { DIRECTION_COLORS, METRIC_COLORS, PEAK_COLOR } from "../../utils/constants";
import { useSiteInsights, useGlobalInsights } from "../../hooks/useSiteInsights";
import PeriodTabs from "../PeriodTabs/PeriodTabs";
import MetricCard from "../MetricCard/MetricCard";
import BarChart from "../BarChart/BarChart";
import DonutChart from "../DonutChart/DonutChart";
import ActivityLog from "../ActivityLog/ActivityLog";
import SectionNav from "./SectionNav";
import "./InsightsModal.css";
import Logo from "../Logo/Logo";

const ENTRY_COLOR = DIRECTION_COLORS.entry;   // כחול — כניסות
const EXIT_COLOR = DIRECTION_COLORS.exit;     // ליים המותג — יציאות
// אותו אדום של תקלה בכל המערכת — כדי שהעין תקשר מיד, בלי לקרוא כותרת.
const FAULT_COLOR = METRIC_COLORS.errors;

// שני הכיוונים, בסדר קבוע ובצבעי הכיוון — משמש בטבלת זמני הפעולה.
const DIRECTIONS = [
  { key: "entry", label: "כניסה", color: ENTRY_COLOR },
  { key: "exit",  label: "יציאה", color: EXIT_COLOR },
];

// סדרת "הפעולות" בגרפי הפעילות — פעילות כוללת ולא כיוון תנועה, ולכן
// היא נושאת את צבע מדד הפעולות המשותף (כחול המותג).
const ACTIVITY_COLOR = METRIC_COLORS.operations;

// שניות → טקסט קריא ("1 דק' 18 שנ'" / "45 שניות")
function fmtSeconds(s) {
  if (s === null || s === undefined) return "—";
  if (s < 60) return `${Math.round(s)} שניות`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest === 0 ? `${m} דקות` : `${m} דק' ${rest} שנ'`;
}

// שעות → טקסט קריא
function fmtHours(h) {
  if (!h) return "0";
  if (h < 1) return `${Math.round(h * 60)} דקות`;
  return `${Math.round(h * 10) / 10} שעות`;
}

function InsightsModal({ site, period, onPeriodChange, version, onClose, initialSection = "overview", allSites = false }) {
  // ⚠️ `requested` ולא `section`: הרשימה תלויה ב-allSites (ראה sections
  // למטה), ולכן שונית שהתבקשה עשויה לא להתקיים. הערך האפקטיבי נגזר שם.
  const [requested, setSection] = useState(initialSection);
  // איזו שורה בטבלת הכרטיסים פתוחה. אחת בכל רגע — פתיחת כולן הופכת את
  // הטבלה לרשימה ארוכה ומאבדת את ההשוואה שהיא באה לתת.
  const [openCard, setOpenCard] = useState(null);
  // מפעילים רק את ההוק הרלוונטי (כלל ה-hooks: שניהם נקראים תמיד, אחד מושבת
  // דרך enabled). מצב "כל האתרים" מצרף על כל המערכת ואינו תלוי ב-site.
  const siteRes = useSiteInsights(site?.code, period, { version, enabled: !allSites });
  const globalRes = useGlobalInsights(period, { version, enabled: allSites });
  const { data, loading, error } = allSites ? globalRes : siteRes;

  // סגירה ב-Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ============================================================
  // ⚠️ counts.all — ולא סכום של שלושה שדות
  // ============================================================
  // כאן היה `counts.operations + counts.status + counts.maintenance`, מימים
  // שבהם המונים היו שלושה שדות נפרדים שה-SQL ספר. מאז הם נבנים מהציר עצמו
  // ומפתחותיהם הם שמות המסננים (all / operation / error / entry …), ואין
  // בהם `operations` כלל.
  //
  // **התוצאה הייתה NaN על השונית** — `undefined + 142 + 4`. לא שגיאה, לא
  // מסך ריק, רק שלוש אותיות שנראות כמו תקלה עמוקה.
  //
  // ⚠️ ולמה שום שער לא תפס: כל השערים משווים בין **שתי הזרועות**, ושתיהן
  // מחזירות את אותו מבנה חדש. זהו צרכן שלא עודכן — סוג כשל שרק המסך מגלה.
  //
  // `all` הוא בדיוק מה שהצ'יפ "הכל" מציג, ולכן השונית והצ'יפ מסכימים בהגדרה.
  const logCount = data?.log?.counts?.all ?? null;

  // ============================================================
  // ⚠️ "משתמשים" אינו מוצג במבט המצרף — החלטת מוצר
  // ============================================================
  // המבט של מנהל כללי מסכם **מערכת**, ולא אנשים. פילוח של מחזיקי כרטיסים
  // בודדים הוא פרט תפעולי בגובה הלא נכון שם, והוא גם חושף פעילות של אנשים
  // מזוהים במסך שנועד למספרים.
  //
  // ⚠️ ובאתר בודד הוא **נשאר** ומועיל: שם "מי הכי פעיל" ו"מי נתקל בתקלות"
  // הן שאלות תפעוליות אמיתיות, וכל השורות מאותו אתר.
  //
  // ⚠️ ובדרך זה מסיר גם תקלה: העמודה "אתר" בטבלה ההיא מוצגת **רק** במצרפת,
  // והיא הייתה ריקה תמיד — `siteNames` מועבר ל-computeInsights רק בזרוע
  // השרת (db/queries.js) ולא בזרוע הישירה. הפער עצמו נשאר בנתונים; מה
  // שנעלם הוא המקום היחיד שהציג אותו.
  const sections = [
    { key: "overview", label: "סקירה" },
    { key: "activity", label: "פעילות" },
    // ⚠️ "משתמשים" ולא "כרטיסים": הכרטיס הוא **האמצעי**, לא מה שנספר.
    // המספר על השונית הוא כמה אנשים שונים השתמשו באתר.
    ...(allSites ? [] : [{ key: "cards", label: "משתמשים", badge: data?.cards.uniqueCards }]),
    { key: "reliability", label: "אמינות" },
    { key: "log", label: "לוג", badge: logCount },
  ];

  // ⚠️ שונית שאינה קיימת נופלת ל"סקירה", ולא נשארת פתוחה בלי שונית.
  // הפרופ `initialSection` מאפשר לפתוח ישר על "משתמשים"; אף קורא אינו
  // עושה זאת היום, אבל במצרפת השונית הזו אינה קיימת — ואז הפאנל היה
  // מוצג **בלי שום שונית מסומנת שתוציא ממנו**.
  const section = sections.some((s) => s.key === requested) ? requested : "overview";

  return (
    <div className="insights-overlay" onClick={onClose}>
      <div className="insights-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">

        {/* ===== כותרת ===== */}
        <header className="insights-header">
          <Logo size={30} />
          <div>
            <h2>{allSites ? "כל האתרים" : site.site_name}</h2>
            <span className="insights-code">
              {allSites ? "מבט מצרף על כל המערכת" : `קוד אתר: ${site.code}`}
            </span>
          </div>
          <button className="insights-close" onClick={onClose} aria-label="סגירה">✕</button>
        </header>

        {/* ===== ניווט: תקופה + מסך ===== */}
        <div className="insights-nav">
          <PeriodTabs period={period} onChange={onPeriodChange} rangeLabel={data?.label} />
          <SectionNav sections={sections} active={section} onChange={setSection} />
        </div>

        {/* ===== תוכן ===== */}
        {loading && !data ? (
          <p className="insights-state">טוען נתונים…</p>
        ) : error && !data ? (
          <p className="insights-state insights-error">{error}</p>
        ) : !data ? null : (
          <div key={section} className={`insights-body ${loading ? "is-refreshing" : ""}`}>

            {/* ⚠️ מעל כל לשונית, לא בתוך אחת מהן: הקטיעה חלה על **כל** המספרים
                במסך הזה — שיאים, זמני פעולה, כרטיסים, אמינות — כי כולם נגזרים
                מאותה שליפה. אזהרה שיושבת בלשונית אחת נעלמת ברגע שעוברים. */}
            {data.capped && (
              <p className="insights-truncated">
                התקופה גדולה מכדי לטעון במלואה — כל המספרים במסך זה חלקיים.
              </p>
            )}

            {/* ---------- סקירה ---------- */}
            {section === "overview" && (
              <>
                <div className="insights-kpis">
                  <MetricCard label="סך פעולות" value={data.totals.operations.toLocaleString()} hint="פעולות חניה שהושלמו" accent />
                  <MetricCard label="כניסות" value={data.totals.entries.toLocaleString()} hint="רכבים שנכנסו לחניון" />
                  <MetricCard label="יציאות" value={data.totals.exits.toLocaleString()} hint="רכבים שיצאו מהחניון" />
                  {/* "כרטיסים ייחודיים" הוא שם טכני — הכרטיס הוא האמצעי, לא
                      מה שנספר. מה שמעניין הוא **כמה אנשים** השתמשו באתר.

                      ⚠️ ואינו מוצג במצרפת, מאותו טעם כמו השונית: המבט של
                      מנהל כללי מסכם מערכת ולא אנשים. גם ה-hint היה שגוי שם
                      — "פעלו **באתר**" בתצוגה שאינה של אתר. */}
                  {!allSites && (
                    <MetricCard label="משתמשים" value={data.cards.uniqueCards.toLocaleString()} hint="כמה משתמשים שונים פעלו באתר בתקופה" />
                  )}
                  <MetricCard label="ימי פעילות" value={data.totals.activeDays.toLocaleString()} hint="ימים שבהם נרשמה פעולה" />
                </div>

                <section className="insights-card">
                  <h3>חלוקת פעילות</h3>
                  <p className="insights-sub">כניסות, יציאות, תקלות ותחזוקה בתקופה</p>
                  <DonutChart
                    centerNote="אירועים"
                    slices={[
                      { label: "כניסות", value: data.totals.entries, color: ENTRY_COLOR },
                      { label: "יציאות", value: data.totals.exits, color: EXIT_COLOR },
                      // תקלות/תחזוקה = אירועים שהתחילו בתקופה (אותה יחידה כמו
                      // כניסות/יציאות, ועקבי עם "תקלות" בכרטיס ובגרף המגמה).
                      { label: "תקלות", value: data.totals.errors, color: METRIC_COLORS.errors },
                      { label: "תחזוקה", value: data.totals.maintenanceEvents, color: METRIC_COLORS.maintenance },
                    ]}
                  />
                  {data.totals.entries !== data.totals.exits && (
                    <p className="insights-note">
                      הפרש של {Math.abs(data.totals.entries - data.totals.exits)} כניסות/יציאות —
                      {data.totals.entries > data.totals.exits
                        ? " יש רכבים שנכנסו וטרם יצאו"
                        : " יש יציאות של רכבים שנכנסו לפני התקופה"}
                    </p>
                  )}
                </section>
              </>
            )}

            {/* ---------- פעילות ---------- */}
            {section === "activity" && (
              <>
                <section className="insights-card">
                  <h3>פעילות לפי שעה ביום</h3>
                  <p className="insights-sub">באילו שעות החניון עמוס — מסייע לתכנון כוח אדם ותחזוקה</p>
                  <BarChart
                    bars={data.activity.byHour.map((h) => ({ label: String(h.hour), value: h.operations }))}
                    color={ACTIVITY_COLOR}
                    highlight={data.activity.busiestHour?.operations}
                    peakColor={PEAK_COLOR}
                    unit="פעולות"
                    everyLabel={3}
                  />
                  {/* ==========================================================
                      הכיתוב חייב לספור אותן שעות שהגרף צבע
                      ==========================================================
                      ⚠️ ההדגשה בגרף נגזרת מה**ערך**, ולכן כל עמודה ששווה
                      למקסימום נצבעת. כשהיו שתי שעות עם 7 פעולות הגרף הראה שתי
                      עמודות ירוקות והכיתוב אמר "השעה העמוסה ביותר: 7:00" —
                      סתירה בתוך אותו כרטיס, ומי שקורא שואל איזה מהם נכון.

                      ⚠️ ונפילה חזרה ל-busiestHour: תגובה שנשמרה במטמון מלפני
                      השינוי עדיין מחזירה את הצורה הישנה. */}
                  {(() => {
                    const hours = data.activity.busiestHours?.length
                      ? data.activity.busiestHours
                      : [data.activity.busiestHour].filter(Boolean);
                    if (!hours.length) return null;

                    const labels = hours.map((h) => `${h.hour}:00`);
                    const joined = labels.length > 1
                      ? `${labels.slice(0, -1).join(", ")} ו-${labels[labels.length - 1]}`
                      : labels[0];

                    return (
                      <p className="insights-note">
                        {labels.length > 1 ? "השעות העמוסות ביותר: " : "השעה העמוסה ביותר: "}
                        <strong>{joined}</strong> — {hours[0].operations} פעולות
                        {labels.length > 1 ? " בכל אחת" : ""}
                      </p>
                    );
                  })()}
                </section>

                <section className="insights-card">
                  <h3>פעילות לפי יום בשבוע</h3>
                  <p className="insights-sub">אילו ימים עמוסים יותר</p>
                  {/* ⚠️ ההדגשה נגזרת מהמקסימום של הסדרה עצמה, ולא מ-busiestDay.
                      busiestDay הוא **תאריך** ספציפי (למשל 30.7), והגרף הזה
                      מקבץ לפי יום בשבוע — הצבעה לפיו הייתה מדגישה את היום
                      הלא נכון בכל שבוע שבו השיא לא נפל ביום הכי עמוס בממוצע. */}
                  <BarChart
                    bars={data.activity.byWeekday.map((w) => ({ label: w.label, value: w.operations }))}
                    color={ACTIVITY_COLOR}
                    highlight={Math.max(0, ...data.activity.byWeekday.map((w) => w.operations))}
                    peakColor={PEAK_COLOR}
                    unit="פעולות"
                  />
                </section>

                <section className="insights-card">
                  <h3>שיאים וקצב</h3>
                  <div className="insights-kpis">
                    {/* ==========================================================
                        ⚠️ רק השיא — וכל מי ששווה לו
                        ==========================================================
                        כאן הוצגו שני הימים העליונים, והשני נשא את הכותרת
                        "השני בעומסו". זה קרא כאילו שניהם ימי שיא, בעוד
                        שאחד מהם פשוט הבא בתור: 4 פעולות מול 3.

                        עכשיו נכנס יום אם ורק אם מספר הפעולות בו **שווה
                        למקסימום**. שלושה ימים עם 4 → שלושתם; יום אחד עם 4
                        והשאר 3 → רק הוא. אותו כלל בדיוק שחל על השעות.

                        ⚠️ נפילה חזרה ל-busiestDay כשהמערך חסר: זרוע השרת
                        וזרוע Supabase מריצות את אותו מודול, אבל תגובה שנשמרה
                        במטמון מלפני השינוי עדיין מחזירה את הצורה הישנה. */}
                    {(() => {
                      const days = data.activity.busiestDays?.length
                        ? data.activity.busiestDays
                        : [data.activity.busiestDay].filter(Boolean);
                      if (!days.length) return null;
                      return (
                        <MetricCard
                          label={days.length > 1 ? "הימים העמוסים ביותר" : "היום העמוס ביותר"}
                          value={String(days[0].operations)}
                          hint={`${days.map((d) => d.label).join(" · ")} — פעולות ביום`}
                          peak
                        />
                      );
                    })()}
                    {!data.activity.busiestDay && (
                      <MetricCard label="היום העמוס ביותר" value="—" hint="אין פעילות בתקופה" peak />
                    )}
                    <MetricCard label="ממוצע יומי" value={String(data.activity.dailyAverage)} hint="פעולות בממוצע ליום פעילות" />
                    {/* ⚠️ גם כאן שוויון אפשרי, ואותה סתירה: כרטיס שמראה שעה
                        אחת בזמן שהגרף מעליו צבע שתיים. הכותרת ברבים והערך
                        מונה את כולן. */}
                    {(() => {
                      const hours = data.activity.busiestHours?.length
                        ? data.activity.busiestHours
                        : [data.activity.busiestHour].filter(Boolean);
                      if (!hours.length) {
                        return <MetricCard label="השעה העמוסה" value="—" hint="אין פעילות" peak />;
                      }
                      const labels = hours.map((h) => `${h.hour}:00`);
                      return (
                        <MetricCard
                          label={hours.length > 1 ? "השעות העמוסות" : "השעה העמוסה"}
                          value={labels.join(" · ")}
                          hint={`${hours[0].operations} פעולות${hours.length > 1 ? " בכל אחת" : " בשעה זו"}`}
                          peak
                        />
                      );
                    })()}
                  </div>
                </section>
              </>
            )}

            {/* ---------- כרטיסים ---------- */}
            {section === "cards" && (
              <>
              {/* ==========================================================
                  סיכום לפני הטבלה
                  ==========================================================
                  הטבלה מדורגת לפי **פעילות**, ולכן היא עונה רק על "מי הכי
                  הרבה". "מי הכי איטי" יכול להיות כרטיס שכלל אינו בעשירייה —
                  כרטיס עם 4 פעולות איטיות במיוחד לא ייכנס לדירוג, והוא בדיוק
                  מה שמחפשים. לכן הסיכום מחושב על **כל** הכרטיסים. */}
              {data.cards.summary && (
                <section className="insights-card">
                  <h3>סיכום המשתמשים</h3>
                  <p className="insights-sub">
                    על כל {data.cards.uniqueCards} המשתמשים בתקופה — לא רק המוצגים בטבלה
                  </p>
                  <div className="insights-kpis">
                    {/* ⚠️ מהיר **לכל כיוון בנפרד**. ממוצע על שני הכיוונים יחד
                        מערבב שתי פעולות מכניות שונות — נמדד שכניסה ארוכה
                        מיציאה ב-31%, ובאתר אחד הכיוון מתהפך. "הכרטיס המהיר"
                        בלי כיוון הוא בעיקר הכרטיס שבמקרה יצא יותר משנכנס. */}
                    <MetricCard
                      label="הכי מהיר בכניסה"
                      value={data.cards.summary.fastestEntry
                        ? `כרטיס ${data.cards.summary.fastestEntry.card}` : "—"}
                      hint={data.cards.summary.fastestEntry
                        ? `${fmtSeconds(data.cards.summary.fastestEntry.averageSeconds)} בממוצע · ${data.cards.summary.fastestEntry.samples} כניסות`
                        : `אין כרטיס עם ${data.cards.summary.minSamples} כניסות ומעלה`}
                      tone={ENTRY_COLOR}
                    />
                    <MetricCard
                      label="הכי מהיר ביציאה"
                      value={data.cards.summary.fastestExit
                        ? `כרטיס ${data.cards.summary.fastestExit.card}` : "—"}
                      hint={data.cards.summary.fastestExit
                        ? `${fmtSeconds(data.cards.summary.fastestExit.averageSeconds)} בממוצע · ${data.cards.summary.fastestExit.samples} יציאות`
                        : `אין כרטיס עם ${data.cards.summary.minSamples} יציאות ומעלה`}
                      tone={EXIT_COLOR}
                    />
                    <MetricCard
                      label="הכי פעיל"
                      value={data.cards.summary.mostActive
                        ? `כרטיס ${data.cards.summary.mostActive.card}` : "—"}
                      hint={data.cards.summary.mostActive
                        ? `${data.cards.summary.mostActive.total} פעולות בתקופה` : "—"}
                      tone={ENTRY_COLOR}
                      accent
                    />
                    <MetricCard
                      label="הכי הרבה תקלות"
                      value={data.cards.summary.mostFaults
                        ? `כרטיס ${data.cards.summary.mostFaults.card}` : "אין"}
                      hint={data.cards.summary.mostFaults
                        ? `${data.cards.summary.mostFaults.faults} תקלות בזמן מעבר`
                        : "לא קרתה תקלה תוך כדי מעבר"}
                      tone={data.cards.summary.mostFaults ? FAULT_COLOR : undefined}
                    />
                  </div>
                  {/* ⚠️ הסף נאמר במפורש. "הכי מהיר" בלי סף הוא תמיד כרטיס
                      שנמדד פעם אחת במקרה — מספר שנראה מדויק ואינו אומר כלום. */}
                  <p className="insights-note">
                    המהירים מחושבים על משתמשים שנמדדו לפחות {data.cards.summary.minSamples} פעמים
                    באותו כיוון — {data.cards.summary.timedEntry} בכניסה,
                    {" "}{data.cards.summary.timedExit} ביציאה.
                    כרטיס עם מדידה בודדת אינו מדגם.
                  </p>
                </section>
              )}

              <section className="insights-card">
                <h3>המשתמשים הפעילים ביותר</h3>
                <p className="insights-sub">מי השתמש באתר הכי הרבה בתקופה</p>

               {data.cards.top.length > 0 ? (
                  <>
                    <table className="insights-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>כרטיס</th>
                          {/* ⚠️ רק במצרפת. באתר בודד כל השורות מאותו אתר,
                              ועמודה שחוזרת על אותו ערך 10 פעמים היא רעש. */}
                          {allSites && <th>אתר</th>}
                          <th>סך פעולות</th>
                          <th>כניסות</th>
                          <th>יציאות</th>
                          {/* ==========================================================
                              תקלות שקרו *בזמן* שהכרטיס עבר
                              ==========================================================
                              לא "תקלות של הכרטיס" — הכרטיס אינו אשם בהכרח. זו נוכחות:
                              המחסום נכשל בזמן שהרכב הזה עבר. כרטיס שחוזר כאן מצביע על
                              כרטיס שהקורא מתקשה בו או על רכב שמפעיל את החיישן בעייתי. */}
                          <th>תקלות בכניסה</th>
                          <th>תקלות ביציאה</th>
                          <th>שימוש אחרון</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.cards.top.map((c, i) => {
                          // ⚠️ **המפתח חייב לכלול את האתר.** במצרפת "כרטיס 4"
                          // מופיע בכמה אתרים, ומפתח לפי המספר בלבד היה גם
                          // מייצר מפתחות כפולים ב-React וגם פותח את כל השורות
                          // בעלות אותו מספר בלחיצה אחת.
                          const rowKey = `${c.siteId}|${c.card}`;
                          return (
                          <Fragment key={rowKey}>
                          {/* ==========================================================
                              לחיצה על שורה פותחת את זמני הפעולה של אותו כרטיס
                              ==========================================================
                              הטבלה עונה "מי הכי פעיל". השאלה הבאה היא תמיד "ולמה
                              דווקא הוא איטי" — ונמדד שיש הבדלים אמיתיים בין
                              כרטיסים באותו אתר (2438: ממוצע כניסה 2,096 שניות
                              לכרטיס 7 מול 337 לכרטיס 6, פי שישה).

                              בשורה מתקפלת ולא בעמודות נוספות: שש עמודות זמן
                              נוספות היו הופכות את הטבלה לבלתי קריאה במסך צר,
                              בזמן שהמידע מעניין רק לכרטיס אחד בכל פעם. */}
                          <tr
                            className={`is-expandable ${openCard === rowKey ? "is-open" : ""}`}
                            onClick={() => setOpenCard(openCard === rowKey ? null : rowKey)}
                            title="לחצי לראות כמה זמן לוקחת לו כניסה ויציאה"
                          >
                            <td className="rank">{i + 1}</td>
                            <td className="card-num">
                              <span className="row-caret">{openCard === rowKey ? "▾" : "▸"}</span>
                              {c.card}
                            </td>
                            {allSites && <td className="muted">{c.siteName || "—"}</td>}
                            <td><strong>{c.total}</strong></td>
                            <td><span className="pill" style={{ background: ENTRY_COLOR }}>{c.entries}</span></td>
                            <td><span className="pill" style={{ background: EXIT_COLOR }}>{c.exits}</span></td>
                            {/* אפס נשאר דהוי ולא נצבע: טבלה שכולה גלולות אדומות מאבדת
                                את מה שהיא באה להבליט. */}
                            <td>
                              {c.faultsOnEntry > 0
                                ? <span className="pill" style={{ background: FAULT_COLOR }}>{c.faultsOnEntry}</span>
                                : <span className="muted">0</span>}
                            </td>
                            <td>
                              {c.faultsOnExit > 0
                                ? <span className="pill" style={{ background: FAULT_COLOR }}>{c.faultsOnExit}</span>
                                : <span className="muted">0</span>}
                            </td>
                            <td className="muted">
                              {c.lastAt ? new Date(c.lastAt).toLocaleString("he-IL", {
                                day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                              }) : "—"}
                            </td>
                          </tr>

                          {openCard === rowKey && (
                            <tr className="row-detail">
                              <td colSpan={allSites ? 9 : 8}>
                                {/* ==========================================================
                                    גם כאן — שורה לכל כיוון
                                    ==========================================================
                                    היו כאן "הפעולה הארוכה" ו"הקצרה" **על שני
                                    הכיוונים יחד**, וזה חסר תועלת: הקיצון כמעט
                                    תמיד שייך לכיוון אחד, ובלי לדעת לאיזה אי
                                    אפשר לעשות איתו כלום. כרטיס עם יציאה של 30
                                    דקות נראה בדיוק כמו כרטיס עם כניסה של 30.

                                    אותו מבנה בדיוק כמו למעלה — שתי שורות, אותם
                                    ארבעה מדדים, אותו סדר. */}
                                {c.durations ? (
                                  <div className="card-duration-rows">
                                    {DIRECTIONS.map(({ key, label, color }) => {
                                      const s = c.durations[key];
                                      return (
                                        <div key={key} className="card-duration-row">
                                          <span className="cd-dir" style={{ color }}>
                                            <span className="duration-dot" style={{ background: color }} />
                                            {label}
                                          </span>
                                          {[
                                            ["ממוצע", "averageSeconds"],
                                            ["חציון", "medianSeconds"],
                                            ["הארוכה", "longestSeconds"],
                                            ["הקצרה", "shortestSeconds"],
                                          ].map(([lbl, field]) => (
                                            <div key={field} className="card-duration">
                                              <span className="cd-label">{lbl}</span>
                                              <strong>{s ? fmtSeconds(s[field]) : "—"}</strong>
                                            </div>
                                          ))}
                                          <span className="cd-samples">
                                            {s ? `${s.samples} מדגמים` : "אין מדידות"}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <p className="insights-note">לא נמדדו זמני פעולה לכרטיס זה בתקופה</p>
                                )}
                              </td>
                            </tr>
                          )}
                          </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                    {/* ==========================================================
                        "X פעולות עם כרטיס מזוהה" — הוסר
                        ==========================================================
                        השורה חילקה את הפעולות ל"עם כרטיס" ו"ללא כרטיס" כאילו
                        שתיהן תקינות. הן לא: **אין דבר כזה פעולה בלי כרטיס
                        מזהה** — כל מעבר מתחיל בהעברת כרטיס. סגירה בלי כרטיס
                        אינה תכונה של הפעולה אלא כשל רישום, ושני הכשלים שגרמו
                        לו כבר תוקנו (רגיסטר שמתאפס לפני סוף הפעולה, וכרטיס
                        שנגנב מהפעולה הבאה — ראה tools/backfill-cards.js).
                        הצגתה כמידע לגיטימי הפכה שארית של באג למדד. */}
                  </>
                ) : (
                  <p className="insights-note">לא נרשמו פעולות בתקופה זו</p>
                )}
              </section>
              </>
            )}

            {/* ---------- אמינות ---------- */}
            {section === "reliability" && (
              <>
                {/* ==========================================================
                    משך פעולה — **רק** לפי כיוון
                    ==========================================================
                    היו כאן קודם ארבעה כרטיסי מדד לממוצע הכולל, ומתחתם הפילוח.
                    זה היה גם צפוף וגם מטעה: **הממוצע הכולל אינו מספר שמישהו
                    יכול לפעול לפיו**, כי כניסה ויציאה אינן אותה פעולה מכנית —
                    הכנסת רכב היא חיפוש תא פנוי והנחה, הוצאה היא איתור תא ידוע
                    ומשיכה.

                    נמדד: חציון כניסה 427 שניות מול יציאה 325 — **כניסה ארוכה
                    ב-31%**, והפער נבלע לגמרי ב-357 המשותף. אתר 1348 אפילו
                    הפוך (יציאה ארוכה ב-58%), וזה בדיוק מה שממוצע אחד מסתיר.

                    טבלה ולא כרטיסים: הערך כאן הוא ב**השוואה**, ושתי עמודות
                    זו לצד זו קוראות אותה במבט אחד. */}
                <section className="insights-card">
                  <h3>משך פעולה</h3>
                  <p className="insights-sub">כמה זמן לוקח למכונה להשלים פעולה, מרגע ההתחלה ועד הסיום</p>

                  {/* ==========================================================
                      שורה לכל כיוון — ולא רשת אחת של שש
                      ==========================================================
                      ברשת אחת הכרטיסים נשברו 5+1: "הפעולה הקצרה" נשארה לבדה
                      בשורה שנייה, מנותקת מהקבוצה שלה. וגרוע מזה — הסדר ערבב
                      כניסה ויציאה, כך שההשוואה בין השתיים דרשה לקפוץ הלוך ושוב.

                      שתי שורות מקבילות עם אותם ארבעה מדדים באותו סדר: העין
                      משווה **מלמעלה למטה באותה עמודה**, וזו הצורה היחידה שבה
                      "כניסה ארוכה מיציאה" נקרא במבט אחד. */}
                  {(data.durationsByDirection?.entry || data.durationsByDirection?.exit) ? (
                    <div className="duration-rows">
                      {DIRECTIONS.map(({ key, label, color }) => {
                        const s = data.durationsByDirection?.[key];
                        return (
                          <div key={key} className="duration-row">
                            <div className="duration-row-head">
                              <span className="duration-dot" style={{ background: color }} />
                              <strong style={{ color }}>{label}</strong>
                              <span className="duration-row-note">
                                {s ? `${s.samples} מדגמים` : "אין מדידות"}
                              </span>
                            </div>
                            <div className="insights-kpis">
                              <MetricCard
                                label="ממוצע"
                                value={s ? fmtSeconds(s.averageSeconds) : "—"}
                                hint="הזמן הטיפוסי"
                                tone={color}
                                accent
                              />
                              <MetricCard
                                label="חציון"
                                value={s ? fmtSeconds(s.medianSeconds) : "—"}
                                hint="מחצית מהפעולות מהירות מזה"
                                tone={color}
                              />
                              <MetricCard
                                label="הארוכה ביותר"
                                value={s ? fmtSeconds(s.longestSeconds) : "—"}
                                hint="המשך הארוך שנמדד"
                                tone={color}
                              />
                              <MetricCard
                                label="הקצרה ביותר"
                                value={s ? fmtSeconds(s.shortestSeconds) : "—"}
                                hint="המשך הקצר שנמדד"
                                tone={color}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="insights-note">לא נמדדו פעולות שלמות בתקופה זו</p>
                  )}
                </section>

                {/* ==========================================================
                    שלוש קטגוריות, ולא שתי כותרות שחופפות
                    ==========================================================
                    קודם היו כאן שני כרטיסים — "השבתות ותקלות" ו"תחזוקה" —
                    ואותה עובדה הופיעה בשניהם בשני שמות: "הסתיימו בתפעול"
                    בראשון ו"תפעולי תקלה" בשני הם **אותם אירועים בדיוק**.
                    מי שקורא אותם רואה שני מספרים ואינו יודע שהם אחד.

                    שלוש קטגוריות, כל אחת נאמרת פעם אחת:

                      תקלה        — המכונה נשברה.        נספר באחוז הכשל.
                      תפעול תקלה — נפתח תפעול אחרי התקלה.  אינו נספר.
                      תחזוקה      — מישהו בחר להוריד.    אינו נספר.

                    ⚠️ וההבדל בין השורה השנייה לשלישית אינו סמנטי בלבד: הראשונה
                    היא **תוצאה** של נפילה, והשנייה היא **החלטה**
                    (סימן טוב). ערבובן מייפה את התמונה — אתר שנופל שלוש פעמים
                    בשבוע נראה כמו אתר שעובר תחזוקה מסודרת. */}
                <section className="insights-card">
                  <h3>זמן שהאתר לא שירת רכבים</h3>

                  {/* ⚠️ שורת הסיכום מציגה את שלוש הקטגוריות **זו לצד זו**,
                      כי השאלה הראשונה שנשאלת היא היחס ביניהן: 5 שעות תקלה
                      מול 5 שעות תחזוקה הם שני אתרים שונים לגמרי. */}
                  <div className="insights-kpis">
                    <MetricCard
                      label="בתקלה"
                      value={fmtHours(data.downtime.totalHours)}
                      hint={`${data.downtime.incidents} אירועים · נספר באחוז הכשל`}
                      accent
                    />
                    <MetricCard
                      label="תפעול תקלה"
                      value={fmtHours(data.maintenance.repairHours ?? 0)}
                      hint={`${data.maintenance.repairEntries ?? 0} תפעולים · אינו נספר`}
                    />
                    <MetricCard
                      label="תחזוקה"
                      value={fmtHours(data.maintenance.plannedHours ?? 0)}
                      hint={`${data.maintenance.plannedEntries ?? 0} פעמים · אינו נספר`}
                    />
                  </div>
                </section>

                {/* ---------- 1 · תקלה ---------- */}
                <section className="insights-card">
                  <h3>תקלות</h3>
                  {/* ==========================================================
                      תקלה שטופלה אינה כמו תקלה שנפתרה מעצמה
                      ==========================================================
                      שתיהן "תקלה" באותו מספר, והן שני דברים שונים: תפעול
                      פירושו שמישהו התערב, והתאוששות עצמית היא לרוב ריצוד
                      שהמכונה ניקתה לבד.

                      ⚠️ **ומה שאיננו יודעים לא נאמר.** אין בנתונים שום דבר
                      שמבחין בין תפעול מרחוק לבין הגעה פיזית לאתר — הסימן
                      היחיד הוא שנפתח מקטע תחזוקה. ניסוח כמו "דרשו הגעה
                      לאתר" היה מציג מסקנה שלא נמדדה, ובמספר שנראה מדויק.

                      אתר עם 5 תקלות שכולן נפתרו לבד הוא סיפור אחר לגמרי
                      מאתר עם 5 שכולן הצריכו תפעול, ובמספר אחד הם זהים. */}
                  <div className="insights-kpis">
                    <MetricCard
                      label="כמה תקלות"
                      value={String(data.downtime.incidents)}
                      hint="פעמים שהאתר נכנס לתקלה"
                    />
                    <MetricCard
                      label="סך זמן"
                      value={fmtHours(data.downtime.totalHours)}
                      hint="שתי הקטגוריות למטה יחד"
                    />
                    <MetricCard
                      label="הארוכה ביותר"
                      value={fmtHours(data.downtime.longestHours)}
                      hint={data.downtime.longestAt
                        ? `החלה ב-${new Date(data.downtime.longestAt).toLocaleDateString("he-IL")}`
                        : "לא היו תקלות"}
                    />
                    <MetricCard
                      label="זמן חזרה ממוצע"
                      value={fmtHours(data.downtime.averageHours)}
                      hint="כמה זמן בממוצע לוקח לחזור לפעילות"
                    />
                  </div>

                  {/* ⚠️ הפילוח בשורה נפרדת ומוזח — הוא **חלוקה של המספר
                      שמעליו**, לא שני מדדים נוספים. שורה אחת של שישה כרטיסים
                      שווים הסתירה בדיוק את היחס הזה. */}
                  {data.downtime.incidents > 0 && (
                    <div className="insights-kpis insights-kpis--sub">
                      <MetricCard
                        label="↳ טופלו"
                        value={String(data.downtime.handledIncidents ?? 0)}
                        hint={(data.downtime.handledIncidents ?? 0) === 0
                          ? "אף תקלה לא הצריכה תפעול"
                          : `${fmtHours(data.downtime.handledHours)} — נפתח תפעול מיד בסיומן`}
                      />
                      <MetricCard
                        label="↳ התאוששו מעצמן"
                        value={String(data.downtime.recoveredIncidents ?? data.downtime.incidents)}
                        hint={(data.downtime.recoveredIncidents ?? data.downtime.incidents) === 0
                          ? "כל התקלות דרשו תפעול"
                          : `${fmtHours(data.downtime.recoveredHours ?? data.downtime.totalHours)} — האתר חזר לבד`}
                      />
                    </div>
                  )}

                  {data.downtime.incidents === 0 && (
                    <p className="insights-note insights-good">✓ לא נרשמו תקלות בתקופה זו</p>
                  )}
                </section>

                {/* ---------- 2 · תפעול תקלה ---------- */}
                <section className="insights-card">
                  <h3>תפעול תקלה</h3>
                  {/* ⚠️ ההבחנה היא **מה קדם למקטע**, לא מה נרשם בו: מקטע
                      תחזוקה שמתחיל בדיוק בשנייה שבה נגמרה תקלה הוא תפעול.
                      הזיהוי חד-משמעי ואינו הערכה. */}
                  <p className="insights-sub">
                    תחזוקה שהתחילה מיד עם סיום תקלה
                  </p>
                  <div className="insights-kpis">
                    <MetricCard
                      label="כמה תפעולים"
                      value={String(data.maintenance.repairEntries ?? 0)}
                      hint={(data.maintenance.repairEntries ?? 0) === 0
                        ? "לא הייתה תחזוקה בעקבות תקלה"
                        : "כל אחד מהם מתחיל בדיוק כשתקלה נגמרה"}
                    />
                    <MetricCard
                      label="סך זמן"
                      value={fmtHours(data.maintenance.repairHours ?? 0)}
                      hint="אינו נספר באחוז הכשל"
                    />
                    <MetricCard
                      label="הארוך ביותר"
                      value={fmtHours(data.maintenance.longestRepairHours ?? 0)}
                      hint="התפעול הארוך ביותר"
                    />
                  </div>

                  {(data.maintenance.repairEntries ?? 0) === 0 && (
                    <p className="insights-note insights-good">
                      ✓ אף תקלה בתקופה זו לא הצריכה תפעול
                    </p>
                  )}
                </section>

                {/* ---------- 3 · תחזוקה ---------- */}
                <section className="insights-card">
                  <h3>תחזוקה</h3>
                  <p className="insights-sub">
                    מישהו בחר להוריד את האתר — החלטה, ולא תוצאה של נפילה
                  </p>
                  <div className="insights-kpis">
                    <MetricCard
                      label="כמה פעמים"
                      value={String(data.maintenance.plannedEntries ?? data.maintenance.plcEntries)}
                      hint={(data.maintenance.plannedEntries ?? data.maintenance.plcEntries) === 0
                        ? "לא נרשמה תחזוקה ללא תקלה שקדמה לה"
                        : "ללא תקלה שקדמה להן"}
                    />
                    <MetricCard
                      label="סך זמן"
                      value={fmtHours(data.maintenance.plannedHours ?? 0)}
                      hint="אינו נספר באחוז הכשל"
                    />
                    <MetricCard
                      label="הארוכה ביותר"
                      value={fmtHours(data.maintenance.longestPlannedHours ?? 0)}
                      hint="חלון התחזוקה הארוך ביותר"
                    />
                    {/* ⚠️ החלון הידני נספר תמיד כתחזוקה ולא כתפעול: מישהו לחץ
                        על כפתור, וזו החלטה לפי הגדרה. */}
                    <MetricCard
                      label="חלונות ידניים"
                      value={String(data.maintenance.manualWindows)}
                      hint="הופעלו מהדשבורד (השאר דווחו מהבקר)"
                    />
                  </div>

                  {data.maintenance.recentWindows.length > 0 && (
                    <table className="insights-table">
                      <thead>
                        <tr>
                          {allSites && <th>אתר</th>}
                          <th>מי הפעיל</th>
                          <th>מתי</th>
                          <th>משך מתוכנן</th>
                          <th>סיבה</th>
                          <th>סטטוס</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.maintenance.recentWindows.map((w, i) => (
                          <tr key={i}>
                            {allSites && <td>{w.siteName || "—"}</td>}
                            <td className="card-num">{w.setBy}</td>
                            <td className="muted">
                              {new Date(w.startedAt).toLocaleString("he-IL", {
                                day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
                              })}
                            </td>
                            <td>{w.durationHours} שע'</td>
                            <td className="muted">{w.reason || "—"}</td>
                            <td>{w.cancelled ? "בוטל" : "הופעל"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {data.maintenance.plcEntries === 0 && data.maintenance.manualWindows === 0 && (
                    <p className="insights-note">לא נרשמה תחזוקה בתקופה זו</p>
                  )}
                </section>
              </>
            )}

            {/* ---------- לוג ---------- */}
            {section === "log" && (
              <section className="insights-card">
                <h3>לוג פעילות מלא</h3>
                <p className="insights-sub">
                  כל האירועים בתקופה — כניסות ויציאות, שינויי מצב וחלונות תחזוקה, מהחדש לישן
                </p>
                {/* code=null במצב "כל האתרים" — הלוג המצרף. הוא גם מה שקובע
                    לאיזה endpoint הדפדוף פונה. */}
                <ActivityLog
                  log={data.log}
                  code={allSites ? null : site?.code}
                  period={period}
                />
              </section>
            )}

          </div>
        )}
      </div>
    </div>
  );
}

export default InsightsModal;
