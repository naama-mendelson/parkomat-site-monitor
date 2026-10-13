// components/AddSiteModal/AddSiteModal.jsx — מודל רישום אתר חדש
import { useEffect, useState } from "react";
// ⚠️ דרך dataSource ולא api: הרישום עובר ל-Supabase ישירות, והמתג הוא זה
// שקובע. הכלל בפרויקט הוא שקומפוננטה אינה בוחרת מסלול נתונים.
import { registerSite, fetchPmProfiles, setPmSiteProfile } from "../../services/dataSource";
import { PM_ENABLED } from "../../utils/compliance";
import ChoiceSelect from "../ChoiceSelect/ChoiceSelect";
import { copyText } from "../../utils/clipboard";
// ⚠️ אותה רשימה בדיוק שהשרת אוכף — ראה shared/site-types.mjs.
import { SITE_TYPE_GROUPS } from "../../../../shared/site-types.mjs";
import { CONTROL_SYSTEMS } from "../../../../shared/control-systems.mjs";
import { liftNeedsConsole, liftsProblem } from "../../../../shared/lift-types.mjs";
import LiftFields from "../LiftFields/LiftFields";
import "./AddSiteModal.css";

// קוד חוקי — חייב להתאים לכלל שה-Master אוכף. הקוד נכנס כמות שהוא לנתיב ה-MQTT
// (sites/{code}/state), ולכן אסור בו '/', '+' או '#'. בודקים בצד הלקוח כדי
// להיכשל מוקדם, אבל השרת הוא הסמכות.
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function AddSiteModal({ onClose, onSuccess }) {
  const [code, setCode] = useState("");
  const [siteName, setSiteName] = useState("");
  const [plcType, setPlcType] = useState("");
  const [controlSystem, setControlSystem] = useState("");
  // אתר בלי בקר מחובר (07/10/2026) — בודק, תחזוקה ומשימות בלבד; בלי זהות סוכן
  const [noController, setNoController] = useState(false);
  // סוג המעלית והקונזול (11/10/2026) — לא חובה מאז 12/10 בערב; הקונזול רק בסוגים שפותחים אותו (1, 2, 6).
  // ומ-12/10 — עד שתי מעליות ("יש אתרים שיש בהם שתי מעליות"); השנייה לא חובה.
  const [lifts, setLifts] = useState([{ type: "", console: "" }]);
  // פרופיל תחזוקה (13/10/2026) — "כמו ברמזור". לא חובה: בלי פרופיל האתר מקבל את רשימת ברירת המחדל.
  // ⚠️ רק כשהתחזוקה המונעת גלויה (PM_ENABLED) — באתר החי היא מוסתרת, ושדה על משהו שלא רואים מבלבל.
  const [profiles, setProfiles] = useState(null);
  const [profileId, setProfileId] = useState("");
  useEffect(() => {
    if (!PM_ENABLED) return undefined;
    let alive = true;
    fetchPmProfiles().then((d) => { if (alive) setProfiles(d.profiles); }).catch(() => { if (alive) setProfiles(false); });
    return () => { alive = false; };
  }, []);

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
    // ⚠️ אותו כלל כמו השרת (register_site) — כאן רק כדי להיכשל מוקדם ובעברית ליד השדה
    // ⚠️ הסוג אינו חובה (12/10/2026, ערב: "תעשה שלא יהיה חייבים לבחור מה סוג המעלית") — נבדק רק מה שנבחר
    const liftErr = liftsProblem(lifts, { required: false });
    if (liftErr) return setError(liftErr);
    const [lift1, lift2] = lifts;

    setSaving(true);
    try {
      const res = await registerSite({
        code: trimmedCode,
        site_name: trimmedName,
        plc_type: plcType.trim() || undefined,
        control_system: controlSystem || undefined,
        // ⚠️ אין fixflow_profile (11/10/2026, "תעיף את זה. שזה יעשה אוטומטי בכל מקרה"): ספריית התקלות
        // נגזרת תמיד אוטומטית — משם האתר או מסוג המתקן והמערכת (shared/fixflow-profiles.mjs).
        ...(noController ? { monitored: false } : {}),
        // רק כשנבחר — registerSiteDirect אינו שולח מפתח ריק, והמסד שם NULL ("לא הוגדר")
        ...(lift1.type ? { lift_type: lift1.type } : {}),
        ...(liftNeedsConsole(lift1.type) ? { lift_console: lift1.console } : {}),
        // השנייה — רק כשנוספה (registerSiteDirect אינו שולח את המפתחות בלעדיה)
        ...(lift2?.type ? { lift2_type: lift2.type, ...(liftNeedsConsole(lift2.type) ? { lift2_console: lift2.console } : {}) } : {}),
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
      // ⚠️ הפרופיל אחרי ההרשמה, וכשל בו אינו מכשיל אותה — האתר כבר קיים (כמו זהות הסוכן).
      // מסך התוצאה אומר שהפרופיל לא נקבע, ואפשר לקבוע אותו בלשונית התחזוקה של האתר.
      let profileError = null;
      if (profileId) {
        try { await setPmSiteProfile(trimmedCode, Number(profileId)); }
        catch (pe) { profileError = pe?.message || "שגיאה"; }
      }
      if (res?.agent?.password || res?.agentError || profileError) {
        setIssued({ ...res, profileError });
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
    const { site, agent, agentError, profileError } = issued;
    return (
      <div className="addsite-overlay">
        <div className="addsite-modal" onClick={(e) => e.stopPropagation()}>
          <div className="addsite-header">
            <h2>{`האתר ${site?.code ?? ""} נרשם`}</h2>
          </div>

          <div className="addsite-form">
            {profileError && (
              <div className="addsite-error" role="alert">
                <b>האתר נרשם, אך פרופיל התחזוקה לא נקבע.</b>
                <div style={{ marginTop: 6 }}>{profileError} — אפשר לקבוע אותו בלשונית התחזוקה של האתר.</div>
              </div>
            )}
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
            ) : !agent?.password ? null : (
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
                          // ⚠️ **הסיסמה בלבד, בלי המייל** (24/09/2026) — בטופס
                          // הסוכן יש רק "סיסמת האתר"; המייל נגזר מקוד האתר.
                          // copyText עובד גם בהקשר לא-מאובטח, ואינו זורק.
                          setCopied(await copyText(agent.password));
                        }}>
                  {copied ? "✓ הועתק" : "העתק סיסמה"}
                </button>
              </>
            )}

            <div className="addsite-actions">
              <button type="button" className="btn btn-primary" onClick={onSuccess}>
                {agentError || !agent?.password ? "הבנתי, סגור" : "העתקתי — סגור"}
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

          {/* ⚠️ "דרגת אתר" הוסר (בעלת המוצר, 11/10/2026: "את זה תעיף"). הדרגה שעל הכרטיס באה מהרמזור
              (site_service_links), והבחירה כאן קבעה רק את sites.tier — ערך גיבוי שמוצג רק כשהקריאה
              לרמזור נכשלת. השרת שם 'basic' כשלא נשלחה דרגה. */}
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

          {/* ⚠️ מערכת ההפעלה — בלעדיה ההתאמה לנהלים לפי סוג מסרבת: אותו XY של
              לולק ושל ביטנקם מקבל ספריית תקלות אחרת, ואין ממה לנחש. */}
          <label className="addsite-field">
            <span>מערכת</span>
            <select value={controlSystem} onChange={(e) => setControlSystem(e.target.value)}>
              <option value="">לא הוגדר</option>
              {CONTROL_SYSTEMS.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </label>

          {/* ==========================================================
              סוג המעלית (11/10/2026) — עד שתיים, ולא חובה (12/10/2026)
              ==========================================================
              בעלת המוצר: "כשמוסיפים אתר צריך 'סוג מעלית' שיהיה SELECT … 1, 2, 6 — אם בוחרים
              באופציות האלו תיפתח השאלה קונזול אורכי או קונזול רוחבי". ו-12/10: "אופציה להוסיף עוד
              מעלית" ו"תעצב את הSELECT יותר יפה וחדשני" — LiftFields: רשימה נפתחת משלנו, הקונזול בשני
              חלקים, "+ עוד מעלית". הרשימה: shared/lift-types.mjs.
              ⚠️ **לא חובה** מאז 12/10/2026 בערב ("תעשה שלא יהיה חייבים לבחור מה סוג המעלית"): "לא הוגדר"
              הוא אפשרות אמיתית, כמו בסוג המתקן. הקונזול — חובה רק כשנבחר סוג שפותח אותו.
              החלפה לסוג בלי קונזול מנקה את הקונזול שנבחר — אחרת הוא היה נשאר בטופס בלי שדה שמראה אותו. */}
          <div className="addsite-field">
            <LiftFields lifts={lifts} onChange={setLifts} variant="form" />
          </div>

          {/* פרופיל תחזוקה (13/10/2026) — בעלת המוצר: "להבא כל צירוף מתקן תצטרכי לשאול איזו תחזוקה
              לצרף לו, לרוב התשובה תהיה כמו פרויקט אחר". לא חובה. */}
          {PM_ENABLED && (
            <div className="addsite-field">
              <span>פרופיל תחזוקה</span>
              <ChoiceSelect label="פרופיל תחזוקה" name="pm_profile" value={profileId} onChange={setProfileId}
                options={[{ value: "", label: "בלי פרופיל (רשימת ברירת המחדל)" },
                  ...(profiles || []).map((p) => ({ value: String(p.id), label: `${p.name} · ${p.sites.length} אתרים` }))]} />
              {profiles === false && (
                <small className="addsite-hint">הפרופילים לא נטענו — אפשר לרשום עכשיו ולקבוע פרופיל אחר כך בלשונית התחזוקה.</small>
              )}
            </div>
          )}

          {/* ⚠️ אתר בלי בקר מחובר (07/10/2026): בעלת המוצר, על מתקני סוטפין — "אתר לא מקושר
              למתקן עצמו… אבל כן קיים, כן נדרש בודק וכן תחזוקה ומשימות". לא מסומן כברירת
              מחדל: רוב האתרים מחוברים, ואתר מחובר שנרשם בטעות כך לא היה מקבל זהות סוכן. */}
          <label className="addsite-check">
            <input type="checkbox" checked={noController} onChange={(e) => setNoController(e.target.checked)} />
            <span>ללא בקר מחובר — בודק, תחזוקה ומשימות בלבד</span>
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
