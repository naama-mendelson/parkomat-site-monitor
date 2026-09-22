// components/FaultAck/FaultAckModal.jsx — חלון שחוסם את המסך עד שמאשרים תקלה.
//
// ==========================================================
// החלטות בעלת המוצר (22/09/2026), וכל אחת נראית כאן
// ==========================================================
//   - **כל תקלה מחכה לאישור**, גם אם האתר כבר חזר לתקין. תקלה של 33
//     שניות היא בדיוק זו שאיש לא ראה — ובגללה נבנה כל זה.
//   - **חוסם**: אין ✕, אין סגירה בלחיצה בחוץ, ו-Escape אינו עושה דבר.
//   - **משותף, עם שם**: אישור אחד סוגר את החלון בכל המסכים (UPDATE שנדחף
//     ב-Realtime), ונרשם מי אישר — בשם שהוקלד **ובחשבון** שדרכו אושר.
//
// ⚠️ **השם מוקלד, לא נלקח מהחשבון.** מסך בקרה אחד משרת כמה בקרים
// מאותו חשבון; "אושר ע"י חדר הבקרה" אינו עונה על "מי ראה". אותו כלל כמו
// "מי מבצע" בפתיחת תחזוקה. השם נזכר בדפדפן — לא להקליד אותו בכל תקלה.
//
// ⚠️ **שכבה 8500, מתחת לחלון שחרור הקול (9000).** כשהקול חסום, קודם
// משחררים אותו — אחרת התקלה הבאה שוב לא תישמע — ורק אז מאשרים.
import { useEffect, useRef, useState } from "react";
import "./FaultAckModal.css";

const NAME_KEY = "parkomat.ack.name";
/** כמה שורות מוצגות. השאר נספרות — ומאושרות יחד. */
const SHOW = 8;

const NOW_LABEL = {
  error: "עדיין בתקלה",
  ready: "חזר לתקין",
  operating: "בפעולה",
  maintenance: "בתחזוקה",
  no_comm: "אין תקשורת",
};

// היום — שעה בלבד; אחרת גם תאריך. חלון שנפתח בבוקר על תקלה מהלילה צריך
// לומר שהיא מהלילה, אחרת "02:14" נקרא כמו "לפני רגע".
function when(isoText) {
  const d = new Date(isoText);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const today = new Date().toDateString() === d.toDateString();
  return today ? `ב-${time}` : `ב-${d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" })} ${time}`;
}

function readName() {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}

export default function FaultAckModal({ alarms, sites, onAck }) {
  const [name, setName] = useState(readName);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);
  const open = alarms.length > 0;

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  if (!open) return null;

  const byCode = new Map((sites || []).map((s) => [s.code, s]));
  const shown = alarms.slice(0, SHOW);
  const who = name.trim();

  const submit = async (e) => {
    e.preventDefault();
    if (who.length < 2 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onAck(alarms.map((a) => a.id), who);
      try { localStorage.setItem(NAME_KEY, who); } catch { /* מצב פרטי */ }
    } catch (x) {
      setErr(x.message || "האישור נכשל — נסו שוב");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fack-overlay">
      <form
        className="fack"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fack-title"
        onSubmit={submit}
        // ⚠️ Escape נבלע כאן: אחרת הוא ממשיך למאזינים של הלוחות שמתחת (הרמזור
        // נסגר ב-Escape) — והחלון החוסם היה נשאר, עם מסך אחר מאחוריו.
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); } }}
      >
        <header className="fack-head">
          <span className="fack-mark" aria-hidden="true">!</span>
          <div>
            <h2 id="fack-title">
              {alarms.length === 1 ? "תקלה — נדרש אישור" : `${alarms.length} תקלות — נדרש אישור`}
            </h2>
            <p className="fack-sub">המסך חסום עד שמישהו מאשר שראה. האישור נרשם בשם שתכתבו ונסגר בכל המסכים.</p>
          </div>
        </header>

        <ul className="fack-list">
          {shown.map((a) => {
            const s = byCode.get(a.site_code);
            const now = s?.status;
            return (
              <li key={a.id} className="fack-item">
                <div className="fack-site">{s?.site_name ? `${s.site_name} (${a.site_code})` : a.site_code}</div>
                <div className="fack-meta">
                  <span>נכנס לתקלה {when(a.occurred_at || a.raised_at)}</span>
                  {NOW_LABEL[now] && (
                    <span className={`fack-now${now === "error" ? " is-open" : ""}`}>{NOW_LABEL[now]}</span>
                  )}
                </div>
                {a.fault_text && <div className="fack-text">{a.fault_text}</div>}
              </li>
            );
          })}
        </ul>
        {alarms.length > shown.length && (
          <p className="fack-more">ועוד {alarms.length - shown.length} — כולן יאושרו יחד.</p>
        )}

        <label className="fack-name">
          <span>מי מאשר? (שם מלא)</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            maxLength={80}
          />
        </label>
        {err && <p className="fack-err" role="alert">{err}</p>}

        <button type="submit" className="fack-btn" disabled={busy || who.length < 2}>
          {busy ? "מאשר…" : alarms.length === 1 ? "ראיתי — אישור" : `ראיתי — אישור ${alarms.length}`}
        </button>
      </form>
    </div>
  );
}
