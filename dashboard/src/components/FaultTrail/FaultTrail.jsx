// components/FaultTrail/FaultTrail.jsx — מה צלצל, ואיך זה נגמר.
//
// ==========================================================
// למה זה קיים
// ==========================================================
// הצליל מתנגן ברגע הכניסה לתקלה. תקלה של 33 שניות מסתיימת לפני שמישהו
// מרים את הראש, הכרטיס חוזר לירוק — ומי ששמע צליל מוצא מסך תקין ואין לו
// דרך לדעת איזה אתר זה היה. כאן כל צלצול משאיר שורה עד שסוגרים אותה.
//
// ⚠️ **גם תקלה שעדיין פתוחה נרשמת כאן**, ולא רק שנסגרה: השורה אומרת
// "עדיין בתקלה", וזה בדיוק מה שהכרטיס האדום אומר — שני מקומות שמסכימים.
//
// ⚠️ **בלי אנימציה ובלי הבהוב**, מאותה סיבה כמו StaleBanner: זה תיעוד של
// מה שכבר קרה, לא אזעקה נוספת. הצליל כבר היה האזעקה.

import "./FaultTrail.css";

const hhmmss = (t) =>
  new Date(t).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function duration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return s === 1 ? "שנייה" : `${s} שניות`;
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "דקה" : `${m} דקות`;
  const h = s / 3600;
  return h < 1.05 ? "שעה" : `${h.toFixed(1)} שעות`;
}

// איך תקלה נגמרה — במילים, לא בשם הסטטוס. "maintenance" אחרי תקלה הוא
// מישהו שהעביר את האתר לתחזוקה, וזה מה שמי שקורא צריך לשמוע.
const ENDED = {
  ready: "חזר לתקין",
  operating: "חזר לפעולה",
  maintenance: "הועבר לתחזוקה",
  no_comm: "איבד תקשורת",
};

export default function FaultTrail({ items, onOpenSite, onDismiss }) {
  if (!items || items.length === 0) return null;

  return (
    <section className="fault-trail" aria-label="תקלות שצלצלו">
      <span className="fault-trail-label">🔔 צלצל</span>
      <ul className="fault-trail-list">
        {items.map((e) => (
          <li key={e.id} className={`fault-trail-item ${e.endedAt ? "is-ended" : "is-open"}`}>
            <span className="fault-trail-dot" aria-hidden="true" />
            <button type="button" className="fault-trail-site" onClick={() => onOpenSite?.(e.code)}>
              {e.name !== e.code ? `${e.name} (${e.code})` : e.code}
            </button>
            <span className="fault-trail-time">נכנס לתקלה ב-{hhmmss(e.at)}</span>
            <span className="fault-trail-end">
              {e.endedAt
                ? `${ENDED[e.endedTo] || `עבר ל-${e.endedTo}`} אחרי ${duration(e.endedAt - e.at)}`
                : "עדיין בתקלה"}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="fault-trail-close" onClick={onDismiss} aria-label="סגירת רשימת התקלות" title="ראיתי — סגור">
        ✕
      </button>
    </section>
  );
}
