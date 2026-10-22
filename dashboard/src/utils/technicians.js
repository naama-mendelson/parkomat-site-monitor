// utils/technicians.js — לוח טכנאי השטח (20/10/2026): מה הלוח מציג ואילו כפתורים יש. פונקציות טהורות; נבדקות ב-
// master/tests/technicians-ui.test.js.
//
// ⚠️ ההחלטות — ב-SQL (master/db/technicians.postgres.sql): המצב של היום ("לא התחיל יום" אחרי חצות, חופש שנמשך), מה מותר
// בזמן שליחה, גבולות השעה בדיעבד. כאן רק תרגום, וההצעה מה ללחוץ. כפתור שמוצג בטעות נדחה במסד עם הודעה בעברית.

import { clockText, durationLabel, nearText, placeText, powerAlert, stateOf, stateText, vehicleName } from "./vehicles.js";
import { looseText, searchSites } from "./siteSearch.js";

/**
 * שמונת המצבים של הרכז, בסדר שלו. ⚠️ אותה רשימה ב-app.tech_statuses() ובשני אילוצים במסד — technicians.test.js משווה.
 */
export const TECH_STATUSES = ["free", "en_route", "on_site", "feedback", "break", "evening", "vacation", "day_done"];

/** label = על הכרטיס; plural = בשורת הסיכום ("3 פנויים"); tone = הצבע. */
export const TECH_STATUS = {
  free:     { label: "פנוי", plural: "פנויים", tone: "free" },
  en_route: { label: "בדרך לאתר", plural: "בדרך", tone: "route" },
  on_site:  { label: "באתר", plural: "באתר", tone: "site" },
  feedback: { label: "עובד במשוב", plural: "במשוב", tone: "feedback" },
  break:    { label: "בהפסקה", plural: "בהפסקה", tone: "break" },
  evening:  { label: "עובד ערב", plural: "ערב", tone: "evening" },
  vacation: { label: "בחופש", plural: "בחופש", tone: "off" },
  day_done: { label: "סיים יום", plural: "סיימו יום", tone: "off" },
};
/** בלי מצב היום: עוד לא היה, או שהוא מיום קודם (ה-SQL מחזיר status_today = null). */
export const NOT_STARTED = { label: "לא התחיל יום", plural: "לא התחילו יום", tone: "none" };

/** כפתורי המצב, במילים הקצרות של הרכז. "בדרך לאתר" ו"באתר" אינם כאן — הם באים מהשליחה. */
export const STATUS_BUTTONS = [
  { status: "free", label: "פנוי" },
  { status: "feedback", label: "משוב" },
  { status: "break", label: "הפסקה" },
  { status: "evening", label: "ערב" },
  { status: "vacation", label: "חופש" },
  { status: "day_done", label: "סיים יום" },
];

/** הכפתורים של שליחה פתוחה. */
export const DISPATCH_ACTIONS = {
  dispatch: "שלח לתקלה",
  arrived: "הגיע",
  entered: "נכנס",
  done: "סיים",
  move: "אתר אחר",
  cancel: "ביטול שליחה",
};

const ms = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : null; };

/** המצב של היום (מפתח), או null = לא התחיל יום. */
export function techStatus(t) {
  const s = t?.status_today;
  return TECH_STATUSES.includes(s) ? s : null;
}

export function statusInfo(key) {
  return TECH_STATUS[key] ?? NOT_STARTED;
}

/** הסדר בלוח: לפי סדר המצבים (פנויים ראשונים — את מי אפשר לשלוח), "לא התחיל יום" בסוף; בתוך כל מצב לפי שם. */
export function sortTechs(list) {
  const rank = (t) => { const i = TECH_STATUSES.indexOf(techStatus(t)); return i < 0 ? TECH_STATUSES.length : i; };
  return [...(list || [])].sort((a, b) => rank(a) - rank(b) || String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "he"));
}

/** כמה בכל מצב; none = לא התחיל יום. */
export function techCounts(list) {
  const c = Object.fromEntries([...TECH_STATUSES, "none"].map((k) => [k, 0]));
  for (const t of list || []) c[techStatus(t) ?? "none"]++;
  return c;
}

/** שורת הסיכום: רק מה שיש בו מישהו, בסדר המצבים. */
export function summaryItems(counts) {
  return [...TECH_STATUSES, "none"]
    .filter((k) => (counts?.[k] ?? 0) > 0)
    .map((k) => ({ key: k, n: counts[k], label: k === "none" ? NOT_STARTED.plural : TECH_STATUS[k].plural }));
}

/** משך: "פחות מדקה", "25 דק׳", "1:05 שע׳", "יום", "3 ימים" — אותו כלל כמו בכרטיסי הרכבים. */
export const durationText = durationLabel;

/** "מ-10:42 · 25 דק׳" — מתי המצב התחיל וכמה זמן הוא נמשך. בלי מצב היום — "". */
export function sinceText(t, nowIso) {
  if (!techStatus(t) || !t?.status_at) return "";
  const when = clockText(t.status_at, nowIso);
  const dur = durationText(t.status_at, nowIso);
  return dur ? `מ-${when} · ${dur}` : `מ-${when}`;
}

/** לאן נשלח: אתר — "הרצל 50, תל אביב · 1227"; מקום — הטקסט. */
export function destText(d) {
  if (!d) return "";
  if (d.site_code) return d.site_name ? `${d.site_name} · ${d.site_code}` : d.site_code;
  return String(d.place ?? "");
}

/** הטכנאי הפעיל של כל רכב — הכרטיסים הם לפי רכב (איתוראן), והשליחה לפי טכנאי. Map plate → טכנאי. */
export function techByPlate(techs) {
  return new Map((techs || []).filter((t) => t?.plate).map((t) => [t.plate, t]));
}

/** שורת המשימה הפתוחה בכרטיס: "נשלח 10:42 ע״י X · הגיע 10:58". בלי משימה — "". */
export function dispatchLine(d, nowIso) {
  if (!d) return "";
  const parts = [`נשלח ${clockText(d.created_at, nowIso)}${d.created_by ? ` ע״י ${d.created_by}` : ""}`];
  if (d.arrived_at) parts.push(`הגיע ${clockText(d.arrived_at, nowIso)}`);
  return parts.join(" · ");
}

/**
 * האם הטכנאי אישר את המשימה בטלפון ("קיבלתי") — תמיד, כל עוד המשימה פתוחה: { tone: ok | wait | bad, label, time, detail }.
 * הבעלת (22/10/2026): "כשטכנאי מאשר את המשימה אני רוצה לראות על הכרטיס שהוא אישר. אם הוא לא אישר — שיראו שהוא עדיין לא
 * אישר". עד אז הייתה כאן שורה קטנה של הצפצוף, ובמצבים מסוימים — אחרי "הגיע", או טלפון שלא מחובר — לא נאמר כלום על האישור.
 *   אישר → "✓ אישר" + השעה;  3 צפצופים בלי אישור → "✕ לא אישר" (אדום);  אחרת → "עוד לא אישר" (ענבר).
 *   detail = מה קרה עם הצפצוף (מתי צפצף, שהטלפון לא מחובר לצפצוף, שהשירות לא ענה). אחרי "הגיע" הצפצוף נעצר — בלי פירוט.
 * ⚠️ מסד בלי השדות (לפני שלב 4, 21/10) — null: אי אפשר לדעת אם אישר, ולא ממציאים "לא אישר".
 */
export function ackLine(d, nowIso) {
  if (!d || (d.push_count === undefined && d.acked_at === undefined)) return null;
  if (d.acked_at) return { tone: "ok", label: "✓ אישר", time: clockText(d.acked_at, nowIso), detail: null };
  const max = Number(d.push_max) || 3;
  const n = Number(d.push_count) || 0;
  if (d.arrived_at) return { tone: "wait", label: "עוד לא אישר", time: null, detail: null };
  if (n >= max) return { tone: "bad", label: "✕ לא אישר", time: null, detail: `צפצף בטלפון ${n} פעמים, בלי תשובה` };
  if (d.push_error) return { tone: "wait", label: "עוד לא אישר", time: null, detail: `⚠ ${d.push_error}` };
  if (n > 0) return { tone: "wait", label: "עוד לא אישר", time: null, detail: `צפצף בטלפון ${clockText(d.push_last_at, nowIso)} (${n} מתוך ${max})` };
  return { tone: "wait", label: "עוד לא אישר", time: null, detail: "שולח צפצוף לטלפון…" };
}

/** אבני הדרך של השליחה שכבר קרו: נשלח, הגיע, נכנס — לכל אחת השעה ו"בדיעבד". */
export function marksList(d) {
  if (!d) return [];
  const out = [{ key: "created", label: "נשלח", at: d.created_at, late: false }];
  if (d.arrived_at) out.push({ key: "arrived", label: "הגיע", at: d.arrived_at, late: d.arrived_late === true });
  if (d.entered_at) out.push({ key: "entered", label: "נכנס", at: d.entered_at, late: d.entered_late === true });
  return out;
}

/** הצעד הבא בשליחה: הגיע → נכנס → סיים. */
export function nextMark(d) {
  if (!d?.arrived_at) return "arrived";
  if (!d?.entered_at) return "entered";
  return "done";
}

/**
 * הכפתורים בכרטיס. primary = הכפתור הבולט; secondary = שאר פעולות השליחה; statuses = כפתורי המצב.
 * ⚠️ בזמן שליחה פתוחה אין כפתורי מצב: המסד דוחה שינוי מצב עד שהשליחה מסתיימת או מבוטלת. בקר — בלי כפתורים בכלל.
 */
export function cardActions(t, editable) {
  if (!editable || !t) return { primary: null, secondary: [], statuses: [] };
  const d = t.dispatch;
  if (d) {
    const next = nextMark(d);
    const secondary = [];
    if (next === "arrived") secondary.push("entered", "done");
    else if (next === "entered") secondary.push("done");
    secondary.push("move", "cancel");
    return { primary: next, secondary, statuses: [] };
  }
  const cur = techStatus(t);
  return { primary: "dispatch", secondary: [], statuses: STATUS_BUTTONS.filter((b) => b.status !== cur) };
}

/** הדקות שאפשר לבחור לסימון בדיעבד ("לפני 10 דק׳"). */
export const LATE_MINUTES = [5, 10, 15, 30];

/**
 * אילו "לפני N דק׳" אפשר לתת לסימון — רק מה שהמסד יקבל: לא לפני השליחה (להגעה) או לפני ההגעה (לכניסה), לא אחרי הכניסה
 * (בתיקון הגעה), ולא יותר מ-12 שעות אחורה. מחזיר [{min, at}].
 */
export function lateChoices(d, mark, nowIso) {
  const now = ms(nowIso);
  if (!d || now == null) return [];
  const floor = mark === "entered" ? ms(d.arrived_at) ?? ms(d.created_at) : ms(d.created_at);
  const ceil = mark === "arrived" && d.entered_at ? ms(d.entered_at) : null;
  return LATE_MINUTES
    .map((min) => ({ min, t: now - min * 60_000 }))
    .filter(({ t }) => (floor == null || t >= floor) && (ceil == null || t <= ceil) && now - t <= 12 * 3_600_000)
    .map(({ min, t }) => ({ min, at: new Date(t).toISOString() }));
}

/** שורת הרכב בכרטיס: המצב במילים של המפה, ליד איזה אתר, איפה, והתראת מתח. בלי רכב — null. */
export function vehicleLine(v, nowIso) {
  if (!v) return null;
  const s = stateOf(v, nowIso);
  return {
    tone: s.tone,
    state: stateText(v, nowIso),
    near: nearText(v),
    place: placeText(v, nowIso),
    power: powerAlert(v, nowIso),
  };
}

const markLabel = { arrived: "הגיע", entered: "נכנס" };
const endLabel = { done: "סיים", cancelled: "השליחה בוטלה", moved: "נשלח לאתר אחר" };

/** הטקסט של שורה ביומן: "נכנס · הרצל 50, תל אביב · 1227", "סיים · … ← פנוי", "תיקון: הגיע 10:58 (היה 11:05)". */
export function logText(row, nowIso) {
  const dest = destText(row);
  const withDest = (s) => (dest ? `${s} · ${dest}` : s);
  const next = row?.status_after ? statusInfo(row.status_after).label : "";
  switch (row?.action) {
    case "status": return next || "שינוי מצב";
    case "dispatch": return dest ? `נשלח ל${dest}` : "נשלח";
    case "arrived": return withDest("הגיע");
    case "entered": return withDest("נכנס");
    case "ended": {
      const s = withDest(endLabel[row?.detail?.end_kind] ?? "השליחה הסתיימה");
      return next ? `${s} ← ${next}` : s;
    }
    case "vehicle": return row?.detail?.to ? `רכב: ${row.detail.to}` : "הרכב הוסר";
    case "correction": {
      const m = markLabel[row?.detail?.mark] ?? "סימון";
      const to = clockText(row?.detail?.to, nowIso);
      const from = clockText(row?.detail?.from, nowIso);
      return withDest(`תיקון: ${m} ${to}${from ? ` (היה ${from})` : ""}`);
    }
    default: return String(row?.action ?? "");
  }
}

/**
 * הרכבים לבחירה במסך הניהול: "בלי רכב", ואחריו כל הצי. רכב של טכנאי פעיל אחר — עם השם שלו, וחסום.
 * [{value, label, hint, disabled}]
 */
export function plateOptions(fleet, techs, selfId) {
  const owner = new Map((techs || []).filter((t) => t.plate && t.id !== selfId).map((t) => [t.plate, t.name]));
  return [
    { value: "", label: "בלי רכב" },
    ...(fleet || []).map((v) => ({
      value: v.plate,
      label: `${vehicleName(v)} · ${v.plate}`,
      hint: owner.has(v.plate) ? `של ${owner.get(v.plate)}` : "",
      disabled: owner.has(v.plate),
    })),
  ];
}

/** רכבים שאין להם טכנאי פעיל — עם הצעת שם מהכינוי באיתוראן. [{plate, name}] */
export function unmappedVehicles(fleet, techs) {
  const taken = new Set((techs || []).map((t) => t.plate).filter(Boolean));
  return (fleet || []).filter((v) => v?.plate && !taken.has(v.plate)).map((v) => ({ plate: v.plate, name: vehicleName(v) }));
}

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
/** שם האתר כמו שהוא ברשימת האתרים של הדשבורד (site_name). */
const siteName = (s) => norm(s?.site_name ?? s?.name);

/**
 * האתרים בחלון "צא ל:". בלי חיפוש: אתרים בתקלה ואתרים עם קריאה פתוחה (תקלה קודם, ואז יותר קריאות), עד 30. עם חיפוש —
 * "פחות או יותר" (utils/siteSearch.js): כל המילים בכל סדר, קיצורי ערים, כתיב מלא / חסר, טעות הקלדה אחת — עד 30.
 * callsBySite = מפתח site.id → {open}. keys = siteKey לכל אתר באותו סדר (נבנה פעם אחת לרשימה; בלי — נבנה כאן).
 */
export function dispatchSites(sites, query, callsBySite, keys = null) {
  const list = Array.isArray(sites) ? sites : [];
  if (!looseText(query)) {
    const calls = (s) => Number(callsBySite?.[s.id]?.open) || 0;
    const fault = (s) => s.monitored !== false && s.status === "error";
    return list
      .filter((s) => fault(s) || calls(s) > 0)
      .sort((a, b) => Number(fault(b)) - Number(fault(a)) || calls(b) - calls(a)
        || siteName(a).localeCompare(siteName(b), "he"))
      .slice(0, 30);
  }
  return searchSites(list, keys, query, 30).map((r) => r.site);
}

// ============================================================
// "טכנאי באתר" בלוח האתרים (21/10/2026, הבעלת: "תשים איקון טכנאי באתר")
// ============================================================

/** Map site_id → [{ name, since, noSignal }] מתוך tech_on_site; מי שהגיע ראשון — ראשון. השם: של הטכנאי בלוח,
 *  ובלי שיוך — הכינוי באיתוראן בלי מספר הרכב (vehicleName, כמו בכרטיס הטכנאי). */
export function techOnSiteBySite(rows) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.site_id == null) continue;
    const name = (r.tech && String(r.tech).trim()) || vehicleName({ name: r.nickname, plate: r.plate });
    const list = map.get(r.site_id) ?? [];
    list.push({ name, since: r.since ?? null, noSignal: r.no_signal === true });
    map.set(r.site_id, list);
  }
  for (const list of map.values()) list.sort((a, b) => String(a.since ?? "").localeCompare(String(b.since ?? "")));
  return map;
}

/** הטקסט של האיקון: "טכנאי באתר: אבי לוי · מ-10:42" / "2 טכנאים באתר: אבי לוי, דני · מ-10:42" (מתי הגיע הראשון). */
export function techOnSiteText(list, nowIso) {
  if (!Array.isArray(list) || !list.length) return "";
  const head = list.length === 1 ? "טכנאי באתר" : `${list.length} טכנאים באתר`;
  const since = list[0].since ? ` · מ-${clockText(list[0].since, nowIso)}` : "";
  return `${head}: ${list.map((x) => x.name).join(", ")}${since}`;
}
