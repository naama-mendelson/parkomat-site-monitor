// components/HelpPanel — איך קוראים את הדשבורד.
//
// ============================================================
// למה זה בתוך המוצר ולא במסמך
// ============================================================
// מסמך נפרד נקרא פעם אחת ביום ההדרכה. השאלה "מה זה 47 דק׳?" נשאלת
// מול המסך, חודשיים אחר כך — ואז צריך שהתשובה תהיה במרחק לחיצה.
//
// ⚠️ **וכל מספר כאן נלקח מההגדרה בקוד, לא מהזיכרון.** דף עזרה שמתאר
// את מה שהמערכת *הייתה* עושה גרוע ממסך בלי עזרה: הוא נראה סמכותי.
// כשמשנים חישוב, משנים גם כאן — הרשימה למטה היא הסיבה שזה אפשרי.
import { LampSwatch } from "../Compliance/ComplianceLights";
import { PM_ENABLED } from "../../utils/compliance";
import "./HelpPanel.css";

/** שורה אחת: מה כתוב על המסך, ומה זה אומר. */
function Row({ term, children, warn }) {
  return (
    <div className={`help-row${warn ? " help-row--warn" : ""}`}>
      <div className="help-term">{term}</div>
      <div className="help-def">{children}</div>
    </div>
  );
}

function Section({ title, lead, children }) {
  return (
    <section className="help-section">
      <h3>{title}</h3>
      {lead && <p className="help-lead">{lead}</p>}
      <div className="help-rows">{children}</div>
    </section>
  );
}

function HelpPanel({ onClose }) {
  return (
    <div className="help-back" onClick={onClose}>
      <div
        className="help"
        role="dialog"
        aria-modal="true"
        aria-label="איך קוראים את הדשבורד"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <div>
            <h2>איך קוראים את הדשבורד</h2>
            <span className="help-sub">מה כל נתון אומר, ומה הוא לא אומר</span>
          </div>
          <button className="help-close" onClick={onClose} aria-label="סגירה">✕</button>
        </div>

        <div className="help-body">

          <Section title="מצב האתר" lead="הנקודה הצבעונית בראש הכרטיס.">
            <Row term="מוכן">פנוי וממתין. המצב הרגיל בין תפעולים.</Row>
            <Row term="בפעולה">רכב נכנס או יוצא כרגע.</Row>
            <Row term="בתקלה">
              כשהבקר שולח גם תיאור, הוא מופיע על הכרטיס ליד ⚠. לא תמיד הוא שולח.
            </Row>
            <Row term="בתחזוקה">מישהו הכניס אותו מהדשבורד, או שהבקר דיווח על כך.</Row>
            <Row term="אין תקשורת" warn>
              <strong>לא שמענו מהאתר</strong> — הסוכן, המחשב או האינטרנט.
              ייתכן שהמחסום עובד כרגיל כל אותו זמן, ואיננו יודעים.
            </Row>
          </Section>

          {/* ⚠️ הספים כאן הם של ה-SQL: "חודש" = app.compliance_warn_days (30),
              "חצי שנה" = app.pm_interval_months (6), ליקוי באיחור = due_on < היום.
              הצבעים נקבעים שם בלבד — שינוי שם מחייב שינוי כאן. המילים של בעלת
              המוצר (06/10/2026): "ירוק תקין, צהוב צריך להתכונן, אדום לא תקין". */}
          {/* תחזוקה מוסתרת באתר החי (PM_ENABLED) → המקרא מדבר על הבודק בלבד */}
          <Section
            title={PM_ENABLED ? "בודק מוסמך ותחזוקה מונעת" : "בודק מוסמך"}
            lead={PM_ENABLED
              ? "שתי המנורות בכרטיס: לוח עם וי — תסקיר בודק מוסמך; מפתח — תחזוקה מונעת, כל חצי שנה. לחיצה על מנורה פותחת את הפרטים."
              : "המנורה עם הלוח והווי בכרטיס — תסקיר בודק מוסמך. לחיצה עליה פותחת את עמוד הבודק."}
          >
            <Row term={<span className="help-lamp"><LampSwatch state="ok" /> בתוקף</span>}>
              תקין. יותר מחודש עד שהתוקף פג.
            </Row>
            <Row term={<span className="help-lamp"><LampSwatch state="soon" /> עומד לפוג תוך חודש</span>}>
              {PM_ENABLED ? "צריך להתכונן: לזמן בודק או לתאם תחזוקה. בבודק — גם" : "צריך להתכונן: לזמן בודק. גם"}{" "}
              כשכל הליקויים תוקנו ומחכים לתסקיר נקי מהבודק, וכש<strong>ליקוי עבר את מועד התיקון</strong> והתסקיר עצמו בתוקף.
            </Row>
            <Row warn term={<span className="help-lamp"><LampSwatch state="expired" /> לא בתוקף</span>}>
              <strong>לא תקין:</strong> התוקף פג, או שאין במערכת {PM_ENABLED ? "תסקיר או ביקור תחזוקה" : "תסקיר"}.
            </Row>
            <Row term={<span className="help-lamp"><span className="cl-badge">2</span> מספר ליד המנורה</span>}>
              ליקויים פתוחים. <span className="cl-badge cl-badge--overdue">2</span> מלא באדום —
              לפחות אחד מהם עבר את מועד התיקון.
            </Row>
            <Row term={<span className="help-lamp"><LampSwatch state="unknown" /> סימן שאלה</span>}>
              הסטטוס לא נטען — איננו יודעים, וזה לא "תקין".
              מסגרת מקווקוות סביב צבע: מוצג המצב האחרון הידוע.
            </Row>
          </Section>

          <Section title="המספרים על הכרטיס">
            <Row term="פעולות">כניסות ויציאות שהושלמו בטווח הנבחר.</Row>
            <Row term="אחוז כשל">
              תקלות ÷ פעולות. ▲ מחמיר, ▼ משתפר.
              נקודה במקום משולש = פחות מ-5 פעולות, מדגם קטן מדי למגמה.
            </Row>
            <Row term="טיפול בתקלה" warn>
              כמה זמן האתר שוהה בתקלה עד שהוא חוזר לעבוד.
              זהו <strong>ממוצע</strong>, ולכן תקלה חריגה אחת מושכת אותו למעלה —
              הגרף שמתחת מראה אם זה מה שקרה.
            </Row>
            <Row term="הגרף">
              מקל לכל תקלה, גובה לפי המשך, בסדר כרונולוגי. ריחוף מציג את הזמן.
              <div className="help-legend">
                <span><i className="lg lg-q" /> עד רבע שעה</span>
                <span><i className="lg lg-m" /> עד שעה</span>
                <span><i className="lg lg-l" /> מעל שעה</span>
              </div>
            </Row>
            <Row term="מונה מחזורים">
              המונה שבבקר עצמו — סימן לבלאי. אינו קשור לאחוז הכשל,
              ויורד אם הבקר הוחלף או אופס.
            </Row>
            <Row term="בסיסי · מורחב · VIP">רמת שירות. אינה נכנסת לחישובים.</Row>
          </Section>

          <Section title="זמינות">
            <Row term="החישוב">
              <code>(מוכן + בפעולה) ÷ (מוכן + בפעולה + תקלה)</code>
            </Row>
            <Row term="מה לא נספר" warn>
              <strong>תחזוקה</strong> — השבתה מתוכננת אינה כישלון.
              <strong> אין תקשורת</strong> — איננו יודעים אם עבד, ואי-ידיעה אינה כישלון.
              המחיר: אתר שמנותק הרבה ייראה תקין, ולכן ההערה שמתחת לפס מציינת
              כמה שעות הוחרגו.
            </Row>
            <Row term="מקף במקום אחוז">
              לא נמדד דבר. <strong>0% היה נקרא "מושבת לגמרי"</strong>.
            </Row>
          </Section>

          <Section title="עדכון">
            <Row term="קצב הדיווח">
              האתר משדר על <strong>שינוי</strong>, לא בקצב קבוע. אתר שקט בלילה תקין.
            </Row>
            <Row term="פס אדום למעלה" warn>
              המספרים <strong>ישנים</strong>, לא שגויים. הפס מסביר מה לעשות.
            </Row>
          </Section>

          <p className="help-foot">
            מספר שאינו מסתדר עם מה שכתוב כאן הוא תקלה — שווה לדווח.
          </p>
        </div>
      </div>
    </div>
  );
}

export default HelpPanel;
