// components/Compliance/PmHistoricalUpload.jsx — העלאת דוחות תחזוקה סרוקים (מילוי לאחור). מנהל בלבד.
//
// ביקורים שנעשו לפני המערכת קיימים כ-PDF בתיקייה. כאן בוחרים כמה קבצים
// בבת אחת, ולכל אחד שורה משלו: תאריך (חובה), מבצע, ספק, הערה.
//
// ⚠️ לכל שורה client_id משלה, שנוצר **פעם אחת** כשהקובץ נבחר ונשלח שוב בכל
// ניסיון. העלאה של 8MB מטלפון נקטעת לעתים קרובות *אחרי* שהשרת כבר שמר —
// ניסיון חוזר עם מזהה חדש היה יוצר ביקור כפול, שמזיז את מועד התחזוקה הבא
// ונראה בהיסטוריה כשני ביקורים. עם אותו מזהה השרת מחזיר replayed — הצלחה.
//
// ⚠️ PT409 (אותו קובץ כבר הועלה לאתר, לפי md5) **אינו** כישלון רשת: ניסיון
// חוזר יידחה תמיד. השורה מציגה את ההודעה של השרת ולא מציעה "נסה שוב".
//
// ⚠️ ובכישלון רשת / זמן קצוב — התוצאה **לא ידועה**, והשדות ננעלים. השרת בודק
// replay לפי client_id לפני כל דבר אחר: אם הניסיון הראשון נשמר, "נסה שוב"
// מחזיר את הביקור **שנשמר אז**, והתיקון (למשל תאריך שתוקן) נזרק בשקט —
// כשהשורה אומרת "✓ כבר הועלה קודם" ומציגה את התאריך המתוקן. מי שצריך לתקן
// פרטים אחרי שהדוח עלה — מוחק את הביקור בהיסטוריה ומעלה מחדש.
// הנעילה נשארת עד הצלחה, או עד דחייה שמוכיחה שלא נשמר דבר (provesNotSaved).
//
// התאריך מוצע מתוך הטקסט של המסמך (parseDate המשותף), ומסומן כהצעה —
// המנהל מאשר אותו. סריקה בלי שכבת טקסט פשוט לא מציעה כלום.
import { useEffect, useRef, useState } from "react";
import { uploadPmHistorical } from "../../services/dataSource";
import { extractPages, isPdfModuleFailure } from "../../utils/pdfText";
import {
  COMPLIANCE_PDF_MAX_BYTES, COMPLIANCE_PDF_WARN_BYTES, formatDateIL, todayIL,
} from "../../utils/compliance";
import { newId } from "../../utils/complianceFiles";
import { NAME_MAX, VISIT_NOTE_MAX, bytesText, isPdfFile, suggestDocDate } from "./PmUtils";

const MIN_DATE = "2000-01-01";

// אין תשובה, או תשובה שאינה מהמסד: רשת / זמן קצוב, או 5xx בלי SQLSTATE (שער
// שוויתר — 502/504 — אחרי שהמסד אולי כבר שמר). 5xx עם קוד של Postgres (57014)
// הוא שאילתה שבוטלה, כלומר rollback — אבל גם אותו לא מנצלים לפתיחה (למטה).
const SQLSTATE = /^[0-9A-Z]{5}$/;
function lostResponse(err) {
  if (err?.network || err?.status === 0) return true;
  return Number(err?.status) >= 500 && !SQLSTATE.test(String(err?.code || ""));
}

// ⚠️ דחייה שמוכיחה שהדוח **לא** נשמר: רק מה ש-pm_historical_upload זורק אחרי
// בדיקת ה-replay (compliance.postgres.sql) — check_violation (תאריך, הערה,
// קובץ), שגיאת נתונים (22xxx), PT409 (הקובץ כבר באתר) ו-PT404 (אתר לא נמצא).
// כל השאר — 401/403/42501, 5xx, ו-23505 (ניסיון קודם שנשמר באותו רגע עם אותו
// client_id) — אינו מוכיח דבר על הניסיון שהתשובה שלו אבדה.
function provesNotSaved(err) {
  const c = String(err?.code || "");
  return c === "23514" || /^22[0-9A-Z]{3}$/.test(c) || c === "PT409" || c === "PT404";
}

const STATUS_TEXT = {
  parsing: "קורא את המסמך…",
  uploading: "מעלה…",
  done: "✓ הועלה",
};

export default function PmHistoricalUpload({ site, onUploaded, onDirty }) {
  const [rows, setRows] = useState([]);
  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);
  const inputRef = useRef(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  const today = todayIL();

  const patch = (key, fields) => {
    if (!aliveRef.current) return;
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...fields } : r)));
  };

  // ⚠️ סדרתי: כל קריאה מפעילה עובד של pdfjs ומפענחת את כל העמודים. עשרה
  // קבצים במקביל בטלפון הם עשרה עובדים — וזה מה שהורג את הלשונית.
  const parseQueue = async (list) => {
    for (const r of list) {
      let suggested = null;
      let parseNote = "";
      try {
        suggested = suggestDocDate(await extractPages(r.file), todayIL());
        if (!suggested) parseNote = "לא נמצא תאריך במסמך — יש להזין ידנית";
      } catch (err) {
        parseNote = isPdfModuleFailure(err)
          ? "רכיב קריאת ה-PDF לא נטען — יש להזין תאריך ידנית (או לרענן את הדף)"
          : "לא ניתן לקרוא את טקסט המסמך (כנראה סריקה) — יש להזין תאריך ידנית";
      }
      if (!aliveRef.current) return;
      setRows((rs) => rs.map((x) => (x.key === r.key
        ? { ...x, status: x.status === "parsing" ? "idle" : x.status, suggested, parseNote, date: x.date || suggested || "" }
        : x)));
    }
  };

  const addFiles = (list) => {
    const files = [...(list || [])];
    if (!files.length) return;
    const add = files.map((file) => {
      const bad = !isPdfFile(file)
        ? "אפשר להעלות קובצי PDF בלבד"
        : file.size > COMPLIANCE_PDF_MAX_BYTES
          ? `הקובץ גדול מ-${bytesText(COMPLIANCE_PDF_MAX_BYTES)} — סרקו ב-150 dpi בגווני אפור, או פצלו אותו`
          : "";
      return {
        key: newId(),
        clientId: newId(),          // ⚠️ פעם אחת לשורה — ראה הכותרת
        file,
        date: "",
        suggested: null,
        parseNote: "",
        performer: "",
        vendor: "",
        note: "",
        status: bad ? "invalid" : "parsing",
        error: bad,
        dup: false,
      };
    });
    setRows((rs) => [...rs, ...add]);
    parseQueue(add.filter((r) => r.status === "parsing"));
  };

  const dateOk = (d) => !!d && d >= MIN_DATE && d <= today;
  const canUpload = (r) => (r.status === "idle" || r.status === "error") && !r.dup && dateOk(r.date);

  const upload = async (key) => {
    const r = rowsRef.current.find((x) => x.key === key);
    if (!r || !canUpload(r)) return;
    patch(key, { status: "uploading", error: "" });
    try {
      const res = await uploadPmHistorical(site.code, {
        clientId: r.clientId,
        performedOn: r.date,
        performerName: r.performer.trim() || null,
        vendor: r.vendor.trim() || null,
        note: r.note.trim() || null,
      }, r.file);
      patch(key, { status: "done", replayed: !!res.replayed, visitId: res.visitId, unknown: false });
      onUploaded?.();
    } catch (err) {
      // תשובה שלא הגיעה ≠ דחייה: ייתכן שהשרת כבר שמר. שדה שננעל = ניסיון חוזר
      // שולח בדיוק את מה שאולי נשמר (ראה הכותרת).
      // ⚠️ ואחרי שהתוצאה לא ידועה — רק דחייה שמוכיחה "לא נשמר" פותחת את השדות
      // (provesNotSaved). 401 של JWT שפג, 42501 של require_manager ו-502 של שער
      // נדחים **לפני** בדיקת ה-replay: הם לא אומרים כלום על הניסיון הקודם. פתיחה
      // עליהם הייתה מחזירה בדיוק את הבאג — תאריך שתוקן, "✓ כבר הועלה קודם",
      // והישן הוא מה שנשמר.
      const unknown = lostResponse(err) || (!!r.unknown && !provesNotSaved(err));
      patch(key, { status: "error", error: err?.message || "ההעלאה נכשלה", dup: err?.code === "PT409", unknown });
    }
  };

  const uploadAll = async () => {
    for (const r of rowsRef.current) {
      if (!aliveRef.current) return;
      if (canUpload(r)) await upload(r.key);
    }
  };

  const remove = (key) => setRows((rs) => rs.filter((r) => r.key !== key));

  // ---------------- שומר הסגירה ----------------
  const uploading = rows.filter((r) => r.status === "uploading").length;
  const waiting = rows.filter((r) => (r.status === "idle" || r.status === "parsing" || (r.status === "error" && !r.dup))).length;
  const reason = uploading
    ? "העלאת דוח תחזוקה היסטורי בתהליך — סגירה עלולה לקטוע אותה."
    : waiting
      ? `נבחרו ${waiting} דוחות תחזוקה היסטוריים שעוד לא הועלו.`
      : null;
  const onDirtyRef = useRef(onDirty);
  useEffect(() => { onDirtyRef.current = onDirty; }, [onDirty]);
  useEffect(() => { onDirtyRef.current?.(reason); }, [reason]);
  useEffect(() => () => onDirtyRef.current?.(null), []);

  const ready = rows.filter(canUpload).length;
  const done = rows.filter((r) => r.status === "done").length;

  return (
    <div className="pm-upload">
      <p className="pm-hint">
        דוחות של ביקורים שנעשו לפני המערכת. כל דוח נרשם כביקור שהוגש בתאריך הביצוע שלו,
        ומשפיע על מועד התחזוקה הבא. PDF בלבד, עד {bytesText(COMPLIANCE_PDF_MAX_BYTES)} לקובץ.
      </p>
      <div className="pm-row">
        <button type="button" className="pm-btn pm-btn--primary" onClick={() => inputRef.current?.click()}>
          בחירת קובצי PDF
        </button>
        {ready > 1 && (
          <button type="button" className="pm-btn" onClick={uploadAll} disabled={uploading > 0}>
            העלאת כל המוכנים ({ready})
          </button>
        )}
        {done > 0 && (
          <button type="button" className="pm-btn pm-btn--ghost" disabled={uploading > 0}
            onClick={() => setRows((rs) => rs.filter((r) => r.status !== "done"))}>
            ניקוי השורות שהועלו
          </button>
        )}
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      </div>

      {rows.length > 0 && (
        <ul className="pm-up-list">
          {rows.map((r) => {
            const busy = r.status === "uploading";
            const locked = busy || r.status === "done" || (r.status === "error" && r.unknown);
            return (
              <li key={r.key} className={`pm-up-row pm-up-row--${r.status}`}>
                <div className="pm-up-file">
                  <span className="pm-up-name" title={r.file.name}>{r.file.name}</span>
                  <span className="pm-up-size">{bytesText(r.file.size)}</span>
                  {!busy && (
                    <button type="button" className="pm-icon-btn" aria-label="הסרת השורה" title="הסרה"
                      onClick={() => remove(r.key)}>×</button>
                  )}
                </div>

                {r.status === "invalid" ? (
                  <div className="pm-banner pm-banner--error" role="alert">{r.error}</div>
                ) : (
                  <>
                    <div className="pm-grid">
                      <label className="pm-field">
                        <span>תאריך הביצוע</span>
                        <input className="pm-input" type="date" min={MIN_DATE} max={today} value={r.date}
                          disabled={locked} onChange={(e) => patch(r.key, { date: e.target.value })} />
                        {r.suggested && r.date === r.suggested && (
                          <small className="pm-suggest">הוצע מתוך המסמך — יש לוודא</small>
                        )}
                        {r.parseNote && !r.date && <small className="pm-hint">{r.parseNote}</small>}
                        {r.date && !dateOk(r.date) && (
                          <small className="pm-field-err">תאריך בין {formatDateIL(MIN_DATE)} להיום</small>
                        )}
                      </label>
                      <label className="pm-field">
                        <span>מבצע <em>(רשות)</em></span>
                        <input className="pm-input" type="text" maxLength={NAME_MAX} value={r.performer}
                          disabled={locked} onChange={(e) => patch(r.key, { performer: e.target.value })} />
                      </label>
                      <label className="pm-field">
                        <span>ספק <em>(רשות)</em></span>
                        <input className="pm-input" type="text" maxLength={NAME_MAX} value={r.vendor}
                          disabled={locked} onChange={(e) => patch(r.key, { vendor: e.target.value })} />
                      </label>
                      <label className="pm-field pm-grid-wide">
                        <span>הערה <em>(רשות)</em></span>
                        <input className="pm-input" type="text" maxLength={VISIT_NOTE_MAX} value={r.note}
                          disabled={locked} onChange={(e) => patch(r.key, { note: e.target.value })} />
                      </label>
                    </div>

                    {r.file.size > COMPLIANCE_PDF_WARN_BYTES && r.status !== "done" && (
                      <p className="pm-hint">קובץ גדול — ההעלאה עשויה לקחת דקה. אל תסגרו את החלון בזמן ההעלאה.</p>
                    )}
                    {r.status === "error" && (
                      r.unknown ? (
                        <div className="pm-banner pm-banner--warn" role="alert">
                          אין אישור שהדוח נשמר ({r.error}) — ייתכן שהוא כבר נשמר. „נסה שוב” שולח בדיוק
                          את אותם הפרטים, ולא ייצור ביקור כפול. לתיקון פרטים אחרי ההעלאה: מחיקת
                          הביקור בהיסטוריה והעלאה מחדש.
                        </div>
                      ) : (
                        <div className="pm-banner pm-banner--error" role="alert">
                          {r.dup ? r.error : `לא הועלה — ${r.error}`}
                        </div>
                      )
                    )}

                    <div className="pm-row pm-up-actions">
                      {STATUS_TEXT[r.status] && (
                        <span className={`pm-status pm-status--${r.status === "done" ? "saved" : "pending"}`} role="status">
                          {busy && <span className="pm-spinner" aria-hidden="true" />}
                          {r.status === "done" && r.replayed ? "✓ כבר הועלה קודם" : STATUS_TEXT[r.status]}
                          {busy ? ` (${bytesText(r.file.size)})` : ""}
                        </span>
                      )}
                      {(r.status === "idle" || (r.status === "error" && !r.dup)) && (
                        <button type="button" className="pm-btn pm-btn--primary" disabled={!canUpload(r)}
                          onClick={() => upload(r.key)}>
                          {r.status === "error" ? "נסה שוב" : "העלאה"}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
