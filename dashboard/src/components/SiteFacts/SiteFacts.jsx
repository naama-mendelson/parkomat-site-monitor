// components/SiteFacts — פרטי האתר וטופס התחזוקה, לשילוב בפירוט המלא.
//
// ============================================================
// למה זה חולץ מ-DetailPanel
// ============================================================
// היו שני מסכים לאותו אתר: פאנל צד שנפתח מהכרטיס, ומודאל "פירוט מלא"
// שנפתח **מתוכו**. כדי להגיע לגרפים היה צריך לפתוח פאנל, לגלול, וללחוץ.
//
// ⚠️ ורוב מה שהפאנל הציג כבר היה במודאל — מדדים, זמינות, לוג. מה ש**לא**
// היה שם הוא בדיוק שני הבלוקים כאן: פרטי האתר, וטופס התחזוקה. הם עברו,
// והשאר לא שוכפל.
//
// ⚠️ **טופס התחזוקה הוא החלק שאסור לשבור בהעברה** — הוא הפעולה התפעולית
// היחידה במסך, ובלעדיו אי אפשר להכניס אתר לתחזוקה. הוא הועבר כמות שהוא,
// כולל שתי הבדיקות שלפני השליחה.
import { useState } from "react";
import { TIER_LABELS } from "../../utils/constants";
import { siteTypeFullLabel } from "../../../../shared/site-types.mjs";
import { formatDate } from "../../utils/helpers";
// ⚠️ מ-dataSource ולא מ-api: הכתיבה עוברת במתג — ישירות ל-Supabase
// כברירת מחדל, ודרך השרת כשהמתג כבוי.
import { startMaintenance, cancelMaintenance, scheduleMaintenance } from "../../services/dataSource";
import "./SiteFacts.css";

// תאריך + "לפני כמה זמן". ⚠️ **שניהם ולא אחד:** תאריך לבדו מחייב לחשב
// בראש כמה זמן עבר, ו"לפני 3 שבועות" לבדו אינו מאפשר להצליב מול אירוע אחר.
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const ago = days <= 0 ? "היום" : days === 1 ? "אתמול" : `לפני ${days} ימים`;
  return `${d.toLocaleDateString("he-IL")} · ${ago}`;
}

function SiteFacts({ site, maintenance, onRefresh }) {
  const [maintName, setMaintName] = useState("");
  const [maintHours, setMaintHours] = useState(2);
  const [busy, setBusy] = useState(false);

  // ⚠️ "מעכשיו" הוא ברירת המחדל, וזה לא שרירותי: זה המקרה הנפוץ — טכנאי
  // שעומד באתר. תזמון הוא התכנון המראש, והוא הפחות שכיח.
  const [mode, setMode] = useState("now");
  // ברירת מחדל היום, כפי שהתבקש. toLocaleDateString("sv") מחזיר
  // YYYY-MM-DD בשעון **המקומי** — toISOString היה מחזיר את של UTC,
  // ואחרי חצות בישראל זה היום הקודם.
  const today = new Date().toLocaleDateString("sv");
  const [day, setDay] = useState(today);
  const [fromH, setFromH] = useState("08:00");
  const [toH, setToH] = useState("10:00");

  if (!site) return null;
  const isInMaintenance = maintenance?.inMaintenance;

  async function start() {
    // ⚠️ שתי הבדיקות נשמרו: שם חובה — הוא כל מודל הייחוס, והשרת מחזיר 400
    // בלעדיו — ומשך חיובי, אחרת נוצר חלון שפג לפני שנפתח.
    if (!maintName.trim()) return alert("יש להזין שם");
    setBusy(true);
    try {
      if (mode === "scheduled") {
        // ⚠️ **בונים Date מהשעון המקומי ולא מחברים מחרוזות.**
        // `${day}T${fromH}` בלי אזור זמן נקרא כ-UTC בחלק מהדפדפנים
        // וכמקומי באחרים — כלומר חלון שזז בשלוש שעות תלוי בדפדפן.
        // הבנייה כאן מפורשת, ו-toISOString ממיר נכון.
        const [y, m, d] = day.split("-").map(Number);
        const at = (hm) => {
          const [hh, mm] = hm.split(":").map(Number);
          return new Date(y, m - 1, d, hh, mm, 0, 0);
        };
        const s = at(fromH), e = at(toH);
        // ⚠️ נבדק גם כאן וגם ב-SQL. כאן — כדי לומר למשתמשת לפני השליחה;
        // שם — כי בדיקה בדפדפן נעקפת.
        if (!(e > s)) return alert("שעת הסיום חייבת להיות אחרי שעת ההתחלה");
        await scheduleMaintenance(site.code, s.toISOString(), e.toISOString(), maintName.trim());
      } else {
        if (!(maintHours > 0)) return alert("משך התחזוקה חייב להיות מספר חיובי (שעות)");
        await startMaintenance(site.code, maintName.trim(), maintHours);
      }
      setMaintName("");
      onRefresh?.();
    } catch (err) {
      alert("שגיאה: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await cancelMaintenance(site.code);
      onRefresh?.();
    } catch (err) {
      alert("שגיאה: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="facts">
      <div className="facts-block">
        <h3>פרטי האתר</h3>
        <div className="facts-info">
          <div className="facts-row">
            <span className="facts-label">נרשם במערכת</span>
            <span>{fmtDateTime(site.registered_at)}</span>
          </div>
          <div className="facts-row">
            <span className="facts-label">סוג המתקן</span>
            <span>{siteTypeFullLabel(site.plc_type)}</span>
          </div>
          <div className="facts-row">
            <span className="facts-label">דרגת שירות</span>
            <span>{TIER_LABELS[site.tier] || TIER_LABELS.basic}</span>
          </div>
          <div className="facts-row">
            <span className="facts-label">נשמע לאחרונה</span>
            <span>{fmtDateTime(site.last_seen)}</span>
          </div>

          {/* ⚠️ **שני מונים, ולא אחד.** מונה המערכת סופר רק מאז הרישום;
              מונה הבקר הוא של המכונה מיום ייצורה. מי שרואה 199 מול 4,984
              בלי הסבר מניח שאחד מהם שגוי — וההפרש הוא בדיוק הנתון: כמה
              עבדה המכונה לפני שהתחלנו למדוד. */}
          <div className="facts-row">
            <span className="facts-label">מחזורים שנמדדו</span>
            <span>{(site.cycle_total ?? 0).toLocaleString()}</span>
          </div>
          <div className="facts-row">
            <span className="facts-label">מונה הבקר</span>
            <span>
              {site.plc_cycle_last != null ? site.plc_cycle_last.toLocaleString() : "—"}
            </span>
          </div>
        </div>

        {/* ⚠️ מוצג רק כשיש פער אמיתי. משפט קבוע שמופיע גם כששני המספרים
            זהים הוא רעש שמלמד את העין לדלג עליו. */}
        {site.plc_cycle_last != null
          && site.plc_cycle_last > (site.cycle_total ?? 0) && (
          <p className="facts-note">
            המכונה עבדה <strong>{(site.plc_cycle_last - (site.cycle_total ?? 0)).toLocaleString()}</strong> מחזורים
            לפני שהאתר נרשם כאן — הפרש זה אינו נספר במדדים.
          </p>
        )}
      </div>

      {/* ⚠️ **פעולה חופשית, לא מאחורי קוד מנהל.** ההחלטה היא "ייחוס במקום
          מנע": אנשי שירות פותחים חלונות בשטח, והשם נדרש כדי לדעת מי. */}
      <div className="facts-block">
        <h3>תחזוקה</h3>
        {isInMaintenance ? (
          <div className="facts-maint-active">
            <p>
              תחזוקה פעילה — {maintenance.maintenance.set_by_name}
              <br />
              פג: {formatDate(maintenance.maintenance.expires_at)}
            </p>
            <button className="btn btn-danger" onClick={cancel} disabled={busy}>
              בטל תחזוקה
            </button>
          </div>
        ) : (
          <div className="facts-maint-form">
            <input
              type="text"
              placeholder="שם מפעיל"
              value={maintName}
              onChange={(e) => setMaintName(e.target.value)}
              className="facts-input"
            />

            <select
              className="facts-input"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              aria-label="מתי"
            >
              <option value="now">מעכשיו</option>
              <option value="scheduled">מתוזמן</option>
            </select>

            {mode === "now" ? (
              <div className="facts-duration">
                <input
                  type="number" min="0.5" step="0.5"
                  value={maintHours}
                  onChange={(e) => setMaintHours(Number(e.target.value))}
                  className="facts-hours"
                  aria-label="משך תחזוקה בשעות"
                />
                <span className="facts-unit">שעות</span>
              </div>
            ) : (
              <>
                {/* ⚠️ min={today}: תזמון לאתמול היה משנה למפרע זמינות שכבר
                    דווחה — מספרים שאנשים כבר ראו. הכלל נאכף גם ב-SQL; כאן
                    הוא רק מונע את הטעות לפני שהיא נשלחת. */}
                <input
                  type="date" className="facts-input" value={day} min={today}
                  onChange={(e) => setDay(e.target.value)} aria-label="תאריך"
                />
                <div className="facts-duration">
                  <input type="time" className="facts-hours" value={fromH}
                         onChange={(e) => setFromH(e.target.value)} aria-label="משעה" />
                  <span className="facts-unit">עד</span>
                  <input type="time" className="facts-hours" value={toH}
                         onChange={(e) => setToH(e.target.value)} aria-label="עד שעה" />
                </div>
              </>
            )}

            <button className="btn btn-primary" onClick={start} disabled={busy}>
              {mode === "now" ? "הכנס לתחזוקה" : "תזמן תחזוקה"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default SiteFacts;
