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
// בין 78 אתרים חיים. הבחירה נזכרת לכל מכשיר (hooks/useSiteKind.js), כמו "בודק מוסמך".
export const isMultiplierSite = (site) => site?.monitored === false;
export const countMultipliers = (sites) => (sites ?? []).filter(isMultiplierSite).length;
export const countRobotic = (sites) => (sites ?? []).filter((s) => !isMultiplierSite(s)).length;

// ============================================================
// "רובוטיים" / "מכפילים" — בורר של שניים, תמיד אחד פעיל (19/10/2026)
// ============================================================
// בעלת המוצר: "תוסיף סינון רובוטיים וזה נמצא אוטומטית. אם לוחצים על מכפילים — רואים רק מכפילים; אם מסירים מכפילים —
// הרובוטיים חוזרים; אם לוחצים על רובוטיים ומכפילים קיים — מכפילים נעלמים ורק רובוטיים נשאר". עד אז (18/10) מתג אחד,
// "מכפילים גלויים", שהוסיף את המכפילים **לצד** הרובוטיים; מצב "שניהם יחד" כבר אינו קיים.
//   • ברירת המחדל — רובוטיים (אתר עם בקר).
//   • לחיצה על "מכפילים" — רק מכפילים; לחיצה שנייה עליו — חזרה לרובוטיים. לחיצה על "רובוטיים" — תמיד רובוטיים.
export const SITE_KIND_ROBOTIC = "robotic";
export const SITE_KIND_MULTIPLIERS = "multipliers";
export const DEFAULT_SITE_KIND = SITE_KIND_ROBOTIC;
/** מה שנקרא מהאחסון: רק "multipliers" מחליף; כל השאר (חסר, שבור, ערך של המתג הישן) = רובוטיים */
export const sanitizeSiteKind = (raw) => (raw === SITE_KIND_MULTIPLIERS ? SITE_KIND_MULTIPLIERS : SITE_KIND_ROBOTIC);
/** האם האתר בלוח לפי הבחירה */
export const matchesSiteKind = (site, kind) => (sanitizeSiteKind(kind) === SITE_KIND_MULTIPLIERS) === isMultiplierSite(site);
/** הבחירה אחרי לחיצה על אריח */
export const nextSiteKind = (current, clicked) =>
  (clicked === SITE_KIND_MULTIPLIERS && sanitizeSiteKind(current) === SITE_KIND_MULTIPLIERS ? SITE_KIND_ROBOTIC : sanitizeSiteKind(clicked));
