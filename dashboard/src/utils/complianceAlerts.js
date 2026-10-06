// utils/complianceAlerts.js — "מה דורש טיפול" בבודק ובתחזוקה, מתוך sites[].compliance.
//
// קובץ טהור (בלי React) — כדי שאפשר יהיה לבדוק אותו ב-node, ושהרכיב
// (ComplianceAlertsButton) יישאר קובץ של רכיבים בלבד.
//
// ⚠️ אין כאן סף שמחליט על **צבע** — הצבעים נקבעים ב-SQL. מה שכאן הוא רק
// "מה נכנס לרשימה": 60 יום לתסקיר ("חודשיים לפני"), 14 יום להמתנה לתסקיר
// נקי, וטיוטה שלא הוגשה — אבני הדרך של D12.
import { COMPLIANCE_AREAS, daysText, draftStale, formatDateIL, todayIL } from "./compliance.js";

const INSPECTION_HORIZON_DAYS = 60;   // "חודשיים לפני"
const AWAIT_CLEAN_DAYS = 14;          // ממתין לתסקיר נקי יותר משבועיים

const dayNum = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

const inDays = (n) => (n === 0 ? "היום" : n === 1 ? "מחר" : `בעוד ${n} ימים`);

/**
 * השורות לרשימה. טהורה — לבדיקות.
 * @returns {{rows: Array<{code,name,tab,sev,text}>, noReport:number, noPm:number, unknown:number}}
 */
export function complianceAlerts(sites, today = todayIL(), nowIso = new Date().toISOString(), areas = COMPLIANCE_AREAS) {
  // תחזוקה כבויה (COMPLIANCE_AREAS) → אין שורות תחזוקה ואין מונה "ללא תחזוקה"
  const withPm = areas.includes("pm");
  const rows = [];
  let noReport = 0;
  let noPm = 0;
  let unknown = 0;
  for (const s of sites || []) {
    const c = s.compliance;
    if (c === undefined || c === null) continue;
    if (c.unknown) { unknown++; continue; }
    const base = { code: s.code, name: s.site_name || s.code };
    const i = c.inspection;
    const p = c.pm;

    // ---- בודק מוסמך ----
    if (i.missing) {
      // לפני תאריך העלייה לאוויר "אין תסקיר" אפור — סופרים אותו (מונה המילוי
      // לאחור), ולא מציפים את הרשימה ב-50 שורות זהות.
      if (i.state === "none") noReport++;
      else rows.push({ ...base, tab: "inspection", sev: 4, text: "אין תסקיר בודק במערכת" });
    } else if (i.validityState === "expired") {
      rows.push({ ...base, tab: "inspection", sev: 4,
        text: `תסקיר פג ${daysText(i.daysLeft) || formatDateIL(i.validUntil)} (${formatDateIL(i.validUntil)}) — לא בתוקף` });
    } else if (i.daysLeft != null && i.daysLeft <= INSPECTION_HORIZON_DAYS) {
      rows.push({ ...base, tab: "inspection", sev: i.daysLeft <= 30 ? 3 : 2,
        text: `תסקיר פג ${inDays(i.daysLeft)} (${formatDateIL(i.validUntil)}) — לזמן בודק` });
    }
    // ⚠️ לפי awaitingSince ולא לפי מחזור האתר: באתר עם שני מתקנים, ליקוי פתוח
    // באחד הופך את מחזור האתר ל-'open' — והמתקן השני, שממתין לתסקיר נקי חודשיים,
    // היה נעלם מהרשימה. ה-SQL ממלא את התאריך רק ממתקנים שממתינים.
    if (i.awaitingSince && dayNum(today) - dayNum(i.awaitingSince) > AWAIT_CLEAN_DAYS) {
      // "כל הליקויים תוקנו" נכון רק כשזה מחזור האתר כולו; אחרת יש מתקן אחר עם ליקוי פתוח
      const whole = i.cycle === "awaiting_clean";
      rows.push({ ...base, tab: "inspection", sev: 3,
        text: `${whole ? "כל הליקויים תוקנו" : "במתקן אחד כל הליקויים תוקנו"} מאז ${formatDateIL(i.awaitingSince)} — ממתין לתסקיר נקי` });
    }
    // sev 4 (אדום) — כמו המנורה: ליקוי שעבר את מועד התיקון צובע אותה אדום (06/10/2026)
    if (i.overdueDefects > 0) {
      rows.push({ ...base, tab: "inspection", sev: 4,
        text: i.overdueDefects === 1 ? "ליקוי אחד עבר את מועד התיקון" : `${i.overdueDefects} ליקויים עברו את מועד התיקון` });
    }

    // ---- תחזוקה מונעת ----
    if (!withPm) continue;
    if (p.missing) {
      if (p.state === "none") noPm++;
      else rows.push({ ...base, tab: "pm", sev: 4, text: "אין תחזוקה מונעת רשומה" });
    } else if (p.state === "expired") {
      rows.push({ ...base, tab: "pm", sev: 4,
        text: `תחזוקה מונעת לא בוצעה — נדרשה עד ${formatDateIL(p.dueOn)}` });
    } else if (p.state === "soon") {
      rows.push({ ...base, tab: "pm", sev: 3,
        text: `תחזוקה מונעת ${inDays(p.daysLeft ?? 0)} (${formatDateIL(p.dueOn)})` });
    }
    if (draftStale(c, nowIso)) {
      rows.push({ ...base, tab: "pm", sev: 2, text: "ביקור תחזוקה נפתח ולא הוגש" });
    }
  }
  rows.sort((a, b) => b.sev - a.sev || a.name.localeCompare(b.name, "he"));
  return { rows, noReport, noPm, unknown };
}
