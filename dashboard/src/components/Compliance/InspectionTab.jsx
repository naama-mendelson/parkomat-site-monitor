// components/Compliance/InspectionTab.jsx — תוכן "בודק מוסמך": העמוד המלא (InspectionPage) וגם הלשונית בחלון האתר.
//
// מה רואים, מלמעלה למטה:
//   1. פס מצב — נורה, תוקף, ולמה הנורה צבועה כשהתסקיר בתוקף (ושורה לכל מתקן כשיש יותר מאחד).
//   2. באנר "ממתין לתסקיר נקי" / "לבדיקה" — כשהפעולה הבאה היא של המנהל.
//   3. ליקויים פתוחים במחזור הנוכחי, ו"בוצעו (N)".
//   4. היסטוריית התסקירים, ו"היסטוריית שינויים" (נטענת רק כשנפתחת).
//
// ============================================================
// ⚠️ אין כאן החלטה על צבע ואין כאן הרשאה
// ============================================================
// הנורה, התוקף ומצב המחזור מגיעים מ-`inspection_site` (SQL). המסך לא מחשב
// "פג/בתוקף" בעצמו — עותק מקומי של הכלל היה נותן יום בשנה שבו הלשונית
// והכרטיס חלוקים. וכפתורי המנהל רק **מוסתרים** ממפעיל: השרת דוחה כל פעולת
// מנהל ממי שאינו מנהל (require_manager), והסתרה היא נימוס ולא הגנה.
//
// ============================================================
// ⚠️ onDirtyChange — "סגירה עכשיו תאבד משהו"
// ============================================================
// החלון שמעלינו (InsightsModal) שואל `window.confirm(reason)` לפני סגירה
// כשהסיבה אינה null. הסיבות נאספות מהחלונות הפנימיים: תמונה בדרך או
// שנכשלה, העלאת תסקיר בתהליך, טופס אישור שלא נשמר. שמירה **מוצלחת** אינה
// סיבה — תמונה שכבר במסד תופיע שוב בפתיחה הבאה.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closeDefectsByReport, deleteDefect, deleteInspectionReport, fetchComplianceFile, fetchInspectionSite,
  reopenDefect, retireMachine,
} from "../../services/dataSource";
import { useAuth } from "../../hooks/useAuth";
import {
  GLYPH, LIGHT_LABEL, formatDateIL, formatDayMonth, machineLampLabel, stateLabel, toCompliance, todayIL,
} from "../../utils/compliance";
import { ClipboardCheckIcon } from "./icons";
import { COMPLIANCE_COLORS, COMPLIANCE_STATES } from "../../utils/constants";
import ComplianceFileViewer from "./ComplianceFileViewer";
import { InspectionMenu, InspectionReasonDialog } from "./InspectionDialog";
import { DefectDoneRow, DefectRow, FixesPdfButton } from "./DefectRows";
import DefectCloseDialog from "./DefectCloseDialog";
import DefectEditDialog from "./DefectEditDialog";
import InspectionReportEdit from "./InspectionReportEdit";
import InspectionUpload from "./InspectionUpload";
import InspectionHistory from "./InspectionHistory";
import { KIND_LABEL, deriveInspection, hasDraggedFiles, ilDateOf, machineTitle, validityText } from "./InspectionUtils";
import "./InspectionTab.css";

const LAMP_STATES = new Set(COMPLIANCE_STATES);
const NOTICE_MS = 5000;

// ⚠️ `label` ולא LIGHT_LABEL[state]: המצב נקבע גם מהליקויים ומהמחזור, ותווית לפי הצבע
// בלבד הייתה אומרת "עומד לפוג" ליד "בתוקף עד 03/2027" באותה שורה.
//
// ⚠️ מילוי, מסגרת וסימן — אותם משתנים בדיוק כמו המנורה בכרטיס (COMPLIANCE_COLORS →
// ComplianceLights.css), לא עותק כאן: שני עותקים כבר סטו פעם (ירוק #15803d מול #166534).
function Lamp({ state, label, small = false }) {
  const s = LAMP_STATES.has(state) ? state : "none";
  const text = label ?? LIGHT_LABEL.inspection[s] ?? "";
  const c = COMPLIANCE_COLORS[s];
  return (
    <span className={`it-lamp it-lamp--${s}${small ? " it-lamp--small" : ""}`} role="img"
      aria-label={text} title={text} style={{ background: c.bg, borderColor: c.border, color: c.ink }}>
      <ClipboardCheckIcon size={small ? 11 : 13} />
      <span className="it-lamp-glyph" aria-hidden="true">{GLYPH[s]}</span>
    </span>
  );
}

function DoneList({ items, byId, isManager, onReopen, onOpenPhoto, site, machineLabel }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="it-donelist">
      {/* ⚠️ הכפתור ליד "בוצעו" ולא בתוך הרשימה: הוא מסמך של כל התיקונים, וגלוי גם כשהרשימה מקופלת */}
      <div className="it-donelist-head">
        <button type="button" className="it-collapse it-collapse--inline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span>בוצעו ({items.length})</span>
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </button>
        <FixesPdfButton defects={items} site={site} machineLabel={machineLabel} byId={byId} />
      </div>
      {open && (
        <ul className="it-list it-rows">
          {items.map((d) => (
            <DefectDoneRow key={d.id} defect={d} closingReport={byId.get(d.closed_by_report_id)}
              isManager={isManager} onReopen={onReopen} onOpenPhoto={onOpenPhoto} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * @param {object} p
 * @param {{id:number, code:string, site_name:string}} p.site
 * @param {number} [p.complianceRev] — עולה כשהגיע אירוע compliance לאתר; טוען מחדש
 * @param {(reason: string|null) => void} [p.onDirtyChange]
 * @param {() => void} [p.onChanged] — אחרי כל כתיבה מוצלחת (ההורה מרענן את נורת הכרטיס)
 * @param {boolean} [p.dropAnywhere] — בעמוד המלא (InspectionPage): קובץ ששוחרר בכל מקום בעמוד פותח את ההעלאה
 */
export default function InspectionTab({ site, complianceRev = 0, onDirtyChange, onChanged, dropAnywhere = false }) {
  const { user } = useAuth();
  const isManager = user?.role === "manager";
  const code = site?.code;

  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loadedRev, setLoadedRev] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [notice, setNotice] = useState("");
  const seqRef = useRef(0);
  const noticeTimer = useRef(null);
  const onChangedRef = useRef(onChanged);
  const onDirtyRef = useRef(onDirtyChange);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);
  useEffect(() => { onDirtyRef.current = onDirtyChange; }, [onDirtyChange]);

  // ---------------- טעינה ----------------
  // ⚠️ מונה בקשות: אירוע compliance ושמירה שקורים יחד שולחים שתי טעינות, והאיטית
  // מביניהן לא תדרוס את החדשה.
  const load = useCallback(async () => {
    const my = ++seqRef.current;
    try {
      const d = await fetchInspectionSite(code);
      if (my === seqRef.current) {
        setData(d);
        setLoadError("");
        setLoadedRev((n) => n + 1);
      }
      return d;
    } catch (err) {
      if (my === seqRef.current) setLoadError(err?.message || "הנתונים לא נטענו");
      throw err;
    }
  }, [code]);

  useEffect(() => {
    if (!code) return;
    load().catch(() => {});
  }, [load, code, complianceRev]);

  // ---------------- הגנת סגירה ----------------
  const dirtyMap = useRef(new Map());
  const lastDirty = useRef(null);
  const setDirty = useCallback((key, reason) => {
    const m = dirtyMap.current;
    if (reason) m.set(key, reason);
    else m.delete(key);
    const next = m.size ? [...m.values()][0] : null;
    if (next !== lastDirty.current) {
      lastDirty.current = next;
      onDirtyRef.current?.(next);
    }
  }, []);
  const dialogDirty = useCallback((reason) => setDirty("dialog", reason), [setDirty]);
  useEffect(() => () => {
    clearTimeout(noticeTimer.current);
    onDirtyRef.current?.(null);
  }, []);

  const flash = useCallback((msg) => {
    clearTimeout(noticeTimer.current);
    setNotice(msg);
    if (msg) noticeTimer.current = setTimeout(() => setNotice(""), NOTICE_MS);
  }, []);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setDirty("dialog", null);
  }, [setDirty]);

  const afterWrite = useCallback(async (msg) => {
    if (msg) flash(msg);
    try { onChangedRef.current?.(); } catch { /* ההורה אחראי לשלו */ }
    try { await load(); } catch { /* השגיאה מוצגת בפס "לא רועננו" */ }
  }, [flash, load]);

  // "כבר סומן" (PT409) בחלון הסגירה — טוענים ובודקים מה המצב בפועל
  const recheckDefect = useCallback(async (id) => {
    const d = await load();
    for (const r of d?.reports || []) for (const x of r.defects || []) if (x.id === id) return x.status;
    return null;
  }, [load]);

  const today = todayIL();
  const fresh = data && (data.site?.code ?? code) === code ? data : null;
  const derived = useMemo(() => deriveInspection(fresh), [fresh]);

  // ---------------- פעולות ----------------
  const openUpload = (preset = null, file = null) => setDialog({ type: "upload", preset, file });

  // ---------------- גרירת קובץ ----------------
  // ⚠️ כל זמן שהלשונית פתוחה: קובץ ששוחרר **מחוץ** לאזור היה נפתח בדפדפן במקום
  // הדשבורד — ומוחק טופס שלא נשמר. לכן חלון שלם מקבל את הגרירה ולא עושה כלום,
  // והאזור מסומן מרגע שקובץ נכנס לחלון, כדי שיהיה ברור לאן לשחרר.
  const [dragOver, setDragOver] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const dropInputRef = useRef(null);
  // חלון פתוח (טופס, תמונה, צפייה בקובץ) — קובץ ששוחרר בעמוד לא יחליף אותו
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = !!dialog || !!viewer; }, [dialog, viewer]);
  useEffect(() => {
    // ⚠️ בעמוד המלא גם למי שאינו מנהל: בלי זה קובץ שגרר טכנאי היה נפתח בדפדפן
    // במקום הדשבורד. הוא מקבל הסבר במקום. בלשונית שבחלון — כמו קודם.
    if (!isManager && !dropAnywhere) return undefined;
    // ⚠️ dragover יורה ברצף כל עוד קובץ מעל החלון, ולכן "שקט" של רגע = הגרירה
    // נגמרה. בלי זה, גרירה שבוטלה ב-Esc או שיצאה מהחלון בתנועה מהירה הייתה
    // משאירה את האזור על "שחררו כאן" — dragleave לא תמיד יורה במקרים האלה.
    let quiet = null;
    const reset = () => { clearTimeout(quiet); setDragActive(false); setDragOver(false); };
    const over = (e) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      if (!isManager) return;
      setDragActive(true);
      clearTimeout(quiet);
      quiet = setTimeout(reset, 400);
    };
    const drop = (e) => {
      if (!hasDraggedFiles(e)) { reset(); return; }
      // ⚠️ defaultPrevented = מלבן הגרירה או טופס ההעלאה כבר קיבלו את הקובץ
      // (React מטפל לפני window). בלעדיו אותה גרירה הייתה נפתחת פעמיים.
      const handled = e.defaultPrevented;
      e.preventDefault();
      reset();
      if (handled || !dropAnywhere || busyRef.current) return;
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (!isManager) { flash("רק מנהל יכול להעלות תסקיר"); return; }
      setDialog({ type: "upload", preset: null, file: f });
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      clearTimeout(quiet);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [isManager, dropAnywhere, flash]);
  const openPhoto = (p) => setViewer({
    key: `ph-${p.id}`, title: "תמונת ביצוע", fetchFile: () => fetchComplianceFile("defect_photo", p.id),
  });
  const openReportFile = (r) => setViewer({
    key: `pdf-${r.file?.id}`,
    title: `${KIND_LABEL[r.kind] ?? "תסקיר"} ${formatDateIL(r.inspected_on)}`,
    fetchFile: () => fetchComplianceFile("inspection_pdf", r.file.id),
  });
  const askReason = (cfg) => setDialog({ type: "reason", ...cfg });

  const onRetire = (m) => askReason({
    title: `הוצאת ${machineTitle(m)} משימוש`,
    // ⚠️ אומרים מה קורה לליקויים: הם יוצאים מהרשימה ומהספירה, ואי אפשר לסמן אותם
    // כבוצע — ואין "ביטול", רק תסקיר תקופתי חדש ומאוחר יותר מחזיר את המתקן.
    message: [
      "מתקן שהוצא משימוש אינו נספר בנורת האתר.",
      m.open > 0
        ? `ל${machineTitle(m)} יש ${m.open === 1 ? "ליקוי פתוח אחד" : `${m.open} ליקויים פתוחים`}${m.overdue ? ` (${m.overdue} עברו את מועד התיקון)` : ""} — הם יוסרו מרשימת הליקויים הפתוחים ומהספירה בכרטיס, ולא יהיה אפשר לסמן אותם כבוצע.`
        : "",
      "אין ביטול: רק תסקיר תקופתי חדש, מאוחר מהקיים, יחזיר את המתקן לשימוש.",
    ].filter(Boolean).join(" "),
    confirmLabel: "הוצאה משימוש", danger: true,
    run: async (reason) => { await retireMachine(code, m.key, reason); return "המתקן הוצא משימוש"; },
  });
  const onDeleteReport = (r, followups = 0) => followups > 0 ? flash(
    followups === 1
      ? "יש לתסקיר הזה בדיקה חוזרת — יש למחוק אותה קודם"
      : `יש לתסקיר הזה ${followups} בדיקות חוזרות — יש למחוק אותן קודם`,
  ) : askReason({
    title: `מחיקת ${KIND_LABEL[r.kind] ?? "תסקיר"} מ-${formatDateIL(r.inspected_on)}`,
    message: [
      "התסקיר יוסר מהרשימה ומהנורה. הפעולה נרשמת בהיסטוריה עם הסיבה.",
      r.kind === "followup" && r.declared_clean ? "ליקויים שנסגרו על סמך התסקיר הזה ייפתחו מחדש." : "",
    ].filter(Boolean).join(" "),
    confirmLabel: "מחיקה", danger: true,
    run: async (reason) => { await deleteInspectionReport(r.id, reason); return "התסקיר נמחק"; },
  });
  const onDeleteDefect = (d) => askReason({
    title: "מחיקת ליקוי",
    message: `"${d.body}" — מחיקה רק כשהליקוי הוזן בטעות. ליקוי שתוקן מסמנים כבוצע.`,
    confirmLabel: "מחיקה", danger: true,
    run: async (reason) => { await deleteDefect(d.id, reason); return "הליקוי נמחק"; },
  });
  const onReopen = (d) => askReason({
    title: "פתיחה מחדש של ליקוי",
    message: `"${d.body}" — התמונות הקודמות נשמרות כהיסטוריה; סגירה חדשה תדרוש תמונה חדשה.`,
    confirmLabel: "פתיחה מחדש",
    run: async (reason) => { await reopenDefect(d.id, reason); return "הליקוי נפתח מחדש"; },
  });
  const onCloseByReport = (r, n) => askReason({
    title: "סגירת ליקויים בתסקיר חוזר נקי",
    message: `${n} ליקויים פתוחים במחזור ייסגרו על סמך התסקיר החוזר הנקי מ-${formatDateIL(r.inspected_on)}, בלי תמונה. הפעולה נרשמת על שמך.`,
    confirmLabel: `סגירת ${n} ליקויים`, optional: true, placeholder: "תסקיר חוזר נקי",
    run: async (reason) => { const k = await closeDefectsByReport(r.id, reason); return `נסגרו ${k} ליקויים`; },
  });

  const runReason = async (reason) => {
    const msg = await dialog.run(reason);    // זורק = החלון מציג את השגיאה ונשאר פתוח
    closeDialog();
    await afterWrite(msg);
  };

  // ---------------- מצבי טעינה ----------------
  if (!fresh) {
    return (
      <div className="it-tab" dir="rtl">
        {loadError ? (
          <div className="insights-card it-card it-state">
            <p className="it-error" role="alert">בודק מוסמך — הנתונים לא נטענו: {loadError}</p>
            <button type="button" className="it-btn" onClick={() => load().catch(() => {})}>נסה שוב</button>
          </div>
        ) : (
          <p className="insights-state">טוען נתוני בודק מוסמך…</p>
        )}
      </div>
    );
  }

  const c = toCompliance(fresh.status);
  const insp = c.unknown ? null : c.inspection;
  const state = insp?.state ?? "none";
  const allRetired = derived.machines.length > 0 && derived.active.length === 0;
  const headline = allRetired
    ? "כל המתקנים הוצאו משימוש"
    : !insp?.validUntil
      ? (insp?.missing && state === "expired" ? "אין תסקיר במערכת — נדרש" : "אין תסקיר במערכת")
      : validityText(insp.validUntil, today);
  const machineLines = derived.machines.length > 1 || derived.machines.some((m) => m.retired_at);
  const single = !machineLines && derived.active.length === 1 ? derived.active[0] : null;
  const withReports = derived.cycles.filter((cy) => cy.reports.length > 0);
  const groupHeaders = withReports.length > 1;
  const openTotal = withReports.reduce((n, cy) => n + cy.open.length, 0);
  // "לראות כמה ליקויים נשארו" — מתוך כל הליקויים של המחזור הנוכחי (פתוחים + בוצעו)
  const cycleTotal = withReports.reduce((n, cy) => n + cy.open.length + cy.done.length, 0);
  const empty = derived.reports.length === 0;

  return (
    <div className="it-tab" dir="rtl">
      {notice && <p className="it-notice" role="status">{notice}</p>}
      {loadError && (
        <p className="it-banner it-banner--warn" role="alert">
          הנתונים לא רועננו: {loadError}{" "}
          <button type="button" className="it-link" onClick={() => load().catch(() => {})}>נסה שוב</button>
        </p>
      )}

      {/* ===== 1. פס מצב ===== */}
      <section className="insights-card it-card it-status">
        <div className="it-status-top">
          <Lamp state={state} label={insp ? stateLabel("inspection", c) : undefined} />
          <div className="it-status-text">
            <strong className="it-headline">{headline}</strong>
            {/* ⚠️ למה הנורה צבועה כשכתוב "בתוקף": בלי השורה הזו הנורה ישבה ליד "בתוקף עד…"
                בלי שום הסבר (בעלת המוצר, 06/10/2026: "תסדר"). כתום — עבר מועד; צהוב — מועד
                תיקון בעוד פחות מחודש, רק כשזה מה שצובע (בכתום הסיבה הכתומה מספיקה). */}
            {insp?.overdueDefects > 0 && (
              <span className="it-reason">
                {insp.overdueDefects === 1 ? "ליקוי אחד עבר את מועד התיקון" : `${insp.overdueDefects} ליקויים עברו את מועד התיקון`}
              </span>
            )}
            {state === "soon" && insp?.validityState === "ok" && insp?.dueSoonDefects > 0 && (
              <span className="it-reason it-reason--soon">
                {insp.dueSoonDefects === 1 ? "מועד התיקון של ליקוי אחד בעוד פחות מחודש" : `מועד התיקון של ${insp.dueSoonDefects} ליקויים בעוד פחות מחודש`}
              </span>
            )}
            {derived.active.length > 1 && insp?.validUntil && <span className="it-muted">המוקדם מבין המתקנים</span>}
            {/* ⚠️ בלי שבבים: "ליקויים פתוחים" ומספרם — בכותרת של רשימת הליקויים למטה, והמתנה
                לתסקיר נקי — בבאנר עם הפעולה. בעלת המוצר (06/10/2026): "תעיף את זה ותעצב את כל
                העמוד נורמלי ויותר מסודר". */}
          </div>
          {isManager && (
            <span className="it-status-actions">
              <button type="button" className="it-btn it-btn--primary" onClick={() => openUpload(null)}>העלאת תסקיר</button>
              {single && (
                <InspectionMenu label="פעולות על המתקן" items={[
                  { label: `הוצאת ${machineTitle(single)} משימוש`, danger: true, onSelect: () => onRetire(single) },
                ]} />
              )}
            </span>
          )}
        </div>

        {machineLines && (
          <ul className="it-machines">
            {derived.machines.map((m) => (
              <li key={m.key} className={`it-machine${m.retired_at ? " is-retired" : ""}`}>
                <Lamp state={m.retired_at ? "none" : m.state} label={m.retired_at ? undefined : machineLampLabel(m)} small />
                <span className="it-machine-text">
                  <strong>{machineTitle(m)}:</strong>{" "}
                  {m.retired_at
                    ? `הוצא משימוש ב-${formatDateIL(ilDateOf(m.retired_at) || "")}`
                    : validityText(m.valid_until, today)}
                </span>
                {!m.retired_at && m.open > 0 && (
                  <span className="it-machine-open">
                    {m.open === 1 ? "ליקוי פתוח" : `${m.open} ליקויים פתוחים`}
                    {m.overdue > 0 && <span className="it-late"> · {m.overdue === 1 ? "אחד עבר את המועד" : `${m.overdue} עברו את המועד`}</span>}
                  </span>
                )}
                {isManager && !m.retired_at && (
                  <InspectionMenu label={`פעולות על ${machineTitle(m)}`} items={[
                    { label: "הוצאת מתקן משימוש", danger: true, onSelect: () => onRetire(m) },
                  ]} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ===== מקום לגרור אליו תסקיר ===== */}
      {/* ⚠️ אותו מסלול בדיוק כמו "העלאת תסקיר": הקובץ נקרא במכשיר, והתאריכים
          והליקויים מוצעים לאישור לפני שמשהו נשמר. הגרירה רק חוסכת את שלב הבחירה. */}
      {isManager && (
        <>
          <button type="button" className={`it-drop${dragOver ? " is-over" : dragActive ? " is-armed" : ""}`}
            onClick={() => dropInputRef.current?.click()}
            onDragOver={(e) => { if (hasDraggedFiles(e)) { e.preventDefault(); setDragOver(true); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              setDragActive(false);
              const f = e.dataTransfer?.files?.[0];
              if (f) openUpload(null, f);
            }}>
            {dropAnywhere && <ClipboardCheckIcon size={20} className="it-drop-icon" />}
            <span className="it-drop-title">{dragOver || dragActive ? "שחררו כאן את התסקיר" : "גררו לכאן תסקיר בודק מוסמך (PDF)"}</span>
            <span className="it-drop-sub">או לחצו לבחירת קובץ · התאריכים יוצעו לאישור לפני השמירה</span>
          </button>
          <input ref={dropInputRef} type="file" accept="application/pdf,.pdf" hidden className="it-drop-file"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) openUpload(null, f); }} />
        </>
      )}
      {/* בעמוד שכל ייעודו הגרירה — מי שאינו רואה את המלבן צריך לדעת למה.
          (כשאין תסקירים בכלל, הכרטיס הריק למטה כבר אומר זאת.) */}
      {!isManager && dropAnywhere && !empty && (
        <p className="it-muted it-drop-note">העלאת תסקיר — למנהלים בלבד.</p>
      )}

      {/* ===== 2. באנרים — הפעולה הבאה היא של המנהל ===== */}
      {derived.cycles.map((cy) => {
        const who = groupHeaders || derived.active.length > 1 ? `${machineTitle(cy.machine)}: ` : "";
        if (cy.machine.cycle === "awaiting_clean") {
          return (
            <div key={`aw-${cy.key}`} className="it-banner it-banner--warn it-banner--action">
              <p>
                {who}כל הליקויים תוקנו — יש לזמן את הבודק לבדיקה חוזרת ולהעלות תסקיר נקי
                {cy.machine.awaiting_since ? ` (ממתין מאז ${formatDayMonth(cy.machine.awaiting_since)})` : ""}
              </p>
              {isManager && (
                <button type="button" className="it-btn"
                  onClick={() => openUpload({ kind: "followup", machineKey: cy.key, followupOf: cy.periodicId })}>
                  העלאת בדיקה חוזרת
                </button>
              )}
            </div>
          );
        }
        if (cy.machine.cycle === "review") {
          return (
            <div key={`rv-${cy.key}`} className="it-banner it-banner--warn it-banner--action">
              <p>{who}אין ליקויים פתוחים, אבל התסקיר לא סומן נקי — לבדוק</p>
              {isManager && cy.latest && (
                <button type="button" className="it-btn"
                  onClick={() => setDialog({ type: "editReport", report: cy.latest, parent: cy.latest.kind === "followup" ? cy.periodic : null })}>
                  עריכת פרטים
                </button>
              )}
            </div>
          );
        }
        return null;
      })}

      {/* ===== ריק ===== */}
      {empty && (
        <section className="insights-card it-card it-empty">
          <p>עדיין לא הועלה תסקיר בודק מוסמך לאתר הזה.</p>
          <p className="it-muted">
            {isManager
              ? "\"העלאת תסקיר\" קורא את ה-PDF כאן, במכשיר, ומציע את התאריכים והליקויים לאישור."
              : "מנהל יכול להעלות את התסקיר האחרון מתוך קובץ ה-PDF."}
          </p>
        </section>
      )}

      {/* ===== 3. ליקויים ===== */}
      {withReports.length > 0 && (
        <section className="insights-card it-card">
          <h3 className="it-h3">
            ליקויים פתוחים{openTotal > 0 && <span className="it-count">{openTotal}</span>}
          </h3>
          {cycleTotal > 0 && (
            <p className={`it-remaining${openTotal === 0 ? " is-done" : ""}`} role="status">
              {openTotal === 0
                ? `✓ כל ${cycleTotal === 1 ? "הליקוי תוקן" : `${cycleTotal} הליקויים תוקנו`}`
                : `נשארו ${openTotal} מתוך ${cycleTotal} ליקויים`}
            </p>
          )}
          {withReports.map((cy) => {
            const showSource = cy.reports.filter((r) => (r.defects || []).length > 0).length > 1;
            return (
              <div key={cy.key} className="it-group">
                {groupHeaders && <h4 className="it-group-title">{machineTitle(cy.machine)}</h4>}
                {cy.open.length === 0 ? (
                  <p className="it-muted it-none">
                    {cy.machine.cycle === "clean" ? "✓ אין ליקויים פתוחים — התסקיר האחרון נקי" : "אין ליקויים פתוחים"}
                  </p>
                ) : (
                  <ul className="it-list it-rows">
                    {cy.open.map((d) => (
                      <DefectRow key={d.id} defect={d} today={today} isManager={isManager} showSource={showSource}
                        onMarkDone={(x) => setDialog({ type: "close", defect: x })}
                        onEdit={(x) => setDialog({ type: "editDefect", defect: x, report: derived.byId.get(x.reportId) })}
                        onDelete={onDeleteDefect} />
                    ))}
                  </ul>
                )}
                {isManager && cy.addTarget && (
                  <button type="button" className="it-btn it-btn--small it-add"
                    onClick={() => setDialog({ type: "addDefect", report: cy.addTarget })}>
                    + הוספת ליקוי
                  </button>
                )}
                {cy.done.length > 0 && (
                  <DoneList items={cy.done} byId={derived.byId} isManager={isManager}
                    onReopen={onReopen} onOpenPhoto={openPhoto}
                    // במסמך לבודק השורה כבר נקראת "מתקן" — "מתקן 30245" היה חוזר על המילה; שם המתקן נשאר אם יש
                    site={site} machineLabel={!groupHeaders ? null : cy.machine.label ? machineTitle(cy.machine) : String(cy.machine.key)} />
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* ===== 4. היסטוריה ===== */}
      <InspectionHistory derived={derived} siteCode={code} isManager={isManager} rev={loadedRev}
        onViewFile={openReportFile}
        onEdit={(r, parent) => setDialog({ type: "editReport", report: r, parent })}
        onDelete={onDeleteReport}
        onCloseByReport={onCloseByReport}
        onOpenPhoto={openPhoto} />

      {/* ===== חלונות ===== */}
      {dialog?.type === "close" && (
        <DefectCloseDialog defect={dialog.defect} onDirtyChange={dialogDirty}
          onStaged={() => { load().catch(() => {}); }}
          recheck={() => recheckDefect(dialog.defect.id)}
          onDone={() => afterWrite("הליקוי סומן כבוצע")}
          // ⚠️ תמונות נשמרות כבר בבחירה (ובלי אירוע) — סגירה בלי "בוצע" עדיין
          // שינתה את השורה ("צולמו N", והאם מותר למחוק). רענון זול, בלי בתים.
          onClose={() => { closeDialog(); load().catch(() => {}); }} />
      )}
      {dialog?.type === "upload" && (
        <InspectionUpload site={site} derived={derived} preset={dialog.preset} initialFile={dialog.file ?? null} onDirtyChange={dialogDirty}
          onSaved={(res, { done }) => {
            const parts = [res?.replayed ? "התסקיר כבר נשמר" : "התסקיר נשמר"];
            if (res?.defects) parts.push(`${res.defects} ליקויים`);
            if (res?.closed) parts.push(`נסגרו ${res.closed} ליקויים`);
            if (done) closeDialog();
            afterWrite(done ? parts.join(" · ") : "");
          }}
          onClose={closeDialog} />
      )}
      {(dialog?.type === "addDefect" || dialog?.type === "editDefect") && (
        <DefectEditDialog defect={dialog.type === "editDefect" ? dialog.defect : null} report={dialog.report}
          onDirtyChange={dialogDirty} onClose={closeDialog}
          onSaved={() => { const add = dialog.type === "addDefect"; closeDialog(); afterWrite(add ? "הליקוי נוסף" : "הליקוי עודכן"); }} />
      )}
      {dialog?.type === "editReport" && (
        <InspectionReportEdit report={dialog.report} parent={dialog.parent} onDirtyChange={dialogDirty}
          onClose={closeDialog} onSaved={() => { closeDialog(); afterWrite("פרטי התסקיר נשמרו"); }} />
      )}
      {dialog?.type === "reason" && (
        <InspectionReasonDialog title={dialog.title} message={dialog.message} confirmLabel={dialog.confirmLabel}
          danger={dialog.danger} optional={dialog.optional} placeholder={dialog.placeholder}
          onSubmit={runReason} onClose={closeDialog} />
      )}
      {viewer && (
        <ComplianceFileViewer key={viewer.key} title={viewer.title} fetchFile={viewer.fetchFile} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}
