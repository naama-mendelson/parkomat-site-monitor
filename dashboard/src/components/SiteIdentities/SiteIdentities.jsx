// זהויות אתרים — המקום שבו חשבון ה-Supabase של כל אתר נוצר, מושבת ומוחלף.
//
// ============================================================
// ⚠️ המסך הזה נולד מתקלה, ולא מבקשת תכונה
// ============================================================
// עד 15/09/2026 זהויות הסוכן ישבו ב**רשימת המשתמשים**, בין בני אדם. 21 שורות
// `site-XXXX@parkomat.co.il` נראות שם בדיוק כמו זבל שצריך לנקות, והן נמחקו —
// בהיגיון מלא. המחיקה ניתקה את המסלול הישיר ב-19 אתרים באותה דקה.
//
// ואיש לא ידע: MQTT המשיך למסור, המסכים נשארו נכונים, ורק הפעימה מתה — כלומר
// **זיהוי הניתוק עצמו**. הכשל לא היה במחיקה אלא בכך שהן הוצגו במקום שבו
// מחיקה היא הפעולה הנכונה, בלי שום הקשר שיסביר מה הן.
//
// לכן כאן, ורק כאן, הן מופיעות — עם ההקשר שהופך אותן למובנות: איזה אתר, האם
// הוא פועם, ומה קורה אם משביתים.
import { useEffect, useState } from "react";
import { listSiteIdentities, provisionAgent, setUserActive, agentEverBeat } from "../../services/dataSource";
import "./SiteIdentities.css";

const STATE_LABEL = {
  active: "פעילה",
  disabled: "מושבתת",
  none: "אין זהות",
};

// ⚠️ "פועם" נמדד מול אותו סף שהשרת משתמש בו (`mark_silent_agents(3)`).
// סף אחר כאן היה מציג "פועם" לאתר שהשרת כבר מחשיב שותק.
const BEAT_FRESH_MS = 3 * 60 * 1000;

function beatLabel(seenAt) {
  if (!seenAt) return { text: "מעולם לא פעם", fresh: false };
  const t = Date.parse(seenAt);
  if (!Number.isFinite(t)) return { text: "—", fresh: false };
  const min = Math.round((Date.now() - t) / 60000);
  if (Date.now() - t <= BEAT_FRESH_MS) return { text: "פועם", fresh: true };
  return { text: min < 60 ? `לפני ${min} דק׳` : `לפני ${Math.round(min / 60)} שעות`, fresh: false };
}

export default function SiteIdentities() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [issued, setIssued] = useState(null);
  const [confirmOff, setConfirmOff] = useState(null);
  const [confirmRotate, setConfirmRotate] = useState(null);

  // ⚠️ אותו נרמול בדיוק כמו בחיפוש האתרים וברמזור: מתעלם מפיסוק ומרווחים,
  // כך ש"אביגיל 20 רג" ימצא את `אביגיל 20, ר"ג`. חיפוש שמתנהג אחרת בכל מסך
  // מלמד את המשתמשת שלא כדאי לסמוך עליו.
  const [query, setQuery] = useState("");
  const normQ = (v) => String(v ?? "").replace(/[^0-9א-תA-Za-z]/g, "").toLowerCase();

  const load = () =>
    listSiteIdentities().then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function issue(row, rotate = false) {
    setBusy(row.code); setErr(null);
    try {
      const r = await provisionAgent(row.code, { rotate });
      setIssued({ code: row.code, name: row.name, email: r.email, password: r.password, rotated: Boolean(r.rotated) });
      await load();
    } catch (e) {
      setErr(e.message);
    } finally { setBusy(null); }
  }

  // ============================================================
  // ⚠️ "סיסמה חדשה" — באישור, אלא אם האתר מעולם לא פעם
  // ============================================================
  // כאן זה היה לחיצה אחת, בזמן שב-AdminPanel אותה פעולה בדיוק דורשת אישור.
  // סיבוב מבטל את הסיסמה שבאתר מיד: ב-2438, שרץ **רק** במסלול הישיר, לחיצה
  // שגויה אחת הייתה משתיקה את האתר עד שמישהו ייסע לעדכן את ה-config.
  //
  // אותו כלל כמו שם: `false` ("מעולם לא פעם") — אין מה לשבור, מסובבים מיד.
  // `null` ("לא הצלחתי לברר") דורש אישור כמו אתר שפועם. ⚠️ לא `row.lastBeat`:
  // הרשימה אינה בודקת את השגיאה של שאילתת הפעימות, ולכן כשל שם נראה בדיוק
  // כמו "מעולם לא פעם".
  async function askRotate(row) {
    setBusy(row.code); setErr(null);
    let beat = null;
    try { beat = await agentEverBeat(row.siteId); } catch { beat = null; }
    setBusy(null);
    if (beat === false) { await issue(row, true); return; }
    setConfirmRotate(row.code);
  }

  async function toggleActive(row, active) {
    setBusy(row.code); setErr(null);
    try {
      await setUserActive(row.userId, active);
      setConfirmOff(null);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally { setBusy(null); }
  }

  if (err && !rows) return <div className="si-err">{err}</div>;
  if (!rows) return <div className="si-load">טוען…</div>;

  const missing = rows.filter((r) => r.state !== "active");
  const q = normQ(query);
  const shown = q ? rows.filter((r) => normQ(r.name).includes(q) || normQ(r.code).includes(q)) : rows;

  return (
    <div className="si">
      <div className="si-head">
        <h3>זהויות אתרים</h3>
        <p>
          לכל אתר חשבון Supabase משלו, שדרכו הסוכן כותב ישירות. ⚠️ זהו <b>לא</b> משתמש
          אנושי — הוא לא יופיע ברשימת המשתמשים ואין להיכנס איתו.
        </p>
        {missing.length > 0 && (
          <div className="si-summary">
            ⚠️ {missing.length} אתרים ללא זהות פעילה — הם מדווחים ב-MQTT, אך ללא כתיבה
            ישירה ובלי זיהוי ניתוק.
          </div>
        )}
      </div>

      {err && <div className="si-err">{err}</div>}

      {/* ============================================================
          ⚠️ הסיסמה מוצגת פעם אחת ואינה ניתנת לשחזור
          ============================================================
          Supabase שומרת hash בלבד. חלון שנעלם מעצמו היה משמיד אותה ומשאיר
          אתר שאי אפשר לחבר — ולכן הסגירה היא פעולה מכוונת. */}
      {issued && (
        <div className="si-issued">
          <div className="si-issued-title">
            {issued.rotated ? "סיסמה חדשה הונפקה" : "זהות נוצרה"} · {issued.name} ({issued.code})
          </div>
          <div className="si-kv"><span>משתמש</span><code>{issued.email}</code></div>
          <div className="si-kv"><span>סיסמה</span><code className="si-pw">{issued.password}</code></div>
          <p className="si-warn">
            ⚠️ הסיסמה מוצגת <b>פעם אחת בלבד</b>. להעתיק אותה עכשיו ולהזין בטריי של האתר
            (הגדרות ← Supabase). אחרי סגירה אי אפשר לשחזר — רק להנפיק חדשה.
          </p>
          <button className="si-btn" onClick={() => setIssued(null)}>העתקתי — סגור</button>
        </div>
      )}

      <div className="si-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש אתר לפי שם או קוד…"
          aria-label="חיפוש אתר"
        />
        {q && <span className="si-search-count">{shown.length} מתוך {rows.length}</span>}
      </div>

      <table className="si-table">
        <thead>
          <tr><th>קוד</th><th>אתר</th><th>זהות</th><th>פעימה</th><th>גרסה</th><th /></tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const beat = beatLabel(r.lastBeat);
            return (
              <tr key={r.siteId} className={r.state === "active" ? "" : "si-row-off"}>
                <td>{r.code}</td>
                <td>{r.name}</td>
                <td>
                  <span className={`si-state si-state-${r.state}`}>{STATE_LABEL[r.state]}</span>
                </td>
                <td><span className={beat.fresh ? "si-beat-ok" : "si-beat-off"}>{beat.text}</span></td>
                <td>{r.agentVersion ?? "—"}</td>
                <td className="si-actions">
                  {r.state === "none" && (
                    <button className="si-btn" disabled={busy === r.code} onClick={() => issue(r)}>
                      {busy === r.code ? "מנפיק…" : "צור זהות"}
                    </button>
                  )}
                  {r.state === "disabled" && (
                    <button className="si-btn" disabled={busy === r.code} onClick={() => toggleActive(r, true)}>
                      הפעל מחדש
                    </button>
                  )}
                  {r.state === "active" && (
                    <>
                      {/* ⚠️ "השבת" ולא "מחק", וזו אינה בחירת מילים.
                          מחיקה מוחקת גם את החשבון, ואז הסיסמה שבאתר חסרת
                          ערך — בדיוק מה שקרה ל-19 אתרים. השבתה עוצרת את
                          הכתיבה מיד (`app.agent_site_id()` דורשת is_active)
                          והיא הפיכה בלחיצה, בלי לנסוע לאף מקום. */}
                      <button className="si-btn si-btn-warn" disabled={busy === r.code}
                        onClick={() => setConfirmOff(r.code)}>
                        השבת
                      </button>
                      <button className="si-btn" disabled={busy === r.code} onClick={() => askRotate(r)}>
                        סיסמה חדשה
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* ⚠️ "לא נמצא" מפורש, ולא טבלה ריקה: טבלה בלי שורות נראית כמו תקלת
          טעינה, ולא כמו תוצאה של מה שהוקלד. */}
      {shown.length === 0 && <p className="si-empty">אין אתר שתואם ל"{query}".</p>}

      {confirmRotate && (() => {
        const row = rows.find((r) => r.code === confirmRotate);
        if (!row) return null;
        return (
          <div className="si-confirm">
            <p>
              להנפיק סיסמה חדשה ל-<b>{row.name}</b> ({row.code})?
            </p>
            <p className="si-warn">
              ⚠️ הסיסמה שבאתר <b>תפסיק לעבוד מיד</b>. אם האתר כותב ישירות ל-Supabase
              הוא יפסיק לדווח במסלול הזה עד שהסיסמה החדשה תוזן בהגדרות הסוכן שבאתר.
            </p>
            <div className="si-confirm-actions">
              <button className="si-btn si-btn-warn" disabled={busy === row.code}
                onClick={async () => { setConfirmRotate(null); await issue(row, true); }}>
                הנפק סיסמה חדשה
              </button>
              <button className="si-btn" onClick={() => setConfirmRotate(null)}>ביטול</button>
            </div>
          </div>
        );
      })()}

      {confirmOff && (() => {
        const row = rows.find((r) => r.code === confirmOff);
        return (
          <div className="si-confirm">
            <p>
              להשבית את הזהות של <b>{row.name}</b> ({row.code})?
            </p>
            <p className="si-warn">
              ⚠️ האתר יפסיק לכתוב ישירות ל-Supabase מיד, ותאבד עבורו <b>זיהוי הניתוק</b>.
              הוא ימשיך לדווח ב-MQTT, כך שהמסכים יישארו נכונים.
              {" "}הפעולה <b>הפיכה</b>: "הפעל מחדש" מחזיר אותה, והסיסמה שבאתר נשארת תקפה.
            </p>
            <div className="si-confirm-actions">
              <button className="si-btn si-btn-warn" onClick={() => toggleActive(row, false)}>השבת</button>
              <button className="si-btn" onClick={() => setConfirmOff(null)}>ביטול</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
