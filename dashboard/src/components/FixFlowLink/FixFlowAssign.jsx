// שיוך ספריית תקלות — מתוך הכרטיס עצמו.
//
// ============================================================
// ⚠️ למה מהכרטיס ולא רק ממסך הניהול
// ============================================================
// הרגע שבו מתגלה שלאתר אין ספריית תקלות הוא הרגע שבו מוקדן פותח את הכרטיס
// באמצע אירוע ורואה "אין ספריית תקלות". לשלוח אותו משם אל ניהול ← חיפוש
// האתר ← עריכה ← גלילה לשדה הוא ארבעה צעדים בדיוק כשאין צעדים פנויים —
// והתוצאה המעשית היא שזה פשוט לא נעשה, והאתר נשאר בלי ספרייה לחודשים.
//
// ⚠️ **ורק במצב שבור.** כרטיס שהספרייה שלו תקינה נשאר קישור פשוט. הוספת
// בורר הגדרות לכל כרטיס הייתה מזמינה שינוי בטעות באמצע אירוע — וזו בדיוק
// הפעולה שאסור שתהיה קלה.
import React, { useState } from "react";
import FixFlowPicker from "./FixFlowPicker.jsx";
import { updateSite } from "../../services/dataSource";
import "./FixFlowLink.css";

export default function FixFlowAssign({ site, reason, onClose, onSaved }) {
  const [value, setValue] = useState(site.fixflow_profile ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      // ⚠️ אותו מסלול בדיוק כמו במסך הניהול — `update_site` עם בדיקת הרשאה
      // בצד השרת. מסלול שני היה מסלול שני לתחזק, ושניים שנפרדים הם באג.
      await updateSite(site.code, { fixflow_profile: value });
      onSaved?.(value);
      onClose?.();
    } catch (e) {
      // ⚠️ שגיאת הרשאה נאמרת כפי שהיא. "השמירה נכשלה" לבדו שולח את המשתמשת
      // לחפש תקלה במקום לומר לה שהיא פשוט אינה מנהלת.
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ffa-backdrop" onClick={(e) => { e.stopPropagation(); onClose?.(); }}>
      <div className="ffa" onClick={(e) => e.stopPropagation()}>
        <h3>ספריית תקלות — {site.site_name || site.code}</h3>
        {reason && <p className="ffa-why">⚠️ {reason}</p>}

        <FixFlowPicker site={site} value={value} onChange={setValue} />

        {err && <p className="ffa-err">{err}</p>}

        <div className="ffa-actions">
          <button className="ffa-save" onClick={save} disabled={busy}>
            {busy ? "שומר…" : "שמור"}
          </button>
          <button className="ffa-cancel" onClick={onClose} disabled={busy}>ביטול</button>
        </div>
      </div>
    </div>
  );
}
