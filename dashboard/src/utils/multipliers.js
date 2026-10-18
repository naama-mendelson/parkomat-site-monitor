// utils/multipliers.js — אתרים מלוח המכפילים שברמזור: מצב השורה והקוד הזמני הבא (15/10/2026).
//
// הלוח "מכפילים" (traffic_light board='multipliers') מחזיק שם אתר ב"אתר" ואת הקוד ב"קוד אתר" (עמודה שנזרעה
// ב-traffic-light.postgres.sql). site_service_links מחברת לפי "קוד אתר" = sites.code, ולכן כל מה שכאן עובד על
// אותן תוויות. ⚠️ הכלל של nextMxCode זהה ל-tools/create-multiplier-sites.js: MX- ושלוש ספרות — לא ספרות בלבד,
// כדי שקוד זמני לא ייראה כקוד פרויקט.
export const MX_CODE_LABEL = "קוד אתר";
export const MX_NAME_LABEL = "אתר";
const MX_RE = /^MX-(\d{3,})$/;

/** הקוד הזמני הפנוי הבא: אחרי הגבוה שבשימוש (באתרים ובקודים שנוצרו זה עתה) — MX-001 כשאין. */
export function nextMxCode(usedCodes) {
  let max = 0;
  for (const c of usedCodes ?? []) { const m = MX_RE.exec(String(c ?? "").trim()); if (m) max = Math.max(max, Number(m[1])); }
  return `MX-${String(max + 1).padStart(3, "0")}`;
}

/**
 * מצב שורה בלוח מול האתרים: exists (הקוד בתא הוא אתר) / missing (יש שם, ואין אתר לקוד — או שאין קוד) /
 * noname (אין שם — אין ממה ליצור) / loading (קודי האתרים עוד לא נטענו).
 * @param {{cells?: object}} row  @param {string} codeKey  @param {string} nameKey
 * @param {Map<string,{site_name:string, monitored:boolean}>|null} siteCodes
 */
export function mxRowState(row, codeKey, nameKey, siteCodes) {
  const code = String(row?.cells?.[codeKey] ?? "").trim();
  const name = String(row?.cells?.[nameKey] ?? "").trim();
  if (!siteCodes) return { state: "loading", code, name };
  const s = code ? siteCodes.get(code) : null;
  if (s) return { state: "exists", code, name, title: `${s.site_name}${s.monitored ? "" : " · ללא בקר מחובר"}` };
  if (!name) return { state: "noname", code, name };
  return { state: "missing", code, name };
}

// ============================================================
// "מכפילים" בלוח — מוצגים או מוסתרים (בעלת המוצר, 18/10/2026: "כפתור סינון נוסף האם המכפילים מופיעים או לא")
// ============================================================
// "מכפיל" בלוח = אתר בלי בקר מחובר (sites.monitored = false): כל 128 אתרי לוח המכפילים, וגם מתקני סוטפין
// שנרשמו כך. הם מופיעים בכרטיסים (בודק, תחזוקה, משימות, קריאות), אבל מי שמנטר בקרים רואה 128 כרטיסים "ללא בקר"
// בין 78 אתרים חיים. הבחירה נזכרת לכל מכשיר (hooks/useShowMultipliers.js), כמו "בודק מוסמך".
// ⚠️ ברירת המחדל — מוצגים: מסך שלא בחר דבר מראה את כל האתרים, כמו עד היום.
export const isMultiplierSite = (site) => site?.monitored === false;
export const countMultipliers = (sites) => (sites ?? []).filter(isMultiplierSite).length;
/** האם האתר עובר את המסנן: מוצגים → תמיד; מוסתרים → רק אתר עם בקר */
export const matchesMultipliersView = (site, shown) => shown !== false || !isMultiplierSite(site);
/** מה שנקרא מהאחסון: רק false מסתיר; כל דבר אחר (חסר, שבור, "true") = מוצגים */
export const sanitizeShowMultipliers = (raw) => raw !== false && raw !== "false";
