// ============================================================
// תיבת קוד המנהל — משותפת, ולא עותק בכל מסך
// ============================================================
// ⚠️ **היא ישבה בתוך `TrafficLight.jsx`, ועכשיו יש לה שני צרכנים.**
// מקטע הסכם השירות שבכרטיס פותח בדיוק את אותו מצב עריכה על בדיוק
// אותן שורות — ותיבת קוד שנייה שנראית זהה היא בדיוק מה שנפרד בשקט
// אחרי חצי שנה: אחת מקבלת את כפתור העין, השנייה לא; אחת מנקה את
// השדה בכישלון, השנייה לא.
//
// ⚠️ **והקוד אינו מה שמגן.** ‏`app.require_manager()` במסד קורא את
// התפקיד **מהטבלה** ודוחה כתיבה של מי שאינו מנהל, גם אם הוא זוכר את
// הקוד. התיבה הזו היא נוחות ותו לא — מסך שמציע פעולות שהמסד ידחה
// הוא הדרך האמינה לגרום למישהו להסיק שהמערכת שבורה.
//
// ⚠️ ה-CSS נשאר ב-`TrafficLight.css` ומיובא כאן. הפרדה שלו הייתה
// משנה מחלקות שהלוח כבר נשען עליהן, וזה סיכון בלי תמורה.
import { useState } from "react";
import "./TrafficLight.css";

export default function CodePrompt({ onUnlock, onClose, checking, error }) {
  const [code, setCode] = useState("");
  const [shown, setShown] = useState(false);

  return (
    <div className="tl-code-back" onClick={onClose}>
      <form
        className="tl-code"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onUnlock(code); }}
      >
        <h3>מצב עריכה</h3>
        <p>הזיני את קוד המנהל כדי לערוך את הלוח.</p>

        <div className="tl-code-field">
          <input
            type={shown ? "text" : "password"}
            placeholder="קוד מנהל"
            autoComplete="current-password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
          <button
            type="button"
            className="tl-eye"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? "הסתר את הקוד" : "הצג את הקוד"}
            title={shown ? "הסתר" : "הצג"}
          >
            {shown ? (
              // עין חצויה — מוצג כרגע, לחיצה תסתיר
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"
                      fill="none" stroke="currentColor" strokeWidth="1.7" />
                <circle cx="12" cy="12" r="2.7" fill="none" stroke="currentColor" strokeWidth="1.7" />
                <path d="M4 20L20 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"
                      fill="none" stroke="currentColor" strokeWidth="1.7" />
                <circle cx="12" cy="12" r="2.7" fill="none" stroke="currentColor" strokeWidth="1.7" />
              </svg>
            )}
          </button>
        </div>

        {error && <p className="tl-err">{error}</p>}

        <div className="tl-lock-actions">
          <button type="button" className="tl-btn-ghost" onClick={onClose}>ביטול</button>
          <button type="submit" className="tl-btn" disabled={checking || !code}>
            {checking ? "בודק…" : "פתח עריכה"}
          </button>
        </div>
      </form>
    </div>
  );
}
