// services/complianceDirect.js — "בודק מוסמך" ו"תחזוקה מונעת", ישירות ל-Supabase.
//
// ============================================================
// ⚠️ אין כאן שום select מטבלה — רק RPC
// ============================================================
// כל עשר הטבלאות של התכונה **סגורות** (D2 ב-compliance.postgres.sql): RLS
// בלי מדיניות ובלי הרשאות. `select("*")` על אחת מהן מחזיר 403, ובכוונה —
// אחרת שורה אחת הייתה מושכת PDF של 8MB לדפדפן של כל מי שגולל רשימה.
// הפונקציה היחידה שמחזירה בתים היא `compliance_file`, קובץ אחד לפי מזהה.
//
// ⚠️ ואין כאן זרוע שרת: התכונה נולדה אחרי ש-master יצא משימוש. במצב שרת
// (VITE_SUPABASE_DIRECT=false) הלשוניות והמנורות מוסתרות — ראה InsightsModal.
//
// ============================================================
// ⚠️ כל קריאה עם זמן קצוב, וכל יצירה עם מזהה לקוח
// ============================================================
// הקריאות האלה יוצאות מטלפון בחדר מכונות. בקשה שנתקעת בלי זמן קצוב משאירה
// כפתור "שומר…" לנצח; בקשה שהתשובה שלה אבדה ונשלחת שוב בלי מזהה יוצרת
// ליקוי כפול, תמונה כפולה או ביקור כפול. לכן כל פונקציה כאן עוברת דרך
// `rpcT` (AbortSignal עם זמן לפי סוג), וכל יצירה מקבלת `clientId` /
// `requestId` שהמסך מייצר **פעם אחת** ושולח שוב בכל ניסיון. השרת מחזיר
// `replayed: true` על ניסיון חוזר — וזו הצלחה, לא שגיאה.
//
// כלל 5 נשמר: הרכיבים אינם מייבאים supabase-js. הם מייבאים מ-dataSource.
import { supabase, isSupabaseConfigured } from "./supabase";
import { fileToBase64, base64ToBlobUrl } from "../utils/complianceFiles";
import { sendError } from "../utils/pmOutbox";

const TIMEOUT = {
  quick: 20_000,     // וי, הערה
  photo: 60_000,     // תמונה דחוסה (~150–950KB)
  pdf: 180_000,      // תסקיר / דוח ביקור (עד 8MB ב-base64)
  normal: 30_000,
};

// ============================================================
// שגיאות
// ============================================================
const HEBREW = /[֐-׿]/;
const NET_RE = /failed to fetch|networkerror|network request failed|load failed|ERR_INTERNET|ERR_NETWORK/i;
const ABORT_RE = /aborterror|timeouterror|aborted|timed? ?out/i;

/**
 * שגיאת PostgREST → הודעה בעברית.
 *
 * ⚠️ ה-RPC מנפיקות הודעות בעברית עם SQLSTATE מכוון, ולכן ברוב המקרים
 * ההודעה מוצגת כמות שהיא. מה שצריך תרגום הוא מה ש**Postgres** אומר:
 * `42501` בלי עברית = "permission denied for function" (אין session, או
 * חשבון מושבת), ו-`57014` / 413 = הבקשה גדולה מדי לזמן הקצוב של המסד.
 */
export function messageFor(error, status, { upload = false } = {}) {
  if (!error) return "שגיאה לא ידועה";
  const raw = String(error.message || error || "");
  const code = String(error.code || "");
  if (status === 0 || error.name === "AbortError" || error.name === "TimeoutError") {
    if (ABORT_RE.test(raw) || error.name === "AbortError" || error.name === "TimeoutError") {
      return "החיבור איטי — נסה שוב";
    }
    return "אין חיבור לאינטרנט — נסה שוב";
  }
  if (NET_RE.test(raw)) return "אין חיבור לאינטרנט — נסה שוב";
  if (status === 413 || /payload too large|request entity too large/i.test(raw)) {
    return "הקובץ גדול מדי לשליחה — סרקו ב-150 dpi בגווני אפור, או פצלו את הקובץ";
  }
  // ⚠️ 57014 (תם זמן השאילתה) אינו ייחודי להעלאות — גם קריאה או וי יכולים
  // לחרוג ב-8 השניות תחת עומס. רק קריאה שנושאת קובץ מקבלת את עצת הסריקה.
  if (code === "57014") {
    return upload
      ? "הקובץ גדול מדי לשליחה — סרקו ב-150 dpi בגווני אפור, או פצלו את הקובץ"
      : "השרת לא הספיק לענות — נסו שוב בעוד רגע";
  }
  if (code === "42501" && !HEBREW.test(raw)) {
    return "אין הרשאה — יש להתחבר מחדש, או שהחשבון הושבת";
  }
  return raw || "הפעולה נכשלה";
}

/** Error עם הקוד והסטטוס המקוריים — כדי שהמסך יבחין בין PT409 ל-PT404. */
function toError(error, status, opts) {
  const err = new Error(messageFor(error, status, opts));
  err.code = error?.code ?? null;
  err.status = status ?? null;
  err.network = status === 0 || NET_RE.test(String(error?.message || ""));
  err.cause = error;
  return err;
}

// AbortSignal.timeout קיים מספארי 16; לפניו — בקר ידני.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms);
  return ctl.signal;
}

// supabase-js אינו זורק על שגיאת רשת או ביטול — הוא מחזיר {error, status: 0}.
async function rpcRaw(name, args, ms) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  try {
    return await supabase.rpc(name, args).abortSignal(timeoutSignal(ms));
  } catch (err) {
    return { data: null, error: err, status: 0 };
  }
}

async function rpcT(name, args, ms = TIMEOUT.normal, opts = {}) {
  const { data, error, status } = await rpcRaw(name, args, ms);
  if (error) throw toError(error, status, opts);
  return data;
}

// RETURNS TABLE מגיע כמערך גם כשיש שורה אחת.
const one = (data) => (Array.isArray(data) ? data[0] ?? null : data ?? null);

// ============================================================
// מצב — שורה לכל אתר (הכרטיס, הלשוניות, פאנל המנהל)
// ============================================================

/**
 * שורות `site_compliance` גולמיות (snake_case). ממירים ב-`toCompliance`.
 * ⚠️ מי שאינו צוות (סוכן, זהות הקליטה) מקבל מערך ריק — לא שגיאה.
 * @param {number[]|null} siteIds — null = כל האתרים
 */
export async function fetchSiteCompliance(siteIds = null) {
  const data = await rpcT("site_compliance", { p_site_ids: siteIds }, TIMEOUT.normal);
  return Array.isArray(data) ? data : [];
}

// ============================================================
// בודק מוסמך
// ============================================================

/**
 * כל מה שהלשונית צריכה, בלי בתים:
 * `{ site:{id,code,name}, status:<שורת site_compliance>,
 *    machines:[{key,label,retired_at,state,validity_state,cycle,valid_until,periodic_id,open,overdue,awaiting_since}],
 *    reports:[{id,machine_key,kind,followup_of,inspected_on,valid_until,effective_valid_until,validity_source,
 *              declared_clean,report_number,inspector_name,inspector_license,machine_no,note,parse_meta,
 *              uploaded_by,created_at,file:{id,file_name,byte_size,purged},
 *              defects:[{id,seq,body,urgent,due_on,status,closure_no,done_at,done_by_name,done_note,
 *                        closed_by_report_id,current_photos,past_photos}]}] }`
 * הדוחות ממוינים מהחדש לישן (inspected_on, id).
 */
export async function fetchInspectionSite(code) {
  return rpcT("inspection_site", { p_site_code: code }, TIMEOUT.normal);
}

/** היסטוריית השינויים (כולל הטקסט החופשי) — לצוות בלבד. מהחדש לישן, עד 200. */
export async function fetchComplianceHistory(code, limit = 100) {
  const data = await rpcT("compliance_history_list", { p_site_code: code, p_limit: limit }, TIMEOUT.normal);
  return Array.isArray(data) ? data : [];
}

/**
 * העלאת תסקיר (תקופתי או חוזר) עם הליקויים שאושרו. מנהל בלבד.
 *
 * @param {string} code
 * @param {object} meta — `client_id` (חובה, פעם אחת למסך), `kind` ('periodic'|'followup'),
 *   `inspected_on`, `valid_until` (חובה בתקופתי; ריק בחוזר = יורש), `machine_key`,
 *   `machine_label`, `machine_no`, `followup_of`, `report_number`, `inspector_name`,
 *   `inspector_license`, `note`, `confirm_clean` (חובה כשאין ליקויים),
 *   `close_open_defects` (רק בחוזר נקי), `default_deadline_days`, `parse` (פלט המפענח),
 *   `file_id` (כשאין קובץ — PDF שכבר הועלה, למתקן נוסף).
 *   ⚠️ `validity_source` **אינו** נשלח: השרת גוזר אותו (D25).
 * @param {File|null} file
 * @param {Array<{body:string, urgent?:boolean, due_on?:string}>} defects
 *   ⚠️ `due_on` רק אם המשתמש ערך אותו — אחרת השרת מחשב (דחוף = יום הבדיקה, אחרת +45).
 * @returns {{reportId, fileId, validUntil, defects, closed, replayed}}
 */
export async function uploadInspection(code, meta, file, defects = []) {
  if (!meta?.client_id) throw new Error("חסר מזהה בקשה");
  const p_file = file
    ? { mime: "application/pdf", data: await fileToBase64(file), name: file.name || null }
    : null;
  const row = one(await rpcT("inspection_upload", {
    p_site_code: code, p_meta: meta, p_file, p_defects: defects,
  }, p_file ? TIMEOUT.pdf : TIMEOUT.normal, { upload: !!p_file }));
  return {
    reportId: row?.report_id ?? null,
    fileId: row?.file_id ?? null,
    validUntil: row?.valid_until ?? null,
    defects: row?.defects ?? 0,
    closed: row?.closed ?? 0,
    replayed: !!row?.replayed,
  };
}

/**
 * עריכת פרטי תסקיר. שולחים **רק** את השדות ששונו — שדה שנשלח נחשב לשינוי
 * (תאריך תוקף שנשלח נרשם 'manual'). `declared_clean: true` מחייב סיבה.
 */
export async function updateInspectionReport(reportId, meta, reason = null) {
  await rpcT("inspection_report_update", { p_report_id: reportId, p_meta: meta, p_reason: reason }, TIMEOUT.normal);
}

export async function deleteInspectionReport(reportId, reason) {
  await rpcT("inspection_report_delete", { p_report_id: reportId, p_reason: reason }, TIMEOUT.normal);
}

export async function retireMachine(code, machineKey, reason) {
  await rpcT("inspection_machine_retire", { p_site_code: code, p_machine_key: machineKey, p_reason: reason }, TIMEOUT.normal);
}

/** סגירת כל הליקויים הפתוחים במחזור על סמך תסקיר חוזר נקי (D24). מחזיר כמה נסגרו. */
export async function closeDefectsByReport(reportId, reason = null) {
  const n = await rpcT("inspection_close_by_report", { p_report_id: reportId, p_reason: reason }, TIMEOUT.normal);
  return Number(n) || 0;
}

/**
 * הוספה (defectId=null, clientId חובה) או עריכה של ליקוי פתוח. מנהל בלבד.
 * `dueOn` null בהוספה = השרת מחשב; null בעריכה = ללא שינוי.
 * @returns {number} מזהה הליקוי
 */
export async function saveDefect({ reportId, defectId = null, body, urgent = false, dueOn = null, clientId = null }) {
  const id = await rpcT("inspection_defect_save", {
    p_report_id: reportId, p_defect_id: defectId, p_body: body,
    p_urgent: urgent, p_due_on: dueOn || null, p_client_id: clientId,
  }, TIMEOUT.normal);
  return Number(id);
}

export async function deleteDefect(defectId, reason) {
  await rpcT("inspection_defect_delete", { p_defect_id: defectId, p_reason: reason }, TIMEOUT.normal);
}

/**
 * תמונת ביצוע — נשמרת ברגע שנבחרה (staging), לפני "סימון כבוצע".
 * @param {{mime,data,thumb}} compressed — מ-compressWithThumb
 * @returns {{id:number}} — אותו מזהה גם בניסיון חוזר עם אותו clientId
 */
export async function addDefectPhoto(defectId, compressed, clientId) {
  const id = await rpcT("inspection_defect_photo_add", {
    p_defect_id: defectId,
    p_photo: { mime: compressed.mime, data: compressed.data, thumb: compressed.thumb ?? null },
    p_client_id: clientId,
  }, TIMEOUT.photo, { upload: true });
  return { id: Number(id) };
}

export async function deleteDefectPhoto(photoId) {
  await rpcT("inspection_defect_photo_delete", { p_photo_id: photoId }, TIMEOUT.normal);
}

/**
 * "בוצע" — רק כשיש לפחות תמונה אחת שמורה לסגירה הנוכחית.
 * ⚠️ `requestId` נוצר **פעם אחת לחלון**: ניסיון חוזר עם אותו מזהה מחזיר
 * `replayed:true`. מזהה אחר על ליקוי שכבר בוצע → שגיאה עם code 'PT409'.
 * @returns {{defectId, photos, replayed}}
 */
export async function markDefectDone(defectId, name, note, requestId) {
  const row = one(await rpcT("inspection_defect_done", {
    p_defect_id: defectId, p_done_by_name: name, p_note: note || null, p_request_id: requestId,
  }, TIMEOUT.normal));
  return { defectId: row?.defect_id ?? defectId, photos: row?.photos ?? 0, replayed: !!row?.replayed };
}

export async function reopenDefect(defectId, reason) {
  await rpcT("inspection_defect_reopen", { p_defect_id: defectId, p_reason: reason }, TIMEOUT.normal);
}

// ============================================================
// קבצים ותמונות ממוזערות
// ============================================================

/**
 * תמונות ממוזערות (base64 נטו, jpeg).
 * @param {'defect'|'defect_history'|'pm_visit'} kind
 *   defect — הסגירה הנוכחית (עד 3) · defect_history — סגירות קודמות (עד 9) ·
 *   pm_visit — כל תמונות הביקור (עד 40), `ownerId` = מזהה הפריט
 * @returns {Array<{id, ownerId, closureNo, mime, thumb}>}
 */
export async function fetchComplianceThumbs(kind, ownerId) {
  const data = await rpcT("compliance_thumbs", { p_kind: kind, p_owner_id: ownerId }, TIMEOUT.normal);
  return (Array.isArray(data) ? data : []).map((r) => ({
    id: r.id, ownerId: r.owner_id, closureNo: r.closure_no, mime: r.mime, thumb: r.thumb_b64,
  }));
}

/**
 * הקובץ המלא כ-blob: (לעולם לא data:). ⚠️ הקורא אחראי ל-revokeObjectURL —
 * ComplianceFileViewer עושה זאת בעצמו כשהוא נסגר.
 * @param {'inspection_pdf'|'defect_photo'|'pm_pdf'|'pm_photo'|'pm_signature'} kind
 * @returns {{blobUrl, mime, fileName}}
 */
export async function fetchComplianceFile(kind, id) {
  const ms = kind === "inspection_pdf" || kind === "pm_pdf" ? TIMEOUT.pdf : TIMEOUT.photo;
  const row = one(await rpcT("compliance_file", { p_kind: kind, p_id: id }, ms));
  if (!row?.data_b64) throw new Error("הקובץ לא נמצא");
  return { blobUrl: base64ToBlobUrl(row.data_b64, row.mime), mime: row.mime, fileName: row.file_name ?? null };
}

// ============================================================
// תחזוקה מונעת
// ============================================================

/**
 * `{ site, status, template_count, me (שם התצוגה של הקורא, כמו ב-updated_by),
 *    draft: null | {id, started_by, started_by_user_id, started_at, last_activity_at,
 *                   items:[{id,seq,label,hint,kind,required,min_photos,checked,note,updated_by,updated_at,
 *                           photos:[{id,client_id,byte_size}]}]},
 *    visits:[{id,source,performed_on,performer_name,vendor,note,submitted_by,submitted_at,
 *             items_total,items_checked,items_done,photo_count,has_signature,file:null|{id,file_name,byte_size}}] }`
 *   items_done = פריטים שמילאו את הדרישה (וי היכן שנדרש + מספר התמונות הנדרש)
 * ⚠️ זול מספיק לסקירה כל 20 שניות בזמן שהטופס פתוח (D16) — אין בו בתים.
 */
export async function fetchPmSite(code) {
  return rpcT("pm_site", { p_site_code: code }, TIMEOUT.normal);
}

/** פרטי ביקור שהוגש (לצפייה בהיסטוריה). items[].photos = מזהי קבצים. */
export async function fetchPmVisit(visitId) {
  return rpcT("pm_visit_detail", { p_visit_id: visitId }, TIMEOUT.normal);
}

/**
 * פריטי רשימת בדיקה: [{id,seq,label,hint,kind,required,min_photos,updated_at,updated_by}]
 * @param {number|null} [templateId] — null = רשימת ברירת המחדל (מה שהיה "הרשימה" לפני 07/10/2026)
 */
export async function fetchPmTemplate(templateId = null) {
  const data = await rpcT("pm_template", templateId == null ? {} : { p_template_id: templateId }, TIMEOUT.normal);
  return Array.isArray(data) ? data : [];
}

/** כל רשימות התחזוקה: [{id,name,seq,is_default,item_count,site_count}] — ברירת המחדל ראשונה. */
export async function fetchPmTemplates() {
  const data = await rpcT("pm_templates_list", {}, TIMEOUT.normal);
  return Array.isArray(data) ? data : [];
}

/** רשימה חדשה (ריקה). מנהל בלבד. @returns {number} המזהה שלה */
export async function createPmTemplate(name) {
  return Number(await rpcT("pm_template_create", { p_name: name }, TIMEOUT.normal));
}

/** שינוי שם של רשימה. מנהל בלבד. */
export async function renamePmTemplate(templateId, name) {
  await rpcT("pm_template_rename", { p_template_id: templateId, p_name: name }, TIMEOUT.normal);
}

/**
 * אילו רשימות האתר מקבל — מצב יעד. [] = חזרה לברירת המחדל. מנהל בלבד.
 * ⚠️ ביקור שכבר פתוח אינו משתנה; הרשימות החדשות חלות מהביקור הבא.
 */
export async function setPmSiteTemplates(code, templateIds) {
  return Number(await rpcT("pm_site_templates_set", { p_site_code: code, p_template_ids: templateIds }, TIMEOUT.normal));
}

/**
 * שמירת הרשימה כולה — **מצב היעד**: פריט עם id מתעדכן, בלי id נוסף, ומה
 * שלא נשלח מושבת (לא נמחק: ביקורים קיימים מצביעים עליו). מנהל בלבד.
 * @param {Array<{id?, label, hint?, kind:'check'|'photo'|'check_photo', required, min_photos}>} items
 * @param {string|null} expectedAt — ה-updated_at המאוחר ברשימה שהעורך טען ('' = נטענה ריקה).
 *   ⚠️ השרת משווה אותו לנוכחי ודוחה ב-PT409 אם מנהל אחר שמר בינתיים — בלעדיו
 *   עורך ישן היה מבטל בשקט את השמירה שלו (מצב היעד כולו נשלח).
 * @returns {number} מספר הפריטים הפעילים
 */
export async function savePmTemplate(items, expectedAt = null, templateId = null) {
  return Number(await rpcT("pm_template_save", {
    p_items: items, p_expected_at: expectedAt,
    // ⚠️ רק כשנבחרה רשימה: בלי המפתח, השמירה היא של ברירת המחדל — כמו לפני 07/10/2026
    ...(templateId == null ? {} : { p_template_id: templateId }),
  }, TIMEOUT.normal)) || 0;
}

/**
 * פתיחת ביקור — או קבלת הטיוטה הקיימת (טיוטה אחת לאתר). `restart` זורק את
 * הקיימת ופותח חדשה (מותר: מנהל, מי שפתח, או כל צוות אחרי 48 שעות שקט).
 * @param {{visitId, lastActivityAt}|null} [expect] — בהתחלה מחדש: הטיוטה שהמשתמש **ראה**
 *   ואישר לזרוק (מהכרטיס). ⚠️ השרת זורק את מה שקיים *עכשיו*; אם זה לא מה שנראה
 *   (הוחלפה, או שעבדו בה מאז) — PT409 ושום דבר לא נמחק. בלי זה מנהל עם כרטיס
 *   ישן היה מוחק עבודה טרייה של טכנאי.
 * @returns {{visitId, created, startedAt, lastActivityAt}}
 */
export async function startPmVisit(code, restart = false, expect = null) {
  const args = { p_site_code: code, p_restart: !!restart };
  if (restart && expect?.visitId != null) {
    args.p_expect_visit_id = Number(expect.visitId);
    args.p_expect_activity = expect.lastActivityAt ?? null;
  }
  const row = one(await rpcT("pm_visit_start", args, TIMEOUT.normal));
  return {
    visitId: row?.visit_id ?? null,
    created: !!row?.created,
    startedAt: row?.started_at ?? null,
    lastActivityAt: row?.last_activity_at ?? null,
  };
}

export async function checkPmItem(itemId, checked) {
  await rpcT("pm_visit_item_check", { p_item_id: itemId, p_checked: !!checked }, TIMEOUT.quick);
}

export async function notePmItem(itemId, note) {
  await rpcT("pm_visit_item_note", { p_item_id: itemId, p_note: note ?? "" }, TIMEOUT.quick);
}

/** @returns {{id:number}} — אותו מזהה גם בניסיון חוזר עם אותו clientId */
export async function addPmPhoto(itemId, compressed, clientId) {
  const id = await rpcT("pm_visit_photo_add", {
    p_item_id: itemId,
    p_photo: { mime: compressed.mime, data: compressed.data, thumb: compressed.thumb ?? null },
    p_client_id: clientId,
  }, TIMEOUT.photo, { upload: true });
  return { id: Number(id) };
}

export async function deletePmPhoto(fileId) {
  await rpcT("pm_visit_photo_delete", { p_file_id: fileId }, TIMEOUT.normal);
}

/**
 * הגשה וחתימה. אחריה הביקור אינו משתנה.
 * ⚠️ `requestId` פעם אחת לטופס; ניסיון חוזר → `replayed:true` (הצלחה).
 * @param {{performerName, signatureB64, performedOn, note, requestId}} p — signatureB64 = PNG נטו
 * @returns {{visitId, performedOn, nextDueOn, replayed}}
 */
export async function submitPmVisit(visitId, { performerName, signatureB64, performedOn = null, note = null, requestId }) {
  const row = one(await rpcT("pm_visit_submit", {
    p_visit_id: visitId,
    p_performer_name: performerName,
    p_signature: signatureB64 ? { mime: "image/png", data: signatureB64 } : null,
    p_performed_on: performedOn || null,
    p_note: note || null,
    p_request_id: requestId,
  }, TIMEOUT.normal));
  return {
    visitId: row?.visit_id ?? visitId,
    performedOn: row?.performed_on ?? null,
    nextDueOn: row?.next_due_on ?? null,
    replayed: !!row?.replayed,
  };
}

/** ביטול טיוטה (מחיקה קשיחה). מותר: מנהל, מי שפתח, או כל צוות אחרי 48 שעות שקט. */
export async function discardPmVisit(visitId, reason = null) {
  await rpcT("pm_visit_discard", { p_visit_id: visitId, p_reason: reason }, TIMEOUT.normal);
}

/**
 * דוח תחזוקה היסטורי (PDF) — ביקור שנעשה לפני המערכת. מנהל בלבד.
 * @param {{clientId, performedOn, performerName?, vendor?, note?}} meta
 * @returns {{visitId, replayed}}
 */
export async function uploadPmHistorical(code, meta, file) {
  if (!meta?.clientId) throw new Error("חסר מזהה בקשה");
  if (!file) throw new Error("חסר קובץ");
  const p_file = { mime: "application/pdf", data: await fileToBase64(file), name: file.name || null };
  const row = one(await rpcT("pm_historical_upload", {
    p_site_code: code,
    p_meta: {
      client_id: meta.clientId,
      performed_on: meta.performedOn,
      performer_name: meta.performerName || null,
      vendor: meta.vendor || null,
      note: meta.note || null,
    },
    p_file,
  }, TIMEOUT.pdf, { upload: true }));
  return { visitId: row?.visit_id ?? null, replayed: !!row?.replayed };
}

/** מחיקה רכה של ביקור שהוגש (עם סיבה). מנהל בלבד. */
export async function deletePmVisit(visitId, reason) {
  await rpcT("pm_visit_delete", { p_visit_id: visitId, p_reason: reason }, TIMEOUT.normal);
}

// ============================================================
// שולחי תיבת היוצאים של הטופס (utils/pmOutbox.js)
// ============================================================
// ⚠️ התיבה מבינה רק שגיאות שנבנו ב-`sendError` (רשת / זמני / נדחה). כאן
// מוסיפים את הסוג הרביעי — `permanent`: הביקור כבר הוגש, בוטל, או שהפריט
// נמחק עם הטיוטה. רשומה כזו לעולם לא תתקבל, ונסיון חוזר שלה רק היה תוקע
// את הטופס על "ממתין לסנכרון" — ומונע את ההגשה הבאה.
const GONE_RE = /הביקור כבר הוגש|הביקור לא נמצא|הפריט לא נמצא/;

async function outboxCall(name, args, ms, opts = {}) {
  const { data, error, status } = await rpcRaw(name, args, ms);
  if (!error) return data;
  const err = sendError(error, status, messageFor(error, status, opts));
  if (GONE_RE.test(String(error.message || "")) || String(error.code || "") === "PT404") err.permanent = true;
  throw err;
}

/**
 * ביטול תמונה שאולי כבר בשרת (הוסרה במכשיר אחרי שנמסרה לשולח).
 *
 * ⚠️ בלי id ידוע — שואלים את pm_visit_photo_add עם p_photo = NULL. בפונקציה
 * בדיקת ה-replay לפי client_id רצה **לפני** כל בדיקה אחרת: אם התמונה בשרת,
 * חוזר ה-id שלה; אם לא — כל תשובה אחרת (תמונה לא תקינה, תקרה, הביקור הוגש,
 * הפריט לא נמצא) אומרת "אינה בשרת", ואין מה למחוק. הסדר הזה ננעל בבדיקה
 * ב-compliance.test.js — שינוי שלו היה משאיר תמונות שהוסרו בתוך ביקורים חתומים.
 */
async function photoUndo(_visitId, itemId, clientId, fileId) {
  let fid = fileId;
  if (fid == null) {
    const { data, error, status } = await rpcRaw("pm_visit_photo_add", {
      p_item_id: Number(itemId), p_photo: null, p_client_id: clientId,
    }, TIMEOUT.quick);
    if (error) {
      const err = sendError(error, status, messageFor(error, status));
      if (err.network) throw err;
      return;                                   // אינה בשרת
    }
    fid = Number(data);
  }
  const { error, status } = await rpcRaw("pm_visit_photo_delete", { p_file_id: fid }, TIMEOUT.normal);
  if (!error) return;
  if (String(error.code || "") === "PT404") return;   // כבר נמחקה
  const err = sendError(error, status, messageFor(error, status));
  // הביקור הוגש עם התמונה — ההסרה אבדה, וזה מה שהטכנאי צריך לשמוע (dropped)
  if (GONE_RE.test(String(error.message || ""))) err.permanent = true;
  throw err;
}

/** השולחים ל-`drain` / `startAutoDrain` של pmOutbox. visitId אינו נשלח — השרת גוזר אותו מהפריט. */
export const pmOutboxSenders = {
  check: (_visitId, itemId, checked) =>
    outboxCall("pm_visit_item_check", { p_item_id: Number(itemId), p_checked: !!checked }, TIMEOUT.quick),
  note: (_visitId, itemId, note) =>
    outboxCall("pm_visit_item_note", { p_item_id: Number(itemId), p_note: note ?? "" }, TIMEOUT.quick),
  // ⚠️ מחזיר את ה-id: שכבת "אושר" צריכה אותו כדי שמחיקה של התמונה לא תחכה לקריאת השרת הבאה
  photo: async (_visitId, itemId, clientId, compressed) => {
    const id = await outboxCall("pm_visit_photo_add", {
      p_item_id: Number(itemId),
      p_photo: { mime: compressed.mime, data: compressed.data, thumb: compressed.thumb ?? null },
      p_client_id: clientId,
    }, TIMEOUT.photo, { upload: true });
    return { id: id == null ? null : Number(id) };
  },
  photoUndo,
};

// ============================================================
// כלי מנהל
// ============================================================

/** `{dbBytes, blobBytes, blobRows}` — כמה מקום תופסים הקבצים (מטא-דאטה בלבד). */
export async function fetchComplianceStorage() {
  const row = one(await rpcT("compliance_storage", {}, TIMEOUT.normal));
  return { dbBytes: Number(row?.db_bytes ?? 0), blobBytes: Number(row?.blob_bytes ?? 0), blobRows: Number(row?.blob_rows ?? 0) };
}

/** רשומות של אתרים שנמחקו: [{siteCode, reports, files, visits, history}] */
export async function fetchComplianceOrphans() {
  const data = await rpcT("compliance_orphans", {}, TIMEOUT.normal);
  return (Array.isArray(data) ? data : []).map((r) => ({
    siteCode: r.site_code, reports: r.reports, files: r.files, visits: r.visits, history: r.history,
  }));
}

export async function reattachCompliance(oldCode, siteCode) {
  return Number(await rpcT("compliance_reattach", { p_old_code: oldCode, p_site_code: siteCode }, TIMEOUT.normal)) || 0;
}

/** @param {'inspection_file'|'pm_visit'} kind */
export async function purgeCompliance(kind, id, reason) {
  return Number(await rpcT("compliance_purge", { p_kind: kind, p_id: id, p_reason: reason }, TIMEOUT.normal)) || 0;
}
