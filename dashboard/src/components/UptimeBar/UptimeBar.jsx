// components/UptimeBar/UptimeBar.jsx — זמינות האתר: אחוז ראשי, שורה צבעונית ופירוט שעות
import { UPTIME_COLORS } from "../../utils/constants";
import "./UptimeBar.css";

// עיצוב שעות בעברית קריאה: "12.5 שעות" / "45 דקות"
function formatHours(hours) {
  if (hours <= 0) return "0";
  if (hours < 1) return `${Math.round(hours * 60)} דקות`;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} שעות`;
}

function UptimeBar({ uptime, trend }) {
  const {
    readyHours, operatingHours, errorHours,
    maintenanceHours, repairHours = 0, plannedHours = 0,
    noCommHours, totalHours, measuredHours, availabilityPercent,
  } = uptime;

  // אין מקטעי מצב בטווח — אין מה לחשב, ואסור להציג 0% שנראה כמו כשל.
  if (!totalHours || totalHours <= 0) {
    return (
      <section className="uptime">
        <header className="uptime-head">
          <h3>זמינות האתר</h3>
          <p className="uptime-sub">כמה מהזמן האתר היה זמין לקבל רכבים</p>
        </header>
        <p className="uptime-empty">אין נתוני מצב לתקופה זו</p>
      </section>
    );
  }

  const availableHours = readyHours + operatingHours;
  const pct = (h) => (h / totalHours) * 100;

  // המקטעים בשורה הצבעונית — בצבעי המצב המערכתיים (מוכן ירוק, בפעולה כחול),
  // אותם צבעים בדיוק כמו בתגית המצב ובדונאט. מה שמבהיר שהכחול הוא חלק
  // מהזמינות אינו הגוון אלא שורות-המשנה במקרא (ראה rows למטה).
  const segments = [
    {
      key: "ready", hours: readyHours, color: UPTIME_COLORS.availableReady,
      title: `מוכן — ${formatHours(readyHours)} (חלק מהזמינות)`,
    },
    {
      key: "operating", hours: operatingHours, color: UPTIME_COLORS.availableOperating,
      title: `בפעולה — ${formatHours(operatingHours)} (חלק מהזמינות)`,
    },
    {
      key: "error", hours: errorHours, color: UPTIME_COLORS.error,
      title: `מושבת — ${formatHours(errorHours)}`,
    },
    {
      key: "maintenance", hours: maintenanceHours, color: UPTIME_COLORS.maintenance,
      title: `בתחזוקה — ${formatHours(maintenanceHours)}`,
    },
    {
      key: "no_comm", hours: noCommHours, color: UPTIME_COLORS.no_comm,
      title: `ללא תקשורת — ${formatHours(noCommHours)} (מחוץ לחישוב)`,
    },
  ].filter((s) => s.hours > 0);

  // ==========================================================
  // הכלל של המקרא: לכל מקטע בפס יש שורה משלו. בלי יוצאי דופן.
  // ==========================================================
  // 'בפעולה' הוא כחול ומהווה חלק מהזמינות — שילוב שנראה סותר, ובאמת בלבל.
  // נוסו שני פתרונות: קודם להשאיר את הכחול בלי שורה במקרא (ואז הוא נקרא
  // כמשהו שאינו זמינות, למרות שהוא רובה), ואחר כך לצבוע אותו בירוק כהה
  // (ואז השאלה הפכה ל"מה הירוק הכהה הזה?"). שניהם אותו כשל: מקטע בפס בלי
  // שורה משלו במקרא.
  //
  // מה שעובד: 'זמין לשירות' הוא כותרת עם הסיכום, ומתחתיה **שתי שורות-משנה**
  // — 'מוכן' ו'בפעולה' — כל אחת בצבע המדויק של המקטע שלה. אפשר להצביע על
  // כל צבע בפס, לרדת למקרא, ולמצוא אותו בשם. ברגע שיש הסבר, הצבע חופשי
  // להיות הצבע המערכתי הנכון.
  const rows = [
    {
      key: "available",
      label: "זמין לשירות",
      explain: "האתר היה זמין לקבל רכבים",
      hours: availableHours,
      color: UPTIME_COLORS.availableReady,
      // שורות-המשנה הן ההסבר לשני המקטעים הירוקים בפס.
      children: [
        { key: "ready", label: "מוכן", hours: readyHours, color: UPTIME_COLORS.availableReady },
        { key: "operating", label: "בפעולה", hours: operatingHours, color: UPTIME_COLORS.availableOperating },
      ],
    },
    {
      key: "error",
      label: "מושבת",
      explain: "האתר לא יכול היה לפעול עקב תקלה",
      hours: errorHours,
      color: UPTIME_COLORS.error,
    },
    // ==========================================================
    // תחזוקה וטיפול בתקלה — מפוצל **רק כשיש מה לפצל**
    // ==========================================================
    // ⚠️ תחזוקה היא **החלטה** (מישהו בחר להוריד את האתר), וטיפול בתקלה הוא
    // **תוצאה** של נפילה — מבחינת מי שרצה לחנות זו אותה השבתה שנמשכת. שורה
    // אחת לשתיהן מייפה את התמונה: אתר שנופל שלוש פעמים בשבוע ומטופל נראה
    // כמו אתר בתחזוקה שוטפת מסודרת.
    //
    // ⚠️ אבל כשקיים רק סוג אחד, שורת-אב ושורת-בת נושאות **בדיוק אותו מספר**
    // — "0.1% בתחזוקה · 10 דקות" ומתחתיה "0.1% טיפול בתקלה · 10 דקות".
    // זה נקרא כמו כפילות ולא כמו פילוח, והתפריט מציג עומק שאין בו מידע.
    //
    // לכן: שני סוגים ⟹ אב + שתי בנות. סוג אחד ⟹ **שורה אחת בשמו המדויק**,
    // שהיא גם מדויקת יותר מ"בתחזוקה" הגנרי.
    (() => {
      const both = repairHours > 0 && plannedHours > 0;
      if (both) {
        // ⚠️ שורת האב היא **"סך התחזוקה"** ולא "בתחזוקה", מרגע שהבת נקראת
        // "תחזוקה": אב ובת באותו שם קוראים כמו כפילות, ומי שרואה אותם זה
        // מעל זה אינו יודע אם המספר העליון כולל את התחתון או חוזר עליו.
        return {
          key: "maintenance",
          label: "סך התחזוקה",
          explain: "אינו נכלל בחישוב הזמינות",
          hours: maintenanceHours,
          color: UPTIME_COLORS.maintenance,
          children: [
            { key: "repair", label: "טיפול בתקלה", hours: repairHours,
              color: UPTIME_COLORS.maintenance },
            { key: "planned", label: "תחזוקה", hours: plannedHours,
              color: UPTIME_COLORS.maintenance },
          ],
        };
      }
      const onlyRepair = repairHours > 0;
      return {
        key: "maintenance",
        label: onlyRepair ? "טיפול בתקלה" : "בתחזוקה",
        explain: onlyRepair
          ? "התחילה מיד אחרי תקלה — אינה נכללת בחישוב הזמינות"
          : "אינו נכלל בחישוב הזמינות",
        hours: maintenanceHours,
        color: UPTIME_COLORS.maintenance,
      };
    })(),
    {
      key: "no_comm",
      label: "ללא תקשורת",
      // ⚠️ הניסוח משתנה יחד עם ההגדרה. "לא התקבל מידע מהאתר" נכון אבל שותק
      // בדיוק במקום שבו הקוראת צריכה לדעת ששעות אלה **אינן בתוך האחוז**.
      explain: "לא התקבל מידע מהאתר — אינו נכלל בחישוב",
      hours: noCommHours,
      color: UPTIME_COLORS.no_comm,
    },
  ];

  return (
    <section className="uptime">
      <header className="uptime-head">
        <h3>זמינות האתר</h3>
        <p className="uptime-sub">כמה מהזמן האתר היה זמין לקבל רכבים</p>
      </header>

      {/* המספר הראשי */}
      <div className="uptime-hero">
        <strong className="uptime-percent">{availabilityPercent}%</strong>
        <span className="uptime-hero-text">
          האתר היה זמין לשירות {availabilityPercent}% מהזמן
        </span>
        {trend && <div className="uptime-hero-trend">{trend}</div>}
      </div>

      {/* ==========================================================
          מה שהאחוז **אינו** אומר
          ==========================================================
          ⚠️ החלטת מוצר: שעות ללא תקשורת אינן מורידות זמינות. הנימוק נכון —
          נתק פירושו שהסוכן או הרשת אינם מדווחים, והמחסום עצמו עשוי לעבוד
          ולשרת רכבים כל אותו זמן. אי-ידיעה אינה כשל.

          ⚠️ אבל זה **מסתיר סיגנל תפעולי אמיתי**: נמדד שאתר 2439 עולה מ-72.8%
          ל-99.3% כי הוא מנותק כרבע מהזמן. בלי השורה הזו המספר היחיד שנשאר על
          המסך אומר "הכול תקין", והעובדה שרבע מהתקופה כלל לא נמדדה נעלמת.

          לכן זו אינה הערת שוליים אלא הצד השני של ההחלטה: האחוז מדבר על מה
          שנמדד, והשורה הזו אומרת כמה **לא** נמדד. */}
      {noCommHours > 0 && (
        <p className="uptime-note">
          <strong>{formatHours(noCommHours)}</strong> ללא תקשורת אינן נכללות בחישוב —
          האחוז מתייחס ל-<strong>{formatHours(measuredHours)}</strong> שנמדדו בפועל.
        </p>
      )}

      {/* השורה הצבעונית */}
      <div className="uptime-bar" role="img" aria-label={`זמינות ${availabilityPercent}%`}>
        {segments.map((s) => (
          <span
            key={s.key}
            className="uptime-seg"
            style={{ width: `${pct(s.hours)}%`, background: s.color }}
            title={s.title}
          />
        ))}
      </div>

      {/* הפירוט */}
      <ul className="uptime-rows">
        {rows.map((r) => (
          <li key={r.key} className="uptime-row-group">
            <div className="uptime-row">
              <span className="uptime-dot" style={{ background: r.color }} />
              <div className="uptime-row-text">
                <span className="uptime-row-label">{r.label}</span>
                <span className="uptime-row-explain">{r.explain}</span>
              </div>
              <div className="uptime-row-nums">
                <strong>{Math.round(pct(r.hours) * 10) / 10}%</strong>
                <span>{formatHours(r.hours)}</span>
              </div>
            </div>

            {/* שורות-משנה: אחת לכל מקטע בפס, בצבע המדויק שלו. מוצגות רק
                כשיש בהן ממש — קטגוריה על אפס לא צריכה פירוט. */}
            {/* ⚠️ שורת-משנה על אפס מסוננת. באתר שהייתה בו רק תחזוקה מתוכננת,
                "טיפול בתקלה 0%" הוא רעש — ובאתר שהיה בו רק טיפול, הסינון הוא
                מה שהופך את השורה היחידה שנשארת לאמירה. */}
            {r.children && r.hours > 0 && (
              <ul className="uptime-subrows">
                {r.children.filter((c) => c.hours > 0).map((c) => (
                  <li key={c.key} className="uptime-subrow">
                    <span className="uptime-dot uptime-dot-sm" style={{ background: c.color }} />
                    <span className="uptime-subrow-label">{c.label}</span>
                    <div className="uptime-row-nums">
                      <strong>{Math.round(pct(c.hours) * 10) / 10}%</strong>
                      <span>{formatHours(c.hours)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <p className="uptime-total">
        סך הזמן שנמדד בתקופה: {formatHours(totalHours)}
      </p>
    </section>
  );
}

export default UptimeBar;
