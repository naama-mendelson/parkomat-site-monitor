// components/Compliance/DefectCloseDialog.jsx — "סימון כבוצע" של ליקוי: תמונה, שם, הערה.
//
// ============================================================
// ⚠️ תמונה — לא חובה. שם המבצע — חובה.
// ============================================================
// בעלת המוצר, 06/10/2026: "אני רוצה שזה יהיה אופציונלי, כלומר יהיה אפשר להמשיך גם בלי
// להעלות תמונה ולציין מי תיקן". כשיש תמונות, הראשונה היא הראיה (D8 במסד). הכפתור
// מחכה רק לשם, ולתמונה שנמצאת באמצע שמירה — סימון באמצע העלאה היה משאיר אותה בחוץ.
//
// ============================================================
// ⚠️ כל תמונה נשמרת ברגע שנבחרה, וחלון שנפתח מחדש מראה אותה
// ============================================================
// PhotoPicker מעלה מיד (staging). כשהחלון נפתח הוא טוען את התמונות שכבר
// שמורות לסגירה הנוכחית (`compliance_thumbs('defect')`) — כך לשונית שנהרגה
// בחניון, או טלפון שני, לא מאבדים את מה שכבר צולם.
//
// ============================================================
// ⚠️ requestId אחד לחלון, ותשובה שאבדה אינה שגיאה
// ============================================================
// "סימון כבוצע" יוצא מחדר מכונות. אם התשובה אבדה והטכנאי לוחץ שוב, אותו
// requestId חוזר כ-replayed — הצלחה. ואם השרת אומר PT409 ("כבר סומן") —
// טוענים מחדש: אם הליקוי אכן סגור, זו הצלחה שהתשובה שלה אבדה, לא כישלון.
import { useEffect, useRef, useState } from "react";
import {
  addDefectPhoto, deleteDefectPhoto, fetchComplianceThumbs, markDefectDone,
} from "../../services/dataSource";
import { newId } from "../../utils/complianceFiles";
import { formatDateIL } from "../../utils/compliance";
import PhotoPicker from "./PhotoPicker";
import { InspectionDialog } from "./InspectionDialog";

const NAME_KEY = "compliance.doneByName";
const MAX_PHOTOS = 3;   // תקרת הסגירה במסד (inspection_defect_photo_add)

// ⚠️ localStorage זורק בגלישה פרטית ובחסימת אחסון — שם שלא נזכר אינו סיבה לחלון שבור.
function loadName() {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}
function saveName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* אין לאן לשמור */ }
}

/**
 * @param {object} p
 * @param {object} p.defect — שורת ליקוי מ-inspection_site (id, body, due_on, urgent…)
 * @param {() => void} p.onDone — אחרי סימון מוצלח (כולל replay)
 * @param {() => void} p.onClose
 * @param {(reason: string|null) => void} [p.onDirtyChange]
 * @param {() => Promise<string|null>} [p.recheck] — טוען מחדש ומחזיר את status העדכני של הליקוי
 */
export default function DefectCloseDialog({ defect, onDone, onClose, onDirtyChange, recheck, onStaged }) {
  const [requestId] = useState(newId);              // ⚠️ פעם אחת לחלון — ראה הכותרת
  const [name, setName] = useState(loadName);
  const [note, setNote] = useState("");
  const [initial, setInitial] = useState(undefined);  // undefined = עוד לא נטען

  // ============================================================
  // ⚠️ מחיקת תמונה כשהשרת אולי יודע משהו שהמסך לא יודע
  // ============================================================
  // • "נכשל" שהתשובה שלו אבדה — השורה בשרת: תופסת אחת משלוש המשבצות, והופכת
  //   לתמונת הראיה של הסגירה (done_photo_id = הראשונה). מבררים ב-replay עם אותו
  //   client_id: אם נשמרה — מקבלים את המזהה ומוחקים; אם השרת דחה — לא נשמרה.
  // • מחיקה שבוצעה והתשובה אבדה — הניסיון הבא מקבל PT404. "כבר נמחקה" היא
  //   הצלחה; בלי זה התמונה נשארה "✓ נשמר" לנצח ואיפשרה "סימון כבוצע" שנדחה.
  const removePhoto = async (item) => {
    let id = item.id ?? null;
    if (id == null && item.compressed) {
      try {
        id = (await addDefectPhoto(defect.id, item.compressed, item.clientId)).id;
      } catch (err) {
        if (err?.network) throw err;          // עדיין לא יודעים — נשארת "נכשל" עם הסיבה
        return;                               // השרת דחה (מכסה, סוג) — מעולם לא נשמרה
      }
    }
    if (id == null) return;
    try {
      await deleteDefectPhoto(id);
    } catch (err) {
      if (err?.code !== "PT404") throw err;
    }
  };
  const [thumbsError, setThumbsError] = useState("");
  const [photos, setPhotos] = useState({ busy: false, failed: 0, saved: 0 });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [thumbsAttempt, setThumbsAttempt] = useState(0);
  const dirtyRef = useRef(onDirtyChange);
  useEffect(() => { dirtyRef.current = onDirtyChange; }, [onDirtyChange]);

  // התמונות שכבר שמורות לסגירה הנוכחית
  useEffect(() => {
    let alive = true;
    setThumbsError("");
    fetchComplianceThumbs("defect", defect.id)
      .then((rows) => { if (alive) setInitial(rows.map((r) => ({ id: r.id, thumb: r.thumb }))); })
      .catch((err) => { if (alive) { setThumbsError(err?.message || "התמונות השמורות לא נטענו"); setInitial([]); } });
    return () => { alive = false; };
  }, [defect.id, thumbsAttempt]);

  // ⚠️ סגירה תאבד רק מה שעוד לא הגיע לשרת: תמונה בדרך, או תמונה שנכשלה
  // ומחכה ל"נסה שוב". תמונה שכבר נשמרה נשארת במסד ותופיע בפתיחה הבאה.
  const dirtyReason = submitting
    ? "הסימון נשלח כרגע — סגירה עכשיו עלולה להשאיר את הליקוי פתוח"
    : photos.busy
      // ⚠️ סגירה אינה עוצרת העלאה שכבר יצאה — היא נשמרת ברקע. ההודעה אומרת את זה,
      // והלשונית מתרעננת כשהיא נוחתת (onStaged), כדי שהשורה תציג את התמונה.
      ? "תמונות עדיין נשמרות — הן ימשיכו להישמר ברקע ויופיעו בפתיחה הבאה. לסגור?"
      : photos.failed > 0
        ? "יש תמונות שלא נשמרו — סגירה עכשיו תאבד אותן"
        : null;

  useEffect(() => { dirtyRef.current?.(done ? null : dirtyReason); }, [dirtyReason, done]);
  useEffect(() => () => dirtyRef.current?.(null), []);

  const requestClose = () => {
    if (!done && dirtyReason && !window.confirm(dirtyReason)) return;
    onClose();
  };

  const trimmed = name.trim();
  const canSubmit = !done && !submitting && !photos.busy && trimmed.length >= 2;

  const succeed = () => {
    saveName(trimmed);
    setDone(true);
    setSubmitting(false);
    onDone?.();
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      await markDefectDone(defect.id, trimmed, note.trim() || null, requestId);   // replay = הצלחה
      succeed();
    } catch (err) {
      if (err?.code === "PT409" && recheck) {
        // "כבר סומן" — אולי בידינו, בתשובה שאבדה. בודקים מה המצב עכשיו.
        try {
          const status = await recheck();
          if (status === "done") { succeed(); return; }
        } catch { /* נופלים להודעה המקורית */ }
      }
      setError(err?.message || "הסימון נכשל");
      setSubmitting(false);
    }
  };

  const missing = [];
  if (!done) {
    if (photos.busy) missing.push("ממתינים לשמירת התמונה");
    if (trimmed.length < 2) missing.push("שם המבצע");
  }

  return (
    <InspectionDialog
      title="סימון ליקוי כבוצע"
      onClose={requestClose}
      footer={done ? (
        <button type="button" className="it-btn it-btn--primary it-btn--wide" onClick={onClose} data-autofocus>סגירה</button>
      ) : (
        <>
          <button type="button" className="it-btn" onClick={requestClose}>ביטול</button>
          <button type="button" className="it-btn it-btn--primary it-btn--wide" onClick={submit} disabled={!canSubmit}>
            {submitting ? "שולח…" : error ? "נסה שוב" : "סימון כבוצע"}
          </button>
        </>
      )}
    >
      <div className="it-form">
        <div className="it-dlg-defect">
          <p className="it-defect-body">{defect.body}</p>
          <p className="it-muted">
            {defect.urgent && <span className="it-tag it-tag--urgent">דחוף</span>}
            {defect.due_on && <span>לתיקון עד {formatDateIL(defect.due_on)}</span>}
          </p>
        </div>

        {done ? (
          <p className="it-success" role="status">✓ הליקוי סומן כבוצע</p>
        ) : (
          <>
            <div className="it-field">
              <span className="it-label">תמונה של הביצוע (לא חובה · עד {MAX_PHOTOS})</span>
              <p className="cmp-hint it-hint">צלמו את המקום אחרי התיקון. כל תמונה נשמרת מיד כשהיא נבחרת.</p>
              {initial === undefined ? (
                <p className="it-muted">טוען תמונות שמורות…</p>
              ) : (
                <PhotoPicker
                  max={MAX_PHOTOS}
                  initial={initial}
                  disabled={submitting}
                  upload={({ clientId, compressed }) =>
                    addDefectPhoto(defect.id, compressed, clientId).then((r) => { onStaged?.(); return r; })}
                  removeFailed
                  onRemove={removePhoto}
                  onChange={({ busy, failed, saved }) => setPhotos({ busy, failed, saved })}
                />
              )}
              {thumbsError && (
                <p className="it-error" role="alert">
                  {thumbsError}{" "}
                  {/* ⚠️ בלי לאפס את initial: איפוס היה מסיר את PhotoPicker ואת
                      התמונות שכבר בדרך. התשובה החדשה מתואמת לתוכו (reconcile). */}
                  <button type="button" className="it-link" onClick={() => setThumbsAttempt((n) => n + 1)}>
                    נסה שוב
                  </button>
                </p>
              )}
            </div>

            <label className="it-field">
              <span className="it-label">שם המבצע</span>
              <input className="it-input" type="text" value={name} maxLength={100} autoComplete="name"
                onChange={(e) => setName(e.target.value)} placeholder="שם מלא" />
            </label>

            <label className="it-field">
              <span className="it-label">הערה (לא חובה)</span>
              <textarea className="it-input it-textarea" rows={2} value={note} maxLength={1000}
                onChange={(e) => setNote(e.target.value)} />
            </label>

            {missing.length > 0 && <p className="it-hint">כדי לסמן: {missing.join(" · ")}</p>}
            {error && <p className="it-error" role="alert">{error}</p>}
          </>
        )}
      </div>
    </InspectionDialog>
  );
}
