// components/Compliance/InspectionPage.jsx — "בודק מוסמך" כעמוד מלא של אתר אחד.
//
// לחיצה על מנורת הבודק בכרטיס (או על "בודק מוסמך" בחלון האתר) פותחת את
// העמוד הזה ולא חלון עם לשוניות: מלבן גרירה גדול למעלה, ומתחתיו הליקויים
// וכל התסקירים הקודמים. בקשת בעלת המוצר, 05/10/2026.
//
// ⚠️ **התוכן הוא InspectionTab עצמו, לא עותק.** אותם נתונים, אותן הרשאות
// ואותו טופס העלאה כמו בלשונית — עמוד שני עם קוד משלו היה מתחיל לסטות
// מהלשונית מהיום הראשון. מה שנוסף כאן הוא המסגרת בלבד: כותרת, חזרה, ושומר
// היציאה שהיה של החלון.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import Logo from "../Logo/Logo";
// insights-card / insights-state — הלשונית משתמשת בהם, והם מוגדרים שם
import "../InsightsModal/InsightsModal.css";
import "./InspectionPage.css";

// ⚠️ טעינה שנכשלת (אין קליטה בחניון, או גרסה חדשה שהוחלפה בשרת) לא מפילה את
// הדשבורד — אותו נימוק כמו lazyTab ב-InsightsModal. כאן כפתור החזרה נשאר
// בכותרת, ולכן מספיקה הודעה עם רענון.
function TabLoadFailed() {
  return (
    <p className="insights-state insights-error" role="alert">
      העמוד לא נטען — אין חיבור, או שהדשבורד עודכן.{" "}
      <button type="button" className="insights-retry" onClick={() => window.location.reload()}>רענון</button>
    </p>
  );
}
const InspectionTab = lazy(() => import("./InspectionTab").catch(() => ({ default: TabLoadFailed })));

/**
 * @param {object} p
 * @param {{id:number, code:string, site_name:string}} p.site
 * @param {string} p.backLabel — "חזרה לאתר" כשנפתח מחלון האתר, אחרת "חזרה לדשבורד"
 * @param {() => void} p.onBack
 * @param {number} [p.complianceRev]
 * @param {() => void} [p.onChanged]
 */
export default function InspectionPage({ site, backLabel, onBack, complianceRev = 0, onChanged }) {
  // ---- שומר יציאה — כמו ב-InsightsModal ----
  // טופס העלאה פתוח או תמונה בדרך: חזרה, Escape או סגירת הלשונית שואלים קודם.
  const blockerRef = useRef(null);
  const [blocker, setBlocker] = useState(null);
  const onDirtyChange = useCallback((reason) => {
    blockerRef.current = reason || null;
    setBlocker(reason || null);
  }, []);
  const guardedBack = useCallback(() => {
    const reason = blockerRef.current;
    if (reason && !window.confirm(`${reason}\n\nלצאת בכל זאת?`)) return;
    onBack();
  }, [onBack]);

  // ⚠️ החלונות שבתוך הלשונית עוצרים Escape בשלב ה-capture, ולכן Escape מגיע
  // לכאן רק כשאין חלון פתוח — כלומר הוא יוצא מהעמוד, ולא מטופס באמצע.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") guardedBack(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [guardedBack]);

  useEffect(() => {
    if (!blocker) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [blocker]);

  // ⚠️ הדשבורד שמתחת אינו נגלל: העמוד גולל את עצמו, ובלי זה היו במחשב שני
  // פסי גלילה זה לצד זה. מיקום הגלילה של הרשת נשמר, והחזרה נוחתת באותו מקום.
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    return () => { root.style.overflow = prev; };
  }, []);

  // מקלדת וקורא מסך מתחילים בעמוד, לא בכרטיס שנלחץ מאחוריו
  const pageRef = useRef(null);
  useEffect(() => { pageRef.current?.focus({ preventScroll: true }); }, []);

  return (
    <div ref={pageRef} className="ip-page" role="dialog" aria-modal="true" aria-labelledby="ip-title" dir="rtl" tabIndex={-1}>
      <header className="ip-header">
        <button type="button" className="ip-back" onClick={guardedBack}>
          <span aria-hidden="true">→</span> {backLabel}
        </button>
        <div className="ip-titles">
          <h1 id="ip-title" className="ip-title">בודק מוסמך</h1>
          <span className="ip-site">{site.site_name} · קוד אתר {site.code}</span>
        </div>
        <Logo size={30} />
      </header>

      <div className="ip-body">
        <Suspense fallback={<p className="insights-state">טוען…</p>}>
          <InspectionTab site={site} complianceRev={complianceRev}
            onDirtyChange={onDirtyChange} onChanged={onChanged} dropAnywhere />
        </Suspense>
      </div>
    </div>
  );
}
