// components/ServerControl/ServerControl.jsx — "הפעל מחדש את השרת".
//
// ============================================================
// ⚠️ הכפתור נחוץ בדיוק כשהשרת לא עונה
// ============================================================
// ולכן הוא **אינו** קורא לשרת. הוא כותב שורה ב-Supabase, וסקריפט על
// מכונת השרת — שרץ מחוץ ל-Docker — קורא ומבצע. ב-27/08/2026 המכונה
// איבדה חשמל, Docker לא עלה בלי התחברות משתמש, והמערכת הייתה למטה
// 2.5 ימים. כפתור שעובר דרך השרת היה חסר תועלת בדיוק אז.
import { useEffect, useState, useRef } from "react";
import {
  requestServiceRestart, recentServiceCommands, subscribeServiceCommands, useDirect,
} from "../../services/dataSource";
import "./ServerControl.css";

const LABEL = {
  pending: "ממתין למכונה",
  running: "רץ עכשיו",
  done: "הסתיים בהצלחה",
  failed: "נכשל",
  expired: "פג — המכונה לא הגיבה",
};

const ilTime = (iso) => {
  if (!iso) return "";
  const d = new Date(Date.parse(iso));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
};

export default function ServerControl() {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  // ⚠️ ref ולא state: הרענון אחרי שינוי חי לא צריך לגרור רינדור נוסף.
  const timer = useRef(null);

  async function load() {
    try { setRows(await recentServiceCommands(5)); }
    catch (e) { setErr(e.message); }
  }

  useEffect(() => {
    // ⚠️ במצב שרת אין למי לפנות — הטבלה חיה ב-Supabase בלבד. השומר בראש
    // ה-effect ולא לפני ה-return, אחרת השאילתה והמנוי היו רצים בכל מקרה.
    if (!useDirect) return undefined;
    load();
    const stop = subscribeServiceCommands(() => load());
    return () => { stop(); if (timer.current) clearTimeout(timer.current); };
  }, []);

  if (!useDirect) return null;

  const open = rows.find((r) => r.status === "pending" || r.status === "running");

  async function fire() {
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await requestServiceRestart(reason);
      setMsg(r.message);
      setReason("");
      setConfirming(false);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="svc">
      <h3>הפעלה מחדש של השרת</h3>

      {/* ============================================================ */}
      {/* ⚠️ מה זה עושה נכתב במפורש, לפני הלחיצה                      */}
      {/* ============================================================ */}
      {/* זו פעולה שמפילה את הקליטה לכמה דקות. כפתור שכתוב עליו רק      */}
      {/* "הפעל מחדש" מזמין לחיצה מתוך תקווה, ואז מפתיע.               */}
      <p className="svc-what">
        מרים מחדש את Docker ואת כל השירותים על מחשב השרת.
        <strong> הקליטה תיפסק ל-1–4 דקות.</strong> הודעות שיגיעו בינתיים
        נשמרות ב-HiveMQ ונמסרות בחזרה.
      </p>
      <p className="svc-when">
        מתי כדאי: האתרים מפסיקים להתעדכן, או שהמסך מציג נתונים ישנים ואין הסבר.
      </p>

      {err && <div className="svc-err">{err}</div>}
      {msg && <div className="svc-ok">{msg}</div>}

      {open ? (
        <div className={`svc-live svc-live-${open.status}`}>
          <span className="svc-spin" aria-hidden="true" />
          <div>
            <strong>{LABEL[open.status]}</strong>
            <div className="svc-live-sub">
              ביקשה: {open.requested_by} · {ilTime(open.requested_at)}
            </div>
          </div>
        </div>
      ) : confirming ? (
        <div className="svc-confirm">
          <label className="svc-field">
            <span>למה? <em>(לא חובה, נשמר ביומן)</em></span>
            <input
              type="text" value={reason} maxLength={200} autoFocus
              placeholder="למשל: האתרים לא מתעדכנים מאתמול"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="svc-confirm-actions">
            <button className="svc-cancel" onClick={() => setConfirming(false)} disabled={busy}>
              ביטול
            </button>
            <button className="svc-go" onClick={fire} disabled={busy}>
              {busy ? "שולח…" : "כן, הפעל מחדש"}
            </button>
          </div>
        </div>
      ) : (
        // ⚠️ שני שלבים ולא אחד. הפעלה מחדש של הייצור בלחיצה בודדת ליד
        // כפתור "מחק אתר" היא תאונה שמחכה לקרות.
        <button className="svc-btn" onClick={() => setConfirming(true)}>
          הפעל מחדש את השרת
        </button>
      )}

      {rows.length > 0 && (
        <ul className="svc-hist">
          {rows.map((r) => (
            <li key={r.id} className={`svc-hist-${r.status}`}>
              <span className="svc-hist-when">{ilTime(r.requested_at)}</span>
              <span className="svc-hist-status">{LABEL[r.status] || r.status}</span>
              <span className="svc-hist-who">{r.requested_by}</span>
              {r.reason && <span className="svc-hist-why">{r.reason}</span>}
              {/* ⚠️ תוצאת הכישלון מוצגת. "נכשל" בלי סיבה שולח מישהו לנחש, */}
              {/* וזה בדיוק מה שהופך תקלה קטנה לנסיעה למשרד.               */}
              {r.status === "failed" && r.result && (
                <span className="svc-hist-err">{r.result}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ⚠️ הגבול נאמר, ולא מוסתר. משתמשת שתלחץ ולא יקרה כלום צריכה */}
      {/* לדעת מיד לאן ללכת, במקום להסיק שהכפתור שבור.               */}
      <p className="svc-limit">
        ⚠️ אם המחשב במשרד כבוי לגמרי — הבקשה תמתין 15 דקות ואז תפוג.
        במקרה כזה צריך להדליק אותו פיזית.
      </p>
    </section>
  );
}
