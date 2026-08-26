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
import { subscribeNewReports } from "../../services/reportsLiveDirect";
import { subscribeReload } from "../../services/reloadDirect";
import { useAuth } from "../../hooks/useAuth";
import { announce, getAlertState, unlockAudio } from "../../utils/audio/alerts";
import "./Announcement.css";

export default function Announcement() {
  const { user } = useAuth();
  const [item, setItem] = useState(null);
  // ⚠️ תור ולא ערך יחיד: שני דיווחים בהפרש שניות היו דורסים זה את זה,
  // והשני היה נעלם בלי שאיש ראה אותו.
  const [reports, setReports] = useState([]);
  const [busy, setBusy] = useState(false);
  // ⚠️ ref ולא state: שינוי state היה מרנדר מחדש ומריץ את ה-effect שוב.
  const played = useRef(false);

  // ============================================================
  // ⚠️ ההודעה ממתינה לאודיו — ולא להפך
  // ============================================================
  // דפדפנים חוסמים צליל עד למחווה ראשונה **בטעינה הזו**, וזה חוק ולא
  // באג. בגרסה הקודמת ההודעה קפצה מיד והצליל נכנס לתור — כלומר הוא
  // נשמע רק בלחיצה על "הבנתי", אחרי שההודעה כבר נקראה. הצליל אמור
  // לבשר, לא ללוות סגירה.
  //
  // לכן הסדר הפוך: אם האודיו כבר פתוח (המצב הרגיל — מי שעובד במסך כבר
  // לחץ על משהו) ההודעה והצליל יוצאים יחד. אם הוא חסום, ממתינים למחווה
  // הראשונה — לחיצה כלשהי, מקש כלשהו — ואז שניהם יחד.
  //
  // ⚠️ ותקרה של עשר שניות: מי שפתח את הדשבורד ולא נגע בכלום עדיין צריך
  // לראות את ההודעה. אז היא תעלה בשקט — עדיף הודעה בלי צליל מאשר הודעה
  // שלא מגיעה.
  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const cleanup = () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      if (timer) clearTimeout(timer);
    };

    function reveal(a, withSound) {
      if (cancelled) return;
      cleanup();
      setItem(a);
      if (withSound && !played.current) {
        played.current = true;
        announce();
      }
    }

    // ⚠️ מוגדר לפני ה-listener כדי ש-cleanup יוכל להסיר את **אותה**
    // הפניה. פונקציה חדשה בכל קריאה לא הייתה מוסרת כלום.
    let pending = null;
    function onGesture() {
      if (!pending) return;
      // המחווה עצמה משחררת; unlockAudio סינכרוני מספיק כדי שהצליל
      // שאחריו ייצא באותו טיק.
      unlockAudio(true);
      reveal(pending, true);
    }

    (async () => {
      const a = await pendingAnnouncement();
      if (cancelled || !a) return;

      if (getAlertState() === "ready") {
        reveal(a, true);          // הדרך הרגילה: יחד
        return;
      }

      pending = a;
      window.addEventListener("pointerdown", onGesture);
      window.addEventListener("keydown", onGesture);
      // בלי מחווה — מציגים בשקט אחרי עשר שניות.
      timer = setTimeout(() => reveal(a, false), 10_000);
    })();

    return () => { cancelled = true; cleanup(); };
  }, []);

  // ============================================================
  // דיווח חדש — קופץ חי, ורק למי שרשאי לראות אותו
  // ============================================================
  // ⚠️ אין כאן בדיקת תפקיד: RLS על field_reports היא "מנהלת, או שלי",
  // ו-Realtime מכבד אותה. תנאי בקוד היה **נראה** כמו הגנה ומסתיר את
  // העובדה שההגנה האמיתית היא המדיניות.
  useEffect(() => {
    const stop = subscribeNewReports((row) => {
      // ⚠️ **לא קופץ על הדיווח של עצמי.** מי שלחץ "שלח" לפני שנייה כבר
      // יודע מה כתב, וחלון שקופץ עליו קורא כמו תקלה.
      if (row.reported_by && user?.email && row.reported_by === user.email) return;
      setReports((cur) => [...cur, row]);
      announce();
    });
    return stop;
  }, [user?.email]);

  // ============================================================
  // רענון יזום — הדף נטען מחדש
  // ============================================================
  // ⚠️ מושהה בשנייה, ובכוונה: שמירת הטיוטה ב-FieldReports היא effect,
  // והיא חייבת להספיק לרוץ לפני שהדף מת. בלי ההשהיה הכלי הזה מוחק
  // בדיוק את הטקסט שהוא נכתב כדי להציל.
  //
  // ⚠️ ואין כאן שאלה למשתמש. זו הייתה הבקשה המפורשת — רענון לכולם —
  // וההגנה על מה שנכתב היא הטיוטה, לא דיאלוג שאפשר לבטל.
  useEffect(() => {
    return subscribeReload(() => {
      setTimeout(() => window.location.reload(), 1000);
    });
  }, []);

  // ⚠️ ההודעה קודמת לדיווח: היא חד-פעמית ועוצרת, והדיווח יחכה שנייה.
  if (!item && reports.length === 0) return null;

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

  // ============================================================
  // דיווח חדש — קופץ, אבל **אינו** נשמר כ"נקרא"
  // ============================================================
  // ⚠️ הודעת מערכת נעלמת לתמיד; דיווח נשאר בתיבה. סגירה כאן היא
  // "ראיתי את ההתראה", לא "טיפלתי" — ולכן אין כאן שום כתיבה למסד.
  if (!item && reports.length > 0) {
    const r = reports[0];
    return (
      <div className="ann-backdrop" role="dialog" aria-modal="true">
        <div className="ann-card">
          <div className="ann-badge ann-badge-report">דיווח חדש</div>
          <h2>{r.reported_by_name || r.reported_by}</h2>
          <p className="ann-body">{r.body}</p>
          {/* ============================================================ */}
          {/* ⚠️ פתח — כי חלון שמראה טקסט ואי אפשר לענות בו הוא מבוי סתום */}
          {/* ============================================================ */}
          {/* הגרסה הראשונה הציגה את הדיווח וזהו: אי אפשר היה לראות את    */}
          {/* התמונות ואי אפשר היה להשיב. מי שקיבל התראה נאלץ לזכור לפתוח */}
          {/* את התיבה בעצמו — כלומר ההתראה יצרה עבודה במקום לחסוך אותה.  */}
          <div className="ann-actions">
            <button
              className="ann-ok ann-ok-ghost"
              onClick={() => setReports((cur) => cur.slice(1))}
            >
              {reports.length > 1 ? `הבא (עוד ${reports.length - 1})` : 'סגור'}
            </button>
            <button
              className="ann-ok"
              autoFocus
              onClick={() => {
                // אירוע חלון ולא prop: הכפתור יושב ב-App והחלונית ב-Header,
                // והשחלת callback בין שני עצים היא צימוד שאין בו צורך.
                window.dispatchEvent(new CustomEvent('parkomat:open-reports'));
                setReports((cur) => cur.slice(1));
              }}
            >
              פתח והשב
            </button>
          </div>
        </div>
      </div>
    );
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
