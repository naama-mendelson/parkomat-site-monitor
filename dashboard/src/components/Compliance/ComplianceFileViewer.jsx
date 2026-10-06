// components/Compliance/ComplianceFileViewer.jsx — צפייה בתסקיר, בדוח ביקור, בתמונה או בחתימה.
//
// ============================================================
// ⚠️ הכול נפתח **בתוך** החלון, ולא בלשונית חדשה
// ============================================================
// הדשבורד מותקן בטלפונים כ-PWA. שם "לשונית חדשה" היא דפדפן אחר לגמרי, בלי
// כפתור חזרה לאפליקציה — והטכנאי נשאר תקוע מחוץ לה עם קובץ שאולי לא נפתח
// בכלל. לכן תמונה נפתחת בתיבת אור כאן, ו-PDF מצויר כאן עמוד אחר עמוד.
// "פתיחה בחלון" קיים רק במחשב שולחני שאינו מותקן כאפליקציה.
//
// ⚠️ **לעולם לא כתובת data:** — דפדפנים חוסמים ניווט אליה בחלון עליון (כרום
// מציג דף ריק בלי הסבר), ו-PDF של כמה MB כמחרוזת הוא זיכרון כפול. רק blob:.
//
// Props:
//   fetchFile: async () => ({ blobUrl, mime, fileName })
//     ⚠️ הכתובת עוברת לבעלות הרכיב: הוא משחרר אותה (revokeObjectURL) כשהוא נסגר.
//     ⚠️ נקראת **פעם אחת** לכל מופע (ובכל "נסה שוב"). פונקציה חדשה בכל רינדור
//     של ההורה (סגירה inline) אינה מורידה שוב — רינדור של ההורה קורה כל 20
//     שניות (סקר pm_site) ובכל אירוע realtime, והורדה חוזרת של 8MB בכל פעם
//     הייתה שורפת את מכסת התעבורה ומאפסת את הגלילה. להחלפת קובץ — key חדש.
//   title?: כותרת
//   onClose: () => void
import { useCallback, useEffect, useRef, useState } from "react";
import { openPdf, isPdfModuleFailure } from "../../utils/pdfText";
import "./ComplianceFileViewer.css";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const WINDOW_GRACE_MS = 60_000;

const isDesktopBrowser = () => {
  try {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    const desktop = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    return desktop && !standalone;
  } catch {
    return false;
  }
};

// הגנה: אם מישהו בעתיד יחזיר data: מ-fetchFile — ממירים ל-blob: ולא מנווטים אליה.
async function ensureBlobUrl(file) {
  if (!file?.blobUrl?.startsWith("data:")) return file;
  const blob = await (await fetch(file.blobUrl)).blob();
  return { ...file, blobUrl: URL.createObjectURL(blob) };
}

function PdfPage({ doc, pageNo, width, aspect, rootRef }) {
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const holderRef = useRef(null);
  const [state, setState] = useState("idle");   // idle | rendering | done | failed
  const startedRef = useRef(false);
  const detachRef = useRef(null);

  // שכבת הטקסט (סימון והעתקה) מתנתקת עם העמוד — ResizeObserver ומאזינים על window
  useEffect(() => () => { detachRef.current?.(); detachRef.current = null; }, []);

  useEffect(() => {
    const el = holderRef.current;
    if (!el || startedRef.current || !width) return undefined;
    let cancelled = false;
    const render = () => {
      startedRef.current = true;
      setState("rendering");
      doc.renderPage(pageNo, canvasRef.current, width)
        .then(() => {
          if (cancelled) return;
          setState("done");
          // אחרי הציור, לא לפניו: את הטקסט מסמנים על מה שרואים
          doc.renderText(pageNo, textRef.current).then((detach) => {
            if (cancelled) detach();
            else detachRef.current = detach;
          }).catch(() => { /* בלי שכבת טקסט העמוד עדיין מוצג — רק אי אפשר לסמן בו */ });
        })
        .catch(() => { if (!cancelled) setState("failed"); });
    };
    if (typeof IntersectionObserver === "undefined") {
      render();
      return () => { cancelled = true; };
    }
    // עצלות: עמוד מצויר רק כשהוא מתקרב למסך. תסקיר של 12 עמודים בטלפון
    // ישן — ציור של כולם מראש הוא כמה שניות של מסך קפוא.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        render();
      }
    }, { root: rootRef.current, rootMargin: "400px 0px" });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [doc, pageNo, width, rootRef]);

  return (
    <div ref={holderRef} className="cfv-page" style={{ width: `${width}px`, aspectRatio: aspect ? `${1 / aspect}` : undefined }}>
      <canvas ref={canvasRef} className="cfv-canvas" aria-label={`עמוד ${pageNo}`} />
      <div ref={textRef} />
      {state !== "done" && (
        <span className="cfv-page-state">{state === "failed" ? `עמוד ${pageNo} לא צויר` : `עמוד ${pageNo}…`}</span>
      )}
    </div>
  );
}

function PdfPages({ blobUrl, scrollRef }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [aspect, setAspect] = useState(null);    // גובה/רוחב של עמוד 1
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let opened = null;
    (async () => {
      try {
        const blob = await (await fetch(blobUrl)).blob();
        opened = await openPdf(blob);
        if (cancelled) { opened.destroy(); return; }
        const size = await opened.pageSize(1);
        if (cancelled) return;
        setAspect(size.height / size.width);
        setDoc(opened);
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();
    return () => {
      cancelled = true;
      // ⚠️ בלי destroy העובד של pdfjs נשאר חי אחרי סגירת התצוגה — כל פתיחה עוד אחד.
      opened?.destroy();
    };
  }, [blobUrl]);

  // הרוחב נמדד פעם אחת כשהמסמך מוכן; עמודים שכבר צוירו אינם מצוירים שוב בשינוי גודל.
  // ⚠️ עד 1200 ולא 900: "שהמסמך יפתח יותר גדול" (בעלת המוצר) — עמוד ברוחב
  // החלון, כמו בצופה PDF רגיל. בטלפון ממילא רוחב המסך הוא הגבול.
  useEffect(() => {
    if (!doc) return;
    const el = scrollRef.current;
    const w = Math.min(1200, Math.max(240, (el?.clientWidth || 600) - 24));
    setWidth(Math.floor(w));
  }, [doc, scrollRef]);

  if (error) {
    return isPdfModuleFailure(error) ? (
      <div className="cfv-msg" role="alert">
        גרסה חדשה של הדשבורד זמינה — רעננו את הדף כדי לצפות במסמך.
        <button type="button" className="cfv-btn" onClick={() => window.location.reload()}>רענון</button>
      </div>
    ) : (
      <div className="cfv-msg" role="alert">לא ניתן להציג את המסמך כאן — אפשר להוריד אותו.</div>
    );
  }
  if (!doc || !width) return <div className="cfv-msg">טוען את המסמך…</div>;

  return (
    <div className="cfv-pages">
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage key={i + 1} doc={doc} pageNo={i + 1} width={width} aspect={aspect} rootRef={scrollRef} />
      ))}
    </div>
  );
}

export default function ComplianceFileViewer({ fetchFile, title, onClose }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(false);
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const promiseRef = useRef(null);
  const downOnOverlayRef = useRef(false);
  const urlsRef = useRef(new Set());           // כל כתובת blob שנוצרה — כולן משתחררות בסגירה
  const unmountedRef = useRef(false);
  const windowOpenedRef = useRef(false);
  const fetchRef = useRef(fetchFile);
  const scrollRef = useRef(null);
  const closeRef = useRef(null);
  const boxRef = useRef(null);
  const [desktop] = useState(isDesktopBrowser);

  useEffect(() => { fetchRef.current = fetchFile; }, [fetchFile]);

  // שחרור כתובת. ⚠️ אם נפתח חלון — דחייה של דקה: החלון אולי עדיין טוען את
  // הקובץ, ושחרור מיידי היה מציג בו דף שגיאה.
  const release = useCallback((url) => {
    if (!url) return;
    urlsRef.current.delete(url);
    if (windowOpenedRef.current) setTimeout(() => URL.revokeObjectURL(url), WINDOW_GRACE_MS);
    else URL.revokeObjectURL(url);
  }, []);

  // ⚠️ תלוי ב-attempt בלבד, לא ב-fetchFile — ראה הכותרת.
  useEffect(() => {
    let cancelled = false;
    setError("");
    setFile(null);
    const p = Promise.resolve().then(() => fetchRef.current()).then(ensureBlobUrl);
    promiseRef.current = p;
    p.then((f) => {
      if (f?.blobUrl) urlsRef.current.add(f.blobUrl);
      // נסגר לפני שהקובץ הגיע — משתחרר מיד (או אחרי דקה אם חלון מחכה לו)
      if (unmountedRef.current) { release(f?.blobUrl); return; }
      // הבאה שהוחלפה (StrictMode / נסה שוב) — אף חלון לא מחכה לה
      if (cancelled) {
        if (promiseRef.current !== p && f?.blobUrl) { urlsRef.current.delete(f.blobUrl); URL.revokeObjectURL(f.blobUrl); }
        return;
      }
      setFile(f);
    }).catch((err) => {
      if (!cancelled) setError(err?.message || "הקובץ לא נטען");
    });
    return () => { cancelled = true; };
  }, [attempt, release]);

  // סגירה: כל הכתובות שנוצרו משתחררות, והמיקוד חוזר למי שפתח את התצוגה.
  useEffect(() => {
    unmountedRef.current = false;
    const opener = document.activeElement;
    closeRef.current?.focus();
    const urls = urlsRef.current;
    return () => {
      unmountedRef.current = true;
      for (const url of [...urls]) release(url);
      if (opener && typeof opener.focus === "function" && document.contains(opener)) {
        try { opener.focus(); } catch { /* */ }
      }
    };
  }, [release]);

  // Escape סוגר את התצוגה בלבד — ⚠️ בשלב ה-capture ועם עצירה, אחרת גם
  // חלון האתר שמתחת (InsightsModal מאזין ל-Escape על window) היה נסגר.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (zoom) setZoom(false);
      else onClose?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, zoom]);

  // ⚠️ window.open חייב לקרות **סינכרונית** בתוך הלחיצה — אחרי await חוסם
  // החלונות הקופצים כבר לא רואה פעולת משתמש וחוסם. לכן פותחים חלון ריק
  // מיד, ומכוונים אותו לקובץ כשהוא מגיע; אם ההבאה נכשלה — סוגרים אותו.
  const openInWindow = useCallback(() => {
    const w = window.open("", "_blank");
    if (!w) {
      setNotice("הדפדפן חסם את החלון החדש");
      return;
    }
    windowOpenedRef.current = true;
    try {
      w.opener = null;
      w.document.title = title || "טוען…";
      w.document.body.textContent = "טוען את הקובץ…";
    } catch { /* חלון שאינו נגיש — לא קריטי */ }
    // ⚠️ השחרור של הכתובת (release) נדחה בדקה מרגע ש-windowOpenedRef דלוק —
    // גם אם התצוגה נסגרת לפני שהקובץ הגיע, החלון מספיק לנווט אליו.
    (promiseRef.current || Promise.reject(new Error("no file")))
      .then((f) => { w.location.href = f.blobUrl; })
      .catch(() => { try { w.close(); } catch { /* כבר נסגר */ } });
  }, [title]);

  // מלכודת מיקוד: Tab מסתובב בתוך התצוגה ולא בורח לחלון האתר שמאחוריה.
  const trapTab = (e) => {
    if (e.key !== "Tab" || !boxRef.current) return;
    const list = [...boxRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !boxRef.current.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !boxRef.current.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  };

  const mime = file?.mime || "";
  const isImage = mime.startsWith("image/");
  const isPdf = mime === "application/pdf";

  // ⚠️ לחיצה על הרקע סוגרת רק אם גם **התחילה** ברקע. מסמנים טקסט במסמך
  // ומשחררים את העכבר מחוץ לעמוד — הדפדפן יורה click על הרקע, והחלון היה
  // נסגר באמצע העתקה. (אותה הגנה כמו ב-InspectionDialog.)
  return (
    <div className="cfv-overlay" role="dialog" aria-modal="true" aria-label={title || "צפייה בקובץ"}
      onPointerDown={(e) => { downOnOverlayRef.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget && downOnOverlayRef.current) onClose?.();
        downOnOverlayRef.current = false;
      }}
      onKeyDown={trapTab}>
      <div className={`cfv-box${isPdf ? " cfv-box--pdf" : ""}`} dir="rtl" ref={boxRef}>
        <div className="cfv-head">
          <span className="cfv-title">{title || file?.fileName || "קובץ"}</span>
          <span className="cfv-tools">
            {file && (
              <a className="cfv-btn" href={file.blobUrl} download={file.fileName || "file"}>הורדה</a>
            )}
            {desktop && !error && (
              <button type="button" className="cfv-btn" onClick={openInWindow}>פתיחה בחלון</button>
            )}
            <button ref={closeRef} type="button" className="cfv-btn cfv-close" onClick={() => onClose?.()} aria-label="סגירה">
              ×
            </button>
          </span>
        </div>
        {notice && <div className="cfv-notice">{notice}</div>}

        <div ref={scrollRef} className={`cfv-body${zoom ? " cfv-body--zoom" : ""}`}>
          {error ? (
            <div className="cfv-msg" role="alert">
              {error}
              <button type="button" className="cfv-btn" onClick={() => setAttempt((n) => n + 1)}>נסה שוב</button>
            </div>
          ) : !file ? (
            <div className="cfv-msg">טוען…</div>
          ) : isImage ? (
            <button type="button" className="cfv-imgbtn" onClick={() => setZoom((z) => !z)}
              aria-pressed={zoom} aria-label={zoom ? "הקטנת התמונה" : "הגדלת התמונה"} title={zoom ? "הקטנה" : "הגדלה"}>
              <img
                className={`cfv-img${zoom ? " cfv-img--zoom" : ""}`}
                src={file.blobUrl}
                alt={file.fileName || ""}
              />
            </button>
          ) : isPdf ? (
            <PdfPages blobUrl={file.blobUrl} scrollRef={scrollRef} />
          ) : (
            <div className="cfv-msg">אין תצוגה לקובץ מסוג זה — אפשר להוריד אותו.</div>
          )}
        </div>
      </div>
    </div>
  );
}
