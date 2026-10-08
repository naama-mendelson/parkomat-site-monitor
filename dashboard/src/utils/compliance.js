// utils/compliance.js — רמזורי "בודק מוסמך" ו"תחזוקה מונעת": תצוגה בלבד.
//
// ============================================================
// ⚠️ אין כאן אף סף, ואין כאן החלטה על מצב
// ============================================================
// צבע המנורה נקבע ב-SQL (`app.compliance_machine_rows`; התוקף ב-`app.compliance_light`),
// במקום אחד, ומשם הוא מגיע לכרטיס, ללשונית ולהתראה. כל מה שכאן **מתרגם** את מה שהשרת החליט
// לטקסט ולסימן. עותק של הסף בצד הלקוח היה נותן יום אחד בשנה שבו הכרטיס
// צהוב וההתראה אומרת "פג" — ושני מקורות אמת שאיש לא יודע מי מהם צודק.
//
// קובץ טהור: בלי React, בלי ייבוא — כדי שאפשר יהיה לבדוק אותו ב-node ישירות.

// ⚠️ שיקוף של `settings.compliance_pdf_max_bytes` (ברירת המחדל במסד).
// השרת הוא הסמכות; כאן זה רק כדי לסרב לפני העלאה של דקה ולא אחריה.
export const COMPLIANCE_PDF_MAX_BYTES = 8 * 1024 * 1024;
export const COMPLIANCE_PDF_WARN_BYTES = 3 * 1024 * 1024;

// טיוטת ביקור שלא נגעו בה 12 שעות — "לא הוגש" על הכרטיס.
export const DRAFT_STALE_MS = 12 * 60 * 60 * 1000;

// ============================================================
// ⚠️ התחזוקה המונעת בנויה — ומוסתרת
// ============================================================
// בעלת המוצר, 06/10/2026: "לדחוף רק את הבודק מוסמך". התחזוקה המונעת שלמה
// ונבדקה (ה-SQL בייצור, הלשונית, הטופס, תיבת היוצאים), אבל אינה מוצגת באתר
// החי עד שיוחלט אחרת. **מקום אחד** מכבה אותה בכל מקום: המנורה בכרטיס, הסימן
// בכרטיס הקטן, הלשונית בחלון האתר, השורות ברשימת המנהלים, המקרא בעזרה,
// והדירוג בטבלת המפקח — כולם קוראים את COMPLIANCE_AREAS.
//
// הפעלה: `VITE_COMPLIANCE_PM=true` בסביבת הבנייה (כמו VITE_FIXFLOW_ENABLED),
// או לשנות את ברירת המחדל כאן ל-"true". ⚠️ בלי משתנה — כבוי: בנייה של
// Cloudflare Pages שאיש לא הגדיר בה דבר חייבת לתת את מה שהוחלט.
// ⚠️ הפונקציות למטה מקבלות `areas` מפורש — כך הבדיקות ממשיכות לבדוק את
// התחזוקה גם כשהיא כבויה. קוד רדום שאינו נבדק נרקב.
export const PM_ENABLED = String(import.meta.env?.VITE_COMPLIANCE_PM ?? "false") === "true";
export const ALL_AREAS = ["inspection", "pm"];
export const COMPLIANCE_AREAS = PM_ENABLED ? ALL_AREAS : ["inspection"];

export const COMPLIANCE_TABS = COMPLIANCE_AREAS;

export const AREA_NAME = { inspection: "בודק מוסמך", pm: "תחזוקה מונעת" };

// ============================================================
// שורת site_compliance → האובייקט שהכרטיס צורך
// ============================================================
// ⚠️ `{unknown:true}` כשאין שורה — לא null ולא אובייקט ריק. מנורה שנעלמת
// בשקט נראית בדיוק כמו "אין מה לדווח" (לקח 17/09); מנורה עם "?" אומרת
// "לא יודעים", וזה מה שצריך לראות.
export function toCompliance(row) {
  if (!row) return { unknown: true };
  const detail = Array.isArray(row.machines_detail) ? row.machines_detail : [];
  return {
    inspection: {
      state: row.inspection_state ?? "none",
      // ⚠️ התוקף הטהור. בלי העמודה (נתון ישן) — המצב, אבל רק אם הוא באמת מצב תוקף: "overdue"
      // אינו תוקף, והתווית הייתה נבנית ממנו ("בודק — לא נטען · עבר מועד תיקון").
      validityState: row.inspection_validity_state ?? (VALIDITY_STATES.has(row.inspection_state) ? row.inspection_state : "none"),
      validUntil: row.inspection_valid_until ?? null,
      daysLeft: row.inspection_days_left ?? null,
      missing: !!row.inspection_missing,
      cycle: row.inspection_cycle ?? "none",
      awaitingSince: row.inspection_awaiting_since ?? null,
      openDefects: row.open_defects ?? 0,
      overdueDefects: row.overdue_defects ?? 0,
      // מועד תיקון בעוד 30 יום או פחות (היום כלול) — מה-SQL, שם הסף
      dueSoonDefects: row.due_soon_defects ?? 0,
      machines: row.machines ?? 0,
      machinesDetail: detail.map((m) => ({
        key: m.key,
        label: m.label ?? null,
        validUntil: m.valid_until ?? null,
        state: m.state ?? "none",
        // התוקף לבדו — המצב (state) נקבע גם מהליקויים ומהמחזור
        validity: m.validity ?? null,
        cycle: m.cycle ?? "none",
        open: m.open ?? 0,
        overdue: m.overdue ?? 0,
        dueSoon: m.due_soon ?? 0,
      })),
    },
    pm: {
      state: row.pm_state ?? "none",
      missing: !!row.pm_missing,
      lastOn: row.pm_last_on ?? null,
      dueOn: row.pm_due_on ?? null,
      daysLeft: row.pm_days_left ?? null,
      draftId: row.pm_draft_id ?? null,
      draftLastActivity: row.pm_draft_last_activity ?? null,
    },
  };
}

// ============================================================
// דרגות ותוויות
// ============================================================
// הסדר של app.light_rank ב-SQL: אדום > כתום > צהוב חזק > צהוב > ירוק > שחור-לבן > אפור.
// ⚠️ unknown מדורג **מעל** ok: "לא יודעים" אינו "בסדר", ובמיון לפי חומרה אתר שהסטטוס
// שלו לא נטען לא צריך להתחבא בין התקינים. ⚠️ ומצב שאינו מוכר כאן מדורג כמו unknown —
// לעולם לא 0: אתר כתום שמוין מתחת לשחור-לבן הוא בדיוק הכשל השקט שהסדר הזה קיים בשבילו.
const SEVERITY = { none: 0, ok: 1, unknown: 2, fixing: 3, soon: 4, awaiting: 5, overdue: 6, expired: 7 };
export const severity = (state) => SEVERITY[state] ?? SEVERITY.unknown;
const VALIDITY_STATES = new Set(["ok", "soon", "expired", "none"]);

// ⚠️ לכל מצב גליף משלו — הצבע לעולם אינו הסימן היחיד (צהוב/כתום/אדום קשים במיוחד לעיוורי
// צבעים). ‼ עם VS15 (U+FE0E): בלעדיו חלק מהטלפונים מציירים אותו כאמוג׳י צבעוני.
export const GLYPH = {
  ok: "✓", fixing: "…", soon: "!", awaiting: "◷", overdue: String.fromCodePoint(0x203c, 0xfe0e),
  expired: "✕", none: "○", unknown: "?",
};

// ⚠️ המילים של בעלת המוצר (06/10/2026): "בתוקף / עומד לפוג עוד חודש / לא בתוקף", ולבודק —
// גם הסיבה כשהמצב בא מהליקויים או מהמחזור. "תוך חודש" = compliance_warn_days (30) ב-SQL —
// הסף שם בלבד; כאן רק השם שלו. ⚠️ בלי "באיחור" בתוויות המנורה (היא החליפה את המילה הזו).
export const LIGHT_LABEL = {
  inspection: {
    ok: "בודק בתוקף",
    fixing: "בודק בתוקף · ליקויים בטיפול",
    soon: "בודק עומד לפוג תוך חודש",
    awaiting: "בודק בתוקף · ממתין לתסקיר נקי",
    overdue: "בודק בתוקף · עבר מועד תיקון",
    expired: "בודק לא בתוקף",
    none: "בודק — אין נתונים",
    unknown: "בודק — לא נטען",
    missing: "אין תסקיר בודק",
  },
  pm: {
    ok: "תחזוקה בתוקף",
    soon: "תחזוקה עומדת לפוג תוך חודש",
    expired: "תחזוקה לא בתוקף",
    none: "תחזוקה — אין נתונים",
    unknown: "תחזוקה — לא נטען",
    missing: "אין תחזוקה מונעת רשומה",
  },
};

/** מצב המנורה של תחום (בודק: אחד משבעת המצבים; תחזוקה: ok/soon/expired/none), או unknown כשלא נטען. */
export function lampState(area, c) {
  if (!c || c.unknown) return "unknown";
  return c[area]?.state ?? "unknown";
}

// ⚠️ המצב של הבודק נקבע גם מהליקויים ומהמחזור, והתוקף (validityState) מגיע בנפרד. תווית
// שנגזרת מהמצב בלבד הייתה כותבת "עומד לפוג" על תסקיר שבתוקף עד השנה הבאה — ושולחת להזמין
// בודק, כשמה שנדרש בפועל הוא לתקן ליקוי או לסגור את המחזור. לכן: התוקף, ואחריו הסיבה.
const CYCLE_REASON = { awaiting_clean: "ממתין לתסקיר נקי", review: "לבדיקה" };
const OVERDUE_REASON = "עבר מועד תיקון";
const DUE_SOON_REASON = "מועד תיקון בעוד פחות מחודש";
const OPEN_REASON = "ליקויים בטיפול";

/**
 * תווית נורת הבודק — של אתר או של מתקן. המצב מה-SQL; כאן רק המילים.
 * @param {string} state — ok/fixing/soon/awaiting/overdue/expired/none
 * @param {string|null} validity — התוקף הטהור (ok/soon/expired/none), או null בנתון ישן
 * @param {string} cycle — מחזור (awaiting_clean / review נותנים את הסיבה של "ממתין")
 * @param {{overdue?: number}} n — ספירות
 */
function inspectionLabel(state, validity, cycle, n = {}) {
  const L = LIGHT_LABEL.inspection;
  // כתום, צהוב חזק וירוק — התסקיר לא פג (ה-SQL), ולכן התוקף הוא "בתוקף" או "עומד לפוג"
  const head = validity === "soon" ? L.soon : L.ok;
  switch (state) {
    case "overdue": return `${head} · ${OVERDUE_REASON}`;
    case "awaiting": return `${head} · ${CYCLE_REASON[cycle] ?? CYCLE_REASON.awaiting_clean}`;
    case "fixing": return `${head} · ${OPEN_REASON}`;
    case "soon":
      if (validity !== "ok") return L.soon;
      // ⚠️ SQL מלפני 06/10/2026 בערב שלח soon גם לליקוי באיחור ולהמתנה לתסקיר נקי. ב-SQL הנוכחי
      // soon על תסקיר בתוקף בא רק ממועד תיקון קרוב — אבל בדקות שבין הדחיפה להחלת ה-SQL, הסיבות
      // הישנות עדיין מגיעות, ותווית "מועד תיקון בעוד פחות מחודש" על ליקוי שכבר באיחור הייתה שקר.
      if (n.overdue > 0) return `${L.ok} · ${OVERDUE_REASON}`;
      if (CYCLE_REASON[cycle]) return `${L.ok} · ${CYCLE_REASON[cycle]}`;
      return `${L.ok} · ${DUE_SOON_REASON}`;
    default: return L[state] ?? L.unknown;
  }
}

/**
 * התווית של מנורת בודק של **מתקן** — בפירוט האתר ובעמוד הבודק.
 * מקבל גם את צורת site_compliance (`validity`) וגם את צורת inspection_site (`validity_state`).
 */
export function machineLampLabel(m) {
  if (!m) return LIGHT_LABEL.inspection.unknown;
  return inspectionLabel(m.state, m.validity ?? m.validity_state ?? null, m.cycle, { overdue: m.overdue });
}

/** התווית שמופיעה ליד המנורה בצפיפות רגילה/מורחבת. */
export function stateLabel(area, c) {
  const labels = LIGHT_LABEL[area];
  if (!labels) return "";
  if (!c || c.unknown) return labels.unknown;
  const a = c[area];
  if (!a) return labels.unknown;
  if (a.missing && a.state !== "none") return labels.missing;
  if (area === "inspection") {
    // ⚠️ מחזור האתר הוא הגרוע מבין המתקנים (open > awaiting_clean). באתר שבו מתקן אחד בטיפול
    // והשני ממתין לתסקיר נקי, הסיבה של "ממתין" יושבת במתקן שהמצב שלו הוא מצב האתר.
    const m = (a.machinesDetail || []).find((x) => x.state === a.state);
    const cycle = CYCLE_REASON[a.cycle] ? a.cycle : m?.cycle;
    return inspectionLabel(a.state, a.validityState ?? null, cycle, { overdue: a.overdueDefects });
  }
  return labels[a.state] ?? labels.unknown;
}

/**
 * האם מתקן כלשהו באתר ממתין לתסקיר נקי.
 * ⚠️ לפי `awaitingSince` ולא לפי מחזור האתר: ה-SQL ממלא אותו רק ממתקנים
 * שממתינים, ומחזור האתר הוא הגרוע — 'open' מסתיר מתקן שני שממתין.
 */
export const isAwaiting = (a) => !!a && (a.cycle === "awaiting_clean" || !!a.awaitingSince);
const anyReview = (a) => !!a && (a.cycle === "review" || (a.machinesDetail || []).some((m) => m.cycle === "review"));

// ============================================================
// תאריכים — לתצוגה בלבד; השרת הוא הסמכות
// ============================================================
// ⚠️ פירוק מחרוזת ולא new Date("2026-11-11"): זה מתפרש כחצות UTC, ובישראל
// בערב שלפני — כלומר "תוקף עד 10/11" על מסמך שכתוב בו 11/11.
export function formatDateIL(iso) {
  if (!iso || typeof iso !== "string") return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return "";
  return `${d}/${m}/${y}`;
}

export function formatDayMonth(iso) {
  if (!iso || typeof iso !== "string") return "";
  const [, m, d] = iso.slice(0, 10).split("-");
  return m && d ? `${d}/${m}` : "";
}

// חותמת זמן מלאה (ISO-UTC) → "DD/MM HH:MM" בשעון ישראל.
export function formatStampIL(isoStamp) {
  const t = Date.parse(isoStamp);
  if (!Number.isFinite(t)) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(t)).map((p) => [p.type, p.value]),
  );
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}

/** היום בישראל, "YYYY-MM-DD". ⚠️ לא toISOString — בין 00:00 ל-03:00 זה עדיין אתמול ב-UTC. */
export function todayIL(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(now);
}

const parseISO = (iso) => iso.slice(0, 10).split("-").map(Number);
const fmtUTC = (t) => new Date(t).toISOString().slice(0, 10);

export function addDaysISO(iso, n) {
  const [y, m, d] = parseISO(iso);
  return fmtUTC(Date.UTC(y, m - 1, d + n));
}

/** כמו Postgres: 31/08 + 6 חודשים = 28/02 (נצמד לסוף החודש, לא גולש למרץ). */
export function addMonthsISO(iso, n) {
  const [y, m, d] = parseISO(iso);
  const target = Date.UTC(y, m - 1 + n, 1);
  const ty = new Date(target).getUTCFullYear();
  const tm = new Date(target).getUTCMonth();
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fmtUTC(Date.UTC(ty, tm, Math.min(d, lastDay)));
}

/** ימים יחסיים: "עוד 12 ימים" / "היום" / "לפני 3 ימים". */
export function daysText(n) {
  if (n == null || !Number.isFinite(n)) return "";
  if (n === 0) return "היום";
  if (n === 1) return "מחר";
  if (n === -1) return "אתמול";
  return n > 0 ? `עוד ${n} ימים` : `לפני ${-n} ימים`;
}

/** טיוטת ביקור שלא נגעו בה יותר מ-12 שעות. */
export function draftStale(c, nowIso = new Date().toISOString()) {
  const pm = c && !c.unknown ? c.pm : null;
  if (!pm?.draftId || !pm.draftLastActivity) return false;
  const last = Date.parse(pm.draftLastActivity);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return false;
  return now - last > DRAFT_STALE_MS;
}

// ============================================================
// הסימן היחיד בצפיפות mini
// ============================================================
// בכרטיס mini אין מקום לשתי מנורות, ולכן מוצג הגרוע מבין השתיים — והקשה
// עליו פותחת את הלשונית של הגרוע. בתיקו — הבודק: הוא החוקי מבין השניים.
// ⚠️ גם הבודק משתתף רק אם הוא מוצג: מאז שהבורר בכותרת יכול להסתיר כל נורה (08/10/2026),
// סימן של בודק בכרטיס שבו הנורה שלו הוסתרה היה מחזיר בדלת האחורית את מה שביקשו להסתיר.
export function markFor(c, areas = COMPLIANCE_AREAS) {
  if (c === undefined || areas.length === 0) return null;
  if (!c || c.unknown) return { state: "unknown", tab: areas.includes("inspection") ? "inspection" : areas[0], stale: false };
  const i = lampState("inspection", c);
  // תחזוקה כבויה → אינה משתתפת. אחרת אדום של תחזוקה היה מופיע בכרטיס הקטן
  // כסימן של בודק, ולחיצה עליו הייתה פותחת לשונית שאינה קיימת.
  const p = areas.includes("pm") ? lampState("pm", c) : "none";
  const worse = !areas.includes("inspection") || severity(p) > severity(i) ? "pm" : "inspection";
  return { state: worse === "pm" ? p : i, tab: worse, stale: !!c.stale };
}

/** החמור מבין המנורות המוצגות — לטבלת המפקח. */
export function worstSeverity(c, areas = COMPLIANCE_AREAS) {
  if (c === undefined) return 0;
  return Math.max(...areas.map((a) => severity(lampState(a, c))));
}

// ============================================================
// "בודק מוסמך" בסינון שבכותרת (08/10/2026; היה סרגל בצד הלוח באותו יום)
// ============================================================
// בעלת המוצר: "סרגל בצד של סינון שיציג רק אתרים פגים או אתרים נקיים וכו'", ואחר כך: "תהיה אופציה
// בצד לסמן האם רוצים לראות בודק מוסמך, האם רוצים לראות תחזוקה מונעת. תחת כל סימון כזה יפתח
// תפריט" של המצבים. ובתשובות שלה: כל המצבים מופיעים תמיד (גם 0), והסימון של התחום קובע גם אם
// הנורה שלו מופיעה בכרטיסים. ⚠️ והבחירה — "בדיוק כמו בכותרת" (אחרי שראתה תיבות סימון שכולן
// מסומנות): "הכל" מודגש בהתחלה, לחיצה על מצב מציגה רק אותו, אפשר כמה, ו"הכל" מנקה.
// ⚠️ ואז: "אני רוצה שבודק מוסמך יופיע בסינון ב-HEADER" — והנורה בכרטיס "מופיעה רק כשמסמנים". ולבסוף,
// במקום סרגל: "כשלוחצים על בודק מוסמך יפתח תפריט מתחת, ואז יצטרכו לבחור מה רואים, ואז זה יסגר".
// כלומר בברירת המחדל התחום **כבוי**: בלי סינון, ובלי הנורה שלו בכרטיסי הלוח. זה שינוי מכוון מהמצב
// שבו הנורה הופיעה תמיד.
// ⚠️ "אין נתונים" ו"לא נטען" אינם שורות — בעלת המוצר, 08/10/2026: "תעיף את זה, זה לא קיים".
// אין נתונים = אין תסקיר לפני תאריך העלייה לאוויר, והוא כבר נקבע (06/10); לא נטען = תקלת רשת
// בדפדפן, לא מצב של אתר. אתר במצב כזה מוצג תחת "הכל" בלבד — אי אפשר לבחור בו.
// ⚠️ גם כאן אין סף: המפתח הוא מצב המנורה מה-SQL, ו"אין תסקיר" נפרד מ"לא בתוקף" באותו
// כלל שבו stateLabel מפריד ביניהם — כך אפשרות בבורר אומרת בדיוק מה שהכרטיס אומר. סרגל
// שמונה "פג" באתר שכתוב עליו "אין תסקיר בודק" היה סותר את הכרטיס שלידו.
// הסדר — מהחמור לקל, כמו SEVERITY. `swatch` = המנורה שמצוירת בשורה.
export const COMPLIANCE_FILTER_ROWS = {
  inspection: [
    { key: "expired", swatch: "expired", label: "לא בתוקף" },
    { key: "missing", swatch: "expired", label: "אין תסקיר" },
    { key: "overdue", swatch: "overdue", label: "עבר מועד תיקון" },
    { key: "awaiting", swatch: "awaiting", label: "ממתין לתסקיר נקי" },
    { key: "soon", swatch: "soon", label: "עומד לפוג תוך חודש",
      title: "התסקיר פג בעוד פחות מחודש, או שמועד התיקון של ליקוי בעוד פחות מחודש" },
    { key: "fixing", swatch: "fixing", label: "ליקויים בטיפול" },
    { key: "ok", swatch: "ok", label: "בתוקף" },
  ],
  pm: [
    { key: "expired", swatch: "expired", label: "לא בתוקף" },
    { key: "missing", swatch: "expired", label: "אין תחזוקה רשומה" },
    { key: "soon", swatch: "soon", label: "עומדת לפוג תוך חודש" },
    { key: "ok", swatch: "ok", label: "בתוקף" },
  ],
};

// ============================================================
// מצב הבורר: לכל תחום — האם נבחר בו משהו (הנורה), ואיזה מצב
// ============================================================
// `show` — סומן בכותרת (ברירת מחדל: לא). `only` ריק = "הכל", כמו activeFilters של מוני המצב בכותרת.
export const DEFAULT_COMPLIANCE_VIEW = Object.freeze({
  inspection: Object.freeze({ show: false, only: Object.freeze([]) }),
  pm: Object.freeze({ show: false, only: Object.freeze([]) }),
});

// המצבים שיש להם אפשרות בבורר, לכל תחום
const LISTED = Object.fromEntries(
  Object.entries(COMPLIANCE_FILTER_ROWS).map(([area, rows]) => [area, new Set(rows.map((r) => r.key))]),
);

/**
 * לאיזו אפשרות בבורר האתר שייך בתחום הזה. אותו כלל כמו stateLabel: missing גובר, חוץ מ-none.
 * "none" ו-"unknown" — אתר שאין לו שורה. ⚠️ מצב שאינו מוכר כאן → "unknown", כמו שהוא מדורג
 * (severity) ומצויר ("?") — ולא מפתח חדש ששום שורה אינה סופרת.
 */
export function complianceFilterKey(area, c) {
  const state = lampState(area, c);
  const key = state !== "unknown" && c[area]?.missing && state !== "none" ? "missing" : state;
  return LISTED[area]?.has(key) || key === "none" ? key : "unknown";
}

// ⚠️ רק true מפורש: תחום שלא סומן בכותרת — כבוי, גם כשהמצב חסר או חלקי
const shown = (view, area) => view?.[area]?.show === true;

/** התחומים שנבחר בהם משהו בכותרת — הנורה שלהם מוצגת בכרטיסי הלוח. מתוך COMPLIANCE_AREAS. */
export function lampAreasFor(view, areas = COMPLIANCE_AREAS) {
  return areas.filter((a) => shown(view, a));
}

/**
 * האם האתר עובר את הבורר: בכל תחום מוצג שנבחרו בו מצבים, המצב של האתר הוא אחד מהם. בתוך תחום —
 * "או"; בין תחומים — "וגם", כמו מצב × סוג בכותרת. תחום שלא מסומן אינו מסנן בכלל — "לא רוצה
 * לראות בודק" אינו "תסתיר את כל האתרים".
 * ⚠️ אתר בלי שורה ("אין נתונים", "לא נטען") אינו אף אחד מהמצבים, ולכן מופיע רק תחת "הכל".
 * ⚠️ תחום כבוי (PM_ENABLED) אינו מסנן גם אם נשארה בו בחירה — אחרת אתרים היו נעלמים בגלל
 * אריח שאינו מוצג, ואין איך לבטל אותו.
 */
export function matchesComplianceView(site, view, areas = COMPLIANCE_AREAS) {
  for (const area of areas) {
    const only = view?.[area]?.only;
    if (!shown(view, area) || !(only?.length > 0)) continue;
    if (!only.includes(complianceFilterKey(area, site?.compliance))) return false;
  }
  return true;
}

/** כמה אתרים בכל שורה. אתר בלי שורה ("אין נתונים", "לא נטען") אינו נספר באף אחת. */
export function complianceFilterCounts(sites, areas = COMPLIANCE_AREAS) {
  const counts = {};
  for (const area of areas) {
    counts[area] = Object.fromEntries(COMPLIANCE_FILTER_ROWS[area].map((r) => [r.key, 0]));
    for (const site of sites || []) {
      const key = complianceFilterKey(area, site?.compliance);
      if (key in counts[area]) counts[area][key]++;
    }
  }
  return counts;
}

/** כמה מסננים פעילים — ל"סינון ותצוגה · N פעילים" בכותרת: תחום שנבחר בו משהו נספר פעם אחת, כמו כל בורר. */
export function complianceActiveCount(view, areas = COMPLIANCE_AREAS) {
  return areas.filter((a) => shown(view, a)).length;
}

/** האם סימן ה-mini מצויר בכלל: רק כשצריך לעשות משהו — צהוב, צהוב חזק, כתום, אדום או "?". */
const MARKED = new Set(["soon", "awaiting", "overdue", "expired", "unknown"]);
export const markVisible = (m) => !!m && MARKED.has(m.state);

// ============================================================
// חלונית הריחוף (title) — המשפט המלא שמאחורי המנורה
// ============================================================
function worstMachine(detail) {
  let worst = null;
  for (const m of detail || []) {
    if (!worst || severity(m.state) > severity(worst.state)) worst = m;
  }
  return worst;
}

// "· 2 באיחור · 1 לתיקון תוך חודש" — בחלונית הריחוף ובתווית הנגישה (לא בתווית המנורה)
function defectCounts(a, sep) {
  const parts = [];
  if (a.overdueDefects > 0) parts.push(`${a.overdueDefects} באיחור`);
  if (a.dueSoonDefects > 0) parts.push(`${a.dueSoonDefects} לתיקון תוך חודש`);
  return parts.length ? sep + parts.join(sep) : "";
}

function validityLine(a) {
  const until = formatDateIL(a.validUntil);
  const days = a.daysLeft;
  switch (a.validityState) {
    case "ok":
      return `בתוקף עד ${until}${days != null ? ` · ${daysText(days)}` : ""}`;
    case "soon":
      if (days == null) return `עומד לפוג תוך חודש (${until})`;
      return `עומד לפוג ${days === 0 ? "היום" : days === 1 ? "מחר" : `בעוד ${days} ימים`} (${until})`;
    case "expired":
      return days != null ? `לא בתוקף — פג ${daysText(days)} (${until})` : `לא בתוקף (${until})`;
    default:
      return "";
  }
}

export function lightTitle(area, c, nowIso = new Date().toISOString()) {
  if (!c || c.unknown) {
    const what = PM_ENABLED ? "סטטוס בודק/תחזוקה" : "סטטוס הבודק";
    return c?.error ? `${what} לא נטען: ${c.error}` : `${what} לא נטען`;
  }
  const lines = [];

  if (area === "inspection") {
    const a = c.inspection || {};
    if (!a.validUntil && a.missing) {
      lines.push(a.state === "none" ? "בודק מוסמך: אין תסקיר במערכת" : "בודק מוסמך: אין תסקיר במערכת — נדרש");
    } else {
      lines.push(`בודק מוסמך: ${validityLine(a)}`);
    }
    if (isAwaiting(a)) {
      lines.push(a.awaitingSince ? `ממתין לתסקיר נקי מאז ${formatDayMonth(a.awaitingSince)}` : "ממתין לתסקיר נקי");
    }
    if (anyReview(a)) {
      lines.push("אין ליקויים פתוחים, אבל התסקיר לא סומן נקי — לבדוק");
    }
    if (a.openDefects > 0) lines.push(`${a.openDefects} ליקויים פתוחים${defectCounts(a, " · ")}`);
    if (a.machines > 1) {
      const w = worstMachine(a.machinesDetail);
      const name = w ? (w.label || `מתקן ${w.key}`) : "";
      lines.push(`${a.machines} מתקנים${w ? ` — הגרוע: ${name} (${machineLampLabel(w)})` : ""}`);
    }
  } else if (area === "pm") {
    const a = c.pm || {};
    if (!a.lastOn && a.missing) {
      lines.push(a.state === "none" ? "תחזוקה מונעת: אין ביקור רשום" : "תחזוקה מונעת: אין ביקור רשום — נדרש");
    } else {
      const last = formatDateIL(a.lastOn);
      const due = formatDateIL(a.dueOn);
      if (a.state === "expired") {
        lines.push(`תחזוקה מונעת: לא בתוקף — נדרשה עד ${due}${a.daysLeft != null ? ` (${daysText(a.daysLeft)})` : ""}`);
      } else if (a.state === "soon") {
        lines.push(`תחזוקה מונעת: עומדת לפוג — הבאה עד ${due}${a.daysLeft != null ? ` (${daysText(a.daysLeft)})` : ""} · בוצעה ${last}`);
      } else {
        lines.push(`תחזוקה מונעת: בוצעה ${last} · הבאה עד ${due}${a.daysLeft != null ? ` (${daysText(a.daysLeft)})` : ""}`);
      }
    }
    if (a.draftId) {
      const when = formatStampIL(a.draftLastActivity);
      lines.push(draftStale(c, nowIso)
        ? `תחזוקה מונעת: ביקור בתהליך לא הוגש (עודכן ${when})`
        : `ביקור בתהליך (עודכן ${when})`);
    }
  }

  if (c.stale) lines.push("סטטוס לא עודכן — מוצג המצב האחרון הידוע");
  return lines.join("\n");
}

/** התווית הנגישה (aria-label): קצרה מה-title, אבל עם כל מה שהעין רואה. */
export function lightAria(area, c, nowIso = new Date().toISOString()) {
  const parts = [stateLabel(area, c)];
  if (c && !c.unknown) {
    if (area === "inspection") {
      const a = c.inspection || {};
      // התווית כבר נושאת את הסיבה כשהצהוב נובע מהמחזור — לא פעמיים
      if (isAwaiting(a) && !parts[0].includes(CYCLE_REASON.awaiting_clean)) parts.push(CYCLE_REASON.awaiting_clean);
      if (a.openDefects > 0) parts.push(`${a.openDefects} ליקויים פתוחים${defectCounts(a, ", ")}`);
    } else if (area === "pm" && draftStale(c, nowIso)) {
      parts.push("ביקור לא הוגש");
    }
    if (c.stale) parts.push("סטטוס לא עודכן");
  }
  return parts.join(" · ");
}
