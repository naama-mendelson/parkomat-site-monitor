// components/Compliance/PhotoPicker.jsx — צילום/בחירת תמונות, דחיסה והעלאה מיידית.
//
// ============================================================
// ⚠️ כל תמונה נשמרת ברגע שנבחרה — לא בלחיצה על "שמירה" בסוף
// ============================================================
// טכנאי בחניון תת-קרקעי מצלם שלוש תמונות, הקליטה נופלת, והלשונית נטענת
// מחדש. אם ההעלאה הייתה מחכה לכפתור בסוף, שלוש התמונות היו נעלמות. כאן כל
// תמונה מקבלת מצב משלה — ממתין / שומר / נשמר / נכשל — וכישלון מציג "נסה
// שוב" שמשתמש ב**אותו** client_id. כך ניסיון חוזר אחרי תשובה שאבדה בדרך
// אינו יוצר תמונה כפולה: השרת מזהה את המזהה ומחזיר את השורה הקיימת.
//
// הרכיב אינו יודע לאן התמונה הולכת. פונקציית ההעלאה מגיעה כ-prop (`upload`),
// ולכן אותו רכיב משמש לסגירת ליקוי (RPC ישיר) ולביקור תחזוקה (תור במכשיר).
//
// Props:
//   upload({clientId, compressed}) → Promise   — חובה; זורקת = נכשל
//     ⚠️ תוצאה עם `queued: true` (תיבת היוצאים של התחזוקה המונעת) = התמונה
//     **במכשיר בלבד**, ממתינה לסנכרון — ולא "נשמר". `persisted: false` = אפילו
//     לא במכשיר, בזיכרון הלשונית בלבד. "✓ נשמר" ירוק על תמונה שלא הגיעה לשרת
//     היה סותר את שורת הפריט שלידו, ומרגיע בדיוק כשאסור.
//   onPick?({clientId, compressed})            — מיד אחרי הדחיסה, לפני ההעלאה
//   onRemove?(item) → Promise                  — מחיקת תמונה שמורה/ממתינה (בלעדיו אין ×)
//   onChange?({items, busy, failed, saved, queued}) — כדי שההורה יחסום סגירה בזמן העלאה
//   initial?: [{clientId|client_id, thumb, id?}] — מה שהשרת מכיר. **מתואם**, לא
//     מצורף: תמונה ממתינה שהשרת מכיר הופכת ל"נשמר", תמונה שהגיעה מהשרת ונעלמה
//     ממנו יורדת, ותמונה שנמחקה כאן לעולם לא חוזרת מרשימה ישנה.
//   max = 3, disabled
//   removeFailed — גם × על תמונה שנכשלה קורא ל-onRemove (ההעלאה אולי נשמרה והתשובה
//     אבדה). לשימוש כשהעלאה היא RPC ישיר; בתור במכשיר "נכשל" הוא מקומי בלבד.
//   gone?: Set<clientId> — תמונות שההורה יודע שאינן עוד (למשל "ותר" על תמונה שהשרת
//     דחה). יורדות מהרשימה ולא חוזרות. ⚠️ בלעדיו תמונה שיצאה מהתור נשארה כאן
//     "ממתין לסנכרון" לנצח — ונספרה מול המכסה.
//   rejected?: Map<clientId, string> — תמונה ממתינה שהשרת דחה: מוצגת כנכשלת עם
//     ההסבר, ולא "ממתין לסנכרון" על משהו שלעולם לא יסונכרן לבד.
import { useEffect, useRef, useState } from "react";
import { compressWithThumb, newId, PHOTO_ACCEPT } from "../../utils/complianceFiles";
import "./PhotoPicker.css";

const STATUS_TEXT = {
  pending: "מכין…",
  saving: "שומר…",
  saved: "נשמר",
  queued: "נשמר במכשיר · ממתין לסנכרון",
  failed: "נכשל",
  removing: "מוחק…",
};

// תמונה שלא נקראה בכלל (אין דחיסה) אינה תופסת מקום במכסה — אין מה לנסות שוב.
const countable = (items) => items.filter((i) => !(i.status === "failed" && !i.compressed)).length;

const serverCid = (p) => p.clientId ?? p.client_id ?? null;
const keysOf = (x) => [x.clientId && `c:${x.clientId}`, x.id != null && `i:${x.id}`].filter(Boolean);

// ⚠️ זיהוי לפי client_id **או** id: תמונה שהועלתה כאן מוכרת לפי ה-uuid שלה,
// והשרת עשוי להחזיר אותה רק עם id (snake_case, בלי clientId) — התאמה לפי
// מפתח אחד בלבד הציגה אותה פעמיים, וספרה אותה פעמיים מול המכסה.
function reconcile(cur, initial, removed) {
  const server = (initial || [])
    .map((p) => ({ clientId: serverCid(p), id: p.id ?? null, thumb: p.thumb }))
    .filter((p) => !keysOf(p).some((k) => removed.has(k)));
  const used = new Set();
  let changed = false;
  const out = [];
  for (const item of cur) {
    const ix = server.findIndex((p, n) => !used.has(n) && (
      (p.clientId && p.clientId === item.clientId) || (p.id != null && item.id != null && String(p.id) === String(item.id))));
    if (ix === -1) {
      // הגיעה מהשרת ואינה בו עוד (נמחקה ממכשיר אחר) — יורדת
      if (item.origin === "server" && item.status === "saved") { changed = true; continue; }
      out.push(item);
      continue;
    }
    used.add(ix);
    const p = server[ix];
    const next = {
      ...item,
      id: item.id ?? p.id ?? undefined,
      thumb: item.thumb || p.thumb,
      // ממתינה שהשרת כבר מכיר — הסנכרון הושלם
      status: item.status === "queued" ? "saved" : item.status,
    };
    if (next.id !== item.id || next.thumb !== item.thumb || next.status !== item.status) changed = true;
    out.push(next);
  }
  server.forEach((p, n) => {
    if (used.has(n)) return;
    changed = true;
    out.push({ clientId: p.clientId ?? `id:${p.id}`, id: p.id ?? undefined, thumb: p.thumb, status: "saved", origin: "server" });
  });
  return changed ? out : cur;
}

export default function PhotoPicker({
  upload, onPick, onRemove, onChange, initial, max = 3, disabled = false, removeFailed = false, gone, rejected,
}) {
  const removedRef = useRef(new Set());
  const [items, setItems] = useState(() => reconcile([], initial, new Set()));
  const [notice, setNotice] = useState("");
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const aliveRef = useRef(true);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // רשימת השרת (compliance_thumbs) — מתואמת מול מה שכאן. undefined = עוד לא נטענה.
  // ⚠️ reconcile מחזיר את אותו מערך כשאין שינוי, אחרת הורה שמעביר .map() inline
  // ומעדכן state ב-onChange היה נכנס ללולאה.
  useEffect(() => {
    if (!initial) return;
    setItems((cur) => reconcile(cur, initial, removedRef.current));
  }, [initial]);

  useEffect(() => {
    if (!gone || !gone.size) return;
    for (const cid of gone) removedRef.current.add(`c:${cid}`);
    setItems((cur) => {
      const next = cur.filter((i) => !gone.has(i.clientId));
      return next.length === cur.length ? cur : next;
    });
  }, [gone]);

  useEffect(() => {
    onChangeRef.current?.({
      items,
      busy: items.some((i) => i.status === "pending" || i.status === "saving" || i.status === "removing"),
      failed: items.filter((i) => i.status === "failed").length,
      saved: items.filter((i) => i.status === "saved").length,
      queued: items.filter((i) => i.status === "queued").length,
    });
  }, [items]);

  const patch = (clientId, fields) => {
    if (!aliveRef.current) return;
    setItems((cur) => cur.map((i) => (i.clientId === clientId ? { ...i, ...fields } : i)));
  };

  const send = async (clientId, compressed) => {
    patch(clientId, { status: "saving", error: "" });
    try {
      const result = await upload({ clientId, compressed });
      if (result?.queued) {
        patch(clientId, { status: "queued", result, deviceOnly: result.persisted === false });
      } else {
        patch(clientId, { status: "saved", result, id: result?.id ?? undefined });
      }
    } catch (err) {
      patch(clientId, { status: "failed", error: err?.message || "ההעלאה נכשלה" });
    }
  };

  const handleFiles = async (fileList) => {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const room = max - countable(items);
    if (room <= 0) {
      setNotice(`אפשר עד ${max} תמונות`);
      return;
    }
    setNotice(files.length > room ? `נוספו ${room} מתוך ${files.length} — אפשר עד ${max} תמונות` : "");
    const picked = files.slice(0, room).map((file) => ({ file, clientId: newId() }));
    setItems((cur) => [...cur, ...picked.map(({ clientId }) => ({ clientId, status: "pending" }))]);

    // ⚠️ סדרתי ולא במקביל: כל דחיסה מפענחת צילום מלא (~48MB בזיכרון).
    // שלוש במקביל בטלפון ישן הן בדיוק מה שהורג את הלשונית.
    for (const { file, clientId } of picked) {
      let compressed;
      try {
        compressed = await compressWithThumb(file);
      } catch (err) {
        patch(clientId, { status: "failed", error: err?.message || "התמונה לא נקראה", unreadable: true });
        continue;
      }
      patch(clientId, { compressed, thumb: compressed.thumb });
      try { onPick?.({ clientId, compressed }); } catch { /* ההורה אחראי לשגיאות שלו */ }
      // ההעלאה עצמה אינה ממתינה לבאה בתור — הרשת והדחיסה רצות במקביל.
      send(clientId, compressed);
    }
  };

  const retry = (item) => {
    if (item.compressed) send(item.clientId, item.compressed);
  };

  const remove = async (item) => {
    // ⚠️ removeFailed: "נכשל" אינו אומר "לא נשמר" — כשהתשובה אבדה בדרך (קליטה,
    // זמן קצוב) השורה עשויה להיות בשרת. אז גם מחיקה של תמונה שנכשלה עוברת דרך
    // onRemove, שיודע לברר (replay עם אותו client_id) ולמחוק.
    const maybeStored = removeFailed && item.status === "failed" && !!item.compressed;
    if (item.status === "saved" || item.status === "queued" || maybeStored) {
      if (!onRemove) return;
      const prev = item.status;
      patch(item.clientId, { status: "removing", error: "" });
      try {
        await onRemove(item);
      } catch (err) {
        patch(item.clientId, { status: prev, error: err?.message || "המחיקה נכשלה" });
        return;
      }
      // ⚠️ לעולם לא חוזרת: רשימת שרת ישנה (רענון שהתחיל לפני המחיקה) הייתה
      // מחזירה אותה כ"נשמר" — ומאפשרת "סימון כבוצע" על תמונה שאינה קיימת.
      for (const k of keysOf(item)) removedRef.current.add(k);
    }
    if (aliveRef.current) setItems((cur) => cur.filter((i) => i.clientId !== item.clientId));
  };

  const onInput = (e) => {
    const files = e.target.files;
    handleFiles(files);
    // איפוס — אחרת בחירה חוזרת של אותו קובץ (אחרי מחיקה) אינה מפעילה onChange
    e.target.value = "";
  };

  const full = countable(items) >= max;

  return (
    <div className="pp" dir="rtl">
      <div className="pp-actions">
        <button type="button" className="pp-btn pp-btn--primary" disabled={disabled || full}
          onClick={() => cameraRef.current?.click()}>
          צילום
        </button>
        <button type="button" className="pp-btn" disabled={disabled || full}
          onClick={() => galleryRef.current?.click()}>
          מהגלריה
        </button>
        {/* ⚠️ image/* במצלמה ולא רשימת mime: כמה מצלמות אנדרואיד מסרבות
            להיפתח מ-input עם accept מפורט. הפלט נדחס ל-JPEG בכל מקרה. */}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onInput} />
        <input ref={galleryRef} type="file" accept={PHOTO_ACCEPT} multiple hidden onChange={onInput} />
      </div>

      {notice && <div className="pp-notice">{notice}</div>}

      {items.length > 0 && (
        <ul className="pp-list">
          {items.map((item) => {
            const refused = item.status === "queued" && rejected?.has?.(item.clientId);
            return (
            <li key={item.clientId} className={`pp-item pp-item--${refused ? "failed" : item.status}`}>
              {item.thumb ? (
                <img className="pp-thumb" src={`data:image/jpeg;base64,${item.thumb}`} alt="" />
              ) : (
                <span className="pp-thumb pp-thumb--empty" aria-hidden="true" />
              )}
              <span className="pp-status" role={item.status === "failed" ? "alert" : undefined}>
                {(item.status === "pending" || item.status === "saving" || item.status === "removing") && (
                  <span className="pp-spinner" aria-hidden="true" />
                )}
                {item.status === "saved" && <span aria-hidden="true">✓ </span>}
                {refused ? "השרת דחה את התמונה" : STATUS_TEXT[item.status]}
              </span>
              {refused && <span className="pp-error">{rejected.get(item.clientId) || "ראו את ההודעה בראש הטופס"}</span>}
              {item.status === "queued" && item.deviceOnly && !refused && (
                <span className="pp-warn" role="alert">לא נשמר במכשיר — אל תסגרו את הדף</span>
              )}
              {item.status === "failed" && item.compressed && (
                <button type="button" className="pp-retry" onClick={() => retry(item)} disabled={disabled}>
                  נסה שוב
                </button>
              )}
              {item.error && <span className="pp-error">{item.error}</span>}
              {(item.status === "failed" || ((item.status === "saved" || item.status === "queued") && onRemove)) && (
                <button type="button" className="pp-remove" aria-label="הסרת התמונה" title="הסרה"
                  onClick={() => remove(item)} disabled={disabled}>
                  ×
                </button>
              )}
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
