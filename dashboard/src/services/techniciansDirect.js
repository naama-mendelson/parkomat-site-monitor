// services/techniciansDirect.js — לוח טכנאי השטח (20/10/2026), ישירות ל-PostgREST.
//
// כל הגישה דרך RPC (master/db/technicians.postgres.sql) — שלוש הטבלאות סגורות. אין זרוע שרת: master יצא משימוש לפני
// שהלוח נולד. ⚠️ כל המפתחות נשלחים במפורש (null כשאין): PostgREST בוחר פונקציה לפי המפתחות שבגוף הבקשה, ומפתח חסר הוא
// חתימה אחרת בעיניו (404, PGRST202) — אותו לקח כמו addTask.
import { supabase, isSupabaseConfigured } from "./supabase";

const HEBREW = /[֐-׿]/;
const NET_RE = /failed to fetch|networkerror|network request failed|load failed|ERR_INTERNET|ERR_NETWORK|abort/i;

/** שגיאה בעברית. stale = המסך לא עדכני (PT409) — הלוח טוען מחדש ומראה את ההודעה. */
function toError(error) {
  const msg = error?.message || String(error || "");
  let out;
  if (NET_RE.test(msg)) out = new Error("אין חיבור לאינטרנט — נסה שוב");
  else if (error?.code === "42501") out = new Error(HEBREW.test(msg) ? msg : "אין הרשאה");
  else out = new Error(HEBREW.test(msg) ? msg : "הפעולה נכשלה — נסה שוב");
  out.stale = error?.code === "PT409";
  out.code = error?.code;
  return out;
}

async function rpc(name, args, ms = 20_000) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const { data, error } = await supabase.rpc(name, args).abortSignal(ctrl.signal);
    if (error) throw toError(error);
    return data;
  } catch (err) {
    throw err instanceof Error && (HEBREW.test(err.message) || err.code) ? err : toError(err);
  } finally {
    clearTimeout(t);
  }
}

/**
 * הלוח: { enabled, canEdit, technicians, inactive, fleet, recentPlaces, sync, now }.
 * enabled = false — החשבון אינו בפיילוט (settings.technicians_board), והמסך מציג את המפה בלבד.
 */
export async function fetchTechBoard() {
  const j = await rpc("tech_board", {});
  if (!j?.enabled) return { enabled: false };
  return {
    enabled: true,
    canEdit: j.can_edit === true,
    technicians: Array.isArray(j.technicians) ? j.technicians : [],
    inactive: Array.isArray(j.inactive) ? j.inactive : [],
    fleet: Array.isArray(j.fleet) ? j.fleet : [],
    recentPlaces: Array.isArray(j.recent_places) ? j.recent_places : [],
    sync: j.sync ?? null,
    now: j.now ?? new Date().toISOString(),
  };
}

/** היומן של יום אחד בישראל ("YYYY-MM-DD"; null = היום): { enabled, day, today, rows, now }. */
export async function fetchTechDay(day = null) {
  const j = await rpc("tech_day", { p_day: day });
  if (!j?.enabled) return { enabled: false };
  return { enabled: true, day: j.day, today: j.today, rows: Array.isArray(j.rows) ? j.rows : [], now: j.now };
}

/** הוספה (id null) או עריכה של טכנאי. rev = הגרסה שהמסך טען. */
export async function saveTechnician({ id = null, name, plate = null, active = null, rev = null }) {
  return rpc("tech_save", { p_id: id, p_name: name, p_plate: plate || null, p_active: active, p_rev: rev });
}

/** שינוי מצב (פנוי / משוב / הפסקה / ערב / חופש / סיים יום). at = שעה בדיעבד (ISO) או null = עכשיו. */
export async function setTechStatus(id, status, at = null, rev = null) {
  return rpc("tech_set_status", { p_tech: id, p_status: status, p_at: at, p_rev: rev });
}

/** שליחה לתקלה: אתר (siteCode) או מקום חופשי (place). ⚠️ clientId נוצר אצל הקורא ונשלח שוב בניסיון חוזר. */
export async function dispatchTech({ id, siteCode = null, place = null, details = null, ticket = null, clientId, rev = null }) {
  return rpc("tech_dispatch", {
    p_tech: id, p_site_code: siteCode || null, p_place: place || null, p_details: details || null,
    p_ticket: ticket || null, p_client_id: clientId, p_rev: rev,
  });
}

/** "הגיע" / "נכנס". at = שעה בדיעבד או null. על סימון קיים — at הוא תיקון. */
export async function markDispatch(dispatchId, mark, at = null) {
  return rpc("tech_dispatch_mark", { p_dispatch: dispatchId, p_mark: mark, p_at: at });
}

/** סיום שליחה: kind = 'done' ("סיים") או 'cancelled' ("ביטול"); next = המצב אחריה (null = פנוי). */
export async function endDispatch(dispatchId, kind, next = null, at = null) {
  return rpc("tech_dispatch_end", { p_dispatch: dispatchId, p_kind: kind, p_next_status: next, p_at: at });
}

// ============================================================
// הטלפון של הטכנאי (21/10/2026, שלב 2 של "צא ל:")
// ============================================================

/**
 * QR לטלפון: Edge Function ‏provision-technician (יצירת משתמש דורשת את ה-Secret key). מחזיר { email, password, name,
 * replaced, warning? }. ⚠️ הסיסמה מוצגת פעם אחת, בתוך ה-QR, ואינה נשמרת. ההרשאה (עורך, בפיילוט) — במסד, בזהות הקורא.
 */
export async function provisionTechPhone(techId) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("נדרשת התחברות מחדש");
  let res;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/provision-technician`, {
      method: "POST",
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ technician_id: Number(techId) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw toError(e);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || "יצירת ה-QR נכשלה — נסו שוב");
    err.stale = res.status === 409;
    err.status = res.status;
    throw err;
  }
  return body;
}

/** ניתוק הטלפון של טכנאי: הטלפון נסגר מיד. { changed, rev }. */
export async function unpairTechPhone(techId) {
  return rpc("tech_phone_unpair", { p_tech: techId });
}

/** מה הטלפון רואה: { id, name, plate, dispatch, now }. נכשל ב-42501 כשהטלפון אינו מחובר לטכנאי. */
export async function fetchTechMe() {
  return rpc("tech_me", {});
}
