// components/FieldReports/FieldReports.jsx — דיווח מהשטח, ותיבת הדואר.
//
// ============================================================
// מסך אחד לשני התפקידים, ולא שניים
// ============================================================
// ⚠️ הפיתוי היה לבנות "מסך דיווח" לאנשי התחזוקה ו"תיבת דואר" למנהלת. שני
// מסכים לאותו נושא הם שני מקומות לחפש בהם, ובפועל **גם המנהלת מדווחת** —
// היא בשטח לא פחות מהם.
//
// לכן: אותו מסך, והתוכן נגזר ממה שהמסד מחזיר. RLS כבר קובעת שמנהלת רואה
// הכול ומדווח רואה את שלו; הרכיב פשוט מציג את מה שהגיע. אין כאן שום תנאי
// הרשאה — תנאי בקוד הזה היה **נראה** כמו הגנה, ואפשר לעקוף אותו בשורת
// fetch אחת.
import { useState, useEffect, useCallback, useRef } from "react";
import {
  submitFieldReport, fetchFieldReports, fetchReportImage,
  resolveFieldReport, MAX_FILES, MAX_BODY, MIN_NAME,
} from "../../services/fieldReportsDirect";
import { useAuth } from "../../hooks/useAuth";
import {
  publishAnnouncement, fetchAnnouncements, MAX_TITLE, MAX_ANN_BODY,
} from "../../services/announcementsDirect";
import "./FieldReports.css";

const fmt = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("he-IL", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
};

export default function FieldReports({ sites = [], onClose }) {
  const { user } = useAuth();
  const isManager = user?.role === "manager";

  const [tab, setTab] = useState("new");     // new | inbox
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // --- טופס ---
  const [reporter, setReporter] = useState("");
  const [body, setBody] = useState("");
  const [siteCode, setSiteCode] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const fileInput = useRef(null);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReports(await fetchFieldReports({ limit: 100 }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (tab === "inbox") load(); }, [tab, load]);

  // ⚠️ **נקודת כניסה אחת לשני המסלולים.** הכפתור והגרירה חייבים להתנהג
  // זהה — חיתוך לארבע, וסינון למה שהוא באמת תמונה. שני מסלולים עם שני
  // כללים הם בדיוק המקום שבו אחד מהם מפספס.
  function addFiles(incoming) {
    // ⚠️ סינון לפי type: גרירה מקבלת **כל** קובץ — PDF, תיקייה, קיצור
    // דרך. ה-RPC ידחה אותם, אבל רק אחרי שהמשתמש כתב את כל הדיווח.
    const images = Array.from(incoming || []).filter((f) => f.type?.startsWith("image/"));
    if (images.length === 0) {
      if ((incoming || []).length > 0) setError("אפשר לצרף תמונות בלבד");
      return;
    }
    // ⚠️ החיתוך כאן ולא רק ב-SQL: מי שבחר שש תמונות צריך לראות מיד שארבע
    // נכנסו, ולא לגלות את זה בשגיאה אחרי שלחץ "שלח".
    setFiles((cur) => [...cur, ...images].slice(0, MAX_FILES));
  }

  function pickFiles(e) {
    addFiles(e.target.files);
    e.target.value = "";   // כדי שבחירה חוזרת של אותו קובץ תעבוד
  }

  // ============================================================
  // ⚠️ הגרירה חייבת לבטל את ברירת המחדל **בשני** האירועים
  // ============================================================
  // בלי preventDefault ב-dragOver הדפדפן פשוט **פותח את התמונה** במקום
  // הדף — כלומר המשתמש מאבד את כל מה שכתב. זה לא באג נדיר אלא
  // התנהגות ברירת המחדל.
  function onDragOver(e) {
    e.preventDefault();
    setDragging(true);
  }

  // ⚠️ relatedTarget: dragLeave נורה גם כשהעכבר עובר בין **ילדים** של
  // אזור השחרור, וכיבוי הסימון שם גורם להבהוב מטורף תוך כדי גרירה.
  function onDragLeave(e) {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragging(false);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer?.files);
  }

  async function send() {
    // ⚠️ השם נבדק **ראשון**, כי הוא השדה הראשון בטופס. בדיקה בסדר
    // אחר שולחת את המשתמש לתקן שדה שנמצא מעל זה שהוא מסתכל עליו.
    if (reporter.trim().length < MIN_NAME) {
      setError("חובה למלא שם");
      return;
    }
    if (body.trim().length < 5) {
      setError("כתוב לפחות כמה מילים");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitFieldReport({ body, siteCode: siteCode || null, files, reportedByName: reporter });
      setBody("");
      setSiteCode("");
      // ⚠️ השם **אינו** מתאפס. אותו אדם מדווח כמה פעמים ברצף, והכרחה
      // להקליד אותו מחדש בכל פעם היא בדיוק מה שגורם לאנשים להקליד
      // "א" ולעבור הלאה — כלומר לרוקן את השדה מתוכן.
      setFiles([]);
      setSent(true);
      // ⚠️ ההודעה נעלמת מעצמה: "נשלח ✓" שנשאר על המסך לנצח קורא כאילו
      // הדיווח **הבא** גם נשלח, ומי שכותב שניים ברצף מתבלבל.
      setTimeout(() => setSent(false), 4000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fr-backdrop" onClick={onClose}>
      <div className="fr-panel" onClick={(e) => e.stopPropagation()}>
        <div className="fr-head">
          {/* ⚠️ לא "דיווח תקלה": הכותרת היא מה שקובע מה אנשים מרגישים
              שמותר לכתוב. מי שיש לו הערה על המסך לא ייכנס למקום שכתוב
              עליו "תקלות". */}
          <h2>כתבו לנו</h2>
          <button className="fr-x" onClick={onClose} aria-label="סגור">×</button>
        </div>

        <div className="fr-tabs">
          <button className={tab === "new" ? "on" : ""} onClick={() => setTab("new")}>
            הודעה חדשה
          </button>
          <button className={tab === "inbox" ? "on" : ""} onClick={() => setTab("inbox")}>
            {isManager ? "כל ההודעות" : "מה שכתבתי"}
          </button>
          {/* ⚠️ רק למנהלת, ובכוונה גם בתצוגה: ה-RPC ידחה כל אחד אחר,
              אבל לשונית שמובילה ל-403 היא הדרך האמינה לגרום למישהו
              להסיק שהמערכת שבורה. ההגנה ב-SQL; זו רק כנות. */}
          {isManager && (
            <button className={tab === "system" ? "on" : ""} onClick={() => setTab("system")}>
              הודעת מערכת
            </button>
          )}
        </div>

        {error && <div className="fr-error">{error}</div>}

        {tab === "new" ? (
          <div className="fr-form">
            <label className="fr-field">
              {/* ⚠️ הזהות כבר מאומתת, אז למה שם מוקלד: החשבון עונה על
                  "מאיזו תיבה נשלח" ולא על "מי ראה". sherut@parkomat.co.il
                  היא תיבה משותפת ולאף משתמש אין full_name. אותו נימוק
                  בדיוק כמו בתחזוקה ידנית. */}
              <span>שם</span>
              <input
                type="text"
                value={reporter}
                placeholder="מי מדווח?"
                onChange={(e) => setReporter(e.target.value)}
              />
            </label>

            <label className="fr-field">
              <span>מה רצית לומר?</span>
              <textarea
                rows={6}
                value={body}
                maxLength={MAX_BODY}
                // ⚠️ ה-placeholder הוא ההנחיה האמיתית. "תאר את הממצא"
                // קורא כטופס תקלות, ומי שרצה להעיר על המסך סוגר את החלון.
                placeholder="תקלה שראיתם, הערה על המסך, רעיון לשיפור — הכול מתקבל"
                onChange={(e) => setBody(e.target.value)}
              />
              <small>{body.length} / {MAX_BODY}</small>
            </label>

            <label className="fr-field">
              <span>אתר <em>(לא חובה)</em></span>
              <select value={siteCode} onChange={(e) => setSiteCode(e.target.value)}>
                <option value="">— ללא שיוך —</option>
                {sites.map((s) => (
                  <option key={s.code} value={s.code}>{s.site_name}</option>
                ))}
              </select>
            </label>

            <div
              className={`fr-field fr-drop ${dragging ? "is-over" : ""}`}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              <span>צילומי מסך <em>(עד {MAX_FILES})</em></span>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                onChange={pickFiles}
                style={{ display: "none" }}
              />
              <button
                type="button"
                className="fr-attach"
                onClick={() => fileInput.current?.click()}
                disabled={files.length >= MAX_FILES}
              >
                📎 צרף תמונה
              </button>

              {files.length > 0 && (
                <ul className="fr-files">
                  {files.map((f, i) => (
                    <li key={i}>
                      <span>{f.name}</span>
                      <button onClick={() => setFiles((c) => c.filter((_, k) => k !== i))}>×</button>
                    </li>
                  ))}
                </ul>
              )}
              {/* ⚠️ נאמר מראש ולא כשגיאה אחרי השליחה. */}
              <small>
                אפשר גם לגרור תמונות לכאן. הן נדחסות לפני השליחה — לא צריך להקטין אותן.
              </small>
            </div>

            <div className="fr-actions">
              {sent && <span className="fr-sent">נשלח ✓</span>}
              {/* ⚠️ מושבת ולא נכשל: עדיף שהכפתור יאמר מראש שחסר משהו
                  מאשר שיקבל לחיצה ויחזיר שגיאה. */}
              <button
                className="fr-send"
                onClick={send}
                disabled={busy || reporter.trim().length < MIN_NAME}
              >
                {busy ? "שולח…" : "שלח"}
              </button>
            </div>
          </div>
        ) : tab === "system" ? (
          <SystemMessage onError={setError} />
        ) : (
          <ReportList
            reports={reports}
            loading={loading}
            isManager={isManager}
            sites={sites}
            onChanged={load}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

function ReportList({ reports, loading, isManager, sites, onChanged, onError }) {
  if (loading) return <div className="fr-empty">טוען…</div>;
  if (reports.length === 0) return <div className="fr-empty">עדיין אין הודעות.</div>;

  const nameOf = (siteId) => sites.find((s) => s.id === siteId)?.site_name ?? null;

  return (
    <ul className="fr-list">
      {reports.map((r) => (
        <ReportRow
          key={r.id}
          report={r}
          siteName={nameOf(r.site_id)}
          isManager={isManager}
          onChanged={onChanged}
          onError={onError}
        />
      ))}
    </ul>
  );
}

function ReportRow({ report: r, siteName, isManager, onChanged, onError }) {
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState(null);   // null = טרם נשלפו
  const [busy, setBusy] = useState(false);

  // ============================================================
  // ⚠️ ה-base64 נשלף רק כשפותחים
  // ============================================================
  // ארבע תמונות של 150KB הן 600KB **לכל דיווח**. תיבה עם חמישים דיווחים
  // הייתה מורידה 30MB בפתיחה, על טלפון, לפני שמישהו הסתכל על משהו.
  useEffect(() => {
    if (!open || images !== null || r.files.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const urls = [];
        for (const f of r.files) urls.push({ id: f.id, url: await fetchReportImage(f.id) });
        if (!cancelled) setImages(urls);
      } catch (e) {
        if (!cancelled) onError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [open, images, r.files, onError]);

  async function markDone() {
    setBusy(true);
    try {
      await resolveFieldReport(r.id);
      onChanged();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const done = r.status === "done";

  return (
    <li className={`fr-item ${done ? "is-done" : ""}`}>
      <div className="fr-item-head" onClick={() => setOpen((o) => !o)}>
        <span className={`fr-dot ${done ? "done" : "open"}`} />
        <div className="fr-item-main">
          <div className="fr-item-body">{r.body}</div>
          <div className="fr-item-meta">
            {/* ⚠️ השם המוקלד קודם והחשבון אחריו, ולא להפך: מי שקורא
                רוצה לדעת את מי לשאול. "מאיזו תיבה" הוא הפרט המשני. */}
            <strong>{r.reported_by_name || r.reported_by}</strong>
            {r.reported_by_name && <> ({r.reported_by})</>}
            {" · "}{fmt(r.created_at)}
            {siteName && <> · <strong>{siteName}</strong></>}
            {r.files.length > 0 && <> · 📎 {r.files.length}</>}
          </div>
        </div>
        <span className="fr-chev">{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div className="fr-item-open">
          {r.files.length > 0 && (
            <div className="fr-shots">
              {images === null
                ? <span className="fr-empty">טוען תמונות…</span>
                : images.map((im) => (
                    // ⚠️ נפתח בלשונית חדשה ולא מוגדל במקום: צילום מסך של
                    // בקר מלא בטקסט קטן, וזום בתוך חלונית קטנה אינו קריא.
                    <a key={im.id} href={im.url} target="_blank" rel="noreferrer">
                      <img src={im.url} alt="צילום מהשטח" />
                    </a>
                  ))}
            </div>
          )}

          {done ? (
            <div className="fr-resolved">
              טופל ע"י {r.resolved_by} · {fmt(r.resolved_at)}
              {r.resolved_note && <> · {r.resolved_note}</>}
            </div>
          ) : isManager ? (
            <button className="fr-done" onClick={markDone} disabled={busy}>
              {busy ? "מסמן…" : "סמן כטופל"}
            </button>
          ) : (
            // ⚠️ למדווח נאמר מה מצב הדיווח, ולא מוצג כפתור שייתן לו 403.
            <div className="fr-waiting">ממתין לטיפול</div>
          )}
        </div>
      )}
    </li>
  );
}


// ============================================================
// הודעת מערכת — כתיבה, ורשימת מה שנשלח
// ============================================================
// ⚠️ הרשימה כאן אינה קישוט: הודעה קופצת פעם אחת לכל אדם ואז נעלמת,
// ולכן אחרי הפרסום אין שום מקום שבו אפשר לראות מה נכתב. בלי הרשימה
// המנהלת שולחת הודעה ומאבדת אותה מיד.
function SystemMessage({ onError }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [past, setPast] = useState([]);

  const load = useCallback(async () => {
    try {
      setPast(await fetchAnnouncements(20));
    } catch (e) {
      onError(e.message);
    }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  async function publish() {
    setBusy(true);
    try {
      await publishAnnouncement({ title, body });
      setTitle("");
      setBody("");
      setSent(true);
      setTimeout(() => setSent(false), 4000);
      load();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const ready = title.trim().length >= 2 && body.trim().length >= 5;

  return (
    <div className="fr-form">
      {/* ⚠️ נאמר לפני הכתיבה ולא אחריה: ההודעה עוצרת את כל מי שנכנס עד
          שילחץ, וכדאי שמי שכותב אותה יידע את זה בזמן שהוא מנסח. */}
      <div className="fr-note">
        ההודעה תקפוץ פעם אחת לכל מי שייכנס לדשבורד, עם צליל, ולא תופיע לו שוב.
      </div>

      <label className="fr-field">
        <span>כותרת</span>
        <input
          type="text"
          value={title}
          maxLength={MAX_TITLE}
          placeholder="למשל: עדכון במסך התקלות"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label className="fr-field">
        <span>תוכן</span>
        <textarea
          rows={7}
          value={body}
          maxLength={MAX_ANN_BODY}
          placeholder="מה חשוב שכולם יידעו"
          onChange={(e) => setBody(e.target.value)}
        />
        <small>{body.length} / {MAX_ANN_BODY}</small>
      </label>

      <div className="fr-actions">
        {sent && <span className="fr-sent">פורסם ✓</span>}
        <button className="fr-send" onClick={publish} disabled={busy || !ready}>
          {busy ? "מפרסם…" : "פרסם לכולם"}
        </button>
      </div>

      {past.length > 0 && (
        <>
          <div className="fr-field"><span>הודעות קודמות</span></div>
          <ul className="fr-list">
            {past.map((a) => (
              <li key={a.id} className="fr-item">
                <div className="fr-item-head" style={{ cursor: "default" }}>
                  <div className="fr-item-main">
                    <div className="fr-item-body"><strong>{a.title}</strong> — {a.body}</div>
                    <div className="fr-item-meta">{a.created_by} · {fmt(a.created_at)}</div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}