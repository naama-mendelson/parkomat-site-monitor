// components/Compliance/ComplianceAlertsButton.jsx — "מה דורש טיפול" בבודק ובתחזוקה, למנהלים.
//
// ============================================================
// ⚠️ זה הערוץ המובטח, וה-push הוא תוספת
// ============================================================
// במנורה שבכרטיס, תסקיר שיפוג בעוד 45 יום הוא **ירוק** (הצהוב מתחיל ב-30).
// ההתראה "חודשיים לפני" שביקשה בעלת המוצר אינה נראית שם בכלל. הרשימה הזו
// מציגה אותה בתוך האפליקציה, בלי תלות בכך שהטלפון אישר התראות או שה-push
// בכלל הופעל (D12). היא נגזרת מ-`sites[].compliance` שכבר נטען — אין כאן
// שום שליפה.
//
// ⚠️ ואין כאן סף שמחליט על **צבע**: הצבעים נקבעים ב-SQL. מה שכאן הוא רק
// "מה להכניס לרשימה" — 60 יום לתסקיר, ו-14 יום להמתנה לתסקיר נקי — לפי
// אבני הדרך של D12.
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { AREA_NAME, PM_ENABLED } from "../../utils/compliance";
import { complianceAlerts } from "../../utils/complianceAlerts";
import { AreaIcon } from "./icons";
import "./ComplianceAlertsButton.css";

/**
 * @param {{sites: Array, onOpen: (code: string, tab: "inspection"|"pm") => void}} props
 */
export default function ComplianceAlertsButton({ sites, onOpen }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  // ============================================================
  // ⚠️ מיקום מחושב מהכפתור, לא עוגן ב-CSS
  // ============================================================
  // עוגן `inset-inline-end:0` ב-RTL הוא שמאל — והחלון גדל ימינה מהכפתור. בין
  // 641 ל-1100px הכותרת נשברת לשורה שנייה, הכפתור נוחת בקצה הימני, ו-310px
  // מהחלון יצאו מהמסך (ב-RTL אי אפשר לגלול אליהם). ובטלפון `top:64px` כיסה את
  // הכפתור עצמו. אותו פתרון כמו ב-AccountMenu: מהמלבן האמיתי, חתוך לשני הצדדים.
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const M = 12;
      const w = Math.min(420, window.innerWidth - 2 * M);
      const left = Math.max(M, Math.min(r.right - w, window.innerWidth - w - M));
      const top = r.bottom + 8;
      setPos({ top, left, width: w, maxHeight: Math.max(200, window.innerHeight - top - M) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  const { rows, noReport, noPm, unknown } = useMemo(() => complianceAlerts(sites), [sites]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // ⚠️ מנהלים בלבד — בקר רואה את המנורות בכרטיסים, וזה מספיק לו.
  if (user?.role !== "manager") return null;
  // במצב שרת אין רמזורים בכלל (compliance === undefined בכל האתרים)
  if (!sites?.some((s) => s.compliance !== undefined)) return null;

  const red = rows.some((r) => r.sev >= 4);
  const count = rows.length;
  // ⚠️ "לא נטען" אינו "הכול בסדר". כשהסטטוס של אתרים לא נטען (למשל ה-SQL עוד
  // לא הוחל, או שהמסד לא ענה), הכפתור לא יגיד "אין התראות" — זה בדיוק המצב
  // שבו תסקיר שפג יכול לשבת ברשימה שאיש אינו רואה (לקח 17/09).
  const partial = unknown > 0;
  const sites1 = (n, many) => (n === 1 ? "אתר אחד" : `${n} ${many}`);
  // תחזוקה מוסתרת (PM_ENABLED) → הכותרות מדברות על הבודק בלבד
  const area = PM_ENABLED ? "בודק / תחזוקה" : "בודק מוסמך";
  const title = PM_ENABLED ? "בודק מוסמך ותחזוקה מונעת" : "בודק מוסמך";
  const label = count
    ? `${area}: ${count} דורשים טיפול${partial ? ` · הסטטוס של ${sites1(unknown, "אתרים")} לא נטען` : ""}`
    : partial
      ? `${area}: הסטטוס של ${sites1(unknown, "אתרים")} לא נטען`
      : `${title} — הכול בסדר`;

  return (
    <div className="cab" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`theme-toggle cab-btn${count ? (red ? " cab-btn--red" : " cab-btn--amber") : partial ? " cab-btn--unknown" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
        aria-label={label}
      >
        <AreaIcon area="inspection" size={18} />
        {count > 0 && <span className="cab-count" aria-hidden="true">{count}</span>}
      </button>

      {open && (
        <div className="cab-panel" role="dialog" aria-label={`${title} — דורש טיפול`}
          style={pos ? { top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight } : { visibility: "hidden" }}>
          <div className="cab-head">
            <strong>{title}</strong>
            <span className="cab-sub">{PM_ENABLED ? "תסקיר — 60 יום לפני · תחזוקה — 30 יום לפני" : "תסקיר — 60 יום לפני"}</span>
          </div>

          {count === 0 && !partial && <p className="cab-empty">אין כרגע מה לטפל בו ✓</p>}
          {partial && (
            // ⚠️ למעלה ולא בתחתית: מתחת ל"✓" הוא היה נקרא כהערת שוליים
            <p className="cab-warn" role="status">
              הסטטוס של {sites1(unknown, "אתרים")} לא נטען — הרשימה אינה מלאה.
            </p>
          )}

          {count > 0 && (
            <ul className="cab-list">
              {rows.map((r, n) => (
                <li key={`${r.code}-${r.tab}-${n}`}>
                  <button
                    type="button"
                    className={`cab-row cab-row--${r.sev >= 4 ? "red" : r.sev === 3 ? "amber" : "info"}`}
                    onClick={() => { setOpen(false); onOpen?.(r.code, r.tab); }}
                  >
                    <AreaIcon area={r.tab} size={14} className="cab-row-icon" />
                    <span className="cab-row-main">
                      <span className="cab-row-site">{r.name}</span>
                      <span className="cab-row-text">{r.text}</span>
                    </span>
                    <span className="cab-row-tab">{AREA_NAME[r.tab]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {(noReport > 0 || noPm > 0) && (
            // ⚠️ מונה המילוי לאחור: עד שמוגדר תאריך עלייה לאוויר, אתר בלי
            // תסקיר הוא אפור ולא אדום — אבל מישהו צריך לדעת כמה נשארו.
            <p className="cab-backfill">
              {noReport > 0 && <>{sites1(noReport, "אתרים")} עדיין ללא תסקיר בודק במערכת</>}
              {noReport > 0 && noPm > 0 && " · "}
              {noPm > 0 && <>{sites1(noPm, "אתרים")} ללא תחזוקה מונעת רשומה</>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
