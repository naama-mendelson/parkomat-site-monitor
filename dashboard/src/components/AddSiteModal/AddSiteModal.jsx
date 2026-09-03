// components/AddSiteModal/AddSiteModal.jsx — מודל רישום אתר חדש
import { useState } from "react";
// ⚠️ דרך dataSource ולא api: הרישום עובר ל-Supabase ישירות, והמתג הוא זה
// שקובע. הכלל בפרויקט הוא שקומפוננטה אינה בוחרת מסלול נתונים.
import { registerSite } from "../../services/dataSource";
import { TIER_OPTIONS, TIER_LABELS } from "../../utils/constants";
// ⚠️ אותה רשימה בדיוק שהשרת אוכף — ראה shared/site-types.mjs.
import { SITE_TYPE_GROUPS } from "../../../../shared/site-types.mjs";
import "./AddSiteModal.css";

// קוד חוקי — חייב להתאים לכלל שה-Master אוכף. הקוד נכנס כמות שהוא לנתיב ה-MQTT
// (sites/{code}/state), ולכן אסור בו '/', '+' או '#'. בודקים בצד הלקוח כדי
// להיכשל מוקדם, אבל השרת הוא הסמכות.
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function AddSiteModal({ onClose, onSuccess }) {
  const [code, setCode] = useState("");
  const [siteName, setSiteName] = useState("");
  const [plcType, setPlcType] = useState("");
  const [tier, setTier] = useState("basic");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // תוצאת ההרשמה כשיש מה להראות אחריה — סיסמת הסוכן, או כישלון בהנפקתה.
  const [issued, setIssued] = useState(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    const trimmedCode = code.trim();
    const trimmedName = siteName.trim();

    if (!CODE_PATTERN.test(trimmedCode)) {
      return setError("קוד האתר: אותיות באנגלית, ספרות, מקף וקו תחתון בלבד (עד 64 תווים)");
    }
    if (!trimmedName) {
      return setError("יש להזין שם אתר");
    }

    setSaving(true);
    try {
      const res = await registerSite({
        code: trimmedCode,
        site_name: trimmedName,
        tier,
        plc_type: plcType.trim() || undefined,
      });

      // ============================================================
      // ⚠️ האתר נרשם — אבל אסור לסגור עדיין
      // ============================================================
      // הסיסמה של הסוכן מוצגת **פעם אחת בלבד**; Supabase מחזיק גיבוב בלבד.
      // סגירה אוטומטית כאן הייתה מוחקת אותה מהמסך לנצח, והאתר החדש היה
      // נשאר בלי דרך להתחבר עד שמישהו מנפיק סיסמה חדשה.
      //
      // ⚠️ וגם כשההנפקה **נכשלה** נשארים פתוחים: האתר כבר קיים, ו-onSuccess
      // שסוגר את החלון היה מציג "נרשם בהצלחה" על אתר שלא יוכל לדווח לעולם.
      if (res?.agent?.password || res?.agentError) {
        setIssued(res);
        return;
      }
      onSuccess();
    } catch (err) {
      // שגיאת השרת (קוד כפול, קוד לא תקין, שרת לא זמין) — הדיאלוג נשאר פתוח
      // עם הערכים כדי לתקן ולנסות שוב.
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // בזמן שמירה חוסמים סגירה (רקע / ✕) — סגירה באמצע הבקשה הייתה מנתקת את
  // מסלול ההצלחה (reload) ומעדכנת state על קומפוננטה שהוסרה.
  const closeIfIdle = () => { if (!saving) onClose(); };

  // ============================================================
  // מסך התוצאה — מוצג במקום הטופס אחרי הרשמה מוצלחת
  // ============================================================
  // ⚠️ **אין כאן ✕ ואין סגירה בלחיצה על הרקע.** הסיסמה מוצגת פעם אחת,
  // ולחיצה מקרית מחוץ לחלון הייתה מוחקת אותה בלי דרך חזרה. היציאה היחידה
  // היא הכפתור, שאומר במפורש מה קורה.
  if (issued) {
    const { site, agent, agentError } = issued;
    return (
      <div className="addsite-overlay">
        <div className="addsite-modal" onClick={(e) => e.stopPropagation()}>
          <div className="addsite-header">
            <h2>{`האתר ${site?.code ?? ""} נרשם`}</h2>
          </div>

          <div className="addsite-form">
            {agentError ? (
              // ⚠️ מצב אמיתי ולא תיאורטי: `register_site` התחייב, ולכן האתר
              // קיים. מה שנכשל הוא הזהות — כלומר האתר **לא יוכל לדווח** עד
              // שמישהו ינפיק לו אחת. הודעה כללית כמו "הרישום נכשל" הייתה
              // שולחת לנסות שוב ולקבל "קוד כבר קיים".
              <div className="addsite-error" role="alert">
                <b>האתר נרשם, אך לא נוצרה לו זהות סוכן.</b>
                <div style={{ marginTop: 6 }}>{agentError}</div>
                <div style={{ marginTop: 6 }}>
                  ⚠️ עד שתונפק זהות, האתר לא יוכל לכתוב נתונים. אפשר לנסות שוב
                  ממסך הניהול.
                </div>
              </div>
            ) : (
              <>
                <div className="addsite-field">
                  <span>שם משתמש של האתר</span>
                  <input type="text" readOnly value={agent.email} />
                </div>

                <div className="addsite-field">
                  <span>סיסמת האתר</span>
                  <input type="text" readOnly value={agent.password}
                         style={{ fontFamily: "monospace", direction: "ltr" }} />
                  <small className="addsite-hint">
                    ⚠️ הסיסמה מוצגת <b>פעם אחת בלבד</b> ואינה ניתנת לשחזור.
                    היא נכנסת להגדרות הסוכן במחשב שבאתר, בשדה "סיסמת האתר".
                  </small>
                </div>

                <button type="button" className="btn btn-ghost"
                        onClick={async () => {
                          // ⚠️ navigator.clipboard נכשל בהקשר לא-מאובטח ומחזיר
                          // Promise דחוי. בלי catch זו שגיאה לא-מטופלת שמפילה
                          // את הלחיצה בשקט, והמשתמשת חושבת שהעתיקה.
                          try {
                            await navigator.clipboard.writeText(
                              `${agent.email}\n${agent.password}`);
                            setCopied(true);
                          } catch { setCopied(false); }
                        }}>
                  {copied ? "✓ הועתק" : "העתק שם משתמש וסיסמה"}
                </button>
              </>
            )}

            <div className="addsite-actions">
              <button type="button" className="btn btn-primary" onClick={onSuccess}>
                {agentError ? "הבנתי, סגור" : "העתקתי — סגור"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="addsite-overlay" onClick={closeIfIdle}>
      <div className="addsite-modal" onClick={(e) => e.stopPropagation()}>
        <div className="addsite-header">
          <h2>הוספת אתר חדש</h2>
          <button className="addsite-close" onClick={closeIfIdle} disabled={saving} aria-label="סגירה">✕</button>
        </div>

        <form className="addsite-form" onSubmit={handleSubmit}>
          <label className="addsite-field">
            <span>קוד האתר <b className="req">*</b></span>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="לדוגמה: 1234"
              autoFocus
            />
            <small className="addsite-hint">
              חייב להיות זהה ל-SiteId שמוגדר בסוכן שרץ באתר — אחרת לא יתקבל ממנו מידע
            </small>
          </label>

          <label className="addsite-field">
            <span>שם האתר <b className="req">*</b></span>
            <input
              type="text"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              placeholder="לדוגמה: חניון דיזנגוף סנטר"
            />
          </label>

          <label className="addsite-field">
            <span>דרגת אתר <b className="req">*</b></span>
            <select value={tier} onChange={(e) => setTier(e.target.value)}>
              {TIER_OPTIONS.map((t) => (
                <option key={t} value={t}>{TIER_LABELS[t]}</option>
              ))}
            </select>
          </label>

          {/* ==========================================================
              סוג המתקן — רשימה סגורה, לא טקסט חופשי
              ==========================================================
              ⚠️ כאן היה שדה חופשי, וזה נראה גמיש והיה ההפך: "XY", "xy" ו-"X.Y"
              הם שלושה סוגים שונים מבחינת כל סינון וכל קיבוץ, וחודשיים אחרי
              ההקלדה איש לא זוכר איזו צורה נכונה.

              ⚠️ "לא הוגדר" הוא אפשרות אמיתית ולא placeholder: אפשר לרשום אתר
              בלי לדעת את סוגו, וזה המצב בשטח כשמתקינים בערב. */}
          <label className="addsite-field">
            <span>סוג המתקן</span>
            <select value={plcType} onChange={(e) => setPlcType(e.target.value)}>
              <option value="">לא הוגדר</option>
              {SITE_TYPE_GROUPS.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {g.types.map((t) => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          {error && <div className="addsite-error" role="alert">{error}</div>}

          <div className="addsite-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              ביטול
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "רושם…" : "רשום אתר"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddSiteModal;
