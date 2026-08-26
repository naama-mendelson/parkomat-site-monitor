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
  resolveFieldReport, MAX_FILES, MAX_BODY,
} from "../../services/fieldReportsDirect";
import { useAuth } from "../../hooks/useAuth";
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
  const [body, setBody] = useState("");
  const [siteCode, setSiteCode] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const fileInput = useRef(null);

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

  function pickFiles(e) {
    const picked = Array.from(e.target.files || []);
    // ⚠️ החיתוך כאן ולא רק ב-SQL: מי שבחר שש תמונות צריך לראות מיד שארבע
    // נכנסו, ולא לגלות את זה בשגיאה אחרי שלחץ "שלח".
    setFiles((cur) => [...cur, ...picked].slice(0, MAX_FILES));
    e.target.value = "";   // כדי שבחירה חוזרת של אותו קובץ תעבוד
  }

  async function send() {
    if (body.trim().length < 5) {
      setError("כתוב לפחות כמה מילים");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitFieldReport({ body, siteCode: siteCode || null, files });
      setBody("");
      setSiteCode("");
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
          <h2>דיווח מהשטח</h2>
          <button className="fr-x" onClick={onClose} aria-label="סגור">×</button>
        </div>

        <div className="fr-tabs">
          <button className={tab === "new" ? "on" : ""} onClick={() => setTab("new")}>
            דיווח חדש
          </button>
          <button className={tab === "inbox" ? "on" : ""} onClick={() => setTab("inbox")}>
            {isManager ? "כל הדיווחים" : "הדיווחים שלי"}
          </button>
        </div>

        {error && <div className="fr-error">{error}</div>}

        {tab === "new" ? (
          <div className="fr-form">
            <label className="fr-field">
              <span>מה ראית?</span>
              <textarea
                rows={6}
                value={body}
                maxLength={MAX_BODY}
                placeholder="תאר את הממצא — מה קרה, איפה, ומתי"
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

            <div className="fr-field">
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
              <small>התמונות נדחסות לפני השליחה — לא צריך להקטין אותן.</small>
            </div>

            <div className="fr-actions">
              {sent && <span className="fr-sent">נשלח ✓</span>}
              <button className="fr-send" onClick={send} disabled={busy}>
                {busy ? "שולח…" : "שלח דיווח"}
              </button>
            </div>
          </div>
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
  if (reports.length === 0) return <div className="fr-empty">אין דיווחים.</div>;

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
            {r.reported_by} · {fmt(r.created_at)}
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
