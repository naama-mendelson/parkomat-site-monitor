// components/Compliance/InspectionUpload.jsx — העלאת תסקיר (מנהל): בחירה → קריאה → אישור → שמירה.
//
// ============================================================
// ⚠️ מהמסמך נקראים **תאריכים בלבד** (בעלת המוצר, 05/10/2026)
// ============================================================
// "אני לא סומכת על כך, כיון שיתכנו ניסוחים רבים — אני רוצה שתחלץ רק
// תאריכים". קריאה לפי תוויות ("בתוקף עד", "מה התיקונים", "מאשר כי ביום")
// עובדת רק על ניסוח שמישהו כבר ראה, ובודק חדש עם טופס אחר היה נקרא חלקית.
// לכן הטופס אינו מפרש את הטקסט כלל:
//   • מוצג **תאריך אחד** לאישור — הבדיקה הבאה ("שיהיה רק תאריך שצריך לאשר
//     וזהו"). ההצעה (suggestInspectionDates): זוג שבו המאוחר הוא בדיוק מספר
//     חודשים שלם אחרי המוקדם — הבאה, ותאריך הבדיקה.
//   • תאריך הבדיקה נדרש (ממנו נספרים ימי התיקון, ולפיו הסדר בין התסקירים)
//     אבל **אינו מוצג** — אלא כשאין הצעה, או כשהוא אינו מסתדר (עתידי, אחרי
//     הבאה, לפני התקופתי). אז השדה מופיע ונשאר (showInsp).
//   • יש ליקויים או אין — בחירה של אדם, בלי ברירת מחדל. את הליקויים מקלידים
//     מהמסמך שליד, שורה לכל ליקוי (כל שורה נסגרת בנפרד, ורק עם תמונה).
//   • אישור אחד: התאריך נבדק מול המסמך. עריכת תאריך מבטלת אותו.
// המפענח המלא (parseInspectionReport) משמש רק לזיהוי קובץ עם כמה תסקירים —
// פיצול עמודים, לא קריאת תוכן.
//
// ============================================================
// ⚠️ המסמך תמיד גלוי ליד הטופס
// ============================================================
// הקובץ נקרא כאן, בדפדפן (pdfjs), ולא נשלח לשום מקום לפני האישור. האישור
// הוא מול התצוגה המקדימה — בלעדיה אין עם מה להשוות.
//
// ============================================================
// ⚠️ תאריך תוקף — לעולם לא ברירת מחדל (D5)
// ============================================================
// תסקיר של חצי שנה שנשמר "לשנה כברירת מחדל" היה
// מסמן אתר ירוק חצי שנה אחרי שפג. אין תאריך במסמך — השדה ריק, השמירה חסומה,
// ו"+12 חודשים" הוא כפתור שהמנהל לוחץ בעצמו. המקור נגזר בשרת (D25): התאריך
// שהוצע מהמסמך נשלח ב-`parse.parsed`, ותאריך אחר שהוזן נרשם 'manual'.
//
// ============================================================
// ⚠️ client_id אחד לטופס, וניסיון חוזר שולח אותו שוב
// ============================================================
// PDF של כמה MB מחדר מכונות. תשובה שאבדה + "נסה שוב" עם מזהה חדש = שני
// תסקירים. עם אותו מזהה השרת מחזיר replayed — וזו הצלחה.
import { useEffect, useMemo, useRef, useState } from "react";
import { uploadInspection } from "../../services/dataSource";
import { extractPages, isPdfModuleFailure, openPdf } from "../../utils/pdfText";
import { dropCleaned, pasteCleaned } from "../../utils/pdfItems";
import { extractDates, parseInspectionReport, suggestInspectionDates } from "../../../../shared/parse-inspection.mjs";
import { newId } from "../../utils/complianceFiles";
import {
  COMPLIANCE_PDF_MAX_BYTES, COMPLIANCE_PDF_WARN_BYTES, addDaysISO, formatDateIL, todayIL,
} from "../../utils/compliance";
import ComplianceFileViewer from "./ComplianceFileViewer";
import { InspectionDialog } from "./InspectionDialog";
import { byDateDesc, daysBetween, fmtMB, hasDraggedFiles, machineTitle, openInCycleUpTo } from "./InspectionUtils";
import "./InspectionTab.css";

const NEW = "__new__";
// dates-1 — תאריכים בלבד (extractDates + suggestInspectionDates), בלי תוויות
const PARSER_VERSION = "dates-1";
const DATE_FIELDS = new Set(["inspected_on", "valid_until"]);
// הקובץ הראשון שנגרר — PDF או לא (pickFile מסרב בהודעה ברורה).
const droppedFile = (e) => e.dataTransfer?.files?.[0] ?? null;
const isPdf = (f) => !!f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""));
const narrowScreen = () => {
  try { return window.matchMedia("(max-width: 899px)").matches; } catch { return false; }
};

// קובץ עם כמה תסקירים (שני מתקנים באותו PDF): המפענח מחזיר `reports`. כל בלוק
// עולה בנפרד, לאותו קובץ — ומכל בלוק נקראים רק התאריכים של העמודים שלו.
const blocksOf = (r) => (Array.isArray(r?.reports) && r.reports.length > 1 ? r.reports : null);

/** התאריכים שבעמודים (כולם, או של בלוק אחד) וההצעה מהם. */
function datesInfo(pages, blockPages = null) {
  const d = extractDates(pages || [], blockPages ? { pages: blockPages } : {});
  return {
    noText: d.noText,
    dates: d.dates.map((x) => x.iso),
    suggest: suggestInspectionDates(d.dates),
    page: blockPages?.[0] ?? 1,
  };
}

function makeForm(info, { machines, periodics, preset }) {
  const keys = machines.map((m) => m.key);
  const activeKeys = machines.filter((m) => !m.retired_at).map((m) => m.key);
  // ⚠️ המתקן אינו נקרא מהמסמך. מתקן פעיל יחיד — הוא; אתר בלי מתקנים — "1";
  // כמה מתקנים — אדם בוחר (ריק עד שבחר).
  let machineSel = NEW;
  let newKey = "";
  if (preset?.machineKey && keys.includes(preset.machineKey)) machineSel = preset.machineKey;
  else if (activeKeys.length === 1) machineSel = activeKeys[0];
  else if (machines.length === 0) newKey = "1";
  else machineSel = "";
  const kind = preset?.kind === "followup" && periodics.length ? "followup" : "periodic";
  return {
    kind,
    machineSel,
    newKey,
    machineLabel: "",
    parentId: preset?.followupOf != null ? String(preset.followupOf) : "",
    inspected_on: info?.suggest?.inspected ?? "",
    valid_until: info?.suggest?.next ?? "",
    confirmDates: false,                         // ⚠️ לעולם לא מסומן מראש — אדם מאשר את התאריכים
    defectsChoice: "",                           // ⚠️ "" | "none" | "some" — לעולם לא נבחר מראש
    // ⚠️ בלי ברירת מחדל — "אם יש ליקויים צריך לכתוב תוך כמה זמן הם צריכים להיות
    // מתוקנים" (בעלת המוצר). 45 היה מוקלד מראש, ולכן איש לא היה בודק אותו מול המסמך.
    deadlineDays: "",
    defects: [],
    closeOpen: false,
  };
}

// שורת ליקוי = טקסט בלבד. דחוף / תאריך יעד לליקוי בודד — אחרי השמירה, ב"עריכה" של הליקוי.
const emptyDefect = () => ({ key: newId(), body: "" });

// ============================================================
// תצוגה מקדימה של הקובץ המקומי
// ============================================================
function PdfPreview({ file, page: wantPage, onOpenFull }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(wantPage || 1);
  const [open, setOpen] = useState(() => !narrowScreen());
  const [renderFailed, setRenderFailed] = useState(false);
  const [rendered, setRendered] = useState(0);
  const holderRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);                  // שכבת הטקסט — סימון והעתקה של ליקויים מהמסמך
  const detachRef = useRef(null);
  const chainRef = useRef(Promise.resolve());

  useEffect(() => { setPage(wantPage || 1); }, [wantPage]);

  useEffect(() => {
    let cancelled = false;
    let opened = null;
    setDoc(null);
    setError(null);
    openPdf(file)
      .then((d) => { if (cancelled) { d.destroy(); return; } opened = d; setDoc(d); })
      .catch((err) => { if (!cancelled) setError(err); });
    // ⚠️ בלי destroy העובד של pdfjs נשאר חי — כל פתיחת טופס עוד אחד
    return () => { cancelled = true; opened?.destroy(); };
  }, [file]);

  useEffect(() => {
    if (!doc || !open) return undefined;
    const canvas = canvasRef.current;
    const holder = holderRef.current;
    if (!canvas || !holder) return undefined;
    const p = Math.min(Math.max(1, page), doc.numPages);
    // עד 1100 ולא 760 — התצוגה קיבלה את העמודה הרחבה בטופס (ראו .iu-layout)
    const width = Math.max(200, Math.min(holder.clientWidth || 360, 1100));
    let cancelled = false;
    setRenderFailed(false);
    // ⚠️ ציורים בתור: pdfjs זורק על שני render() מקבילים על אותו קנבס
    // (מעבר מהיר בין עמודים). שכבת הטקסט באותו תור — מכל אחד לשני העמודים.
    chainRef.current = chainRef.current
      .catch(() => {})
      .then(() => {
        if (cancelled) return null;
        // הטקסט של העמוד הקודם יורד לפני הציור — אחרת סימון בזמן הציור
        // היה מעתיק מילים מעמוד אחר
        textRef.current?.replaceChildren();
        return doc.renderPage(p, canvas, width);
      })
      .then(() => {
        if (cancelled) return null;
        setRendered(p);
        return doc.renderText(p, textRef.current)
          .then((detach) => { if (cancelled) detach(); else detachRef.current = detach; })
          .catch(() => { /* העמוד מצויר; רק אי אפשר לסמן בו */ });
      })
      .catch(() => { if (!cancelled) setRenderFailed(true); });
    return () => {
      cancelled = true;
      detachRef.current?.();
      detachRef.current = null;
    };
  }, [doc, page, open]);

  const n = doc?.numPages ?? 0;
  return (
    <div className={`iu-preview${open ? "" : " iu-preview--closed"}`}>
      <div className="iu-preview-head">
        <button type="button" className="iu-preview-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          תצוגת המסמך{n ? ` · עמוד ${page} מתוך ${n}` : ""} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </button>
        <button type="button" className="it-btn it-btn--small" onClick={onOpenFull}>פתיחת המסמך</button>
      </div>
      {open && (
        <div className="iu-preview-body" ref={holderRef}>
          {error ? (
            <p className="it-muted" role="alert">
              {isPdfModuleFailure(error)
                ? "רכיב התצוגה לא נטען — רעננו את הדף. אפשר להמשיך במילוי הטופס."
                : "אי אפשר להציג את המסמך כאן — אפשר לפתוח אותו בכפתור למעלה."}
            </p>
          ) : (
            <>
              {!doc && <p className="it-muted">טוען תצוגה…</p>}
              <div className="iu-page" hidden={!doc}>
                <canvas ref={canvasRef} className="iu-canvas" data-page={rendered || undefined}
                  aria-label={`עמוד ${page} של המסמך`} />
                <div ref={textRef} />
              </div>
              {renderFailed && <p className="it-muted">העמוד לא צויר.</p>}
              {n > 1 && (
                <div className="iu-pager">
                  <button type="button" className="it-btn it-btn--small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>עמוד קודם</button>
                  <span className="it-muted">{page} / {n}</span>
                  <button type="button" className="it-btn it-btn--small" disabled={page >= n} onClick={() => setPage((p) => p + 1)}>עמוד הבא</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * @param {object} p
 * @param {{id:number, code:string, site_name?:string}} p.site
 * @param {ReturnType<import('./InspectionUtils').deriveInspection>} p.derived
 * @param {{kind?:'followup'|'periodic', machineKey?:string, followupOf?:number}|null} [p.preset]
 * @param {(res: object, info: {done: boolean}) => void} p.onSaved — done=false: נשארו בלוקים בקובץ
 * @param {() => void} p.onClose
 * @param {(reason: string|null) => void} [p.onDirtyChange]
 * @param {File|null} [p.initialFile] — קובץ שנגרר ללשונית: נקרא מיד, בלי שלב הבחירה
 */
export default function InspectionUpload({ site, derived, preset = null, onSaved, onClose, onDirtyChange, initialFile = null }) {
  const { machines, reports } = derived;
  const periodics = useMemo(() => reports.filter((r) => r.kind === "periodic").sort(byDateDesc), [reports]);
  const machineByKey = useMemo(() => new Map(machines.map((m) => [m.key, m])), [machines]);
  const today = todayIL();

  const [phase, setPhase] = useState("pick");     // pick | parsing | blocks | form | saving
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState("");
  const [info, setInfo] = useState(null);         // התאריכים של הבלוק הנוכחי (datesInfo)
  const [extract, setExtract] = useState(null);   // 'ok' | 'failed:<name>'
  const [moduleError, setModuleError] = useState(false);
  const [manualReason, setManualReason] = useState("");
  const [blocks, setBlocks] = useState(null);
  const [blockIdx, setBlockIdx] = useState(null);
  const [savedBlocks, setSavedBlocks] = useState(() => new Set());
  const [fileId, setFileId] = useState(null);     // אחרי הבלוק הראשון — הקובץ כבר במסד
  const [form, setForm] = useState(null);
  const [saveError, setSaveError] = useState("");
  const [viewer, setViewer] = useState(false);
  // שדה תאריך הבדיקה — מוסתר כשיש הצעה; מופיע (ונשאר) כשאין, או כשהוא אינו מסתדר
  const [showInsp, setShowInsp] = useState(false);
  const pagesRef = useRef(null);
  const [locked, setLocked] = useState(false);   // אחרי כשל לא ודאי — הניסיון החוזר זהה לראשון
  const clientIdRef = useRef(null);
  const aliveRef = useRef(true);
  const inputRef = useRef(null);
  const dirtyRef = useRef(onDirtyChange);
  useEffect(() => { dirtyRef.current = onDirtyChange; }, [onDirtyChange]);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const ctx = { machines, periodics, preset };

  const startForm = (inf, idx = null) => {
    clientIdRef.current = newId();               // ⚠️ אחד לטופס — ניסיון חוזר שולח אותו שוב
    setLocked(false);                            // טופס חדש = בקשה חדשה; הנעילה שייכת לקודמת
    setInfo(inf);
    setBlockIdx(idx);
    setForm(makeForm(inf, ctx));
    setShowInsp(!inf?.suggest?.inspected);
    setSaveError("");
    setPhase("form");
  };

  const pickFile = async (f) => {
    setFileError("");
    if (!f) return;
    if (!isPdf(f)) { setFileError("יש לבחור קובץ PDF"); return; }
    if (f.size === 0) { setFileError("הקובץ ריק"); return; }
    if (f.size > COMPLIANCE_PDF_MAX_BYTES) {
      // ⚠️ סירוב **לפני** העלאה: אחרת המנהל מחכה דקה ומקבל את אותה תשובה מהשרת
      setFileError(`הקובץ גדול מדי (${fmtMB(f.size)} MB, המקסימום ${fmtMB(COMPLIANCE_PDF_MAX_BYTES)} MB) — סרקו ב-150 dpi בגווני אפור, או פצלו את הקובץ`);
      return;
    }
    // ⚠️ הכותרת ולא רק הסיומת: "‎.pdf" שאינו PDF היה נשלח להזנה ידנית — והשרת היה
    // דוחה את אותם בתים (magic) רק אחרי שהכול הוקלד
    try {
      const head = await f.slice(0, 5).text();
      if (head !== "%PDF-") { setFileError("הקובץ אינו PDF תקין"); return; }
    } catch { /* קריאה נכשלה — pdfjs ינסה ויכריע */ }
    setFile(f);
    setPhase("parsing");
    setModuleError(false);
    setManualReason("");
    setBlocks(null);
    setSavedBlocks(new Set());
    setFileId(null);
    let pages = null;
    let ex = "ok";
    let manual = "";
    let modErr = false;
    try {
      pages = await extractPages(f);
    } catch (err) {
      ex = `failed:${err?.name || "Error"}`;
      // ⚠️ שתי משפחות כשל: מודול שלא נטען = בעיה של **הדף** (רענון); קובץ
      // שלא נקרא = בעיה של **המסמך** (הזנה ידנית). שתיהן משאירות הזנה ידנית.
      if (isPdfModuleFailure(err)) modErr = true;
      else manual = "לא הצלחנו לקרוא את הקובץ — הזינו את התאריכים מהמסמך";
    }
    let bl = null;
    let inf = null;
    if (pages) {
      inf = datesInfo(pages);
      if (inf.noText) manual = "בקובץ אין טקסט (כנראה סריקה) — הזינו את התאריכים מהמסמך";
      else {
        // רק פיצול עמודים לכמה תסקירים — לא קריאת תוכן
        try { bl = blocksOf(parseInspectionReport(pages)); } catch { bl = null; }
      }
    }
    if (!aliveRef.current) return;
    pagesRef.current = pages;
    setExtract(ex);
    setModuleError(modErr);
    setManualReason(manual);
    if (bl) {
      setBlocks(bl.map((b) => ({ pages: b.pages, info: datesInfo(pages, b.pages) })));
      setPhase("blocks");
    } else {
      startForm(inf);
    }
  };

  // ⚠️ פעם אחת, גם ב-StrictMode (שמריץ אפקטים פעמיים בפיתוח): ref ולא state,
  // כי הוא שורד את ההרכבה הכפולה. קריאה כפולה הייתה מפענחת את הקובץ פעמיים.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!initialFile || startedRef.current) return;
    startedRef.current = true;
    pickFile(initialFile);
  }, [initialFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const [dragOver, setDragOver] = useState(false);
  const onPickDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    pickFile(droppedFile(e));
  };

  const chooseBlock = (i) => startForm(blocks[i].info, i);

  // ============================================================
  // נגזרות של הטופס
  // ============================================================
  const f = form;
  const parent = f && f.kind === "followup"
    ? periodics.find((p) => String(p.id) === String(f.parentId)) ?? null
    : null;
  const machineKey = !f ? "" : f.kind === "followup" ? (parent?.machine_key ?? "") : (f.machineSel === NEW ? f.newKey.trim() : f.machineSel);
  const openCount = f && f.kind === "followup" && parent
    ? openInCycleUpTo(reports, parent.id, f.inspected_on || today).length
    : 0;
  const clean = !!f && f.defectsChoice === "none";
  const withDefects = !!f && f.defectsChoice === "some";

  const problems = [];
  // בעיה שנוגעת לתאריך הבדיקה — השדה המוסתר מופיע, אחרת אין איפה לתקן
  let inspIssue = false;
  const inspProblem = (msg) => { problems.push(msg); inspIssue = true; };
  if (f) {
    if (!f.inspected_on) inspProblem("תאריך הבדיקה");
    else if (f.inspected_on > today) inspProblem("תאריך הבדיקה בעתיד");
    else if (f.inspected_on < "2000-01-01") inspProblem("תאריך בדיקה לא תקין");
    if (f.kind === "periodic" && !f.valid_until) problems.push("הבדיקה הבאה");
    if (f.valid_until && f.inspected_on) {
      const n = daysBetween(f.inspected_on, f.valid_until);
      if (n <= 0 || n > 800) inspProblem("הבדיקה הבאה חייבת להיות אחרי תאריך הבדיקה ועד כשנתיים ממנו");
    }
    if (f.kind === "periodic" && !machineKey) problems.push("מתקן");
    if (f.kind === "followup" && !parent) problems.push("תסקיר תקופתי לשיוך הבדיקה החוזרת");
    if (f.kind === "followup" && parent && f.inspected_on && f.inspected_on < parent.inspected_on) {
      inspProblem("בדיקה חוזרת אינה יכולה להיות לפני התסקיר התקופתי");
    }
    if (!f.defectsChoice) problems.push("יש ליקויים או אין");
    if (withDefects) {
      if (f.defects.length === 0) problems.push("לפחות ליקוי אחד");
      // ⚠️ Number.isInteger ולא השוואה: "" נכפה ל-0 (כל ליקוי "באיחור" ביום ההעלאה),
      // ו-45.5 עובר כאן ונדחה בשרת בהודעה כללית שאינה אומרת איזה שדה
      if (!(Number.isInteger(f.deadlineDays) && f.deadlineDays >= 0 && f.deadlineDays <= 365)) {
        problems.push("תוך כמה ימים לתקן (0–365)");
      }
      f.defects.forEach((d, i) => { if (d.body.trim().length < 2) problems.push(`ליקוי ${i + 1} ריק — מלאו או הסירו`); });
      if (f.defects.length > 100) problems.push("יותר מ-100 ליקויים");
    }
    if (!f.confirmDates) problems.push("אישור התאריך מול המסמך");
  }
  useEffect(() => { if (inspIssue) setShowInsp(true); }, [inspIssue]);

  // ============================================================
  // הגנת סגירה
  // ============================================================
  const total = blocks?.length ?? 0;
  const dirty = phase === "saving"
    ? "התסקיר נשמר כרגע — סגירה עכשיו עלולה להשאיר אותו לא שמור"
    : phase === "form"
      ? "טופס התסקיר לא נשמר — סגירה תמחק את מה שהוזן"
      : phase === "blocks" && savedBlocks.size > 0
        ? `נשמרו ${savedBlocks.size} מתוך ${total} התסקירים שבקובץ — השאר לא יישמרו`
        : null;
  useEffect(() => { dirtyRef.current?.(dirty); }, [dirty]);
  useEffect(() => () => dirtyRef.current?.(null), []);

  const requestClose = () => {
    if (dirty && !window.confirm(dirty)) return;
    onClose();
  };

  // ⚠️ שינוי תאריך מבטל את אישור התאריכים: האישור הוא על הערכים שהוצגו
  // בתווית שלו, ואישור שנשאר מסומן אחרי עריכה היה מאשר תאריך שאיש לא בדק.
  const set = (k, v) => setForm((cur) => ({ ...cur, [k]: v, ...(DATE_FIELDS.has(k) ? { confirmDates: false } : {}) }));
  const setDefect = (key, patch) => setForm((cur) => ({ ...cur, defects: cur.defects.map((d) => (d.key === key ? { ...d, ...patch } : d)) }));
  // שורה חדשה מקבלת את הסמן מיד — מקלידים ליקוי, Enter, ממשיכים לבא
  const focusKey = useRef(null);
  useEffect(() => {
    if (!focusKey.current) return;
    const el = document.getElementById(`iu-def-${focusKey.current}`);
    if (el) { el.focus(); focusKey.current = null; }
  });
  // ⚠️ השורה נוצרת **מחוץ** ל-updater: ב-StrictMode הוא רץ פעמיים, והסמן היה מחפש
  // מפתח של שורה שנזרקה.
  const addDefect = () => {
    // שורה ריקה בסוף כבר מחכה — אליה, ולא עוד אחת
    const last = f?.defects[f.defects.length - 1];
    if (last && !last.body.trim()) { document.getElementById(`iu-def-${last.key}`)?.focus(); return; }
    const d = emptyDefect();
    focusKey.current = d.key;
    setForm((cur) => ({ ...cur, defects: [...cur.defects, d] }));
  };
  const removeDefect = (key) => setForm((cur) => ({ ...cur, defects: cur.defects.filter((d) => d.key !== key) }));
  // "יש ליקויים" פותח שורה ריקה ראשונה. ⚠️ מעבר ל"אין" אינו מוחק את מה שהוקלד —
  // רק מסתיר; מה שנשלח נקבע לפי הבחירה (save), כך שטעות בבחירה אינה מאבדת עבודה.
  const chooseDefects = (v) => {
    const first = v === "some" && f && f.defects.length === 0 ? emptyDefect() : null;
    if (first) focusKey.current = first.key;
    setForm((cur) => ({
      ...cur,
      defectsChoice: v,
      closeOpen: v === "none" && cur.closeOpen,
      defects: first && cur.defects.length === 0 ? [first] : cur.defects,
    }));
  };
  // התאריך שהליקויים צריכים להיות מתוקנים עד אליו — מוצג ליד מספר הימים
  const dueDate = f?.inspected_on && Number.isInteger(f.deadlineDays) && f.deadlineDays >= 0
    ? addDaysISO(f.inspected_on, f.deadlineDays) : "";

  const setKind = (kind) => setForm((cur) => {
    if (kind === cur.kind) return cur;
    let parentId = cur.parentId;
    if (kind === "followup" && !parentId) {
      // ברירת מחדל: התקופתי האחרון של המתקן שנבחר, שנבדק לפני הבדיקה הזו
      const key = cur.machineSel === NEW ? cur.newKey.trim() : cur.machineSel;
      const mine = periodics.filter((p) => p.machine_key === key);
      // ⚠️ לא מנחשים בין מתקנים. כשלמתקן שנבחר אין תקופתי והאתר מחזיק יותר ממתקן
      // אחד — אין ברירת מחדל, והמנהל בוחר. ניחוש שגוי עם "לסגור את הליקויים" היה
      // סוגר ליקויים של המתקן **השני**.
      const oneMachine = new Set(periodics.map((p) => p.machine_key)).size <= 1;
      const pool = mine.length ? mine : oneMachine ? periodics : [];
      const before = cur.inspected_on ? pool.find((p) => p.inspected_on <= cur.inspected_on) : null;
      parentId = String((before ?? pool[0])?.id ?? "");
    }
    // הסוג משנה את משמעות התוקף (בבדיקה חוזרת ריק = של התקופתי) — ולכן גם הוא מבטל את האישור
    return { ...cur, kind, parentId, closeOpen: false, confirmDates: false };
  });

  const save = async () => {
    if (!f || problems.length || phase === "saving") return;
    const sug = info?.suggest ?? null;
    const meta = {
      client_id: clientIdRef.current,
      kind: f.kind,
      machine_key: machineKey,
      inspected_on: f.inspected_on,
      valid_until: f.valid_until || null,
      report_number: null,
      inspector_name: null,
      inspector_license: null,
      machine_no: null,
      note: null,
      confirm_clean: clean,
      close_open_defects: f.kind === "followup" && clean && f.closeOpen && openCount > 0,
      default_deadline_days: Number(f.deadlineDays),
      // D25: מה שהוצע מהמסמך. השרת רושם "מהמסמך" רק אם התאריך שאושר זהה להצעה;
      // תאריך אחר (כפתור אחר, הקלדה, +12) נרשם 'manual'. ⚠️ בלי טקסט מהמסמך.
      parse: {
        parser: PARSER_VERSION,
        confidence: null,
        notes: [
          ...(sug ? [`suggest_${sug.rule}`] : info && !info.noText ? ["no_dates"] : []),
          ...(manualReason || moduleError ? ["manual_entry"] : []),
        ],
        extract: extract ?? "failed:none",
        parsed: {
          inspectedAt: sug?.inspected ?? null,
          validUntil: sug?.next ?? null,
          validitySource: sug?.next ? "document" : null,
        },
      },
    };
    if (f.kind === "followup") meta.followup_of = parent.id;
    if (f.kind === "periodic" && f.machineSel === NEW && f.machineLabel.trim()) meta.machine_label = f.machineLabel.trim();
    if (fileId) meta.file_id = fileId;
    const defects = withDefects
      // בלי due_on — השרת מחשב "תאריך הבדיקה + ימי התיקון", אותו כלל שמוצג כאן
      ? f.defects.map((d) => ({ body: d.body.trim(), urgent: false }))
      : [];

    setPhase("saving");
    setSaveError("");
    try {
      const res = await uploadInspection(site.code, meta, fileId ? null : file, defects);
      if (!aliveRef.current) return;
      const nextSaved = new Set(savedBlocks);
      if (blockIdx != null) nextSaved.add(blockIdx);
      const remaining = blocks ? blocks.filter((_, i) => !nextSaved.has(i)).length : 0;
      if (res?.fileId) setFileId(res.fileId);
      setSavedBlocks(nextSaved);
      if (remaining > 0) {
        setForm(null);
        setPhase("blocks");
      }
      onSaved?.(res, { done: remaining === 0 });
    } catch (err) {
      if (!aliveRef.current) return;
      setSaveError(err?.message || "השמירה נכשלה");
      // ⚠️ כשל לא ודאי (רשת / זמן קצוב) — ייתכן שהתסקיר כבר נשמר. אז "נסה שוב"
      // עם אותו client_id מקבל replay, והשרת **מתעלם** ממה ששונה בינתיים. לכן
      // הטופס ננעל: הניסיון החוזר שולח בדיוק את מה שנשלח, ותיקונים — אחר כך.
      if (err?.network) setLocked(true);
      setPhase("form");
    }
  };

  // ============================================================
  // תצוגה
  // ============================================================
  const sendingFile = !fileId;
  const footer = phase === "form" || phase === "saving" ? (
    <>
      <button type="button" className="it-btn" onClick={requestClose}>ביטול</button>
      <button type="button" className="it-btn it-btn--primary it-btn--wide" onClick={save}
        disabled={phase === "saving" || problems.length > 0}>
        {phase === "saving"
          ? (sendingFile && file ? `שומר… ${fmtMB(file.size)} MB` : "שומר…")
          : saveError ? "נסה שוב" : "שמירת התסקיר"}
      </button>
    </>
  ) : (
    <button type="button" className="it-btn" onClick={requestClose}>{phase === "blocks" && savedBlocks.size ? "סיום" : "ביטול"}</button>
  );

  const presetMachine = preset?.machineKey ? machineByKey.get(preset.machineKey) : null;
  // ⚠️ בלי שורת "הוצע: …" מתחת לשדות — הוסרה לבקשת בעלת המוצר (05/10/2026).
  // האישור הוא מול המסמך שליד, לא מול ההסבר איך נבחר התאריך.
  const dates = info?.dates ?? [];

  return (
    <InspectionDialog title={preset?.kind === "followup" ? "העלאת בדיקה חוזרת" : "העלאת תסקיר"} size="wide"
      onClose={requestClose} footer={footer} className="iu">
      {phase === "pick" && (
        <div className={`iu-pick iu-drop${dragOver ? " is-over" : ""}`}
          onDragOver={(e) => { if (hasDraggedFiles(e)) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
          onDrop={onPickDrop}>
          {presetMachine && <p className="it-muted">בדיקה חוזרת ל{machineTitle(presetMachine)}</p>}
          <p>גררו לכאן את קובץ ה-PDF של התסקיר, או בחרו אותו. הקובץ נקרא כאן, במכשיר — התאריכים שבו יוצעו לאישור לפני השמירה.</p>
          <button type="button" className="it-btn it-btn--primary it-btn--wide" data-autofocus onClick={() => inputRef.current?.click()}>
            בחירת קובץ PDF
          </button>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden className="iu-file"
            onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ""; pickFile(x); }} />
          <p className="it-hint">עד {fmtMB(COMPLIANCE_PDF_MAX_BYTES)} MB. קובץ סרוק כבד — סרקו ב-150 dpi בגווני אפור.</p>
          {fileError && <p className="it-error" role="alert">{fileError}</p>}
        </div>
      )}

      {phase === "parsing" && <p className="iu-state" role="status">קורא את המסמך…</p>}

      {phase === "blocks" && blocks && (
        <div className="iu-blocks">
          <p className="it-banner it-banner--warn">
            הקובץ מכיל {blocks.length} תסקירים — מעלים כל אחד בנפרד. הקובץ נשמר פעם אחת.
          </p>
          {savedBlocks.size > 0 && (
            <p className="it-success" role="status">✓ נשמרו {savedBlocks.size} מתוך {blocks.length}</p>
          )}
          <ul className="it-list">
            {blocks.map((b, i) => (
              <li key={i}>
                <button type="button" className="iu-block" disabled={savedBlocks.has(i)} onClick={() => chooseBlock(i)}>
                  <strong>תסקיר {i + 1}</strong>
                  {b.info.suggest && (
                    <span>
                      {b.info.suggest.inspected ? `נבדק ${formatDateIL(b.info.suggest.inspected)} · ` : ""}הבאה {formatDateIL(b.info.suggest.next)}
                    </span>
                  )}
                  {Array.isArray(b.pages) && <span className="it-muted">עמודים {b.pages.join(", ")}</span>}
                  {savedBlocks.has(i) && <span className="it-tag it-tag--clean">נשמר</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(phase === "form" || phase === "saving") && f && (
        <div className="iu-layout">
          <div className="iu-preview-col">
            {file && <PdfPreview file={file} page={info?.page ?? 1} onOpenFull={() => setViewer(true)} />}
          </div>

          <fieldset className="iu-form-col it-form" disabled={phase === "saving" || locked}>
            {locked && (
              <p className="it-banner it-banner--warn" role="status">
                לא ידוע אם התסקיר נשמר — החיבור נקטע. "נסה שוב" ישלח בדיוק את מה שנשלח;
                תיקונים אפשר לעשות אחרי השמירה, בעריכת התסקיר.
              </p>
            )}
            {moduleError && (
              <div className="it-banner it-banner--warn" role="alert">
                גרסה חדשה של הדשבורד זמינה — רעננו את הדף כדי שהתאריכים ייקראו מהמסמך.
                <span className="it-inline-btns">
                  <button type="button" className="it-btn it-btn--small" onClick={() => window.location.reload()}>רענון</button>
                </span>
                <span className="it-hint">אפשר גם להמשיך כאן בהזנה ידנית.</span>
              </div>
            )}
            {manualReason && <p className="it-banner it-banner--warn" role="alert">{manualReason}</p>}
            {file && file.size > COMPLIANCE_PDF_WARN_BYTES && (
              <p className="it-hint">קובץ גדול ({fmtMB(file.size)} MB) — השמירה עשויה להימשך.</p>
            )}
            {blocks && blockIdx != null && (
              <p className="it-muted">תסקיר {blockIdx + 1} מתוך {blocks.length} שבקובץ</p>
            )}

            {/* ---- סוג — רק כשיש תקופתי שאפשר לשייך אליו בדיקה חוזרת ---- */}
            {periodics.length > 0 && (
              <div className="it-field">
                <span className="it-label">סוג</span>
                <div className="iu-seg" role="radiogroup" aria-label="סוג התסקיר">
                  {[["periodic", "תסקיר תקופתי"], ["followup", "בדיקה חוזרת"]].map(([k, label]) => (
                    <button key={k} type="button" role="radio" aria-checked={f.kind === k}
                      className={`iu-seg-btn${f.kind === k ? " is-on" : ""}`}
                      onClick={() => setKind(k)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ---- מתקן — רק כשיש באתר מתקנים להבחין ביניהם ---- */}
            {f.kind === "periodic" && machines.length > 0 && (
              <div className="it-grid2">
                <label className="it-field">
                  <span className="it-label">מתקן</span>
                  <select className="it-input" name="machine" value={f.machineSel} onChange={(e) => set("machineSel", e.target.value)}>
                    {f.machineSel === "" && <option value="">— לבחור —</option>}
                    {machines.map((m) => (
                      <option key={m.key} value={m.key}>{machineTitle(m)}{m.retired_at ? " (הוצא משימוש)" : ""}</option>
                    ))}
                    <option value={NEW}>מתקן חדש…</option>
                  </select>
                </label>
                {f.machineSel === NEW && (
                  <>
                    <label className="it-field">
                      <span className="it-label">מספר המתקן</span>
                      <input className="it-input" value={f.newKey} maxLength={40} onChange={(e) => set("newKey", e.target.value)} />
                    </label>
                    <label className="it-field">
                      <span className="it-label">שם המתקן (לא חובה)</span>
                      <input className="it-input" value={f.machineLabel} maxLength={80} placeholder="למשל: מעלית צפון"
                        onChange={(e) => set("machineLabel", e.target.value)} />
                    </label>
                  </>
                )}
              </div>
            )}
            {f.kind === "followup" && (
              <label className="it-field">
                <span className="it-label">שייך לתסקיר התקופתי</span>
                <select className="it-input" value={f.parentId} onChange={(e) => set("parentId", e.target.value)}>
                  <option value="">— לבחור —</option>
                  {periodics.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {machineTitle(machineByKey.get(p.machine_key) ?? { key: p.machine_key })} · תסקיר {formatDateIL(p.inspected_on)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {f.kind === "followup" && openCount > 0 && (
              <p className="it-banner it-banner--warn">{openCount} ליקויים עדיין פתוחים במחזור הזה.</p>
            )}

            {/* ---- תאריכים — מהתאריכים שבמסמך ---- */}
            {dates.length === 0 && !manualReason && !moduleError && (
              <p className="it-banner it-banner--warn" role="status">לא נמצאו תאריכים במסמך — להזין אותם מהמסמך.</p>
            )}
            <div className="it-field">
              <label className="it-label" htmlFor="iu-valid">
                הבדיקה הבאה{f.kind === "periodic" ? "" : " — לא חובה"}
              </label>
              <input id="iu-valid" className="it-input it-input--date" type="date" value={f.valid_until} name="valid_until"
                onChange={(e) => set("valid_until", e.target.value)} />
              {f.kind === "followup" && !f.valid_until && (
                <span className="it-hint">
                  ריק = כמו התסקיר התקופתי{parent?.valid_until ? ` (${formatDateIL(parent.valid_until)})` : ""}
                </span>
              )}
            </div>
            {showInsp && (
              <div className="it-field">
                <label className="it-label" htmlFor="iu-insp">תאריך הבדיקה</label>
                <input id="iu-insp" className="it-input it-input--date" type="date" max={today} value={f.inspected_on}
                  onChange={(e) => set("inspected_on", e.target.value)} name="inspected_on" />
              </div>
            )}

            {/* ⚠️ אדם מאשר את התאריך — הוא קובע את צבע המנורה ואת ההתראות. התווית
                חוזרת על הערך עצמו, כדי שהאישור יהיה על מה שמוצג ולא על "הטופס". */}
            <label className="it-check it-check--strong iu-confirm-dates">
              <input type="checkbox" checked={f.confirmDates} name="confirm_dates"
                disabled={!f.inspected_on || (f.kind === "periodic" && !f.valid_until)}
                onChange={(e) => setForm((cur) => ({ ...cur, confirmDates: e.target.checked }))} />
              <span>
                בדקתי מול המסמך: {showInsp && f.inspected_on ? `נבדק ב-${formatDateIL(f.inspected_on)}, ` : ""}
                {f.valid_until
                  ? `הבדיקה הבאה ${formatDateIL(f.valid_until)}`
                  : f.kind === "followup" ? "התוקף כמו התסקיר התקופתי" : "—"}
              </span>
            </label>

            {/* ---- ליקויים — בחירה של אדם, בלי ברירת מחדל ---- */}
            <label className="it-field iu-defects-choice">
              <span className="it-label">ליקויים</span>
              <select className="it-input" name="defects_choice" value={f.defectsChoice}
                onChange={(e) => chooseDefects(e.target.value)}>
                <option value="">— לבחור —</option>
                <option value="none">אין ליקויים</option>
                <option value="some">יש ליקויים</option>
              </select>
            </label>

            {clean && f.kind === "followup" && openCount > 0 && (
              <label className="it-check">
                <input type="checkbox" checked={f.closeOpen} name="close_open_defects"
                  onChange={(e) => set("closeOpen", e.target.checked)} />
                <span>הבודק אישר את התיקונים — לסגור {openCount} ליקויים פתוחים</span>
              </label>
            )}

            {withDefects && (
              <div className="iu-defects">
                <label className="iu-deadline-field">
                  <span className="it-label">תוך כמה ימים לתקן</span>
                  <span className="iu-deadline-row">
                    <input className="it-input iu-num" type="number" inputMode="numeric" min={0} max={365} name="deadline_days"
                      value={f.deadlineDays} placeholder="ימים"
                      onChange={(e) => set("deadlineDays", e.target.value === "" ? "" : Number(e.target.value))} />
                    <span className="iu-deadline-txt">ימים{dueDate ? ` — עד ${formatDateIL(dueDate)}` : ""}</span>
                  </span>
                </label>
                <span className="it-label">הליקויים ({f.defects.length})</span>
                {f.defects.length > 0 && (
                  <ol className="iu-lines">
                    {f.defects.map((d, i) => (
                      <li key={d.key} className="iu-line" data-defect={i + 1}>
                        <span className="iu-line-no" aria-hidden="true">{i + 1}.</span>
                        <input id={`iu-def-${d.key}`} className="it-input iu-line-input" type="text" maxLength={2000}
                          value={d.body} placeholder="תיאור הליקוי, כמו במסמך" aria-label={`ליקוי ${i + 1}`}
                          onChange={(e) => setDefect(d.key, { body: e.target.value })}
                          // ליקוי שנשבר לשתי שורות במסמך — בלי זה השדה מוחק את ירידת השורה ומדביק מילים
                          onPaste={(e) => pasteCleaned(e, (v) => setDefect(d.key, { body: v }))}
                          onDrop={(e) => dropCleaned(e, (v) => setDefect(d.key, { body: v }))}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (d.body.trim()) addDefect(); } }} />
                        <button type="button" className="iu-x" aria-label={`הסרת ליקוי ${i + 1}`} title="הסרה"
                          onClick={() => removeDefect(d.key)}>×</button>
                      </li>
                    ))}
                  </ol>
                )}
                <button type="button" className="it-btn iu-add-line" onClick={addDefect}>+ עוד ליקוי</button>
                <p className="it-hint">אחרי השמירה כל ליקוי מסומן "בוצע" בנפרד, עם תמונה, ורואים כמה נשארו. כשכולם תוקנו — מעלים את התסקיר הנקי של הבדיקה החוזרת.</p>
              </div>
            )}

            {problems.length > 0 && <p className="it-hint iu-problems">כדי לשמור: {problems.join(" · ")}</p>}
            {saveError && <p className="it-error" role="alert">{saveError}</p>}
          </fieldset>
        </div>
      )}

      {viewer && file && (
        <ComplianceFileViewer
          title={file.name}
          // ⚠️ הכתובת עוברת לבעלות התצוגה — היא משחררת אותה בסגירה
          fetchFile={async () => ({ blobUrl: URL.createObjectURL(file), mime: "application/pdf", fileName: file.name })}
          onClose={() => setViewer(false)}
        />
      )}
    </InspectionDialog>
  );
}
