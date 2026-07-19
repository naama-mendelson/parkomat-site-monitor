// components/AddSiteModal/AddSiteModal.jsx — מודל רישום אתר חדש
import { useState } from "react";
import { registerSite } from "../../services/api";
import { TIER_OPTIONS, TIER_LABELS } from "../../utils/constants";
import "./AddSiteModal.css";

// קוד חוקי — חייב להתאים לכלל שה-Master אוכף. הקוד נכנס כמות שהוא לנתיב ה-MQTT
// (sites/{code}/state), ולכן אסור בו '/', '+' או '#'. בודקים בצד הלקוח כדי
// להיכשל מוקדם, אבל השרת הוא הסמכות.
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function AddSiteModal({ onClose, onSuccess }) {
  const [code, setCode] = useState("");
  const [siteName, setSiteName] = useState("");
  const [plcType, setPlcType] = useState("");
  const [plcIp, setPlcIp] = useState("");
  const [siteIp, setSiteIp] = useState("");
  const [tier, setTier] = useState("basic");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

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
      await registerSite({
        code: trimmedCode,
        site_name: trimmedName,
        tier,
        plc_type: plcType.trim() || undefined,
        plc_ip: plcIp.trim() || undefined,
        site_ip: siteIp.trim() || undefined,
      });
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

          <label className="addsite-field">
            <span>סוג PLC</span>
            <input type="text" value={plcType} onChange={(e) => setPlcType(e.target.value)} placeholder="אופציונלי" />
          </label>

          <label className="addsite-field">
            <span>כתובת IP של ה-PLC</span>
            <input type="text" value={plcIp} onChange={(e) => setPlcIp(e.target.value)} placeholder="אופציונלי" />
          </label>

          <label className="addsite-field">
            <span>כתובת IP של האתר</span>
            <input type="text" value={siteIp} onChange={(e) => setSiteIp(e.target.value)} placeholder="אופציונלי" />
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
