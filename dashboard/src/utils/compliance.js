// utils/compliance.js — רמזורי "בודק מוסמך" ו"תחזוקה מונעת": תצוגה בלבד.
//
// ============================================================
// ⚠️ אין כאן אף סף, ואין כאן החלטה על מצב
// ============================================================
// ירוק/צהוב/אדום נקבע ב-SQL (`app.compliance_light`), במקום אחד, ומשם הוא
// מגיע לכרטיס, ללשונית ולהתראה. כל מה שכאן **מתרגם** את מה שהשרת החליט
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
      validityState: row.inspection_validity_state ?? row.inspection_state ?? "none",
      validUntil: row.inspection_valid_until ?? null,
      daysLeft: row.inspection_days_left ?? null,
      missing: !!row.inspection_missing,
      cycle: row.inspection_cycle ?? "none",
      awaitingSince: row.inspection_awaiting_since ?? null,
      openDefects: row.open_defects ?? 0,
      overdueDefects: row.overdue_defects ?? 0,
      machines: row.machines ?? 0,
      machinesDetail: detail.map((m) => ({
        key: m.key,
        label: m.label ?? null,
        validUntil: m.valid_until ?? null,
        state: m.state ?? "none",
        // התוקף לבדו — הנורה (state) עולה מעליו בליקוי באיחור או בהמתנה לתסקיר נקי
        validity: m.validity ?? null,
        cycle: m.cycle ?? "none",
        open: m.open ?? 0,
        overdue: m.overdue ?? 0,
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
// ⚠️ unknown מדורג **מעל** ok: "לא יודעים" אינו "בסדר", ובמיון לפי חומרה
// אתר שהסטטוס שלו לא נטען לא צריך להתחבא בין הירוקים.
const SEVERITY = { none: 0, ok: 1, unknown: 2, soon: 3, expired: 4 };
export const severity = (state) => SEVERITY[state] ?? 0;

export const GLYPH = { ok: "✓", soon: "!", expired: "✕", none: "○", unknown: "?" };

// ⚠️ רמזור, במילים של בעלת המוצר (06/10/2026): "בתוקף / עומד לפוג עוד חודש /
// לא בתוקף — ירוק תקין, צהוב צריך להתכונן לתחזוקה או לזמן בודק, אדום לא תקין".
// אותן שלוש מילים לשני התחומים. "תוך חודש" = compliance_warn_days (30) ב-SQL —
// הסף שם בלבד; כאן רק השם שלו.
export const LIGHT_LABEL = {
  inspection: {
    ok: "בודק בתוקף",
    soon: "בודק עומד לפוג תוך חודש",
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

/** מצב המנורה של תחום: ok/soon/expired/none, או unknown כשהסטטוס לא נטען. */
export function lampState(area, c) {
  if (!c || c.unknown) return "unknown";
  return c[area]?.state ?? "unknown";
}

// ⚠️ המנורה של הבודק עולה לצהוב גם כשהתסקיר **בתוקף** — כשהמחזור ממתין
// לתסקיר נקי או לבדיקה (D10 ב-SQL). התוקף האמיתי מגיע בנפרד
// (validityState). תווית שנגזרת מצבע המנורה בלבד הייתה כותבת "בודק עומד
// לפוג" על אתר שבתוקף עד השנה הבאה — ושולחת להזמין בודק, כשמה שנדרש
// בפועל הוא לסגור את המחזור.
const CYCLE_REASON = { awaiting_clean: "ממתין לתסקיר נקי", review: "לבדיקה" };

// ⚠️ והמנורה עולה לצהוב כשליקוי עבר את מועד התיקון והתסקיר בתוקף (בעלת המוצר,
// 06/10/2026: "זה צריך להיות צהוב כיון שהמסמך בתוקף אבל הליקויים לא טופלו" — מחליף את
// האדום שנבחר באותו בוקר; ההחלטה ב-SQL). בלי הסיבה הזו התווית הייתה כותבת "עומד לפוג"
// על תסקיר שבתוקף עד השנה הבאה — ושולחת לזמן בודק, כשמה שנדרש הוא לתקן את הליקוי.
// ⚠️ לא "באיחור": בעלת המוצר החליפה את המילה הזו בתוויות המנורה (06/10/2026).
const OVERDUE_REASON = "עבר מועד תיקון";

/**
 * התווית של מנורת בודק של **מתקן** — בפירוט האתר ובעמוד הבודק.
 * מקבל גם את צורת site_compliance (`validity`) וגם את צורת inspection_site (`validity_state`).
 * בלי תוקף נפרד (נתון ישן) — לפי הצבע בלבד, כמו קודם.
 */
export function machineLampLabel(m) {
  if (!m) return LIGHT_LABEL.inspection.unknown;
  const validity = m.validity ?? m.validity_state ?? null;
  if (m.overdue > 0 && validity && validity !== "expired") {
    return `${LIGHT_LABEL.inspection[validity] ?? LIGHT_LABEL.inspection.unknown} · ${OVERDUE_REASON}`;
  }
  if (m.state === "soon" && CYCLE_REASON[m.cycle]) return `נדרשת בדיקה חוזרת — ${CYCLE_REASON[m.cycle]}`;
  return LIGHT_LABEL.inspection[m.state] ?? m.state;
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
    const validity = a.validityState ?? a.state;
    // ליקוי שעבר את מועד התיקון — הסיבה הראשונה, כי הפעולה היא לתקן ולא לזמן בודק
    if (a.validityState && a.validityState !== "expired" && a.overdueDefects > 0) {
      return `${labels[validity] ?? labels.unknown} · ${OVERDUE_REASON}`;
    }
    // ⚠️ כשהמנורה גבוהה מהתוקף, הצהוב בא ממחזור — **תמיד**, גם כשמחזור האתר
    // הוא 'open'. מחזור האתר הוא הגרוע מבין המתקנים (open > awaiting_clean),
    // ולכן באתר עם ליקוי פתוח במתקן אחד ובדיקה חוזרת חסרה בשני, הסיבה יושבת
    // במתקן ולא באתר — והנפילה ל-labels[a.state] הייתה כותבת "עומד לפוג".
    if (validity !== a.state) {
      const m = (a.machinesDetail || []).find((x) => x.state === a.state && CYCLE_REASON[x.cycle]);
      const reason = CYCLE_REASON[a.cycle] ?? CYCLE_REASON[m?.cycle] ?? "נדרשת בדיקה חוזרת";
      return `${labels[validity] ?? labels.unknown} · ${reason}`;
    }
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
export function markFor(c, areas = COMPLIANCE_AREAS) {
  if (c === undefined) return null;
  if (!c || c.unknown) return { state: "unknown", tab: "inspection", stale: false };
  const i = lampState("inspection", c);
  // תחזוקה כבויה → אינה משתתפת. אחרת אדום של תחזוקה היה מופיע בכרטיס הקטן
  // כסימן של בודק, ולחיצה עליו הייתה פותחת לשונית שאינה קיימת.
  const p = areas.includes("pm") ? lampState("pm", c) : "none";
  const worse = severity(p) > severity(i) ? "pm" : "inspection";
  return { state: worse === "pm" ? p : i, tab: worse, stale: !!c.stale };
}

/** החמור מבין המנורות המוצגות — לטבלת המפקח. */
export function worstSeverity(c, areas = COMPLIANCE_AREAS) {
  if (c === undefined) return 0;
  return Math.max(...areas.map((a) => severity(lampState(a, c))));
}

/** האם סימן ה-mini מצויר בכלל: רק כשיש מה לראות — צהוב, אדום או "?". */
export const markVisible = (m) => !!m && (m.state === "soon" || m.state === "expired" || m.state === "unknown");

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
    if (a.openDefects > 0) {
      lines.push(`${a.openDefects} ליקויים פתוחים${a.overdueDefects > 0 ? ` · ${a.overdueDefects} באיחור` : ""}`);
    }
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
      if (a.openDefects > 0) parts.push(`${a.openDefects} ליקויים פתוחים${a.overdueDefects > 0 ? `, ${a.overdueDefects} באיחור` : ""}`);
    } else if (area === "pm" && draftStale(c, nowIso)) {
      parts.push("ביקור לא הוגש");
    }
    if (c.stale) parts.push("סטטוס לא עודכן");
  }
  return parts.join(" · ");
}
