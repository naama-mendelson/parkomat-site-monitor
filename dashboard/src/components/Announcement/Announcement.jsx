// components/Announcement/Announcement.jsx — הכרזה חד-פעמית.
//
// ============================================================
// ⚠️ הצליל מנוגן פעם אחת, ורק אחרי שההכרזה באמת עלתה
// ============================================================
// הפיתוי היה לנגן ברגע שהשליפה חוזרת. אבל השליפה חוזרת גם למי שכבר ראה
// — ואז נשמע צליל בלי שקופץ כלום, וזה מבלבל הרבה יותר מאשר שקט.
//
// ⚠️ ובדפדפן, צליל בטעינה טרייה **חסום** עד למחווה ראשונה. `announce()`
// מכיר את זה ושומר את הצליל בתור; הוא יישמע ברגע שהמשתמש ילחץ על משהו —
// כולל על "הבנתי". זו לא עקיפה של המדיניות אלא עבודה איתה, וזו גם הסיבה
// שאין כאן טיפול שגיאה: אין מה לתפוס.
import { useEffect, useState, useRef } from "react";
import { pendingAnnouncement, markAnnouncementSeen } from "../../services/announcementsDirect";
import { announce } from "../../utils/audio/alerts";
import "./Announcement.css";

export default function Announcement() {
  const [item, setItem] = useState(null);
  const [busy, setBusy] = useState(false);
  // ⚠️ ref ולא state: שינוי state היה מרנדר מחדש ומריץ את ה-effect שוב.
  const played = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const a = await pendingAnnouncement();
      if (cancelled || !a) return;
      setItem(a);
      if (!played.current) {
        played.current = true;
        announce();
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!item) return null;

  async function dismiss() {
    setBusy(true);
    try {
      await markAnnouncementSeen(item.key);
      setItem(null);
    } catch {
      // ⚠️ נסגר גם אם השמירה נכשלה. הכרזה שמסרבת להיסגר בגלל קפיצת רשת
      // היא מסך חסום — והמחיר של כישלון הוא שהיא תופיע שוב פעם אחת,
      // וזה בהרבה פחות גרוע.
      setItem(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    // ⚠️ אין סגירה בלחיצה על הרקע ואין ✕. הבקשה הייתה שההודעה **תבשר**,
    // וסגירה מקרית בלחיצה ליד הייתה מסמנת "ראיתי" למי שלא ראה כלום.
    <div className="ann-backdrop" role="dialog" aria-modal="true" aria-labelledby="ann-title">
      <div className="ann-card">
        <div className="ann-badge">חדש</div>
        <h2 id="ann-title">{item.title}</h2>
        {/* white-space: pre-line ב-CSS — הטקסט מגיע עם שורות ריקות */}
        <p className="ann-body">{item.body}</p>
        <button className="ann-ok" onClick={dismiss} disabled={busy} autoFocus>
          {busy ? "רגע…" : "הבנתי"}
        </button>
      </div>
    </div>
  );
}
